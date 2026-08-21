/**
 * Pi 自然语言请求的 Token 安全线计算。
 *
 * 职责：根据模型窗口、最大输出、当前上下文用量和新输入计算请求前门禁。
 * 非职责：不读取 Pi 会话、不触发 compact、不发送模型请求、不修改 Shell 或任务状态。
 * 输入输出：只接收数字和本轮用户文本，返回低敏估算与 allow/compact 动作。
 * 相邻边界：ShellServer 负责读取真实用量、执行压缩和展示状态；Pi 仍负责最终 overflow 保护。
 * 副作用与权限：纯函数，无文件、网络或进程副作用，不扩大任何工具权限。
 * 隐私：不记录、持久化或返回用户正文，只返回字符计数推导出的 Token 数字。
 * 失败与恢复：Pi 用量未知时返回 allow，由 Pi 原生门禁兜底；非法模型配置由上游档案校验拒绝。
 */

/** 请求进入 Pi 前的低敏 Token 决策结果，不包含用户正文。 */
export interface TokenControlDecision {
  action: "allow" | "compact";
  incomingTokens: number;
  projectedTokens: number | null;
  promptTokenLimit: number;
}

/**
 * 计算同时为输出和 25% 安全余量留出空间的输入上限。
 *
 * @param contextWindow 当前模型声明的上下文窗口。
 * @param maxOutputTokens 当前模型声明的单次最大输出。
 * @returns 本次请求允许占用的最大输入 Token；不会超过上下文窗口的 75%。
 */
export function promptTokenLimit(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(0, Math.min(
    Math.floor(contextWindow * 0.75),
    contextWindow - maxOutputTokens,
  ));
}

/**
 * 对尚未进入会话的用户文本做保守 Token 估算。
 *
 * @param text 已去除首尾空白的自然语言输入。
 * @returns ASCII 按四字符一 Token、非 ASCII 按一字符一 Token 的估算值。
 */
export function estimateInputTokens(text: string): number {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) asciiCharacters += 1;
    else nonAsciiCharacters += 1;
  }
  return Math.ceil(asciiCharacters / 4) + nonAsciiCharacters;
}

/**
 * 判断当前输入是否应在发送前先压缩上下文。
 *
 * @param contextTokens Pi 最近一次报告的上下文用量；未知时传 null。
 * @param contextWindow 当前模型上下文窗口。
 * @param maxOutputTokens 当前模型最大输出。
 * @param inputText 本轮自然语言输入。
 * @returns 只含估算数字和动作的门禁结果；不会返回输入正文。
 */
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
