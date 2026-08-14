/**
 * Pi AI 模型装配边界。
 *
 * 本模块把独立 `MAINTAINER_*` 配置转换成一个 OpenAI 兼容 Pi Provider。它只暴露
 * `Model` 与流函数，不导出密钥、不读取目标游戏仓库，也不复用游戏线上 Agent 的
 * `MAIN_*` 配置。API Key 保存在认证闭包中，每次请求由 Pi 解析；供应商错误通过
 * Pi 事件返回，不能改变任务审批或文件权限。
 */

import {
  createModels, createProvider, type Api, type Context, type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { RuntimeConfig } from "./config.js";
import { requireApiKey } from "./config.js";

/** 可注入 Agent 的模型和流式调用函数，测试可替换为 Pi Faux Provider。 */
export interface RuntimeModel {
  model: Model<Api>;
  stream: StreamFn;
}

/**
 * 创建维护器专属 Pi Provider。
 * @param config 已加载且仅存在于当前进程的维护器配置。
 * @returns 静态模型定义和带超时、输出上限的流函数。
 * @throws `MAINTAINER_API_KEY` 缺失时返回可识别的 BLOCKED_ENV 错误。
 */
export function createRuntimeModel(config: RuntimeConfig): RuntimeModel {
  const apiKey = requireApiKey(config);
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "dungeon-maintainer",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxOutputTokens,
  };
  const provider = createProvider({
    id: "dungeon-maintainer",
    name: "Dungeon Maintainer",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "Dungeon Maintainer API Key",
        resolve: ({ signal }) => {
          signal.throwIfAborted();
          return Promise.resolve({ auth: { apiKey }, source: "MAINTAINER_API_KEY" });
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const stream = (requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => (
    models.streamSimple(requestModel, context, {
      ...options,
      maxTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      maxRetries: 0,
      cacheRetention: "short",
    })
  );
  return { model, stream };
}
