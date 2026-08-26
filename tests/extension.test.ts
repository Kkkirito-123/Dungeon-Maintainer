import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { EvidenceStore } from "../src/evidence/store.js";
import type { GameDriver } from "../src/game/driver.js";
import type { PlayView } from "../src/game/protocol.js";
import { SemanticTrace } from "../src/logging/trace.js";
import {
  assertTaskSessionBinding,
  installDungeonMaintainerExtension,
} from "../src/pi/extension.js";
import {
  FULL_CODING_TOOLS,
} from "../src/pi/tool-policy.js";
import { INITIAL_TASK_OBJECTIVE } from "../src/task/types.js";
import { TaskStore } from "../src/task/store.js";
import { createTemporaryGitRepository } from "./testSupport.js";
import { serializeGameToolResult } from "../src/pi/tools/game.js";

type RegisteredHandler = (...args: unknown[]) => unknown;

interface RegisteredCommand {
  description: string;
  handler(args: string, context: unknown): Promise<void>;
}

class RecordingExtensionApi {
  readonly providers = new Map<string, unknown>();
  readonly tools: string[] = [];
  readonly toolDefinitions = new Map<string, {
    execute?: (...args: unknown[]) => unknown;
  }>();
  readonly commands = new Map<string, RegisteredCommand>();
  readonly hooks = new Map<string, RegisteredHandler>();
  readonly sentMessages: Array<{ message: unknown; options: unknown }> = [];
  activeTools: string[] = [];
  sessionName = "";

  registerProvider(id: string, provider: unknown): void {
    this.providers.set(id, provider);
  }

  registerTool(tool: { name: string; execute?: (...args: unknown[]) => unknown }): void {
    this.tools.push(tool.name);
    this.toolDefinitions.set(tool.name, tool);
  }

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }

  on(event: string, handler: RegisteredHandler): void {
    this.hooks.set(event, handler);
  }

  setActiveTools(tools: string[]): void {
    this.activeTools = [...tools];
  }

  setSessionName(name: string): void {
    this.sessionName = name;
  }

  async setModel(): Promise<boolean> {
    return true;
  }

  sendMessage(message: unknown, options: unknown): void {
    this.sentMessages.push({ message, options });
  }
}

function requireHook(
  pi: RecordingExtensionApi,
  name: string,
): RegisteredHandler {
  const hook = pi.hooks.get(name);
  assert.ok(hook, `缺少 ${name} hook`);
  return hook;
}

describe("Pi Extension 单循环工具、命令和会话阻断", () => {
  it("相同失败写入只执行两次，第三次由真实 Extension 门禁阻止", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data-loop-v2");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-loop-v2",
        objective: "修复重复写入",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-loop-v2"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const driver = {} as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "provider-secret" }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => driver,
          ensure: async () => driver,
          close: async () => undefined,
        },
      });
      const finish = pi.toolDefinitions.get("finish");
      assert.ok(finish?.execute);
      await finish.execute(
        "approve-loop-v2",
        {
          status: "proposed",
          summary: "定位到 README 测试问题。",
          risk: "仅测试门禁。",
          plan: {
            title: "验证失败写入门禁",
            steps: ["尝试同一精确补丁。"],
            verification: "确认第三次执行前阻止。",
            allowedPaths: ["README.md"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );
      const call = requireHook(pi, "tool_call");
      const result = requireHook(pi, "tool_result");
      const input = {
        edits: [{
          path: "README.md",
          baseHash: "deadbeef",
          oldText: "baseline",
          newText: "changed",
        }],
      };
      for (const id of ["failed-patch-1", "failed-patch-2"]) {
        assert.equal(await call({
          type: "tool_call",
          toolCallId: id,
          toolName: "patch",
          input,
        }, { ui: { notify: () => undefined } }), undefined);
        await result({
          type: "tool_result",
          toolCallId: id,
          toolName: "patch",
          input,
          content: [{ type: "text", text: "baseHash conflict" }],
          details: undefined,
          isError: true,
        }, { ui: { notify: () => undefined } });
      }
      const blocked = await call({
        type: "tool_call",
        toolCallId: "failed-patch-3",
        toolName: "patch",
        input,
      }, { ui: { notify: () => undefined } }) as {
        block: boolean;
        terminate: boolean;
        reason: string;
      };
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /循环门禁/u);

      const events = (await readFile(join(store.taskDir(task.id), "events.jsonl"), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { type: string; detail: Record<string, unknown> });
      const writes = events.filter((event) => event.type === "tool.write_outcome");
      assert.deepEqual(writes.map((event) => event.detail.outcome), [
        "failed",
        "failed",
        "rejected",
      ]);
      assert.equal(events.filter((event) => event.type === "tool.loop_guard").length, 1);
      assert.doesNotMatch(JSON.stringify(events), /baseline|changed|deadbeef/u);
    } finally {
      await repository.dispose();
    }
  });

  it("并行相同写入只允许两个 pending，结果与异常回合都会释放计数", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data-pending-write");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-pending-write",
        objective: "修复并行重复写入",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-pending-write"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const driver = {} as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "provider-secret" }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => driver,
          ensure: async () => driver,
          close: async () => undefined,
        },
      });
      const finish = pi.toolDefinitions.get("finish");
      assert.ok(finish?.execute);
      await finish.execute(
        "approve-pending-write",
        {
          status: "proposed",
          summary: "定位到并行写入门禁测试路径。",
          risk: "仅验证执行前拒绝。",
          plan: {
            title: "验证并行 pending 门禁",
            steps: ["并行请求同一原生写入。"],
            verification: "第三个请求执行前被拒绝。",
            allowedPaths: ["README.md"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );
      const call = requireHook(pi, "tool_call");
      const result = requireHook(pi, "tool_result");
      const turnEnd = requireHook(pi, "turn_end");
      const context = { ui: { notify: () => undefined } };
      const input = { path: "README.md", content: "changed\n" };
      for (const id of ["pending-write-1", "pending-write-2"]) {
        assert.equal(await call({
          type: "tool_call",
          toolCallId: id,
          toolName: "write",
          input,
        }, context), undefined);
      }
      const third = await call({
        type: "tool_call",
        toolCallId: "pending-write-3",
        toolName: "write",
        input,
      }, context) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(third.block, true);
      assert.equal(third.terminate, false);
      assert.match(third.reason, /循环门禁/u);

      await result({
        type: "tool_result",
        toolCallId: "pending-write-1",
        toolName: "write",
        input,
        content: [{ type: "text", text: "write noop" }],
        details: undefined,
        isError: false,
      }, context);
      await result({
        type: "tool_result",
        toolCallId: "pending-write-2",
        toolName: "write",
        input,
        content: [{ type: "text", text: "write failed" }],
        details: undefined,
        isError: true,
      }, context);
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "pending-write-4",
        toolName: "write",
        input,
      }, context), undefined);

      await turnEnd({}, context);
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "pending-write-5",
        toolName: "write",
        input,
      }, context), undefined);
      await turnEnd({}, context);

      const events = (await readFile(join(store.taskDir(task.id), "events.jsonl"), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { type: string; detail: Record<string, unknown> });
      assert.equal(events.filter((event) => (
        event.type === "tool.loop_guard"
        && event.detail.reasonCode === "block-pending_action"
      )).length, 1);
      assert.equal(events.filter((event) => (
        event.type === "tool.write_outcome"
        && event.detail.outcome === "rejected"
        && event.detail.reasonCode === "loop-guard-pending_action"
      )).length, 1);
    } finally {
      await repository.dispose();
    }
  });

  it("注册十一个领域工具，并用执行门禁保护固定 Coding 工具面", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/project.json": JSON.stringify({
        schemaVersion: 1,
        adapter: "sql-dungeon",
      }) + "\n",
      "README.md": "test\n",
      "long.txt": Array.from({ length: 120 }, (_value, index) => (
        "line-" + String(index + 1)
      )).join("\n") + "\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-extension",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-extension"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const evidence = new EvidenceStore(dataDir, task);
      const config = loadConfig({
        LOCALAPPDATA: dataDir,
        MAINTAINER_API_KEY: "provider-secret",
        MAINTAINER_BASE_URL: "https://api.deepseek.com/v1",
        MAINTAINER_MODEL: "fixed-model",
      });
      const lifecycle: string[] = [];
      const reproductionTrace = new SemanticTrace(10);
      reproductionTrace.push({
        action: "use",
        arguments: { actionId: "terminal" },
        ok: false,
        summary: "action-not-available",
      });
      const driver = {
        trace: reproductionTrace,
        peek: async () => ({
          floor: 3,
          mode: "combat",
          developerVisibleSentinel: "full-view-sentinel",
        }),
        ensureReproductionCheckpoint: async () => {
          lifecycle.push("checkpoint");
        },
        reloadAndReplay: async (actions: readonly unknown[]) => {
          lifecycle.push("reload");
          return {
            passed: true,
            actionCount: actions.length,
            failure: null,
          };
        },
      } as unknown as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config,
        store,
        task,
        evidenceStore: evidence,
        gameRuntime: {
          currentDriver: () => driver,
          requireDriver: () => driver,
          ensure: async () => {
            lifecycle.push("ensure");
            return driver;
          },
          close: async () => undefined,
        },
        verifyTask: async () => {
          lifecycle.push("verify");
          const record = {
            worktreeHash: "verified-worktree-hash",
            checkIds: ["rules-validate"],
            reproductionId: null,
            replayPassed: true,
            verifiedAt: new Date().toISOString(),
          };
          task.state = "ready_to_apply";
          task.changedPaths = ["first.txt", "second.txt"];
          task.verification = record;
          return {
            record,
            patchPath: join(store.taskDir(task.id), "patch.diff"),
            changedPaths: [...task.changedPaths],
          };
        },
      });

      assert.deepEqual(pi.tools, [
        "inspect",
        "evidence",
        "patch",
        "check",
        "finish",
        "look",
        "go",
        "use",
        "input_sql",
        "query",
        "tree",
      ]);
      const treeTool = pi.toolDefinitions.get("tree");
      assert.ok(treeTool?.execute);
      const localTreeListResult = await treeTool.execute(
        "call-tree",
        { action: "list" },
        undefined,
        undefined,
        {},
      ) as { content: Array<{ text: string }> };
      assert.match(localTreeListResult.content[0]?.text ?? "", /TREE [a-f0-9]{12}/u);
      assert.match(localTreeListResult.content[0]?.text ?? "", /current=true/u);
      const inspectTool = pi.toolDefinitions.get("inspect");
      assert.ok(inspectTool?.execute);
      const inspectPage = await inspectTool.execute(
        "call-inspect-page",
        { action: "read", path: "long.txt", startLine: 5, lineCount: 3 },
        undefined,
        undefined,
        {},
      ) as { content: Array<{ text: string }> };
      assert.match(inspectPage.content[0]?.text ?? "", /line-5/u);
      assert.match(inspectPage.content[0]?.text ?? "", /line-7/u);
      assert.doesNotMatch(inspectPage.content[0]?.text ?? "", /line-8/u);
      for (const command of ["play", "diff", "verify", "apply", "discard"]) {
        assert.ok(pi.commands.has(command));
      }
      assert.deepEqual([...pi.commands.keys()], [
        "play",
        "diff",
        "verify",
        "apply",
        "discard",
      ]);
      const provider = pi.providers.get("dungeon-maintainer") as {
        apiKey?: string;
        models?: Array<{ id?: string; reasoning?: boolean }>;
      };
      assert.equal(provider.apiKey, "$DUNGEON_MAINTAINER_PROFILE_KEY_DEFAULT");
      const registeredModel = provider.models?.[0];
      assert.ok(registeredModel);
      assert.equal(registeredModel.id, "fixed-model");
      assert.equal(registeredModel.reasoning, true);
      assert.ok(!JSON.stringify(provider).includes("provider-secret"));

      const repeatedToolText = "相同证据".repeat(100);
      const contextResult = await requireHook(pi, "context")({
        messages: [
          {
            role: "toolResult",
            toolCallId: "older-call",
            toolName: "inspect",
            content: [{ type: "text", text: repeatedToolText }],
            isError: false,
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "newer-call",
            toolName: "inspect",
            content: [{ type: "text", text: repeatedToolText }],
            isError: false,
            timestamp: 2,
          },
        ],
      }) as { messages: Array<{ content: Array<{ text: string }> }> };
      assert.equal(contextResult.messages[0]?.content[0]?.text, repeatedToolText);
      assert.equal(contextResult.messages[1]?.content[0]?.text, repeatedToolText);

      const oversizedContext = await requireHook(pi, "context")({
        messages: Array.from({ length: 32 }, (_value, index) => ({
          role: "toolResult",
          toolCallId: "large-call-" + String(index),
          toolName: "read",
          content: [{
            type: "text",
            text: String(index).padStart(2, "0") + "-" + "x".repeat(5_000),
          }],
          isError: false,
          timestamp: index,
        })),
      }) as { messages: Array<{ content: Array<{ text: string }> }> };
      const boundedTexts = oversizedContext.messages.map(
        (message) => message.content[0]?.text ?? "",
      );
      assert.equal(boundedTexts.length, 32);
      assert.ok(boundedTexts.reduce((sum, text) => sum + text.length, 0) <= 16_384);
      assert.ok(boundedTexts.some((text) => text.includes("TOOL_RESULT_RECEIPT")));
      assert.equal(boundedTexts.at(-1)?.length, 2_048);
      assert.match(boundedTexts.at(-1) ?? "", /工具结果稳定截断/u);
      assert.match(boundedTexts.at(-1) ?? "", /^31-/u);
      assert.match(boundedTexts.at(0) ?? "", /TOOL_RESULT_RECEIPT/u);

      const resetAcrossUsers = await requireHook(pi, "context")({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "first" }],
          },
          {
            role: "toolResult",
            toolCallId: "turn-one",
            toolName: "inspect",
            content: [{ type: "text", text: repeatedToolText }],
            isError: false,
          },
          {
            role: "user",
            content: [{ type: "text", text: "second" }],
          },
          {
            role: "toolResult",
            toolCallId: "turn-two",
            toolName: "inspect",
            content: [{ type: "text", text: repeatedToolText }],
            isError: false,
          },
        ],
      }) as { messages: Array<{ role: string; content: Array<{ text: string }> }> };
      assert.equal(resetAcrossUsers.messages.length, 4);
      assert.equal(resetAcrossUsers.messages[3]?.content[0]?.text, repeatedToolText);

      const promptResult = await requireHook(pi, "before_agent_start")(
        {
          prompt: "当前在哪一层，状态是什么？",
          systemPrompt: "PROJECT AGENTS SENTINEL",
        },
        { getContextUsage: () => undefined },
      ) as {
        systemPrompt: string;
        message?: unknown;
      };
      assert.deepEqual(pi.activeTools, [...FULL_CODING_TOOLS]);
      const fixedToolNames = new Set<string>(pi.activeTools);
      assert.ok(!fixedToolNames.has("read"));
      assert.ok(!fixedToolNames.has("grep"));
      assert.ok(!fixedToolNames.has("find"));
      assert.ok(!fixedToolNames.has("ls"));
      assert.ok(!fixedToolNames.has("edit"));
      assert.ok(fixedToolNames.has("write"));
      assert.ok(!fixedToolNames.has("bash"));
      assert.match(promptResult.systemPrompt, /SQL Dungeon/u);
      assert.match(promptResult.systemPrompt, /PROJECT AGENTS SENTINEL/u);
      assert.match(promptResult.systemPrompt, /一个 Pi Agent Loop/u);
      assert.match(promptResult.systemPrompt, /finish\(status=proposed\)/u);
      assert.match(promptResult.systemPrompt, /用户批准.*前，write\/patch 都会被拒绝/u);
      assert.match(promptResult.systemPrompt, /结构化断言/u);
      assert.match(JSON.stringify(promptResult.message), /本轮最高优先级请求/u);
      assert.match(JSON.stringify(promptResult.message), /当前在哪一层/u);
      assert.match(JSON.stringify(promptResult.message), /full-view-sentinel/u);
      assert.match(promptResult.systemPrompt, /不加载 Bash/u);

      const finishTool = pi.toolDefinitions.get("finish");
      assert.ok(finishTool?.execute);
      const executeFinish = finishTool.execute;
      await assert.rejects(
        async () => await executeFinish(
          "call-invalid-reproduction",
          {
            status: "reproduced",
            summary: "终端动作已复现。",
            risk: "只保存复现。",
            reproduction: {
              title: "终端未打开",
              expected: "修复后 terminalOpen=true",
              actual: "当前终端未打开",
              evidence: ["terminal action 返回失败"],
              assertions: { terminalOpen: false },
            },
          },
          undefined,
          undefined,
          { ui: {} },
        ),
        /必须描述修复后的期望值 true/u,
      );
      await assert.rejects(
        async () => await executeFinish(
          "call-uncertain-proposal",
          {
            status: "proposed",
            summary: "已定位目标文件，但准备顺手修改相邻映射。",
            risk: "相邻映射是否需要修改仍需确认。",
            plan: {
              title: "修改当前故障与相邻映射",
              steps: ["修正当前错误。", "顺手修改相邻映射。"],
              verification: "运行固定检查。",
              allowedPaths: ["first.txt"],
            },
          },
          undefined,
          undefined,
          { ui: {} },
        ),
        /只保留现有证据直接证明的最小修复/u,
      );
      let approvalCount = 0;
      const proposedResult = await finishTool.execute(
        "call-proposed",
        {
          status: "proposed",
            summary: "楼层推进状态没有在传送动画结束后恢复。\n证据：<button id=\"open-sql\"> 已确认。",
          risk: "只影响楼层切换状态机。",
          plan: {
            title: "修复楼层推进状态并补充回归测试",
            steps: [
              { text: "修正推进失败时的状态恢复。" },
              "补充成功和失败路径测试。",
              "刷新游戏并重放传送步骤。",
            ],
            verification: "运行聚焦测试，并在右侧游戏重放相同步骤。",
            allowedPaths: ["first.txt", "second.txt"],
          },
        },
        undefined,
        undefined,
        {
          ui: {
            confirm: async (title: string, message: string) => {
              approvalCount += 1;
              assert.equal(title, "是否执行完整修复方案");
              assert.match(message, /病因：楼层推进状态/u);
              assert.match(message, /‹button id="open-sql"›/u);
              assert.match(message, /1\. 修正推进失败/u);
              assert.match(message, /验证：运行聚焦测试/u);
              return true;
            },
          },
        },
      ) as { terminate: boolean; details: { executionApproved: boolean } };
      assert.equal(approvalCount, 1);
      assert.equal(proposedResult.terminate, false);
      assert.equal(proposedResult.details.executionApproved, true);
      assert.deepEqual(pi.activeTools, [...FULL_CODING_TOOLS]);

      const toolCallHook = requireHook(pi, "tool_call");
      const toolResultHook = requireHook(pi, "tool_result");
      const refreshNotifications: string[] = [];
      const refreshContext = {
        ui: {
          notify: (message: string) => refreshNotifications.push(message),
        },
      };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "native-one",
        toolName: "write",
        input: { path: "first.txt", content: "one\n" },
      }, refreshContext), undefined);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "native-two",
        toolName: "write",
        input: { path: "second.txt", content: "two\n" },
      }, refreshContext), undefined);
      await writeFile(join(task.worktreeRoot, "first.txt"), "one\n", "utf8");
      await writeFile(join(task.worktreeRoot, "second.txt"), "two\n", "utf8");
      const firstNativeResult = await toolResultHook({
        type: "tool_result",
        toolCallId: "native-one",
        toolName: "write",
        input: { path: "first.txt", content: "one\n" },
        content: [{ type: "text", text: "first written" }],
        details: undefined,
        isError: false,
      }, refreshContext);
      assert.equal(firstNativeResult, undefined);
      assert.deepEqual(lifecycle, ["checkpoint"]);
      const secondNativeResult = await toolResultHook({
        type: "tool_result",
        toolCallId: "native-two",
        toolName: "write",
        input: { path: "second.txt", content: "two\n" },
        content: [{ type: "text", text: "second written" }],
        details: undefined,
        isError: false,
      }, refreshContext) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      assert.deepEqual(lifecycle, ["checkpoint", "reload"]);
      assert.equal(secondNativeResult.content[0]?.text, "second written");
      assert.match(secondNativeResult.content[1]?.text ?? "", /已刷新/u);
      assert.equal(secondNativeResult.isError, undefined);
      assert.deepEqual([...task.changedPaths].sort(), ["first.txt", "second.txt"]);
      assert.equal(refreshNotifications.length, 1);
      assert.equal(pi.sentMessages.length, 0);

      const checkGate = await toolCallHook({
        type: "tool_call",
        toolCallId: "check-after-refresh",
        toolName: "check",
        input: { id: "rules-validate" },
      }, refreshContext);
      lifecycle.push("check-gate");
      assert.equal(checkGate, undefined);
      task.state = "verifying";
      await store.save(task);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "second-check-while-verifying",
        toolName: "check",
        input: { id: "game-architecture" },
      }, refreshContext), undefined);
      const finishGate = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-after-refresh",
        toolName: "finish",
        input: { status: "result" },
      }, refreshContext);
      assert.equal(finishGate, undefined);

      const conclusionNotifications: string[] = [];
      const resultConclusion = await finishTool.execute(
        "call-result",
        {
          status: "result",
          summary: "已修复楼层推进状态并通过聚焦测试。",
          risk: "固定检查、刷新重放和隐藏断言均已通过。",
        },
        undefined,
        undefined,
        {
          ui: {
            notify: (message: string) => conclusionNotifications.push(message),
          },
        },
      ) as { terminate: boolean };
      assert.equal(resultConclusion.terminate, true);
      assert.match(conclusionNotifications.at(-1) ?? "", /已修复楼层推进状态/u);
      assert.match(conclusionNotifications.at(-1) ?? "", /可以执行 \/apply/u);
      assert.deepEqual(lifecycle, [
        "checkpoint",
        "reload",
        "check-gate",
        "verify",
      ]);
      assert.deepEqual(pi.activeTools, [...FULL_CODING_TOOLS]);
      await requireHook(pi, "agent_end")(
        { type: "agent_end", messages: [] },
        {
          getContextUsage: () => ({ percent: 20 }),
          ui: { notify: () => undefined },
        },
      );
      assert.equal(task.state, "ready_to_apply");
      assert.equal(pi.sentMessages.length, 0);

      const deniedProposal = await finishTool.execute(
        "call-denied",
        {
          status: "proposed",
          summary: "已定位另一个独立状态错误。",
          risk: "需要修改状态恢复分支。",
          plan: {
            title: "修复独立状态错误",
            steps: ["修改状态恢复条件。"],
            verification: "运行对应状态机测试。",
            allowedPaths: ["third.txt"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => false, notify: () => undefined } },
      ) as { terminate: boolean; details: { executionApproved: boolean } };
      assert.equal(deniedProposal.terminate, true);
      assert.equal(deniedProposal.details.executionApproved, false);
      assert.deepEqual(pi.activeTools, [...FULL_CODING_TOOLS]);

      const notifications: string[] = [];
      const switchResult = await requireHook(pi, "session_before_switch")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { cancel: boolean };
      assert.deepEqual(switchResult, { cancel: true });
      const forkResult = await requireHook(pi, "session_before_fork")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { cancel: boolean };
      assert.deepEqual(forkResult, { cancel: true });
      const treeResult = await requireHook(pi, "session_before_tree")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { cancel: boolean };
      assert.deepEqual(treeResult, { cancel: true });
      const bashResult = await requireHook(pi, "user_bash")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { result: { exitCode: number; output: string } };
      assert.equal(bashResult.result.exitCode, 1);
      assert.match(bashResult.result.output, /禁止/u);

      await requireHook(pi, "input")({
        source: "rpc",
        text: "当前在哪一层，状态是什么？",
      });
      assert.equal(task.objective, "当前在哪一层，状态是什么？");
      await requireHook(pi, "input")({
        source: "rpc",
        text: "检查并修复默认答案错误 api_key=abcdefghijklmnop",
      });
      assert.match(task.objective, /检查并修复默认答案错误/u);
      assert.ok(!task.objective.includes("abcdefghijklmnop"));
      const repairObjective = task.objective;
      await requireHook(pi, "input")({
        source: "rpc",
        text: "现在进度如何？",
      });
      assert.equal(task.objective, repairObjective);
    } finally {
      await repository.dispose();
    }
  });

  it("修复请求覆盖旧目标但不创建隐藏阶段，状态问答仍可自然结束", async () => {
    const repository = await createTemporaryGitRepository({
      "README.md": "baseline\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-single-agent-request",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-single-agent-request"), "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const pi = new RecordingExtensionApi();
      const driver = {
        trace: new SemanticTrace(10),
        peek: async () => ({
          floor: 3,
          mode: "combat",
          prompt: "SELECT id FROM monsters",
        }),
      } as unknown as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({
          LOCALAPPDATA: dataDir,
          MAINTAINER_API_KEY: "provider-secret",
        }),
        store,
        task,
        evidenceStore: evidence,
        gameRuntime: {
          currentDriver: () => driver,
          requireDriver: () => driver,
          ensure: async () => driver,
          close: async () => undefined,
        },
      });
      const notifications: string[] = [];
      const hookContext = {
        getContextUsage: () => ({ percent: 20 }),
        ui: {
          notify: (message: string) => notifications.push(message),
        },
      };
      const inputHook = requireHook(pi, "input");
      const agentEndHook = requireHook(pi, "agent_end");

      await inputHook({ source: "rpc", text: "当前状态是什么？" });
      await agentEndHook({ type: "agent_end", messages: [] }, hookContext);
      assert.equal(pi.sentMessages.length, 0);

      const repairRequest = "第一层进入 SELECT 战斗后终端不出现，请直接定位并修复。";
      await inputHook({ source: "rpc", text: repairRequest });
      assert.equal(task.objective, repairRequest);
      assert.equal(pi.hooks.has("agent_start"), false);
      assert.equal(pi.hooks.has("agent_settled"), false);

      const dynamic = await requireHook(pi, "before_agent_start")(
        { prompt: repairRequest, systemPrompt: "PROJECT AGENTS SENTINEL" },
        hookContext,
      ) as { systemPrompt: string; message?: unknown };
      const dynamicText = JSON.stringify(dynamic.message);
      assert.match(dynamic.systemPrompt, /PROJECT AGENTS SENTINEL/u);
      assert.match(dynamicText, /本轮最高优先级请求/u);
      assert.match(dynamicText, /SELECT 战斗后终端不出现/u);
      assert.match(dynamicText, /SELECT id FROM monsters/u);
      assert.doesNotMatch(dynamicText, /滚动任务|阶段指令|诊断门禁|active 证据卡/u);

      const inspectGate = await requireHook(pi, "tool_call")({
        type: "tool_call",
        toolCallId: "autonomous-inspect",
        toolName: "inspect",
        input: { action: "search", query: "terminal" },
      }, hookContext);
      assert.equal(inspectGate, undefined);
      const unapprovedWrite = await requireHook(pi, "tool_call")({
        type: "tool_call",
        toolCallId: "unapproved-write",
        toolName: "write",
        input: { path: "README.md", content: "forbidden\n" },
      }, hookContext) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(unapprovedWrite.block, true);
      assert.equal(unapprovedWrite.terminate, false);
      assert.match(unapprovedWrite.reason, /finish\(status=proposed\)/u);

      const finishTool = pi.toolDefinitions.get("finish");
      assert.ok(finishTool?.execute);
      const executeFinish = finishTool.execute;
      await assert.rejects(
        async () => await executeFinish(
          "premature-diagnosed",
          { status: "diagnosed", summary: "已找到原因。", risk: "无" },
          undefined,
          undefined,
          hookContext,
        ),
        /diagnosed 不是终态/u,
      );
      await agentEndHook({ type: "agent_end", messages: [] }, hookContext);
      assert.equal(pi.sentMessages.length, 0);

      await inputHook({ source: "rpc", text: "现在状态如何？" });
      assert.equal(task.objective, repairRequest);
      await requireHook(pi, "before_agent_start")(
        { prompt: "现在状态如何？", systemPrompt: "PROJECT AGENTS SENTINEL" },
        {
          ...hookContext,
          getContextUsage: () => ({ percent: 85 }),
        },
      );
      assert.match(notifications.at(-1) ?? "", /上下文已超过 60%/u);
      assert.equal(pi.sentMessages.length, 0);
    } finally {
      await repository.dispose();
    }
  });

  it("刷新失败合并进最后一个原生工具结果，并阻断后续检查和 result", async () => {
    const repository = await createTemporaryGitRepository({
      "README.md": "baseline\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-refresh-failure",
        objective: "验证刷新失败门禁",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-refresh-failure"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      let reloadCount = 0;
      const driver = {
        ensureReproductionCheckpoint: async () => undefined,
        reloadAndReplay: async () => {
          reloadCount += 1;
          throw new Error("bridge unavailable");
        },
      } as unknown as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({
          LOCALAPPDATA: dataDir,
          MAINTAINER_API_KEY: "provider-secret",
        }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => driver,
          requireDriver: () => driver,
          ensure: async () => driver,
          close: async () => undefined,
        },
        verifyTask: async () => {
          throw new Error("刷新失败时不应进入 verifyTask");
        },
      });
      const finishTool = pi.toolDefinitions.get("finish");
      assert.ok(finishTool?.execute);
      await finishTool.execute(
        "approve-refresh-failure",
        {
          status: "proposed",
          summary: "已定位刷新失败测试路径。",
          risk: "仅用于测试。",
          plan: {
            title: "写入后刷新",
            steps: ["修改测试文件。"],
            verification: "检查刷新门禁。",
            allowedPaths: ["changed.txt", "fallback.txt"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );

      const toolCallHook = requireHook(pi, "tool_call");
      const toolResultHook = requireHook(pi, "tool_result");
      const notifications: string[] = [];
      const hookContext = {
        ui: { notify: (message: string) => notifications.push(message) },
      };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "write-failing-refresh",
        toolName: "write",
        input: { path: "changed.txt", content: "changed\n" },
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "changed.txt"), "changed\n", "utf8");
      const nativeResult = await toolResultHook({
        type: "tool_result",
        toolCallId: "write-failing-refresh",
        toolName: "write",
        input: { path: "changed.txt", content: "changed\n" },
        content: [{ type: "text", text: "native write completed" }],
        details: undefined,
        isError: false,
      }, hookContext) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      assert.equal(reloadCount, 1);
      assert.equal(nativeResult.isError, true);
      assert.equal(nativeResult.content[0]?.text, "native write completed");
      assert.match(nativeResult.content[1]?.text ?? "", /刷新重放未通过/u);
      assert.match(notifications.at(-1) ?? "", /刷新重放未通过/u);

      // 正常路径已经在 tool_result 刷新；turn_end 只兜底处理缺失的结果事件。
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "write-without-result-event",
        toolName: "write",
        input: { path: "fallback.txt", content: "fallback\n" },
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "fallback.txt"), "fallback\n", "utf8");
      await requireHook(pi, "turn_end")({}, hookContext);
      assert.equal(reloadCount, 2);

      const blockedCheck = await toolCallHook({
        type: "tool_call",
        toolCallId: "blocked-check",
        toolName: "check",
        input: { id: "rules-validate" },
      }, hookContext) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(blockedCheck.block, true);
      assert.equal(blockedCheck.terminate, false);
      assert.match(blockedCheck.reason, /刷新门禁未通过/u);
      const blockedResult = await toolCallHook({
        type: "tool_call",
        toolCallId: "blocked-result",
        toolName: "finish",
        input: { status: "result" },
      }, hookContext) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(blockedResult.block, true);
      assert.equal(blockedResult.terminate, false);
      assert.match(blockedResult.reason, /继续修复后重试/u);
      assert.deepEqual(pi.activeTools, [...FULL_CODING_TOOLS]);
    } finally {
      await repository.dispose();
    }
  });

  it("旧 write 刷新失败后，成功 patch 清除统一刷新门禁", async () => {
    const repository = await createTemporaryGitRepository({
      "README.md": "baseline\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data-patch-refresh-recovery");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-patch-refresh-recovery",
        objective: "验证 patch 可以修复旧刷新失败",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-patch-refresh-recovery"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const driver = {
        ensureReproductionCheckpoint: async () => undefined,
        reloadAndReplay: async () => {
          throw new Error("bridge unavailable");
        },
      } as unknown as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({
          LOCALAPPDATA: dataDir,
          MAINTAINER_API_KEY: "provider-secret",
        }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => driver,
          requireDriver: () => driver,
          ensure: async () => driver,
          close: async () => undefined,
        },
      });
      const finishTool = pi.toolDefinitions.get("finish");
      assert.ok(finishTool?.execute);
      await finishTool.execute(
        "approve-patch-refresh-recovery",
        {
          status: "proposed",
          summary: "已定位刷新失败后的修复路径。",
          risk: "仅验证统一刷新门禁。",
          plan: {
            title: "用精确补丁恢复刷新",
            steps: ["先触发旧刷新失败，再应用成功补丁。"],
            verification: "确认 check 和 result 不再被旧失败阻断。",
            allowedPaths: ["changed.txt", "README.md"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );

      const toolCallHook = requireHook(pi, "tool_call");
      const toolResultHook = requireHook(pi, "tool_result");
      const hookContext = { ui: { notify: () => undefined } };
      const writeInput = { path: "changed.txt", content: "changed\n" };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "write-before-patch-recovery",
        toolName: "write",
        input: writeInput,
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "changed.txt"), "changed\n", "utf8");
      const failedWrite = await toolResultHook({
        type: "tool_result",
        toolCallId: "write-before-patch-recovery",
        toolName: "write",
        input: writeInput,
        content: [{ type: "text", text: "native write completed" }],
        details: undefined,
        isError: false,
      }, hookContext) as { isError: boolean };
      assert.equal(failedWrite.isError, true);
      const blockedBeforePatch = await toolCallHook({
        type: "tool_call",
        toolCallId: "check-before-patch-recovery",
        toolName: "check",
        input: { id: "rules-validate" },
      }, hookContext) as { block: boolean };
      assert.equal(blockedBeforePatch.block, true);

      const patchInput = {
        edits: [{
          path: "README.md",
          baseHash: "baseline-hash",
          oldText: "baseline",
          newText: "fixed",
        }],
      };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "patch-refresh-recovery",
        toolName: "patch",
        input: patchInput,
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "README.md"), "fixed\n", "utf8");
      await toolResultHook({
        type: "tool_result",
        toolCallId: "patch-refresh-recovery",
        toolName: "patch",
        input: patchInput,
        content: [{ type: "text", text: "patch replay passed" }],
        details: {
          replay: { passed: true, actionCount: 0, failure: null },
        },
        isError: false,
      }, hookContext);

      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "check-after-patch-recovery",
        toolName: "check",
        input: { id: "rules-validate" },
      }, hookContext), undefined);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "result-after-patch-recovery",
        toolName: "finish",
        input: { status: "result" },
      }, hookContext), undefined);

      const events = (await readFile(join(store.taskDir(task.id), "events.jsonl"), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { type: string; detail: Record<string, unknown> });
      const writes = events.filter((event) => event.type === "tool.write_outcome");
      assert.deepEqual(writes.map((event) => event.detail.outcome), [
        "mutated_replay_failed",
        "mutated",
      ]);
    } finally {
      await repository.dispose();
    }
  });

  it("patch 自身重放失败后，统一刷新门禁阻断 check 和 result", async () => {
    const repository = await createTemporaryGitRepository({
      "README.md": "baseline\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data-patch-refresh-failure");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-patch-refresh-failure",
        objective: "验证 patch 刷新失败门禁",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-patch-refresh-failure"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const driver = {} as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({
          LOCALAPPDATA: dataDir,
          MAINTAINER_API_KEY: "provider-secret",
        }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => driver,
          ensure: async () => driver,
          close: async () => undefined,
        },
      });
      const finishTool = pi.toolDefinitions.get("finish");
      assert.ok(finishTool?.execute);
      await finishTool.execute(
        "approve-patch-refresh-failure",
        {
          status: "proposed",
          summary: "已定位精确补丁刷新失败路径。",
          risk: "仅验证统一刷新门禁。",
          plan: {
            title: "验证 patch 重放失败",
            steps: ["写入精确补丁并模拟 afterPatch 重放失败。"],
            verification: "阻断后续 check 和 result。",
            allowedPaths: ["README.md"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );

      const toolCallHook = requireHook(pi, "tool_call");
      const toolResultHook = requireHook(pi, "tool_result");
      const hookContext = { ui: { notify: () => undefined } };
      const patchInput = {
        edits: [{
          path: "README.md",
          baseHash: "baseline-hash",
          oldText: "baseline",
          newText: "changed",
        }],
      };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "patch-refresh-failure",
        toolName: "patch",
        input: patchInput,
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "README.md"), "changed\n", "utf8");
      await toolResultHook({
        type: "tool_result",
        toolCallId: "patch-refresh-failure",
        toolName: "patch",
        input: patchInput,
        content: [{
          type: "text",
          text: "新代码刷新后的复现重放失败：bridge unavailable",
        }],
        details: undefined,
        isError: true,
      }, hookContext);

      const blockedCheck = await toolCallHook({
        type: "tool_call",
        toolCallId: "check-after-patch-refresh-failure",
        toolName: "check",
        input: { id: "rules-validate" },
      }, hookContext) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(blockedCheck.block, true);
      assert.equal(blockedCheck.terminate, false);
      assert.match(blockedCheck.reason, /精确补丁已写入/u);
      const blockedResult = await toolCallHook({
        type: "tool_call",
        toolCallId: "result-after-patch-refresh-failure",
        toolName: "finish",
        input: { status: "result" },
      }, hookContext) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(blockedResult.block, true);
      assert.equal(blockedResult.terminate, false);
      assert.match(blockedResult.reason, /bridge unavailable/u);

      const events = (await readFile(join(store.taskDir(task.id), "events.jsonl"), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { type: string; detail: Record<string, unknown> });
      const write = events.find((event) => (
        event.type === "tool.write_outcome"
        && event.detail.toolName === "patch"
      ));
      assert.ok(write);
      assert.equal(write.detail.outcome, "mutated_replay_failed");
      assert.equal(write.detail.reasonCode, "refresh-replay-failed");
    } finally {
      await repository.dispose();
    }
  });

  it("拒绝越界原生路径和无代码变化的 result，并保留本轮修改权限", async () => {
    const repository = await createTemporaryGitRepository({
      "README.md": "baseline\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-no-change-result",
        objective: "验证结果证据门禁",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-no-change-result"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      let runtimeEnsureCount = 0;
      const driver = {} as GameDriver;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({
          LOCALAPPDATA: dataDir,
          MAINTAINER_API_KEY: "provider-secret",
        }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => driver,
          ensure: async () => {
            runtimeEnsureCount += 1;
            return driver;
          },
          close: async () => undefined,
        },
      });
      const finishTool = pi.toolDefinitions.get("finish");
      assert.ok(finishTool?.execute);
      await finishTool.execute(
        "approve-no-change",
        {
          status: "proposed",
          summary: "已定位静态测试问题。",
          risk: "仅修改测试文件。",
          plan: {
            title: "执行最小修改",
            steps: ["修改测试文件。"],
            verification: "运行固定检查。",
            allowedPaths: ["README.md", "linked-outside/escape.txt"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );
      const toolCallHook = requireHook(pi, "tool_call");
      const formalRepositoryPath = await toolCallHook({
        type: "tool_call",
        toolCallId: "formal-repo-write",
        toolName: "write",
        input: {
          path: join(task.repoRoot, "README.md"),
          content: "forbidden\n",
        },
      }, { ui: { notify: () => undefined } }) as {
        block: boolean;
        terminate: boolean;
        reason: string;
      };
      assert.equal(formalRepositoryPath.block, true);
      assert.equal(formalRepositoryPath.terminate, false);
      assert.match(formalRepositoryPath.reason, /正式仓库绝对路径/u);
      const parentTraversal = await toolCallHook({
        type: "tool_call",
        toolCallId: "parent-traversal-write",
        toolName: "write",
        input: { path: "../escape.txt", content: "b" },
      }, { ui: { notify: () => undefined } }) as {
        block: boolean;
        terminate: boolean;
        reason: string;
      };
      assert.equal(parentTraversal.block, true);
      assert.equal(parentTraversal.terminate, false);
      assert.match(parentTraversal.reason, /不能包含 \.\./u);

      const outsideDirectory = join(repository.temporaryRoot, "outside-native-write");
      const linkedDirectory = join(task.worktreeRoot, "linked-outside");
      await mkdir(outsideDirectory, { recursive: true });
      await symlink(
        outsideDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      const linkedEscape = await toolCallHook({
        type: "tool_call",
        toolCallId: "linked-escape-write",
        toolName: "write",
        input: { path: "linked-outside/escape.txt", content: "forbidden\n" },
      }, { ui: { notify: () => undefined } }) as {
        block: boolean;
        terminate: boolean;
        reason: string;
      };
      assert.equal(linkedEscape.block, true);
      assert.equal(linkedEscape.terminate, false);
      assert.match(linkedEscape.reason, /realpath/u);
      assert.equal(runtimeEnsureCount, 0);

      const notifications: string[] = [];
      await assert.rejects(
        async () => {
          await finishTool.execute?.(
            "result-without-changes",
            {
              status: "result",
              summary: "声称已经修复。",
              risk: "没有实际变化。",
            },
            undefined,
            undefined,
            { ui: { notify: (message: string) => notifications.push(message) } },
          );
        },
        /任务 worktree 没有代码变化/u,
      );
      assert.deepEqual(notifications, []);
      assert.deepEqual(pi.activeTools, [...FULL_CODING_TOOLS]);
      assert.equal(task.state, "created");
    } finally {
      await repository.dispose();
    }
  });
  it("长 SQL 输入不会挤掉最新终端状态", () => {
    const view: PlayView = {
      floor: 1,
      mode: "combat",
      hp: { current: 2, max: 2, armor: 0 },
      progress: { lessons: 0, rooms: 1, moves: 0, queries: 1, hintLevel: 0 },
      actions: [{ id: "query", label: "提交" }],
      room: "测试房间",
      mission: { title: "题目", body: "目标", lesson: "说明" },
      record: null,
      terminal: {
        kind: "combat",
        title: "SELECT",
        objective: "当前目标",
        lessonId: "select",
        stageId: "stage-1",
        stageIndex: 0,
        task: null,
        schema: ["monsters"],
        locks: [],
        hints: [],
        inputSql: "SELECT ".padEnd(16 * 1024, "x"),
        status: { kind: "warning", text: "当前失败状态" },
        result: "当前结果",
        plan: ["SCAN monsters"],
      },
      prompt: "",
      banner: "",
    };
    const text = serializeGameToolResult(view);
    assert.match(text, /当前失败状态/u);
    assert.match(text, /当前结果/u);
    assert.match(text, /内容已截断/u);
  });
});

describe("Pi session-id、session-dir 与 worktree 固定绑定", () => {
  it("匹配时通过，任一 ID 漂移时拒绝", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const piSessionDir = join(repository.temporaryRoot, "task", "pi");
      const sessionFile = join(piSessionDir, "session_task-binding.jsonl");
      await mkdir(piSessionDir, { recursive: true });
      await writeFile(sessionFile, "{}\n", "utf8");
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      const task = await store.create({
        id: "task-binding",
        objective: "验证绑定",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir,
      });
      const sessionManager = {
        getSessionDir: () => piSessionDir,
        getCwd: () => repository.repoRoot,
        getSessionId: () => task.id,
        getSessionFile: () => sessionFile,
      };
      const context = {
        cwd: repository.repoRoot,
        sessionManager,
      } as unknown as ExtensionContext;

      await assertTaskSessionBinding(context, task);
      const driftedContext = {
        cwd: repository.repoRoot,
        sessionManager: {
          ...sessionManager,
          getSessionId: () => "other-task",
        },
      } as unknown as ExtensionContext;
      await assert.rejects(
        assertTaskSessionBinding(driftedContext, task),
        /session-id/u,
      );
    } finally {
      await repository.dispose();
    }
  });
});
