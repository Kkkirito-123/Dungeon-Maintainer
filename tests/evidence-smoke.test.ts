/**
 * Evidence Graph v1 专用冒烟测试。
 *
 * 这里只验证本地确定性存储、缓存、失效、复现、Solution 和循环门禁，不启动真实游戏、
 * 不调用模型，也不运行完整 Benchmark。测试仓库与数据目录均为一次性临时目录。
 */

import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { checkEvidence } from "../src/evidence/projector.js";
import { gameEvidence } from "../src/evidence/projector.js";
import { readDiagnosticEvidence } from "../src/evidence/diagnostic.js";
import { EvidenceStore } from "../src/evidence/store.js";
import { SemanticTrace } from "../src/logging/trace.js";
import { LoopGuard } from "../src/pi/loop-guard.js";
import { registerFinishTool } from "../src/pi/tools/finish.js";
import { inspectTask } from "../src/pi/tools/inspect.js";
import {
  readActiveReproduction,
  reproductionNeedsSqlRefresh,
  saveReproduction,
} from "../src/repair/reproduction.js";
import { TaskStore } from "../src/task/store.js";
import { hashFile, hashWorktree } from "../src/workspace/git.js";
import { createTemporaryGitRepository } from "./testSupport.js";

interface RegisteredTool {
  execute(...args: unknown[]): Promise<unknown>;
}

class SingleToolApi {
  tool: RegisteredTool | null = null;

  registerTool(tool: RegisteredTool): void {
    this.tool = tool;
  }
}

function finishExtensionContext(approved: boolean): ExtensionContext {
  return {
    ui: {
      confirm: async () => approved,
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
}

describe("Evidence Graph v1 冒烟", () => {
  it("action-not-available 的三类证据可跨进程恢复，单次源码读取不能提前 proposed", async () => {
    const bridgePath = "game/src/devtools/dungeon-agent/bridge.ts";
    const actionsPath = "game/src/devtools/dungeon-agent/actions.ts";
    const domPath = "game/src/presentation/dom/appShellTemplate.ts";
    const repository = await createTemporaryGitRepository({
      [bridgePath]: [
        "const selector = DUNGEON_AGENT_ACTION_SELECTORS[actionId];",
        "if (!clickDungeonAgentAction(root, selector)) return 'action-not-available';",
        "",
      ].join("\n"),
      [actionsPath]: [
        "export const DUNGEON_AGENT_ACTION_SELECTORS = {",
        "  terminal: '#open-sql-broken',",
        "};",
        "",
      ].join("\n"),
      [domPath]: "<button id=\"open-sql\">SQL 战斗</button>\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "diagnostic-evidence",
        objective: "修复终端动作不可用",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "diagnostic-evidence", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      await evidence.capture(gameEvidence({
        toolName: "use",
        actionId: "terminal",
        ok: false,
        event: "action-not-available",
      }));
      const trace = new SemanticTrace(10);
      trace.push({
        action: "use",
        arguments: { actionId: "terminal" },
        ok: false,
        summary: "action-not-available",
      });
      await saveReproduction(store, evidence, task, trace, {
        title: "终端动作不可用",
        expected: "终端可以打开",
        actual: "action-not-available",
        evidence: ["use terminal 失败"],
        assertions: { terminalOpen: true },
      });

      await inspectTask({ task, store, evidence }, {
        action: "read",
        path: bridgePath,
        startLine: 1,
        lineCount: 20,
      });
      const bridgeOnly = await readDiagnosticEvidence(evidence);
      assert.equal(bridgeOnly.actionNotAvailable, true);
      assert.equal(bridgeOnly.hasGameEvidence, true);
      assert.equal(bridgeOnly.sourceEvidenceReady, false);
      assert.deepEqual(bridgeOnly.missingActionEvidence, [
        "terminal 的动作映射字面量",
        "真实 DOM 按钮定义",
      ]);

      await inspectTask({ task, store, evidence }, {
        action: "read",
        path: actionsPath,
        startLine: 1,
        lineCount: 20,
      });
      assert.deepEqual((await readDiagnosticEvidence(evidence)).missingActionEvidence, [
        "真实 DOM 按钮定义",
      ]);
      await inspectTask({ task, store, evidence }, {
        action: "read",
        path: domPath,
        startLine: 1,
        lineCount: 20,
      });
      assert.equal((await readDiagnosticEvidence(evidence)).sourceEvidenceReady, true);

      const restarted = new EvidenceStore(dataDir, task);
      assert.equal((await readDiagnosticEvidence(restarted)).sourceEvidenceReady, true);
    } finally {
      await repository.dispose();
    }
  });

  it("附带 action-not-available 不会污染普通 SQL/战斗复现的源码门禁", async () => {
    const sessionPath = "game/src/application/GameSession.ts";
    const combatPath = "game/src/domain/combat.ts";
    const repository = await createTemporaryGitRepository({
      [sessionPath]: "export function advanceLesson(): boolean { return false; }\n",
      [combatPath]: "export function acceptedQuery(): boolean { return true; }\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "diagnostic-incidental-action-failure",
        objective: "修复查询已接受但课程进度不增加",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "diagnostic-incidental-action-failure", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      // 这是复现路径中的一次误点探测，不是用户报告的目标故障。
      await evidence.capture(gameEvidence({
        toolName: "use",
        actionId: "continue",
        ok: false,
        event: "action-not-available",
      }));
      const trace = new SemanticTrace(10);
      trace.push({
        action: "go",
        arguments: { target: "objective", maxSteps: 8 },
        ok: true,
        summary: "到达战斗遭遇",
      });
      trace.push({
        action: "use",
        arguments: { actionId: "continue" },
        ok: false,
        summary: "action-not-available",
      });
      await assert.rejects(saveReproduction(store, evidence, task, trace, {
        title: "没有查询动作的阶段断言",
        expected: "修复后 stageIndex 至少达到 1",
        actual: "只保存了误点动作，没有保存查询提交",
        evidence: ["动作不可用"],
        assertions: { minStageIndex: 1 },
      }), /没有可重放的 query 动作/u);
      trace.push({
        action: "query",
        arguments: {},
        ok: true,
        summary: "query accepted but lesson progress unchanged",
      });
      // 模拟模型在目标异常已经成立后又追加一次确认提交；正确补丁可能让这次提交
      // 结束战斗，因此 mode/terminalOpen 不能被保存为阶段推进的终态要求。
      trace.push({
        action: "input-sql",
        arguments: { inputLength: 32 },
        ok: true,
        summary: "second query input accepted",
      });
      trace.push({
        action: "query",
        arguments: {},
        ok: false,
        summary: "second query rejected",
      });
      await assert.rejects(saveReproduction(store, evidence, task, trace, {
        title: "查询成功但课程进度没有增加",
        expected: "查询成功后战斗终端 stageIndex=1",
        actual: "查询被接受，但战斗终端 stageIndex 仍为 0",
        evidence: ["query 返回成功但题目阶段未推进"],
        assertions: {
          mode: "combat",
          terminalOpen: true,
          queryAccepted: true,
          minStageIndex: 0,
        },
      }), /minStageIndex.*不能缺失或填写更小/u);
      await saveReproduction(store, evidence, task, trace, {
        title: "查询成功但课程进度没有增加",
        expected: "查询成功后战斗终端 stageIndex 至少前进到 1",
        actual: "查询被接受，但战斗终端 stageIndex 仍为 0",
        evidence: ["query 返回成功但题目阶段未推进"],
        assertions: {
          mode: "combat",
          terminalOpen: true,
          queryAccepted: true,
          minStageIndex: 1,
        },
      });
      const savedReproduction = await readActiveReproduction(store, evidence, task);
      assert.ok(savedReproduction);
      assert.equal(savedReproduction.assertions.minStageIndex, 1);
      assert.equal(savedReproduction.assertions.advancedFromFloor, undefined);
      assert.equal(savedReproduction.assertions.mode, undefined);
      assert.equal(savedReproduction.assertions.terminalOpen, undefined);
      assert.equal(savedReproduction.actions.filter((entry) => entry.action === "query").length, 2);

      await inspectTask({ task, store, evidence }, {
        action: "read",
        path: sessionPath,
        startLine: 1,
        lineCount: 20,
      });
      assert.equal(
        (await readDiagnosticEvidence(evidence)).sourceEvidenceReady,
        true,
        "普通故障的一次当前版本源码读取已经足以形成方案证据",
      );
      await inspectTask({ task, store, evidence }, {
        action: "read",
        path: combatPath,
        startLine: 1,
        lineCount: 20,
      });
      const state = await readDiagnosticEvidence(evidence);
      assert.equal(state.hasReproduction, true);
      assert.equal(state.hasGameFailure, true);
      assert.equal(state.actionNotAvailable, false);
      assert.deepEqual(state.missingActionEvidence, []);
      assert.equal(state.sourceEvidenceReady, true);
    } finally {
      await repository.dispose();
    }
  });

  it("缓存、失效、重启、检查版本、复现与隐私形成任务内闭环", async () => {
    const sourcePath = "game/src/domain/portal.ts";
    const secretPath = "game/src/domain/answer-cache.ts";
    const original = "export const portalState = 'stuck';\n";
    const secret = [
      "const answerSql = 'SELECT hidden FROM judge';",
      "const hiddenJudge = 'developer-only';",
      "",
    ].join("\n");
    const repository = await createTemporaryGitRepository({
      [sourcePath]: original,
      [secretPath]: secret,
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-smoke",
        objective: "修复击败首领后卡在传送门的问题",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-smoke", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);

      const first = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: sourcePath,
        startLine: 1,
        lineCount: 20,
      });
      assert.equal(first.details.cacheHit, false);
      const firstRevision = evidence.revision;
      const second = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: sourcePath,
        startLine: 1,
        lineCount: 20,
      });
      assert.equal(second.details.cacheHit, true);
      assert.equal(evidence.revision, firstRevision);
      assert.match(second.text, /CACHE HIT/u);

      const secretRead = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: secretPath,
        startLine: 1,
        lineCount: 20,
      });
      const artifact = await evidence.getEvidenceArtifact(secretRead.details.evidenceId);
      assert.ok(artifact);
      assert.doesNotMatch(artifact, /answerSql|SELECT hidden|hiddenJudge|developer-only/iu);
      assert.equal((await inspectTask({ task, store, evidence }, {
        action: "read",
        path: secretPath,
        startLine: 1,
        lineCount: 20,
      })).details.cacheHit, false);

      const loopGuard = new LoopGuard();
      loopGuard.resetForNewTask(evidence.revision);
      const cachedAction = {
        toolName: "inspect",
        input: { action: "read", path: sourcePath },
      };
      assert.equal(loopGuard.evaluateAction(cachedAction).kind, "allow");
      assert.equal(loopGuard.recordOutcome({
        action: cachedAction,
        result: second.details,
        evidenceRevision: evidence.revision,
      }), false);
      assert.equal(loopGuard.noProgressCount, 1);

      await writeFile(
        join(repository.repoRoot, sourcePath),
        original.replace("'stuck'", "'ready'"),
        "utf8",
      );
      await evidence.invalidatePaths([sourcePath]);
      const afterChange = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: sourcePath,
        startLine: 1,
        lineCount: 20,
      });
      assert.equal(afterChange.details.cacheHit, false);
      assert.notEqual(afterChange.details.evidenceId, first.details.evidenceId);

      const check = checkEvidence({
        id: "game-test",
        worktreeHash: "worktree-v1",
        status: "failed",
        durationMs: 12,
        logPath: join(store.taskDir(task.id), "checks", "game-test.log"),
        savedAt: new Date().toISOString(),
      });
      await evidence.capture(check);
      assert.ok(check.actionKey);
      assert.ok(await evidence.findReusable(check.actionKey, "worktree-v1"));
      assert.equal(await evidence.findReusable(check.actionKey, "worktree-v2"), null);

      const firstTrace = new SemanticTrace(10);
      firstTrace.push({
        action: "go",
        arguments: { target: "objective", maxSteps: 64 },
        ok: false,
        summary: "传送门未推进",
      });
      const firstReproduction = await saveReproduction(
        store,
        evidence,
        task,
        firstTrace,
        {
          title: "首领后传送门卡住",
          expected: "进入下一层",
          actual: "停留在传送门动画",
          evidence: ["右侧玩家投影"],
          assertions: { advancedFromFloor: 2 },
        },
      );
      const secondTrace = new SemanticTrace(10);
      secondTrace.push({
        action: "use",
        arguments: { actionId: "portal" },
        ok: false,
        summary: "传送门仍不可用",
      });
      const secondReproduction = await saveReproduction(
        store,
        evidence,
        task,
        secondTrace,
        {
          title: "首领后传送门无法使用",
          expected: "传送门推进楼层",
          actual: "动作失败",
          evidence: ["语义动作失败"],
          assertions: { advancedFromFloor: 2 },
        },
      );
      assert.notEqual(firstReproduction.id, secondReproduction.id);
      assert.equal((await evidence.active("reproduction")).length, 1);

      await appendFile(
        join(store.taskDir(task.id), "evidence.jsonl"),
        "{\"schemaVersion\":1",
        "utf8",
      );
      const recoveredEvidence = new EvidenceStore(dataDir, task);
      await recoveredEvidence.load();
      assert.equal(
        (await readActiveReproduction(store, recoveredEvidence, task))?.id,
        secondReproduction.id,
      );

      let executionApproved = false;
      const toolApi = new SingleToolApi();
      const oldHash = await hashFile(repository.repoRoot, sourcePath);
      registerFinishTool(toolApi as unknown as ExtensionAPI, {
        task,
        store,
        evidence: recoveredEvidence,
        currentDriver: () => null,
        approveExecution: () => { executionApproved = true; },
        completeExecution: () => { executionApproved = false; },
        isExecutionApproved: () => executionApproved,
        repairRequested: () => true,
        verifyTask: async () => {
          const worktreeHash = await hashWorktree(repository.repoRoot);
          const record = {
            worktreeHash,
            checkIds: ["game-test"],
            reproductionId: secondReproduction.id,
            replayPassed: true,
            verifiedAt: new Date().toISOString(),
          };
          task.changedPaths = [sourcePath];
          task.baseHashes = { [sourcePath]: oldHash };
          task.verification = record;
          await store.transition(task, "verifying");
          await store.transition(task, "ready_to_apply");
          return {
            record,
            patchPath: join(store.taskDir(task.id), "patch.diff"),
            changedPaths: [sourcePath],
          };
        },
      });
      assert.ok(toolApi.tool);
      await assert.rejects(toolApi.tool.execute(
        "finish-unresolved-proposal",
        {
          status: "proposed",
          summary: "尚未定位传送门状态由哪个分支推进",
          risk: "无",
          plan: {
            title: "修复首领后传送门推进",
            steps: ["先进一步定位状态推进分支"],
            verification: "需要运行 game-test 验证并重放复现",
            allowedPaths: [sourcePath],
          },
        },
        undefined,
        undefined,
        finishExtensionContext(true),
      ), /未确认推测/u);
      await toolApi.tool.execute(
        "finish-proposed",
        {
          status: "proposed",
          summary: "首领结算后没有把传送门状态推进到可用",
          risk: "仅影响楼层推进状态",
          plan: {
            title: "修复首领后传送门推进",
            steps: ["在首领结算分支设置可用状态"],
            verification: "需要运行 game-test 验证并重放复现",
            allowedPaths: [sourcePath],
          },
        },
        undefined,
        undefined,
        finishExtensionContext(true),
      );
      assert.equal(executionApproved, true);
      const proposalClaim = await recoveredEvidence.latest("claim");
      const reproductionEvidenceRecord = await recoveredEvidence.latest("reproduction");
      assert.equal(proposalClaim?.metadata.finishStatus, "proposed");
      assert.ok(reproductionEvidenceRecord);
      assert.ok(proposalClaim.links.includes(reproductionEvidenceRecord.id));
      await toolApi.tool.execute(
        "finish-result",
        {
          status: "result",
          summary: "传送门推进已修复",
          risk: "无",
        },
        undefined,
        undefined,
        finishExtensionContext(true),
      );

      // finish 的验证路径只决定当前任务是否可应用；跨任务 Solution 不再由 Coding
      // Agent 自动生成，避免遥测/索引失败推翻已经通过的修复。
      assert.equal(
        (await recoveredEvidence.searchSolutions("击败 boss 后卡在传送门", 3)).length,
        0,
      );
      const blockedApi = new SingleToolApi();
      registerFinishTool(blockedApi as unknown as ExtensionAPI, {
        task,
        store,
        evidence: recoveredEvidence,
        currentDriver: () => null,
        approveExecution: () => undefined,
        completeExecution: () => undefined,
        isExecutionApproved: () => false,
        repairRequested: () => true,
        verifyTask: async () => { throw new Error("不应调用验证"); },
      });
      await store.transition(task, "active");
      await blockedApi.tool?.execute(
        "finish-blocked",
        { status: "blocked", summary: "独特阻塞结论", risk: "缺少外部环境" },
        undefined,
        undefined,
        finishExtensionContext(false),
      );
      assert.equal(
        (await recoveredEvidence.searchSolutions("独特阻塞结论", 3)).length,
        0,
      );

      const sqlTrace = new SemanticTrace(10);
      sqlTrace.push({
        action: "input-sql",
        arguments: { inputLength: 42 },
        ok: true,
        summary: "已输入一条 SQL",
      });
      const sqlReproduction = await saveReproduction(
        store,
        recoveredEvidence,
        task,
        sqlTrace,
        {
          title: "管理员答案复现",
          expected: "提示答案可以提交",
          actual: "提交后仍被拒绝",
          evidence: ["只保存输入长度"],
          assertions: { terminalOpen: true },
        },
      );
      assert.equal(reproductionNeedsSqlRefresh(sqlReproduction), true);
      const reproductionText = await readFile(
        join(store.taskDir(task.id), "reproductions", sqlReproduction.id + ".json"),
        "utf8",
      );
      assert.doesNotMatch(reproductionText, /SELECT|管理员答案正文/iu);

      // 模拟新进程 session_start：SQL 正文不在磁盘，旧复现必须退出 active，
      // 后续只能创建 recover Episode 重新输入，不能把不可重放记录当成已验证。
      const restartedEvidence = new EvidenceStore(dataDir, task);
      await restartedEvidence.load();
      const restored = await readActiveReproduction(store, restartedEvidence, task);
      assert.equal(restored?.id, sqlReproduction.id);
      assert(restored);
      assert.equal(reproductionNeedsSqlRefresh(restored), true);
      await restartedEvidence.supersedeReproductions();
      task.verification = null;
      await store.save(task);
      assert.equal(await restartedEvidence.latest("reproduction"), null);
      assert.equal(task.verification, null);
    } finally {
      await repository.dispose();
    }
  });
});
