/**
 * 单个 EvalScenario 的 Agent 运行与黑盒功能判定。
 *
 * 本模块只物化故障仓库、运行一个 Profile 到自然 settled，并在 Profile 已停止后执行一次
 * 隐藏浏览器 Oracle。它不读取候选 Diff、HEAD 或路径，不比较参考实现，也不调用第二个模型。
 * 输入来自当前游戏 Adapter 与公开任务，隐藏复现和断言只交给进程外 Oracle；输出是低敏结果与
 * 时间/Token 指标。Agent 只获临时工作区权限，不能读取隐藏判定输入。副作用限于临时仓库、
 * Agent/游戏子进程和可选结果归档，均在本轮回收；启动、卸载或 Oracle 失败会分类为
 * `infra_error`，修正环境后可重跑完整 Scenario。
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EVAL_ORACLE_VERSION } from "../domain/oracle.js";
import {
  EVAL_TIMEOUT_MAX_MS,
} from "../domain/scenario.js";
import type {
  ProfileRunMetrics,
  ProfileWorkflowClosure,
} from "../domain/result.js";
import { runPiMaintainer, type PiMaintainerLiveEvent } from "../profiles/maintainer.js";
import { runPiBaseline } from "../profiles/pi-baseline.js";
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
import {
  loadEvalScenario,
  resolveEvalRunIdentity,
} from "./preflight.js";
import { createEvalWorkspace } from "./workspace.js";

/** 游戏修复 Eval 当前支持的被测 Profile。 */
export type EvalRunProfile = "pi-baseline" | "maintainer";

/** 一次真实模型游戏修复 Eval 的统一低敏结果。 */
export interface EvalRunResult {
  readonly schemaVersion: 7;
  readonly runId: string;
  readonly scenarioId: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
  readonly status: "passed" | "failed" | "infra_error";
  readonly failureClass: "none" | "agent" | "oracle" | "infrastructure";
  readonly externalCorrectness: {
    readonly sourcePatchMaterialized: boolean;
    readonly agentSettled: boolean;
    readonly afterOracleMatched: boolean | null;
  };
  readonly workflowClosure: ProfileWorkflowClosure;
  readonly agentResult: ProfileRunMetrics & {
    readonly totalDurationMs: number;
  };
  readonly oracleOutcome: {
    readonly status: "passed" | "failed" | "infra_error";
    readonly externalCorrectnessPassed: boolean;
    readonly workflowClosurePassed: boolean | null;
    readonly actionCount: number;
    readonly browserErrorCount: number;
    readonly durationMs: number;
  };
  readonly modelId: string | null;
  readonly identity: EvalResultIdentity | null;
  readonly agentFailureCode: string | null;
  readonly oracleFailureCode: string | null;
  readonly diagnostics: {
    readonly afterOracle: EvalOracleDiagnostic | null;
    readonly lastToolName: string | null;
    readonly lastFinishStatus: string | null;
  };
  readonly archivePath: string | null;
}

/** 一次真实模型游戏修复 Eval 的参数。 */
export interface EvalRunOptions {
  readonly scenarioId: string;
  /** 已由当前游戏 Adapter catalog 返回的完整内容指纹。 */
  readonly datasetFingerprint: string;
  readonly dependencyRepoRoot: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
  readonly archiveRoot?: string;
  readonly timeoutMs?: number;
  /** 与 checkpoint 和最终 EvalSuite 汇总共享的运行身份。 */
  readonly runIdentity?: EvalRunIdentity;
  /** 仅转发当前模型的可见文本和工具名，不参与判分或归档。 */
  readonly onLiveEvent?: (event: PiMaintainerLiveEvent) => void;
}

/**
 * 把最终失败归入互斥低敏类别。
 *
 * @param input 最终状态及 Agent 是否自然 settled。
 * @returns 供 Suite 汇总的稳定失败类别；不改变运行状态。
 */
export function classifyEvalFailure(input: {
  readonly status: EvalRunResult["status"];
  readonly agentSettled: boolean;
}): EvalRunResult["failureClass"] {
  if (input.status === "passed") return "none";
  if (input.status === "infra_error") return "infrastructure";
  return input.agentSettled ? "oracle" : "agent";
}

/**
 * 只按故障已物化、Agent 已自然结束和隐藏功能 Oracle 判定外部正确性。
 *
 * @param input 三个与实现代码形态无关的运行事实。
 * @returns 三项全部满足时为 true；不读取工作区或模型文本。
 */
export function evalExternalCorrectnessPassed(input: {
  readonly sourcePatchMaterialized: boolean;
  readonly agentSettled: boolean;
  readonly afterOracleMatched: boolean | null;
}): boolean {
  return input.sourcePatchMaterialized
    && input.agentSettled
    && input.afterOracleMatched === true;
}

/**
 * 根据基础设施与功能结果生成 Oracle 总结。
 *
 * @param input 基础设施、外部功能和可选工作流诊断事实。
 * @returns 最终状态；`workflowClosurePassed` 原样保留但不参与判分。
 */
export function evalOracleOutcome(input: {
  readonly infrastructureFailure: boolean;
  readonly externalCorrectnessPassed: boolean;
  readonly workflowClosurePassed: boolean | null;
}): Pick<
  EvalRunResult["oracleOutcome"],
  "status" | "externalCorrectnessPassed" | "workflowClosurePassed"
> {
  const status = input.infrastructureFailure
    ? "infra_error"
    : input.externalCorrectnessPassed ? "passed" : "failed";
  return {
    status,
    externalCorrectnessPassed: input.externalCorrectnessPassed,
    workflowClosurePassed: input.workflowClosurePassed,
  };
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

function initialWorkflowClosure(profile: EvalRunProfile): ProfileWorkflowClosure {
  const applicable = profile === "maintainer";
  return {
    applicable,
    taskState: null,
    proposed: applicable ? false : null,
    executed: applicable ? false : null,
    writeAttempted: applicable ? false : null,
    retainedChanges: applicable ? false : null,
    verified: applicable ? false : null,
    readyToApply: applicable ? false : null,
    paused: applicable ? false : null,
  };
}

function emptyProfileMetrics(): ProfileRunMetrics {
  return {
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
}

type EvalRunPhase = "setup" | "agent" | "oracle" | "complete";

/**
 * 运行一轮真实模型游戏修复 Eval。
 *
 * @param options 冻结场景、依赖来源、Profile、超时和低敏归档选项。
 * @returns Agent 指标与一次隐藏 after Oracle 组成的 schema v7 结果。
 * @throws 不向外抛模型正文；运行错误折叠为稳定状态和失败码。
 * Profile 返回前必须已停止自身 Agent 与工具进程；只有真实 settled 才启动一次全新浏览器
 * Oracle。Oracle 结果不会反馈给 Agent，超时不会进入判卷，任何基础设施错误均优先失败。
 */
export async function runEvalScenario(
  options: EvalRunOptions,
): Promise<EvalRunResult> {
  const startedAt = performance.now();
  const runId = randomUUID();
  let temporaryRoot: string | null = null;
  let dependencyLease: EvalDependencyLease | null = null;
  let sourcePatchMaterialized = false;
  let agentSettled = false;
  let afterOracleMatched: boolean | null = null;
  let afterOracle: EvalOracleDiagnostic | null = null;
  let oracleActionCount = 0;
  let oracleBrowserErrorCount = 0;
  let oracleDurationMs = 0;
  let infrastructureFailure = false;
  let agentFailureCode: string | null = null;
  let oracleFailureCode: string | null = null;
  let lastToolName: string | null = null;
  let lastFinishStatus: string | null = null;
  let workflowClosure = initialWorkflowClosure(options.profile);
  let identity: EvalResultIdentity | null = null;
  let piMetrics = emptyProfileMetrics();
  let phase: EvalRunPhase = "setup";
  let agentStartedAt: number | null = null;

  try {
    const scenario = await loadEvalScenario({
      scenarioId: options.scenarioId,
      gameRepoRoot: options.dependencyRepoRoot,
    });
    const runIdentity = await resolveEvalRunIdentity(
      options.datasetFingerprint,
      options.runIdentity,
    );
    const timeoutMs = Math.min(
      options.timeoutMs ?? scenario.publicCase.timeoutMs,
      EVAL_TIMEOUT_MAX_MS,
    );
    temporaryRoot = await mkdtemp(join(tmpdir(), "dungeon-eval-"));
    const workspaceRoot = join(temporaryRoot, "repository");
    await createEvalWorkspace({
      scenarioId: scenario.publicCase.scenarioId,
      gameRepoRoot: options.dependencyRepoRoot,
      destination: workspaceRoot,
    });
    sourcePatchMaterialized = true;
    dependencyLease = await provisionEvalDependencies({
      repositoryRoot: workspaceRoot,
      dependencyRepoRoot: options.dependencyRepoRoot,
    });
    identity = await collectEvalResultIdentity({
      repositoryRoot: workspaceRoot,
      profile: options.profile,
      publicPrompt: scenario.publicCase.prompt,
      datasetFingerprint: runIdentity.datasetFingerprint,
      oracleVersion: EVAL_ORACLE_VERSION,
      runIdentity,
    });

    phase = "agent";
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
    workflowClosure = profileOutcome.workflowClosure;
    lastToolName = profileOutcome.diagnostics.lastToolName;
    lastFinishStatus = profileOutcome.diagnostics.lastFinishStatus;
    agentSettled = piMetrics.status === "settled";
    agentFailureCode = piMetrics.failureCode;
    if (!agentSettled) {
      agentFailureCode ??= piMetrics.status === "timeout"
        ? "agent-timeout"
        : "agent-runtime-error";
    }
    if (piMetrics.status === "infra_error") infrastructureFailure = true;

    if (agentSettled) {
      phase = "oracle";
      const oracleStartedAt = performance.now();
      try {
        const oracle = await runEvalBrowserOracle({
          repositoryRoot: profileOutcome.workspaceRoot,
          scenario,
          phase: "after",
          timeoutMs,
        });
        afterOracleMatched = oracle.matched;
        afterOracle = oracle.diagnostic;
        oracleActionCount = oracle.actionCount;
        oracleBrowserErrorCount = oracle.browserErrorCount;
        if (oracle.failureCode !== null) {
          infrastructureFailure = true;
          oracleFailureCode = oracle.failureCode;
        } else if (oracle.browserErrorCount > 0) {
          infrastructureFailure = true;
          oracleFailureCode = "oracle-browser-error";
        } else if (!oracle.matched) {
          oracleFailureCode = "after-oracle-not-matched";
        }
      } finally {
        oracleDurationMs = Math.max(0, Math.round(performance.now() - oracleStartedAt));
      }
    }
    phase = "complete";
  } catch (error) {
    infrastructureFailure = true;
    const failureCode = evalFailureCode(error);
    if (phase === "agent") {
      agentFailureCode = failureCode;
      piMetrics = {
        ...piMetrics,
        status: "infra_error",
        durationMs: agentStartedAt === null
          ? 0
          : Math.max(0, Math.round(performance.now() - agentStartedAt)),
        failureCode,
      };
    } else {
      oracleFailureCode = failureCode;
    }
  } finally {
    if (dependencyLease) {
      await releaseEvalDependencies(dependencyLease).catch((error: unknown) => {
        infrastructureFailure = true;
        oracleFailureCode = evalFailureCode(error);
      });
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
        .catch((error: unknown) => {
          infrastructureFailure = true;
          oracleFailureCode = evalFailureCode(error);
        });
    }
  }

  const externalCorrectnessPassed = evalExternalCorrectnessPassed({
    sourcePatchMaterialized,
    agentSettled,
    afterOracleMatched,
  });
  const workflowClosurePassed = workflowClosure.applicable
    ? workflowClosure.proposed === true
      && workflowClosure.retainedChanges === true
      && workflowClosure.verified === true
      && workflowClosure.readyToApply === true
    : null;
  const outcome = evalOracleOutcome({
    infrastructureFailure,
    externalCorrectnessPassed,
    workflowClosurePassed,
  });
  const oracleOutcome: EvalRunResult["oracleOutcome"] = {
    ...outcome,
    actionCount: oracleActionCount,
    browserErrorCount: oracleBrowserErrorCount,
    durationMs: oracleDurationMs,
  };
  const resultWithoutArchive: EvalRunResult = {
    schemaVersion: 7,
    runId,
    scenarioId: options.scenarioId,
    profile: options.profile,
    repetition: options.repetition,
    status: oracleOutcome.status,
    failureClass: classifyEvalFailure({
      status: oracleOutcome.status,
      agentSettled,
    }),
    externalCorrectness: {
      sourcePatchMaterialized,
      agentSettled,
      afterOracleMatched,
    },
    workflowClosure,
    agentResult: {
      ...piMetrics,
      totalDurationMs: Math.round(performance.now() - startedAt),
    },
    oracleOutcome,
    modelId: identity?.modelId ?? null,
    identity,
    agentFailureCode,
    oracleFailureCode,
    diagnostics: {
      afterOracle,
      lastToolName,
      lastFinishStatus,
    },
    archivePath: null,
  };
  const archivePath = await writeEvalRunArchive(options.archiveRoot, resultWithoutArchive)
    .catch(() => null);
  return { ...resultWithoutArchive, archivePath };
}
