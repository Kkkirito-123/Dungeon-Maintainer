/**
 * Agent 自然语言请求的 Token 安全线计算。
 *
 * 这是与具体 Agent Runtime 无关的纯策略：Shell 提供当前用量和模型窗口，运行时负责
 * 真正执行 compact。模块不读取会话、不发送模型请求，也不依赖 Pi。
 */

/** 请求进入 Agent 前的低敏 Token 决策结果，不包含用户正文。 */
export interface TokenControlDecision {
  action: "allow" | "compact";
  incomingTokens: number;
  projectedTokens: number | null;
  promptTokenLimit: number;
}

/** 计算同时为输出和 25% 安全余量留出空间的输入上限。 */
export function promptTokenLimit(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(0, Math.min(
    Math.floor(contextWindow * 0.75),
    contextWindow - maxOutputTokens,
  ));
}

/** 对尚未进入会话的用户文本做保守 Token 估算。 */
export function estimateInputTokens(text: string): number {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) asciiCharacters += 1;
    else nonAsciiCharacters += 1;
  }
  return Math.ceil(asciiCharacters / 4) + nonAsciiCharacters;
}

/** 判断当前输入是否应在发送前先压缩上下文。 */
export function decideTokenControl(
  contextTokens: number | null,
  contextWindow: number,
  maxOutputTokens: number,
  inputText: string,
): TokenControlDecision {
  const incomingTokens = estimateInputTokens(inputText);
  const limit = promptTokenLimit(contextWindow, maxOutputTokens);
  const projectedTokens = contextTokens === null ? null : contextTokens + incomingTokens;
  return {
    action: projectedTokens !== null && projectedTokens > limit ? "compact" : "allow",
    incomingTokens,
    projectedTokens,
    promptTokenLimit: limit,
  };
}
