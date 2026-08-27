/**
 * Pi Provider 请求前的工具结果整形。
 *
 * 本模块先把带工具调用的历史 assistant 长篇说明替换为稳定回执，再对过长 toolResult
 * 做首尾截断，并把历史工具批次固定替换为低敏索引回执。上下文只保留最新 finish
 * 控制结果、最近源码证据和尾部刚产生的工具批次正文，避免方案获批后因一次定向回读丢失执行状态。
 * 其它旧消息从下一轮起不再反复改写，Provider 可以持续命中 Prompt 前缀缓存；原始
 * session 和 Evidence Store 不会被修改，需要回看正文时由 evidence(get) 明确取回。
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
  omittedCharacters: number;
  assistantTextOmittedCharacters: number;
  toolResultOmittedCharacters: number;
}

/** 工具结果预算。 */
export interface ContextShapeLimits {
  perResultCharacters: number;
  perTurnCharacters: number;
  /** 带工具调用的历史 assistant 文本达到该长度后替换为稳定回执。 */
  assistantTextCharacters?: number;
}

const DEFAULT_LIMITS: ContextShapeLimits = {
  // 最新工具结果允许保留完整 Inspect 的 4 KiB 输出；更早结果仍只保留回执。
  perResultCharacters: 4_096,
  // 不论历史工具结果数量，发送的 toolResult 正文与回执合计都不超过 16 KiB。
  perTurnCharacters: 16_384,
  // 工具调用本身和短说明保留；长篇过程分析从下一次 Provider 请求起折叠。
  assistantTextCharacters: 512,
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
  const assistantTextCharacters = Math.max(
    256,
    limits.assistantTextCharacters ?? DEFAULT_LIMITS.assistantTextCharacters ?? 512,
  );
  const stats: ContextShapeStats = {
    truncatedResults: 0,
    omittedResults: 0,
    sentCharacters: 0,
    omittedCharacters: 0,
    assistantTextOmittedCharacters: 0,
    toolResultOmittedCharacters: 0,
  };
  const messages = inputMessages.map((message) => {
    if (
      message.role === "assistant"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "toolCall")
    ) {
      const fullText = textContent(message);
      if (fullText.length > assistantTextCharacters) {
        const digest = createHash("sha256").update(fullText).digest("hex").slice(0, 12);
        const receipt = "[ASSISTANT_TEXT_RECEIPT hash=" + digest
          + " chars=" + String(fullText.length)
          + "；工具调用已保留]";
        let receiptPlaced = false;
        const content = message.content.flatMap((block) => {
          if (block.type !== "text") return [block];
          if (receiptPlaced) return [];
          receiptPlaced = true;
          return [{ ...block, text: receipt }];
        });
        return { ...message, content };
      }
    }
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
    const originalText = textContent(inputMessages[index] ?? message);
    const evidence = /\b(?:evidence|id)=([a-z0-9_-]{4,})/iu.exec(originalText)?.[1] ?? null;
    // 回执只保留后续 evidence(get) 所需的低敏索引。去掉正文长度和完整 Hash，
    // 为最近的 finish 契约及源码证据留出稳定预算；原始正文仍保存在 session/ledger。
    const receipt = [
      "[TOOL_RESULT_RECEIPT",
      "tool=" + (message.toolName ?? "unknown"),
      evidence ? "evidence=" + evidence : null,
      "]",
    ].filter((part): part is string => part !== null).join(" ");
    return { index, fullText, receipt };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  let currentBatchStart = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "toolResult") {
      currentBatchStart = index;
      continue;
    }
    break;
  }
  const currentBatch = toolResults.filter((entry) => entry.index >= currentBatchStart);
  const reservedReceiptCharacters = toolResults.length > 0
    ? Math.min(
        perTurnCharacters,
        Math.max(...toolResults.map((entry) => entry.receipt.length)),
      )
    : 0;
  let remainingCharacters = perTurnCharacters - reservedReceiptCharacters;
  const expanded = new Set<number>();
  // finish 承载方案是否获批、allowedPaths 和下一步动作。只固定最近一条，既让后续
  // 定向源码回读仍能看到执行契约，也避免保留一串历史控制结果破坏总预算。
  const latestFinish = [...toolResults].reverse().find((entry) => (
    messages[entry.index]?.toolName === "finish"
  ));
  const latestSource = [...toolResults].reverse().find((entry) => {
    const toolName = messages[entry.index]?.toolName;
    if (toolName !== "inspect" && toolName !== "evidence") return false;
    // search/bundle/read_many 的真实源码正文都会带 EVIDENCE；CACHE/READ 回执则不应
    // 被当成可用于 patch 的正文。
    return /(?:\[EVIDENCE id=|\[source\/active\])/u.test(entry.fullText)
      && !/^\[CACHE HIT/u.test(entry.fullText);
  });
  const expansionCandidates = [
    ...(latestFinish ? [latestFinish] : []),
    ...(latestSource && latestSource.index !== latestFinish?.index ? [latestSource] : []),
    ...[...currentBatch].reverse().filter((entry) => (
      entry.index !== latestFinish?.index && entry.index !== latestSource?.index
    )),
  ];
  for (const entry of expansionCandidates) {
    if (expanded.has(entry.index) || entry.fullText.length > remainingCharacters) continue;
    expanded.add(entry.index);
    remainingCharacters -= entry.fullText.length;
  }
  // 从最新结果向前保留可回读索引。极长会话中即使所有短回执之和
  // 也超出预算，更早的 toolResult 仍保留配对消息，但文本置空。
  const receiptTexts = new Map<number, string>();
  const oldestOmitted = toolResults.find((entry) => !expanded.has(entry.index));
  if (oldestOmitted) {
    receiptTexts.set(oldestOmitted.index, oldestOmitted.receipt);
    remainingCharacters += reservedReceiptCharacters - oldestOmitted.receipt.length;
  } else {
    remainingCharacters += reservedReceiptCharacters;
  }
  for (const entry of [...toolResults].reverse()) {
    if (expanded.has(entry.index) || receiptTexts.has(entry.index)) continue;
    const receipt = entry.receipt.length <= remainingCharacters ? entry.receipt : "";
    receiptTexts.set(entry.index, receipt);
    remainingCharacters -= receipt.length;
  }
  for (const entry of toolResults) {
    if (expanded.has(entry.index)) {
      stats.sentCharacters += entry.fullText.length;
      continue;
    }
    const receipt = receiptTexts.get(entry.index) ?? "";
    stats.omittedResults += 1;
    stats.sentCharacters += receipt.length;
    const message = messages[entry.index];
    if (!message) continue;
    messages[entry.index] = {
      ...message,
      content: [{ type: "text", text: receipt }],
    };
  }
  for (let index = 0; index < messages.length; index += 1) {
    const before = inputMessages[index];
    const after = messages[index];
    if (!before || !after) continue;
    const omitted = Math.max(0, textContent(before).length - textContent(after).length);
    stats.omittedCharacters += omitted;
    if (before.role === "assistant") {
      stats.assistantTextOmittedCharacters += omitted;
    } else if (before.role === "toolResult") {
      stats.toolResultOmittedCharacters += omitted;
    }
  }
  return { messages, stats };
}
