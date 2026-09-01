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
import type { AgentRpcCommand } from "../agent/rpc.js";
import type { EvidenceStore } from "../evidence/store.js";
import { buildEvidenceSnapshot, type EvidenceSnapshot } from "../evidence/view.js";
import {
  decideTokenControl,
  promptTokenLimit,
} from "../agent/token-control.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import {
  listRecoverableTasks,
  listRepositoryWorktrees,
  readWorkspaceTree,
} from "../workspace/catalog.js";
import { renderShellPage } from "./page.js";
import {
  createInitialStatus,
  MAINTAINER_PROGRESS_KEY,
  statusFromTask,
  type ShellApprovalRequest,
  type ShellActivityState,
  type ShellEvent,
  type ShellStatus,
  type ShellStatusConfig,
  type ShellTaskSwitchRequest,
  type ShellUiResponse,
} from "./protocol.js";
import {
  assistantStopReason,
  compactionEstimate,
  isRecord,
  isThinkingDelta,
  jsonBody,
  modelSummary,
  parseRpcEvent,
  sanitizeText,
  stringValue,
  textFromAssistantEvent,
  textFromMessage,
  visibleModelError,
  writeJson,
  writeText,
  isTerminalAssistantMessage,
} from "./codec.js";
type RpcSender = (command: AgentRpcCommand) => Promise<unknown>;
type ShellClient = { response: ServerResponse; lastEventId: number };

/** Shell 启动后返回的本机访问地址。 */
export interface ShellHandle {
  url: string;
  token: string;
  close(): Promise<void>;
  publish(event: ShellEvent): void;
  settleCommand(): void;
  updateTask(task: TaskRecord): void;
  updateTurnUsage(usage: unknown): void;
  updateSessionStats(stats: unknown): void;
  syncPiState(): Promise<void>;
  updateRuntime(update: { state: "starting" | "ready" | "error" | "stopped"; gameUrl?: string | null }): void;
  syncEvidence(): Promise<void>;
  handlePiEvent(event: unknown): void;
}

/** Shell 需要的外部行为，具体实现由 Pi 进程编排层提供。 */
export interface ShellServerOptions extends ShellStatusConfig {
  store: TaskStore;
  evidence?: EvidenceStore;
  readEvidenceSnapshot?: () => Promise<EvidenceSnapshot>;
  sendPiCommand: RpcSender;
  onSwitchTask?: (request: ShellTaskSwitchRequest) => Promise<TaskRecord>;
  onClose: () => Promise<void>;
}

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

/** 创建可供 start/resume 使用的本地 Shell。 */
export async function startShellServer(options: ShellServerOptions): Promise<ShellHandle> {
  let task = options.task;
  const shellTaskId = options.task.id;
  let status: ShellStatus = createInitialStatus(options);
  let activeMaxOutputTokens = options.maxOutputTokens ?? 4_096;
  let gameUrl: string | null = null;
  let sequence = 0;
  const events: Array<{ id: number; event: ShellEvent }> = [];
  const clients = new Set<ShellClient>();
  const token = randomUUID();
  let promptInFlight = false;
  let tokenControlInFlight = false;
  let activeRequestKind: "input" | "command" | null = null;
  let abortRequested = false;
  let abortInFlight = false;
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
  const isAbortRequested = (): boolean => abortRequested;
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
      promptInFlight = false;
      activeRequestKind = null;
      abortRequested = false;
      abortInFlight = false;
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
    promptInFlight = true;
    activeRequestKind = kind;
    abortRequested = false;
    abortInFlight = false;
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

  const toolActivity = (toolName: string): string => {
    if (toolName === "look") return "正在读取右侧游戏当前状态…";
    if (["act", "query"].includes(toolName)) return "正在右侧游戏中复现问题…";
    if (["inspect", "workspace"].includes(toolName)) {
      return "正在定位相关代码和证据…";
    }
    if (toolName === "edit") {
      return "正在修改 detached worktree；右侧游戏会自动刷新…";
    }
    if (["bash", "check"].includes(toolName)) return "正在运行检查和验证…";
    if (toolName === "finish") return "正在整理病因、完整方案或验证结论…";
    return "正在执行 " + toolName + "…";
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
    if (!promptInFlight || activeRequestKind !== "command") return;
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

  const refreshTokenUsage = async (): Promise<void> => {
    const stats = await options.sendPiCommand({ type: "get_session_stats" });
    updateSessionStats(stats);
  };

  const compactForTokenControl = async (): Promise<number | null> => {
    if (isAbortRequested()) throw new Error("当前回合已请求停止");
    status = { ...status, phase: "compacting" };
    publishState();
    publishActivity("working", "上下文超过安全线，正在压缩后再提交本轮消息…", true);
    const result = await options.sendPiCommand({
      type: "compact",
      customInstructions: "保留当前任务目标、最新游戏证据、源码定位、已批准修改范围、Diff、验证状态和未解决阻塞；删除重复旧工具正文。",
    });
    if (isAbortRequested()) throw new Error("当前回合已请求停止");
    const estimatedTokens = compactionEstimate(result);
    await refreshTokenUsage().catch(() => undefined);
    if (estimatedTokens !== null) {
      status = {
        ...status,
        contextUsed: estimatedTokens,
        contextPercent: status.contextLimit > 0
          ? estimatedTokens / status.contextLimit * 100
          : null,
      };
      publishState();
    }
    return estimatedTokens ?? status.contextUsed;
  };

  const ensureNaturalInputBudget = async (text: string): Promise<string | null> => {
    // 新会话尚未有可用上下文估算时不发额外 RPC；Pi 原生 overflow 门禁负责兜底。
    // 已有用量的会话才在发送前刷新，避免把未知状态误判为超限或改变普通请求顺序。
    if (status.contextUsed !== null) await refreshTokenUsage();
    const decision = decideTokenControl(
      status.contextUsed,
      status.contextLimit,
      activeMaxOutputTokens,
      text,
    );
    if (decision.action === "allow") return null;
    try {
      const compactedTokens = await compactForTokenControl();
      const afterCompaction = decideTokenControl(
        compactedTokens,
        status.contextLimit,
        activeMaxOutputTokens,
        text,
      );
      if (afterCompaction.action === "compact") {
        const error = "上下文压缩后仍预计使用 "
          + String(afterCompaction.projectedTokens)
          + " Token，超过安全输入上限 "
          + String(afterCompaction.promptTokenLimit)
          + "；请切换更大上下文模型或创建新任务。";
        status = { ...status, phase: "idle" };
        publishActivity("error", error);
        publishState();
        return error;
      }
      status = { ...status, phase: "idle" };
      publishActivity("done", "上下文压缩完成，正在提交本轮消息…");
      publishState();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "上下文压缩失败";
      status = { ...status, phase: "idle" };
      publishActivity("error", "自动压缩失败：" + sanitizeText(message));
      publishState();
      return "上下文已超过安全线，但自动压缩失败：" + sanitizeText(message);
    }
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
      if (method === "setStatus") {
        if (stringValue(event.statusKey) !== MAINTAINER_PROGRESS_KEY) return;
        const statusText = stringValue(event.statusText);
        progressText = statusText === null ? null : cleanProgressLine(statusText);
        publishProgress();
        return;
      }
      if (method === "setWidget") {
        if (stringValue(event.widgetKey) !== MAINTAINER_PROGRESS_KEY) return;
        progressLines = Array.isArray(event.widgetLines)
          ? event.widgetLines
            .filter((line): line is string => typeof line === "string")
            .slice(0, MAX_PROGRESS_LINES)
            .map(cleanProgressLine)
            .filter(Boolean)
          : [];
        publishProgress();
        return;
      }
      if (method === "notify") {
        const message = stringValue(event.message);
        if (message) {
          const level = event.notifyType === "error"
            ? "error"
            : event.notifyType === "warning" ? "warning" : "info";
          const safeMessage = sanitizeText(message);
          if (level === "error" && promptInFlight) {
            pendingTerminalError ??= safeMessage;
            publishActivity("working", "检查报告错误，正在等待本轮安全结束…");
          } else {
            publish({ type: "notice", level, text: safeMessage });
          }
        }
        return;
      }
      if (
        method === "confirm"
        || method === "select"
        || method === "input"
        || method === "editor"
      ) {
        const approvalTitle = sanitizeText(stringValue(event.title) ?? "需要确认");
        status = { ...status, phase: "approval" };
        publishState();
        publishActivity(
          "approval",
          method === "editor"
            ? "只读内容已就绪，关闭查看器后继续…"
            : approvalTitle === "是否执行完整修复方案"
            ? "等待你确认完整修复方案…"
            : approvalTitle === "是否允许本次代码修改"
            ? "等待你确认本次代码修改…"
            : "等待你的选择：" + approvalTitle,
        );
        const request: ShellApprovalRequest = {
          id,
          title: approvalTitle,
          message: sanitizeText(
            method === "editor"
              ? stringValue(event.prefill) ?? ""
              : stringValue(event.message) ?? "",
          ),
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
    if (event.type === "extension_error") {
      const detail = stringValue(event.error);
      pendingTerminalError ??= detail
        ? sanitizeText(detail).replace(/\s+/gu, " ").slice(0, 2_000)
        : "Pi Extension 执行失败，本轮没有安全完成。请重试；若持续发生，请检查维护器日志。";
      if (promptInFlight) {
        publishActivity("working", "Pi Extension 报告错误，正在等待本轮安全结束…");
      } else {
        publish({ type: "notice", level: "error", text: pendingTerminalError });
      }
      return;
    }
    if (event.type === "message_update") {
      const text = textFromAssistantEvent(event);
      if (text) {
        pendingTerminalError = null;
        publishActivity("working", "正在生成回复…");
        publish({ type: "chat.text", text: sanitizeText(text), done: false });
      } else if (isThinkingDelta(event)) {
        // thinking 正文属于不可展示的模型内部分析。这里只使用事件类型更新固定活动栏，
        // 既让用户知道请求仍在推进，也不把思维链写入聊天或 SSE 缓存。
        publishActivity("working", "模型正在分析问题…");
      }
      return;
    }
    if (event.type === "message_end") {
      const text = textFromMessage(event);
      const stopReason = assistantStopReason(event);
      if (text) {
        if (stopReason !== "error") pendingTerminalError = null;
        publish({ type: "chat.text", text: sanitizeText(text), done: true });
      }
      const modelError = visibleModelError(event);
      if (modelError) {
        // Pi 可能在 agent_end 后自动重试。此处只记录低敏错误并维持互斥锁，真正
        // 恢复输入必须等 agent_settled，避免新消息撞进自动重试或压缩流程。
        pendingTerminalError = modelError;
        publishActivity("waiting", "模型请求暂时失败，正在等待 Pi 重试或结束本轮…");
      } else if (stopReason === "length" && !text) {
        pendingTerminalError = "模型输出上限被内部分析耗尽，未生成可见答复。请降低思考预算或切换可直接回答的模型后重试。";
        publishActivity("working", "模型未生成可见答复，正在等待本轮安全结束…");
      } else if (stopReason === "aborted" && !text) {
        pendingTerminalError = "本轮模型请求已中止，未生成可见答复。";
        publishActivity("working", "模型请求已中止，正在等待本轮安全结束…");
      } else if (isTerminalAssistantMessage(event)) {
        if (!text) {
          pendingTerminalError = "模型返回了空答复，请重试；若持续发生，请检查模型兼容配置。";
          publishActivity("working", "模型返回空答复，正在等待本轮安全结束…");
        } else {
          publishActivity("working", "回复已生成，正在完成本轮收尾…");
        }
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const toolName = stringValue(event.toolName) ?? "tool";
      const phase = toolName === "edit"
        ? "edit"
        : ["look", "act", "query"].includes(toolName)
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
      publishActivity("working", toolActivity(toolName));
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
      void syncEvidence().catch(() => undefined);
      return;
    }
    if (event.type === "agent_start") {
      status = {
        ...status,
        phase: "diagnose",
        turnInputTokens: 0,
        turnOutputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnTotalTokens: 0,
      };
      publishActivity("working", "Pi 已开始处理，正在读取任务与游戏上下文…");
      publishState();
      return;
    }
    if (event.type === "agent_end") {
      if (promptInFlight) {
        publishActivity(
          event.willRetry === true ? "waiting" : "working",
          event.willRetry === true
            ? "本次模型调用将自动重试，输入仍保持锁定…"
            : "模型循环已结束，正在确认重试、压缩与队列状态…",
        );
      }
      return;
    }
    if (event.type === "agent_settled") {
      status = { ...status, phase: "idle" };
      if (promptInFlight && (activeRequestKind === "input" || activeRequestKind === "command")) {
        if (abortRequested) {
          finishRequest("done", "本轮已停止，可以继续输入", false);
        } else if (pendingTerminalError) {
          finishRequest("error", pendingTerminalError);
        } else {
          finishRequest("done", "本轮处理完成", false);
        }
      } else {
        publishState();
      }
      return;
    }
    if (event.type === "auto_retry_start") {
      const attempt = typeof event.attempt === "number" ? event.attempt : null;
      const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : null;
      publishActivity(
        "waiting",
        attempt !== null && maxAttempts !== null
          ? "模型请求失败，正在自动重试 " + String(attempt) + "/" + String(maxAttempts) + "…"
          : "模型请求失败，正在自动重试…",
      );
      return;
    }
    if (event.type === "auto_retry_end") {
      if (event.success === true) {
        pendingTerminalError = null;
        publishActivity("working", "自动重试已恢复，正在继续处理…");
      } else {
        publishActivity("working", "自动重试未恢复，正在等待本轮安全结束…");
      }
      return;
    }
    if (event.type === "compaction_start") {
      status = { ...status, phase: "compacting" };
      publishState();
      publishActivity("working", "正在压缩旧上下文，完成后会自动继续…");
      publish({ type: "notice", level: "info", text: "上下文接近上限，Pi 正在压缩旧证据摘要。" });
      return;
    }
    if (event.type === "compaction_end") {
      const result = isRecord(event.result) ? event.result : null;
      const estimatedTokens = result && typeof result.estimatedTokensAfter === "number"
        ? result.estimatedTokensAfter
        : null;
      const succeeded = !!result && event.aborted !== true;
      status = {
        ...status,
        phase: event.willRetry === true
          ? "diagnose"
          : promptInFlight ? "compacting" : "idle",
        contextUsed: estimatedTokens,
        contextPercent: null,
      };
      publishState();
      if (event.willRetry === true) {
        publishActivity("waiting", "上下文压缩完成，等待 Pi 继续诊断…");
      } else if (promptInFlight && succeeded) {
        publishActivity("working", "上下文压缩完成，正在等待本轮安全结束…");
      } else if (promptInFlight) {
        if (event.aborted !== true) {
          pendingTerminalError ??= "上下文压缩失败，请缩小问题范围后重试。";
        }
        publishActivity("working", "上下文压缩未继续，正在等待本轮安全结束…");
      } else if (succeeded) {
        publishActivity("done", "上下文压缩完成");
      } else {
        publishActivity("error", "上下文压缩失败，请缩小问题范围后重试。");
      }
      publish({
        type: "notice",
        level: succeeded ? "info" : "warning",
        text: succeeded
          ? "上下文压缩已完成，可以继续操作。"
          : event.aborted === true
            ? "上下文压缩已取消。"
            : "上下文压缩失败；请结束本轮并缩小任务范围。",
      });
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
    if (request.method === "GET" && url.pathname === "/api/worktrees") {
      const [worktrees, tasks] = await Promise.all([
        listRepositoryWorktrees(task, options.store),
        listRecoverableTasks(task, options.store),
      ]);
      writeJson(response, { worktrees, tasks, activeTaskId: task.id });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workspace/tree") {
      writeJson(response, {
        taskId: task.id,
        files: await readWorkspaceTree(task, options.store.dataDir),
        writeScope: task.writeScope,
      });
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
      if (promptInFlight) {
        writeJson(response, { error: "Pi 正在处理上一条消息，请等待当前动作完成" }, 409);
        return;
      }
      if (tokenControlInFlight) {
        writeJson(response, { error: "正在整理上下文，请等待 Token 门禁完成" }, 409);
        return;
      }
      tokenControlInFlight = true;
      let tokenError: string | null;
      try {
        tokenError = await ensureNaturalInputBudget(text).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "无法读取 Pi Token 用量";
          return "Token 门禁检查失败：" + sanitizeText(message);
        });
      } finally {
        tokenControlInFlight = false;
      }
      if (tokenError) {
        writeJson(response, { error: tokenError }, 409);
        return;
      }
      beginRequest("input");
      publish({ type: "chat.user", text: sanitizeText(text) });
      publishActivity("waiting", "消息已收到，正在等待 Pi 开始诊断…", true);
      try {
        await options.sendPiCommand({ id: randomUUID(), type: "prompt", message: text });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pi RPC 请求失败";
        finishRequest("error", "消息发送失败：" + sanitizeText(message));
        throw error;
      }
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/api/steer") {
      const text = stringValue(body.text)?.trim();
      if (!text || text.length > 4_000) {
        writeJson(response, { error: "追加要求为空或过长" }, 400);
        return;
      }
      if (text.startsWith("/")) {
        writeJson(response, { error: "运行中只能追加文字要求；固定命令请先停止本轮后再发送" }, 400);
        return;
      }
      if (!promptInFlight || activeRequestKind !== "input") {
        writeJson(response, { error: "固定命令执行中不能追加要求，请等待命令完成或停止本轮" }, 409);
        return;
      }
      if (abortRequested || abortInFlight) {
        writeJson(response, { error: "正在停止当前回合，请稍候" }, 409);
        return;
      }
      try {
        // 走 prompt 的 streamingBehavior 路径，让 Pi 在入队前触发 Extension input hook；
        // 直接 RPC steer 会绕过请求预算继承和最新请求合并。
        await options.sendPiCommand({
          id: randomUUID(),
          type: "prompt",
          message: text,
          streamingBehavior: "steer",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "追加要求发送失败";
        throw new Error("追加要求发送失败：" + sanitizeText(message), { cause: error });
      }
      publish({ type: "chat.user", text: sanitizeText(text) });
      publishActivity("working", "追加要求已发送，等待当前动作切换…");
      writeJson(response, { ok: true, accepted: true });
      return;
    }
    if (url.pathname === "/api/abort") {
      if (!promptInFlight && !tokenControlInFlight) {
        writeJson(response, { error: "当前没有正在运行的本轮" }, 409);
        return;
      }
      if (abortRequested || abortInFlight) {
        writeJson(response, { ok: true, accepted: true, duplicate: true });
        return;
      }
      abortRequested = true;
      abortInFlight = true;
      publishActivity("working", "正在停止当前回合…", true);
      try {
        await options.sendPiCommand({ type: "abort" });
      } catch (error) {
        abortRequested = false;
        abortInFlight = false;
        const message = error instanceof Error ? error.message : "停止请求发送失败";
        publishActivity("working", "停止请求失败，当前回合仍在运行…", true);
        throw new Error("停止当前回合失败：" + sanitizeText(message), { cause: error });
      }
      writeJson(response, { ok: true, accepted: true });
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
      if (promptInFlight) {
        writeJson(response, { error: "Pi 正在处理上一条消息，请等待当前动作完成" }, 409);
        return;
      }
      beginRequest("command");
      status = {
        ...status,
        phase: command === "/play"
          ? "reproduce"
          : command === "/verify" ? "verify" : "diagnose",
      };
      publishState();
      publish({ type: "chat.user", text });
      publishActivity("waiting", "正在执行 " + command + "…", true);
      void options.sendPiCommand({ id: randomUUID(), type: "prompt", message: command })
        .catch((error: unknown) => {
          if (!promptInFlight || activeRequestKind !== "command") return;
          const message = pendingTerminalError
            ?? ("命令发送失败：" + sanitizeText(
              error instanceof Error ? error.message : "Pi RPC 请求失败",
            ));
          finishRequest("error", message);
        });
      writeJson(response, { ok: true, accepted: true });
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
      publishActivity("working", "已收到你的选择，Pi 正在继续处理…");
      try {
        await options.sendPiCommand({ type: "extension_ui_response", ...uiResponse });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pi RPC UI 响应失败";
        finishRequest("error", "选择提交失败：" + sanitizeText(message));
        throw error;
      }
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/api/pi/thinking") {
      if (promptInFlight || status.phase === "compacting" || status.phase === "verify") {
        writeJson(response, { error: "Pi 正忙，当前不能切换 Thinking" }, 409);
        return;
      }
      const level = stringValue(body.level);
      if (!level || !status.availableThinkingLevels.includes(level)) {
        writeJson(response, { error: "Thinking 等级不受当前模型支持" }, 400);
        return;
      }
      await options.sendPiCommand({ type: "set_thinking_level", level });
      await syncPiState();
      writeJson(response, { ok: true, status });
      return;
    }
    if (url.pathname === "/api/pi/compact") {
      if (promptInFlight || status.phase === "compacting" || status.phase === "verify") {
        writeJson(response, { error: "Pi 正忙，当前不能手动压缩" }, 409);
        return;
      }
      status = { ...status, phase: "compacting" };
      publishState();
      publishActivity("working", "正在手动压缩旧上下文…", true);
      try {
        await options.sendPiCommand({
          type: "compact",
          customInstructions: "保留当前任务目标、最新游戏证据、源码定位、已批准修改范围、Diff 和验证状态；删除重复旧工具正文。",
        });
        await syncPiState();
        publishActivity("done", "上下文压缩完成");
        writeJson(response, { ok: true, status });
      } catch (error) {
        status = { ...status, phase: "idle" };
        publishActivity("error", "上下文压缩失败");
        throw error;
      }
      return;
    }
    if (url.pathname === "/api/tasks/switch") {
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
      if (promptInFlight && !agentConfirmed) {
        writeJson(response, { error: "Pi 正忙，当前不能切换工作树" }, 409);
        return;
      }
      publishActivity("waiting", "正在保存当前任务并切换工作树…", true);
      writeJson(response, { ok: true, accepted: true });
      setTimeout(() => {
        void options.onSwitchTask?.({ kind, id })
          .then((nextTask) => {
            updateTask(nextTask);
            publishActivity("done", "已切换到任务 " + nextTask.id.slice(0, 8));
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "任务切换失败";
            publishActivity("error", sanitizeText(message));
            publish({ type: "notice", level: "error", text: sanitizeText(message) });
          });
      }, agentConfirmed ? 800 : 0).unref();
      return;
    }
    if (url.pathname === "/api/tasks/rename") {
      if (promptInFlight || status.phase !== "idle") {
        writeJson(response, { error: "Pi 正忙，当前不能重命名任务" }, 409);
        return;
      }
      const name = stringValue(body.name)?.trim();
      if (!name || name.length > 80) {
        writeJson(response, { error: "任务名称不能为空且不能超过 80 个字符" }, 400);
        return;
      }
      await options.store.rename(task, name);
      updateTask(task);
      publish({ type: "notice", level: "info", text: "任务名称已更新为：" + sanitizeText(task.displayName) });
      writeJson(response, { ok: true, status });
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
  const shellUrl = baseUrl + "/?taskId=" + encodeURIComponent(shellTaskId) + "&token=" + encodeURIComponent(token);
  publishState();
  void syncEvidence().catch(() => undefined);

  return {
    url: shellUrl,
    token,
    close: async () => {
      stopActivityTimer();
      for (const client of clients) client.response.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    publish,
    settleCommand,
    updateTask,
    updateTurnUsage,
    updateSessionStats,
    syncPiState,
    updateRuntime,
    syncEvidence,
    handlePiEvent,
  };
}
