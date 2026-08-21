/**
 * Pi Provider 请求前的工具结果整形。
 *
 * 本模块只在即将发送给模型的临时消息副本上执行去重和字符预算，不改 Pi JSONL、
 * 任务证据或工具原始结果。每个用户回合独立计数，并从最新结果向前保留，避免早期
 * 大输出耗尽预算后把真正用于收尾的游戏、源码和检查证据全部替换为省略标记。
 */

/** 整形函数需要的最小消息形状。 */
export interface ShapeableMessage {
  role?: string;
  toolCallId?: string;
  toolName?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/** 不含正文的整形统计，可用于测试和低敏运行状态。 */
export interface ContextShapeStats {
  truncatedResults: number;
  omittedResults: number;
  duplicateResults: number;
  sentCharacters: number;
}

/** 工具结果预算。 */
export interface ContextShapeLimits {
  perResultCharacters: number;
  perTurnCharacters: number;
  /** 最多保留最近几轮用户请求；旧轮次由任务事实和持久化证据替代。 */
  maxRetainedUserTurns?: number;
}

const DEFAULT_LIMITS: ContextShapeLimits = {
  // 保留足够的首尾源码证据，同时避免旧读取结果挤占执行阶段预算。
  perResultCharacters: 2_048,
  // 为最多 32 个短省略标记预留空间，总量控制在 20 KiB 左右。
  perTurnCharacters: 16_384,
  maxRetainedUserTurns: 3,
};

function boundedToolResult(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n...[工具结果已按 Token 预算截断]...\n";
  if (limit <= marker.length) return marker.slice(0, limit);
  const remaining = limit - marker.length;
  const headLength = Math.ceil(remaining * 0.75);
  return text.slice(0, headLength)
    + marker
    + text.slice(-(remaining - headLength));
}

function textContent(message: ShapeableMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * 按用户回合从后向前保留最新工具证据。
 *
 * @param inputMessages Pi 即将发送给 Provider 的消息。
 * @param limits 单结果和单用户回合字符上限。
 * @returns 新消息数组与不含正文的计数；输入对象不会被修改。
 */
export function shapeModelContext<T extends ShapeableMessage>(
  inputMessages: readonly T[],
  limits: ContextShapeLimits = DEFAULT_LIMITS,
): { messages: T[]; stats: ContextShapeStats } {
  let messages = [...inputMessages];
  const retainedUserTurns = Math.max(1, limits.maxRetainedUserTurns ?? 3);
  let userTurns = 0;
  let cutoff = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    userTurns += 1;
    if (userTurns > retainedUserTurns) {
      cutoff = index + 1;
      break;
    }
  }
  if (cutoff > 0) messages = messages.slice(cutoff);
  const stats: ContextShapeStats = {
    truncatedResults: 0,
    omittedResults: 0,
    duplicateResults: 0,
    sentCharacters: 0,
  };
  let remaining = limits.perTurnCharacters;
  let seen = new Map<string, string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") {
      remaining = limits.perTurnCharacters;
      seen = new Map<string, string>();
      continue;
    }
    if (message.role !== "toolResult") continue;
    const text = textContent(message);
    const signature = (message.toolName ?? "tool") + "\0" + text;
    const newerCallId = seen.get(signature);
    let bounded = text;
    if (text.length >= 256 && !newerCallId) {
      seen.set(signature, message.toolCallId ?? "newer");
    } else if (newerCallId) {
      bounded = "[重复工具结果已省略；与较新调用 " + newerCallId + " 完全相同]";
      stats.duplicateResults += 1;
    }

    if (remaining <= 0) {
      bounded = "[较早工具结果已省略]";
      stats.omittedResults += 1;
    } else {
      const limit = Math.min(limits.perResultCharacters, remaining);
      const next = boundedToolResult(bounded, limit);
      if (next !== bounded) stats.truncatedResults += 1;
      bounded = next;
      remaining -= bounded.length;
    }
    stats.sentCharacters += bounded.length;
    if (bounded === text) continue;
    messages[index] = {
      ...message,
      content: [{ type: "text", text: bounded }],
    };
  }
  return { messages, stats };
}
