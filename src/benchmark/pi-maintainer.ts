/**
 * 当前 Dungeon Maintainer 实现的通用 Benchmark 运行器。
 *
 * 每次构建都直接加载当前分支编译出的 Maintainer Extension，因此 Prompt、领域工具、
 * 安全门禁和 Token 控制的后续修改会自动进入同一套游戏修复 Eval。运行器只负责建立
 * 隔离任务、自动确认 Benchmark 中唯一的完整方案审批并汇总低敏指标；案例、Oracle、
 * 检查和公开 Prompt 继续由 agent-eval-runner 统一提供。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPiArguments, resolvePiCliPath } from "../app/pi-process.js";
import { loadConfig, requireApiKey } from "../config.js";
import { PiRpcProcess } from "../pi/rpc-process.js";
import { defaultModelProfile, profileKeyEnvironmentName } from "../settings/profiles.js";
import { startShellServer, type ShellHandle } from "../shell/server.js";
import { TaskStore } from "../task/store.js";
import { INITIAL_TASK_OBJECTIVE, type TaskState } from "../task/types.js";
import { readRepo } from "../workspace/git.js";
import { createTaskWorktreeSnapshot } from "../workspace/worktree.js";
import type { PiRunMetrics, PiRunOutcome } from "./pi-original.js";
import { requestWithDeadline, SESSION_STATS_TIMEOUT_MS } from "./rpc-timeout.js";
import { EvidenceStore } from "../evidence/store.js";
import { assertFlashBenchmarkModel } from "./model-policy.js";

/** 当前实现单次运行参数；与原版 Profile 使用完全相同的公开输入。 */
export interface PiMaintainerRunOptions {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly runtimeRoot: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  /** 必须与当前 fixture 的隐藏 Oracle 起点一致。 */
  readonly startFloor: number;
  /** 可选的内置管理员预设；只通过子进程环境传给游戏运行时。 */
  readonly startPreset: string | null;
  /** 仅供本地实时进度页消费；回调正文不会进入 Benchmark 归档。 */
  readonly onLiveEvent?: (event: PiMaintainerLiveEvent) => void;
}

/** 当前 Maintainer 在一次 Eval 内允许公开到本地进度页的低敏实时事件。 */
export type PiMaintainerLiveEvent =
  | { readonly kind: "tool"; readonly toolName: string }
  | { readonly kind: "assistant"; readonly text: string };

/** Benchmark 子进程专用的游戏起点与无头模式环境；生产 start/resume 不设置这些字段。 */
export function benchmarkGameStartEnvironment(
  options: Pick<PiMaintainerRunOptions, "startFloor" | "startPreset">,
): Record<string, string> {
  if (!Number.isInteger(options.startFloor) || options.startFloor < 1 || options.startFloor > 8) {
    throw new Error("Benchmark 初始楼层必须是 1 至 8 的整数");
  }
  if (
    options.startPreset !== null
    && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.startPreset)
  ) {
    throw new Error("Benchmark 初始预设 ID 非法");
  }
  return {
    DUNGEON_MAINTAINER_BENCHMARK_MODE: "1",
    DUNGEON_MAINTAINER_BENCHMARK_HEADLESS: "1",
    DUNGEON_MAINTAINER_BENCHMARK_START_FLOOR: String(options.startFloor),
    DUNGEON_MAINTAINER_BENCHMARK_START_PRESET: options.startPreset ?? "",
  };
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

function assistantDelta(value: Record<string, unknown>): string | null {
  const event = record(value.assistantMessageEvent);
  return event?.type === "text_delta" && typeof event.delta === "string"
    ? event.delta
    : null;
}

function assistantMessageText(value: Record<string, unknown>): string | null {
  const message = record(value.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
  const chunks = message.content.flatMap((block) => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  });
  return chunks.length > 0 ? chunks.join("") : null;
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
  return "maintainer-current-error";
}

async function readInspectTelemetry(eventsPath: string): Promise<{
  executions: number;
  receiptHits: number;
  expansions: number;
}> {
  try {
    const rows = (await readFile(eventsPath, "utf8")).split(/\r?\n/u).filter(Boolean);
    let executions = 0;
    let receiptHits = 0;
    let expansions = 0;
    for (const row of rows) {
      const event = record(JSON.parse(row));
      if (event?.type !== "tool.inspect") continue;
      const detail = record(event.detail);
      if (detail?.cacheHit === true || detail?.receiptOnly === true) receiptHits += 1;
      else executions += 1;
      if (detail?.expanded === true) expansions += 1;
    }
    return { executions, receiptHits, expansions };
  } catch {
    return { executions: 0, receiptHits: 0, expansions: 0 };
  }
}

function requireBenchmarkRpc(value: PiRpcProcess | null): PiRpcProcess {
  if (value === null) throw new Error("Benchmark Pi RPC 尚未启动");
  return value;
}

/**
 * 判断 Benchmark 是否需要自动回复一个 Extension UI 请求。
 *
 * Benchmark 没有人工交互，完整修复方案必须沿用原来的固定批准策略；其它 UI 请求
 * 也继续自动拒绝，避免无人值守运行因为弹窗而悬挂。调用方不会把这些请求转成 Shell
 * 可点击 approval，从而保证同一个请求只写入一次 Pi RPC 响应。
 *
 * @param value Pi RPC 事件。
 * @returns 是否为需要自动回复的 UI 请求。
 */
export function isBenchmarkUiRequest(value: unknown): value is {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
} {
  const event = record(value);
  return event?.type === "extension_ui_request"
    && typeof event.id === "string"
    && typeof event.method === "string"
    && ["confirm", "select", "input", "editor"].includes(event.method);
}

/** 判断一个 UI 请求是否属于固定的完整修复方案审批。 */
export function isBenchmarkExecutionApproval(value: unknown): boolean {
  const event = record(value);
  return isBenchmarkUiRequest(value)
    && event?.method === "confirm"
    && event.title === "是否执行完整修复方案";
}

/** 构造带任务令牌的 Shell POST 地址；不复制或解析 API Key。 */
export function benchmarkShellEndpoint(shellUrl: string, path: string): string {
  const url = new URL(shellUrl);
  url.pathname = path;
  return url.toString();
}

/**
 * 第一个真实 `agent_settled` 即表示本次自然请求的 Pi Agent Loop 已结束。
 * TaskState 只补充真实 blocked 分类；修复是否成功由随后独立运行的外部 Oracle 判断，
 * 不能再等待内部 Queue、paused 或 ready_to_apply 来替 Benchmark 判卷。
 */
export function benchmarkSettledDecision(input: {
  readonly taskState: TaskState;
  readonly queueActive: number;
}): { readonly failureCode: string | null } | null {
  void input.queueActive;
  if (input.taskState === "blocked") return { failureCode: "maintainer-blocked" };
  if (input.taskState === "paused") return { failureCode: "maintainer-paused" };
  if (input.taskState === "ready_to_apply") return { failureCode: null };
  return { failureCode: "maintainer-agent-incomplete" };
}

/** 当前 Profile 的 Pi 参数始终指向本次构建产物，不保存版本副本。 */
export function buildPiMaintainerArguments(
  task: Parameters<typeof buildPiArguments>[0],
  config: Parameters<typeof buildPiArguments>[1],
): string[] {
  return [...buildPiArguments(task, config), "--thinking", "off"];
}

/**
 * 在物化 fixture 中运行当前 Maintainer，直到单次自然请求的 Agent Loop settled。
 *
 * fixture 的故障补丁先暂存为任务基线，保证“修回正常 HEAD”仍会被工作区层识别为
 * Agent 增量。该暂存只发生在本轮临时仓库，外层 finally 会统一删除。
 */
export async function runPiMaintainer(
  options: PiMaintainerRunOptions,
): Promise<PiRunOutcome> {
  const startedAt = performance.now();
  let visibleAssistantText = "";
  const repositoryRoot = resolve(options.repositoryRoot);
  const runtimeRoot = resolve(options.runtimeRoot);
  const dataDirectory = join(runtimeRoot, "data");
  const configDirectory = join(runtimeRoot, "config");
  const store = new TaskStore(dataDirectory);
  const repository = await readRepo(repositoryRoot);
  const snapshot = await createTaskWorktreeSnapshot(
    options.runId,
    repositoryRoot,
    repository.head,
    join(dataDirectory, "worktrees"),
  );
  const sessionDirectory = join(store.taskDir(options.runId), "pi");
  await mkdir(sessionDirectory, { recursive: true });
  const task = await store.create({
    id: options.runId,
    objective: INITIAL_TASK_OBJECTIVE,
    repoRoot: repositoryRoot,
    baseHead: repository.head,
    sourceBranch: snapshot.sourceBranch,
    sourceDirtyFiles: snapshot.sourceDirtyFiles,
    sourceSnapshotHash: snapshot.sourceSnapshotHash,
    worktreeRoot: snapshot.root,
    piSessionDir: sessionDirectory,
  });
  const config = loadConfig();
  const apiKey = requireApiKey(config);
  const profile = defaultModelProfile(config);
  assertFlashBenchmarkModel(profile.modelId);
  let turns = 0;
  let toolCalls = 0;
  let diagnosticToolCalls = 0;
  let readCalls = 0;
  let inspectCalls = 0;
  let writeCalls = 0;
  let duplicateCalls = 0;
  let piMessageQueuePeak = 0;
  const taskQueuePeak = 0;
  const episodes = 0;
  const recoveries = 0;
  let proposed = false;
  let previousToolSignature: string | null = null;
  let lastToolName: string | null = null;
  let lastFinishStatus: string | null = null;
  const runState: {
    firstWriteAt: number | null;
    completed: boolean;
    failureCode: string | null;
  } = {
    firstWriteAt: null,
    completed: false,
    failureCode: null,
  };
  let settleCheck = 0;
  let resolveCompleted: () => void = () => undefined;
  const completedPromise = new Promise<void>((resolvePromise) => {
    resolveCompleted = resolvePromise;
  });
  let rpc: PiRpcProcess | null = null;
  let shell: ShellHandle | null = null;

  const scheduleSettledCheck = (): void => {
    const check = ++settleCheck;
    setTimeout(() => {
      void (async () => {
        if (check !== settleCheck || runState.completed) return;
        const currentTask = await store.read(task.id);
        const decision = benchmarkSettledDecision({
          taskState: currentTask.state,
          queueActive: 0,
        });
        if (!decision) return;
        runState.failureCode ??= decision.failureCode;
        runState.completed = true;
        resolveCompleted();
      })().catch(() => {
        runState.failureCode ??= "maintainer-state-read-failed";
        runState.completed = true;
        resolveCompleted();
      });
    }, 50);
  };

  let stats: SessionStatsRecord = {};
  try {
    shell = await startShellServer({
      task,
      model: profile.modelId,
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
      store,
      sendPiCommand: async (command) => {
        const activeRpc = rpc;
        if (!activeRpc) throw new Error("Benchmark Pi RPC 尚未启动");
        if (command.type === "extension_ui_response") {
          activeRpc.respond(command);
          return { ok: true };
        }
        return await activeRpc.send(command);
      },
      onClose: async () => {
        runState.failureCode ??= "benchmark-shell-closed";
        runState.completed = true;
        resolveCompleted();
        await rpc?.send({ type: "abort" }).catch(() => undefined);
      },
    });
    rpc = new PiRpcProcess(
      resolvePiCliPath(),
      buildPiMaintainerArguments(task, config),
      {
        ...process.env,
        ...benchmarkGameStartEnvironment(options),
        MAINTAINER_API_KEY: apiKey,
        MAINTAINER_BASE_URL: profile.baseUrl,
        MAINTAINER_MODEL: profile.modelId,
        MAINTAINER_CONTEXT_WINDOW: String(profile.contextWindow),
        MAINTAINER_MAX_TOKENS: String(profile.maxOutputTokens),
        MAINTAINER_REASONING: String(profile.reasoning),
        DUNGEON_MAINTAINER_MODEL_PROFILES: JSON.stringify([profile]),
        DUNGEON_MAINTAINER_TASK_ID: task.id,
        DUNGEON_MAINTAINER_DATA_DIR: dataDirectory,
        DUNGEON_MAINTAINER_WORKTREE: snapshot.root,
        DUNGEON_MAINTAINER_SHELL_URL: shell.url,
        [profileKeyEnvironmentName(profile.id)]: apiKey,
        PI_CODING_AGENT_DIR: configDirectory,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      (event) => {
        const value = record(event);
        if (!value) return;
        // UI 请求的类型守卫会把 `value` 缩窄成 UI 联合类型；统计字段则来自其它
        // Pi 事件。使用独立的 Record 视图读取可选统计字段，避免把两类事件混在一起。
        const eventRecord: Record<string, unknown> = value;
        const activeShell = shell;
        const activeRpc = rpc;
        if (isBenchmarkUiRequest(value)) {
          const approved = isBenchmarkExecutionApproval(value);
          if (approved) proposed = true;
          activeRpc?.respond({ id: value.id, confirmed: approved });
          activeShell?.publish({
            type: "notice",
            level: approved ? "info" : "warning",
            text: approved
              ? "Benchmark 已按固定规则自动批准完整修复方案。"
              : "Benchmark 已按无人值守规则拒绝额外交互请求。",
          });
        } else {
          activeShell?.handlePiEvent(event);
        }
        if (eventRecord.type === "message_update" && eventRecord.usage) {
          activeShell?.updateTurnUsage(eventRecord.usage);
        }
        if (eventRecord.type === "message_update") {
          const delta = assistantDelta(eventRecord);
          if (delta) {
            visibleAssistantText = (visibleAssistantText + delta).slice(-4_000);
            options.onLiveEvent?.({ kind: "assistant", text: visibleAssistantText });
          }
        }
        if (eventRecord.type === "message_end") {
          const text = assistantMessageText(eventRecord);
          if (text) {
            visibleAssistantText = text.slice(-4_000);
            options.onLiveEvent?.({ kind: "assistant", text: visibleAssistantText });
          }
        }
        if (eventRecord.type === "turn_end") turns += 1;
        if (eventRecord.type === "queue_update") {
          const steering = Array.isArray(eventRecord.steering) ? eventRecord.steering.length : 0;
          const followUp = Array.isArray(eventRecord.followUp) ? eventRecord.followUp.length : 0;
          piMessageQueuePeak = Math.max(piMessageQueuePeak, steering + followUp);
        }
        if (eventRecord.type === "tool_execution_start") {
          const toolName = typeof eventRecord.toolName === "string" ? eventRecord.toolName : "unknown";
          options.onLiveEvent?.({ kind: "tool", toolName });
          lastToolName = toolName;
          if (toolName === "finish") {
            const status = record(eventRecord.args)?.status;
            lastFinishStatus = typeof status === "string" ? status : null;
          }
          const signature = toolName + ":" + canonical(eventRecord.args);
          if (signature === previousToolSignature) duplicateCalls += 1;
          previousToolSignature = signature;
          toolCalls += 1;
          const isWrite = toolName === "write" || toolName === "patch";
          if (runState.firstWriteAt === null && !isWrite) diagnosticToolCalls += 1;
          if (toolName === "read") readCalls += 1;
          if (toolName === "inspect") {
            inspectCalls += 1;
            if (record(eventRecord.args)?.action === "read") readCalls += 1;
          }
          if (isWrite) {
            writeCalls += 1;
            runState.firstWriteAt ??= performance.now();
          }
        }
        if (eventRecord.type === "agent_settled") scheduleSettledCheck();
        if (eventRecord.type === "agent_settled" || eventRecord.type === "compaction_end") {
          void activeShell?.syncPiState().catch(() => undefined);
        }
        void store.read(task.id)
          .then((currentTask) => activeShell?.updateTask(currentTask))
          .catch(() => undefined);
        if (eventRecord.type === "extension_error" || eventRecord.type === "pi_stderr") {
          runState.failureCode ??= "pi-runtime-error";
        }
      },
    );
    await rpc.start();
    await rpc.send({ type: "set_thinking_level", level: "off" });
    await shell.syncPiState();
    const promptResponse = await fetch(benchmarkShellEndpoint(shell.url, "/api/input"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: options.prompt }),
    });
    if (!promptResponse.ok) {
      throw new Error("Benchmark Shell 无法提交公开 Prompt");
    }
    const finished = await Promise.race([
      completedPromise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), options.timeoutMs);
        timer.unref();
      }),
    ]);
    if (!finished) {
      runState.failureCode = "agent-timeout";
      await rpc.send({ type: "abort" }).catch(() => undefined);
    }
    const statsRpc = requireBenchmarkRpc(rpc);
    stats = record(await requestWithDeadline(
      () => statsRpc.send({ type: "get_session_stats" }),
      SESSION_STATS_TIMEOUT_MS,
      null,
    )) ?? {};
    shell.updateSessionStats(stats);
    await store.read(task.id).then((currentTask) => shell?.updateTask(currentTask));
  } catch (error) {
    runState.failureCode ??= safeFailureCode(error);
  } finally {
    await rpc?.stop().catch(() => {
      runState.failureCode ??= "pi-stop-failed";
    });
    await shell?.close().catch(() => {
      runState.failureCode ??= "benchmark-shell-stop-failed";
    });
  }
  const tokens = stats.tokens ?? {};
  const contextUsage = stats.contextUsage ?? {};
  const inspectTelemetry = await readInspectTelemetry(
    join(store.taskDir(task.id), "events.jsonl"),
  );
  const metrics: PiRunMetrics = {
    status: runState.failureCode === "agent-timeout"
      ? "timeout"
      : runState.completed && (
          runState.failureCode === null
          || runState.failureCode === "maintainer-blocked"
          || runState.failureCode === "maintainer-paused"
        )
        ? "settled"
        : "infra_error",
    durationMs: Math.round(performance.now() - startedAt),
    diagnosisMs: runState.firstWriteAt === null
      ? null
      : Math.round(runState.firstWriteAt - startedAt),
    turns,
    toolCalls,
    diagnosticToolCalls,
    readCalls,
    writeCalls,
    consecutiveDuplicateToolCalls: duplicateCalls,
    piMessageQueuePeak,
    taskQueuePeak,
    episodes,
    recoveries,
    inspectCalls,
    inspectExecutions: inspectTelemetry.executions,
    inspectReceiptHits: inspectTelemetry.receiptHits,
    routedSearchExpansions: inspectTelemetry.expansions,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadTokens: tokens.cacheRead ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
    totalTokens: tokens.total ?? 0,
    contextTokens: typeof contextUsage.tokens === "number" ? contextUsage.tokens : null,
    contextPercent: typeof contextUsage.percent === "number" ? contextUsage.percent : null,
    failureCode: runState.failureCode,
  };
  let workflowClosure: PiRunOutcome["workflowClosure"] = {
    applicable: true,
    taskState: null,
    proposed: false,
    executed: writeCalls > 0,
    writeAttempted: writeCalls > 0,
    retainedChanges: false,
    verified: false,
    readyToApply: false,
    paused: false,
  };
  try {
    const finalTask = await store.read(task.id);
    workflowClosure = {
      applicable: true,
      taskState: finalTask.state,
      proposed,
      executed: finalTask.changedPaths.length > 0 || writeCalls > 0,
      writeAttempted: writeCalls > 0,
      retainedChanges: finalTask.changedPaths.length > 0,
      verified: finalTask.verification?.replayPassed === true,
      readyToApply: finalTask.state === "ready_to_apply",
      paused: finalTask.state === "paused",
    };
  } catch {
    runState.failureCode ??= "maintainer-state-read-failed";
  }
  const evidenceStore = new EvidenceStore(dataDirectory, task);
  const evidenceGraph = await evidenceStore.active().then((records) => records.map((record) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    links: [...record.links],
    worktreeHash: record.worktreeHash,
  }))).catch(() => []);
  return {
    metrics: { ...metrics, failureCode: runState.failureCode },
    evaluationRoot: snapshot.root,
    workflowClosure,
    diagnostics: { lastToolName, lastFinishStatus, evidenceGraph },
  };
}
