/** @deprecated 从中立 Agent 策略层导入；保留门面避免已有调用方突然失效。 */
export {
  decideTokenControl,
  estimateInputTokens,
  promptTokenLimit,
  type TokenControlDecision,
} from "../agent/token-control.js";
