/** Shell HTTP 路由。每个处理函数对应一个页面动作，不在这里归约 Pi 事件。 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { TaskRecord } from "../task/types.js";
import {
  listRecoverableTasks,
  listRepositoryWorktrees,
  readWorkspaceTree,
} from "../workspace/catalog.js";
import {
  jsonBody,
  sanitizeText,
  stringValue,
  writeJson,
  writeText,
  type JsonRecord,
} from "./codec.js";
import { renderShellPage } from "./page.js";
import type { ShellEvent, ShellStatus, ShellUiResponse } from "./protocol.js";
import type { ShellServerOptions } from "./server.js";

export type ShellRequestState = "idle" | "input" | "command" | "aborting";

/** 路由可以使用的会话动作；所有状态变化仍由 session 统一发布。 */
export interface ShellRouteSession {
  readonly task: TaskRecord;
  status: ShellStatus;
  readonly gameUrl: string | null;
  readonly requestState: ShellRequestState;
  pendingTerminalError: string | null;
  authorize(url: URL, request: IncomingMessage): boolean;
  connectEvents(request: IncomingMessage, response: ServerResponse): void;
  setRequestState(state: ShellRequestState): void;
  setPhase(phase: ShellStatus["phase"]): void;
  beginRequest(kind: "input" | "command"): void;
  finishRequest(state: "done" | "error", text: string, notice?: boolean): void;
  publish(event: ShellEvent): void;
  publishState(): void;
  publishActivity(
    state: "waiting" | "working" | "approval" | "done" | "error",
    text: string,
    startNew?: boolean,
  ): void;
  settleCommand(): void;
  updateTask(task: TaskRecord): void;
  syncPiState(): Promise<void>;
  updateRuntime(update: {
    state: "starting" | "ready" | "error" | "stopped";
    gameUrl?: string | null;
  }): void;
}

interface RouteContext {
  options: ShellServerOptions;
  shell: ShellRouteSession;
  body: JsonRecord;
  response: ServerResponse;
}

type PostHandler = (context: RouteContext) => Promise<void> | void;

const COMMANDS = new Set(["/play", "/diff", "/verify", "/apply", "/discard"]);

function invalidText(
  response: ServerResponse,
  text: string | null,
  message: string,
): text is null {
  if (text && text.length <= 4_000) return false;
  writeJson(response, { error: message }, 400);
  return true;
}

const input: PostHandler = async ({ options, shell, body, response }) => {
  const text = stringValue(body.text)?.trim() ?? null;
  if (invalidText(response, text, "输入为空或过长")) return;
  if (shell.requestState !== "idle") {
    writeJson(response, { error: "Pi 正在处理上一条消息，请等待当前动作完成" }, 409);
    return;
  }
  shell.beginRequest("input");
  shell.publish({ type: "chat.user", text: sanitizeText(text) });
  shell.publishActivity("waiting", "消息已收到，正在等待 Pi 开始诊断…", true);
  try {
    await options.sendPiCommand({ id: randomUUID(), type: "prompt", message: text });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pi RPC 请求失败";
    shell.finishRequest("error", "消息发送失败：" + sanitizeText(message));
    throw error;
  }
  writeJson(response, { ok: true });
};

const steer: PostHandler = async ({ options, shell, body, response }) => {
  const text = stringValue(body.text)?.trim() ?? null;
  if (invalidText(response, text, "追加要求为空或过长")) return;
  if (text.startsWith("/")) {
    writeJson(response, { error: "运行中只能追加文字要求；固定命令请先停止本轮后再发送" }, 400);
    return;
  }
  if (shell.requestState !== "input") {
    const error = shell.requestState === "aborting"
      ? "正在停止当前回合，请稍候"
      : "固定命令执行中不能追加要求，请等待命令完成或停止本轮";
    writeJson(response, { error }, 409);
    return;
  }
  await options.sendPiCommand({
    id: randomUUID(),
    type: "prompt",
    message: text,
    streamingBehavior: "steer",
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "追加要求发送失败";
    throw new Error("追加要求发送失败：" + sanitizeText(message), { cause: error });
  });
  shell.publish({ type: "chat.user", text: sanitizeText(text) });
  shell.publishActivity("working", "追加要求已发送，等待当前动作切换…");
  writeJson(response, { ok: true, accepted: true });
};

const abort: PostHandler = async ({ options, shell, response }) => {
  if (shell.requestState === "idle") {
    writeJson(response, { error: "当前没有正在运行的本轮" }, 409);
    return;
  }
  if (shell.requestState === "aborting") {
    writeJson(response, { ok: true, accepted: true, duplicate: true });
    return;
  }
  const previous = shell.requestState;
  shell.setRequestState("aborting");
  shell.publishActivity("working", "正在停止当前回合…", true);
  try {
    await options.sendPiCommand({ type: "abort" });
  } catch (error) {
    shell.setRequestState(previous);
    shell.publishActivity("working", "停止请求失败，当前回合仍在运行…", true);
    const message = error instanceof Error ? error.message : "停止请求发送失败";
    throw new Error("停止当前回合失败：" + sanitizeText(message), { cause: error });
  }
  writeJson(response, { ok: true, accepted: true });
};

const command: PostHandler = ({ options, shell, body, response }) => {
  const text = stringValue(body.text)?.trim() ?? "";
  const name = text.split(/\s+/u)[0] ?? "";
  if (!COMMANDS.has(name)) {
    writeJson(response, { error: "不支持的 Shell 命令" }, 400);
    return;
  }
  if (shell.requestState !== "idle") {
    writeJson(response, { error: "Pi 正在处理上一条消息，请等待当前动作完成" }, 409);
    return;
  }
  shell.beginRequest("command");
  shell.setPhase(name === "/play" ? "reproduce" : name === "/verify" ? "verify" : "diagnose");
  shell.publish({ type: "chat.user", text });
  shell.publishActivity("waiting", "正在执行 " + name + "…", true);
  void options.sendPiCommand({ id: randomUUID(), type: "prompt", message: name })
    .catch((error: unknown) => {
      if (shell.requestState !== "command") return;
      const message = shell.pendingTerminalError ?? "命令发送失败：" + sanitizeText(
        error instanceof Error ? error.message : "Pi RPC 请求失败",
      );
      shell.finishRequest("error", message);
    });
  writeJson(response, { ok: true, accepted: true });
};

const uiResponse: PostHandler = async ({ options, shell, body, response }) => {
  const id = stringValue(body.id);
  if (!id) {
    writeJson(response, { error: "缺少 UI 请求 ID" }, 400);
    return;
  }
  const choice: ShellUiResponse = typeof body.confirmed === "boolean"
    ? { id, confirmed: body.confirmed }
    : typeof body.value === "string" ? { id, value: body.value } : { id, cancelled: true };
  shell.publishActivity("working", "已收到你的选择，Pi 正在继续处理…");
  await options.sendPiCommand({ type: "extension_ui_response", ...choice })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Pi RPC UI 响应失败";
      shell.finishRequest("error", "选择提交失败：" + sanitizeText(message));
      throw error;
    });
  writeJson(response, { ok: true });
};

const thinking: PostHandler = async ({ options, shell, body, response }) => {
  if (shell.requestState !== "idle" || ["compacting", "verify"].includes(shell.status.phase)) {
    writeJson(response, { error: "Pi 正忙，当前不能切换 Thinking" }, 409);
    return;
  }
  const level = stringValue(body.level);
  if (!level || !shell.status.availableThinkingLevels.includes(level)) {
    writeJson(response, { error: "Thinking 等级不受当前模型支持" }, 400);
    return;
  }
  await options.sendPiCommand({
    type: "set_thinking_level",
    level: level as TaskRecord["thinkingLevel"],
  });
  await shell.syncPiState();
  writeJson(response, { ok: true, status: shell.status });
};

const compact: PostHandler = async ({ options, shell, response }) => {
  if (shell.requestState !== "idle" || ["compacting", "verify"].includes(shell.status.phase)) {
    writeJson(response, { error: "Pi 正忙，当前不能手动压缩" }, 409);
    return;
  }
  shell.setPhase("compacting");
  shell.publishActivity("working", "正在手动压缩旧上下文…", true);
  try {
    await options.sendPiCommand({
      type: "compact",
      customInstructions: "保留当前任务目标、最新游戏证据、源码定位、已批准修改范围、Diff 和验证状态；删除重复旧工具正文。",
    });
    await shell.syncPiState();
    shell.publishActivity("done", "上下文压缩完成");
    writeJson(response, { ok: true, status: shell.status });
  } catch (error) {
    shell.setPhase("idle");
    shell.publishActivity("error", "上下文压缩失败");
    throw error;
  }
};

const switchTask: PostHandler = ({ options, shell, body, response }) => {
  if (!options.onSwitchTask) {
    writeJson(response, { error: "当前启动方式不支持任务切换" }, 501);
    return;
  }
  const kind = body.kind;
  const id = stringValue(body.id);
  const agentConfirmed = body.agentConfirmed === true;
  if ((kind !== "worktree" && kind !== "task") || !id) {
    writeJson(response, { error: "任务切换参数无效" }, 400);
    return;
  }
  if (shell.requestState !== "idle" && !agentConfirmed) {
    writeJson(response, { error: "Pi 正忙，当前不能切换工作树" }, 409);
    return;
  }
  shell.publishActivity("waiting", "正在保存当前任务并切换工作树…", true);
  writeJson(response, { ok: true, accepted: true });
  setTimeout(() => {
    void options.onSwitchTask?.({ kind, id })
      .then((task) => {
        shell.updateTask(task);
        shell.publishActivity("done", "已切换到任务 " + task.id.slice(0, 8));
      })
      .catch((error: unknown) => {
        const message = sanitizeText(error instanceof Error ? error.message : "任务切换失败");
        shell.publishActivity("error", message);
        shell.publish({ type: "notice", level: "error", text: message });
      });
  }, agentConfirmed ? 800 : 0).unref();
};

const renameTask: PostHandler = async ({ options, shell, body, response }) => {
  if (shell.requestState !== "idle" || shell.status.phase !== "idle") {
    writeJson(response, { error: "Pi 正忙，当前不能重命名任务" }, 409);
    return;
  }
  const name = stringValue(body.name)?.trim();
  if (!name || name.length > 80) {
    writeJson(response, { error: "任务名称不能为空且不能超过 80 个字符" }, 400);
    return;
  }
  await options.store.rename(shell.task, name);
  shell.updateTask(shell.task);
  shell.publish({
    type: "notice",
    level: "info",
    text: "任务名称已更新为：" + sanitizeText(shell.task.displayName),
  });
  writeJson(response, { ok: true, status: shell.status });
};

const runtime: PostHandler = ({ shell, body, response }) => {
  const state = body.state;
  if (!["starting", "ready", "error", "stopped"].includes(String(state))) {
    writeJson(response, { error: "运行时状态无效" }, 400);
    return;
  }
  shell.updateRuntime({
    state: state as "starting" | "ready" | "error" | "stopped",
    gameUrl: typeof body.gameUrl === "string" ? body.gameUrl : null,
  });
  writeJson(response, { ok: true });
};

const close: PostHandler = async ({ options, response }) => {
  writeJson(response, { ok: true });
  await options.onClose();
};

const POST_ROUTES: Readonly<Record<string, PostHandler>> = {
  "/api/input": input,
  "/api/steer": steer,
  "/api/abort": abort,
  "/api/command": command,
  "/api/ui-response": uiResponse,
  "/api/pi/thinking": thinking,
  "/api/pi/compact": compact,
  "/api/tasks/switch": switchTask,
  "/api/tasks/rename": renameTask,
  "/api/runtime": runtime,
  "/api/close": close,
};

async function handleGet(
  options: ShellServerOptions,
  shell: ShellRouteSession,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<boolean> {
  if (path === "/events") {
    shell.connectEvents(request, response);
  } else if (path === "/api/state") {
    shell.updateTask(await options.store.read(shell.task.id).catch(() => shell.task));
    writeJson(response, { status: shell.status, gameUrl: shell.gameUrl });
  } else if (path === "/api/worktrees") {
    const [worktrees, tasks] = await Promise.all([
      listRepositoryWorktrees(shell.task, options.store),
      listRecoverableTasks(shell.task, options.store),
    ]);
    writeJson(response, { worktrees, tasks, activeTaskId: shell.task.id });
  } else if (path === "/api/workspace/tree") {
    writeJson(response, {
      taskId: shell.task.id,
      files: await readWorkspaceTree(shell.task, options.store.dataDir),
      writeScope: shell.task.writeScope,
    });
  } else {
    return false;
  }
  return true;
}

/** 创建固定路由表；入口只做认证、方法分派和请求体解析。 */
export function createShellRouter(
  options: ShellServerOptions,
  shell: ShellRouteSession,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://" + (request.headers.host ?? "127.0.0.1"));
    if (request.method === "GET" && url.pathname === "/") {
      writeText(response, renderShellPage());
      return;
    }
    if (!shell.authorize(url, request)) {
      writeJson(response, { error: "Shell 任务令牌无效" }, 403);
      return;
    }
    if (request.method === "GET") {
      if (!await handleGet(options, shell, request, response, url.pathname)) {
        writeJson(response, { error: "未知 Shell 路径" }, 404);
      }
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, { error: "不支持的请求方法" }, 405);
      return;
    }
    const handler = POST_ROUTES[url.pathname];
    if (!handler) {
      writeJson(response, { error: "未知 Shell 路径" }, 404);
      return;
    }
    await handler({ options, shell, body: await jsonBody(request), response });
  };
}
