import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
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

describe("Pi Extension 分阶段工具、命令和会话阻断", () => {
  it("注册十个领域工具，并用执行门禁保护固定 Coding 工具面", async () => {
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
      assert.match(contextResult.messages[0]?.content[0]?.text ?? "", /重复工具结果已省略/u);
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
      assert.ok(boundedTexts.every((text) => text.length <= 4_096));
      assert.ok(boundedTexts.some((text) => text.includes("已按 Token 预算截断")));
      assert.ok(boundedTexts.some((text) => text === "[较早工具结果已省略]"));
      assert.match(boundedTexts.at(-1) ?? "", /^31-/u);
      assert.equal(boundedTexts.at(0), "[较早工具结果已省略]");
      assert.ok(boundedTexts.reduce((sum, text) => sum + text.length, 0) <= 24_576);

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
      assert.equal(resetAcrossUsers.messages[1]?.content[0]?.text, repeatedToolText);
      assert.equal(resetAcrossUsers.messages[3]?.content[0]?.text, repeatedToolText);

      const promptResult = await requireHook(pi, "before_agent_start")(
        { prompt: "当前在哪一层，状态是什么？" },
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
      assert.ok(fixedToolNames.has("edit"));
      assert.ok(fixedToolNames.has("write"));
      assert.ok(!fixedToolNames.has("bash"));
      assert.match(promptResult.systemPrompt, /detached worktree/u);
      assert.match(promptResult.systemPrompt, /SQL Dungeon/u);
      assert.match(promptResult.systemPrompt, /实时玩家投影/u);
      assert.match(promptResult.systemPrompt, /普通状态问题最多 3 次低价值读取/u);
      assert.match(promptResult.systemPrompt, /finish\(status=proposed\)/u);
      assert.match(promptResult.systemPrompt, /只询问一次是否执行/u);
      assert.match(promptResult.systemPrompt, /结构化断言/u);
      assert.match(promptResult.systemPrompt, /本轮最高优先级请求/u);
      assert.match(promptResult.systemPrompt, /当前在哪一层/u);
      assert.match(promptResult.systemPrompt, /full-view-sentinel/u);
      assert.equal(promptResult.message, undefined);
      assert.ok(!promptResult.systemPrompt.includes("bash"));

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
      assert.deepEqual(lifecycle, ["ensure", "checkpoint"]);
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
      assert.deepEqual(lifecycle, ["ensure", "checkpoint", "reload"]);
      assert.equal(secondNativeResult.content[0]?.text, "second written");
      assert.match(secondNativeResult.content[1]?.text ?? "", /已刷新/u);
      assert.equal(secondNativeResult.isError, undefined);
      assert.deepEqual([...task.changedPaths].sort(), ["first.txt", "second.txt"]);
      assert.equal(refreshNotifications.length, 1);
      assert.equal(pi.sentMessages.length, 1);

      const checkGate = await toolCallHook({
        type: "tool_call",
        toolCallId: "check-after-refresh",
        toolName: "check",
        input: { id: "rules-validate" },
      }, refreshContext);
      lifecycle.push("check-gate");
      assert.equal(checkGate, undefined);
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
        "ensure",
        "checkpoint",
        "reload",
        "check-gate",
        "verify",
      ]);
      assert.deepEqual(pi.activeTools, [...FULL_CODING_TOOLS]);

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

      const agentStartHook = requireHook(pi, "agent_start");
      const budgetNotifications: string[] = [];
      const budgetContext = {
        ui: {
          notify: (message: string) => budgetNotifications.push(message),
        },
      };
      agentStartHook({});
      for (let index = 0; index < 3; index += 1) {
        assert.equal(await toolCallHook({
          toolName: "inspect",
          input: { action: "search", query: "candidate-" + String(index) },
        }, budgetContext), undefined);
      }
      // 普通状态请求在低价值读取达到上限后自动收尾，不能误伤第一个游戏动作。
      assert.equal(await toolCallHook({ toolName: "look", input: {} }, budgetContext), undefined);
      const inspectOverflow = await toolCallHook({
        toolName: "inspect",
        input: { action: "status" },
      }, budgetContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.deepEqual(inspectOverflow, {
        block: true,
        terminate: false,
        reason: "本轮读取预算已达到上限；正在根据已有证据自动收尾。",
      });
      assert.match(budgetNotifications.at(-1) ?? "", /自动收尾/u);

      await requireHook(pi, "input")({
        source: "rpc",
        text: "新的状态问题",
      });
      agentStartHook({});
      for (let index = 0; index < 6; index += 1) {
        assert.equal(await toolCallHook({
          toolName: "use",
          input: { actionId: "candidate-" + String(index) },
        }, budgetContext), undefined);
      }

      // 同一修复请求跨 agent follow-up 共享 inspect 预算；新自然语言问题才会重置。
      await requireHook(pi, "input")({
        source: "rpc",
        text: "请重新定位并修复右侧游戏动作失败的问题。",
      });
      agentStartHook({});
      assert.equal(await toolCallHook({ toolName: "inspect", input: { action: "status" } }, budgetContext), undefined);
      assert.equal(await toolCallHook({ toolName: "inspect", input: { action: "status" } }, budgetContext), undefined);
      const repeatedInspect = await toolCallHook({
        toolName: "inspect",
        input: { action: "status" },
      }, budgetContext) as { block?: boolean; terminate?: boolean };
      assert.equal(repeatedInspect.block, true);
      assert.equal(repeatedInspect.terminate, false);
      assert.match(budgetNotifications.at(-1) ?? "", /相同参数/u);

      await requireHook(pi, "input")({
        source: "rpc",
        text: "请定位并修复右侧游戏动作失败的问题。",
      });
      agentStartHook({});
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.equal(await toolCallHook({
          type: "tool_call",
          toolCallId: "failed-go-" + String(attempt),
          toolName: "go",
          input: { target: "objective", maxSteps: 64 },
        }, budgetContext), undefined);
        await requireHook(pi, "tool_result")({
          type: "tool_result",
          toolCallId: "failed-go-" + String(attempt),
          toolName: "go",
          input: { target: "objective", maxSteps: 64 },
          content: [{ type: "text", text: "blocked" }],
          details: { ok: false, event: "blocked" },
          isError: false,
        }, budgetContext);
      }
      const repeatedFailedGameAction = await toolCallHook({
        type: "tool_call",
        toolCallId: "failed-go-third",
        toolName: "go",
        input: { target: "objective", maxSteps: 64 },
      }, budgetContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.equal(repeatedFailedGameAction.block, true);
      assert.equal(repeatedFailedGameAction.terminate, false);
      assert.match(repeatedFailedGameAction.reason ?? "", /失败两次/u);
      task.objective = INITIAL_TASK_OBJECTIVE;
      await store.save(task);

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

  it("修复请求覆盖旧目标并自动续跑，状态问答仍可自然结束", async () => {
    const repository = await createTemporaryGitRepository({
      "README.md": "test\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-repair-continuation",
        objective: "当前在哪一层，状态是什么？",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-repair-continuation"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const driver = {
        peek: async () => ({
          floor: 3,
          mode: "combat",
          terminal: {
            task: "找出由主人守卫的怪物",
            inputSql: "SELECT id FROM monsters;",
          },
        }),
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
      const inputHook = requireHook(pi, "input");
      const agentEndHook = requireHook(pi, "agent_end");
      const continuationNotifications: string[] = [];
      const agentEndContext = {
        hasPendingMessages: () => false,
        getContextUsage: () => ({ percent: 20 }),
        ui: {
          notify: (message: string) => continuationNotifications.push(message),
        },
      };

      await inputHook({ source: "rpc", text: "当前状态是什么？" });
      agentEndHook({ type: "agent_end", messages: [] }, agentEndContext);
      assert.equal(pi.sentMessages.length, 0);

      const selectCombatRepair = "第一层进入 SELECT 战斗后终端不出现，请直接定位并修复。";
      await inputHook({ source: "rpc", text: selectCombatRepair });
      assert.equal(task.objective, selectCombatRepair);
      const promptResult = await requireHook(pi, "before_agent_start")(
        { prompt: selectCombatRepair },
        { getContextUsage: () => undefined },
      ) as { systemPrompt: string; message?: unknown };
      assert.match(promptResult.systemPrompt, /本轮最高优先级请求/u);
      assert.match(promptResult.systemPrompt, /SELECT 战斗后终端不出现/u);
      assert.match(promptResult.systemPrompt, /SELECT id FROM monsters/u);
      assert.equal(promptResult.message, undefined);

      const toolCallHook = requireHook(pi, "tool_call");
      const finishDiagnosed = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-diagnosed",
        toolName: "finish",
        input: { status: "diagnosed" },
      }, agentEndContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.equal(finishDiagnosed.block, true);
      assert.equal(finishDiagnosed.terminate, false);
      assert.match(finishDiagnosed.reason ?? "", /不能用 diagnosed 快速结束/u);

      const finishWithoutEvidence = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-empty",
        toolName: "finish",
        input: { status: "proposed", summary: "empty" },
      }, agentEndContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.equal(finishWithoutEvidence.block, true);
      assert.equal(finishWithoutEvidence.terminate, false);
      assert.match(finishWithoutEvidence.reason ?? "", /源码读取证据/u);

      await requireHook(pi, "tool_result")({
        type: "tool_result",
        toolCallId: "look-only",
        toolName: "look",
        input: {},
        content: [{ type: "text", text: "visible state" }],
        details: { floor: 3, mode: "combat" },
        isError: false,
      }, agentEndContext);
      const blockedFromLookOnly = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-blocked-look-only",
        toolName: "finish",
        input: { status: "blocked", summary: "look only" },
      }, agentEndContext) as { block?: boolean; reason?: string };
      assert.equal(blockedFromLookOnly.block, true);
      assert.match(blockedFromLookOnly.reason ?? "", /客观证据/u);

      await requireHook(pi, "tool_result")({
        type: "tool_result",
        toolCallId: "query-failed",
        toolName: "query",
        input: {},
        content: [{ type: "text", text: "query-rejected" }],
        details: { ok: false, event: "query-rejected" },
        isError: false,
      }, agentEndContext);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-blocked-query-failed",
        toolName: "finish",
        input: { status: "blocked", summary: "query failed" },
      }, agentEndContext), undefined);

      await requireHook(pi, "tool_result")({
        type: "tool_result",
        toolCallId: "inspect-status",
        toolName: "inspect",
        input: { action: "status" },
        content: [{ type: "text", text: "status only" }],
        details: undefined,
        isError: false,
      }, agentEndContext);
      const proposedFromStatusOnly = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-status-only",
        toolName: "finish",
        input: { status: "proposed", summary: "status only" },
      }, agentEndContext) as { block?: boolean; reason?: string };
      assert.equal(proposedFromStatusOnly.block, true);
      assert.match(proposedFromStatusOnly.reason ?? "", /源码读取证据/u);

      await requireHook(pi, "tool_result")({
        type: "tool_result",
        toolCallId: "check-failed",
        toolName: "check",
        input: { id: "game-test" },
        content: [{ type: "text", text: "game-test: failed" }],
        details: { status: "failed" },
        isError: false,
      }, agentEndContext);
      const proposedFromFailedCheckOnly = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-check-only",
        toolName: "finish",
        input: { status: "proposed", summary: "check only" },
      }, agentEndContext) as { block?: boolean; reason?: string };
      assert.equal(proposedFromFailedCheckOnly.block, true);
      assert.match(proposedFromFailedCheckOnly.reason ?? "", /源码读取证据/u);

      await requireHook(pi, "tool_result")({
        type: "tool_result",
        toolCallId: "finish-reproduced",
        toolName: "finish",
        input: { status: "reproduced" },
        content: [{ type: "text", text: "reproduced" }],
        details: { status: "reproduced" },
        isError: false,
      }, agentEndContext);
      await requireHook(pi, "tool_result")({
        type: "tool_result",
        toolCallId: "inspect-source",
        toolName: "inspect",
        input: { action: "search", query: "answerSql" },
        content: [{ type: "text", text: "SRC evidence" }],
        details: undefined,
        isError: false,
      }, agentEndContext);
      const proposedFromSearchOnly = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-search-only",
        toolName: "finish",
        input: { status: "proposed", summary: "search only" },
      }, agentEndContext) as { block?: boolean; reason?: string };
      assert.equal(proposedFromSearchOnly.block, true);
      assert.match(proposedFromSearchOnly.reason ?? "", /inspect\(read\)/u);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "inspect-source-read",
        toolName: "inspect",
        input: { action: "read", path: "src/game.ts", startLine: 1 },
      }, agentEndContext), undefined);
      await requireHook(pi, "tool_result")({
        type: "tool_result",
        toolCallId: "inspect-source-read",
        toolName: "inspect",
        input: { action: "read", path: "src/game.ts", startLine: 1 },
        content: [{ type: "text", text: "SRC read evidence" }],
        details: undefined,
        isError: false,
      }, agentEndContext);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-with-evidence",
        toolName: "finish",
        input: { status: "proposed", summary: "source and failed check" },
      }, agentEndContext), undefined);
      const forcedProposalTurn = await toolCallHook({
        type: "tool_call",
        toolCallId: "inspect-after-evidence",
        toolName: "inspect",
        input: { action: "search", query: "unrelated" },
      }, agentEndContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.deepEqual(forcedProposalTurn, {
        block: true,
        terminate: true,
        reason: "复现和源码证据已经足够；当前诊断回合已停止，请立即调用 finish(status=proposed) 提交一次性修复方案，不要继续搜索。",
      });

      for (let index = 0; index < 5; index += 1) {
        agentEndHook({ type: "agent_end", messages: [] }, agentEndContext);
      }
      assert.equal(pi.sentMessages.length, 4);
      for (const entry of pi.sentMessages) {
        assert.deepEqual(entry.options, {
          triggerTurn: true,
          deliverAs: "followUp",
        });
        assert.match(JSON.stringify(entry.message), /修复任务尚未完成/u);
      }

      await inputHook({
        source: "rpc",
        text: "请继续修复默认 SQL 错误。",
      });
      agentEndHook(
        { type: "agent_end", messages: [] },
        {
          ...agentEndContext,
          getContextUsage: () => ({ percent: 85 }),
        },
      );
      assert.equal(pi.sentMessages.length, 4);
      assert.match(continuationNotifications.at(-1) ?? "", /上下文已接近上限/u);

      const agentStartHook = requireHook(pi, "agent_start");
      agentStartHook({ type: "agent_start" });
      for (let index = 0; index < 8; index += 1) {
        assert.equal(await toolCallHook({
          type: "tool_call",
          toolCallId: "repair-budget-inspect-" + String(index),
          toolName: "inspect",
          input: {
            action: "search",
            query: "budget-inspect-" + String(index),
          },
        }, agentEndContext), undefined);
      }
      // follow-up 不会重置累计总预算；换用另一工具族仍可继续到总上限。
      agentStartHook({ type: "agent_start" });
      for (let index = 0; index < 8; index += 1) {
        assert.equal(await toolCallHook({
          type: "tool_call",
          toolCallId: "repair-budget-game-" + String(index),
          toolName: "use",
          input: { actionId: "budget-game-" + String(index) },
        }, agentEndContext), undefined);
      }
      agentStartHook({ type: "agent_start" });
      const cumulativeBudget = await toolCallHook({
        type: "tool_call",
        toolCallId: "repair-budget-overflow",
        toolName: "use",
        input: { actionId: "budget-overflow" },
      }, agentEndContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.equal(cumulativeBudget.block, true);
      assert.equal(cumulativeBudget.terminate, false);
      assert.match(cumulativeBudget.reason ?? "", /达到工具预算上限/u);
      agentEndHook({ type: "agent_end", messages: [] }, agentEndContext);
      assert.equal(pi.sentMessages.length, 5);

      const repairObjective = task.objective;
      await inputHook({ source: "rpc", text: "现在状态如何？" });
      agentEndHook({ type: "agent_end", messages: [] }, agentEndContext);
      assert.equal(pi.sentMessages.length, 5);
      assert.equal(task.objective, repairObjective);
    } finally {
      await repository.dispose();
    }
  });

  it("action-not-available 必须读取执行分支、动作映射和真实 DOM 后才能提交方案", async () => {
    const repository = await createTemporaryGitRepository({
      "README.md": "test\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-action-evidence",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-action-evidence"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const driver = {
        peek: async () => ({ floor: 1, mode: "combat", terminal: null }),
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
      const hookContext = {
        hasPendingMessages: () => false,
        getContextUsage: () => ({ percent: 20 }),
        ui: { notify: () => undefined },
      };
      const inputHook = requireHook(pi, "input");
      const toolCallHook = requireHook(pi, "tool_call");
      const toolResultHook = requireHook(pi, "tool_result");
      const agentEndHook = requireHook(pi, "agent_end");

      await inputHook({
        source: "rpc",
        text: "terminal 动作返回 action-not-available，请直接定位并修复。",
      });
      // details 缺失时仍必须从真实工具正文识别运行时失败类型和失败 actionId。
      await toolResultHook({
        type: "tool_result",
        toolCallId: "use-terminal-failed",
        toolName: "use",
        input: { actionId: "terminal" },
        content: [{
          type: "text",
          text: "{\"ok\":false,\"event\":\"action-not-available\"}",
        }],
        details: {},
        isError: false,
      }, hookContext);
      const sourceBeforeReproduction = await toolCallHook({
        type: "tool_call",
        toolCallId: "inspect-before-reproduced",
        toolName: "inspect",
        input: { action: "search", query: "terminal" },
      }, hookContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.equal(sourceBeforeReproduction.block, true);
      assert.equal(sourceBeforeReproduction.terminate, true);
      assert.match(sourceBeforeReproduction.reason ?? "", /finish\(status=reproduced\)/u);
      await toolResultHook({
        type: "tool_result",
        toolCallId: "finish-reproduced-action",
        toolName: "finish",
        input: { status: "reproduced" },
        content: [{ type: "text", text: "reproduced" }],
        details: { status: "reproduced" },
        isError: false,
      }, hookContext);
      await toolResultHook({
        type: "tool_result",
        toolCallId: "read-use-branch",
        toolName: "inspect",
        input: {
          action: "read",
          path: "game/src/devtools/dungeon-agent/bridge.ts",
          startLine: 278,
        },
        content: [{
          type: "text",
          text: [
            "const selector = DUNGEON_AGENT_ACTION_SELECTORS[actionId];",
            "if (!selector) return result(false, \"action-not-available\");",
            "if (!clickDungeonAgentAction(options.root, selector)) return result(false, \"action-not-available\");",
          ].join("\n"),
        }],
        details: { action: "read" },
        isError: false,
      }, hookContext);
      await toolResultHook({
        type: "tool_result",
        toolCallId: "read-projection",
        toolName: "inspect",
        input: {
          action: "read",
          path: "game/src/devtools/dungeon-agent/projection.ts",
          startLine: 100,
        },
        content: [{
          type: "text",
          text: "actions.push(action(\"terminal\", \"打开当前 SQL 战斗终端\"));\nreturn { terminal: terminalView(snapshot, overlay) };",
        }],
        details: { action: "read" },
        isError: false,
      }, hookContext);

      const prematureProposal = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-too-early",
        toolName: "finish",
        input: { status: "proposed" },
      }, hookContext) as { block?: boolean; reason?: string };
      assert.equal(prematureProposal.block, true);
      assert.match(prematureProposal.reason ?? "", /terminal 的动作映射字面量/u);
      assert.match(prematureProposal.reason ?? "", /真实 DOM 按钮定义/u);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "inspect-mapping-allowed",
        toolName: "inspect",
        input: {
          action: "read",
          path: "game/src/devtools/dungeon-agent/actions.ts",
        },
      }, hookContext), undefined);

      agentEndHook({ type: "agent_end", messages: [] }, hookContext);
      assert.match(
        JSON.stringify(pi.sentMessages.at(-1)?.message),
        /terminal 的动作映射字面量.*真实 DOM 按钮定义/u,
      );

      await toolResultHook({
        type: "tool_result",
        toolCallId: "read-action-mapping",
        toolName: "inspect",
        input: {
          action: "read",
          path: "game/src/devtools/dungeon-agent/actions.ts",
          startLine: 14,
        },
        content: [{
          type: "text",
          text: "   16 export const DUNGEON_AGENT_ACTION_SELECTORS = {\n   20   terminal: \"#open-sql-broken\",\n   28 };",
        }],
        details: { action: "read" },
        isError: false,
      }, hookContext);
      const missingDomProposal = await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-no-dom",
        toolName: "finish",
        input: { status: "proposed" },
      }, hookContext) as { block?: boolean; reason?: string };
      assert.equal(missingDomProposal.block, true);
      assert.doesNotMatch(missingDomProposal.reason ?? "", /动作映射字面量/u);
      assert.match(missingDomProposal.reason ?? "", /真实 DOM 按钮定义/u);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "inspect-dom-search-allowed",
        toolName: "inspect",
        input: {
          action: "search",
          query: "open-sql",
        },
      }, hookContext), undefined);

      await toolResultHook({
        type: "tool_result",
        toolCallId: "search-real-dom",
        toolName: "inspect",
        input: {
          action: "search",
          query: "open-sql",
        },
        content: [{
          type: "text",
          text: "game/src/presentation/dom/appShellTemplate.ts:356:  <button id=\"open-sql\" type=\"button\">SQL 战斗</button>",
        }],
        details: { action: "search" },
        isError: false,
      }, hookContext);
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "finish-proposed-complete",
        toolName: "finish",
        input: { status: "proposed" },
      }, hookContext), undefined);
      const stoppedSearch = await toolCallHook({
        type: "tool_call",
        toolCallId: "inspect-after-complete-evidence",
        toolName: "inspect",
        input: { action: "search", query: "unrelated" },
      }, hookContext) as { block?: boolean; terminate?: boolean; reason?: string };
      assert.equal(stoppedSearch.block, true);
      assert.equal(stoppedSearch.terminate, true);
      assert.match(stoppedSearch.reason ?? "", /源码证据已经足够/u);
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
        toolName: "edit",
        input: { path: "../escape.txt", oldText: "a", newText: "b" },
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
