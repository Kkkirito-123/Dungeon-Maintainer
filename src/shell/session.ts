/**
 * Shell 会话状态。
 *
 * 这里管理任务摘要、请求状态、SSE 缓冲和 Pi 状态同步；HTTP 路由与 Pi 事件分类分别
 * 位于 routes.ts 和 events.ts。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { buildEvidenceSnapshot } from "../evidence/view.js";
import type { TaskRecord } from "../task/types.js";
import {
  createInitialStatus,
  MAINTAINER_PROGRESS_KEY,
  promptTokenLimit,
  statusFromTask,
  type ShellActivityState,
  type ShellCoreEvent,
  type ShellEvent,
  type ShellStatus,
} from "./protocol.js";
import { isRecord, modelSummary, sanitizeText } from "./codec.js";
import { reducePiEvent, type ShellEventSession } from "./events.js";
import type {
  ShellRequestState,
  ShellRouteSession,
} from "./routes.js";
import type { ShellServerOptions } from "./server.js";

type ShellClient = { response: ServerResponse; lastEventId: number };

const MAX_EVENTS = 500;
const MAX_PROGRESS_LINES = 80;
const MAX_PROGRESS_LINE_LENGTH = 500;
const ANSI_ESCAPE = new RegExp(
  String.fromCharCode(27) + "\\[[0-?]*[ -/]*[@-~]",
  "gu",
);

function cleanProgressLine(value: string): string {
  return sanitizeText(value)
    .replace(ANSI_ESCAPE, "")
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, MAX_PROGRESS_LINE_LENGTH);
}

export interface ShellSession extends ShellRouteSession, ShellEventSession {
  start(): void;
  close(): void;
  updateTurnUsage(usage: unknown): void;
  updateSessionStats(stats: unknown): void;
  handlePiEvent(event: ShellCoreEvent): void;
}

export function createShellSession(
  options: ShellServerOptions,
  token: string,
): ShellSession {
  let task = options.task;
  const shellTaskId = options.task.id;
  let status: ShellStatus = createInitialStatus(options);
  let activeMaxOutputTokens = options.maxOutputTokens ?? 4_096;
  let gameUrl: string | null = null;
  let sequence = 0;
  const events: Array<{ id: number; event: ShellEvent }> = [];
  const clients = new Set<ShellClient>();
  let requestState: ShellRequestState = "idle";
  let pendingTerminalError: string | null = null;
  let progressText: string | null = null;
  let progressLines: string[] = [];
  let activityStartedAt: number | null = null;
  let activityText = "";
  let activityState: ShellActivityState = "done";
  let activityTimer: NodeJS.Timeout | null = null;
  let lastStatePayload = "";
  let lastEvidenceRevision = -1;
  let evidenceSync: Promise<void> = Promise.resolve();

  const publish = (event: ShellEvent): void => {
    if (event.type === "progress") {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.event.type === "progress") events.splice(index, 1);
      }
    }
    sequence += 1;
    events.push({ id: sequence, event });
    while (events.length > MAX_EVENTS) events.shift();
    const payload = "id: " + String(sequence) + "\ndata: " + JSON.stringify(event) + "\n\n";
    for (const client of clients) {
      client.lastEventId = sequence;
      client.response.write(payload);
    }
  };

  const publishProgress = (): void => {
    publish({
      type: "progress",
      key: MAINTAINER_PROGRESS_KEY,
      text: progressText,
      lines: [...progressLines],
    });
  };

  const publishState = (): void => {
    const payload = JSON.stringify({ status, gameUrl });
    if (payload === lastStatePayload) return;
    lastStatePayload = payload;
    publish({ type: "state", status, gameUrl });
  };

  const activityElapsed = (): number => activityStartedAt === null
    ? 0
    : Math.max(0, Math.floor((Date.now() - activityStartedAt) / 1_000));

  const stopActivityTimer = (): void => {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = null;
  };

  const publishActivity = (
    state: ShellActivityState,
    text: string,
    startNew = false,
  ): void => {
    if (
      !startNew
      && activityStartedAt !== null
      && activityState === state
      && activityText === text
    ) return;
    if (startNew || activityStartedAt === null) activityStartedAt = Date.now();
    activityState = state;
    activityText = text;
    publish({
      type: "activity",
      state,
      text: sanitizeText(text),
      elapsedSeconds: activityElapsed(),
    });
    const active = state === "waiting" || state === "working" || state === "approval";
    if (!active) {
      stopActivityTimer();
      activityStartedAt = null;
      requestState = "idle";
      return;
    }
    if (!activityTimer) {
      // 五秒只更新同一个固定状态区域，不向聊天记录追加气泡，也不调用模型，
      // 因而能让长请求保持可见反馈，同时不增加 Token 或挤满 SSE 缓冲。
      activityTimer = setInterval(() => {
        publish({
          type: "activity",
          state: activityState,
          text: sanitizeText(activityText),
          elapsedSeconds: activityElapsed(),
        });
      }, 5_000);
      activityTimer.unref();
    }
  };

  const beginRequest = (kind: "input" | "command"): void => {
    requestState = kind;
    pendingTerminalError = null;
    status = {
      ...status,
      turnInputTokens: 0,
      turnOutputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnTotalTokens: 0,
      ...(kind === "input" ? { toolCalls: 0 } : {}),
    };
    publishState();
  };

  const finishRequest = (
    state: "done" | "error",
    text: string,
    publishErrorNotice = state === "error",
  ): void => {
    const safeText = sanitizeText(text);
    if (publishErrorNotice && state === "error") {
      publish({ type: "notice", level: "error", text: safeText });
    }
    status = { ...status, phase: "idle" };
    pendingTerminalError = null;
    publishActivity(state, safeText);
    publishState();
  };

  const authorize = (url: URL, request: IncomingMessage): boolean => {
    const requestTask = url.searchParams.get("taskId");
    const headerToken = Array.isArray(request.headers["x-dungeon-token"])
      ? request.headers["x-dungeon-token"][0]
      : request.headers["x-dungeon-token"];
    const requestToken = url.searchParams.get("token") ?? headerToken;
    return requestTask === shellTaskId && requestToken === token;
  };

  const updateTask = (nextTask: TaskRecord): void => {
    const changedTask = nextTask.id !== task.id;
    task = nextTask;
    if (changedTask) {
      progressText = null;
      progressLines = [];
      publishProgress();
    }
    status = statusFromTask(status, nextTask);
    publishState();
  };

  const settleCommand = (): void => {
    if (requestState !== "command") return;
    finishRequest(
      pendingTerminalError ? "error" : "done",
      pendingTerminalError ?? "固定命令执行完成",
      pendingTerminalError !== null,
    );
  };

  const syncEvidence = async (): Promise<void> => {
    if (!options.evidence && !options.readEvidenceSnapshot) return;
    evidenceSync = evidenceSync.catch(() => undefined).then(async () => {
      const snapshot = options.readEvidenceSnapshot
        ? await options.readEvidenceSnapshot()
        : options.evidence
          ? await buildEvidenceSnapshot(options.evidence)
          : null;
      if (!snapshot) return;
      if (snapshot.revision === lastEvidenceRevision && snapshot.taskId === task.id) return;
      lastEvidenceRevision = snapshot.revision;
      // 证据快照是当前状态投影，不是事件流水；SSE 重连只需要最近一份，旧快照会让
      // 环形缓存膨胀并在浏览器重连时重复渲染整张证据图。
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.event.type === "evidence.snapshot") events.splice(index, 1);
      }
      publish({ type: "evidence.snapshot", ...snapshot });
    });
    await evidenceSync;
  };

  const updateTurnUsage = (value: unknown): void => {
    if (!isRecord(value)) return;
    status = {
      ...status,
      turnInputTokens: typeof value.input === "number" ? value.input : status.turnInputTokens,
      turnOutputTokens: typeof value.output === "number" ? value.output : status.turnOutputTokens,
      cacheReadTokens: typeof value.cacheRead === "number" ? value.cacheRead : status.cacheReadTokens,
      cacheWriteTokens: typeof value.cacheWrite === "number" ? value.cacheWrite : status.cacheWriteTokens,
      turnTotalTokens: typeof value.totalTokens === "number"
        ? value.totalTokens
        : status.turnTotalTokens,
    };
    publishState();
  };

  const updateSessionStats = (value: unknown): void => {
    if (!isRecord(value)) return;
    const tokens = isRecord(value.tokens) ? value.tokens : null;
    const contextUsage = isRecord(value.contextUsage) ? value.contextUsage : null;
    if (tokens) {
      status = {
        ...status,
        sessionInputTokens: typeof tokens.input === "number"
          ? tokens.input
          : status.sessionInputTokens,
        sessionOutputTokens: typeof tokens.output === "number"
          ? tokens.output
          : status.sessionOutputTokens,
        sessionCacheReadTokens: typeof tokens.cacheRead === "number"
          ? tokens.cacheRead
          : status.sessionCacheReadTokens,
        sessionCacheWriteTokens: typeof tokens.cacheWrite === "number"
          ? tokens.cacheWrite
          : status.sessionCacheWriteTokens,
        totalTokens: typeof tokens.total === "number" ? tokens.total : status.totalTokens,
      };
    }
    if (contextUsage) {
      const contextLimit = typeof contextUsage.contextWindow === "number"
        ? contextUsage.contextWindow
        : status.contextLimit;
      status = {
        ...status,
        contextUsed: typeof contextUsage.tokens === "number"
          ? contextUsage.tokens
          : null,
        contextLimit,
        contextPercent: typeof contextUsage.percent === "number"
          ? contextUsage.percent
          : null,
        promptTokenLimit: promptTokenLimit(contextLimit, activeMaxOutputTokens),
      };
    }
    publishState();
  };

  const syncPiState = async (): Promise<void> => {
    const [stateValue, levelsValue, statsValue] = await Promise.all([
      options.sendPiCommand({ type: "get_state" }),
      options.sendPiCommand({ type: "get_available_thinking_levels" }),
      options.sendPiCommand({ type: "get_session_stats" }),
    ]);
    const state = isRecord(stateValue) ? stateValue : null;
    const currentModel = state ? modelSummary(state.model) : null;
    activeMaxOutputTokens = currentModel?.maxOutputTokens ?? activeMaxOutputTokens;
    const contextLimit = currentModel?.contextWindow ?? status.contextLimit;
    const levelsRecord = isRecord(levelsValue) ? levelsValue : null;
    const levels = Array.isArray(levelsRecord?.levels)
      ? levelsRecord.levels.filter((level): level is string => typeof level === "string")
      : status.availableThinkingLevels;
    status = {
      ...status,
      modelProvider: currentModel?.provider ?? status.modelProvider,
      model: currentModel?.id ?? status.model,
      thinkingLevel: state && typeof state.thinkingLevel === "string"
        ? state.thinkingLevel
        : status.thinkingLevel,
      availableThinkingLevels: levels.length > 0 ? levels : ["off"],
      autoCompactionEnabled: state?.autoCompactionEnabled === true,
      pendingMessageCount: state && typeof state.pendingMessageCount === "number"
        ? state.pendingMessageCount
        : 0,
      contextLimit,
      promptTokenLimit: promptTokenLimit(contextLimit, activeMaxOutputTokens),
    };
    const previousThinkingLevel = task.thinkingLevel;
    if (
      status.thinkingLevel === "off"
      || status.thinkingLevel === "minimal"
      || status.thinkingLevel === "low"
      || status.thinkingLevel === "medium"
      || status.thinkingLevel === "high"
      || status.thinkingLevel === "xhigh"
      || status.thinkingLevel === "max"
    ) {
      task.thinkingLevel = status.thinkingLevel;
    }
    if (
      previousThinkingLevel !== task.thinkingLevel
    ) {
      await options.store.save(task);
    }
    updateSessionStats(statsValue);
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


  const session: ShellRouteSession & ShellEventSession = {
    get task() { return task; },
    get status() { return status; },
    set status(next) { status = next; },
    get gameUrl() { return gameUrl; },
    get requestState() { return requestState; },
    get pendingTerminalError() { return pendingTerminalError; },
    set pendingTerminalError(error) { pendingTerminalError = error; },
    authorize,
    connectEvents: (request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const lastId = Number(request.headers["last-event-id"] ?? "0");
      const client: ShellClient = {
        response,
        lastEventId: Number.isFinite(lastId) ? lastId : 0,
      };
      clients.add(client);
      for (const item of events) {
        if (item.id > client.lastEventId) {
          response.write(
            "id: " + String(item.id) + "\ndata: " + JSON.stringify(item.event) + "\n\n",
          );
        }
      }
      request.on("close", () => clients.delete(client));
    },
    setRequestState: (next) => {
      requestState = next;
    },
    setPhase: (phase) => {
      status = { ...status, phase };
      publishState();
    },
    beginRequest,
    finishRequest,
    publish,
    publishState,
    publishActivity,
    publishProgress: (update) => {
      if (update.text !== undefined) {
        progressText = update.text === null ? null : cleanProgressLine(update.text);
      }
      if (update.lines !== undefined) {
        progressLines = update.lines
          .slice(0, MAX_PROGRESS_LINES)
          .map(cleanProgressLine)
          .filter(Boolean);
      }
      publishProgress();
    },
    settleCommand,
    updateTask,
    syncPiState,
    updateRuntime,
    syncEvidence,
  };
  const handlePiEvent = (event: ShellCoreEvent): void => reducePiEvent(session, event);
  return Object.assign(session, {
    start: () => {
      publishState();
      void syncEvidence().catch(() => undefined);
    },
    close: () => {
      stopActivityTimer();
      for (const client of clients) client.response.end();
      clients.clear();
    },
    updateTurnUsage,
    updateSessionStats,
    handlePiEvent,
  });
}
