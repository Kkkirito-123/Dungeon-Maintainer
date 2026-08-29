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
  PI_BUILTIN_TOOLS,
} from "../src/pi/tool-policy.js";
import { INITIAL_TASK_OBJECTIVE, type TaskEvent } from "../src/task/types.js";
import { TaskStore } from "../src/task/store.js";
import { hashFile } from "../src/workspace/git.js";
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

async function createExtensionHarness(suffix: string) {
  const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
  const dataDir = join(repository.temporaryRoot, "data-request-policy-" + suffix);
  const store = new TaskStore(dataDir);
  const task = await store.create({
    id: "task-request-policy-" + suffix,
    objective: "验证 Extension 工具生命周期",
    repoRoot: repository.repoRoot,
    baseHead: repository.baseHead,
    worktreeRoot: repository.repoRoot,
    piSessionDir: join(store.taskDir("task-request-policy-" + suffix), "pi"),
  });
  const evidence = new EvidenceStore(dataDir, task);
  const pi = new RecordingExtensionApi();
  installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
    config: loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "provider-secret" }),
    store,
    task,
    evidenceStore: evidence,
    gameRuntime: {
      currentDriver: () => null,
      requireDriver: () => ({}) as GameDriver,
      ensure: async () => ({}) as GameDriver,
      close: async () => undefined,
    },
  });
  let abortCalls = 0;
  const context = {
    abort: () => { abortCalls += 1; },
    ui: { notify: () => undefined },
  };
  return {
    repository,
    pi,
    store,
    task,
    evidence,
    context,
    abortCalls: () => abortCalls,
    input: requireHook(pi, "input"),
    call: requireHook(pi, "tool_call"),
    result: requireHook(pi, "tool_result"),
  };
}

async function approveReadmeWrite(pi: RecordingExtensionApi, suffix: string): Promise<void> {
  const finish = pi.toolDefinitions.get("finish");
  assert.ok(finish?.execute);
  await finish.execute(
    "approve-readme-" + suffix,
    {
      status: "proposed",
      summary: "已定位 README.md 中的测试问题。",
      risk: "只验证请求边界的写权限回收。",
      plan: {
        title: "验证请求写权限回收",
        steps: ["仅允许修改 README.md。"],
        verification: "确认新请求或 settled 后旧授权失效。",
        allowedPaths: ["README.md"],
      },
    },
    undefined,
    undefined,
    { ui: { confirm: async () => true } },
  );
}

function writeEditInput(path: string, content: string, baseHash = "deadbeef") {
  return { edits: [{ mode: "write", path, baseHash, content }] };
}

function createEditInput(path: string, content: string) {
  return { edits: [{ mode: "create", path, baseHash: "missing", content }] };
}

describe("Pi Extension 单循环工具、命令和会话阻断", () => {
  it("证据链新节点持续推进，并能进入修复流程", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data-evidence-flow");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-evidence-flow",
        objective: "修复持续无进展后的正常流程",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-evidence-flow"), "pi"),
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
      const call = requireHook(pi, "tool_call");
      const result = requireHook(pi, "tool_result");
      const context = { ui: { notify: () => undefined } };
      await requireHook(pi, "input")({ source: "rpc", text: task.objective }, context);
      const completeEvidenceRead = async (
        evidenceId: string,
        toolCallId: string,
      ): Promise<void> => {
        const input = { action: "evidence_get", evidenceId };
        assert.equal(await call({
          type: "tool_call",
          toolCallId,
          toolName: "inspect",
          input,
        }, context), undefined);
        await result({
          type: "tool_result",
          toolCallId,
          toolName: "inspect",
          input,
          content: [{ type: "text", text: "existing evidence" }],
          details: { action: "get" },
          isError: false,
        }, context);
      };
      await completeEvidenceRead("aaaaaaaaaaaaaaaa", "alternating-a-1");
      await completeEvidenceRead("bbbbbbbbbbbbbbbb", "alternating-b-1");
      await completeEvidenceRead("aaaaaaaaaaaaaaaa", "alternating-a-2");
      await completeEvidenceRead("bbbbbbbbbbbbbbbb", "alternating-b-2");

      let completedCalls = 4;
      let attempts = 0;
      while (completedCalls < 8) {
        const input = {
          action: "evidence_get",
          evidenceId: completedCalls.toString(16).padStart(16, "0"),
        };
        const toolCallId = "no-progress-" + String(attempts);
        attempts += 1;
        assert.equal(await call({
          type: "tool_call",
          toolCallId,
          toolName: "inspect",
          input,
        }, context), undefined);
        await result({
          type: "tool_result",
          toolCallId,
          toolName: "inspect",
          input,
          content: [{ type: "text", text: "existing evidence" }],
          details: { action: "get" },
          isError: false,
        }, context);
        completedCalls += 1;
      }

      const proposedInput = {
        status: "proposed",
        summary: "现有检查持续返回缓存结果，已定位 README.md 中需要修正的测试内容。",
        risk: "仅修改已定位的测试内容。",
        plan: {
          title: "修正已定位的测试内容",
          steps: ["修改 README.md 中已定位的测试内容。"],
          verification: "再次运行聚焦检查。",
          allowedPaths: ["README.md"],
        },
      };
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "finish-after-no-progress",
        toolName: "finish",
        input: proposedInput,
      }, context), undefined);
      const finish = pi.toolDefinitions.get("finish");
      assert.ok(finish?.execute);
      const finishResult = await finish.execute(
        "finish-after-no-progress",
        proposedInput,
        undefined,
        undefined,
        {
          ui: {
            confirm: async () => true,
            notify: () => undefined,
          },
        },
      ) as {
        content: Array<{ type: "text"; text: string }>;
        details: { executionApproved: boolean; status: string };
      };
      assert.equal(finishResult.details.executionApproved, true);
      const approvedText = finishResult.content.map((item) => item.text).join("\n");
      assert.match(approvedText, /调查阶段结束/u);
      assert.match(approvedText, /edit/u);
      assert.doesNotMatch(approvedText, /证据提示/u);
      await result({
        type: "tool_result",
        toolCallId: "finish-after-no-progress",
        toolName: "finish",
        input: proposedInput,
        content: finishResult.content,
        details: finishResult.details,
        isError: false,
      }, context);
      const evidenceInput = { action: "evidence_get", evidenceId: "dddddddddddddddd" };
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "evidence-after-approval",
        toolName: "inspect",
        input: evidenceInput,
      }, context), undefined);
      await result({
        type: "tool_result",
        toolCallId: "evidence-after-approval",
        toolName: "inspect",
        input: evidenceInput,
        content: [{ type: "text", text: "existing evidence" }],
        details: { action: "get" },
        isError: false,
      }, context);

      const searchInput = { action: "search", query: "baseline" };
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "search-after-approval",
        toolName: "inspect",
        input: searchInput,
      }, context), undefined);
      await result({
        type: "tool_result",
        toolCallId: "search-after-approval",
        toolName: "inspect",
        input: searchInput,
        content: [{ type: "text", text: "baseline" }],
        details: { action: "search", lines: 1, cacheKind: "none" },
        isError: false,
      }, context);

      const checkInput = { id: "guard-check-after-proposal" };
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "check-after-proposal",
        toolName: "check",
        input: checkInput,
      }, context), undefined);
      await result({
        type: "tool_result",
        toolCallId: "check-after-proposal",
        toolName: "check",
        input: checkInput,
        content: [{ type: "text", text: "check passed" }],
        details: { cached: false },
        isError: false,
      }, context);

      const patchInput = {
        edits: [{
          mode: "replace",
          path: "README.md",
          baseHash: "deadbeef",
          oldText: "baseline",
          newText: "changed",
        }],
      };
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "patch-after-approval",
        toolName: "edit",
        input: patchInput,
      }, context), undefined);
      await result({
        type: "tool_result",
        toolCallId: "patch-after-approval",
        toolName: "edit",
        input: patchInput,
        content: [{ type: "text", text: "baseHash conflict" }],
        details: undefined,
        isError: true,
      }, context);

    } finally {
      await repository.dispose();
    }
  });

  it("并行 edit 事件不会中止当前请求", async () => {
    const harness = await createExtensionHarness("parallel-native-write-attribution");
    try {
      const { abortCalls, call, context, input, pi, result, task } = harness;
      const noopPaths = Array.from({ length: 5 }, (_, index) => (
        "noop-" + String(index) + ".txt"
      ));
      for (const path of noopPaths) {
        await writeFile(join(task.worktreeRoot, path), "same\n", "utf8");
      }
      await input({ source: "rpc", text: "验证并行写入进展归因" }, context);
      const finish = pi.toolDefinitions.get("finish");
      assert.ok(finish?.execute);
      await finish.execute(
        "approve-parallel-write-attribution",
        {
          status: "proposed",
          summary: "已限定并行写入测试文件。",
          risk: "仅验证证据链进展归因。",
          plan: {
            title: "验证并行写入归因",
            steps: ["写入 README，并对五个文件执行无变化写入。"],
            verification: "只有 README 调用应被记为进展。",
            allowedPaths: ["README.md", ...noopPaths],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );

      const writes = [
        {
          toolCallId: "parallel-write-progress",
          input: writeEditInput("README.md", "changed\n"),
        },
        ...noopPaths.map((path, index) => ({
          toolCallId: "parallel-write-noop-" + String(index),
          input: writeEditInput(path, "same\n"),
        })),
      ];
      for (const write of writes) {
        assert.equal(await call({
          type: "tool_call",
          toolCallId: write.toolCallId,
          toolName: "edit",
          input: write.input,
        }, context), undefined);
      }

      // 模拟 Pi 并行批次中只有第一个 write 真正改变目标文件；其余五个调用
      // 即使观察到整个 worktree 已变化，也只能根据自己的目标文件判定为 noop。
      await writeFile(join(task.worktreeRoot, "README.md"), "changed\n", "utf8");
      for (const write of writes) {
        await result({
          type: "tool_result",
          toolCallId: write.toolCallId,
          toolName: "edit",
          input: write.input,
          content: [{ type: "text", text: "edit completed" }],
          details: undefined,
          isError: false,
        }, context);
      }

      assert.equal(abortCalls(), 0);
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "after-parallel-write-noops",
        toolName: "inspect",
        input: { action: "evidence_list" },
      }, context), undefined);
    } finally {
      await harness.repository.dispose();
    }
  });

  it("turn_end 清理缺失的 edit 写前归因", async () => {
    const harness = await createExtensionHarness("missing-native-results");
    try {
      const { abortCalls, call, context, input, pi, result, store, task } = harness;
      const missingPaths = Array.from({ length: 5 }, (_, index) => (
        "missing-result-" + String(index) + ".txt"
      ));
      await input({ source: "rpc", text: "验证缺失工具结果收敛" }, context);
      const finish = pi.toolDefinitions.get("finish");
      assert.ok(finish?.execute);
      await finish.execute(
        "approve-missing-native-results",
        {
          status: "proposed",
          summary: "已限定缺失结果测试文件。",
          risk: "仅验证 turn_end 归因。",
          plan: {
            title: "验证缺失结果归因",
            steps: ["保留一个真实写入，并模拟五个缺失结果。"],
            verification: "缺失结果必须统一记为失败和无进展。",
            allowedPaths: ["README.md", ...missingPaths],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );

      const successful = {
        toolCallId: "write-with-real-result",
        input: writeEditInput("README.md", "changed\n"),
      };
      const missing = missingPaths.map((path, index) => ({
        toolCallId: "write-without-result-" + String(index),
        input: writeEditInput(path, "content-" + String(index) + "\n"),
      }));
      for (const write of [successful, ...missing]) {
        assert.equal(await call({
          type: "tool_call",
          toolCallId: write.toolCallId,
          toolName: "edit",
          input: write.input,
        }, context), undefined);
      }
      await writeFile(join(task.worktreeRoot, "README.md"), "changed\n", "utf8");
      await result({
        type: "tool_result",
        toolCallId: successful.toolCallId,
        toolName: "edit",
        input: successful.input,
        content: [{ type: "text", text: "edit completed" }],
        details: undefined,
        isError: false,
      }, context);
      await requireHook(pi, "turn_end")({}, context);

      assert.equal(abortCalls(), 0);
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "after-missing-native-results",
        toolName: "inspect",
        input: { action: "evidence_list" },
      }, context), undefined);

      const events = (await readFile(join(store.taskDir(task.id), "events.jsonl"), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { type: string; detail: Record<string, unknown> });
      const writeOutcomes = events
        .filter((event) => event.type === "tool.write_outcome")
        .map((event) => event.detail.outcome);
      assert.equal(writeOutcomes.filter((outcome) => outcome === "mutated").length, 1);
      assert.equal(writeOutcomes.filter((outcome) => outcome === "failed").length, 0);
      assert.equal(writeOutcomes.includes("mutated_replay_failed"), false);
    } finally {
      await harness.repository.dispose();
    }
  });

  it("拒绝写入的审批日志失败仍只阻止当前调用", async () => {
    const harness = await createExtensionHarness("approval-audit-failure");
    try {
      const { abortCalls, call, input, store } = harness;
      const context = {
        abort: harness.context.abort,
        hasUI: true,
        ui: {
          notify: () => undefined,
          confirm: async () => false,
        },
      };
      await input({ source: "rpc", text: "验证审批日志故障" }, context);
      const append = store.append.bind(store);
      store.append = async (taskId: string, event: TaskEvent): Promise<void> => {
        if (event.type === "execution.approval") {
          throw new Error("injected approval audit failure");
        }
        await append(taskId, event);
      };

      const blocked = await call({
        type: "tool_call",
        toolCallId: "denied-write-with-audit-failure",
        toolName: "edit",
        input: writeEditInput("README.md", "changed\n"),
      }, context) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(blocked.block, true);
      assert.equal(blocked.terminate, false);
      assert.match(blocked.reason, /未批准/u);
      assert.equal(abortCalls(), 0);
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "after-approval-denial",
        toolName: "inspect",
        input: { action: "evidence_list" },
      }, context), undefined);
    } finally {
      await harness.repository.dispose();
    }
  });

  it("agent_settled 关闭持久化写权限", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data-settled-log-failure");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-settled-log-failure",
        objective: "验证 settled 收权顺序",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-settled-log-failure"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "provider-secret" }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => ({}) as GameDriver,
          ensure: async () => ({}) as GameDriver,
          close: async () => undefined,
        },
      });
      const context = { ui: { notify: () => undefined } };
      await requireHook(pi, "input")({ source: "rpc", text: task.objective }, context);
      await approveReadmeWrite(pi, "settled");
      assert.equal(task.writeScope.state, "approved");

      await requireHook(pi, "agent_settled")({}, context);
      assert.equal(task.writeScope.state, "closed");
    } finally {
      await repository.dispose();
    }
  });

  it("新 input 撤销上一请求的运行时写授权", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data-input-log-failure");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-input-log-failure",
        objective: "验证新请求收权顺序",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-input-log-failure"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "provider-secret" }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => ({}) as GameDriver,
          ensure: async () => ({}) as GameDriver,
          close: async () => undefined,
        },
      });
      const input = requireHook(pi, "input");
      const context = { ui: { notify: () => undefined } };
      await input({ source: "rpc", text: task.objective }, context);
      await approveReadmeWrite(pi, "new-input");
      assert.equal(task.writeScope.state, "approved");

      await input({ source: "rpc", text: "开始下一请求" }, context);
      assert.equal(task.writeScope.state, "closed");

      let confirmations = 0;
      const blocked = await requireHook(pi, "tool_call")({
        type: "tool_call",
        toolCallId: "write-after-input-log-failure",
        toolName: "edit",
        input: writeEditInput("README.md", "changed\n"),
      }, {
        abort: () => undefined,
        hasUI: true,
        ui: {
          notify: () => undefined,
          confirm: async () => {
            confirmations += 1;
            return false;
          },
        },
      }) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(confirmations, 1);
      assert.equal(blocked.block, true);
      assert.equal(blocked.terminate, false);
      assert.match(blocked.reason, /未批准/u);
    } finally {
      await repository.dispose();
    }
  });

  it("注册且只注册八个模型工具，并用执行门禁保护 edit", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/project.json": JSON.stringify({
        schemaVersion: 1,
        adapter: "sql-dungeon",
      }) + "\n",
      "README.md": "test\n",
      "whole.txt": "before\n",
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
      await store.transition(task, "active");
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
          task.changedPaths = ["README.md", "created.txt", "whole.txt"];
          task.verification = record;
          return {
            record,
            patchPath: join(store.taskDir(task.id), "patch.diff"),
            changedPaths: [...task.changedPaths],
          };
        },
      });

      assert.deepEqual([...pi.hooks.keys()], [
        "user_bash",
        "session_before_switch",
        "session_before_fork",
        "session_before_tree",
        "session_start",
        "before_agent_start",
        "input",
        "tool_call",
        "tool_result",
        "turn_end",
        "agent_end",
        "agent_settled",
        "session_shutdown",
      ]);

      assert.deepEqual(pi.tools, [
        "inspect",
        "edit",
        "check",
        "finish",
        "look",
        "act",
        "query",
        "workspace",
      ]);
      assert.deepEqual([...PI_BUILTIN_TOOLS], []);
      const workspaceTool = pi.toolDefinitions.get("workspace");
      assert.ok(workspaceTool?.execute);
      const localTreeListResult = await workspaceTool.execute(
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
      const evidenceList = await inspectTool.execute(
        "call-evidence-list",
        { action: "evidence_list", status: "active" },
        undefined,
        undefined,
        {},
      ) as { content: Array<{ text: string }> };
      const evidenceId = /id=([a-f0-9]{16})/u.exec(evidenceList.content[0]?.text ?? "")?.[1];
      assert.ok(evidenceId);
      const evidenceGet = await inspectTool.execute(
        "call-evidence-get",
        { action: "evidence_get", evidenceId },
        undefined,
        undefined,
        {},
      ) as { content: Array<{ text: string }> };
      assert.match(evidenceGet.content[0]?.text ?? "", new RegExp(evidenceId, "u"));
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
      assert.equal(provider.apiKey, "$MAINTAINER_API_KEY");
      const registeredModel = provider.models?.[0];
      assert.ok(registeredModel);
      assert.equal(registeredModel.id, "fixed-model");
      assert.equal(registeredModel.reasoning, true);
      assert.ok(!JSON.stringify(provider).includes("provider-secret"));

      assert.equal(pi.hooks.has("context"), false);

      await requireHook(pi, "input")({
        source: "rpc",
        text: "当前在哪一层，状态是什么？",
      });
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
      assert.ok(fixedToolNames.has("edit"));
      assert.ok(!fixedToolNames.has("write"));
      assert.ok(!fixedToolNames.has("patch"));
      assert.ok(!fixedToolNames.has("evidence"));
      assert.ok(!fixedToolNames.has("tree"));
      assert.ok(!fixedToolNames.has("go"));
      assert.ok(!fixedToolNames.has("use"));
      assert.ok(!fixedToolNames.has("input_sql"));
      assert.ok(!fixedToolNames.has("bash"));
      assert.match(promptResult.systemPrompt, /SQL Dungeon/u);
      assert.match(promptResult.systemPrompt, /PROJECT AGENTS SENTINEL/u);
      assert.match(promptResult.systemPrompt, /一个 Pi Agent Loop/u);
      assert.match(promptResult.systemPrompt, /finish\(status=reproduced\)/u);
      assert.match(promptResult.systemPrompt, /第一次调用 edit 时.*写入批准/u);
      assert.match(promptResult.systemPrompt, /结构化断言/u);
      assert.equal(promptResult.message, undefined);
      assert.match(promptResult.systemPrompt, /不加载任何 Pi 原生工具或 Bash/u);

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
            allowedPaths: ["README.md", "whole.txt", "created.txt"],
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
      const editInput = {
        edits: [{
          mode: "replace",
          path: "README.md",
          baseHash: await hashFile(task.worktreeRoot, "README.md"),
          oldText: "test\n",
          newText: "updated\n",
        }, {
          mode: "write",
          path: "whole.txt",
          baseHash: await hashFile(task.worktreeRoot, "whole.txt"),
          content: "after\n",
        }, {
          mode: "create",
          path: "created.txt",
          baseHash: "missing",
          content: "created\n",
        }],
      };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "edit-three-modes",
        toolName: "edit",
        input: editInput,
      }, refreshContext), undefined);
      const editTool = pi.toolDefinitions.get("edit");
      assert.ok(editTool?.execute);
      const editResult = await editTool.execute(
        "edit-three-modes",
        editInput,
        undefined,
        undefined,
        refreshContext,
      ) as {
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      };
      assert.equal(await toolResultHook({
        type: "tool_result",
        toolCallId: "edit-three-modes",
        toolName: "edit",
        input: editInput,
        content: editResult.content,
        details: editResult.details,
        isError: false,
      }, refreshContext), undefined);
      assert.deepEqual(lifecycle, ["checkpoint"]);
      assert.match(editResult.content[0]?.text ?? "", /README\.md, whole\.txt, created\.txt/u);
      assert.equal(await readFile(join(task.worktreeRoot, "README.md"), "utf8"), "updated\n");
      assert.equal(await readFile(join(task.worktreeRoot, "whole.txt"), "utf8"), "after\n");
      assert.equal(await readFile(join(task.worktreeRoot, "created.txt"), "utf8"), "created\n");
      assert.deepEqual([...task.changedPaths].sort(), ["README.md", "created.txt", "whole.txt"]);
      assert.equal(refreshNotifications.length, 0);
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
        abort: () => undefined,
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
      assert.equal(pi.hooks.has("agent_settled"), true);

      const dynamic = await requireHook(pi, "before_agent_start")(
        { prompt: repairRequest, systemPrompt: "PROJECT AGENTS SENTINEL" },
        hookContext,
      ) as { systemPrompt: string; message?: unknown };
      assert.match(dynamic.systemPrompt, /PROJECT AGENTS SENTINEL/u);
      assert.equal(dynamic.message, undefined);
      assert.equal(pi.hooks.has("context"), false);

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
        toolName: "edit",
        input: writeEditInput("README.md", "forbidden\n"),
      }, hookContext) as { block: boolean; terminate: boolean; reason: string };
      assert.equal(unapprovedWrite.block, true);
      assert.equal(unapprovedWrite.terminate, false);
      assert.match(unapprovedWrite.reason, /用户未批准本次代码修改/u);

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

  it("edit 刷新失败会阻断后续检查和 result", async () => {
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
      await requireHook(pi, "input")({ source: "rpc", text: task.objective });
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
      const hookContext = {
        ui: { notify: () => undefined },
      };
      const failingInput = createEditInput("changed.txt", "changed\n");
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "write-failing-refresh",
        toolName: "edit",
        input: failingInput,
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "changed.txt"), "changed\n", "utf8");
      const editResult = await toolResultHook({
        type: "tool_result",
        toolCallId: "write-failing-refresh",
        toolName: "edit",
        input: failingInput,
        content: [{ type: "text", text: "bridge unavailable" }],
        details: { replay: { passed: false, actionCount: 0, failure: "bridge unavailable" } },
        isError: true,
      }, hookContext);
      assert.equal(editResult, undefined);
      assert.equal(reloadCount, 0);

      // 正常路径已经在 tool_result 刷新；turn_end 只兜底处理缺失的结果事件。
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "write-without-result-event",
        toolName: "edit",
        input: createEditInput("fallback.txt", "fallback\n"),
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "fallback.txt"), "fallback\n", "utf8");
      await requireHook(pi, "turn_end")({}, hookContext);
      assert.equal(reloadCount, 0);

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

  it("agent_settled 只结束回合并回收写权限，不自动验证修改", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data-settled");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-settled-no-auto-verify",
        objective: "直接修复并自然结束",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-settled-no-auto-verify"), "pi"),
      });
      await store.transition(task, "active");
      const pi = new RecordingExtensionApi();
      let verifyCalls = 0;
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "provider-secret" }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => ({}) as GameDriver,
          ensure: async () => ({}) as GameDriver,
          close: async () => undefined,
        },
        verifyTask: async () => {
          verifyCalls += 1;
          throw new Error("不应由 agent_settled 调用");
        },
      });
      await requireHook(pi, "input")({ source: "rpc", text: task.objective });
      const finishTool = pi.toolDefinitions.get("finish");
      assert.ok(finishTool?.execute);
      await finishTool.execute(
        "approve-settled-no-verify",
        {
          status: "proposed",
          summary: "已定位最小修改。",
          risk: "仅修改一个文件。",
          plan: {
            title: "写入最小修复",
            steps: ["修改目标文件。"],
            verification: "稍后由用户显式 /verify。",
            allowedPaths: ["changed.txt"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );
      const toolCallHook = requireHook(pi, "tool_call");
      const toolResultHook = requireHook(pi, "tool_result");
      const hookContext = { ui: { notify: () => undefined } };
      const editInput = createEditInput("changed.txt", "changed\n");
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "settled-write",
        toolName: "edit",
        input: editInput,
      }, hookContext), undefined);
      const editTool = pi.toolDefinitions.get("edit");
      assert.ok(editTool?.execute);
      const editResult = await editTool.execute(
        "settled-write",
        editInput,
        undefined,
        undefined,
        hookContext,
      ) as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
      await toolResultHook({
        type: "tool_result",
        toolCallId: "settled-write",
        toolName: "edit",
        input: editInput,
        content: editResult.content,
        details: editResult.details,
        isError: false,
      }, hookContext);

      await requireHook(pi, "agent_settled")({}, hookContext);
      assert.equal(verifyCalls, 0);
      assert.equal(task.writeScope.state, "closed");
      assert.deepEqual(task.changedPaths, ["changed.txt"]);
      assert.notEqual(task.state, "ready_to_apply");
    } finally {
      await repository.dispose();
    }
  });

  it("edit 刷新失败后，后续成功 edit 清除统一刷新门禁", async () => {
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
      await requireHook(pi, "input")({ source: "rpc", text: task.objective });
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
      const writeInput = createEditInput("changed.txt", "changed\n");
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "write-before-patch-recovery",
        toolName: "edit",
        input: writeInput,
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "changed.txt"), "changed\n", "utf8");
      const failedWrite = await toolResultHook({
        type: "tool_result",
        toolCallId: "write-before-patch-recovery",
        toolName: "edit",
        input: writeInput,
        content: [{ type: "text", text: "bridge unavailable" }],
        details: { replay: { passed: false, actionCount: 0, failure: "bridge unavailable" } },
        isError: true,
      }, hookContext);
      assert.equal(failedWrite, undefined);
      const blockedBeforePatch = await toolCallHook({
        type: "tool_call",
        toolCallId: "check-before-patch-recovery",
        toolName: "check",
        input: { id: "rules-validate" },
      }, hookContext) as { block: boolean };
      assert.equal(blockedBeforePatch.block, true);

      const patchInput = {
        edits: [{
          mode: "replace",
          path: "README.md",
          baseHash: "baseline-hash",
          oldText: "baseline",
          newText: "fixed",
        }],
      };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "patch-refresh-recovery",
        toolName: "edit",
        input: patchInput,
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "README.md"), "fixed\n", "utf8");
      await toolResultHook({
        type: "tool_result",
        toolCallId: "patch-refresh-recovery",
        toolName: "edit",
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

  it("edit 自身重放失败后，统一刷新门禁阻断 check 和 result", async () => {
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
      await requireHook(pi, "input")({ source: "rpc", text: task.objective });
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
          mode: "replace",
          path: "README.md",
          baseHash: "baseline-hash",
          oldText: "baseline",
          newText: "changed",
        }],
      };
      assert.equal(await toolCallHook({
        type: "tool_call",
        toolCallId: "patch-refresh-failure",
        toolName: "edit",
        input: patchInput,
      }, hookContext), undefined);
      await writeFile(join(task.worktreeRoot, "README.md"), "changed\n", "utf8");
      await toolResultHook({
        type: "tool_result",
        toolCallId: "patch-refresh-failure",
        toolName: "edit",
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
      assert.match(blockedCheck.reason, /edit 已写入/u);
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
        && event.detail.toolName === "edit"
      ));
      assert.ok(write);
      assert.equal(write.detail.outcome, "mutated_replay_failed");
      assert.equal(write.detail.reasonCode, "refresh-replay-failed");
    } finally {
      await repository.dispose();
    }
  });

  it("拒绝 edit 越界路径和无代码变化的 result，并保留本轮修改权限", async () => {
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
      await requireHook(pi, "input")({ source: "rpc", text: task.objective });
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
        toolName: "edit",
        input: writeEditInput(join(task.repoRoot, "README.md"), "forbidden\n"),
      }, { abort: () => undefined, ui: { notify: () => undefined } }) as {
        block: boolean;
        terminate: boolean;
        reason: string;
      };
      assert.equal(formalRepositoryPath.block, true);
      assert.equal(formalRepositoryPath.terminate, false);
      assert.match(formalRepositoryPath.reason, /项目相对路径|正式仓库绝对路径/u);
      const parentTraversal = await toolCallHook({
        type: "tool_call",
        toolCallId: "parent-traversal-write",
        toolName: "edit",
        input: writeEditInput("../escape.txt", "b"),
      }, { abort: () => undefined, ui: { notify: () => undefined } }) as {
        block: boolean;
        terminate: boolean;
        reason: string;
      };
      assert.equal(parentTraversal.block, true);
      assert.equal(parentTraversal.terminate, false);
      assert.match(parentTraversal.reason, /路径不得离开项目根目录|不能包含 \.\./u);

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
        toolName: "edit",
        input: createEditInput("linked-outside/escape.txt", "forbidden\n"),
      }, { abort: () => undefined, ui: { notify: () => undefined } }) as {
        block: boolean;
        terminate: boolean;
        reason: string;
      };
      assert.equal(linkedEscape.block, true);
      assert.equal(linkedEscape.terminate, false);
      assert.match(linkedEscape.reason, /realpath|符号链接|junction/u);
      assert.equal(runtimeEnsureCount, 0);

      // 三次路径安全失败都只拒绝当前调用，请求与写授权仍有效。下一个自然输入
      // 按设计关闭旧写授权，重新批准后再独立验证“没有 worktree 变化不能提交 result”。
      await requireHook(pi, "input")({
        source: "rpc",
        text: "继续验证无代码变化的结果门禁",
      });
      await finishTool.execute(
        "reapprove-no-change",
        {
          status: "proposed",
          summary: "路径边界已验证，继续检查空变更结果。",
          risk: "不执行实际写入。",
          plan: {
            title: "验证空变更结果门禁",
            steps: ["不修改文件，直接提交结果。"],
            verification: "结果工具必须拒绝空 worktree 变化。",
            allowedPaths: ["README.md"],
          },
        },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );
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
  it("首次 edit 直接触发一次批准并继续原调用", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "baseline\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data-first-write");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-first-write",
        objective: "直接修复",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-first-write"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config: loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "provider-secret" }),
        store,
        task,
        gameRuntime: {
          currentDriver: () => null,
          requireDriver: () => ({} as GameDriver),
          ensure: async () => ({} as GameDriver),
          close: async () => undefined,
        },
      });
      await requireHook(pi, "input")({ source: "rpc", text: task.objective });
      let confirmations = 0;
      const context = {
        hasUI: true,
        ui: {
          confirm: async (title: string, message: string) => {
            confirmations += 1;
            assert.equal(title, "是否允许本次代码修改");
            assert.match(message, /README\.md/u);
            return true;
          },
          notify: () => undefined,
        },
      };
      const call = requireHook(pi, "tool_call");
      const result = requireHook(pi, "tool_result");
      const input = writeEditInput("README.md", "fixed\n");
      assert.equal(await call({
        type: "tool_call",
        toolCallId: "first-write",
        toolName: "edit",
        input,
      }, context), undefined);
      assert.equal(confirmations, 1);
      assert.equal(task.writeScope.state, "approved");
      await writeFile(join(task.worktreeRoot, "README.md"), "fixed\n", "utf8");
      await result({
        type: "tool_result",
        toolCallId: "first-write",
        toolName: "edit",
        input,
        content: [{ type: "text", text: "written" }],
        details: undefined,
        isError: false,
      }, context);
      assert.equal(await readFile(join(task.worktreeRoot, "README.md"), "utf8"), "fixed\n");
    } finally {
      await repository.dispose();
    }
  });

  it("长 SQL 输入不会挤掉最新终端状态", () => {
    const view: PlayView = {
      revision: "00000001",
      floor: 1,
      mode: "combat",
      hp: { current: 2, max: 2, armor: 0 },
      progress: { lessons: 0, rooms: 1, moves: 0, queries: 1, hintLevel: 0 },
      actions: [{ id: "query", label: "提交", tool: "query" }],
      target: null,
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
