/**
 * 原版 Pi Eval 的最小模型 Provider 适配器。
 *
 * 本 Extension 只把父进程给定的 OpenAI-compatible endpoint 注册为一个固定 Provider，
 * 不修改系统 Prompt、不注册工具或命令、不监听会话生命周期，也不实现任何 Token、循环、
 * 证据或任务编排优化。这样可在相同模型配置下测量 Pi 原生 `read/bash/edit/write` 行为。
 *
 * API Key 只通过环境变量引用交给 Pi Provider，不写入参数、会话附加信息或 Eval
 * 报告。缺少父进程固定环境时会在模型请求前明确失败。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 原版 Pi 基线使用的固定 Provider ID。 */
export const PI_BASELINE_PROVIDER_ID = "dungeon-eval-baseline";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("原版 Pi Eval 缺少 " + name);
  return value;
}

function boundedEnvironmentInteger(
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("原版 Pi Eval 的 " + name + " 超出允许范围");
  }
  return value;
}

/**
 * 注册原版 Pi 基线所需的唯一模型 Provider。
 *
 * @param pi 当前 Pi Extension API。
 * @returns 无返回值；除 Provider 注册表外不改变会话状态。
 * @throws endpoint、模型或数值环境缺失时拒绝启动，密钥正文不会进入错误消息。
 */
export default function registerPiBaselineProvider(
  pi: ExtensionAPI,
): void {
  const model = requiredEnvironment("DUNGEON_EVAL_MODEL");
  pi.registerProvider(PI_BASELINE_PROVIDER_ID, {
    name: "Pi Baseline Eval",
    baseUrl: requiredEnvironment("DUNGEON_EVAL_BASE_URL"),
    apiKey: "$DUNGEON_EVAL_API_KEY",
    api: "openai-completions",
    models: [{
      id: model,
      name: model,
      reasoning: process.env.DUNGEON_EVAL_REASONING === "1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: boundedEnvironmentInteger(
        "DUNGEON_EVAL_CONTEXT_WINDOW",
        8_000,
        2_000_000,
      ),
      maxTokens: boundedEnvironmentInteger(
        "DUNGEON_EVAL_MAX_TOKENS",
        256,
        64_000,
      ),
    }],
  });
}
