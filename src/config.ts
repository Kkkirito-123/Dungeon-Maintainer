/**
 * Dungeon Maintainer 运行配置入口。
 *
 * 本模块只读取维护器自己的 MAINTAINER_* 环境变量和项目根目录 .env，不读取目标
 * 游戏仓库中的配置。它负责为启动器和 Pi Extension 提供一致的数据目录、模型端点
 * 与资源上限；不会启动模型、浏览器、Vite 或 Git，也不会把 API Key 写入任务文件。
 *
 * 重要失败模式：API 地址非法时立即拒绝启动；API Key 缺失允许读取任务状态，但在
 * 真正启动 Pi 前会明确报错。所有导出的路径都是绝对路径，避免子进程 cwd 改变后
 * 将任务数据误写进游戏 worktree。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 维护器进程使用的稳定配置。 */
export interface MaintainerConfig {
  /** 只注入 Pi 子进程环境，不进入命令行、日志或任务 JSON。 */
  apiKey: string | null;
  /** OpenAI 兼容接口根地址，不包含 chat/completions 后缀。 */
  baseUrl: string;
  /** 没有活动模型档案时使用的默认模型标识。 */
  model: string;
  /** 注册给 Pi Provider 的上下文窗口大小。 */
  contextWindow: number;
  /** 注册给 Pi Provider 的单次最大输出 Token。 */
  maxOutputTokens: number;
  /** 默认模型档案是否支持 Pi Thinking 等级。 */
  reasoning: boolean;
  /** 任务、Pi 会话、检查日志和 worktree 的统一父目录。 */
  dataDir: string;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (/^(?:1|true|yes|on)$/iu.test(value.trim())) return true;
  if (/^(?:0|false|no|off)$/iu.test(value.trim())) return false;
  return fallback;
}

/**
 * 解析维护器自己的 .env 文本。
 *
 * @param text UTF-8 配置文本。
 * @returns 只包含 MAINTAINER_* 项的键值对象。
 */
export function parseMaintainerEnv(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u);
    if (!match?.[1]?.startsWith("MAINTAINER_")) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[match[1]] = value;
  }
  return output;
}

/**
 * 定位维护器项目根目录的 .env。
 *
 * @param modulePath 当前模块绝对路径；测试可传入虚拟路径。
 * @returns 维护器根目录中的 .env 绝对路径。
 */
export function maintainerEnvPath(
  modulePath = fileURLToPath(import.meta.url),
): string {
  const sourceRoot = resolve(dirname(modulePath), "..");
  const projectRoot = basename(sourceRoot) === "dist"
    ? dirname(sourceRoot)
    : sourceRoot;
  return resolve(projectRoot, ".env");
}

function mergedEnvironment(): NodeJS.ProcessEnv {
  let fileEnvironment: Record<string, string> = {};
  try {
    fileEnvironment = parseMaintainerEnv(
      readFileSync(maintainerEnvPath(), "utf8"),
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return { ...fileEnvironment, ...process.env };
}

/**
 * 规范化 OpenAI 兼容接口地址。
 *
 * @param value 根地址或包含 chat/completions 的完整地址。
 * @returns 无末尾斜杠、无 chat/completions 后缀的 HTTP(S) 地址。
 * @throws 地址协议不是 HTTP(S) 时拒绝。
 */
export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MAINTAINER_BASE_URL 只允许 HTTP(S) 地址");
  }
  const suffix = "/chat/completions";
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith(suffix)
    ? pathname.slice(0, -suffix.length)
    : pathname;
  return url.toString().replace(/\/$/u, "");
}

/**
 * 读取完整维护器配置。
 *
 * @param environment 可注入的隔离环境；默认合并维护器 .env 与当前进程环境。
 * @returns 规范化后的不可变运行配置。
 */
export function loadConfig(
  environment: NodeJS.ProcessEnv = mergedEnvironment(),
): MaintainerConfig {
  const localData = environment.LOCALAPPDATA?.trim()
    || resolve(homedir(), ".local", "share");
  const baseUrl = normalizeBaseUrl(
    environment.MAINTAINER_BASE_URL?.trim()
    || "https://api.deepseek.com/v1",
  );
  return {
    apiKey: environment.MAINTAINER_API_KEY?.trim() || null,
    baseUrl,
    model: environment.MAINTAINER_MODEL?.trim() || "deepseek-chat",
    contextWindow: boundedInteger(
      environment.MAINTAINER_CONTEXT_WINDOW,
      64_000,
      8_000,
      2_000_000,
    ),
    maxOutputTokens: boundedInteger(
      environment.MAINTAINER_MAX_TOKENS,
      4_096,
      256,
      64_000,
    ),
    reasoning: booleanValue(
      environment.MAINTAINER_REASONING,
      /deepseek/iu.test(baseUrl),
    ),
    dataDir: resolve(localData, "dungeon-maintainer"),
  };
}

/**
 * 在启动 Pi 前取得模型密钥。
 *
 * @param config 已加载的维护器配置。
 * @returns 非空 API Key。
 * @throws 未配置密钥时抛出可识别的环境错误。
 */
export function requireApiKey(config: MaintainerConfig): string {
  if (!config.apiKey) {
    throw new Error("BLOCKED_ENV: MAINTAINER_API_KEY 未配置");
  }
  return config.apiKey;
}
