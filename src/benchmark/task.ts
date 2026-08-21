/**
 * 已完成真实 Pi 任务的 token 与自主闭环分析器。
 *
 * 分析器只读取 task.json、低敏 events.jsonl 和 Pi session JSONL 的结构化元数据；
 * 不把用户消息、模型正文、工具参数或源码写入报告。它适合比较不同模型/提示/缓存策略。
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
}

interface TaskSummary {
  changedPaths: unknown[];
  checks: Array<{ status?: unknown }>;
  reproductions: unknown[];
  conclusion: unknown;
  state: unknown;
}

interface EventSummary {
  refreshes: number;
  refreshFailures: number;
  approvalRounds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageTimestamp(message: Record<string, unknown>): number | null {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : null;
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

async function aggregateSessions(taskDirectory: string): Promise<SessionAggregate> {
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
  };
  const sessionDirectory = join(taskDirectory, "pi");
  const files = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
  let lastToolSignature = "";
  let consecutiveToolCalls = 0;
  for (const file of files.sort()) {
    const entries = await readJsonLines(join(sessionDirectory, file));
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      const message = entry.message;
      if (message.role === "user") {
        aggregate.userTurns += 1;
        if (isNaturalLanguageUserMessage(message)) aggregate.naturalLanguageTurns += 1;
        const timestamp = messageTimestamp(message);
        if (timestamp !== null) {
          aggregate.firstUserTimestamp = aggregate.firstUserTimestamp === null
            ? timestamp
            : Math.min(aggregate.firstUserTimestamp, timestamp);
        }
        lastToolSignature = "";
        consecutiveToolCalls = 0;
        continue;
      }
      if (message.role === "toolResult") {
        // finish 的工具结果会通过 Shell 的 notify/结论栏直接呈现给用户；
        // 它不是普通模型正文，但应计入“有可见终结答复”的闭环指标。
        if (message.toolName === "finish") {
          aggregate.terminalAssistantTurns += 1;
          if (hasVisibleText(message)) aggregate.visibleTerminalTurns += 1;
          const timestamp = messageTimestamp(message);
          if (timestamp !== null) {
            aggregate.lastTerminalTimestamp = aggregate.lastTerminalTimestamp === null
              ? timestamp
              : Math.max(aggregate.lastTerminalTimestamp, timestamp);
          }
        }
        continue;
      }
      if (message.role !== "assistant") continue;
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
      for (const block of blocks) {
        if (block.type !== "toolCall") continue;
        aggregate.toolCalls += 1;
        const toolName = typeof block.name === "string" ? block.name : "";
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
      const timestamp = messageTimestamp(message);
      if (timestamp !== null) {
        aggregate.lastTerminalTimestamp = aggregate.lastTerminalTimestamp === null
          ? timestamp
          : Math.max(aggregate.lastTerminalTimestamp, timestamp);
      }
      lastToolSignature = "";
      consecutiveToolCalls = 0;
    }
  }
  return aggregate;
}

async function readTaskSummary(taskDirectory: string): Promise<TaskSummary> {
  const value: unknown = JSON.parse(await readFile(join(taskDirectory, "task.json"), "utf8"));
  if (!isRecord(value)) throw new Error("benchmark task.json 不是对象");
  return {
    changedPaths: Array.isArray(value.changedPaths) ? value.changedPaths : [],
    checks: Array.isArray(value.checks) ? value.checks.filter(isRecord) : [],
    reproductions: Array.isArray(value.reproductions) ? value.reproductions : [],
    conclusion: value.conclusion,
    state: value.state,
  };
}

async function readEventSummary(taskDirectory: string): Promise<EventSummary> {
  const entries = await readJsonLines(join(taskDirectory, "events.jsonl"));
  let refreshes = 0;
  let refreshFailures = 0;
  let approvalRounds = 0;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.type === "game.refresh") {
      refreshes += 1;
      if (!isRecord(entry.detail) || entry.detail.passed !== true) refreshFailures += 1;
    }
    if (entry.type === "execution.approval") approvalRounds += 1;
    else if (
      entry.type === "task.state"
      && isRecord(entry.detail)
      && entry.detail.next === "awaiting_approval"
    ) approvalRounds += 1;
  }
  return { refreshes, refreshFailures, approvalRounds };
}

/**
 * 分析一个真实 Dungeon Maintainer task 目录。
 *
 * @param taskDirectory 包含 task.json、events.jsonl 和 pi/ 的目录。
 * @param contextWindow 本次模型注册的上下文窗口，用于 75% 安全线。
 */
export async function analyzeTaskBenchmark(
  taskDirectory: string,
  contextWindow = 64_000,
): Promise<BenchmarkScenario> {
  const directory = resolve(taskDirectory);
  const [session, task, events] = await Promise.all([
    aggregateSessions(directory),
    readTaskSummary(directory),
    readEventSummary(directory),
  ]);
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
    "任务终态：" + (typeof task.state === "string" ? task.state : "unknown"),
  ]);
}
