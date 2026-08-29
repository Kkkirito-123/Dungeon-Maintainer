/** EvalSuite 的低敏汇总与 Profile 效率比较。 */

import type { EvalRunProfile, EvalRunResult } from "../execution/run.js";

export interface PairedEfficiencySummary {
  readonly pairedSuccessCases: number;
  readonly maintainerMinusBaseline: {
    readonly totalTokens: number | null;
    readonly toolCalls: number | null;
    readonly inspectCalls: number | null;
    readonly readCalls: number | null;
    readonly diagnosisMs: number | null;
    readonly totalDurationMs: number | null;
  };
}

export interface MaintainerInspectSummary {
  readonly calls: number;
  readonly executions: number;
  readonly receiptHits: number;
  readonly receiptRatio: number;
}

/** 一整套 Eval 的 Agent、外部 Oracle、工具与时间汇总。 */
export interface EvalUsageSummary {
  readonly agentTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly sumAgentDurationMs: number;
  readonly sumOracleDurationMs: number;
  readonly sumRunDurationMs: number;
  readonly suiteWallDurationMs: number;
}

/**
 * 汇总用户关心的 Token、工具调用和时间，不读取模型正文或工具参数。
 *
 * @param results 已完成的低敏场景结果。
 * @param suiteWallDurationMs 从 Suite 开始到汇总的墙钟时间。
 * @returns Agent Token、工具次数，以及 Agent、Oracle、Run、Suite 的明确耗时口径。
 */
export function summarizeEvalUsage(
  results: readonly EvalRunResult[],
  suiteWallDurationMs: number,
): EvalUsageSummary {
  const agentTokens = results.reduce(
    (sum, result) => sum + result.agentResult.totalTokens,
    0,
  );
  return {
    agentTokens,
    totalTokens: agentTokens,
    toolCalls: results.reduce((sum, result) => sum + result.agentResult.toolCalls, 0),
    sumAgentDurationMs: results.reduce(
      (sum, result) => sum + result.agentResult.durationMs,
      0,
    ),
    sumOracleDurationMs: results.reduce(
      (sum, result) => sum + result.oracleOutcome.durationMs,
      0,
    ),
    sumRunDurationMs: results.reduce(
      (sum, result) => sum + result.agentResult.totalDurationMs,
      0,
    ),
    suiteWallDurationMs: Math.max(0, Math.round(suiteWallDurationMs)),
  };
}

export function summarizeMaintainerInspect(
  results: readonly EvalRunResult[],
): MaintainerInspectSummary {
  const current = results.filter((result) => result.profile === "maintainer");
  const calls = current.reduce((sum, result) => sum + result.agentResult.inspectCalls, 0);
  const executions = current.reduce(
    (sum, result) => sum + result.agentResult.inspectExecutions,
    0,
  );
  const receiptHits = current.reduce(
    (sum, result) => sum + result.agentResult.inspectReceiptHits,
    0,
  );
  return {
    calls,
    executions,
    receiptHits,
    receiptRatio: calls > 0 ? Math.round((receiptHits / calls) * 10_000) / 10_000 : 0,
  };
}

/** 单个 Profile 的最终外部结果计数。 */
export interface EvalSuiteResultSummary {
  readonly passed: number;
  readonly failed: number;
  readonly infraError: number;
}

/** 单个 Profile 的运行收尾诊断；不参与功能成功判定。 */
export interface EvalSuiteRunSummary {
  readonly settled: number;
  readonly paused: number;
  readonly timeout: number;
  readonly infraError: number;
}

type EvalSuiteRunCategory = "infraError" | "timeout" | "paused" | "settled";

interface ClassifiableEvalRunResult {
  readonly profile: EvalRunProfile;
  readonly status: EvalRunResult["status"];
  readonly agentResult: Pick<EvalRunResult["agentResult"], "status">;
  readonly workflowClosure: Pick<EvalRunResult["workflowClosure"], "paused">;
}

function classifyEvalSuiteRun(
  result: ClassifiableEvalRunResult,
): EvalSuiteRunCategory {
  if (result.status === "infra_error" || result.agentResult.status === "infra_error") {
    return "infraError";
  }
  if (result.agentResult.status === "timeout") return "timeout";
  if (result.workflowClosure.paused === true) return "paused";
  return "settled";
}

/**
 * 按互斥优先级汇总 EvalSuite 结果，并判定整套评测是否完整通过。
 *
 * @param input 预检状态、期望运行数、已返回结果和未返回结果的运行错误。
 * @returns 各 Profile 的互斥计数，以及仅在全部期望运行都通过时为 `passed` 的总状态。
 */
export function summarizeEvalSuiteRuns(input: {
  readonly expectedRuns: number;
  readonly results: readonly ClassifiableEvalRunResult[];
  readonly runFailures: readonly { readonly profile: EvalRunProfile }[];
}): {
  readonly status: "passed" | "failed";
  readonly byProfile: Readonly<Record<EvalRunProfile, EvalSuiteResultSummary>>;
  readonly runByProfile: Readonly<Record<EvalRunProfile, EvalSuiteRunSummary>>;
} {
  const byProfile = {
    "pi-baseline": { passed: 0, failed: 0, infraError: 0 },
    maintainer: { passed: 0, failed: 0, infraError: 0 },
  } satisfies Record<EvalRunProfile, EvalSuiteResultSummary>;
  const runByProfile = {
    "pi-baseline": { settled: 0, paused: 0, timeout: 0, infraError: 0 },
    maintainer: { settled: 0, paused: 0, timeout: 0, infraError: 0 },
  } satisfies Record<EvalRunProfile, EvalSuiteRunSummary>;
  for (const result of input.results) {
    if (result.status === "passed") byProfile[result.profile].passed += 1;
    else if (result.status === "failed") byProfile[result.profile].failed += 1;
    else byProfile[result.profile].infraError += 1;
    runByProfile[result.profile][classifyEvalSuiteRun(result)] += 1;
  }
  for (const failure of input.runFailures) {
    byProfile[failure.profile].infraError += 1;
    runByProfile[failure.profile].infraError += 1;
  }
  const allExpectedRunsPassed = input.results.length === input.expectedRuns
    && input.runFailures.length === 0
    && input.results.every((result) => result.status === "passed");
  return {
    status: allExpectedRunsPassed ? "passed" : "failed",
    byProfile,
    runByProfile,
  };
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function summarizeEfficiency(
  results: readonly EvalRunResult[],
): PairedEfficiencySummary {
  const pairs = new Map<string, Partial<Record<EvalRunProfile, EvalRunResult>>>();
  for (const result of results) {
    const key = result.scenarioId + ":" + String(result.repetition);
    const pair = pairs.get(key) ?? {};
    pair[result.profile] = result;
    pairs.set(key, pair);
  }
  const deltas = {
    totalTokens: [] as number[],
    toolCalls: [] as number[],
    inspectCalls: [] as number[],
    readCalls: [] as number[],
    diagnosisMs: [] as number[],
    totalDurationMs: [] as number[],
  };
  let pairedSuccessCases = 0;
  for (const pair of pairs.values()) {
    const current = pair.maintainer;
    const original = pair["pi-baseline"];
    if (
      !current
      || !original
      || current.status !== "passed"
      || original.status !== "passed"
      || current.agentResult.status !== "settled"
      || original.agentResult.status !== "settled"
      || current.workflowClosure.paused === true
      || original.workflowClosure.paused === true
    ) continue;
    pairedSuccessCases += 1;
    deltas.totalTokens.push(current.agentResult.totalTokens - original.agentResult.totalTokens);
    deltas.toolCalls.push(current.agentResult.toolCalls - original.agentResult.toolCalls);
    deltas.inspectCalls.push(current.agentResult.inspectCalls - original.agentResult.inspectCalls);
    deltas.readCalls.push(current.agentResult.readCalls - original.agentResult.readCalls);
    if (current.agentResult.diagnosisMs !== null && original.agentResult.diagnosisMs !== null) {
      deltas.diagnosisMs.push(current.agentResult.diagnosisMs - original.agentResult.diagnosisMs);
    }
    deltas.totalDurationMs.push(
      current.agentResult.totalDurationMs - original.agentResult.totalDurationMs,
    );
  }
  return {
    pairedSuccessCases,
    maintainerMinusBaseline: {
      totalTokens: average(deltas.totalTokens),
      toolCalls: average(deltas.toolCalls),
      inspectCalls: average(deltas.inspectCalls),
      readCalls: average(deltas.readCalls),
      diagnosisMs: average(deltas.diagnosisMs),
      totalDurationMs: average(deltas.totalDurationMs),
    },
  };
}
