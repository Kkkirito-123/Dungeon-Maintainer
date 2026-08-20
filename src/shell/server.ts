/**
 * Dungeon Maintainer 本地统一 Shell HTTP/SSE 服务。
 *
 * 本模块只负责把 Pi RPC 事件、任务摘要和游戏运行时状态提供给本机 Chromium，并把
 * 用户输入、固定命令和确认框响应转交给上层回调。它不直接执行 Git、Shell、SQL 或
 * 模型请求；所有真正的权限判断仍在 Pi Extension、workspace 和 repair 模块中完成。
 *
 * 服务只绑定 127.0.0.1，任务令牌每次启动随机生成。事件环形缓存最多保留 500 条低敏
 * 摘要，关闭时释放 HTTP 服务和 SSE 客户端，不写入游戏仓库。敏感正文在进入浏览器前
 * 只保留文本消息和工具名，工具参数、完整工具结果与思维链不会通过本服务持久化。
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { PiRpcCommand } from "../pi/rpc-process.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { renderShellPage } from "./page.js";
import {
  createInitialStatus,
  statusFromTask,
  type ShellApprovalRequest,
  type ShellEvent,
  type ShellStatus,
  type ShellStatusConfig,
  type ShellUiResponse,
} from "./protocol.js";

type JsonRecord = Record<string, unknown>;
type RpcSender = (command: PiRpcCommand) => Promise<unknown>;
type ShellClient = { response: ServerResponse; lastEventId: number };

/** Shell 启动后返回的本机访问地址。 */
export interface ShellHandle {
  url: string;
  token: string;
  close(): Promise<void>;
  publish(event: ShellEvent): void;
  updateTask(task: TaskRecord): void;
  updateSessionStats(stats: unknown): void;
  updateRuntime(update: { state: "starting" | "ready" | "error" | "stopped"; gameUrl?: string | null }): void;
  handlePiEvent(event: unknown): void;
}

/** Shell 需要的外部行为，具体实现由 Pi 进程编排层提供。 */
export interface ShellServerOptions extends ShellStatusConfig {
  store: TaskStore;
  sendPiCommand: RpcSender;
  onClose: () => Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 500;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sanitizeText(text: string): string {
  return text
    .replaceAll(/(?:api[_ -]?key|authorization|bearer)\s*[:=]\s*\S+/giu, "[已隐藏]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]+\b/gu, "[已隐藏]")
    .slice(0, 8_000);
}

function jsonBody(request: IncomingMessage): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        request.destroy();
        return;
      }
      text += chunk;
    });
    request.on("end", () => {
      try {
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (!isRecord(parsed)) throw new Error("请求体必须是 JSON 对象");
        resolve(parsed);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("请求体无效"));
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function writeText(response: ServerResponse, value: string, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(value);
}

function parseRpcEvent(value: unknown): JsonRecord | null {
  return isRecord(value) && typeof value.type === "string" ? value : null;
}

function textFromAssistantEvent(value: JsonRecord): string | null {
  const event = isRecord(value.assistantMessageEvent)
    ? value.assistantMessageEvent
    : null;
  if (!event || event.type !== "text_delta") return null;
  return stringValue(event.delta);
}

function textFromMessage(value: JsonRecord): string | null {
  const message = isRecord(value.message) ? value.message : null;
  if (!message || !Array.isArray(message.content)) return null;
  const chunks = message.content
    .filter(isRecord)
    .map((block) => block.type === "text" ? stringValue(block.text) : null)
    .filter((text): text is string => !!text);
  return chunks.length > 0 ? chunks.join("") : null;
}

/** 创建可供 start/resume 使用的本地 Shell。 */
export async function startShellServer(options: ShellServerOptions): Promise<ShellHandle> {
  let task = options.task;
  let status: ShellStatus = createInitialStatus(options);
  let gameUrl: string | null = null;
  let sequence = 0;
  const events: Array<{ id: number; event: ShellEvent }> = [];
  const clients = new Set<ShellClient>();
  const token = randomUUID();
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        writeJson(response, {
          error: error instanceof Error ? error.message : "Shell 请求失败",
        }, 500);
      } else {
        response.end();
      }
    });
  });

  const publish = (event: ShellEvent): void => {
    sequence += 1;
    events.push({ id: sequence, event });
    while (events.length > MAX_EVENTS) events.shift();
    const payload = "id: " + String(sequence) + "\ndata: " + JSON.stringify(event) + "\n\n";
    for (const client of clients) {
      client.lastEventId = sequence;
      client.response.write(payload);
    }
  };

  const publishState = (): void => publish({ type: "state", status, gameUrl });

  const authorize = (url: URL, request: IncomingMessage): boolean => {
    const requestTask = url.searchParams.get("taskId");
    const headerToken = Array.isArray(request.headers["x-dungeon-token"])
      ? request.headers["x-dungeon-token"][0]
      : request.headers["x-dungeon-token"];
    const requestToken = url.searchParams.get("token") ?? headerToken;
    return requestTask === task.id && requestToken === token;
  };

  const updateTask = (nextTask: TaskRecord): void => {
    task = nextTask;
    status = statusFromTask(status, nextTask);
    publishState();
  };

  const updateSessionStats = (value: unknown): void => {
    if (!isRecord(value)) return;
    const tokens = isRecord(value.tokens) ? value.tokens : null;
    const contextUsage = isRecord(value.contextUsage) ? value.contextUsage : null;
    if (tokens) {
      status = {
        ...status,
        turnInputTokens: typeof tokens.input === "number" ? tokens.input : status.turnInputTokens,
        turnOutputTokens: typeof tokens.output === "number" ? tokens.output : status.turnOutputTokens,
        cacheReadTokens: typeof tokens.cacheRead === "number" ? tokens.cacheRead : status.cacheReadTokens,
        totalTokens: typeof tokens.total === "number" ? tokens.total : status.totalTokens,
      };
    }
    if (contextUsage && typeof contextUsage.tokens === "number") {
      status = { ...status, contextUsed: contextUsage.tokens };
    }
    publishState();
  };

  const updateRuntime = (update: { state: "starting" | "ready" | "error" | "stopped"; gameUrl?: string | null }): void => {
    if (update.gameUrl !== undefined) gameUrl = update.gameUrl;
    status = {
      ...status,
      viteState: update.state === "ready"
        ? "ready"
        : update.state === "error"
          ? "error"
          : update.state === "stopped" ? "stopped" : "starting",
      browserState: update.state === "ready"
        ? "ready"
        : update.state === "error"
          ? "error"
          : update.state === "stopped" ? "stopped" : "starting",
      bridgeState: update.state === "ready"
        ? "ready"
        : update.state === "error" ? "unavailable" : status.bridgeState,
    };
    publish({ type: "game", state: update.state, gameUrl });
    publishState();
  };

  const handlePiEvent = (value: unknown): void => {
    const event = parseRpcEvent(value);
    if (!event) return;
    if (event.type === "extension_ui_request") {
      const method = stringValue(event.method);
      const id = stringValue(event.id);
      if (!method || !id) return;
      if (method === "notify") {
        const message = stringValue(event.message);
        if (message) {
          const level = event.notifyType === "error"
            ? "error"
            : event.notifyType === "warning" ? "warning" : "info";
          publish({ type: "notice", level, text: sanitizeText(message) });
        }
        return;
      }
      if (method === "confirm" || method === "select" || method === "input") {
        status = { ...status, phase: "approval" };
        publishState();
        const request: ShellApprovalRequest = {
          id,
          title: sanitizeText(stringValue(event.title) ?? "需要确认"),
          message: sanitizeText(stringValue(event.message) ?? ""),
          kind: method,
        };
        if (Array.isArray(event.options)) {
          request.options = event.options
            .filter((item): item is string => typeof item === "string")
            .slice(0, 20);
        }
        publish({ type: "approval", request });
      }
      return;
    }
    if (event.type === "message_update") {
      const text = textFromAssistantEvent(event);
      if (text) publish({ type: "chat.text", text: sanitizeText(text), done: false });
      return;
    }
    if (event.type === "message_end") {
      const text = textFromMessage(event);
      if (text) publish({ type: "chat.text", text: sanitizeText(text), done: true });
      return;
    }
    if (event.type === "tool_execution_start") {
      const toolName = stringValue(event.toolName) ?? "tool";
      const phase = toolName === "patch"
        ? "patch"
        : ["look", "go", "use", "query"].includes(toolName)
          ? "reproduce"
          : ["check", "finish"].includes(toolName)
            ? "verify"
            : "diagnose";
      status = { ...status, toolCalls: status.toolCalls + 1, phase };
      publish({
        type: "chat.tool",
        name: toolName,
        phase: "start",
        error: false,
      });
      publishState();
      return;
    }
    if (event.type === "tool_execution_end") {
      const toolName = stringValue(event.toolName) ?? "tool";
      publish({
        type: "chat.tool",
        name: toolName,
        phase: "end",
        error: event.isError === true,
      });
      return;
    }
    if (event.type === "agent_start") {
      status = { ...status, phase: "diagnose" };
      publishState();
      return;
    }
    if (event.type === "agent_end" || event.type === "agent_settled") {
      status = { ...status, phase: "idle" };
      publishState();
      return;
    }
    if (event.type === "compaction_start") {
      publish({ type: "notice", level: "info", text: "上下文接近上限，Pi 正在压缩旧证据摘要。" });
    }
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", "http://" + host);
    if (request.method === "GET" && url.pathname === "/") {
      writeText(response, renderShellPage());
      return;
    }
    if (!authorize(url, request)) {
      writeJson(response, { error: "Shell 任务令牌无效" }, 403);
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const lastId = Number(request.headers["last-event-id"] ?? "0");
      const client: ShellClient = { response, lastEventId: Number.isFinite(lastId) ? lastId : 0 };
      clients.add(client);
      for (const item of events) {
        if (item.id > client.lastEventId) {
          response.write("id: " + String(item.id) + "\ndata: " + JSON.stringify(item.event) + "\n\n");
        }
      }
      request.on("close", () => clients.delete(client));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      const currentTask = await options.store.read(task.id).catch(() => task);
      updateTask(currentTask);
      writeJson(response, { status, gameUrl });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, { error: "不支持的请求方法" }, 405);
      return;
    }
    const body = await jsonBody(request);
    if (url.pathname === "/api/input") {
      const text = stringValue(body.text)?.trim();
      if (!text || text.length > 4_000) {
        writeJson(response, { error: "输入为空或过长" }, 400);
        return;
      }
      publish({ type: "chat.user", text: sanitizeText(text) });
      await options.sendPiCommand({ id: randomUUID(), type: "prompt", message: text });
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/api/command") {
      const text = stringValue(body.text)?.trim() ?? "";
      const command = text.split(/\s+/u)[0] ?? "";
      const allowed = ["/play", "/diff", "/verify", "/apply", "/discard"];
      if (!allowed.includes(command)) {
        writeJson(response, { error: "不支持的 Shell 命令" }, 400);
        return;
      }
      publish({ type: "chat.user", text });
      await options.sendPiCommand({ id: randomUUID(), type: "prompt", message: command });
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/api/ui-response") {
      const id = stringValue(body.id);
      if (!id) {
        writeJson(response, { error: "缺少 UI 请求 ID" }, 400);
        return;
      }
      const uiResponse: ShellUiResponse = typeof body.confirmed === "boolean"
        ? { id, confirmed: body.confirmed }
        : typeof body.value === "string"
          ? { id, value: body.value }
          : { id, cancelled: true };
      await options.sendPiCommand({ type: "extension_ui_response", ...uiResponse });
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/api/runtime") {
      const runtimeState = body.state;
      if (runtimeState !== "starting" && runtimeState !== "ready" && runtimeState !== "error" && runtimeState !== "stopped") {
        writeJson(response, { error: "运行时状态无效" }, 400);
        return;
      }
      const nextUrl = typeof body.gameUrl === "string" ? body.gameUrl : null;
      updateRuntime({ state: runtimeState, gameUrl: nextUrl });
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/api/close") {
      writeJson(response, { ok: true });
      await options.onClose();
      return;
    }
    writeJson(response, { error: "未知 Shell 路径" }, 404);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配 Shell 本机端口");
  const baseUrl = "http://127.0.0.1:" + String(address.port);
  const shellUrl = baseUrl + "/?taskId=" + encodeURIComponent(options.task.id) + "&token=" + encodeURIComponent(token);
  publishState();

  return {
    url: shellUrl,
    token,
    close: async () => {
      for (const client of clients) client.response.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    publish,
    updateTask,
    updateSessionStats,
    updateRuntime,
    handlePiEvent,
  };
}
