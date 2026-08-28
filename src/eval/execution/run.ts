/** 单个 EvalScenario 的模型运行与外部判分编排。 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  EVAL_TIMEOUT_MAX_MS,
  type EvalScenario,
} from "../domain/scenario.js";
import { runPiMaintainer, type PiMaintainerLiveEvent } from "../profiles/maintainer.js";
import {
  runPiBaseline,
} from "../profiles/pi-baseline.js";
import type {
  ProfileRunDiagnostics,
  ProfileRunMetrics,
  ProfileWorkflowClosure,
} from "../domain/result.js";
import {
  collectEvalResultIdentity,
  type EvalResultIdentity,
  type EvalRunIdentity,
} from "../reporting/identity.js";
import {
  evalFailureCode,
  provisionEvalDependencies,
  releaseEvalDependencies,
  runEvalBrowserOracle,
  type EvalDependencyLease,
  type EvalOracleDiagnostic,
} from "./browser-oracle.js";
import { EVAL_ORACLE_VERSION } from "../domain/oracle.js";
import {
  isEvalPreflightCertificateCurrent,
  loadEvalScenario,
  resolveEvalRunIdentity,
  type EvalPreflightCertificate,
} from "./preflight.js";
import { createEvalWorkspace } from "./workspace.js";

const executeFile = promisify(execFile);

/** 游戏修复 Eval 当前支持的被测 Profile。 */
export type EvalRunProfile = "pi-baseline" | "maintainer";

/** 一次真实模型游戏修复 Eval 的统一低敏结果。 */
export interface EvalRunResult {
  readonly schemaVersion: 5;
  readonly runId: string;
  readonly scenarioId: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
  readonly status: "passed" | "failed" | "infra_error";
  readonly failureClass: "none" | "agent" | "oracle" | "infrastructure";
  readonly externalCorrectness: {
    readonly initialFailureMatched: boolean;
    readonly afterOracleMatched: boolean | null;
    readonly forbiddenPathsUntouched: boolean | null;
    readonly headUnchanged: boolean | null;
  };
  readonly workflowClosure: ProfileWorkflowClosure;
  readonly agentResult: ProfileRunMetrics & {
    readonly totalDurationMs: number;
    readonly beforeActionCount: number;
    readonly afterActionCount: number;
    readonly browserErrorCount: number;
    readonly changedFileCount: number;
    readonly changedPaths: readonly string[];
    readonly changedPathDigests: Readonly<Record<string, string | null>>;
  };
  readonly judgeOutcome: {
    readonly status: "passed" | "failed" | "infra_error";
    readonly externalCorrectnessPassed: boolean;
    readonly workflowClosurePassed: boolean | null;
  };
  readonly modelId: string | null;
  readonly identity: EvalResultIdentity | null;
  readonly agentFailureCode: string | null;
  readonly judgeFailureCode: string | null;
  readonly diagnostics: {
    readonly beforeOracle: EvalOracleDiagnostic | null;
    readonly afterOracle: EvalOracleDiagnostic | null;
    readonly lastToolName: string | null;
    readonly lastFinishStatus: string | null;
    readonly evidenceGraph: ProfileRunDiagnostics["evidenceGraph"];
  };
  readonly archivePath: string | null;
}

/** 一次真实模型游戏修复 Eval 的参数。 */
export interface EvalRunOptions {
  readonly scenarioId: string;
  /** 完整 Dataset 根；省略时读取内置 eval-v1。 */
  readonly datasetRoot?: string;
  /** 已由 EvalDataset 读取器验证的完整内容指纹。 */
  readonly datasetFingerprint: string;
  readonly dependencyRepoRoot: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
  readonly archiveRoot?: string;
  readonly timeoutMs?: number;
  readonly preflightCertificate?: EvalPreflightCertificate;
  /** 与预检证书、checkpoint 和最终 EvalSuite 汇总共享的运行身份。 */
  readonly runIdentity?: EvalRunIdentity;
  /** 仅转发当前模型的可见文本和工具名，不参与判分或归档。 */
  readonly onLiveEvent?: (event: PiMaintainerLiveEvent) => void;
}

/** 把最终失败归入互斥低敏类别，避免通过错误正文猜测根因。 */
export function classifyEvalFailure(input: {
  readonly status: EvalRunResult["status"];
  readonly agentFailureCode: string | null;
  readonly workflowClosurePassed: boolean | null;
}): EvalRunResult["failureClass"] {
  if (input.status === "passed") return "none";
  if (input.status === "infra_error") return "infrastructure";
  if (input.agentFailureCode !== null || input.workflowClosurePassed === false) return "agent";
  return "oracle";
}

/**
 * 判定一次游戏修复是否通过外部任务 Oracle。
 *
 * @param input 初始故障、修复后 Oracle 与 Git 安全边界事实。
 * @returns 仅当任务故障被复现、修复后目标满足且未改提交/禁写路径时为 true；不执行测试或构建。
 */
export function evalExternalCorrectnessPassed(input: {
  readonly initialFailureMatched: boolean;
  readonly afterOracleMatched: boolean | null;
  readonly forbiddenPathsUntouched: boolean | null;
  readonly headUnchanged: boolean | null;
}): boolean {
  return input.initialFailureMatched
    && input.afterOracleMatched === true
    && input.forbiddenPathsUntouched === true
    && input.headUnchanged === true;
}

/**
 * 用同一外部结果规则判定所有 Profile；工作流闭环只保留为诊断字段。
 *
 * Pi 的 settled、Maintainer 的 ready_to_apply 和运行超时都不声明功能正确性。只要评测
 * 基础设施可用，最终状态完全由外部 Oracle 与 Git 安全边界决定。
 */
export function evalJudgeOutcome(input: {
  readonly infrastructureFailure: boolean;
  readonly externalCorrectnessPassed: boolean;
  readonly workflowClosurePassed: boolean | null;
}): EvalRunResult["judgeOutcome"] {
  const status = input.infrastructureFailure
    ? "infra_error"
    : input.externalCorrectnessPassed ? "passed" : "failed";
  return {
    status,
    externalCorrectnessPassed: input.externalCorrectnessPassed,
    workflowClosurePassed: input.workflowClosurePassed,
  };
}

async function gitOutput(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", [...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function changedPaths(repositoryRoot: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitOutput(repositoryRoot, ["diff", "--name-only", "-z", "HEAD", "--"]),
    gitOutput(repositoryRoot, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  return [...new Set((tracked + untracked).split("\0").filter(Boolean))].sort();
}

async function changedPathDigests(
  repositoryRoot: string,
  paths: readonly string[],
): Promise<Record<string, string | null>> {
  const output: Record<string, string | null> = {};
  for (const path of paths) {
    try {
      output[path] = createHash("sha256")
        .update(await readFile(join(repositoryRoot, path)))
        .digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") output[path] = null;
      else throw error;
    }
  }
  return output;
}

function touchesForbiddenPath(
  paths: readonly string[],
  forbiddenPaths: readonly string[],
): boolean {
  return paths.some((path) => forbiddenPaths.some((forbidden) => (
    path === forbidden || path.startsWith(forbidden + "/")
  )));
}

async function writeEvalRunArchive(
  archiveRoot: string | undefined,
  result: EvalRunResult,
): Promise<string | null> {
  if (!archiveRoot) return null;
  const directory = resolve(archiveRoot);
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    result.scenarioId + "-" + result.profile + "-" + String(result.repetition) + ".json",
  );
  await writeFile(path, JSON.stringify({ ...result, archivePath: null }, null, 2) + "\n", "utf8");
  return path;
}

/**
 * 运行一轮真实模型游戏修复 Eval。
 *
 * @param options 案例、依赖来源、Profile、重复编号和低敏归档目录。
 * @returns 同时包含任务正确性和模型运行指标的统一成绩单；不输出 Prompt、源码、SQL 或答案。
 * @remarks `pi-baseline` Profile 只运行原生 Pi 工具；`maintainer` 使用当前维护器。
 * 复用相同的物化、Oracle 和指标层，保证比较只改变 Agent 编排策略；代码检查由被测
 * Maintainer 内部流程或独立质量门禁负责，不在外层逐案例重复执行。
 */
export async function runEvalScenario(
  options: EvalRunOptions,
): Promise<EvalRunResult> {
  const startedAt = performance.now();
  const runId = randomUUID();
  let scenario: EvalScenario | null = null;
  let temporaryRoot: string | null = null;
  let workspaceRoot: string | null = null;
  let dependencyLease: EvalDependencyLease | null = null;
  let initialFailureMatched = false;
  let afterOracleMatched: boolean | null = null;
  let browserErrorCount = 0;
  let beforeActionCount = 0;
  let afterActionCount = 0;
  let changedFileCount = 0;
  let retainedChangedPaths: string[] = [];
  let retainedChangedPathDigests: Record<string, string | null> = {};
  let forbiddenPathsUntouched: boolean | null = null;
  let headUnchanged: boolean | null = null;
  let agentStarted = false;
  let agentStartedAt: number | null = null;
  let infrastructureFailure = false;
  let agentFailureCode: string | null = null;
  let judgeFailureCode: string | null = null;
  let beforeDiagnostic: EvalOracleDiagnostic | null = null;
  let afterDiagnostic: EvalOracleDiagnostic | null = null;
  let runDiagnostics: ProfileRunDiagnostics = {
    lastToolName: null,
    lastFinishStatus: null,
    evidenceGraph: [],
  };
  let workflowClosure: ProfileWorkflowClosure = {
    applicable: options.profile === "maintainer",
    taskState: null,
    proposed: options.profile === "maintainer" ? false : null,
    executed: options.profile === "maintainer" ? false : null,
    writeAttempted: options.profile === "maintainer" ? false : null,
    retainedChanges: options.profile === "maintainer" ? false : null,
    verified: options.profile === "maintainer" ? false : null,
    readyToApply: options.profile === "maintainer" ? false : null,
    paused: options.profile === "maintainer" ? false : null,
  };
  let identity: EvalResultIdentity | null = null;
  let runIdentity: EvalRunIdentity | null = null;
  let piMetrics: ProfileRunMetrics = {
    status: "infra_error",
    durationMs: 0,
    diagnosisMs: null,
    turns: 0,
    toolCalls: 0,
    diagnosticToolCalls: 0,
    readCalls: 0,
    writeCalls: 0,
    consecutiveDuplicateToolCalls: 0,
    piMessageQueuePeak: 0,
    inspectCalls: 0,
    inspectExecutions: 0,
    inspectReceiptHits: 0,
    semanticEvidenceHits: 0,
    inspectBundles: 0,
    inspectBundleWindows: 0,
    inspectFailures: 0,
    inspectCandidateFiles: 0,
    inspectSelectedFiles: 0,
    writeAttempts: 0,
    writeRejected: 0,
    writeFailures: 0,
    writeNoops: 0,
    writeMutations: null,
    writeReplayFailures: 0,
    telemetryParseErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    uncachedTokens: 0,
    contextTokens: null,
    contextPercent: null,
    failureCode: null,
  };
  try {
    scenario = await loadEvalScenario(options);
    runIdentity = await resolveEvalRunIdentity(options.datasetFingerprint, options.runIdentity);
    const timeoutMs = Math.min(
      options.timeoutMs ?? scenario.publicCase.timeoutMs,
      EVAL_TIMEOUT_MAX_MS,
    );
    temporaryRoot = await mkdtemp(join(tmpdir(), "dungeon-eval-"));
    workspaceRoot = join(temporaryRoot, "repository");
    await createEvalWorkspace({
      scenarioId: scenario.publicCase.scenarioId,
      ...(options.datasetRoot ? { datasetRoot: options.datasetRoot } : {}),
      destination: workspaceRoot,
    });
    dependencyLease = await provisionEvalDependencies({
      repositoryRoot: workspaceRoot,
      dependencyRepoRoot: options.dependencyRepoRoot,
    });
    const baseHead = (await gitOutput(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    if (options.preflightCertificate) {
      if (!isEvalPreflightCertificateCurrent({
        certificate: options.preflightCertificate,
        scenarioId: scenario.publicCase.scenarioId,
        buggyHead: baseHead,
        dependencyRepoRoot: options.dependencyRepoRoot,
        runFingerprint: runIdentity.runFingerprint,
      })) throw new Error("preflight-certificate-mismatch");
      initialFailureMatched = true;
    } else {
      const before = await runEvalBrowserOracle({
        repositoryRoot: workspaceRoot,
        scenario,
        phase: "before",
        timeoutMs,
      });
      initialFailureMatched = before.matched;
      beforeDiagnostic = before.diagnostic;
      beforeActionCount = before.actionCount;
      browserErrorCount += before.browserErrorCount;
      if (before.failureCode) {
        infrastructureFailure = true;
        throw new Error(before.failureCode);
      }
      if (!initialFailureMatched) {
        infrastructureFailure = true;
        throw new Error("initial-failure-not-matched");
      }
    }
    identity = await collectEvalResultIdentity({
      repositoryRoot: workspaceRoot,
      profile: options.profile,
      publicPrompt: scenario.publicCase.prompt,
      datasetFingerprint: runIdentity.datasetFingerprint,
      oracleVersion: EVAL_ORACLE_VERSION,
      runIdentity,
    });
    agentStarted = true;
    agentStartedAt = performance.now();
    const commonRunOptions = {
      runId,
      repositoryRoot: workspaceRoot,
      runtimeRoot: join(temporaryRoot, "pi-runtime"),
      prompt: scenario.publicCase.prompt,
      timeoutMs,
    };
    const profileOutcome = options.profile === "pi-baseline"
      ? await runPiBaseline(commonRunOptions)
      : await runPiMaintainer({
          ...commonRunOptions,
        startFloor: scenario.publicCase.startFloor,
        startPreset: scenario.publicCase.startPreset,
        ...(options.onLiveEvent ? { onLiveEvent: options.onLiveEvent } : {}),
      });
    piMetrics = profileOutcome.metrics;
    const evaluationRoot = profileOutcome.workspaceRoot;
    workflowClosure = profileOutcome.workflowClosure;
    runDiagnostics = profileOutcome.diagnostics;
    if (piMetrics.failureCode) agentFailureCode = piMetrics.failureCode;
    if (piMetrics.status === "infra_error") infrastructureFailure = true;
    const after = await runEvalBrowserOracle({
      repositoryRoot: evaluationRoot,
      scenario,
      phase: "after",
      timeoutMs,
    });
    afterOracleMatched = after.matched;
    afterDiagnostic = after.diagnostic;
    afterActionCount = after.actionCount;
    browserErrorCount += after.browserErrorCount;
    if (after.failureCode) {
      infrastructureFailure = true;
      judgeFailureCode ??= after.failureCode;
    }
    const paths = await changedPaths(evaluationRoot);
    changedFileCount = paths.length;
    retainedChangedPaths = paths;
    retainedChangedPathDigests = await changedPathDigests(evaluationRoot, paths);
    forbiddenPathsUntouched = !touchesForbiddenPath(paths, scenario.expected.forbiddenPaths);
    const finalHead = (await gitOutput(evaluationRoot, ["rev-parse", "HEAD"])).trim();
    headUnchanged = baseHead === finalHead;
    if (!afterOracleMatched) judgeFailureCode ??= "after-oracle-not-matched";
    if (!forbiddenPathsUntouched) judgeFailureCode ??= "forbidden-path-changed";
    if (!headUnchanged) judgeFailureCode ??= "unexpected-commit";
  } catch (error) {
    infrastructureFailure = true;
    const failureCode = evalFailureCode(error);
    if (agentStarted) {
      agentFailureCode ??= failureCode;
      piMetrics = {
        ...piMetrics,
        status: "infra_error",
        durationMs: agentStartedAt === null
          ? 0
          : Math.max(0, Math.round(performance.now() - agentStartedAt)),
        failureCode,
      };
    } else {
      judgeFailureCode ??= failureCode;
    }
  } finally {
    if (dependencyLease) {
      await releaseEvalDependencies(dependencyLease).catch((error: unknown) => {
        infrastructureFailure = true;
        judgeFailureCode ??= evalFailureCode(error);
      });
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
        .catch((error: unknown) => {
          infrastructureFailure = true;
          judgeFailureCode ??= evalFailureCode(error);
        });
    }
  }
  const externalCorrectnessPassed = evalExternalCorrectnessPassed({
    initialFailureMatched,
    afterOracleMatched,
    forbiddenPathsUntouched,
    headUnchanged,
  });
  const workflowClosurePassed = workflowClosure.applicable
    ? workflowClosure.proposed === true
      && workflowClosure.retainedChanges === true
      && workflowClosure.verified === true
      && workflowClosure.readyToApply === true
    : null;
  const judgeOutcome = evalJudgeOutcome({
    infrastructureFailure,
    externalCorrectnessPassed,
    workflowClosurePassed,
  });
  const resultWithoutArchive: EvalRunResult = {
    schemaVersion: 5,
    runId,
    scenarioId: options.scenarioId,
    profile: options.profile,
    repetition: options.repetition,
    status: judgeOutcome.status,
    failureClass: classifyEvalFailure({
      status: judgeOutcome.status,
      agentFailureCode,
      workflowClosurePassed,
    }),
    externalCorrectness: {
      initialFailureMatched,
      afterOracleMatched,
      forbiddenPathsUntouched,
      headUnchanged,
    },
    workflowClosure,
    agentResult: {
      ...piMetrics,
      totalDurationMs: Math.round(performance.now() - startedAt),
      beforeActionCount,
      afterActionCount,
      browserErrorCount,
      changedFileCount,
      changedPaths: retainedChangedPaths,
      changedPathDigests: retainedChangedPathDigests,
    },
    judgeOutcome,
    modelId: identity?.modelId ?? null,
    identity,
    agentFailureCode,
    judgeFailureCode,
    diagnostics: {
      beforeOracle: beforeDiagnostic,
      afterOracle: afterDiagnostic,
      lastToolName: runDiagnostics.lastToolName,
      lastFinishStatus: runDiagnostics.lastFinishStatus,
      evidenceGraph: runDiagnostics.evidenceGraph,
    },
    archivePath: null,
  };
  const archivePath = await writeEvalRunArchive(options.archiveRoot, resultWithoutArchive)
    .catch(() => null);
  return { ...resultWithoutArchive, archivePath };
}
