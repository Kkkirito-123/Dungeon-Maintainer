/**
 * EvalSuite 断点文件。
 *
 * 本模块只做原子单写和恢复所需的最小验证。并行 Worker 不直接写文件，Suite 会把
 * 所有写入排入同一 Promise 链，因此 checkpoint 不会发生交错覆盖。
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalRunProfile, EvalRunResult } from "../execution/run.js";
import type { EvalPreflightResult } from "../execution/preflight.js";

/** 可恢复的 Suite 状态。 */
export interface EvalSuiteCheckpoint {
  readonly schemaVersion: 3;
  readonly runFingerprint: string;
  readonly datasetId: string;
  readonly profile: EvalRunProfile | "both";
  readonly repetitions: number;
  readonly expectedRuns: number;
  readonly results: readonly EvalRunResult[];
  readonly runFailures: readonly {
    readonly scenarioId: string;
    readonly profile: EvalRunProfile;
    readonly repetition: number;
    readonly code: string;
  }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function profile(value: unknown): value is EvalRunProfile {
  return value === "maintainer" || value === "pi-baseline";
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function booleanOrNull(value: unknown): boolean {
  return typeof value === "boolean" || value === null;
}

function isRunResult(value: unknown, runFingerprint: string): value is EvalRunResult {
  const result = record(value);
  const agentResult = record(result?.agentResult);
  const externalCorrectness = record(result?.externalCorrectness);
  const workflowClosure = record(result?.workflowClosure);
  const oracleOutcome = record(result?.oracleOutcome);
  const rawIdentity = result?.identity;
  const identity = rawIdentity === null ? null : record(rawIdentity);
  const identityMatches = identity !== null && identity.runFingerprint === runFingerprint;
  return result !== null
    && result.schemaVersion === 7
    && typeof result.runId === "string"
    && result.runId.length > 0
    && typeof result.scenarioId === "string"
    && result.scenarioId.length > 0
    && profile(result.profile)
    && positiveInteger(result.repetition)
    && (result.status === "passed" || result.status === "failed" || result.status === "infra_error")
    && agentResult !== null
    && (agentResult.status === "settled" || agentResult.status === "timeout" || agentResult.status === "infra_error")
    && nonNegativeInteger(agentResult.durationMs)
    && nonNegativeInteger(agentResult.totalDurationMs)
    && nonNegativeInteger(agentResult.totalTokens)
    && nonNegativeInteger(agentResult.toolCalls)
    && nonNegativeInteger(agentResult.inspectCalls)
    && nonNegativeInteger(agentResult.inspectExecutions)
    && nonNegativeInteger(agentResult.inspectReceiptHits)
    && nonNegativeInteger(agentResult.readCalls)
    && (agentResult.diagnosisMs === null || nonNegativeInteger(agentResult.diagnosisMs))
    && externalCorrectness !== null
    && typeof externalCorrectness.sourcePatchMaterialized === "boolean"
    && typeof externalCorrectness.agentSettled === "boolean"
    && booleanOrNull(externalCorrectness.afterOracleMatched)
    && workflowClosure !== null
    && booleanOrNull(workflowClosure.paused)
    && oracleOutcome !== null
    && (oracleOutcome.status === "passed" || oracleOutcome.status === "failed" || oracleOutcome.status === "infra_error")
    && typeof oracleOutcome.externalCorrectnessPassed === "boolean"
    && booleanOrNull(oracleOutcome.workflowClosurePassed)
    && nonNegativeInteger(oracleOutcome.actionCount)
    && nonNegativeInteger(oracleOutcome.browserErrorCount)
    && nonNegativeInteger(oracleOutcome.durationMs)
    && (rawIdentity === null || identity !== null)
    && (result.status === "infra_error"
      ? identity === null || identityMatches
      : identityMatches);
}

function isRunFailure(value: unknown): boolean {
  const failure = record(value);
  return failure !== null
    && typeof failure.scenarioId === "string"
    && failure.scenarioId.length > 0
    && profile(failure.profile)
    && positiveInteger(failure.repetition)
    && typeof failure.code === "string"
    && failure.code.length > 0;
}

interface CheckpointJobIdentity {
  readonly scenarioId: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
}

function checkpointJobKey(job: CheckpointJobIdentity): string {
  return job.scenarioId + ":" + job.profile + ":" + String(job.repetition);
}

/** 只复用相同 Dataset、Profile、重复次数和运行身份的 checkpoint。 */
export function evalSuiteCheckpointIsCompatible(
  checkpoint: unknown,
  expected: {
    readonly runFingerprint: string;
    readonly datasetId: string;
    readonly profile: EvalRunProfile | "both";
    readonly repetitions: number;
    readonly expectedRuns: number;
    readonly scenarioIds?: readonly string[];
  },
): checkpoint is EvalSuiteCheckpoint {
  const value = record(checkpoint);
  if (
    !positiveInteger(expected.repetitions)
    || !positiveInteger(expected.expectedRuns)
    || !/^[0-9a-f]{64}$/u.test(expected.runFingerprint)
    || expected.datasetId.length === 0
  ) return false;
  if (!(value !== null
    && value.schemaVersion === 3
    && value.runFingerprint === expected.runFingerprint
    && value.datasetId === expected.datasetId
    && value.profile === expected.profile
    && value.repetitions === expected.repetitions
    && value.expectedRuns === expected.expectedRuns
    && Array.isArray(value.results)
    && value.results.every((result) => isRunResult(result, expected.runFingerprint))
    && Array.isArray(value.runFailures)
    && value.runFailures.every(isRunFailure))) return false;

  const jobs = [
    ...value.results,
    ...value.runFailures as CheckpointJobIdentity[],
  ];
  if (jobs.length > expected.expectedRuns) return false;
  const scenarioIds = expected.scenarioIds;
  const scenarioSet = scenarioIds ? new Set(scenarioIds) : null;
  if (scenarioIds && scenarioSet?.size !== scenarioIds.length) return false;
  if (scenarioIds?.some((scenarioId) => scenarioId.length === 0)) return false;
  if (scenarioIds) {
    const profileCount = expected.profile === "both" ? 2 : 1;
    if (expected.expectedRuns !== scenarioIds.length * profileCount * expected.repetitions) {
      return false;
    }
  }
  const keys = new Set<string>();
  for (const job of jobs) {
    if (
      job.repetition > expected.repetitions
      || (expected.profile !== "both" && job.profile !== expected.profile)
      || (scenarioSet && !scenarioSet.has(job.scenarioId))
    ) return false;
    const key = checkpointJobKey(job);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

/** 通过同目录临时文件和 rename 原子替换 checkpoint。 */
export async function writeEvalSuiteCheckpoint(
  archiveDirectory: string,
  checkpoint: EvalSuiteCheckpoint,
): Promise<void> {
  const target = join(archiveDirectory, "checkpoint.json");
  const temporary = target + ".tmp-" + randomUUID();
  await writeFile(temporary, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  await rename(temporary, target);
}

/** 读取 checkpoint；损坏或旧 schema 统一视为不可恢复。 */
export async function readEvalSuiteCheckpoint(
  path: string,
): Promise<EvalSuiteCheckpoint | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const value = record(parsed);
    if (
      !value
      || typeof value.runFingerprint !== "string"
      || typeof value.datasetId !== "string"
      || (value.profile !== "both" && !profile(value.profile))
      || !positiveInteger(value.repetitions)
      || !Number.isSafeInteger(value.expectedRuns)
    ) return null;
    return evalSuiteCheckpointIsCompatible(value, {
      runFingerprint: value.runFingerprint,
      datasetId: value.datasetId,
      profile: value.profile,
      repetitions: Number(value.repetitions),
      expectedRuns: Number(value.expectedRuns),
    }) ? value : null;
  } catch {
    return null;
  }
}

function isPreflightResult(
  value: unknown,
  scenarioId: string,
  runFingerprint: string,
): value is EvalPreflightResult {
  const result = record(value);
  const certificate = result?.certificate === null ? null : record(result?.certificate);
  return result !== null
    && result.schemaVersion === 3
    && result.scenarioId === scenarioId
    && result.runFingerprint === runFingerprint
    && (result.status === "passed" || result.status === "failed" || result.status === "infra_error")
    && typeof result.initialFailureMatched === "boolean"
    && typeof result.cleanBaselineMatched === "boolean"
    && (
      certificate === null
      || (
        certificate.schemaVersion === 2
        && certificate.scenarioId === scenarioId
        && certificate.runFingerprint === runFingerprint
      )
    );
}

/** 按 Dataset 顺序读取全部预检；任一缺失或不匹配就重新预检整组。 */
export async function readSavedEvalPreflights(
  archiveDirectory: string,
  scenarioIds: readonly string[],
  runFingerprint: string,
): Promise<EvalPreflightResult[] | null> {
  const entries: EvalPreflightResult[] = [];
  for (const scenarioId of scenarioIds) {
    try {
      const parsed: unknown = JSON.parse(await readFile(
        join(archiveDirectory, "preflight", scenarioId + "-preflight.json"),
        "utf8",
      ));
      if (!isPreflightResult(parsed, scenarioId, runFingerprint)) return null;
      entries.push(parsed);
    } catch {
      return null;
    }
  }
  return entries;
}
