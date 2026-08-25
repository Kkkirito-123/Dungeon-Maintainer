/**
 * Pi Provider 请求前的工具结果整形。
 *
 * 本模块先对每条过长 toolResult 做稳定首尾截断，再按总预算把较旧结果替换为
 * 内容 Hash 回执。相同输入始终得到相同字节；最新证据优先保留，原始 session 和
 * Evidence Store 不会被修改。
 */

import { createHash } from "node:crypto";

/** 整形函数需要的最小消息形状。 */
export interface ShapeableMessage {
  role?: string;
  customType?: string;
  toolCallId?: string;
  toolName?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/** 不含正文的整形统计，可用于测试和低敏运行状态。 */
export interface ContextShapeStats {
  truncatedResults: number;
  omittedResults: number;
  sentCharacters: number;
}

/** 工具结果预算。 */
export interface ContextShapeLimits {
  perResultCharacters: number;
  perTurnCharacters: number;
}

const DEFAULT_LIMITS: ContextShapeLimits = {
  // 保留足够的首尾源码证据，同时避免旧读取结果挤占执行阶段预算。
  perResultCharacters: 2_048,
  // 为最多 32 个短省略标记预留空间，总量控制在 20 KiB 左右。
  perTurnCharacters: 16_384,
};

function textContent(message: ShapeableMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * 确定性截断过长工具结果并统计发送字符数。
 *
 * @param inputMessages Pi 即将发送给 Provider 的消息。
 * @param limits 单结果和单用户回合字符上限。
 * @returns 新消息数组与不含正文的计数；输入对象不会被修改。
 */
export function shapeModelContext<T extends ShapeableMessage>(
  inputMessages: readonly T[],
  limits: ContextShapeLimits = DEFAULT_LIMITS,
): { messages: T[]; stats: ContextShapeStats } {
  const perResultCharacters = Math.max(256, limits.perResultCharacters);
  const perTurnCharacters = Math.max(1_024, limits.perTurnCharacters);
  const stats: ContextShapeStats = {
    truncatedResults: 0,
    omittedResults: 0,
    sentCharacters: 0,
  };
  const messages = inputMessages.map((message) => {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) {
      return message;
    }
    const fullText = textContent(message);
    if (fullText.length <= perResultCharacters) {
    return message;
    }
    const marker = "\n…[工具结果稳定截断；原始字符=" + String(fullText.length) + "]…\n";
    const available = Math.max(0, perResultCharacters - marker.length);
    const headLength = Math.ceil(available * 0.65);
    const tailLength = available - headLength;
    const replacement = fullText.slice(0, headLength)
      + marker
      + (tailLength > 0 ? fullText.slice(-tailLength) : "");
    stats.truncatedResults += 1;
    return {
      ...message,
      content: [{ type: "text", text: replacement }],
    };
  });

  const toolResults = messages.map((message, index) => {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) return null;
    const fullText = textContent(message);
    const evidence = /\b(?:evidence|id)=([a-z0-9_-]{4,})/iu.exec(fullText)?.[1] ?? null;
    const digest = createHash("sha256").update(fullText).digest("hex").slice(0, 12);
    const receipt = [
      "[TOOL_RESULT_RECEIPT",
      "tool=" + (message.toolName ?? "unknown"),
      "hash=" + digest,
      "chars=" + String(fullText.length),
      evidence ? "evidence=" + evidence : null,
      "]",
    ].filter((part): part is string => part !== null).join(" ");
    return { index, fullText, receipt };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const receiptCharacters = toolResults.reduce((sum, entry) => sum + entry.receipt.length, 0);
  let expansionBudget = Math.max(0, perTurnCharacters - receiptCharacters);
  const expanded = new Set<number>();
  for (const entry of [...toolResults].reverse()) {
    const extra = Math.max(0, entry.fullText.length - entry.receipt.length);
    if (extra > expansionBudget) continue;
    expanded.add(entry.index);
    expansionBudget -= extra;
  }
  for (const entry of toolResults) {
    if (expanded.has(entry.index)) {
      stats.sentCharacters += entry.fullText.length;
      continue;
    }
    stats.omittedResults += 1;
    stats.sentCharacters += entry.receipt.length;
    const message = messages[entry.index];
    if (!message) continue;
    messages[entry.index] = {
      ...message,
      content: [{ type: "text", text: entry.receipt }],
    };
  }
  return { messages, stats };
}
