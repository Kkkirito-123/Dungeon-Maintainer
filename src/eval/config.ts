/**
 * Eval 专用模型配置。
 *
 * 职责：在维护器现有配置上选择 Eval 模型并关闭推理，供被测 Agent 与 Pi 基线
 * 共用同一 Provider。非职责：不新增密钥来源、不切换生产维护器模型，也不持久化配置。
 * 输入来自维护器进程环境或项目 `.env`，输出仍是 `MaintainerConfig`；相邻 Profile 和运行
 * 身份模块只消费该结果。读取配置是唯一副作用，不启动模型。API Key 只保留在
 * 内存并由调用方注入请求；配置非法时沿用 `loadConfig` 的失败，修正环境后可直接重试。
 */

import {
  loadConfig,
  type MaintainerConfig,
} from "../config.js";

/** Eval 中被测 Agent 共同使用的默认 Flash 模型。 */
export const EVAL_MODEL_ID = "deepseek-v4-flash";

/**
 * 读取 Eval 配置并选择显式模型或默认 Flash，同时关闭推理。
 *
 * @param environment 可选隔离环境；省略时读取维护器当前环境与 `.env`。
 * @returns 与生产 Provider 同 Key、同 Base URL，模型由 DUNGEON_EVAL_MODEL 或默认 Flash 决定。
 * @throws Base URL 等基础配置非法时沿用 `loadConfig` 错误；本函数不验证或输出 API Key。
 * @remarks 调用前不需要网络权限；真正的 Provider 调用只由 Profile 发起。
 */
export function loadEvalConfig(
  environment?: NodeJS.ProcessEnv,
): MaintainerConfig {
  const config = environment === undefined
    ? loadConfig()
    : loadConfig(environment);
  const model = (environment ?? process.env).DUNGEON_EVAL_MODEL?.trim()
    || EVAL_MODEL_ID;
  return {
    ...config,
    model,
    reasoning: false,
  };
}
