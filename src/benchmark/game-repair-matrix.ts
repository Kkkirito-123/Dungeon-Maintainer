/**
 * 固定 12 案例游戏修复矩阵。
 *
 * 本模块为每轮创建全新 fixture、Pi session、游戏实例和（优化版）detached worktree。
 * 奇数案例先运行 Current，偶数案例先运行 Original，降低固定顺序带来的冷热启动偏差。
 * 所有单轮结果由 agent-eval-runner 按任务 Oracle 判卷；矩阵只做低敏汇总，不读取模型正文或隐藏答案。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  runAgentEvalPreflight,
  runGameRepairEval,
  type AgentEvalPreflightResult,
  type GameRepairEvalProfile,
  type GameRepairEvalResultV5,
} from "./agent-eval-runner.js";
import type { BenchmarkProgressEvent } from "./progress.js";

/** 正式对比固定使用的 12 个游戏 Bug。 */
export const GAME_REPAIR_FIXTURE_IDS = [
  "terminal-action-bug",
  "admin-answer-hint-rejected",
  "accepted-query-without-progress",
  "final-stage-boss-stuck-at-one-hp",
  "boss-hp-reset-after-death",
  "lesson-complete-reward-missing",
  "dead-area-boss-still-blocks-portal",
  "admin-floor-transition-deadlock",
  "transition-lost-after-reload",
  "transaction-sandbox-state-leak",
  "stale-query-plan-evidence",
  "duplicate-final-victory-commit",
] as const;

export const GAME_REPAIR_REGRESSION_FIXTURE_IDS = [
  "admin-floor-transition-deadlock",
  "transition-lost-after-reload",
  "transaction-sandbox-state-leak",
  "stale-query-plan-evidence",
] as const;

export type GameRepairSuite = "full" | "four-regressions";

/** 正式矩阵可运行的 Profile 范围；`both` 保持原有公平对比行为。 */
export type GameRepairMatrixProfile = GameRepairEvalProfile | "both";

/** 固定矩阵运行参数。 */
export interface GameRepairMatrixOptions {
  readonly dependencyRepoRoot: string;
  readonly archiveRoot: string;
  readonly fixtureRoot?: string;
  readonly repetitions: number;
  readonly timeoutMs?: number;
  /** 省略时默认运行双方，避免改变正式 Benchmark 的既有语义。 */
  readonly profile?: GameRepairMatrixProfile;
  readonly suite?: GameRepairSuite;
  /** 正式运行 worker 数；每个 worker 仍使用独立临时仓库和运行时。 */
  readonly concurrency?: number;
  readonly onProgress?: (event: BenchmarkProgressEvent) => void;
}

/** 12 个零 Token 预检的低敏汇总。 */
export interface GameRepairPreflightMatrixResult {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly archiveDirectory: string;
  readonly results: readonly AgentEvalPreflightResult[];
}

async function runPreflights(
  options: Omit<GameRepairMatrixOptions, "repetitions" | "profile">,
  archiveRoot: string,
  fixtureIds: readonly string[],
  onProgress?: (event: BenchmarkProgressEvent) => void,
  workerCount = 1,
): Promise<AgentEvalPreflightResult[]> {
  const results: AgentEvalPreflightResult[] = [];
  const startedAt = new Date().toISOString();
  for (let index = 0; index < fixtureIds.length; index += 2) {
    const batch = fixtureIds.slice(index, index + 2);
    const batchResults = await Promise.all(batch.map(async (fixtureId) => {
      onProgress?.({ phase: "preflight", fixtureId, profile: null, repetition: null,
        completed: results.length, total: fixtureIds.length, status: "running",
        cumulativeTokens: 0, cumulativeToolCalls: 0, startedAt,
        workerId: null, workerCount });
      return await runAgentEvalPreflight({
        fixtureId,
        dependencyRepoRoot: options.dependencyRepoRoot,
        archiveRoot,
        ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }));
    const stableResults = await Promise.all(batchResults.map(async (result) => {
      if (result.status !== "infra_error") return result;
      return await runAgentEvalPreflight({
        fixtureId: result.fixtureId,
        dependencyRepoRoot: options.dependencyRepoRoot,
        archiveRoot,
        ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }));
    results.push(...stableResults);
  }
  return results;
}

interface PairedEfficiencySummary {
  readonly pairedSuccessCases: number;
  readonly currentMinusOriginal: {
    readonly totalTokens: number | null;
    readonly toolCalls: number | null;
    readonly inspectCalls: number | null;
    readonly readCalls: number | null;
    readonly diagnosisMs: number | null;
    readonly totalDurationMs: number | null;
  };
}

interface MaintainerInspectSummary {
  readonly calls: number;
  readonly executions: number;
  readonly receiptHits: number;
  readonly routedSearchExpansions: number;
  readonly receiptRatio: number;
}

function summarizeMaintainerInspect(
  results: readonly GameRepairEvalResultV5[],
): MaintainerInspectSummary {
  const current = results.filter((result) => result.profile === "maintainer-current");
  const calls = current.reduce((sum, result) => sum + result.agentOutcome.inspectCalls, 0);
  const executions = current.reduce(
    (sum, result) => sum + result.agentOutcome.inspectExecutions,
    0,
  );
  const receiptHits = current.reduce(
    (sum, result) => sum + result.agentOutcome.inspectReceiptHits,
    0,
  );
  const routedSearchExpansions = current.reduce(
    (sum, result) => sum + result.agentOutcome.routedSearchExpansions,
    0,
  );
  return {
    calls,
    executions,
    receiptHits,
    routedSearchExpansions,
    receiptRatio: calls > 0 ? Math.round((receiptHits / calls) * 10_000) / 10_000 : 0,
  };
}

/** 单个 Profile 的最终外部结果计数。 */
export interface GameRepairMatrixOutcomeSummary {
  readonly passed: number;
  readonly failed: number;
  readonly infraError: number;
}

/** 单个 Profile 的运行收尾诊断；不参与功能成功判定。 */
export interface GameRepairMatrixRunSummary {
  readonly settled: number;
  readonly paused: number;
  readonly timeout: number;
  readonly infraError: number;
}

type GameRepairMatrixRunCategory = "infraError" | "timeout" | "paused" | "settled";

interface ClassifiableGameRepairResult {
  readonly profile: GameRepairEvalProfile;
  readonly status: GameRepairEvalResultV5["status"];
  readonly agentOutcome: Pick<GameRepairEvalResultV5["agentOutcome"], "status">;
  readonly workflowClosure: Pick<GameRepairEvalResultV5["workflowClosure"], "paused">;
}

function classifyGameRepairResult(
  result: ClassifiableGameRepairResult,
): GameRepairMatrixRunCategory {
  if (result.status === "infra_error" || result.agentOutcome.status === "infra_error") {
    return "infraError";
  }
  if (result.agentOutcome.status === "timeout") return "timeout";
  if (result.workflowClosure.paused === true) return "paused";
  return "settled";
}

/**
 * 按互斥优先级汇总矩阵结果，并判定矩阵是否完整通过。
 *
 * @param input 预检状态、期望运行数、已返回结果和未返回结果的运行错误。
 * @returns 各 Profile 的互斥计数，以及仅在全部期望运行都通过时为 `passed` 的总状态。
 */
export function summarizeGameRepairMatrixRuns(input: {
  readonly preflightPassed: boolean;
  readonly expectedRuns: number;
  readonly results: readonly ClassifiableGameRepairResult[];
  readonly runFailures: readonly { readonly profile: GameRepairEvalProfile }[];
}): {
  readonly status: GameRepairMatrixResult["status"];
  readonly byProfile: Readonly<Record<GameRepairEvalProfile, GameRepairMatrixOutcomeSummary>>;
  readonly runByProfile: Readonly<Record<GameRepairEvalProfile, GameRepairMatrixRunSummary>>;
} {
  const byProfile = {
    "pi-original": { passed: 0, failed: 0, infraError: 0 },
    "maintainer-current": { passed: 0, failed: 0, infraError: 0 },
  } satisfies Record<GameRepairEvalProfile, GameRepairMatrixOutcomeSummary>;
  const runByProfile = {
    "pi-original": { settled: 0, paused: 0, timeout: 0, infraError: 0 },
    "maintainer-current": { settled: 0, paused: 0, timeout: 0, infraError: 0 },
  } satisfies Record<GameRepairEvalProfile, GameRepairMatrixRunSummary>;
  for (const result of input.results) {
    if (result.status === "passed") byProfile[result.profile].passed += 1;
    else if (result.status === "failed") byProfile[result.profile].failed += 1;
    else byProfile[result.profile].infraError += 1;
    runByProfile[result.profile][classifyGameRepairResult(result)] += 1;
  }
  for (const failure of input.runFailures) {
    byProfile[failure.profile].infraError += 1;
    runByProfile[failure.profile].infraError += 1;
  }
  const allExpectedRunsPassed = input.results.length === input.expectedRuns
    && input.runFailures.length === 0
    && input.results.every((result) => result.status === "passed");
  return {
    status: input.preflightPassed && allExpectedRunsPassed ? "passed" : "failed",
    byProfile,
    runByProfile,
  };
}

/** 12 × 所选 Profile 数 × repetitions 次正式运行的描述性矩阵报告。 */
export interface GameRepairMatrixResult {
  readonly schemaVersion: 3;
  readonly status: "passed" | "failed";
  readonly repetitions: number;
  readonly profile: GameRepairMatrixProfile;
  readonly archiveDirectory: string;
  readonly preflightPassed: boolean;
  readonly expectedRuns: number;
  readonly completedRuns: number;
  readonly runFailures: readonly {
    fixtureId: string;
    profile: GameRepairEvalProfile;
    repetition: number;
    code: string;
  }[];
  readonly results: readonly GameRepairEvalResultV5[];
  readonly byProfile: Readonly<Record<GameRepairEvalProfile, GameRepairMatrixOutcomeSummary>>;
  readonly runByProfile: Readonly<Record<GameRepairEvalProfile, GameRepairMatrixRunSummary>>;
  readonly efficiency: PairedEfficiencySummary;
  readonly maintainerInspect: MaintainerInspectSummary;
  readonly note: string;
}

/**
 * 返回某个案例的实际运行顺序。
 *
 * 单 Profile 调试只返回指定一方；双 Profile 仍按案例奇偶交替先后顺序，降低固定
 * 冷热启动偏差。该纯函数也让 CLI 选择无需启动真实模型即可回归测试。
 */
export function gameRepairMatrixProfiles(
  profile: GameRepairMatrixProfile,
  fixtureIndex: number,
): readonly GameRepairEvalProfile[] {
  if (profile !== "both") return [profile];
  return fixtureIndex % 2 === 0
    ? ["maintainer-current", "pi-original"]
    : ["pi-original", "maintainer-current"];
}

function uniqueArchiveDirectory(root: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return join(resolve(root), label + "-" + stamp + "-" + randomUUID().slice(0, 8));
}

function safeCode(error: unknown): string {
  if (!(error instanceof Error)) return "matrix-run-error";
  const text = error.message.toLowerCase();
  if (text.includes("api key") || text.includes("鉴权")) return "model-auth-unavailable";
  if (text.includes("fixture")) return "fixture-invalid";
  return "matrix-run-error";
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function summarizeEfficiency(results: readonly GameRepairEvalResultV5[]): PairedEfficiencySummary {
  const pairs = new Map<string, Partial<Record<GameRepairEvalProfile, GameRepairEvalResultV5>>>();
  for (const result of results) {
    const key = result.fixtureId + ":" + String(result.repetition);
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
    const current = pair["maintainer-current"];
    const original = pair["pi-original"];
    if (
      !current
      || !original
      || current.status !== "passed"
      || original.status !== "passed"
      || current.agentOutcome.status !== "settled"
      || original.agentOutcome.status !== "settled"
      || current.workflowClosure.paused === true
      || original.workflowClosure.paused === true
    ) continue;
    pairedSuccessCases += 1;
    deltas.totalTokens.push(current.agentOutcome.totalTokens - original.agentOutcome.totalTokens);
    deltas.toolCalls.push(current.agentOutcome.toolCalls - original.agentOutcome.toolCalls);
    deltas.inspectCalls.push(current.agentOutcome.inspectCalls - original.agentOutcome.inspectCalls);
    deltas.readCalls.push(current.agentOutcome.readCalls - original.agentOutcome.readCalls);
    if (current.agentOutcome.diagnosisMs !== null && original.agentOutcome.diagnosisMs !== null) {
      deltas.diagnosisMs.push(current.agentOutcome.diagnosisMs - original.agentOutcome.diagnosisMs);
    }
    deltas.totalDurationMs.push(
      current.agentOutcome.totalDurationMs - original.agentOutcome.totalDurationMs,
    );
  }
  return {
    pairedSuccessCases,
    currentMinusOriginal: {
      totalTokens: average(deltas.totalTokens),
      toolCalls: average(deltas.toolCalls),
      inspectCalls: average(deltas.inspectCalls),
      readCalls: average(deltas.readCalls),
      diagnosisMs: average(deltas.diagnosisMs),
      totalDurationMs: average(deltas.totalDurationMs),
    },
  };
}

/** 串行运行全部 12 个零 Token 初始故障预检。 */
export async function runGameRepairPreflightMatrix(
  options: Omit<GameRepairMatrixOptions, "repetitions" | "profile">,
): Promise<GameRepairPreflightMatrixResult> {
  const archiveDirectory = uniqueArchiveDirectory(options.archiveRoot, "preflight");
  await mkdir(archiveDirectory, { recursive: true });
  const results = await runPreflights(
    options,
    archiveDirectory,
    GAME_REPAIR_FIXTURE_IDS,
    options.onProgress,
    options.concurrency ?? 1,
  );
  const result: GameRepairPreflightMatrixResult = {
    schemaVersion: 1,
    status: results.every((entry) => entry.status === "passed") ? "passed" : "failed",
    archiveDirectory,
    results,
  };
  await writeFile(join(archiveDirectory, "summary.json"), JSON.stringify({
    ...result,
    archiveDirectory: null,
    results: result.results.map((entry) => ({ ...entry, archivePath: null })),
  }, null, 2) + "\n", "utf8");
  return result;
}

/** 运行预检后以隔离 worker 执行固定的 12 × 所选 Profile 数 × repetitions 正式矩阵。 */
export async function runGameRepairMatrix(
  options: GameRepairMatrixOptions,
): Promise<GameRepairMatrixResult> {
  const selectedProfile = options.profile ?? "both";
  const fixtureIds = options.suite === "four-regressions"
    ? GAME_REPAIR_REGRESSION_FIXTURE_IDS
    : GAME_REPAIR_FIXTURE_IDS;
  const selectedProfileCount = selectedProfile === "both" ? 2 : 1;
  const requestedConcurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const archiveDirectory = uniqueArchiveDirectory(options.archiveRoot, "matrix");
  await mkdir(archiveDirectory, { recursive: true });
  const preflightResults = await runPreflights(
    options,
    join(archiveDirectory, "preflight"),
    fixtureIds,
    options.onProgress,
    requestedConcurrency,
  );
  const certificates = new Map(preflightResults.flatMap((entry) => (
    entry.certificate ? [[entry.fixtureId, entry.certificate] as const] : []
  )));
  const preflightPassed = preflightResults.every((entry) => entry.status === "passed");
  const results: GameRepairEvalResultV5[] = [];
  const runFailures: GameRepairMatrixResult["runFailures"][number][] = [];
  if (preflightPassed) {
    const jobs: Array<{
      fixtureId: string;
      profile: GameRepairEvalProfile;
      repetition: number;
      order: number;
    }> = [];
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (let index = 0; index < fixtureIds.length; index += 1) {
        const fixtureId = fixtureIds[index];
        if (!fixtureId) continue;
        const profiles = gameRepairMatrixProfiles(selectedProfile, index);
        for (const profile of profiles) {
          jobs.push({ fixtureId, profile, repetition, order: jobs.length });
        }
      }
    }
    let nextJob = 0;
    const workerCount = Math.min(requestedConcurrency, jobs.length);
    const totals = () => ({
      completed: results.length + runFailures.length,
      cumulativeTokens: results.reduce((sum, item) => sum + item.agentOutcome.totalTokens, 0),
      cumulativeToolCalls: results.reduce((sum, item) => sum + item.agentOutcome.toolCalls, 0),
    });
    const runWorker = async (workerId: number): Promise<void> => {
      while (nextJob < jobs.length) {
        const job = jobs[nextJob];
        nextJob += 1;
        if (!job) return;
        const { fixtureId, profile, repetition } = job;
        const runStartedAt = new Date().toISOString();
        const publish = (
          status: BenchmarkProgressEvent["status"],
          live: Partial<Pick<BenchmarkProgressEvent, "liveKind" | "toolName" | "assistantText">> = {},
        ): void => {
          options.onProgress?.({ phase: "run", fixtureId, profile, repetition,
            ...totals(), total: jobs.length, status, startedAt: runStartedAt,
            workerId, workerCount, ...live });
        };
        publish("running", { liveKind: "start", toolName: null, assistantText: "" });
        try {
          const certificate = certificates.get(fixtureId);
          const run = await runGameRepairEval({
            fixtureId,
            dependencyRepoRoot: options.dependencyRepoRoot,
            profile,
            repetition,
            archiveRoot: join(archiveDirectory, "runs"),
            ...(certificate ? { preflightCertificate: certificate } : {}),
            ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(profile === "maintainer-current" ? { onLiveEvent: (event: { kind: "tool"; toolName: string } | { kind: "assistant"; text: string }) => {
              if (event.kind === "tool") publish("running", { liveKind: "tool", toolName: event.toolName });
              else publish("running", { liveKind: "assistant", assistantText: event.text });
            } } : {}),
          });
          results.push(run);
          publish(run.status === "passed" ? "passed" : "failed", { liveKind: "finish" });
        } catch (error) {
          runFailures.push({ fixtureId, profile, repetition, code: safeCode(error) });
          publish("failed", { liveKind: "finish" });
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index + 1)));
    const jobOrder = new Map(jobs.map((job) => [
      job.fixtureId + ":" + job.profile + ":" + String(job.repetition),
      job.order,
    ]));
    results.sort((left, right) => (
      (jobOrder.get(left.fixtureId + ":" + left.profile + ":" + String(left.repetition)) ?? 0)
      - (jobOrder.get(right.fixtureId + ":" + right.profile + ":" + String(right.repetition)) ?? 0)
    ));
    runFailures.sort((left, right) => (
      (jobOrder.get(left.fixtureId + ":" + left.profile + ":" + String(left.repetition)) ?? 0)
      - (jobOrder.get(right.fixtureId + ":" + right.profile + ":" + String(right.repetition)) ?? 0)
    ));
  }
  const expectedRuns = fixtureIds.length
    * selectedProfileCount
    * options.repetitions;
  const summary = summarizeGameRepairMatrixRuns({
    preflightPassed,
    expectedRuns,
    results,
    runFailures,
  });
  const output: GameRepairMatrixResult = {
    schemaVersion: 3,
    status: summary.status,
    repetitions: options.repetitions,
    profile: selectedProfile,
    archiveDirectory,
    preflightPassed,
    expectedRuns,
    completedRuns: results.length,
    runFailures,
    results,
    byProfile: summary.byProfile,
    runByProfile: summary.runByProfile,
    efficiency: summarizeEfficiency(results),
    maintainerInspect: summarizeMaintainerInspect(results),
    note: selectedProfile === "both"
      ? "主结果只由双方相同的外部 Oracle 与安全边界决定；运行收尾和闭环单独诊断。效率差值仅包含双方功能都成功的配对案例。"
      : "单 Profile 矩阵只用于低成本调试，不生成双方效率差值，也不能替代正式公平对比。",
  };
  await writeFile(join(archiveDirectory, "summary.json"), JSON.stringify({
    ...output,
    archiveDirectory: null,
    results: output.results.map((entry) => ({ ...entry, archivePath: null })),
  }, null, 2) + "\n", "utf8");
  options.onProgress?.({ phase: "complete", fixtureId: null, profile: selectedProfile,
    repetition: null, completed: results.length, total: expectedRuns,
    status: output.status, cumulativeTokens: results.reduce((sum, item) => sum + item.agentOutcome.totalTokens, 0),
    cumulativeToolCalls: results.reduce((sum, item) => sum + item.agentOutcome.toolCalls, 0),
    startedAt: new Date().toISOString(), workerId: null,
    workerCount: Math.min(requestedConcurrency, Math.max(1, expectedRuns)) });
  return output;
}
