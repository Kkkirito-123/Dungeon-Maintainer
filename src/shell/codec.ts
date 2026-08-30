/**
 * Shell 边界编解码。
 *
 * 这里集中处理 HTTP JSON、低敏文本和 Pi RPC 事件的解析。路由状态机只依赖这些
 * 小函数，不需要同时理解 HTTP 细节和模型事件字段。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

type JsonRecord = Record<string, unknown>;

const MAX_BODY_BYTES = 64 * 1024;

/** 判断未知值是否为 JSON 对象。 */
export function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 读取字符串字段，类型不符时返回空值。 */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 提取 Pi 当前模型的低敏摘要。 */
export function modelSummary(value: unknown): {
  provider: string;
  id: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
} | null {
  if (!isRecord(value)) return null;
  const provider = stringValue(value.provider);
  const id = stringValue(value.id);
  if (!provider || !id) return null;
  return {
    provider,
    id,
    contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : null,
    maxOutputTokens: typeof value.maxTokens === "number" ? value.maxTokens : null,
  };
}

/** 提取上下文压缩后的 Token 估算。 */
export function compactionEstimate(value: unknown): number | null {
  if (!isRecord(value)) return null;
  return typeof value.estimatedTokensAfter === "number"
    && Number.isFinite(value.estimatedTokensAfter)
    && value.estimatedTokensAfter >= 0
    ? Math.floor(value.estimatedTokensAfter)
    : null;
}

/** 删除凭据模式并限制可展示文本长度。 */
export function sanitizeText(text: string): string {
  return text
    .replaceAll(/(?:api[_ -]?key|authorization|bearer)\s*[:=]\s*\S+/giu, "[已隐藏]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]+\b/gu, "[已隐藏]")
    .slice(0, 8_000);
}

/** 读取并限制一个 HTTP JSON 请求体。 */
export function jsonBody(request: IncomingMessage): Promise<JsonRecord> {
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

/** 以禁止缓存的 JSON 响应结束请求。 */
export function writeJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

/** 以禁止缓存的 HTML 文本响应结束请求。 */
export function writeText(response: ServerResponse, value: string, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(value);
}

/** 过滤出带类型字段的 Pi RPC 事件。 */
export function parseRpcEvent(value: unknown): JsonRecord | null {
  return isRecord(value) && typeof value.type === "string" ? value : null;
}

/** 提取 assistant 文本增量事件。 */
export function textFromAssistantEvent(value: JsonRecord): string | null {
  const event = isRecord(value.assistantMessageEvent)
    ? value.assistantMessageEvent
    : null;
  if (!event || event.type !== "text_delta") return null;
  return stringValue(event.delta);
}

/** 提取 assistant 完整消息中的可展示文本。 */
export function textFromMessage(value: JsonRecord): string | null {
  const message = isRecord(value.message) ? value.message : null;
  // 只允许 assistant 文本进入 Shell，避免把工具完整结果误当回答展示。
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const chunks = message.content
    .filter(isRecord)
    .map((block) => block.type === "text" ? stringValue(block.text) : null)
    .filter((text): text is string => !!text);
  return chunks.length > 0 ? chunks.join("") : null;
}

/** 判断 assistant 消息是否结束当前模型回合。 */
export function isTerminalAssistantMessage(value: JsonRecord): boolean {
  const message = isRecord(value.message) ? value.message : null;
  return !!message
    && message.role === "assistant"
    && message.stopReason !== "toolUse";
}

/** 读取 assistant 消息的停止原因。 */
export function assistantStopReason(value: JsonRecord): string | null {
  const message = isRecord(value.message) ? value.message : null;
  return message?.role === "assistant" ? stringValue(message.stopReason) : null;
}

/** 判断事件是否为 thinking 增量。 */
export function isThinkingDelta(value: JsonRecord): boolean {
  const event = isRecord(value.assistantMessageEvent)
    ? value.assistantMessageEvent
    : null;
  return event?.type === "thinking_delta";
}

/** 将上游模型错误转换为可操作的低敏提示。 */
/** 将模型错误归类为可操作的低敏提示。 */
export function visibleModelError(value: JsonRecord): string | null {
  const message = isRecord(value.message) ? value.message : null;
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return null;
  const raw = stringValue(message.errorMessage) ?? "";
  if (/\b402\b|insufficient balance/iu.test(raw)) {
    return "模型服务余额不足（HTTP 402），本次消息没有执行。请补充余额或切换可用服务后重试。";
  }
  if (/\b401\b|unauthori[sz]ed|invalid api key/iu.test(raw)) {
    return "模型鉴权失败（HTTP 401），本次消息没有执行。请检查 MAINTAINER_API_KEY 后重试。";
  }
  if (/\b429\b|rate limit|too many requests/iu.test(raw)) {
    return "模型服务触发限流（HTTP 429），本次消息没有执行。请稍后重试。";
  }
  return "模型请求失败，本次消息没有执行。请检查模型服务状态后重试。";
}
