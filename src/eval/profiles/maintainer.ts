/**
 * 当前 Dungeon Maintainer 实现的通用 Eval 运行器。
 *
 * 每次构建都直接加载当前分支编译出的 Maintainer Extension，因此 Prompt、领域工具、
 * 安全门禁的后续修改会自动进入同一套游戏修复 Eval。运行器只负责建立
 * 隔离任务、自动确认 Eval 中唯一的完整方案审批并汇总低敏指标；第一次真实
 * `agent_settled` 后停止 Pi 并卸载本轮工具。案例、隐藏 after Oracle、检查和公开
 * Prompt 继续由外层 runner 统一提供，Profile 不参与功能判分。
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPiArguments, resolvePiCliPath } from "../../app/pi-process.js";
import { requireApiKey } from "../../config.js";
import { loadEvalConfig } from "../config.js";
import { PiRpcProcess, type PiRpcEvent } from "../../pi/rpc-process.js";
import { TaskStore } from "../../task/store.js";
import { INITIAL_TASK_OBJECTIVE, type TaskRecord } from "../../task/types.js";
import { readRepo } from "../../workspace/git.js";
import { createTaskWorktreeSnapshot } from "../../workspace/worktree.js";
import type { ProfileRunMetrics, ProfileRunResult } from "../domain/result.js";
import { readMaintainerTelemetry } from "./maintainer-telemetry.js";
import { buildMaintainerWorkflowClosure } from "../domain/result.js";
import { requestWithDeadline, SESSION_STATS_TIMEOUT_MS } from "./rpc-deadline.js";
import { EvidenceStore } from "../../evidence/store.js";

export { readMaintainerTelemetry } from "./maintainer-telemetry.js";
export type { MaintainerTelemetry } from "./maintainer-telemetry.js";
export { buildMaintainerWorkflowClosure } from "../domain/result.js";

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
  /** 仅供本地实时进度页消费；回调正文不会进入 Eval 归档。 */
  readonly onLiveEvent?: (event: PiMaintainerLiveEvent) => void;
}

/** 当前 Maintainer 在一次 Eval 内允许公开到本地进度页的低敏实时事件。 */
export type PiMaintainerLiveEvent =
  | { readonly kind: "tool"; readonly toolName: string }
  | { readonly kind: "assistant"; readonly text: string };

/** Eval 子进程专用的游戏起点与无头模式环境；生产 start/resume 不设置这些字段。 */
export function evalGameStartEnvironment(
  options: Pick<PiMaintainerRunOptions, "startFloor" | "startPreset">,
): Record<string, string> {
  if (!Number.isInteger(options.startFloor) || options.startFloor < 1 || options.startFloor > 8) {
    throw new Error("Eval 初始楼层必须是 1 至 8 的整数");
  }
  if (
    options.startPreset !== null
    && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.startPreset)
  ) {
    throw new Error("Eval 初始预设 ID 非法");
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
  return "maintainer-error";
}

function requireEvalRpc(value: PiRpcProcess | null): PiRpcProcess {
  if (value === null) throw new Error("Eval Pi RPC 尚未启动");
  return value;
}

/** Maintainer 模型侧唯一会修改工作区的 1.0 工具。 */
export function isMaintainerWriteTool(toolName: string): boolean {
  return toolName === "edit";
}

/**
 * 停止 Pi，使 Extension 的 session_shutdown 卸载游戏 Browser/Vite 和模型工具。
 */
export async function teardownMaintainerRuntime(input: {
  readonly stopPi: () => Promise<void>;
}): Promise<readonly "pi-stop-failed"[]> {
  const failures: "pi-stop-failed"[] = [];
  try {
    await input.stopPi();
  } catch {
    failures.push("pi-stop-failed");
  }
  return failures;
}

/**
 * 判断 Eval 是否需要自动回复一个 Extension UI 请求。
 *
 * Eval 没有人工交互，完整修复方案必须沿用原来的固定批准策略；其它 UI 请求
 * 也继续自动拒绝，避免无人值守运行因为弹窗而悬挂。
 *
 * @param value Pi RPC 事件。
 * @returns 是否为需要自动回复的 UI 请求。
 */
export function isEvalUiRequest(value: unknown): value is {
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

/** 判断一个 UI 请求是否属于固定的代码修改审批。 */
export function isEvalExecutionApproval(value: unknown): boolean {
  const event = record(value);
  return isEvalUiRequest(value)
    && event?.method === "confirm"
    && (
      event.title === "是否允许本次代码修改"
      || event.title === "是否执行完整修复方案"
    );
}

/**
 * 按真实 Agent Loop 是否结束区分语义失败与基础设施失败。
 *
 * Agent 一旦 settled 就交给外层功能 Oracle；只有未完成运行、超时或卸载失败会阻断。
 */
export function classifyMaintainerRunStatus(input: {
  readonly completed: boolean;
  readonly failureCode: string | null;
  readonly infrastructureFailureCode?: string | null;
}): ProfileRunMetrics["status"] {
  if (input.failureCode === "agent-timeout") return "timeout";
  if (input.infrastructureFailureCode) return "infra_error";
  if (!input.completed) return "infra_error";
  return "settled";
}

/** 超时保持独立状态；其它情况下真实运行故障优先于 Agent 的正常收尾诊断。 */
export function maintainerRunFailureCode(input: {
  readonly failureCode: string | null;
  readonly infrastructureFailureCode?: string | null;
}): string | null {
  if (input.failureCode === "agent-timeout") return input.failureCode;
  return input.infrastructureFailureCode ?? input.failureCode;
}

/** 当前 Profile 的 Pi 参数始终指向本次构建产物，不保存版本副本。 */
export function buildPiMaintainerArguments(
  task: Parameters<typeof buildPiArguments>[0],
  config: Parameters<typeof buildPiArguments>[1],
): string[] {
  return buildPiArguments(task, config);
}

interface MaintainerRunState {
  visibleAssistantText: string;
  turns: number;
  toolCalls: number;
  diagnosticToolCalls: number;
  readCalls: number;
  inspectCalls: number;
  writeCalls: number;
  duplicateCalls: number;
  piMessageQueuePeak: number;
  proposed: boolean;
  previousToolSignature: string | null;
  lastToolName: string | null;
  lastFinishStatus: string | null;
  completed: boolean;
  failureCode: string | null;
  infrastructureFailureCode: string | null;
  stats: SessionStatsRecord;
}

function createMaintainerRunState(): MaintainerRunState {
  return {
    visibleAssistantText: "",
    turns: 0,
    toolCalls: 0,
    diagnosticToolCalls: 0,
    readCalls: 0,
    inspectCalls: 0,
    writeCalls: 0,
    duplicateCalls: 0,
    piMessageQueuePeak: 0,
    proposed: false,
    previousToolSignature: null,
    lastToolName: null,
    lastFinishStatus: null,
    completed: false,
    failureCode: null,
    infrastructureFailureCode: null,
    stats: {},
  };
}

function observeMaintainerEvent(
  options: PiMaintainerRunOptions,
  state: MaintainerRunState,
  rpc: PiRpcProcess | null,
  event: PiRpcEvent,
  settle: () => void,
): void {
  const eventRecord = event as unknown as Record<string, unknown>;
  if (isEvalUiRequest(event)) {
    const approved = isEvalExecutionApproval(event);
    if (approved) state.proposed = true;
    rpc?.respond(event.method === "confirm"
      ? { type: "extension_ui_response", id: event.id, confirmed: approved }
      : { type: "extension_ui_response", id: event.id, cancelled: true });
  }
  if (eventRecord.type === "message_update") {
    const delta = assistantDelta(eventRecord);
    if (delta) {
      state.visibleAssistantText = (state.visibleAssistantText + delta).slice(-4_000);
      options.onLiveEvent?.({ kind: "assistant", text: state.visibleAssistantText });
    }
  }
  if (eventRecord.type === "message_end") {
    const text = assistantMessageText(eventRecord);
    if (text) {
      state.visibleAssistantText = text.slice(-4_000);
      options.onLiveEvent?.({ kind: "assistant", text: state.visibleAssistantText });
    }
  }
  if (eventRecord.type === "turn_end") state.turns += 1;
  if (eventRecord.type === "queue_update") {
    const steering = Array.isArray(eventRecord.steering) ? eventRecord.steering.length : 0;
    const followUp = Array.isArray(eventRecord.followUp) ? eventRecord.followUp.length : 0;
    state.piMessageQueuePeak = Math.max(state.piMessageQueuePeak, steering + followUp);
  }
  if (eventRecord.type === "tool_execution_start") {
    const toolName = typeof eventRecord.toolName === "string" ? eventRecord.toolName : "unknown";
    options.onLiveEvent?.({ kind: "tool", toolName });
    state.lastToolName = toolName;
    if (toolName === "finish") {
      const status = record(eventRecord.args)?.status;
      state.lastFinishStatus = typeof status === "string" ? status : null;
    }
    const signature = toolName + ":" + canonical(eventRecord.args);
    if (signature === state.previousToolSignature) state.duplicateCalls += 1;
    state.previousToolSignature = signature;
    state.toolCalls += 1;
    const isWrite = isMaintainerWriteTool(toolName);
    if (state.writeCalls === 0 && !isWrite) state.diagnosticToolCalls += 1;
    if (toolName === "read") state.readCalls += 1;
    if (toolName === "inspect") {
      state.inspectCalls += 1;
      if (record(eventRecord.args)?.action === "read") state.readCalls += 1;
    }
    if (isWrite) state.writeCalls += 1;
  }
  if (eventRecord.type === "agent_settled" && !state.completed) {
    state.completed = true;
    settle();
  }
}

async function buildMaintainerRunResult(input: {
  state: MaintainerRunState;
  startedAt: number;
  startedEpoch: number;
  dataDirectory: string;
  store: TaskStore;
  task: TaskRecord;
  workspaceRoot: string;
}): Promise<ProfileRunResult> {
  const { state, startedAt, startedEpoch, dataDirectory, store, task } = input;
  const tokens = state.stats.tokens ?? {};
  const contextUsage = state.stats.contextUsage ?? {};
  const telemetry = await readMaintainerTelemetry(join(store.taskDir(task.id), "events.jsonl"));
  const classifiedInspectCalls = telemetry.executions
    + telemetry.receiptHits
    + telemetry.inspectFailures;
  if (state.inspectCalls > classifiedInspectCalls) {
    telemetry.inspectFailures += state.inspectCalls - classifiedInspectCalls;
  }
  const inspectTotal = telemetry.executions + telemetry.receiptHits + telemetry.inspectFailures;
  const writeAttempts = telemetry.writeRejected
    + telemetry.writeFailures
    + telemetry.writeNoops
    + telemetry.writeMutations;
  const metrics: ProfileRunMetrics = {
    status: classifyMaintainerRunStatus(state),
    durationMs: Math.round(performance.now() - startedAt),
    diagnosisMs: telemetry.firstMutationAt === null
      ? null
      : Math.max(0, telemetry.firstMutationAt - startedEpoch),
    turns: state.turns,
    toolCalls: state.toolCalls,
    diagnosticToolCalls: state.diagnosticToolCalls,
    readCalls: state.readCalls,
    writeCalls: state.writeCalls,
    consecutiveDuplicateToolCalls: state.duplicateCalls,
    piMessageQueuePeak: state.piMessageQueuePeak,
    inspectCalls: inspectTotal,
    inspectExecutions: telemetry.executions,
    inspectReceiptHits: telemetry.receiptHits,
    semanticEvidenceHits: telemetry.semanticEvidenceHits,
    inspectBundles: telemetry.bundles,
    inspectBundleWindows: telemetry.bundleWindows,
    inspectFailures: telemetry.inspectFailures,
    inspectCandidateFiles: telemetry.inspectCandidateFiles,
    inspectSelectedFiles: telemetry.inspectSelectedFiles,
    writeAttempts,
    writeRejected: telemetry.writeRejected,
    writeFailures: telemetry.writeFailures,
    writeNoops: telemetry.writeNoops,
    writeMutations: telemetry.writeMutations,
    writeReplayFailures: telemetry.writeReplayFailures,
    telemetryParseErrors: telemetry.parseErrors,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadTokens: tokens.cacheRead ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
    totalTokens: tokens.total ?? 0,
    cacheHitRate: (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) > 0
      ? (tokens.cacheRead ?? 0)
        / ((tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0))
      : 0,
    uncachedTokens: (tokens.input ?? 0) + (tokens.cacheWrite ?? 0) + (tokens.output ?? 0),
    contextTokens: typeof contextUsage.tokens === "number" ? contextUsage.tokens : null,
    contextPercent: typeof contextUsage.percent === "number" ? contextUsage.percent : null,
    failureCode: maintainerRunFailureCode(state),
  };
  let workflowClosure = buildMaintainerWorkflowClosure({
    taskState: null,
    proposed: false,
    writeAttempts,
    writeMutations: telemetry.writeMutations,
    changedPathCount: 0,
    replayPassed: false,
    readyToApply: false,
    paused: false,
  });
  try {
    const finalTask = await store.read(task.id);
    workflowClosure = buildMaintainerWorkflowClosure({
      taskState: finalTask.state,
      proposed: state.proposed,
      writeAttempts,
      writeMutations: telemetry.writeMutations,
      changedPathCount: finalTask.changedPaths.length,
      replayPassed: finalTask.verification?.replayPassed === true,
      readyToApply: finalTask.state === "ready_to_apply",
      paused: finalTask.state === "paused",
    });
  } catch {
    // 工作流闭环只供诊断，功能成绩由 settled 后的外层 Oracle 决定。
  }
  const evidenceGraph = await new EvidenceStore(dataDirectory, task)
    .list({ status: "all" }).then((records) => records.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      links: [...item.links],
      worktreeHash: item.worktreeHash,
    }))).catch(() => []);
  return {
    metrics,
    workspaceRoot: input.workspaceRoot,
    workflowClosure,
    diagnostics: {
      lastToolName: state.lastToolName,
      lastFinishStatus: state.lastFinishStatus,
      evidenceGraph,
    },
  };
}

/**
 * 在物化 fixture 中运行当前 Maintainer，直到单次自然请求的 Agent Loop settled。
 *
 * fixture 的故障补丁先暂存为任务基线，保证“修回正常 HEAD”仍会被工作区层识别为
 * Agent 增量。该暂存只发生在本轮临时仓库，外层 finally 会统一删除。
 * 第一次真实 `agent_settled` 后本函数完成低敏统计并停止 Pi；只有 Profile 已返回、
 * 本轮工具已卸载后，外层 Run 才会启动独立的隐藏 after browser Oracle。
 */
export async function runPiMaintainer(
  options: PiMaintainerRunOptions,
): Promise<ProfileRunResult> {
  const startedAt = performance.now();
  const startedEpoch = Date.now();
  const state = createMaintainerRunState();
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
  const config = loadEvalConfig();
  const apiKey = requireApiKey(config);
  let resolveCompleted: () => void = () => undefined;
  const completedPromise = new Promise<void>((resolvePromise) => {
    resolveCompleted = resolvePromise;
  });
  let rpc: PiRpcProcess | null = null;
  try {
    rpc = new PiRpcProcess(
      resolvePiCliPath(),
      buildPiMaintainerArguments(task, config),
      {
        ...process.env,
        ...evalGameStartEnvironment(options),
        MAINTAINER_API_KEY: apiKey,
        MAINTAINER_BASE_URL: config.baseUrl,
        MAINTAINER_MODEL: config.model,
        MAINTAINER_CONTEXT_WINDOW: String(config.contextWindow),
        MAINTAINER_MAX_TOKENS: String(config.maxOutputTokens),
        MAINTAINER_REASONING: String(config.reasoning),
        DUNGEON_MAINTAINER_TASK_ID: task.id,
        DUNGEON_MAINTAINER_DATA_DIR: dataDirectory,
        DUNGEON_MAINTAINER_WORKTREE: snapshot.root,
        PI_CODING_AGENT_DIR: configDirectory,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      (event) => observeMaintainerEvent(options, state, rpc, event, resolveCompleted),
    );
    await rpc.start();
    await rpc.send({ type: "prompt", message: options.prompt });
    const finished = await Promise.race([
      completedPromise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), options.timeoutMs);
        timer.unref();
      }),
    ]);
    if (!finished) {
      state.failureCode = "agent-timeout";
      await requestWithDeadline(
        () => requireEvalRpc(rpc).send({ type: "abort" }),
        SESSION_STATS_TIMEOUT_MS,
        null,
      );
    }
    const statsRpc = requireEvalRpc(rpc);
    const statsResult = await requestWithDeadline(
      () => statsRpc.send({ type: "get_session_stats" }),
      SESSION_STATS_TIMEOUT_MS,
      null,
    );
    const sessionStats = record(statsResult);
    if (sessionStats) state.stats = sessionStats;
  } catch (error) {
    state.infrastructureFailureCode ??= safeFailureCode(error);
  } finally {
    const teardownFailures = await teardownMaintainerRuntime({
      stopPi: async () => await rpc?.stop(),
    });
    state.infrastructureFailureCode ??= teardownFailures[0] ?? null;
  }
  return await buildMaintainerRunResult({
    state,
    startedAt,
    startedEpoch,
    dataDirectory,
    store,
    task,
    workspaceRoot: snapshot.root,
  });
}
