/**
 * 固定 7 案例游戏修复矩阵。
 *
 * 本模块为每轮创建全新 fixture、Pi session、游戏实例和（优化版）detached worktree。
 * 奇数案例先运行 Current，偶数案例先运行 Original，降低固定顺序带来的冷热启动偏差。
 * 所有单轮结果由 agent-eval-runner 按任务 Oracle 判卷；矩阵只做低敏汇总，不读取模型正文或隐藏答案。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AGENT_EVAL_ORACLE_VERSION,
  runAgentEvalPreflight,
  runGameRepairEval,
  type AgentEvalPreflightResult,
  type GameRepairEvalProfile,
  type GameRepairEvalResult,
} from "./agent-eval-runner.js";
import { readGameBenchmarkCatalog } from "./agent-eval-case.js";
import type { BenchmarkProgressEvent } from "./progress.js";
import {
  collectBenchmarkRunIdentity,
  type BenchmarkRunIdentity,
} from "./provenance.js";

/** 内置 fixture 的固定测试顺序；正式矩阵由游戏 Adapter catalog 提供同一清单。 */
export const GAME_REPAIR_FIXTURE_IDS = [
  "terminal-action-bug",
  "accepted-query-without-progress",
  "final-stage-boss-stuck-at-one-hp",
  "admin-floor-transition-deadlock",
  "transition-lost-after-reload",
  "stale-query-plan-evidence",
  "duplicate-final-victory-commit",
] as const;

/** 当前 1.0 中用于快速回归的四个高风险案例。 */
export const GAME_REPAIR_REGRESSION_FIXTURE_IDS = [
  "admin-floor-transition-deadlock",
  "transition-lost-after-reload",
  "stale-query-plan-evidence",
  "duplicate-final-victory-commit",
] as const;

export type GameRepairSuite = "full" | "four-regressions";

/** 正式矩阵可运行的 Profile 范围；`both` 保持原有公平对比行为。 */
export type GameRepairMatrixProfile = GameRepairEvalProfile | "both";

/** 固定矩阵运行参数。 */
export interface GameRepairMatrixOptions {
  readonly dependencyRepoRoot: string;
  readonly archiveRoot: string;
  /** 仅供仓库内 fixture 聚焦测试注入；正式 CLI 不暴露此入口。 */
  readonly fixtureRoot?: string;
  readonly repetitions: number;
  readonly timeoutMs?: number;
  /** 省略时默认运行双方，避免改变正式 Benchmark 的既有语义。 */
  readonly profile?: GameRepairMatrixProfile;
  /** `full` 运行 7 项；`four-regressions` 只运行当前四个高风险案例。 */
  readonly suite?: GameRepairSuite;
  /** 正式运行 worker 数；每个 worker 仍使用独立临时仓库和运行时。 */
  readonly concurrency?: number;
  /** 可选的已有矩阵归档；提供后复用其中的预检和已完成单题。 */
  readonly resumeDirectory?: string;
  readonly onProgress?: (event: BenchmarkProgressEvent) => void;
}

/** 7 个零 Token 预检的低敏汇总。 */
export interface GameRepairPreflightMatrixResult {
  readonly schemaVersion: 2;
  readonly status: "passed" | "failed";
  readonly runFingerprint: string;
  readonly gameSourceFingerprint: string;
  readonly archiveDirectory: string;
  readonly results: readonly AgentEvalPreflightResult[];
}

async function runPreflights(
  options: Omit<GameRepairMatrixOptions, "repetitions" | "profile">,
  archiveRoot: string,
  fixtureIds: readonly string[],
  runIdentity: BenchmarkRunIdentity,
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
        runIdentity,
      });
    }));
    const stableResults: AgentEvalPreflightResult[] = [];
    for (const result of batchResults) {
      if (result.status !== "infra_error") {
        stableResults.push(result);
        continue;
      }
      // 并发 Chromium/Vite 的偶发页面错误顺序重试，避免同一批再次争用资源。
      stableResults.push(await runAgentEvalPreflight({
        fixtureId: result.fixtureId,
        dependencyRepoRoot: options.dependencyRepoRoot,
        archiveRoot,
        ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        runIdentity,
      }));
    }
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
  results: readonly GameRepairEvalResult[],
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
  readonly status: GameRepairEvalResult["status"];
  readonly agentOutcome: Pick<GameRepairEvalResult["agentOutcome"], "status">;
  readonly workflowClosure: Pick<GameRepairEvalResult["workflowClosure"], "paused">;
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

/** 7 × 所选 Profile 数 × repetitions 次正式运行的描述性矩阵报告。 */
export interface GameRepairMatrixResult {
  readonly schemaVersion: 4;
  readonly status: "passed" | "failed";
  readonly runFingerprint: string;
  readonly gameSourceFingerprint: string;
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
  readonly results: readonly GameRepairEvalResult[];
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

async function resolveMatrixBenchmarkSource(
  options: Pick<GameRepairMatrixOptions, "dependencyRepoRoot" | "fixtureRoot">,
): Promise<{
  readonly fixtureIds: readonly string[];
  readonly gameSourceFingerprint: string;
}> {
  if (options.fixtureRoot) {
    // 仅供仓库内 fixture 聚焦测试注入；正式 CLI 不暴露 fixtureRoot。
    return {
      fixtureIds: GAME_REPAIR_FIXTURE_IDS,
      gameSourceFingerprint: createHash("sha256")
        .update("internal-test-fixtures:")
        .update(resolve(options.fixtureRoot))
        .digest("hex"),
    };
  }
  const catalog = await readGameBenchmarkCatalog({
    gameRepositoryRoot: options.dependencyRepoRoot,
  });
  return {
    fixtureIds: catalog.fixtureIds,
    gameSourceFingerprint: catalog.sourceFingerprint,
  };
}

function matrixJobKey(input: {
  fixtureId: string;
  profile: GameRepairEvalProfile;
  repetition: number;
}): string {
  return input.fixtureId + ":" + input.profile + ":" + String(input.repetition);
}

/** 可恢复矩阵的低敏 checkpoint；不包含 Prompt、源码或隐藏 Oracle。 */
export interface MatrixCheckpoint {
  readonly schemaVersion: 2;
  readonly runFingerprint: string;
  readonly profile: GameRepairMatrixProfile;
  readonly suite: GameRepairSuite;
  readonly repetitions: number;
  readonly expectedRuns: number;
  readonly results: readonly GameRepairEvalResult[];
  readonly runFailures: readonly GameRepairMatrixResult["runFailures"][number][];
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length
    && keys.every((key) => Object.hasOwn(record, key))
    ? record
    : null;
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableNonNegativeNumber(value: unknown): boolean {
  return value === null || nonNegativeNumber(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nullableStringRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(nullableString);
}

const ORACLE_DIAGNOSTIC_KEYS = [
  "oracle",
  "finalStepIndex",
  "finalOp",
  "finalEvent",
  "finalFloor",
  "finalMode",
  "finalAdvanced",
  "finalBossDefeated",
  "finalClaimableReward",
  "finalVictories",
  "reloadObserved",
  "stepEvents",
  "queryEvents",
  "planClasses",
] as const;

function isCurrentOracleDiagnostic(value: unknown): boolean {
  if (value === null) return true;
  const diagnostic = exactRecord(value, ORACLE_DIAGNOSTIC_KEYS);
  return diagnostic !== null
    && typeof diagnostic.oracle === "string"
    && (diagnostic.finalStepIndex === null || Number.isSafeInteger(diagnostic.finalStepIndex))
    && (
      diagnostic.finalOp === null
      || diagnostic.finalOp === "go"
      || diagnostic.finalOp === "use"
      || diagnostic.finalOp === "input-sql"
      || diagnostic.finalOp === "query"
      || diagnostic.finalOp === "reload"
      || diagnostic.finalOp === "wait"
    )
    && nullableString(diagnostic.finalEvent)
    && nullableNonNegativeNumber(diagnostic.finalFloor)
    && nullableString(diagnostic.finalMode)
    && nullableBoolean(diagnostic.finalAdvanced)
    && nullableBoolean(diagnostic.finalBossDefeated)
    && nullableString(diagnostic.finalClaimableReward)
    && nullableNonNegativeNumber(diagnostic.finalVictories)
    && typeof diagnostic.reloadObserved === "boolean"
    && stringArray(diagnostic.stepEvents)
    && stringArray(diagnostic.queryEvents)
    && stringArray(diagnostic.planClasses);
}

const WORKFLOW_CLOSURE_KEYS = [
  "applicable",
  "taskState",
  "proposed",
  "executed",
  "writeAttempted",
  "retainedChanges",
  "verified",
  "readyToApply",
  "paused",
] as const;

const TASK_STATES = new Set([
  "created",
  "active",
  "awaiting_approval",
  "verifying",
  "paused",
  "ready_to_apply",
  "applied",
  "blocked",
  "discarded",
]);

function isCurrentWorkflowClosure(value: unknown): boolean {
  const closure = exactRecord(value, WORKFLOW_CLOSURE_KEYS);
  return closure !== null
    && typeof closure.applicable === "boolean"
    && (closure.taskState === null
      || (typeof closure.taskState === "string" && TASK_STATES.has(closure.taskState)))
    && nullableBoolean(closure.proposed)
    && nullableBoolean(closure.executed)
    && nullableBoolean(closure.writeAttempted)
    && nullableBoolean(closure.retainedChanges)
    && nullableBoolean(closure.verified)
    && nullableBoolean(closure.readyToApply)
    && nullableBoolean(closure.paused);
}

const AGENT_OUTCOME_NUMBER_KEYS = [
  "durationMs",
  "turns",
  "toolCalls",
  "diagnosticToolCalls",
  "readCalls",
  "writeCalls",
  "consecutiveDuplicateToolCalls",
  "piMessageQueuePeak",
  "taskQueuePeak",
  "episodes",
  "recoveries",
  "inspectCalls",
  "inspectExecutions",
  "inspectReceiptHits",
  "semanticEvidenceHits",
  "solutionLookupHits",
  "inspectBundles",
  "inspectBundleWindows",
  "inspectFailures",
  "inspectCandidateFiles",
  "inspectSelectedFiles",
  "routedSearchExpansions",
  "featureRoutedInspectCalls",
  "featureRoutePrimaryExecutions",
  "featureRouteAdjacentExecutions",
  "featureRouteSharedExecutions",
  "featureRouteFallbackExecutions",
  "floorRoutedInspectCalls",
  "floorScopesVisited",
  "floorRouteCurrentExecutions",
  "floorRouteAdjacentExecutions",
  "floorRouteSharedExecutions",
  "floorRouteFallbackExecutions",
  "writeAttempts",
  "writeRejected",
  "writeFailures",
  "writeNoops",
  "writeMutations",
  "writeReplayFailures",
  "loopGuardBlocks",
  "telemetryParseErrors",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "cacheHitRate",
  "uncachedTokens",
  "assistantTextOmittedCharacters",
  "totalDurationMs",
  "beforeActionCount",
  "afterActionCount",
  "browserErrorCount",
  "changedFileCount",
] as const;

const AGENT_OUTCOME_KEYS = [
  "status",
  "diagnosisMs",
  "contextTokens",
  "contextPercent",
  "failureCode",
  "changedPaths",
  "changedPathDigests",
  ...AGENT_OUTCOME_NUMBER_KEYS,
] as const;

function isCurrentAgentOutcome(value: unknown): boolean {
  const outcome = exactRecord(value, AGENT_OUTCOME_KEYS);
  if (!outcome) return false;
  return (
    outcome.status === "settled"
    || outcome.status === "timeout"
    || outcome.status === "infra_error"
  )
    && AGENT_OUTCOME_NUMBER_KEYS.every((key) => nonNegativeNumber(outcome[key]))
    && nullableNonNegativeNumber(outcome.diagnosisMs)
    && nullableNonNegativeNumber(outcome.contextTokens)
    && nullableNonNegativeNumber(outcome.contextPercent)
    && nullableString(outcome.failureCode)
    && stringArray(outcome.changedPaths)
    && nullableStringRecord(outcome.changedPathDigests);
}

const PROVENANCE_KEYS = [
  "runFingerprint",
  "benchmarkCommit",
  "benchmarkWorktreeHash",
  "gameSourceFingerprint",
  "oracleVersion",
  "piSourceRepository",
  "piSourceTag",
  "piSourceCommit",
  "piPackageName",
  "piVersion",
  "piPackageIntegrity",
  "piCliHash",
  "fixtureHash",
  "agentsHash",
  "skillManifestHash",
  "publicPromptHash",
  "promptHash",
  "toolsetHash",
  "modelId",
  "modelConfigHash",
] as const;

function isCurrentProvenance(value: unknown, runFingerprint: string): boolean {
  if (value === null) return true;
  const provenance = exactRecord(value, PROVENANCE_KEYS);
  return provenance !== null
    && PROVENANCE_KEYS.every((key) => typeof provenance[key] === "string")
    && provenance.runFingerprint === runFingerprint;
}

function isCurrentEvidenceGraph(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => {
    const evidence = exactRecord(entry, ["id", "kind", "status", "links", "worktreeHash"]);
    return evidence !== null
      && typeof evidence.id === "string"
      && typeof evidence.kind === "string"
      && typeof evidence.status === "string"
      && stringArray(evidence.links)
      && nullableString(evidence.worktreeHash);
  });
}

function isCurrentGameRepairResult(
  value: unknown,
  runFingerprint: string,
): value is GameRepairEvalResult {
  const result = exactRecord(value, [
    "schemaVersion",
    "runId",
    "fixtureId",
    "profile",
    "repetition",
    "status",
    "failureClass",
    "externalCorrectness",
    "workflowClosure",
    "agentOutcome",
    "judgeOutcome",
    "modelId",
    "provenance",
    "agentFailureCode",
    "judgeFailureCode",
    "diagnostics",
    "archivePath",
  ]);
  if (!result) return false;
  const external = exactRecord(result.externalCorrectness, [
    "initialFailureMatched",
    "afterOracleMatched",
    "forbiddenPathsUntouched",
    "headUnchanged",
  ]);
  const judge = exactRecord(result.judgeOutcome, [
    "status",
    "externalCorrectnessPassed",
    "workflowClosurePassed",
  ]);
  const diagnostics = exactRecord(result.diagnostics, [
    "beforeOracle",
    "afterOracle",
    "lastToolName",
    "lastFinishStatus",
    "evidenceGraph",
  ]);
  return result.schemaVersion === 5
    && typeof result.runId === "string"
    && result.runId.length > 0
    && typeof result.fixtureId === "string"
    && result.fixtureId.length > 0
    && (result.profile === "pi-original" || result.profile === "maintainer-current")
    && Number.isSafeInteger(result.repetition)
    && (result.repetition as number) >= 1
    && (result.status === "passed" || result.status === "failed" || result.status === "infra_error")
    && (
      result.failureClass === "none"
      || result.failureClass === "agent"
      || result.failureClass === "oracle"
      || result.failureClass === "infrastructure"
    )
    && external !== null
    && typeof external.initialFailureMatched === "boolean"
    && nullableBoolean(external.afterOracleMatched)
    && nullableBoolean(external.forbiddenPathsUntouched)
    && nullableBoolean(external.headUnchanged)
    && isCurrentWorkflowClosure(result.workflowClosure)
    && isCurrentAgentOutcome(result.agentOutcome)
    && judge !== null
    && (judge.status === "passed" || judge.status === "failed" || judge.status === "infra_error")
    && typeof judge.externalCorrectnessPassed === "boolean"
    && nullableBoolean(judge.workflowClosurePassed)
    && nullableString(result.modelId)
    && isCurrentProvenance(result.provenance, runFingerprint)
    && nullableString(result.agentFailureCode)
    && nullableString(result.judgeFailureCode)
    && diagnostics !== null
    && isCurrentOracleDiagnostic(diagnostics.beforeOracle)
    && isCurrentOracleDiagnostic(diagnostics.afterOracle)
    && nullableString(diagnostics.lastToolName)
    && nullableString(diagnostics.lastFinishStatus)
    && isCurrentEvidenceGraph(diagnostics.evidenceGraph)
    && nullableString(result.archivePath);
}

function isCurrentRunFailure(value: unknown): boolean {
  const failure = exactRecord(value, ["fixtureId", "profile", "repetition", "code"]);
  return failure !== null
    && typeof failure.fixtureId === "string"
    && (failure.profile === "pi-original" || failure.profile === "maintainer-current")
    && Number.isSafeInteger(failure.repetition)
    && (failure.repetition as number) >= 1
    && typeof failure.code === "string";
}

/** 仅同一运行身份和同一矩阵参数可以复用 checkpoint。 */
export function matrixCheckpointIsCompatible(
  checkpoint: unknown,
  expected: {
    readonly runFingerprint: string;
    readonly profile: GameRepairMatrixProfile;
    readonly suite: GameRepairSuite;
    readonly repetitions: number;
    readonly expectedRuns: number;
  },
): checkpoint is MatrixCheckpoint {
  const value = exactRecord(checkpoint, [
    "schemaVersion",
    "runFingerprint",
    "profile",
    "suite",
    "repetitions",
    "expectedRuns",
    "results",
    "runFailures",
  ]);
  return value !== null
    && value.schemaVersion === 2
    && typeof value.runFingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(value.runFingerprint)
    && (value.profile === "both"
      || value.profile === "pi-original"
      || value.profile === "maintainer-current")
    && (value.suite === "full" || value.suite === "four-regressions")
    && Number.isSafeInteger(value.repetitions)
    && (value.repetitions as number) >= 1
    && Number.isSafeInteger(value.expectedRuns)
    && (value.expectedRuns as number) >= 0
    && Array.isArray(value.results)
    && value.results.every((result) => isCurrentGameRepairResult(result, expected.runFingerprint))
    && Array.isArray(value.runFailures)
    && value.runFailures.every(isCurrentRunFailure)
    && value.runFingerprint === expected.runFingerprint
    && value.profile === expected.profile
    && value.suite === expected.suite
    && value.repetitions === expected.repetitions
    && value.expectedRuns === expected.expectedRuns;
}

async function writeMatrixCheckpoint(
  archiveDirectory: string,
  checkpoint: MatrixCheckpoint,
): Promise<void> {
  const target = join(archiveDirectory, "checkpoint.json");
  const temporary = target + ".tmp-" + randomUUID();
  await writeFile(temporary, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  await rename(temporary, target);
}

async function readMatrixCheckpoint(path: string): Promise<MatrixCheckpoint | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = exactRecord(parsed, [
      "schemaVersion",
      "runFingerprint",
      "profile",
      "suite",
      "repetitions",
      "expectedRuns",
      "results",
      "runFailures",
    ]);
    if (
      value === null
      || typeof value.runFingerprint !== "string"
      || (value.profile !== "both"
        && value.profile !== "pi-original"
        && value.profile !== "maintainer-current")
      || (value.suite !== "full" && value.suite !== "four-regressions")
      || !Number.isSafeInteger(value.repetitions)
      || !Number.isSafeInteger(value.expectedRuns)
      || !matrixCheckpointIsCompatible(value, {
        runFingerprint: value.runFingerprint,
        profile: value.profile,
        suite: value.suite,
        repetitions: value.repetitions as number,
        expectedRuns: value.expectedRuns as number,
      })
    ) return null;
    return value;
  } catch {
    return null;
  }
}

async function readSavedPreflights(
  archiveDirectory: string,
  fixtureIds: readonly string[],
  runFingerprint: string,
): Promise<AgentEvalPreflightResult[] | null> {
  const entries: AgentEvalPreflightResult[] = [];
  for (const fixtureId of fixtureIds) {
    try {
      const parsed: unknown = JSON.parse(await readFile(
        join(archiveDirectory, "preflight", fixtureId + "-preflight.json"),
        "utf8",
      ));
      if (!parsed || typeof parsed !== "object") return null;
      if (!isCurrentPreflightResult(parsed, fixtureId, runFingerprint)) return null;
      entries.push(parsed);
    } catch {
      return null;
    }
  }
  return entries;
}

function isCurrentPreflightCertificate(value: unknown, runFingerprint: string): boolean {
  const certificate = exactRecord(value, [
    "schemaVersion",
    "fixtureId",
    "buggyHead",
    "dependencyKey",
    "oracleVersion",
    "runFingerprint",
    "beforeOracleMatched",
    "cleanAfterOracleMatched",
  ]);
  return certificate !== null
    && certificate.schemaVersion === 2
    && typeof certificate.fixtureId === "string"
    && /^[0-9a-f]{40}$/u.test(String(certificate.buggyHead))
    && typeof certificate.dependencyKey === "string"
    && /^[0-9a-f]{16}$/u.test(certificate.dependencyKey)
    && typeof certificate.oracleVersion === "string"
    && certificate.oracleVersion === AGENT_EVAL_ORACLE_VERSION
    && certificate.runFingerprint === runFingerprint
    && certificate.beforeOracleMatched === true
    && certificate.cleanAfterOracleMatched === true;
}

function isCurrentPreflightDiagnostic(value: unknown): boolean {
  const diagnostic = exactRecord(value, [
    "oracle",
    "finalStepIndex",
    "finalOp",
    "finalEvent",
    "finalFloor",
    "finalMode",
    "finalAdvanced",
    "finalBossDefeated",
    "finalClaimableReward",
    "finalVictories",
    "reloadObserved",
    "stepEvents",
    "queryEvents",
    "planClasses",
  ]);
  return diagnostic !== null
    && typeof diagnostic.oracle === "string"
    && (diagnostic.finalStepIndex === null || Number.isSafeInteger(diagnostic.finalStepIndex))
    && nullableString(diagnostic.finalEvent)
    && nullableNonNegativeNumber(diagnostic.finalFloor)
    && nullableString(diagnostic.finalMode)
    && nullableBoolean(diagnostic.finalAdvanced)
    && nullableBoolean(diagnostic.finalBossDefeated)
    && nullableString(diagnostic.finalClaimableReward)
    && nullableNonNegativeNumber(diagnostic.finalVictories)
    && typeof diagnostic.reloadObserved === "boolean"
    && stringArray(diagnostic.stepEvents)
    && stringArray(diagnostic.queryEvents)
    && stringArray(diagnostic.planClasses);
}

function isCurrentPreflightResult(
  value: unknown,
  fixtureId: string,
  runFingerprint: string,
): value is AgentEvalPreflightResult {
  const entry = exactRecord(value, [
    "schemaVersion",
    "fixtureId",
    "runFingerprint",
    "status",
    "initialFailureMatched",
    "cleanBaselineMatched",
    "certificate",
    "beforeDiagnostic",
    "cleanDiagnostic",
    "actionCount",
    "durationMs",
    "browserErrorCount",
    "failureCode",
    "archivePath",
  ]);
  return entry !== null
    && entry.schemaVersion === 3
    && entry.fixtureId === fixtureId
    && entry.runFingerprint === runFingerprint
    && (entry.status === "passed" || entry.status === "failed" || entry.status === "infra_error")
    && typeof entry.initialFailureMatched === "boolean"
    && typeof entry.cleanBaselineMatched === "boolean"
    && (entry.certificate === null || isCurrentPreflightCertificate(entry.certificate, runFingerprint))
    && (entry.beforeDiagnostic === null || isCurrentPreflightDiagnostic(entry.beforeDiagnostic))
    && (entry.cleanDiagnostic === null || isCurrentPreflightDiagnostic(entry.cleanDiagnostic))
    && nonNegativeNumber(entry.actionCount)
    && nonNegativeNumber(entry.durationMs)
    && nonNegativeNumber(entry.browserErrorCount)
    && nullableString(entry.failureCode)
    && nullableString(entry.archivePath)
    && (entry.status !== "passed" || entry.certificate !== null);
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

function summarizeEfficiency(results: readonly GameRepairEvalResult[]): PairedEfficiencySummary {
  const pairs = new Map<string, Partial<Record<GameRepairEvalProfile, GameRepairEvalResult>>>();
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

/** 串行运行全部 7 个零 Token 初始故障预检。 */
export async function runGameRepairPreflightMatrix(
  options: Omit<GameRepairMatrixOptions, "repetitions" | "profile">,
): Promise<GameRepairPreflightMatrixResult> {
  const archiveDirectory = uniqueArchiveDirectory(options.archiveRoot, "preflight");
  await mkdir(archiveDirectory, { recursive: true });
  const source = await resolveMatrixBenchmarkSource(options);
  const runIdentity = await collectBenchmarkRunIdentity({
    gameSourceFingerprint: source.gameSourceFingerprint,
    oracleVersion: AGENT_EVAL_ORACLE_VERSION,
  });
  const results = await runPreflights(
    options,
    archiveDirectory,
    source.fixtureIds,
    runIdentity,
    options.onProgress,
    options.concurrency ?? 1,
  );
  const result: GameRepairPreflightMatrixResult = {
    schemaVersion: 2,
    status: results.every((entry) => entry.status === "passed") ? "passed" : "failed",
    runFingerprint: runIdentity.runFingerprint,
    gameSourceFingerprint: runIdentity.gameSourceFingerprint,
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

/** 运行预检后以隔离 worker 执行固定的 7 × 所选 Profile 数 × repetitions 正式矩阵。 */
export async function runGameRepairMatrix(
  options: GameRepairMatrixOptions,
): Promise<GameRepairMatrixResult> {
  const selectedProfile = options.profile ?? "both";
  const source = await resolveMatrixBenchmarkSource(options);
  const runIdentity = await collectBenchmarkRunIdentity({
    gameSourceFingerprint: source.gameSourceFingerprint,
    oracleVersion: AGENT_EVAL_ORACLE_VERSION,
  });
  const fullFixtureIds = source.fixtureIds;
  const fixtureIds = options.suite === "four-regressions"
    ? fullFixtureIds.filter((fixtureId) => GAME_REPAIR_REGRESSION_FIXTURE_IDS.includes(fixtureId as never))
    : fullFixtureIds;
  const selectedProfileCount = selectedProfile === "both" ? 2 : 1;
  const requestedConcurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const archiveDirectory = options.resumeDirectory
    ? resolve(options.resumeDirectory)
    : uniqueArchiveDirectory(options.archiveRoot, "matrix");
  await mkdir(archiveDirectory, { recursive: true });
  const preflightResults = options.resumeDirectory
    ? await readSavedPreflights(
      archiveDirectory,
      fixtureIds,
      runIdentity.runFingerprint,
    )
      ?? await runPreflights(
        options,
        join(archiveDirectory, "preflight"),
        fixtureIds,
        runIdentity,
        options.onProgress,
        requestedConcurrency,
      )
    : await runPreflights(
      options,
      join(archiveDirectory, "preflight"),
      fixtureIds,
      runIdentity,
      options.onProgress,
      requestedConcurrency,
    );
  const certificates = new Map(preflightResults.flatMap((entry) => (
    entry.certificate ? [[entry.fixtureId, entry.certificate] as const] : []
  )));
  const preflightPassed = preflightResults.every((entry) => entry.status === "passed");
  const priorCheckpoint = options.resumeDirectory
    ? await readMatrixCheckpoint(join(archiveDirectory, "checkpoint.json"))
    : null;
  const checkpointMatches = matrixCheckpointIsCompatible(priorCheckpoint, {
    runFingerprint: runIdentity.runFingerprint,
    profile: selectedProfile,
    suite: options.suite ?? "full",
    repetitions: options.repetitions,
    expectedRuns: fixtureIds.length * selectedProfileCount * options.repetitions,
  });
  const results: GameRepairEvalResult[] = checkpointMatches
    ? [...priorCheckpoint.results]
    : [];
  const runFailures: GameRepairMatrixResult["runFailures"][number][] = checkpointMatches
    ? [...priorCheckpoint.runFailures]
    : [];
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
    const completedKeys = new Set([
      ...results.map((result) => matrixJobKey(result)),
      ...runFailures.map((failure) => matrixJobKey(failure)),
    ]);
    const pendingJobs = jobs.filter((job) => !completedKeys.has(matrixJobKey(job)));
    let nextJob = 0;
    const workerCount = Math.min(requestedConcurrency, pendingJobs.length);
    let checkpointWrite = Promise.resolve();
    const persistCheckpoint = (): Promise<void> => {
      checkpointWrite = checkpointWrite.then(() => writeMatrixCheckpoint(archiveDirectory, {
        schemaVersion: 2,
        runFingerprint: runIdentity.runFingerprint,
        profile: selectedProfile,
        suite: options.suite ?? "full",
        repetitions: options.repetitions,
        expectedRuns: jobs.length,
        results,
        runFailures,
      }));
      return checkpointWrite;
    };
    await persistCheckpoint();
    const totals = () => ({
      completed: results.length + runFailures.length,
      cumulativeTokens: results.reduce((sum, item) => sum + item.agentOutcome.totalTokens, 0),
      cumulativeToolCalls: results.reduce((sum, item) => sum + item.agentOutcome.toolCalls, 0),
    });
    const runWorker = async (workerId: number): Promise<void> => {
      while (nextJob < pendingJobs.length) {
        const job = pendingJobs[nextJob];
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
            runIdentity,
            ...(profile === "maintainer-current" ? { onLiveEvent: (event: { kind: "tool"; toolName: string } | { kind: "assistant"; text: string }) => {
              if (event.kind === "tool") publish("running", { liveKind: "tool", toolName: event.toolName });
              else publish("running", { liveKind: "assistant", assistantText: event.text });
            } } : {}),
          });
          results.push(run);
          await persistCheckpoint();
          publish(run.status === "passed" ? "passed" : "failed", { liveKind: "finish" });
        } catch (error) {
          runFailures.push({ fixtureId, profile, repetition, code: safeCode(error) });
          await persistCheckpoint();
          publish("failed", { liveKind: "finish" });
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index + 1)));
    await checkpointWrite;
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
    schemaVersion: 4,
    status: summary.status,
    runFingerprint: runIdentity.runFingerprint,
    gameSourceFingerprint: runIdentity.gameSourceFingerprint,
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
