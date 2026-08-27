/**
 * Evidence Graph 专用冒烟测试。
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
import { buildEvidenceCard } from "../src/evidence/card.js";
import { checkEvidence } from "../src/evidence/projector.js";
import { gameEvidence } from "../src/evidence/projector.js";
import { readDiagnosticEvidence } from "../src/evidence/diagnostic.js";
import { EvidenceStore } from "../src/evidence/store.js";
import { SemanticTrace } from "../src/logging/trace.js";
import { currentSolutionContext } from "../src/pi/evidence-context.js";
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

describe("Evidence Graph 冒烟", () => {
  it("worktree 修改后失效旧 search/bundle，同时保留精确读取的路径粒度", async () => {
    const changedPath = "src/changed.ts";
    const unchangedPath = "src/unchanged.ts";
    const repository = await createTemporaryGitRepository({
      [changedPath]: "export const portalState = 'stuck';\n",
      [unchangedPath]: "export const stableState = 'ready';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-worktree-invalidation",
        objective: "验证整树源码证据失效",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-worktree-invalidation", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const oldWorktreeHash = await hashWorktree(repository.repoRoot);

      await inspectTask({ task, store, evidence }, {
        action: "search",
        query: "portalState",
      }, undefined, oldWorktreeHash);
      await inspectTask({ task, store, evidence }, {
        action: "bundle",
        query: "portalState",
      }, undefined, oldWorktreeHash);
      await inspectTask({ task, store, evidence }, {
        action: "read",
        path: changedPath,
        startLine: 1,
        lineCount: 20,
      });
      await inspectTask({ task, store, evidence }, {
        action: "read",
        path: unchangedPath,
        startLine: 1,
        lineCount: 20,
      });

      const oldScoped = (await evidence.active("source")).filter((record) => (
        record.worktreeHash === oldWorktreeHash
      ));
      assert.deepEqual(
        [...new Set(oldScoped.map((record) => record.metadata.action))].sort(),
        ["bundle", "search"],
      );

      await writeFile(
        join(repository.repoRoot, changedPath),
        "export const portalState = 'ready';\n",
        "utf8",
      );
      const currentWorktreeHash = await hashWorktree(repository.repoRoot);
      await evidence.invalidatePaths([changedPath], currentWorktreeHash);

      const activeSources = await evidence.active("source");
      assert.equal(activeSources.some((record) => record.worktreeHash === oldWorktreeHash), false);
      assert.equal(activeSources.some((record) => record.path === changedPath), false);
      assert.equal(activeSources.some((record) => record.path === unchangedPath), true);
      assert.doesNotMatch(buildEvidenceCard(await evidence.active()), new RegExp(
        oldWorktreeHash.slice(0, 12),
        "u",
      ));
      const staleActions = (await evidence.list({ status: "stale", kind: "source" }))
        .filter((record) => record.worktreeHash === oldWorktreeHash)
        .map((record) => record.metadata.action);
      assert.deepEqual([...new Set(staleActions)].sort(), ["bundle", "search"]);
      for (const record of oldScoped) {
        assert.ok(record.actionKey);
        assert.equal(await evidence.findReusable(record.actionKey, oldWorktreeHash), null);
      }

      const refreshed = await inspectTask({ task, store, evidence }, {
        action: "search",
        query: "portalState",
      }, undefined, currentWorktreeHash);
      const reused = await inspectTask({ task, store, evidence }, {
        action: "search",
        query: "portalState",
      }, undefined, currentWorktreeHash);
      assert.equal(refreshed.details.cacheKind, "none");
      assert.equal(reused.details.cacheKind, "exact");
      assert.equal(
        (await evidence.get(refreshed.details.evidenceId))?.worktreeHash,
        currentWorktreeHash,
      );
    } finally {
      await repository.dispose();
    }
  });

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

  it("同一 fingerprint/validity 的不同 actionKey 复用证据并持久化 alias", async () => {
    const sourcePath = "src/game.ts";
    const repository = await createTemporaryGitRepository({
      [sourcePath]: "export const state = 'ready';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-semantic-alias",
        objective: "验证语义证据索引",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-semantic-alias", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const candidate = {
        kind: "source" as const,
        actionKey: "inspect:read:state",
        fingerprint: "same-source-result",
        status: "active" as const,
        summary: "当前源码证据",
        artifactRef: null,
        path: sourcePath,
        startLine: 1,
        lineCount: 1,
        baseHash: "base-v1",
        worktreeHash: "worktree-v1",
        validityKey: "base-v1",
        links: [],
        metadata: {},
      };
      const first = await evidence.capture(candidate);
      const second = await evidence.capture({
        ...candidate,
        actionKey: "inspect:bundle:state",
      });

      assert.equal(first.added, true);
      assert.equal(second.added, false);
      assert.equal(second.record.id, first.record.id);
      assert.equal(second.record.actionAliases.includes("inspect:bundle:state"), true);
      assert.equal(
        (await evidence.findReusableByFingerprint(
          "source",
          "same-source-result",
          "base-v1",
        ))?.id,
        first.record.id,
      );
      assert.equal(
        (await evidence.findReusable("inspect:bundle:state", "base-v1"))?.id,
        first.record.id,
      );

      const restarted = new EvidenceStore(dataDir, task);
      assert.equal(
        (await restarted.findReusable("inspect:bundle:state", "base-v1"))?.id,
        first.record.id,
      );
      assert.match(
        await readFile(join(store.taskDir(task.id), "evidence.jsonl"), "utf8"),
        /inspect:bundle:state/u,
      );
    } finally {
      await repository.dispose();
    }
  });

  it("只读取字段完整且无旧扩展的当前 Evidence 记录", async () => {
    const repository = await createTemporaryGitRepository({
      "src/game.ts": "export const state = 'ready';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-current-record-only",
        objective: "拒绝非当前 Evidence 格式",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-current-record-only", "pi"),
      });
      await store.transition(task, "active");
      const path = join(store.taskDir(task.id), "evidence.jsonl");
      const currentRecord = {
        schemaVersion: 1,
        id: "current-record",
        taskId: task.id,
        kind: "source",
        actionKey: "inspect:read:state",
        fingerprint: "source-result",
        actionAliases: [],
        status: "active",
        summary: "完整当前记录",
        artifactRef: null,
        path: "src/game.ts",
        startLine: 1,
        lineCount: 1,
        baseHash: "base-a",
        worktreeHash: "worktree-a",
        validityKey: "base-a",
        links: [],
        metadata: {},
        createdAt: new Date().toISOString(),
      };
      const missingField = { ...currentRecord } as Record<string, unknown>;
      delete missingField.actionAliases;
      await writeFile(path, JSON.stringify(missingField) + "\n", "utf8");

      await assert.rejects(
        new EvidenceStore(dataDir, task).load(),
        /JSONL 记录结构非法/u,
      );

      await writeFile(
        path,
        JSON.stringify({ ...currentRecord, legacyActionKeys: [] }) + "\n",
        "utf8",
      );
      await assert.rejects(
        new EvidenceStore(dataDir, task).load(),
        /JSONL 记录结构非法/u,
      );

      await writeFile(path, JSON.stringify(currentRecord) + "\n", "utf8");
      const loaded = new EvidenceStore(dataDir, task);
      await loaded.load();
      assert.equal((await loaded.get(currentRecord.id))?.summary, currentRecord.summary);
    } finally {
      await repository.dispose();
    }
  });

  it("captureText 语义命中时不覆盖已有工件", async () => {
    const repository = await createTemporaryGitRepository({ "src/game.ts": "export const state = 'ready';\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-artifact-dedup",
        objective: "验证证据工件去重",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-artifact-dedup", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const candidate = {
        kind: "source" as const,
        actionKey: "inspect:read:first",
        fingerprint: "same-artifact-result",
        status: "active" as const,
        summary: "源码正文",
        artifactRef: null,
        path: "src/game.ts",
        startLine: 1,
        lineCount: 1,
        baseHash: "base-v1",
        worktreeHash: "worktree-v1",
        validityKey: "base-v1",
        links: [],
        metadata: {},
      };
      const first = await evidence.captureText(candidate, "first artifact body\n");
      const second = await evidence.captureText({
        ...candidate,
        actionKey: "inspect:search:state",
      }, "different body must not replace the same fingerprint\n");

      assert.equal(first.added, true);
      assert.equal(second.added, false);
      assert.equal(second.record.id, first.record.id);
      assert.equal(
        await evidence.getEvidenceArtifact(first.record.id),
        "first artifact body\n",
      );
      assert.equal(
        (await evidence.findReusable("inspect:search:state", "base-v1"))?.id,
        first.record.id,
      );
    } finally {
      await repository.dispose();
    }
  });

  it("Inspect 为同结果的不同查询登记语义回执，随后直接精确命中", async () => {
    const repository = await createTemporaryGitRepository({
      "src/state.ts": "export const state = 'ready';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "inspect-semantic-reuse",
        objective: "验证相同搜索结果复用",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "inspect-semantic-reuse", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const first = await inspectTask({ task, store, evidence }, {
        action: "search",
        query: "state",
      });
      const semantic = await inspectTask({ task, store, evidence }, {
        action: "search",
        query: "ready",
      });
      const exact = await inspectTask({ task, store, evidence }, {
        action: "search",
        query: "ready",
      });

      assert.equal(first.details.cacheKind, "none");
      assert.equal(semantic.details.cacheKind, "semantic");
      assert.match(semantic.text, /semanticResult=true/u);
      assert.equal(exact.details.cacheKind, "exact");
      assert.equal(exact.details.evidenceId, first.details.evidenceId);
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
      assert.equal(first.details.cacheKind, "none");
      const firstRevision = evidence.revision;
      const second = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: sourcePath,
        startLine: 1,
        lineCount: 20,
      });
      assert.equal(second.details.cacheKind, "exact");
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
      })).details.cacheKind, "none");

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
      await evidence.invalidatePaths([sourcePath], await hashWorktree(repository.repoRoot));
      const afterChange = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: sourcePath,
        startLine: 1,
        lineCount: 20,
      });
      assert.equal(afterChange.details.cacheKind, "none");
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

      const savedSolutions = await recoveredEvidence.searchSolutions(
        "击败 boss 后卡在传送门",
        3,
      );
      assert.equal(savedSolutions.length, 1);
      const savedSolution = savedSolutions[0];
      assert(savedSolution);
      assert.deepEqual(savedSolution.relatedPaths, [sourcePath]);
      const solutionPath = join(
        dataDir,
        "projects",
        recoveredEvidence.projectKey,
        "solutions",
        savedSolution.id + ".json",
      );
      const solutionText = await readFile(solutionPath, "utf8");
      const incompleteSolution = JSON.parse(solutionText) as Record<string, unknown>;
      delete incompleteSolution.verification;
      await writeFile(
        solutionPath,
        JSON.stringify(incompleteSolution, null, 2) + "\n",
        "utf8",
      );
      await assert.rejects(
        recoveredEvidence.getSolution(savedSolution.id),
        /解决方案文件格式、版本、ID 或项目绑定非法/u,
      );
      const oldExtendedSolution = {
        ...(JSON.parse(solutionText) as Record<string, unknown>),
        legacyCategory: "game-repair",
      };
      await writeFile(
        solutionPath,
        JSON.stringify(oldExtendedSolution, null, 2) + "\n",
        "utf8",
      );
      await assert.rejects(
        recoveredEvidence.getSolution(savedSolution.id),
        /解决方案文件格式、版本、ID 或项目绑定非法/u,
      );
      await writeFile(solutionPath, solutionText, "utf8");
      assert.equal((await recoveredEvidence.getSolution(savedSolution.id))?.id, savedSolution.id);
      const nextTask = await store.create({
        id: "evidence-smoke-next",
        objective: "击败 boss 后卡在传送门，请检查并修复",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-smoke-next", "pi"),
      });
      const nextEvidence = new EvidenceStore(dataDir, nextTask);
      const historicalContext = await currentSolutionContext(
        nextEvidence,
        nextTask.objective,
      );
      assert.equal(historicalContext.matchCount, 1);
      assert.match(historicalContext.text ?? "", /历史解决方案候选/u);
      assert.match(historicalContext.text ?? "", /修复首领后传送门推进/u);
      assert.match(historicalContext.text ?? "", /game\/src\/domain\/portal\.ts/u);
      assert.doesNotMatch(historicalContext.text ?? "", /solutionId|evidenceRefs|score/u);
      const solutionEvents = (await readFile(
        join(store.taskDir(task.id), "events.jsonl"),
        "utf8",
      )).split(/\r?\n/u).filter(Boolean).map(
        (row) => JSON.parse(row) as { type: string; detail: Record<string, unknown> },
      );
      assert.equal(solutionEvents.some((event) => (
        event.type === "evidence.solution_saved"
        && event.detail.outcome === "saved"
      )), true);
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
