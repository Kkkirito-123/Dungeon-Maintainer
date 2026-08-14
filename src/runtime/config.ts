/**
 * 运行配置入口。
 *
 * 本模块只从当前进程环境读取维护器自己的模型参数，并计算统一数据目录；它不会
 * 搜索目标仓库、加载 `.env`，也不会把密钥写入任务文件。配置缺失会在真正调用
 * 模型前明确失败，纯状态查询、补丁应用与回滚不依赖模型凭据。
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/** 维护器的模型、持久化目录和资源上限。 */
export interface RuntimeConfig {
  /** 仅存在于当前 Node 进程内的模型密钥。 */
  apiKey: string | null;
  /** OpenAI 兼容 API 的根地址，不包含 `/chat/completions`。 */
  baseUrl: string;
  /** 供应商实际接受的模型标识。 */
  model: string;
  /** 模型上下文窗口，用于触发压缩和硬上限。 */
  contextWindow: number;
  /** 单次模型响应上限；工具结果不计入该值。 */
  maxOutputTokens: number;
  /** 单次供应商请求超时毫秒数。 */
  timeoutMs: number;
  /** 任务、日志、补丁和临时 worktree 的统一父目录。 */
  dataDir: string;
  /** 单任务允许的最大模型回合数。 */
  maxTurns: number;
  /** 单任务允许的最大工具调用数。 */
  maxToolCalls: number;
  /** 单任务允许的累计 token 数。 */
  maxTokens: number;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * 规范化 OpenAI 兼容地址。
 *
 * @param value 用户提供的根地址或完整 chat-completions 地址。
 * @returns 不带末尾斜杠和 `/chat/completions` 的 API 根地址。
 * @throws 当地址不是 HTTP(S) URL 时抛出错误。
 */
export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MAINTAINER_BASE_URL 只允许 HTTP(S) 地址");
  }
  const suffix = "/chat/completions";
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : pathname;
  return url.toString().replace(/\/$/, "");
}

/**
 * 读取维护器配置。
 *
 * @param env 可注入的环境变量，测试可传入隔离对象。
 * @returns 完整且带默认资源限制的配置。
 * @throws 当 API 根地址非法时抛出错误；密钥缺失不会在此处抛错。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const local = env.LOCALAPPDATA?.trim() || resolve(homedir(), ".local", "share");
  return {
    apiKey: env.MAINTAINER_API_KEY?.trim() || null,
    baseUrl: normalizeBaseUrl(env.MAINTAINER_BASE_URL?.trim() || "https://api.deepseek.com/v1"),
    model: env.MAINTAINER_MODEL?.trim() || "deepseek-chat",
    contextWindow: boundedInt(env.MAINTAINER_CONTEXT_WINDOW, 64_000, 8_000, 2_000_000),
    maxOutputTokens: boundedInt(env.MAINTAINER_MAX_TOKENS, 4_096, 256, 64_000),
    timeoutMs: boundedInt(env.MAINTAINER_TIMEOUT_MS, 60_000, 1_000, 600_000),
    dataDir: resolve(local, "dungeon-maintainer"),
    maxTurns: 20,
    maxToolCalls: 40,
    maxTokens: 64_000,
  };
}

/**
 * 在模型调用前验证凭据。
 *
 * @param config 已加载的运行配置。
 * @returns 非空 API Key；调用方不得记录或持久化该值。
 * @throws 当 `MAINTAINER_API_KEY` 未配置时抛出可识别的环境错误。
 */
export function requireApiKey(config: RuntimeConfig): string {
  if (!config.apiKey) throw new Error("BLOCKED_ENV: MAINTAINER_API_KEY 未配置");
  return config.apiKey;
}
