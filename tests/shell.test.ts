import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { EvidenceStore } from "../src/evidence/store.js";
import { checkEvidence } from "../src/evidence/projector.js";
import { startShellServer } from "../src/shell/server.js";
import { TaskStore } from "../src/task/store.js";
import { INITIAL_TASK_OBJECTIVE } from "../src/task/types.js";
import { createTemporaryGitRepository, runTestGit } from "./testSupport.js";

async function readSseUntil(shellUrl: string, marker: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(shellUrl.replace("/?", "/events?"), {
      signal: controller.signal,
    });
    reader = response.body?.getReader() ?? null;
    assert.ok(reader);
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output;
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
  }
}

describe("统一 Chromium Shell HTTP/SSE 边界", () => {
  it("页面单独由 shell 文件夹提供，状态和令牌校验不泄漏敏感配置", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "shell-secret",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "fixed-model",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "shell-task",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-task"), "pi"),
      });
      const commands: Array<Record<string, unknown>> = [];
      const shell = await startShellServer({
        task,
        model: config.model,
        contextWindow: config.contextWindow,
        store,
        sendPiCommand: async (command) => {
          commands.push(command);
          return { ok: true };
        },
        onClose: async () => undefined,
      });
      try {
        shell.updateTask(task);
        shell.updateTask(task);
        shell.publish({ type: "notice", level: "info", text: "state-dedupe-marker" });
        const initialEvents = await readSseUntil(shell.url, "state-dedupe-marker");
        const initialStateEvents = initialEvents
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as { type?: string })
          .filter((event) => event.type === "state");
        assert.equal(initialStateEvents.length, 1);

        const pageResponse = await fetch(shell.url);
        const page = await pageResponse.text();
        assert.equal(pageResponse.status, 200);
        assert.match(page, /id="game-frame"/u);
        assert.match(page, /id="status-bar"/u);
        assert.match(page, /id="status-primary" class="status-row"/u);
        assert.match(page, /id="status-secondary" class="status-row"/u);
        assert.match(page, /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/u);
        assert.match(page, /overflow-x: auto; overflow-y: hidden/u);
        assert.match(page, /\[hidden\] \{ display: none !important; \}/u);
        assert.match(page, /#shell \{ width: 100%; height: 100dvh; min-height: 0; overflow: hidden;/u);
        assert.match(page, /#chat-panel \{ overflow: hidden;/u);
        assert.match(page, /#game-panel \{ position: relative; overflow: hidden;/u);
        assert.doesNotMatch(page, /addMessage\('user', text\)/u);
        assert.match(page, /assistantNode = addMessage\('assistant', data\.text\)/u);
        assert.match(page, /else if \(data\.done\) assistantNode\.textContent = data\.text/u);
        assert.match(page, /工具 ' \+ event\.name \+ ' ×'/u);
        assert.match(page, /else if \(data\.type === 'chat\.tool'\) showTool\(data\)/u);
        assert.match(page, /id="activity" role="status" aria-live="polite"/u);
        assert.match(page, /else if \(data\.type === 'activity'\) showActivity\(data\)/u);
        assert.match(page, /id="progress-panel"/u);
        assert.match(page, /id="progress-log"/u);
        assert.match(page, /data\.type === 'progress' && data\.key === 'maintainer-progress'/u);
        assert.match(page, /progressLog\.textContent = Array\.isArray\(data\.lines\)/u);
        assert.match(page, /progressLog\.scrollTop = progressLog\.scrollHeight/u);
        assert.match(page, /input\.disabled = busy && commandInFlight/u);
        assert.match(page, /id="abort-button"/u);
        assert.match(page, /\/api\/steer/u);
        assert.match(page, /\/api\/abort/u);
        assert.match(page, /消息已发送，正在等待 Pi 接收/u);
        assert.match(page, /statusItem\('本轮 Token'/u);
        assert.match(page, /statusItem\('本轮缓存'/u);
        assert.match(page, /statusItem\('会话 新\/缓\/出'/u);
        assert.match(page, /statusItem\('会话 Token'/u);
        assert.match(page, /statusItem\('工具调用'/u);
        assert.doesNotMatch(page, /send\('\/api\/pi\/model'|model-select/u);
        assert.match(page, /send\('\/api\/pi\/thinking'/u);
        assert.match(page, /send\('\/api\/pi\/compact'/u);
        assert.doesNotMatch(page, /模型档案|settings-dialog|profile-/u);
        assert.match(page, /request\.kind === 'editor'/u);
        assert.match(page, /value: currentApproval\.message/u);
        assert.match(page, /Shell 事件渲染失败/u);
        assert.doesNotMatch(page, /shell-secret/u);

        shell.handlePiEvent({
          type: "extension_ui_request",
          id: "progress-status",
          method: "setStatus",
          statusKey: "maintainer-progress",
          statusText: "检查 1/2",
        });
        shell.handlePiEvent({
          type: "extension_ui_request",
          id: "progress-widget",
          method: "setWidget",
          widgetKey: "maintainer-progress",
          widgetLines: ["game-test passed", "game-build running"],
          widgetPlacement: "aboveEditor",
        });
        shell.handlePiEvent({
          type: "extension_ui_request",
          id: "progress-clear",
          method: "setStatus",
          statusKey: "maintainer-progress",
        });
        shell.handlePiEvent({
          type: "extension_ui_request",
          id: "unknown-progress",
          method: "setWidget",
          widgetKey: "other-progress",
          widgetLines: ["must-not-render"],
        });
        shell.publish({ type: "notice", level: "info", text: "progress-cache-marker" });
        const progressEvents = (await readSseUntil(shell.url, "progress-cache-marker"))
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as {
            type?: string;
            key?: string;
            text?: string | null;
            lines?: string[];
          })
          .filter((event) => event.type === "progress");
        assert.deepEqual(progressEvents, [{
          type: "progress",
          key: "maintainer-progress",
          text: null,
          lines: ["game-test passed", "game-build running"],
        }]);

        shell.handlePiEvent({
          type: "message_end",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "不应进入 Shell 的工具正文" }],
          },
        });
        shell.handlePiEvent({ type: "agent_start" });
        shell.handlePiEvent({
          type: "tool_execution_start",
          toolName: "look",
        });
        shell.handlePiEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "402: Insufficient Balance",
          },
        });
        shell.handlePiEvent({ type: "agent_end", willRetry: true });
        shell.handlePiEvent({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
        });
        shell.handlePiEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "最终" },
        });
        shell.handlePiEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "最终回答" }],
          },
        });
        shell.handlePiEvent({ type: "auto_retry_end", success: true, attempt: 1 });
        shell.handlePiEvent({ type: "compaction_start", reason: "threshold" });
        shell.handlePiEvent({
          type: "compaction_end",
          reason: "threshold",
          result: { estimatedTokensAfter: 12_345 },
          aborted: false,
          willRetry: false,
        });
        const eventController = new AbortController();
        const eventTimeout = setTimeout(() => eventController.abort(), 2_000);
        let eventReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
          const eventResponse = await fetch(shell.url.replace("/?", "/events?"), {
            signal: eventController.signal,
          });
          eventReader = eventResponse.body?.getReader() ?? null;
          assert.ok(eventReader);
          const decoder = new TextDecoder();
          let eventText = "";
          while (!eventText.includes('"done":true')) {
            const chunk = await eventReader.read();
            if (chunk.done) break;
            eventText += decoder.decode(chunk.value, { stream: true });
          }
          assert.doesNotMatch(eventText, /不应进入 Shell 的工具正文/u);
          assert.match(eventText, /模型请求失败，正在自动重试 1\/3/u);
          assert.doesNotMatch(eventText, /模型服务余额不足（HTTP 402），本次消息没有执行/u);
          assert.match(eventText, /正在读取右侧游戏当前状态/u);
          assert.match(eventText, /"phase":"idle"/u);
          const chatEvents = eventText
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)) as { type?: string; text?: string; done?: boolean })
            .filter((event) => event.type === "chat.text");
          assert.deepEqual(chatEvents, [
            { type: "chat.text", text: "最终", done: false },
            { type: "chat.text", text: "最终回答", done: true },
          ]);
          assert.match(eventText, /上下文压缩已完成，可以继续操作/u);
          assert.match(eventText, /"contextUsed":12345/u);
        } finally {
          clearTimeout(eventTimeout);
          await eventReader?.cancel().catch(() => undefined);
        }

        shell.updateTurnUsage({
          input: 9,
          output: 4_096,
          cacheRead: 39_936,
          cacheWrite: 0,
          totalTokens: 44_041,
        });
        shell.updateSessionStats({
          tokens: {
            input: 10_000,
            output: 1_234,
            cacheRead: 112_000,
            cacheWrite: 222,
            total: 123_456,
          },
          contextUsage: { tokens: 40_012 },
        });
        const stateResponse = await fetch(shell.url.replace("/?", "/api/state?"));
        assert.equal(stateResponse.status, 200);
        const state = await stateResponse.json() as {
          status: {
            taskState: string;
            turnInputTokens: number;
            turnOutputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            turnTotalTokens: number;
            sessionInputTokens: number;
            sessionOutputTokens: number;
            sessionCacheReadTokens: number;
            sessionCacheWriteTokens: number;
            totalTokens: number;
            contextUsed: number;
            toolCalls: number;
          };
        };
        assert.equal(state.status.taskState, "created");
        assert.equal(state.status.turnInputTokens, 9);
        assert.equal(state.status.turnOutputTokens, 4_096);
        assert.equal(state.status.cacheReadTokens, 39_936);
        assert.equal(state.status.cacheWriteTokens, 0);
        assert.equal(state.status.turnTotalTokens, 44_041);
        assert.equal(state.status.sessionInputTokens, 10_000);
        assert.equal(state.status.sessionOutputTokens, 1_234);
        assert.equal(state.status.sessionCacheReadTokens, 112_000);
        assert.equal(state.status.sessionCacheWriteTokens, 222);
        assert.equal(state.status.totalTokens, 123_456);
        assert.equal(state.status.contextUsed, 40_012);
        assert.equal(state.status.toolCalls, 1);

        const badState = await fetch(
          shell.url.replace("/?", "/api/state?").replace("token=", "token=bad-"),
        );
        assert.equal(badState.status, 403);

        const inputResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "定位问题" }),
        });
        assert.equal(inputResponse.status, 200);
        const promptCommand = commands.find((command) => command.type === "prompt");
        assert.ok(promptCommand);
        assert.equal(promptCommand.message, "定位问题");
        const resetStateResponse = await fetch(shell.url.replace("/?", "/api/state?"));
        const resetState = await resetStateResponse.json() as {
          status: {
            toolCalls: number;
          };
        };
        assert.equal(resetState.status.toolCalls, 0);

        const busyInputResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "重复消息" }),
        });
        assert.equal(busyInputResponse.status, 409);
        assert.match(await busyInputResponse.text(), /正在处理上一条消息/u);

        const commandResponse = await fetch(shell.url.replace("/?", "/api/command?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "/bad" }),
        });
        assert.equal(commandResponse.status, 400);

        shell.handlePiEvent({ type: "agent_end", willRetry: false });
        const beforeSettledResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "agent_end 后仍不能并发" }),
        });
        assert.equal(beforeSettledResponse.status, 409);
        shell.handlePiEvent({ type: "agent_settled" });

        const playResponse = await fetch(shell.url.replace("/?", "/api/command?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "/play" }),
        });
        assert.equal(playResponse.status, 200);
        const inputDuringCommand = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "命令未 settled，不能抢跑" }),
        });
        assert.equal(inputDuringCommand.status, 409);
        shell.handlePiEvent({ type: "agent_settled" });
        const afterCommandState = await (
          await fetch(shell.url.replace("/?", "/api/state?"))
        ).json() as {
          status: {
            toolCalls: number;
          };
        };
        assert.equal(afterCommandState.status.toolCalls, 0);
        const steeringResponse = await fetch(shell.url.replace("/?", "/api/steer?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "命令执行中请停止低价值搜索" }),
        });
        assert.equal(steeringResponse.status, 409);
        const naturalInputResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "开始一轮可被追加的调查" }),
        });
        assert.equal(naturalInputResponse.status, 200);
        const steeringDuringInputResponse = await fetch(shell.url.replace("/?", "/api/steer?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "请停止低价值搜索" }),
        });
        assert.equal(steeringDuringInputResponse.status, 200);
        assert.ok(commands.some((command) => (
          command.type === "prompt"
          && command.streamingBehavior === "steer"
          && command.message === "请停止低价值搜索"
        )));
        const busyAfterSteerResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "当前回合仍未收尾" }),
        });
        assert.equal(busyAfterSteerResponse.status, 409);
        const abortResponse = await fetch(shell.url.replace("/?", "/api/abort?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(abortResponse.status, 200);
        assert.ok(commands.some((command) => command.type === "abort"));
        shell.handlePiEvent({ type: "agent_settled" });
        const afterAbortResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "停止后可以追加" }),
        });
        assert.equal(afterAbortResponse.status, 200);
        shell.handlePiEvent({ type: "agent_settled" });

        const runtimeUrl = new URL("/api/runtime", shell.url);
        runtimeUrl.search = new URL(shell.url).search;
        const runtimeResponse = await fetch(runtimeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dungeon-token": shell.token,
          },
          body: JSON.stringify({
            state: "ready",
            gameUrl: "http://127.0.0.1:4173/?playtest=agent",
          }),
        });
        assert.equal(runtimeResponse.status, 200);
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });

  it("命令在 settled 前保持锁定，in-flight error 在 settled 后结束", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      const task = await store.create({
        id: "shell-command-settled",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-command-settled"), "pi"),
      });
      const shell = await startShellServer({
        task,
        model: "model-a",
        contextWindow: 64_000,
        store,
        sendPiCommand: async () => ({ ok: true }),
        onClose: async () => undefined,
      });
      try {
        const commandResponse = await fetch(shell.url.replace("/?", "/api/command?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "/verify" }),
        });
        assert.equal(commandResponse.status, 200);
        assert.deepEqual(await commandResponse.json(), { ok: true, accepted: true });

        const busyBeforeSettled = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "不能抢跑" }),
        });
        assert.equal(busyBeforeSettled.status, 409);
        shell.handlePiEvent({
          type: "extension_ui_request",
          id: "verify-error",
          method: "notify",
          notifyType: "error",
          message: "直接测试失败",
        });
        const stillBusy = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "错误通知后仍不能抢跑" }),
        });
        assert.equal(stillBusy.status, 409);
        shell.handlePiEvent({ type: "agent_settled" });
        const settledEvents = await readSseUntil(shell.url, "直接测试失败");
        assert.match(settledEvents, /"state":"error"/u);

        const secondCommand = await fetch(shell.url.replace("/?", "/api/command?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "/verify" }),
        });
        assert.equal(secondCommand.status, 200);
        shell.handlePiEvent({
          type: "extension_error",
          error: "检查 game-test 失败：退出码 1",
        });
        shell.handlePiEvent({ type: "agent_settled" });
        const detailedEvents = await readSseUntil(shell.url, "检查 game-test 失败");
        assert.match(detailedEvents, /检查 game-test 失败：退出码 1/u);
        assert.match(detailedEvents, /"state":"error"/u);

        const unlocked = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "settled 后继续" }),
        });
        assert.equal(unlocked.status, 200);
        shell.handlePiEvent({ type: "agent_settled" });
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });

  it("固定模型、Thinking、压缩和上下文统计使用真实 Pi RPC", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "shell-secret",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "model-a",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "shell-pi-controls",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-pi-controls"), "pi"),
      });
      const commands: Array<Record<string, unknown>> = [];
      let thinkingLevel = "off";
      let compacted = false;
      const shell = await startShellServer({
        task,
        model: config.model,
        contextWindow: config.contextWindow,
        store,
        sendPiCommand: async (command) => {
          commands.push(command);
          if (command.type === "set_thinking_level") {
            thinkingLevel = String(command.level);
            return undefined;
          }
          if (command.type === "compact") {
            compacted = true;
            return { estimatedTokensAfter: 4_000 };
          }
          if (command.type === "get_state") {
            return {
              model: {
                provider: "dungeon-maintainer",
                id: "model-a",
                name: "model-a",
                reasoning: true,
              },
              thinkingLevel,
              autoCompactionEnabled: true,
              pendingMessageCount: 0,
            };
          }
          if (command.type === "get_available_thinking_levels") {
            return { levels: ["off", "high"] };
          }
          if (command.type === "get_session_stats") {
            return {
              tokens: {
                input: 100,
                output: 20,
                cacheRead: 80,
                cacheWrite: 5,
                total: 205,
              },
              contextUsage: {
                tokens: compacted ? null : 32_000,
                contextWindow: 64_000,
                percent: compacted ? null : 50,
              },
            };
          }
          return undefined;
        },
        onClose: async () => undefined,
      });
      try {
        await shell.syncPiState();
        const initial = await fetch(shell.url.replace("/?", "/api/state?"));
        const initialBody = await initial.json() as {
          status: {
            model: string;
            thinkingLevel: string;
            contextUsed: number | null;
            contextPercent: number | null;
          };
        };
        assert.equal(initialBody.status.model, "model-a");
        assert.equal(initialBody.status.thinkingLevel, "off");
        assert.equal(initialBody.status.contextUsed, 32_000);
        assert.equal(initialBody.status.contextPercent, 50);

        const thinkingResponse = await fetch(shell.url.replace("/?", "/api/pi/thinking?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ level: "high" }),
        });
        assert.equal(thinkingResponse.status, 200);
        assert.equal(
          (await thinkingResponse.json() as { status: { thinkingLevel: string } }).status.thinkingLevel,
          "high",
        );

        const compactResponse = await fetch(shell.url.replace("/?", "/api/pi/compact?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(compactResponse.status, 200);
        const compactBody = await compactResponse.json() as {
          status: { contextUsed: number | null; contextPercent: number | null };
        };
        assert.equal(compactBody.status.contextUsed, null);
        assert.equal(compactBody.status.contextPercent, null);
        assert.ok(!commands.some((command) => command.type === "set_model"));
        assert.ok(commands.some((command) => command.type === "set_thinking_level"));
        assert.ok(commands.some((command) => command.type === "compact"));
        const persisted = await store.read(task.id);
        assert.equal(persisted.modelProfileId, "default");
        assert.equal(persisted.thinkingLevel, "high");
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });

  it("自然语言输入超出安全线时先同步压缩，压缩后仍超限则不发送 prompt", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "token control\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "shell-token-control",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-token-control"), "pi"),
      });
      const commands: Array<Record<string, unknown>> = [];
      let contextTokens = 50_000;
      let compactedTokens = 12_000;
      const sessionStats = () => ({
        contextUsage: {
          tokens: contextTokens,
          contextWindow: 64_000,
          percent: contextTokens / 640,
        },
      });
      const shell = await startShellServer({
        task,
        model: "model-a",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        store,
        sendPiCommand: async (command) => {
          commands.push(command);
          if (command.type === "get_session_stats") return sessionStats();
          if (command.type === "compact") {
            contextTokens = compactedTokens;
            return { estimatedTokensAfter: compactedTokens };
          }
          return undefined;
        },
        onClose: async () => undefined,
      });
      try {
        shell.updateSessionStats(sessionStats());
        const accepted = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "继续定位" }),
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(
          commands.map((command) => command.type),
          ["get_session_stats", "compact", "get_session_stats", "prompt"],
        );

        shell.handlePiEvent({ type: "agent_settled" });
        contextTokens = 50_000;
        compactedTokens = 50_000;
        shell.updateSessionStats(sessionStats());
        const blocked = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "继续定位" }),
        });
        assert.equal(blocked.status, 409);
        assert.match(
          (await blocked.json() as { error: string }).error,
          /压缩后仍预计使用/u,
        );
        assert.equal(commands.filter((command) => command.type === "prompt").length, 1);
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });

  it("工作树目录、沙箱标记和任务切换使用真实本地事实", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/project.json": JSON.stringify({
        schemaVersion: 1,
        adapter: "sql-dungeon",
      }) + "\n",
      ".env": "TEST_ONLY_PLACEHOLDER=true\n",
      "game/src/fix.ts": "export const fixed = false;\n",
      "game/src/other.ts": "export const other = true;\n",
    });
    try {
      const alternateRoot = join(repository.temporaryRoot, "alternate");
      await runTestGit(repository.repoRoot, [
        "worktree",
        "add",
        "-b",
        "shell-alternate",
        alternateRoot,
        repository.baseHead,
      ]);
      await writeFile(
        join(alternateRoot, "game", "src", "other.ts"),
        "export const other = false;\n",
        "utf8",
      );
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const currentBranch = await runTestGit(repository.repoRoot, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      const task = await store.create({
        id: "shell-catalog-current",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        sourceBranch: currentBranch,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-catalog-current"), "pi"),
      });
      await store.approveWriteScope(task, ["game/src/fix.ts"], "catalog-scope");
      task.changedPaths = ["game/src/fix.ts"];
      const evidence = new EvidenceStore(dataDir, task);
      await evidence.capture(checkEvidence({
        id: "game-test",
        worktreeHash: "catalog-test",
        status: "failed",
        durationMs: 1,
        logPath: join(store.taskDir(task.id), "checks", "game-test.log"),
        savedAt: new Date().toISOString(),
      }));
      await store.save(task);
      const recoverable = await store.create({
        id: "shell-catalog-recoverable",
        objective: "恢复另一个任务",
        repoRoot: alternateRoot,
        baseHead: repository.baseHead,
        sourceBranch: "shell-alternate",
        worktreeRoot: alternateRoot,
        piSessionDir: join(store.taskDir("shell-catalog-recoverable"), "pi"),
      });
      let switchRequest: unknown = null;
      const shell = await startShellServer({
        task,
        model: "model-a",
        contextWindow: 64_000,
        store,
        sendPiCommand: async (command) => {
          if (command.type === "get_state") {
            return {
              model: { provider: "dungeon-maintainer", id: "model-a", name: "model-a" },
              thinkingLevel: "off",
            };
          }
          return undefined;
        },
        onSwitchTask: async (request) => {
          switchRequest = request;
          return recoverable;
        },
        onClose: async () => undefined,
      });
      try {
        const catalogResponse = await fetch(shell.url.replace("/?", "/api/worktrees?"));
        const catalogText = await catalogResponse.text();
        assert.equal(catalogResponse.status, 200, catalogText);
        const catalog = JSON.parse(catalogText) as {
          activeTaskId: string;
          worktrees: Array<{ id: string; branch: string; dirtyFiles: number; current: boolean }>;
          tasks: Array<{ id: string; name: string; createdAt: string; current: boolean }>;
        };
        assert.equal(catalog.activeTaskId, task.id);
        assert.equal(catalog.worktrees.length, 2);
        assert.ok(catalog.worktrees.some((entry) => entry.current && entry.branch === currentBranch));
        const alternate = catalog.worktrees.find((entry) => entry.branch === "shell-alternate");
        assert.ok(alternate);
        assert.equal(alternate.dirtyFiles, 1);
        const recoverableEntry = catalog.tasks.find((entry) => entry.id === recoverable.id && !entry.current);
        assert.ok(recoverableEntry);
        assert.equal(recoverableEntry.name, recoverable.displayName);
        assert.equal(recoverableEntry.createdAt, recoverable.createdAt);

        const renameResponse = await fetch(shell.url.replace("/?", "/api/tasks/rename?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "默认答案修复 · 战斗" }),
        });
        assert.equal(renameResponse.status, 200);
        const renamedState = await renameResponse.json() as {
          status: { taskName: string; taskCreatedAt: string };
        };
        assert.equal(renamedState.status.taskName, "默认答案修复 · 战斗");
        assert.equal(renamedState.status.taskCreatedAt, task.createdAt);
        assert.equal((await store.read(task.id)).displayName, "默认答案修复 · 战斗");

        const treeResponse = await fetch(shell.url.replace("/?", "/api/workspace/tree?"));
        assert.equal(treeResponse.status, 200);
        const tree = await treeResponse.json() as {
          taskId: string;
          files: Array<{
            path: string;
            approved: boolean;
            modified: boolean;
            denied: boolean;
            validation: string;
          }>;
        };
        assert.equal(tree.taskId, task.id);
        const approvedFile = tree.files.find((entry) => entry.path === "game/src/fix.ts");
        assert.deepEqual(approvedFile, {
          path: "game/src/fix.ts",
          approved: true,
          modified: true,
          denied: false,
          validation: "failed",
        });
        assert.equal(tree.files.find((entry) => entry.path === ".env")?.denied, true);

        const switchResponse = await fetch(shell.url.replace("/?", "/api/tasks/switch?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "task", id: recoverable.id }),
        });
        assert.equal(switchResponse.status, 200);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(switchRequest, { kind: "task", id: recoverable.id });
        const switchedState = await fetch(shell.url.replace("/?", "/api/state?"));
        const switchedBody = await switchedState.json() as {
          status: { activeTaskId: string };
        };
        assert.equal(switchedBody.status.activeTaskId, recoverable.id);
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });

  it("thinking 不泄漏，length 空答复等 settled 才报错并解锁", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "shell-secret",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "fixed-model",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "shell-length-task",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-length-task"), "pi"),
      });
      const shell = await startShellServer({
        task,
        model: config.model,
        contextWindow: config.contextWindow,
        store,
        sendPiCommand: async () => ({ ok: true }),
        onClose: async () => undefined,
      });
      try {
        const firstResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "为什么没有进入第二层" }),
        });
        assert.equal(firstResponse.status, 200);

        shell.handlePiEvent({ type: "agent_start" });
        shell.updateTurnUsage({
          input: 9,
          output: 4_096,
          cacheRead: 39_936,
          cacheWrite: 0,
          totalTokens: 44_041,
        });
        shell.handlePiEvent({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "绝不能进入 Shell 的内部分析",
          },
        });
        shell.handlePiEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "绝不能进入 Shell 的内部分析" }],
            stopReason: "length",
          },
        });
        shell.handlePiEvent({ type: "agent_end", willRetry: false });

        const beforeSettledEvents = await readSseUntil(shell.url, "模型未生成可见答复");
        assert.match(beforeSettledEvents, /模型正在分析问题/u);
        assert.doesNotMatch(beforeSettledEvents, /绝不能进入 Shell 的内部分析/u);
        assert.doesNotMatch(beforeSettledEvents, /"type":"chat\.text"/u);

        const busyResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "不能抢跑" }),
        });
        assert.equal(busyResponse.status, 409);

        shell.handlePiEvent({ type: "agent_settled" });
        const settledEvents = await readSseUntil(shell.url, "模型输出上限被内部分析耗尽");
        assert.match(settledEvents, /"state":"error"/u);
        assert.match(settledEvents, /未生成可见答复/u);

        const unlockedResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "settled 后可以继续" }),
        });
        assert.equal(unlockedResponse.status, 200);
        shell.handlePiEvent({ type: "agent_settled" });
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });

  it("editor 只读查看器回传 value，命令返回后解锁", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "shell-secret",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "fixed-model",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "shell-editor-task",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-editor-task"), "pi"),
      });
      const commands: Array<Record<string, unknown>> = [];
      const editorText = "diff --git a/game.ts b/game.ts\n+fixed";
      let resolveDiffCommand: ((value: unknown) => void) | null = null;
      let emitPiEvent: (event: unknown) => void = () => undefined;
      const shell = await startShellServer({
        task,
        model: config.model,
        contextWindow: config.contextWindow,
        store,
        sendPiCommand: async (command) => {
          const record = command as Record<string, unknown>;
          commands.push(record);
          if (record.type === "prompt" && record.message === "/diff") {
            return await new Promise((resolve) => {
              resolveDiffCommand = resolve;
              queueMicrotask(() => emitPiEvent({
                type: "extension_ui_request",
                id: "editor-request",
                method: "editor",
                title: "当前差异",
                prefill: editorText,
              }));
            });
          }
          if (record.type === "extension_ui_response") {
            resolveDiffCommand?.({ ok: true });
            resolveDiffCommand = null;
          }
          return { ok: true };
        },
        onClose: async () => undefined,
      });
      emitPiEvent = (event) => shell.handlePiEvent(event);
      try {
        const commandResponsePromise = fetch(shell.url.replace("/?", "/api/command?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "/diff" }),
        });
        const editorEvents = await readSseUntil(shell.url, '"kind":"editor"');
        assert.match(editorEvents, /当前差异/u);
        assert.match(editorEvents, /diff --git/u);

        const editorResponse = await fetch(shell.url.replace("/?", "/api/ui-response?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "editor-request", value: editorText }),
        });
        assert.equal(editorResponse.status, 200);
        const commandResponse = await commandResponsePromise;
        assert.equal(commandResponse.status, 200);

        const uiResponse = commands.find((command) => command.type === "extension_ui_response");
        assert.deepEqual(uiResponse, {
          type: "extension_ui_response",
          id: "editor-request",
          value: editorText,
        });

        shell.handlePiEvent({ type: "agent_settled" });
        const unlockedResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "命令完成后可以继续" }),
        });
        assert.equal(unlockedResponse.status, 200);
        shell.handlePiEvent({ type: "agent_settled" });
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });
});
