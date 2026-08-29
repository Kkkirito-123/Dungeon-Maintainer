/**
 * Eval 场景准备与零模型预检。
 *
 * 本模块读取场景、物化 broken/clean 仓库，并用浏览器 Oracle 生成可供同一运行身份
 * 复用的低敏证书。它不启动模型，也不把隐藏 expected 或 SQL 暴露给 Agent。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  evalFailureCode,
  provisionEvalDependencies,
  releaseEvalDependencies,
  runEvalPreflightBrowserOracle,
  type EvalDependencyLease,
  type EvalOracleDiagnostic,
} from "./browser-oracle.js";
import {
  createEvalWorkspace,
} from "./workspace.js";
import { EVAL_ORACLE_VERSION } from "../domain/oracle.js";
import {
  collectEvalRunIdentity,
  evalRunIdentityIsCurrent,
  type EvalRunIdentity,
} from "../reporting/identity.js";
import {
  readEvalScenario,
  type EvalScenario,
} from "../domain/scenario.js";

const executeFile = promisify(execFile);

/** 预检成功后可供同一 EvalSuite 正式运行复用的低敏证书。 */
export interface EvalPreflightCertificate {
  readonly schemaVersion: 2;
  readonly scenarioId: string;
  readonly buggyHead: string;
  readonly dependencyKey: string;
  readonly oracleVersion: typeof EVAL_ORACLE_VERSION;
  readonly runFingerprint: string;
  readonly beforeOracleMatched: boolean;
  readonly cleanAfterOracleMatched: boolean;
}

/** 零模型预检结果；不包含 SQL、源码、模型正文或绝对临时路径。 */
export interface EvalPreflightResult {
  readonly schemaVersion: 3;
  readonly scenarioId: string;
  readonly runFingerprint: string | null;
  readonly status: "passed" | "failed" | "infra_error";
  readonly initialFailureMatched: boolean;
  readonly cleanBaselineMatched: boolean;
  readonly certificate: EvalPreflightCertificate | null;
  readonly beforeDiagnostic: EvalOracleDiagnostic | null;
  readonly cleanDiagnostic: EvalOracleDiagnostic | null;
  readonly actionCount: number;
  readonly durationMs: number;
  readonly browserErrorCount: number;
  readonly failureCode: string | null;
  readonly archivePath: string | null;
}

/** 预检参数；依赖仓库必须由调用方显式提供，避免评测期间联网安装。 */
export interface EvalPreflightOptions {
  readonly scenarioId: string;
  /** 完整 Dataset 根；省略时读取内置 eval-v1。 */
  readonly datasetRoot?: string;
  /** 已由 EvalDataset 读取器验证的完整内容指纹。 */
  readonly datasetFingerprint: string;
  readonly dependencyRepoRoot: string;
  readonly archiveRoot?: string;
  readonly timeoutMs?: number;
  /** EvalSuite 预先冻结的运行身份；单题调用省略时由当前源码和模型配置生成。 */
  readonly runIdentity?: EvalRunIdentity;
}

function evalDependencyKey(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
}

/** 从固定 Dataset 读取一个 EvalScenario。 */
export async function loadEvalScenario(options: {
  readonly scenarioId: string;
  readonly datasetRoot?: string;
}): Promise<EvalScenario> {
  return await readEvalScenario({
    scenarioId: options.scenarioId,
    ...(options.datasetRoot ? { datasetRoot: options.datasetRoot } : {}),
  });
}

/** 解析或校验与场景来源、模型配置和 Oracle 版本绑定的运行身份。 */
export async function resolveEvalRunIdentity(
  datasetFingerprint: string,
  provided: EvalRunIdentity | undefined,
): Promise<EvalRunIdentity> {
  if (!/^[0-9a-f]{64}$/u.test(datasetFingerprint)) {
    throw new Error("eval-run-fingerprint-mismatch");
  }
  if (provided) {
    if (
      !evalRunIdentityIsCurrent(provided)
      || provided.datasetFingerprint !== datasetFingerprint
      || provided.oracleVersion !== EVAL_ORACLE_VERSION
    ) {
      throw new Error("eval-run-fingerprint-mismatch");
    }
    return provided;
  }
  return await collectEvalRunIdentity({
    datasetFingerprint,
    oracleVersion: EVAL_ORACLE_VERSION,
  });
}

/** 验证预检证书确实来自当前 EvalSuite 的同一运行身份。 */
export function isEvalPreflightCertificateCurrent(input: {
  readonly certificate: unknown;
  readonly scenarioId: string;
  readonly buggyHead: string;
  readonly dependencyRepoRoot: string;
  readonly runFingerprint: string;
}): boolean {
  if (!input.certificate || typeof input.certificate !== "object") return false;
  const certificate = input.certificate as Record<string, unknown>;
  return certificate.schemaVersion === 2
    && certificate.scenarioId === input.scenarioId
    && certificate.buggyHead === input.buggyHead
    && certificate.dependencyKey === evalDependencyKey(input.dependencyRepoRoot)
    && certificate.oracleVersion === EVAL_ORACLE_VERSION
    && certificate.runFingerprint === input.runFingerprint
    && certificate.beforeOracleMatched === true
    && certificate.cleanAfterOracleMatched === true;
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

async function writeEvalPreflightArchive(
  archiveRoot: string | undefined,
  result: EvalPreflightResult,
): Promise<string | null> {
  if (!archiveRoot) return null;
  const directory = resolve(archiveRoot);
  await mkdir(directory, { recursive: true });
  const path = join(directory, result.scenarioId + "-preflight.json");
  await writeFile(path, JSON.stringify({ ...result, archivePath: null }, null, 2) + "\n", "utf8");
  return path;
}

/** 执行一个场景的零 Token 初始故障与干净基线预检。 */
export async function runEvalPreflight(
  options: EvalPreflightOptions,
): Promise<EvalPreflightResult> {
  const startedAt = performance.now();
  let scenario: EvalScenario | null = null;
  let temporaryRoot: string | null = null;
  let workspaceRoot: string | null = null;
  let dependencyLease: EvalDependencyLease | null = null;
  let cleanDependencyLease: EvalDependencyLease | null = null;
  let actionCount = 0;
  let initialFailureMatched = false;
  let cleanBaselineMatched = false;
  let certificate: EvalPreflightCertificate | null = null;
  let runIdentity: EvalRunIdentity | null = null;
  let beforeDiagnostic: EvalOracleDiagnostic | null = null;
  let cleanDiagnostic: EvalOracleDiagnostic | null = null;
  let failureCode: string | null = null;
  let browserErrorCount = 0;
  try {
    scenario = await loadEvalScenario(options);
    runIdentity = await resolveEvalRunIdentity(options.datasetFingerprint, options.runIdentity);
    const timeoutMs = options.timeoutMs ?? scenario.publicCase.timeoutMs;
    temporaryRoot = await mkdtemp(join(tmpdir(), "dungeon-agent-eval-"));
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
    const oracle = await runEvalPreflightBrowserOracle({
      repositoryRoot: workspaceRoot,
      scenario,
      phase: "before",
      timeoutMs,
    });
    actionCount = oracle.actionCount;
    browserErrorCount = oracle.browserErrorCount;
    initialFailureMatched = oracle.matched;
    beforeDiagnostic = oracle.diagnostic;
    failureCode = oracle.failureCode ?? (initialFailureMatched ? null : "initial-failure-not-matched");
    if (!failureCode) {
      const cleanRoot = join(temporaryRoot, "clean-repository");
      await createEvalWorkspace({
        scenarioId: scenario.publicCase.scenarioId,
        ...(options.datasetRoot ? { datasetRoot: options.datasetRoot } : {}),
        destination: cleanRoot,
        variant: "clean",
      });
      cleanDependencyLease = await provisionEvalDependencies({
        repositoryRoot: cleanRoot,
        dependencyRepoRoot: options.dependencyRepoRoot,
      });
      const cleanOracle = await runEvalPreflightBrowserOracle({
        repositoryRoot: cleanRoot,
        scenario,
        phase: "after",
        timeoutMs,
      });
      actionCount += cleanOracle.actionCount;
      browserErrorCount += cleanOracle.browserErrorCount;
      cleanBaselineMatched = cleanOracle.matched;
      cleanDiagnostic = cleanOracle.diagnostic;
      failureCode = cleanOracle.failureCode ?? (cleanBaselineMatched ? null : "clean-baseline-not-matched");
      if (!failureCode) {
        certificate = {
          schemaVersion: 2,
          scenarioId: scenario.publicCase.scenarioId,
          buggyHead: (await gitOutput(workspaceRoot, ["rev-parse", "HEAD"])).trim(),
          dependencyKey: evalDependencyKey(options.dependencyRepoRoot),
          oracleVersion: EVAL_ORACLE_VERSION,
          runFingerprint: runIdentity.runFingerprint,
          beforeOracleMatched: true,
          cleanAfterOracleMatched: true,
        };
      }
    }
  } catch (error) {
    failureCode = evalFailureCode(error);
  } finally {
    if (cleanDependencyLease) {
      await releaseEvalDependencies(cleanDependencyLease).catch((error: unknown) => {
        failureCode ??= evalFailureCode(error);
      });
    }
    if (dependencyLease) {
      await releaseEvalDependencies(dependencyLease).catch((error: unknown) => {
        failureCode ??= evalFailureCode(error);
      });
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
        .catch((error: unknown) => { failureCode ??= evalFailureCode(error); });
    }
  }
  const resultWithoutArchive: EvalPreflightResult = {
    schemaVersion: 3,
    scenarioId: options.scenarioId,
    runFingerprint: runIdentity?.runFingerprint ?? null,
    status: failureCode
      ? (
          failureCode === "initial-failure-not-matched"
          || failureCode === "clean-baseline-not-matched"
            ? "failed"
            : "infra_error"
        )
      : "passed",
    initialFailureMatched,
    cleanBaselineMatched,
    certificate,
    beforeDiagnostic,
    cleanDiagnostic,
    actionCount,
    durationMs: Math.round(performance.now() - startedAt),
    browserErrorCount,
    failureCode,
    archivePath: null,
  };
  const archivePath = await writeEvalPreflightArchive(options.archiveRoot, resultWithoutArchive)
    .catch(() => null);
  return { ...resultWithoutArchive, archivePath };
}
