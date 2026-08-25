/**
 * 原版 Pi Coding Agent 的一次性 Benchmark 运行器。
 *
 * 本模块在调用方已经物化的临时 Git 仓库中启动固定版本 Pi RPC，只启用原生
 * `read/bash/edit/write`，保留项目 AGENTS/skills，禁用用户全局 Extension 和 Prompt
 * 模板。唯一显式 Extension 只注册同模型 Provider，不介入 Prompt、工具或生命周期。
 *
 * 运行器只返回数值、布尔值和稳定失败码；模型正文、工具参数、命令输出、API Key 与
 * session JSONL 都留在调用方临时目录，随后由上层统一回收。超时会先 RPC abort，再关闭
 * stdin；任何后台 Pi 都不能跨案例继续消耗 Token。
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireApiKey } from "../config.js";
import { resolvePiCliPath } from "../app/pi-process.js";
import { PiRpcProcess } from "../pi/rpc-process.js";
import { PI_ORIGINAL_PROVIDER_ID } from "./pi-original-extension.js";
import { requestWithDeadline, SESSION_STATS_TIMEOUT_MS } from "./rpc-timeout.js";
import { assertFlashBenchmarkModel } from "./model-policy.js";
import type { TaskState } from "../task/types.js";

/** 所有真实 Pi Profile 共享的低敏运行指标。 */
export interface PiRunMetrics {
  readonly status: "settled" | "timeout" | "infra_error";
  readonly durationMs: number;
  readonly diagnosisMs: number | null;
  readonly turns: number;
  readonly toolCalls: number;
  readonly diagnosticToolCalls: number;
  readonly readCalls: number;
  readonly writeCalls: number;
  readonly consecutiveDuplicateToolCalls: number;
  /** Pi 内部 steering/follow-up 消息队列峰值。 */
  readonly piMessageQueuePeak: number;
  /** 外层 Episode 任务队列峰值；原版没有该队列。 */
  readonly taskQueuePeak: number;
  /** 当前请求产生的 Episode 数。 */
  readonly episodes: number;
  /** 当前请求产生的 recover Episode 数。 */
  readonly recoveries: number;
  /** inspect 工具调用数；原版工具面没有 inspect。 */
  readonly inspectCalls: number;
  /** inspect 中真正执行文件系统或 rg 的次数。 */
  readonly inspectExecutions: number;
  /** inspect 因相同有效版本只返回短回执的次数。 */
  readonly inspectReceiptHits: number;
  /** 区域搜索从主区域扩展到相邻区域或仓库的次数。 */
  readonly routedSearchExpansions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly contextTokens: number | null;
  readonly contextPercent: number | null;
  readonly failureCode: string | null;
}

/** Profile 自身能证明的工作流闭环；原版没有 Maintainer 结构化状态。 */
export interface PiWorkflowClosure {
  readonly applicable: boolean;
  readonly taskState: TaskState | null;
  readonly proposed: boolean | null;
  readonly executed: boolean | null;
  /** 是否至少尝试过模型写入；与最终是否保留变更分开。 */
  readonly writeAttempted: boolean | null;
  /** Agent 结束时 worktree 是否仍保留实际代码变化。 */
  readonly retainedChanges: boolean | null;
  readonly verified: boolean | null;
  readonly readyToApply: boolean | null;
  readonly paused: boolean | null;
}

/** 不含工具正文、Prompt、源码或 SQL 的运行收尾诊断。 */
export interface PiRunDiagnostics {
  readonly lastToolName: string | null;
  readonly lastFinishStatus: string | null;
  readonly evidenceGraph: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly links: readonly string[];
    readonly worktreeHash: string | null;
  }[];
}

/** 单次 Profile 执行结果；evaluationRoot 仅供同进程判卷，不写入公开报告。 */
export interface PiRunOutcome {
  readonly metrics: PiRunMetrics;
  readonly evaluationRoot: string;
  readonly workflowClosure: PiWorkflowClosure;
  readonly diagnostics: PiRunDiagnostics;
}

/** 兼容既有调用方的原版 Pi 指标名称。 */
export type PiOriginalRunMetrics = PiRunMetrics;

/** 原版 Pi 单次运行参数。 */
export interface PiOriginalRunOptions {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly runtimeRoot: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

interface SessionStatsRecord {
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
  readonly contextUsage?: {
    readonly tokens?: number | null;
    readonly percent?: number | null;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const object = record(value);
  if (!object) {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : "undefined";
  }
  return "{" + Object.keys(object).sort().map(
    (key) => JSON.stringify(key) + ":" + canonical(object[key]),
  ).join(",") + "}";
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("api key") || message.includes("鉴权")) return "model-auth-unavailable";
  if (message.includes("model") || message.includes("provider")) return "model-unavailable";
  if (message.includes("rpc") || message.includes("pi ")) return "pi-rpc-error";
  return "pi-original-error";
}

function providerExtensionPath(): string {
  return fileURLToPath(new URL("./pi-original-extension.js", import.meta.url));
}

/**
 * 构造不加载 Dungeon Maintainer 优化的原版 Pi 参数。
 *
 * @param options 仓库、会话目录和当前模型 ID。
 * @returns 不含 API Key 和 Prompt 的固定参数数组。
 */
export function buildPiOriginalArguments(options: {
  readonly runId: string;
  readonly sessionDirectory: string;
  readonly model: string;
}): string[] {
  return [
    "--mode", "rpc",
    "--approve",
    "--tools", "read,bash,edit,write",
    "--no-extensions",
    "--no-prompt-templates",
    "-e", providerExtensionPath(),
    "--provider", PI_ORIGINAL_PROVIDER_ID,
    "--model", options.model,
    "--thinking", "off",
    "--session-id", options.runId,
    "--session-dir", options.sessionDirectory,
  ];
}

/**
 * 在一次性仓库中运行一轮原版 Pi，并等待 `agent_settled`。
 *
 * @param options 运行 ID、临时仓库、临时配置目录、公开 Prompt 和硬超时。
 * @returns 低敏 Token、工具、队列和诊断时延指标。
 * @throws 不向外抛模型正文；启动后错误会折叠为稳定 `failureCode`。
 */
export async function runPiOriginal(
  options: PiOriginalRunOptions,
): Promise<PiRunOutcome> {
  const startedAt = performance.now();
  const repositoryRoot = resolve(options.repositoryRoot);
  const runtimeRoot = resolve(options.runtimeRoot);
  const sessionDirectory = resolve(runtimeRoot, "session");
  const configDirectory = resolve(runtimeRoot, "config");
  await Promise.all([
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(configDirectory, { recursive: true }),
  ]);
  const config = loadConfig();
  assertFlashBenchmarkModel(config.model);
  const apiKey = requireApiKey(config);
  let turns = 0;
  let toolCalls = 0;
  let diagnosticToolCalls = 0;
  let readCalls = 0;
  let writeCalls = 0;
  let duplicateCalls = 0;
  let queuePeak = 0;
  const runtimeState: { firstWriteAt: number | null; settled: boolean } = {
    firstWriteAt: null,
    settled: false,
  };
  let failureCode: string | null = null;
  let previousToolSignature: string | null = null;
  let lastToolName: string | null = null;
  let resolveSettled: () => void = () => undefined;
  const settledPromise = new Promise<void>((resolvePromise) => {
    resolveSettled = resolvePromise;
  });
  const rpc = new PiRpcProcess(
    resolvePiCliPath(),
    buildPiOriginalArguments({
      runId: options.runId,
      sessionDirectory,
      model: config.model,
    }),
    {
      ...process.env,
      DUNGEON_MAINTAINER_WORKTREE: repositoryRoot,
      DUNGEON_BENCHMARK_API_KEY: apiKey,
      DUNGEON_BENCHMARK_BASE_URL: config.baseUrl,
      DUNGEON_BENCHMARK_MODEL: config.model,
      DUNGEON_BENCHMARK_CONTEXT_WINDOW: String(config.contextWindow),
      DUNGEON_BENCHMARK_MAX_TOKENS: String(config.maxOutputTokens),
      DUNGEON_BENCHMARK_REASONING: config.reasoning ? "1" : "0",
      PI_CODING_AGENT_DIR: configDirectory,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    (event) => {
      const value = record(event);
      if (!value) return;
      if (value.type === "turn_end") turns += 1;
      if (value.type === "queue_update") {
        const steering = Array.isArray(value.steering) ? value.steering.length : 0;
        const followUp = Array.isArray(value.followUp) ? value.followUp.length : 0;
        queuePeak = Math.max(queuePeak, steering + followUp);
      }
      if (value.type === "tool_execution_start") {
        const toolName = typeof value.toolName === "string" ? value.toolName : "unknown";
        lastToolName = toolName;
        const signature = toolName + ":" + canonical(value.args);
        if (signature === previousToolSignature) duplicateCalls += 1;
        previousToolSignature = signature;
        toolCalls += 1;
        const isWrite = toolName === "edit" || toolName === "write";
        if (runtimeState.firstWriteAt === null && !isWrite) diagnosticToolCalls += 1;
        if (toolName === "read") readCalls += 1;
        if (isWrite) {
          writeCalls += 1;
          runtimeState.firstWriteAt ??= performance.now();
        }
      }
      if (value.type === "agent_settled") {
        runtimeState.settled = true;
        resolveSettled();
      }
      if (value.type === "extension_error" || value.type === "pi_stderr") {
        failureCode ??= "pi-runtime-error";
      }
    },
  );

  let stats: SessionStatsRecord = {};
  try {
    await rpc.start();
    await rpc.send({ type: "prompt", message: options.prompt });
    const completed = await Promise.race([
      settledPromise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), options.timeoutMs);
        timer.unref();
      }),
    ]);
    if (!completed) {
      failureCode = "agent-timeout";
      await rpc.send({ type: "abort" }).catch(() => undefined);
    }
    stats = record(await requestWithDeadline(
      () => rpc.send({ type: "get_session_stats" }),
      SESSION_STATS_TIMEOUT_MS,
      null,
    )) ?? {};
  } catch (error) {
    failureCode ??= safeFailureCode(error);
  } finally {
    await rpc.stop().catch(() => {
      failureCode ??= "pi-stop-failed";
    });
  }
  const tokens = stats.tokens ?? {};
  const contextUsage = stats.contextUsage ?? {};
  const metrics: PiRunMetrics = {
    status: runtimeState.settled && !failureCode
      ? "settled"
      : failureCode === "agent-timeout" ? "timeout" : "infra_error",
    durationMs: Math.round(performance.now() - startedAt),
    diagnosisMs: runtimeState.firstWriteAt === null
      ? null
      : Math.round(runtimeState.firstWriteAt - startedAt),
    turns,
    toolCalls,
    diagnosticToolCalls,
    readCalls,
    writeCalls,
    consecutiveDuplicateToolCalls: duplicateCalls,
    piMessageQueuePeak: queuePeak,
    taskQueuePeak: 0,
    episodes: 0,
    recoveries: 0,
    inspectCalls: 0,
    inspectExecutions: 0,
    inspectReceiptHits: 0,
    routedSearchExpansions: 0,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadTokens: tokens.cacheRead ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
    totalTokens: tokens.total ?? 0,
    contextTokens: typeof contextUsage.tokens === "number" ? contextUsage.tokens : null,
    contextPercent: typeof contextUsage.percent === "number" ? contextUsage.percent : null,
    failureCode,
  };
  return {
    metrics,
    evaluationRoot: repositoryRoot,
    workflowClosure: {
      applicable: false,
      taskState: null,
      proposed: null,
      executed: null,
      writeAttempted: null,
      retainedChanges: null,
      verified: null,
      readyToApply: null,
      paused: null,
    },
    diagnostics: {
      lastToolName,
      lastFinishStatus: null,
      evidenceGraph: [],
    },
  };
}
