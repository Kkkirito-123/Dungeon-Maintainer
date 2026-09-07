/** 将 Pi RPC 事件归约成 Shell 状态和低敏 UI 事件。 */

import {
  assistantStopReason,
  isRecord,
  isTerminalAssistantMessage,
  isThinkingDelta,
  sanitizeText,
  stringValue,
  textFromAssistantEvent,
  textFromMessage,
  visibleModelError,
} from "./codec.js";
import {
  MAINTAINER_PROGRESS_KEY,
  type ShellApprovalRequest,
  type ShellCoreEvent,
  type ShellEvent,
  type ShellStatus,
} from "./protocol.js";
import type { ShellRequestState } from "./routes.js";

type RpcEvent = ShellCoreEvent & Record<string, unknown>;

export interface ShellEventSession {
  status: ShellStatus;
  pendingTerminalError: string | null;
  readonly requestState: ShellRequestState;
  publish(event: ShellEvent): void;
  publishState(): void;
  publishActivity(
    state: "waiting" | "working" | "approval" | "done" | "error",
    text: string,
    startNew?: boolean,
  ): void;
  publishProgress(update: { text?: string | null; lines?: string[] }): void;
  finishRequest(state: "done" | "error", text: string, notice?: boolean): void;
  syncEvidence(): Promise<void>;
}

function toolActivity(toolName: string): string {
  if (toolName === "look") return "正在读取右侧游戏当前状态…";
  if (["act", "query"].includes(toolName)) return "正在右侧游戏中复现问题…";
  if (["inspect", "workspace"].includes(toolName)) return "正在定位相关代码和证据…";
  if (toolName === "edit") return "正在修改 detached worktree；右侧游戏会自动刷新…";
  if (["bash", "check"].includes(toolName)) return "正在运行检查和验证…";
  if (toolName === "finish") return "正在整理病因、完整方案或验证结论…";
  return "正在执行 " + toolName + "…";
}

function handleExtensionEvent(session: ShellEventSession, event: RpcEvent): boolean {
  if (event.type === "extension_error") {
    const detail = stringValue(event.error);
    session.pendingTerminalError = detail
      ? sanitizeText(detail).replace(/\s+/gu, " ").slice(0, 2_000)
      : "Pi Extension 执行失败，本轮没有安全完成。请重试；若持续发生，请检查维护器日志。";
    if (session.requestState === "idle") {
      session.publish({ type: "notice", level: "error", text: session.pendingTerminalError });
    } else {
      session.publishActivity("working", "Pi Extension 报告错误，正在等待本轮安全结束…");
    }
    return true;
  }
  if (event.type !== "extension_ui_request") return false;
  const method = stringValue(event.method);
  const id = stringValue(event.id);
  if (!method || !id) return true;
  if (method === "setStatus") {
    if (stringValue(event.statusKey) === MAINTAINER_PROGRESS_KEY) {
      session.publishProgress({ text: stringValue(event.statusText) });
    }
    return true;
  }
  if (method === "setWidget") {
    if (stringValue(event.widgetKey) === MAINTAINER_PROGRESS_KEY) {
      session.publishProgress({
        lines: Array.isArray(event.widgetLines)
          ? event.widgetLines.filter((line): line is string => typeof line === "string")
          : [],
      });
    }
    return true;
  }
  if (method === "notify") {
    const message = stringValue(event.message);
    if (!message) return true;
    const level = event.notifyType === "error"
      ? "error"
      : event.notifyType === "warning" ? "warning" : "info";
    const text = sanitizeText(message);
    if (level === "error" && session.requestState !== "idle") {
      session.pendingTerminalError ??= text;
      session.publishActivity("working", "检查报告错误，正在等待本轮安全结束…");
    } else {
      session.publish({ type: "notice", level, text });
    }
    return true;
  }
  if (!["confirm", "select", "input", "editor"].includes(method)) return true;
  const title = sanitizeText(stringValue(event.title) ?? "需要确认");
  session.status = { ...session.status, phase: "approval" };
  session.publishState();
  session.publishActivity(
    "approval",
    method === "editor"
      ? "只读内容已就绪，关闭查看器后继续…"
      : title === "是否执行完整修复方案"
        ? "等待你确认完整修复方案…"
        : title === "是否允许本次代码修改"
          ? "等待你确认本次代码修改…"
          : "等待你的选择：" + title,
  );
  const request: ShellApprovalRequest = {
    id,
    title,
    message: sanitizeText(
      method === "editor" ? stringValue(event.prefill) ?? "" : stringValue(event.message) ?? "",
    ),
    kind: method as ShellApprovalRequest["kind"],
  };
  if (Array.isArray(event.options)) {
    request.options = event.options
      .filter((item): item is string => typeof item === "string")
      .slice(0, 20);
  }
  session.publish({ type: "approval", request });
  return true;
}

function handleMessageEvent(session: ShellEventSession, event: RpcEvent): boolean {
  if (event.type === "message_update") {
    const text = textFromAssistantEvent(event);
    if (text) {
      session.pendingTerminalError = null;
      session.publishActivity("working", "正在生成回复…");
      session.publish({ type: "chat.text", text: sanitizeText(text), done: false });
    } else if (isThinkingDelta(event)) {
      session.publishActivity("working", "模型正在分析问题…");
    }
    return true;
  }
  if (event.type !== "message_end") return false;
  const text = textFromMessage(event);
  const stopReason = assistantStopReason(event);
  if (text) {
    if (stopReason !== "error") session.pendingTerminalError = null;
    session.publish({ type: "chat.text", text: sanitizeText(text), done: true });
  }
  const modelError = visibleModelError(event);
  if (modelError) {
    session.pendingTerminalError = modelError;
    session.publishActivity("waiting", "模型请求暂时失败，正在等待 Pi 重试或结束本轮…");
  } else if (stopReason === "length" && !text) {
    session.pendingTerminalError = "模型输出上限被内部分析耗尽，未生成可见答复。请降低思考预算或切换可直接回答的模型后重试。";
    session.publishActivity("working", "模型未生成可见答复，正在等待本轮安全结束…");
  } else if (stopReason === "aborted" && !text) {
    session.pendingTerminalError = "本轮模型请求已中止，未生成可见答复。";
    session.publishActivity("working", "模型请求已中止，正在等待本轮安全结束…");
  } else if (isTerminalAssistantMessage(event)) {
    if (text) {
      session.publishActivity("working", "回复已生成，正在完成本轮收尾…");
    } else {
      session.pendingTerminalError = "模型返回了空答复，请重试；若持续发生，请检查模型兼容配置。";
      session.publishActivity("working", "模型返回空答复，正在等待本轮安全结束…");
    }
  }
  return true;
}

function finishSettledRequest(session: ShellEventSession): void {
  session.status = { ...session.status, phase: "idle" };
  if (session.requestState === "idle") {
    session.publishState();
  } else if (session.requestState === "aborting") {
    session.finishRequest("done", "本轮已停止，可以继续输入", false);
  } else if (session.pendingTerminalError) {
    session.finishRequest("error", session.pendingTerminalError);
  } else {
    session.finishRequest("done", "本轮处理完成", false);
  }
}

function handleLifecycleEvent(session: ShellEventSession, event: RpcEvent): void {
  if (event.type === "tool_execution_start") {
    const toolName = stringValue(event.toolName) ?? "tool";
    const phase = toolName === "edit"
      ? "edit"
      : ["look", "act", "query"].includes(toolName)
        ? "reproduce"
        : ["check", "finish"].includes(toolName) ? "verify" : "diagnose";
    session.status = {
      ...session.status,
      toolCalls: session.status.toolCalls + 1,
      phase,
    };
    session.publish({ type: "chat.tool", name: toolName, phase: "start", error: false });
    session.publishActivity("working", toolActivity(toolName));
    session.publishState();
  } else if (event.type === "tool_execution_end") {
    session.publish({
      type: "chat.tool",
      name: stringValue(event.toolName) ?? "tool",
      phase: "end",
      error: event.isError === true,
    });
    void session.syncEvidence().catch(() => undefined);
  } else if (event.type === "agent_start") {
    session.status = {
      ...session.status,
      phase: "diagnose",
      turnInputTokens: 0,
      turnOutputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnTotalTokens: 0,
    };
    session.publishActivity("working", "Pi 已开始处理，正在读取任务与游戏上下文…");
    session.publishState();
  } else if (event.type === "agent_end" && session.requestState !== "idle") {
    session.publishActivity(
      event.willRetry === true ? "waiting" : "working",
      event.willRetry === true
        ? "本次模型调用将自动重试，输入仍保持锁定…"
        : "模型循环已结束，正在确认重试、压缩与队列状态…",
    );
  } else if (event.type === "agent_settled") {
    finishSettledRequest(session);
  } else if (event.type === "auto_retry_start") {
    const suffix = typeof event.attempt === "number" && typeof event.maxAttempts === "number"
      ? " " + String(event.attempt) + "/" + String(event.maxAttempts) + "…"
      : "…";
    session.publishActivity("waiting", "模型请求失败，正在自动重试" + suffix);
  } else if (event.type === "auto_retry_end") {
    if (event.success === true) session.pendingTerminalError = null;
    session.publishActivity(
      "working",
      event.success === true
        ? "自动重试已恢复，正在继续处理…"
        : "自动重试未恢复，正在等待本轮安全结束…",
    );
  } else if (event.type === "compaction_start") {
    session.status = { ...session.status, phase: "compacting" };
    session.publishState();
    session.publishActivity("working", "正在压缩旧上下文，完成后会自动继续…");
    session.publish({ type: "notice", level: "info", text: "上下文接近上限，Pi 正在压缩旧证据摘要。" });
  } else if (event.type === "compaction_end") {
    handleCompactionEnd(session, event);
  }
}

function handleCompactionEnd(session: ShellEventSession, event: RpcEvent): void {
  const result = isRecord(event.result) ? event.result : null;
  const estimatedTokens = result && typeof result.estimatedTokensAfter === "number"
    ? result.estimatedTokensAfter
    : null;
  const succeeded = !!result && event.aborted !== true;
  session.status = {
    ...session.status,
    phase: event.willRetry === true
      ? "diagnose"
      : session.requestState !== "idle" ? "compacting" : "idle",
    contextUsed: estimatedTokens,
    contextPercent: null,
  };
  session.publishState();
  if (event.willRetry === true) {
    session.publishActivity("waiting", "上下文压缩完成，等待 Pi 继续诊断…");
  } else if (session.requestState !== "idle" && succeeded) {
    session.publishActivity("working", "上下文压缩完成，正在等待本轮安全结束…");
  } else if (session.requestState !== "idle") {
    if (event.aborted !== true) session.pendingTerminalError ??= "上下文压缩失败，请缩小问题范围后重试。";
    session.publishActivity("working", "上下文压缩未继续，正在等待本轮安全结束…");
  } else {
    session.publishActivity(
      succeeded ? "done" : "error",
      succeeded ? "上下文压缩完成" : "上下文压缩失败，请缩小问题范围后重试。",
    );
  }
  session.publish({
    type: "notice",
    level: succeeded ? "info" : "warning",
    text: succeeded
      ? "上下文压缩已完成，可以继续操作。"
      : event.aborted === true ? "上下文压缩已取消。" : "上下文压缩失败；请结束本轮并缩小任务范围。",
  });
}

/** 单一事件入口；RPC 字段只在这里解码一次。 */
export function reducePiEvent(session: ShellEventSession, value: ShellCoreEvent): void {
  const event = value as RpcEvent;
  if (handleExtensionEvent(session, event)) return;
  if (handleMessageEvent(session, event)) return;
  handleLifecycleEvent(session, event);
}
