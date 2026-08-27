/**
 * 已完成真实 Pi 任务的 token、自主闭环与续跑浪费分析器。
 *
 * 职责：只读汇总 task.json、低敏 events.jsonl 和 Pi session JSONL 的结构化元数据，
 * 计算缓存、工具、诊断时延、自动续跑及任务终态后的额外消耗。非职责：本模块不恢复任务、
 * 不调度 Pi、不判断修复内容是否正确，也不修改游戏仓库或维护器状态。
 *
 * 输入是一个既有任务目录和模型上下文窗口，输出是可机器判定的 BenchmarkScenario。
 * 相邻边界由 TaskStore 保证 task/events 格式，由 Pi 会话存储提供 message/custom_message
 * 信封；本模块只做容错读取，损坏 JSONL 行会被忽略，缺失必需文件则把文件错误交给调用方。
 *
 * 唯一副作用是读取本地文件；不需要写权限、模型权限、游戏权限或网络权限。报告只保留数量、
 * 时间和 token 合计，不复制用户正文、模型正文、工具参数、源码、SQL、证据正文或凭据。
 * 若任务目录不完整，应修复或重新导出该任务后重跑 Benchmark，而不是从会话正文猜测缺失事实。
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { taskRecordIsCurrent } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { metric, scenario, type BenchmarkScenario } from "./types.js";

interface SessionAggregate {
  userTurns: number;
  naturalLanguageTurns: number;
  terminalAssistantTurns: number;
  visibleTerminalTurns: number;
  thinkingOnlyLengthTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  maxConsecutiveIdenticalToolCalls: number;
  maxPromptTokens: number;
  firstUserTimestamp: number | null;
  lastTerminalTimestamp: number | null;
  automaticContinuationIds: Set<string>;
  inferredAdmittedContinuationIds: Set<string>;
  anonymousAutomaticContinuations: number;
  postTerminalModelTurns: number;
  postTerminalToolCalls: number;
  tokensAfterTerminal: number;
  duplicateFinishSubmissions: number;
  semanticDuplicateResults: number;
  inspectAttemptsToProposal: number;
  diagnosisMs: number;
}

interface TaskSummary {
  changedPaths: string[];
  checks: Array<{ status?: unknown }>;
  reproductions: unknown[];
  conclusion: string | null;
  state: TaskRecord["state"];
}

interface EventSummary {
  refreshes: number;
  refreshFailures: number;
  approvalRounds: number;
  terminalTimestamp: number | null;
  continuationCreatedIds: Set<string>;
  continuationAdmittedIds: Set<string>;
  staleContinuationIds: Set<string>;
  anonymousContinuationsCreated: number;
  anonymousContinuationsAdmitted: number;
  anonymousStaleContinuations: number;
}

interface EvidenceSummaryRecord {
  kind?: unknown;
  status?: unknown;
  metadata?: unknown;
}

interface ToolCallObservation {
  sequence: number;
  timestamp: number | null;
  name: string;
  finishStatus: string | null;
}

const TERMINAL_TASK_STATES = new Set([
  "ready_to_apply",
  "applied",
  "blocked",
  "discarded",
]);

const AUTOMATIC_CUSTOM_MESSAGE_TYPES = new Set([
  "dungeon-repair-follow-up",
  "dungeon-budget-follow-up",
  "dungeon-refresh-recovery",
]);

const CONTINUATION_KINDS = new Set([
  "repair",
  "budget",
  "refresh-recovery",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function entryTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown> | null = null,
): number | null {
  return timestamp(entry.timestamp) ?? timestamp(message?.timestamp);
}

function contentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? message.content.filter(isRecord)
    : [];
}

function hasVisibleText(message: Record<string, unknown>): boolean {
  return contentBlocks(message).some((block) => (
    block.type === "text"
    && typeof block.text === "string"
    && block.text.trim().length > 0
  ));
}

function isNaturalLanguageUserMessage(message: Record<string, unknown>): boolean {
  const text = contentBlocks(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("")
    .trim();
  return text.length > 0 && !text.startsWith("/");
}

function continuationIdentity(entry: Record<string, unknown>): string | null {
  const details = isRecord(entry.details) ? entry.details : null;
  return nonEmptyString(details?.continuationId) ?? nonEmptyString(entry.id);
}

function isAutomaticCustomMessage(entry: Record<string, unknown>): boolean {
  if (entry.type !== "custom_message") return false;
  const details = isRecord(entry.details) ? entry.details : null;
  return nonEmptyString(details?.continuationId) !== null
    || CONTINUATION_KINDS.has(nonEmptyString(details?.kind) ?? "")
    || AUTOMATIC_CUSTOM_MESSAGE_TYPES.has(nonEmptyString(entry.customType) ?? "");
}

function finishStatusFromToolCall(block: Record<string, unknown>): string | null {
  const args = isRecord(block.arguments) ? block.arguments : null;
  return nonEmptyString(args?.status);
}

function toolResultSemanticKeys(message: Record<string, unknown>): string[] {
  const details = isRecord(message.details) ? message.details : null;
  const keys: string[] = [];
  const evidenceId = nonEmptyString(details?.evidenceId);
  if (evidenceId) keys.push("evidence\0" + evidenceId);
  const status = message.toolName === "finish"
    ? nonEmptyString(details?.status)
    : null;
  if (status) keys.push("finish\0" + status);
  return keys;
}

function totalUsageTokens(usage: Record<string, unknown>): number {
  return numeric(usage.input)
    + numeric(usage.output)
    + numeric(usage.cacheRead)
    + numeric(usage.cacheWrite);
}

function countUnion(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
  return new Set([...first, ...second]).size;
}

async function readJsonLines(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // 损坏行不进入指标；任务完整性会由既有 TaskStore/会话恢复检查单独阻断。
    }
  }
  return values;
}

async function aggregateSessions(
  taskDirectory: string,
  terminalTimestamp: number | null,
): Promise<SessionAggregate> {
  const aggregate: SessionAggregate = {
    userTurns: 0,
    naturalLanguageTurns: 0,
    terminalAssistantTurns: 0,
    visibleTerminalTurns: 0,
    thinkingOnlyLengthTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
    maxConsecutiveIdenticalToolCalls: 0,
    maxPromptTokens: 0,
    firstUserTimestamp: null,
    lastTerminalTimestamp: null,
    automaticContinuationIds: new Set<string>(),
    inferredAdmittedContinuationIds: new Set<string>(),
    anonymousAutomaticContinuations: 0,
    postTerminalModelTurns: 0,
    postTerminalToolCalls: 0,
    tokensAfterTerminal: 0,
    duplicateFinishSubmissions: 0,
    semanticDuplicateResults: 0,
    inspectAttemptsToProposal: 0,
    diagnosisMs: 0,
  };
  const sessionDirectory = join(taskDirectory, "pi");
  const files = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
  const customMessageIdentities = new Map<string, string>();
  const automaticAssistantParents = new Set<string>();
  const seenFinishStatuses = new Set<string>();
  const seenSemanticResults = new Set<string>();
  const toolObservations: ToolCallObservation[] = [];
  let lastToolSignature = "";
  let consecutiveToolCalls = 0;
  let toolSequence = 0;
  for (const file of files.sort()) {
    const entries = await readJsonLines(join(sessionDirectory, file));
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (isAutomaticCustomMessage(entry)) {
        const identity = continuationIdentity(entry);
        if (identity) aggregate.automaticContinuationIds.add(identity);
        else aggregate.anonymousAutomaticContinuations += 1;
        const entryId = nonEmptyString(entry.id);
        if (entryId && identity) customMessageIdentities.set(entryId, identity);
        continue;
      }
      if (entry.type !== "message" || !isRecord(entry.message)) continue;
      const message = entry.message;
      const currentTimestamp = entryTimestamp(entry, message);
      if (message.role === "user") {
        aggregate.userTurns += 1;
        if (isNaturalLanguageUserMessage(message)) aggregate.naturalLanguageTurns += 1;
        if (currentTimestamp !== null) {
          aggregate.firstUserTimestamp = aggregate.firstUserTimestamp === null
            ? currentTimestamp
            : Math.min(aggregate.firstUserTimestamp, currentTimestamp);
        }
        lastToolSignature = "";
        consecutiveToolCalls = 0;
        continue;
      }
      if (message.role === "toolResult") {
        const semanticKeys = toolResultSemanticKeys(message);
        if (semanticKeys.some((key) => seenSemanticResults.has(key))) {
          aggregate.semanticDuplicateResults += 1;
        }
        for (const key of semanticKeys) seenSemanticResults.add(key);
        // finish 的工具结果会通过 Shell 的 notify/结论栏直接呈现给用户；
        // 它不是普通模型正文，但应计入“有可见终结答复”的闭环指标。
        if (message.toolName === "finish") {
          aggregate.terminalAssistantTurns += 1;
          if (hasVisibleText(message)) aggregate.visibleTerminalTurns += 1;
          if (currentTimestamp !== null) {
            aggregate.lastTerminalTimestamp = aggregate.lastTerminalTimestamp === null
              ? currentTimestamp
              : Math.max(aggregate.lastTerminalTimestamp, currentTimestamp);
          }
        }
        continue;
      }
      if (message.role !== "assistant") continue;
      const parentId = nonEmptyString(entry.parentId);
      if (parentId) automaticAssistantParents.add(parentId);
      const usage = isRecord(message.usage) ? message.usage : {};
      const input = numeric(usage.input);
      const output = numeric(usage.output);
      const cacheRead = numeric(usage.cacheRead);
      const cacheWrite = numeric(usage.cacheWrite);
      aggregate.inputTokens += input;
      aggregate.outputTokens += output;
      aggregate.cacheReadTokens += cacheRead;
      aggregate.cacheWriteTokens += cacheWrite;
      aggregate.maxPromptTokens = Math.max(
        aggregate.maxPromptTokens,
        input + cacheRead + cacheWrite,
      );

      const blocks = contentBlocks(message);
      const afterTerminal = terminalTimestamp !== null
        && currentTimestamp !== null
        && currentTimestamp > terminalTimestamp;
      if (afterTerminal) {
        aggregate.postTerminalModelTurns += 1;
        aggregate.tokensAfterTerminal += totalUsageTokens(usage);
      }
      for (const block of blocks) {
        if (block.type !== "toolCall") continue;
        aggregate.toolCalls += 1;
        const toolName = typeof block.name === "string" ? block.name : "";
        const finishStatus = toolName === "finish"
          ? finishStatusFromToolCall(block)
          : null;
        toolSequence += 1;
        toolObservations.push({
          sequence: toolSequence,
          timestamp: currentTimestamp,
          name: toolName,
          finishStatus,
        });
        if (finishStatus) {
          if (seenFinishStatuses.has(finishStatus)) {
            aggregate.duplicateFinishSubmissions += 1;
          }
          seenFinishStatuses.add(finishStatus);
        }
        if (afterTerminal) aggregate.postTerminalToolCalls += 1;
        const signature = toolName + "\0" + JSON.stringify(block.arguments ?? null);
        if (signature === lastToolSignature) consecutiveToolCalls += 1;
        else consecutiveToolCalls = 1;
        lastToolSignature = signature;
        aggregate.maxConsecutiveIdenticalToolCalls = Math.max(
          aggregate.maxConsecutiveIdenticalToolCalls,
          consecutiveToolCalls,
        );
      }

      if (message.stopReason === "toolUse") continue;
      aggregate.terminalAssistantTurns += 1;
      if (hasVisibleText(message)) aggregate.visibleTerminalTurns += 1;
      if (message.stopReason === "length" && !hasVisibleText(message)) {
        aggregate.thinkingOnlyLengthTurns += 1;
      }
      if (currentTimestamp !== null) {
        aggregate.lastTerminalTimestamp = aggregate.lastTerminalTimestamp === null
          ? currentTimestamp
          : Math.max(aggregate.lastTerminalTimestamp, currentTimestamp);
      }
      lastToolSignature = "";
      consecutiveToolCalls = 0;
    }
  }
  for (const parentId of automaticAssistantParents) {
    const identity = customMessageIdentities.get(parentId);
    if (identity) aggregate.inferredAdmittedContinuationIds.add(identity);
  }
  const proposal = toolObservations.find((observation) => (
    observation.name === "finish" && observation.finishStatus === "proposed"
  ));
  aggregate.inspectAttemptsToProposal = toolObservations.filter((observation) => (
    observation.name === "inspect"
    && (
      !proposal
      || (
        observation.timestamp !== null
        && proposal.timestamp !== null
        && observation.timestamp <= proposal.timestamp
      )
      || (
        (observation.timestamp === null || proposal.timestamp === null)
        && observation.sequence <= proposal.sequence
      )
    )
  )).length;
  const diagnosisEnd = proposal?.timestamp ?? aggregate.lastTerminalTimestamp;
  aggregate.diagnosisMs = aggregate.firstUserTimestamp !== null && diagnosisEnd !== null
    ? Math.max(0, diagnosisEnd - aggregate.firstUserTimestamp)
    : 0;
  return aggregate;
}

async function readEvidenceSummary(taskDirectory: string): Promise<EvidenceSummaryRecord[]> {
  try {
    const text = await readFile(join(taskDirectory, "evidence.jsonl"), "utf8");
    return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        // 只读分析器忽略最后一条中断半行；不要因日志尾部损坏丢失整份报告。
        return [];
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readTaskSummary(taskDirectory: string): Promise<TaskSummary> {
  const value: unknown = JSON.parse(await readFile(join(taskDirectory, "task.json"), "utf8"));
  const taskId = isRecord(value) && typeof value.id === "string" ? value.id : "";
  if (!taskRecordIsCurrent(value, taskId)) {
    throw new Error("benchmark task.json 不是当前任务格式");
  }
  const evidence = await readEvidenceSummary(taskDirectory);
  const active = evidence.filter((record) => record.status === "active");
  const checks = active
    .filter((record) => record.kind === "check")
    .map((record) => ({
      status: isRecord(record.metadata) ? record.metadata.status : undefined,
    }));
  const reproductions = active.filter((record) => record.kind === "reproduction");
  const claims = active.filter((record) => (
    record.kind === "claim"
    && isRecord(record.metadata)
    && record.metadata.finishStatus === "result"
  ));
  return {
    changedPaths: value.changedPaths,
    checks,
    reproductions,
    conclusion: claims.length > 0 ? "result" : null,
    state: value.state,
  };
}

async function readEventSummary(taskDirectory: string): Promise<EventSummary> {
  const entries = await readJsonLines(join(taskDirectory, "events.jsonl"));
  let refreshes = 0;
  let refreshFailures = 0;
  let approvalRounds = 0;
  let terminalTimestamp: number | null = null;
  const continuationCreatedIds = new Set<string>();
  const continuationAdmittedIds = new Set<string>();
  const staleContinuationIds = new Set<string>();
  let anonymousContinuationsCreated = 0;
  let anonymousContinuationsAdmitted = 0;
  let anonymousStaleContinuations = 0;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const detail = isRecord(entry.detail) ? entry.detail : null;
    if (entry.type === "game.refresh") {
      refreshes += 1;
      if (detail?.passed !== true) refreshFailures += 1;
    }
    if (entry.type === "execution.approval") approvalRounds += 1;
    else if (
      entry.type === "task.state"
      && detail?.next === "awaiting_approval"
    ) approvalRounds += 1;
    if (
      entry.type === "task.state"
      && TERMINAL_TASK_STATES.has(nonEmptyString(detail?.next) ?? "")
    ) {
      const stateTimestamp = timestamp(entry.at);
      if (stateTimestamp !== null) {
        terminalTimestamp = terminalTimestamp === null
          ? stateTimestamp
          : Math.min(terminalTimestamp, stateTimestamp);
      }
    }
    if (
      entry.type !== "continuation.queued"
      && entry.type !== "continuation.admitted"
      && entry.type !== "continuation.stale"
    ) continue;
    const identity = nonEmptyString(detail?.continuationId);
    if (entry.type === "continuation.queued") {
      if (identity) continuationCreatedIds.add(identity);
      else anonymousContinuationsCreated += 1;
    } else if (entry.type === "continuation.admitted") {
      if (identity) continuationAdmittedIds.add(identity);
      else anonymousContinuationsAdmitted += 1;
    } else if (identity) {
      staleContinuationIds.add(identity);
    } else {
      anonymousStaleContinuations += 1;
    }
  }
  return {
    refreshes,
    refreshFailures,
    approvalRounds,
    terminalTimestamp,
    continuationCreatedIds,
    continuationAdmittedIds,
    staleContinuationIds,
    anonymousContinuationsCreated,
    anonymousContinuationsAdmitted,
    anonymousStaleContinuations,
  };
}

/**
 * 分析一个真实 Dungeon Maintainer task 目录。
 *
 * @param taskDirectory 包含 task.json、events.jsonl 和 pi/ 的目录。
 * @param contextWindow 本次模型注册的上下文窗口，用于 75% 安全线。
 * @returns 只含数值、布尔判定和低敏摘要的真实任务场景。
 * @throws 任务目录、task.json、events.jsonl 或 pi/ 不可读时抛出文件或格式错误。
 * @remarks 本函数只有本地只读权限，不会恢复会话、调用模型、执行工具或写入任务。
 */
export async function analyzeTaskBenchmark(
  taskDirectory: string,
  contextWindow = 64_000,
): Promise<BenchmarkScenario> {
  const directory = resolve(taskDirectory);
  const [task, events] = await Promise.all([
    readTaskSummary(directory),
    readEventSummary(directory),
  ]);
  const session = await aggregateSessions(directory, events.terminalTimestamp);
  const automaticContinuationsCreated = countUnion(
    events.continuationCreatedIds,
    session.automaticContinuationIds,
  ) + events.anonymousContinuationsCreated + session.anonymousAutomaticContinuations;
  const automaticContinuationsAdmitted = countUnion(
    events.continuationAdmittedIds,
    session.inferredAdmittedContinuationIds,
  ) + events.anonymousContinuationsAdmitted;
  const staleContinuationsDropped = events.staleContinuationIds.size
    + events.anonymousStaleContinuations;
  const promptTokens = session.inputTokens + session.cacheReadTokens + session.cacheWriteTokens;
  const cacheHitRatio = promptTokens > 0 ? session.cacheReadTokens / promptTokens : 0;
  const visibleAnswerRatio = session.terminalAssistantTurns > 0
    ? session.visibleTerminalTurns / session.terminalAssistantTurns
    : 0;
  const naturalTurns = Math.max(1, session.naturalLanguageTurns);
  const freshInputPerTurn = session.inputTokens / naturalTurns;
  const outputPerTurn = session.outputTokens / naturalTurns;
  const toolCallsPerTurn = session.toolCalls / naturalTurns;
  const elapsedMs = session.firstUserTimestamp !== null && session.lastTerminalTimestamp !== null
    ? Math.max(0, session.lastTerminalTimestamp - session.firstUserTimestamp)
    : 0;
  const failedChecks = task.checks.filter((check) => check.status === "failed").length;
  const passedChecks = task.checks.filter((check) => check.status === "passed").length;
  const changed = task.changedPaths.length > 0;
  const autonomousClosure = typeof task.conclusion === "string"
    && task.conclusion.trim().length > 0
    && (!changed || (
      task.reproductions.length > 0
      && passedChecks > 0
      && events.refreshes > 0
      && events.refreshFailures === 0
    ));

  return scenario("live-task-autonomy-and-token", "live-task", [
    metric({
      name: "thinking_only_length_turns",
      value: session.thinkingOnlyLengthTurns,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "visible_terminal_answer_ratio",
      value: visibleAnswerRatio,
      unit: "ratio",
      direction: "gte",
      threshold: 0.95,
    }),
    metric({
      name: "cache_hit_ratio",
      value: cacheHitRatio,
      unit: "ratio",
      direction: "gte",
      threshold: 0.8,
    }),
    metric({
      name: "fresh_input_tokens_per_user_turn",
      value: Math.round(freshInputPerTurn),
      unit: "tokens",
      direction: "lte",
      threshold: 8_000,
    }),
    metric({
      name: "output_tokens_per_user_turn",
      value: Math.round(outputPerTurn),
      unit: "tokens",
      direction: "lte",
      threshold: 6_000,
    }),
    metric({
      name: "tool_calls_per_user_turn",
      value: Math.round(toolCallsPerTurn * 100) / 100,
      unit: "count",
      direction: "lte",
      threshold: 16,
    }),
    metric({
      name: "max_consecutive_identical_tool_calls",
      value: session.maxConsecutiveIdenticalToolCalls,
      unit: "count",
      direction: "lte",
      threshold: 2,
    }),
    metric({
      name: "automatic_continuations_created",
      value: automaticContinuationsCreated,
      unit: "count",
      direction: "lte",
      threshold: 4,
    }),
    metric({
      name: "automatic_continuations_admitted",
      value: automaticContinuationsAdmitted,
      unit: "count",
      direction: "lte",
      threshold: 4,
    }),
    metric({
      name: "stale_continuations_dropped",
      value: staleContinuationsDropped,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "post_terminal_model_turns",
      value: session.postTerminalModelTurns,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "post_terminal_tool_calls",
      value: session.postTerminalToolCalls,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "tokens_after_terminal",
      value: session.tokensAfterTerminal,
      unit: "tokens",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "duplicate_finish_submissions",
      value: session.duplicateFinishSubmissions,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "semantic_duplicate_results",
      value: session.semanticDuplicateResults,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "inspect_attempts_to_proposal",
      value: session.inspectAttemptsToProposal,
      unit: "count",
      direction: "lte",
      threshold: 10,
    }),
    metric({
      name: "diagnosis_ms",
      value: session.diagnosisMs,
      unit: "ms",
      direction: "lte",
      threshold: 300_000,
    }),
    metric({
      name: "max_prompt_tokens",
      value: session.maxPromptTokens,
      unit: "tokens",
      direction: "lte",
      threshold: Math.floor(contextWindow * 0.75),
    }),
    metric({
      name: "natural_language_followups",
      value: Math.max(0, session.naturalLanguageTurns - 1),
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "approval_rounds",
      value: events.approvalRounds,
      unit: "count",
      direction: "lte",
      threshold: changed ? 1 : 0,
    }),
    metric({
      name: "failed_check_count",
      value: failedChecks,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "refresh_replay_failure_count",
      value: events.refreshFailures,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "autonomous_closure_recorded",
      value: autonomousClosure,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
  ], [
    "会话新输入/缓存读取/输出："
      + String(session.inputTokens) + "/"
      + String(session.cacheReadTokens) + "/"
      + String(session.outputTokens),
    "自然语言轮次/工具调用/总耗时毫秒："
      + String(session.naturalLanguageTurns) + "/"
      + String(session.toolCalls) + "/"
      + String(elapsedMs),
    "自动续跑创建/准入/过期丢弃："
      + String(automaticContinuationsCreated) + "/"
      + String(automaticContinuationsAdmitted) + "/"
      + String(staleContinuationsDropped),
    "终态后模型轮次/工具调用/token："
      + String(session.postTerminalModelTurns) + "/"
      + String(session.postTerminalToolCalls) + "/"
      + String(session.tokensAfterTerminal),
    "到方案 inspect 次数/诊断毫秒："
      + String(session.inspectAttemptsToProposal) + "/"
      + String(session.diagnosisMs),
    "任务终态：" + (typeof task.state === "string" ? task.state : "unknown"),
  ]);
}
