/**
 * 固定 Dataset 的 EvalSuite 编排。
 *
 * Suite 只决定场景顺序、Profile、并发和断点恢复。每个 Run 自己创建 Workspace、Pi
 * session、端口与浏览器上下文；Worker 之间唯一共享的是只读 Dataset 和串行 checkpoint。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_EVAL_DATASET_ID,
  readEvalDataset,
} from "../domain/dataset.js";
import { EVAL_ORACLE_VERSION } from "../domain/oracle.js";
import { runEvalPreflight, type EvalPreflightResult } from "./preflight.js";
import { runEvalScenario, type EvalRunProfile, type EvalRunResult } from "./run.js";
import type { EvalProgressEvent } from "./progress.js";
import { collectEvalRunIdentity, type EvalRunIdentity } from "../reporting/identity.js";
import {
  evalSuiteCheckpointIsCompatible,
  readEvalSuiteCheckpoint,
  writeEvalSuiteCheckpoint,
} from "../reporting/checkpoint.js";
import {
  summarizeEfficiency,
  summarizeEvalUsage,
  summarizeEvalSuiteRuns,
  summarizeMaintainerInspect,
  type EvalSuiteResultSummary,
  type EvalSuiteRunSummary,
  type EvalUsageSummary,
  type MaintainerInspectSummary,
  type PairedEfficiencySummary,
} from "../reporting/report.js";

/** Suite 可运行的 Profile；`both` 只用于公平对比。 */
export type EvalSuiteProfile = EvalRunProfile | "both";

/** 固定 EvalSuite 参数。 */
export interface EvalSuiteOptions {
  readonly dependencyRepoRoot: string;
  readonly archiveRoot: string;
  readonly datasetId?: string;
  /** Dataset 父目录，仅供仓库测试注入。 */
  readonly datasetsRoot?: string;
  readonly repetitions: number;
  readonly timeoutMs?: number;
  readonly profile?: EvalSuiteProfile;
  /** 并行 Worker 数，范围 1..4；单 Profile 默认 2，对比默认 1。 */
  readonly workers?: number;
  readonly resumeDirectory?: string;
  readonly onProgress?: (event: EvalProgressEvent) => void;
}

/** 预检报告。 */
export interface EvalSuitePreflightResult {
  readonly schemaVersion: 3;
  readonly status: "passed" | "failed";
  readonly datasetId: string;
  readonly datasetFingerprint: string;
  readonly runFingerprint: string;
  readonly archiveDirectory: string;
  readonly results: readonly EvalPreflightResult[];
}

/** 完整 Suite 报告。 */
export interface EvalSuiteResult {
  readonly schemaVersion: 7;
  readonly status: "passed" | "failed";
  readonly datasetId: string;
  readonly datasetFingerprint: string;
  readonly runFingerprint: string;
  readonly repetitions: number;
  readonly profile: EvalSuiteProfile;
  readonly workers: number;
  readonly timingComparable: boolean;
  readonly archiveDirectory: string;
  readonly expectedRuns: number;
  readonly completedRuns: number;
  readonly runFailures: readonly EvalRunFailure[];
  readonly results: readonly EvalRunResult[];
  readonly byProfile: Readonly<Record<EvalRunProfile, EvalSuiteResultSummary>>;
  readonly runByProfile: Readonly<Record<EvalRunProfile, EvalSuiteRunSummary>>;
  readonly efficiency: PairedEfficiencySummary;
  readonly maintainerInspect: MaintainerInspectSummary;
  readonly usage: EvalUsageSummary;
  readonly note: string;
}

interface EvalRunFailure {
  readonly scenarioId: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
  readonly code: string;
}

interface EvalSuiteJob {
  readonly scenarioId: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
  readonly order: number;
}

type EvalSuiteJobIdentity = Pick<
  EvalSuiteJob,
  "scenarioId" | "profile" | "repetition"
>;

/** 校验并限制 Worker 数。 */
export function normalizeEvalWorkers(value: number | undefined, fallback: number): number {
  const workers = value ?? fallback;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 4) {
    throw new Error("Eval workers 必须在 1 至 4 之间");
  }
  return workers;
}

/**
 * 用固定数量 Worker 消费任务，并按输入顺序返回 settled 结果。
 * 单个任务失败不会取消其它任务；调用方不需要处理并发写入。
 */
export async function runEvalWorkerPool<T, R>(
  items: readonly T[],
  workers: number,
  execute: (item: T, workerId: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const workerCount = Math.min(normalizeEvalWorkers(workers, 1), Math.max(items.length, 1));
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const runWorker = async (workerId: number): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = { status: "fulfilled", value: await execute(item, workerId) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index + 1)));
  return results;
}

/** 双 Profile 时交替先后顺序，降低固定冷热启动偏差。 */
export function evalSuiteProfiles(
  profile: EvalSuiteProfile,
  scenarioIndex: number,
): readonly EvalRunProfile[] {
  if (profile !== "both") return [profile];
  return scenarioIndex % 2 === 0
    ? ["maintainer", "pi-baseline"]
    : ["pi-baseline", "maintainer"];
}

function uniqueArchiveDirectory(root: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return join(resolve(root), label + "-" + stamp + "-" + randomUUID().slice(0, 8));
}

function jobKey(input: Pick<EvalSuiteJob, "scenarioId" | "profile" | "repetition">): string {
  return input.scenarioId + ":" + input.profile + ":" + String(input.repetition);
}

/** 恢复时只有已产出功能结论的 job 可跳过；所有基础设施失败必须重跑。 */
export function pendingEvalSuiteJobs<T extends EvalSuiteJobIdentity>(
  jobs: readonly T[],
  completedResults: readonly (EvalSuiteJobIdentity & Pick<EvalRunResult, "status">)[],
): T[] {
  const completedKeys = new Set(
    completedResults.filter((result) => result.status !== "infra_error").map(jobKey),
  );
  return jobs.filter((job) => !completedKeys.has(jobKey(job)));
}

function runFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "suite-run-error";
  const text = error.message.toLowerCase();
  if (text.includes("api key") || text.includes("鉴权")) return "model-auth-unavailable";
  if (text.includes("scenario") || text.includes("dataset")) return "scenario-invalid";
  return "suite-run-error";
}

function failedPreflight(
  scenarioId: string,
  runFingerprint: string,
  error: unknown,
): EvalPreflightResult {
  return {
    schemaVersion: 3,
    scenarioId,
    runFingerprint,
    status: "infra_error",
    initialFailureMatched: false,
    cleanBaselineMatched: false,
    certificate: null,
    beforeDiagnostic: null,
    cleanDiagnostic: null,
    actionCount: 0,
    durationMs: 0,
    browserErrorCount: 0,
    failureCode: runFailureCode(error),
    archivePath: null,
  };
}

async function runEvalPreflights(input: {
  readonly options: Omit<EvalSuiteOptions, "repetitions" | "profile">;
  readonly datasetRoot: string;
  readonly scenarioIds: readonly string[];
  readonly archiveRoot: string;
  readonly runIdentity: EvalRunIdentity;
}): Promise<EvalPreflightResult[]> {
  const startedAt = new Date().toISOString();
  let completed = 0;
  const workers = Math.min(normalizeEvalWorkers(input.options.workers, 2), 2);
  const settled = await runEvalWorkerPool(input.scenarioIds, workers, async (scenarioId, workerId) => {
    input.options.onProgress?.({ phase: "preflight", scenarioId, profile: null, repetition: null,
      completed, total: input.scenarioIds.length, status: "running", cumulativeTokens: 0,
      cumulativeToolCalls: 0, startedAt, workerId, workerCount: workers });
    try {
      let result = await runEvalPreflight({
        scenarioId,
        datasetRoot: input.datasetRoot,
        datasetFingerprint: input.runIdentity.datasetFingerprint,
        dependencyRepoRoot: input.options.dependencyRepoRoot,
        archiveRoot: input.archiveRoot,
        ...(input.options.timeoutMs === undefined ? {} : { timeoutMs: input.options.timeoutMs }),
        runIdentity: input.runIdentity,
      });
      if (result.status === "infra_error") {
        result = await runEvalPreflight({
          scenarioId,
          datasetRoot: input.datasetRoot,
          datasetFingerprint: input.runIdentity.datasetFingerprint,
          dependencyRepoRoot: input.options.dependencyRepoRoot,
          archiveRoot: input.archiveRoot,
          ...(input.options.timeoutMs === undefined ? {} : { timeoutMs: input.options.timeoutMs }),
          runIdentity: input.runIdentity,
        });
      }
      return result;
    } finally {
      completed += 1;
    }
  });
  return settled.map((entry, index) => entry.status === "fulfilled"
    ? entry.value
    : failedPreflight(input.scenarioIds[index] ?? "unknown", input.runIdentity.runFingerprint, entry.reason));
}

/** 运行 Dataset 的零模型预检；最多使用两个 Worker。 */
export async function runEvalSuitePreflight(
  options: Omit<EvalSuiteOptions, "repetitions" | "profile">,
): Promise<EvalSuitePreflightResult> {
  const dataset = await readEvalDataset(
    options.datasetId ?? DEFAULT_EVAL_DATASET_ID,
    options.datasetsRoot,
  );
  const archiveDirectory = uniqueArchiveDirectory(options.archiveRoot, "preflight");
  await mkdir(archiveDirectory, { recursive: true });
  const runIdentity = await collectEvalRunIdentity({
    datasetFingerprint: dataset.fingerprint,
    oracleVersion: EVAL_ORACLE_VERSION,
  });
  const results = await runEvalPreflights({
    options,
    datasetRoot: dataset.root,
    scenarioIds: dataset.scenarioIds,
    archiveRoot: archiveDirectory,
    runIdentity,
  });
  const output: EvalSuitePreflightResult = {
    schemaVersion: 3,
    status: results.every((entry) => entry.status === "passed") ? "passed" : "failed",
    datasetId: dataset.id,
    datasetFingerprint: dataset.fingerprint,
    runFingerprint: runIdentity.runFingerprint,
    archiveDirectory,
    results,
  };
  await writeFile(join(archiveDirectory, "summary.json"), JSON.stringify({
    ...output,
    archiveDirectory: null,
    results: results.map((entry) => ({ ...entry, archivePath: null })),
  }, null, 2) + "\n", "utf8");
  return output;
}

/** 运行 Dataset 中的全部场景；浏览器预检仅由显式命令单独执行。 */
export async function runEvalSuite(options: EvalSuiteOptions): Promise<EvalSuiteResult> {
  const suiteStartedAt = performance.now();
  const selectedProfile = options.profile ?? "maintainer";
  const workers = normalizeEvalWorkers(options.workers, selectedProfile === "both" ? 1 : 2);
  const dataset = await readEvalDataset(
    options.datasetId ?? DEFAULT_EVAL_DATASET_ID,
    options.datasetsRoot,
  );
  const runIdentity = await collectEvalRunIdentity({
    datasetFingerprint: dataset.fingerprint,
    oracleVersion: EVAL_ORACLE_VERSION,
  });
  const selectedProfileCount = selectedProfile === "both" ? 2 : 1;
  const expectedRuns = dataset.scenarioIds.length * selectedProfileCount * options.repetitions;
  const archiveDirectory = options.resumeDirectory
    ? resolve(options.resumeDirectory)
    : uniqueArchiveDirectory(options.archiveRoot, "suite");
  await mkdir(archiveDirectory, { recursive: true });
  const priorCheckpoint = options.resumeDirectory
    ? await readEvalSuiteCheckpoint(join(archiveDirectory, "checkpoint.json"))
    : null;
  const checkpointMatches = evalSuiteCheckpointIsCompatible(priorCheckpoint, {
    runFingerprint: runIdentity.runFingerprint,
    datasetId: dataset.id,
    profile: selectedProfile,
    repetitions: options.repetitions,
    expectedRuns,
    scenarioIds: dataset.scenarioIds,
  });
  const results: EvalRunResult[] = checkpointMatches
    ? priorCheckpoint.results.filter((result) => result.status !== "infra_error")
    : [];
  // 无论基础设施故障是否已包装成 RunResult，resume 都重新执行，而不是永久跳过。
  const runFailures: EvalRunFailure[] = [];
  const jobs: EvalSuiteJob[] = [];
  for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    for (let index = 0; index < dataset.scenarioIds.length; index += 1) {
      const scenarioId = dataset.scenarioIds[index];
      if (!scenarioId) continue;
      for (const profile of evalSuiteProfiles(selectedProfile, index)) {
        jobs.push({ scenarioId, profile, repetition, order: jobs.length });
      }
    }
  }
  const order = new Map(jobs.map((job) => [jobKey(job), job.order]));
  const sortByOrder = <T extends Pick<EvalSuiteJob, "scenarioId" | "profile" | "repetition">>(
    entries: T[],
  ): T[] => entries.sort((left, right) => (order.get(jobKey(left)) ?? 0) - (order.get(jobKey(right)) ?? 0));
  let checkpointWrite = Promise.resolve();
  const persistCheckpoint = (): Promise<void> => {
    const resultSnapshot = sortByOrder([...results]);
    const failureSnapshot = sortByOrder([...runFailures]);
    checkpointWrite = checkpointWrite.then(() => writeEvalSuiteCheckpoint(archiveDirectory, {
      schemaVersion: 3,
      runFingerprint: runIdentity.runFingerprint,
      datasetId: dataset.id,
      profile: selectedProfile,
      repetitions: options.repetitions,
      expectedRuns,
      results: resultSnapshot,
      runFailures: failureSnapshot,
    }));
    return checkpointWrite;
  };
  const pendingJobs = pendingEvalSuiteJobs(jobs, results);
  await persistCheckpoint();
  const totals = () => ({
    completed: results.length + runFailures.length,
    cumulativeTokens: results.reduce((sum, item) => sum + item.agentResult.totalTokens, 0),
    cumulativeToolCalls: results.reduce((sum, item) => sum + item.agentResult.toolCalls, 0),
  });
  await runEvalWorkerPool(pendingJobs, workers, async (job, workerId) => {
    const startedAt = new Date().toISOString();
    const publish = (
      status: EvalProgressEvent["status"],
      live: Partial<Pick<EvalProgressEvent, "liveKind" | "toolName" | "assistantText">> = {},
    ): void => options.onProgress?.({ phase: "run", scenarioId: job.scenarioId,
      profile: job.profile, repetition: job.repetition, ...totals(), total: jobs.length,
      status, startedAt, workerId, workerCount: workers, ...live });
    publish("running", { liveKind: "start", toolName: null, assistantText: "" });
    try {
      const run = await runEvalScenario({
        scenarioId: job.scenarioId,
        datasetRoot: dataset.root,
        datasetFingerprint: dataset.fingerprint,
        dependencyRepoRoot: options.dependencyRepoRoot,
        profile: job.profile,
        repetition: job.repetition,
        archiveRoot: join(archiveDirectory, "runs"),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        runIdentity,
        ...(job.profile === "maintainer" ? { onLiveEvent: (event: { kind: "tool"; toolName: string } | { kind: "assistant"; text: string }) => {
          if (event.kind === "tool") publish("running", { liveKind: "tool", toolName: event.toolName });
          else publish("running", { liveKind: "assistant", assistantText: event.text });
        } } : {}),
      });
      results.push(run);
      await persistCheckpoint();
      publish(run.status === "passed" ? "passed" : "failed", { liveKind: "finish" });
    } catch (error) {
      runFailures.push({
        scenarioId: job.scenarioId,
        profile: job.profile,
        repetition: job.repetition,
        code: runFailureCode(error),
      });
      await persistCheckpoint();
      publish("failed", { liveKind: "finish" });
    }
  });
  await checkpointWrite;
  sortByOrder(results);
  sortByOrder(runFailures);
  const summary = summarizeEvalSuiteRuns({ expectedRuns, results, runFailures });
  const output: EvalSuiteResult = {
    schemaVersion: 7,
    status: summary.status,
    datasetId: dataset.id,
    datasetFingerprint: dataset.fingerprint,
    runFingerprint: runIdentity.runFingerprint,
    repetitions: options.repetitions,
    profile: selectedProfile,
    workers,
    timingComparable: workers === 1,
    archiveDirectory,
    expectedRuns,
    completedRuns: results.length,
    runFailures,
    results,
    byProfile: summary.byProfile,
    runByProfile: summary.runByProfile,
    efficiency: summarizeEfficiency(results),
    maintainerInspect: summarizeMaintainerInspect(results),
    usage: summarizeEvalUsage(results, performance.now() - suiteStartedAt),
    note: workers === 1
      ? "Agent 正常结束后由一次独立浏览器 Oracle 判定功能；单 Worker 的耗时可用于 Profile 对比。"
      : "每个 Run 只执行一次独立浏览器 Oracle；多 Worker 会共享本机资源，因此耗时不用于 Profile 对比。",
  };
  await writeFile(join(archiveDirectory, "summary.json"), JSON.stringify({
    ...output,
    archiveDirectory: null,
    results: results.map((entry) => ({ ...entry, archivePath: null })),
  }, null, 2) + "\n", "utf8");
  options.onProgress?.({ phase: "complete", scenarioId: null, profile: selectedProfile,
    repetition: null, completed: results.length + runFailures.length, total: expectedRuns,
    status: output.status, cumulativeTokens: output.usage.totalTokens,
    cumulativeToolCalls: results.reduce((sum, item) => sum + item.agentResult.toolCalls, 0),
    startedAt: new Date().toISOString(), workerId: null, workerCount: workers });
  return output;
}
