/**
 * 游戏修复 Agent Eval 的确定性准备与零 Token 预检。
 *
 * 本模块负责读取案例、物化临时 Git 仓库、复用显式依赖目录、启动 Vite/无头
 * Chromium 并执行固定复现动作。它不启动模型、不把隐藏 expected 或 SQL 返回给
 * Agent，也不负责判断模型修改是否正确。所有资源都通过本轮 lease 记录，并在
 * finally 中按固定顺序回收；预检失败会返回低敏结果而不是留下后台进程。
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  GAME_REPAIR_TIMEOUT_MAX_MS,
  readAgentEvalCase,
  type AgentEvalCase,
  type AgentEvalReproductionStep,
} from "./agent-eval-case.js";
import { materializeAgentEvalFixture } from "./agent-eval-fixture.js";
import { runPiMaintainer, type PiMaintainerLiveEvent } from "./pi-maintainer.js";
import {
  runPiOriginal,
  type PiRunMetrics,
  type PiRunDiagnostics,
  type PiWorkflowClosure,
} from "./pi-original.js";
import { GameBrowser } from "../game/browser.js";
import { GameDriver } from "../game/driver.js";
import { startGameServer, type GameServer } from "../game/server.js";
import {
  collectBenchmarkProvenance,
  type BenchmarkProvenance,
} from "./provenance.js";
import {
  classifyAgentEvalPlan,
  matchesAfterOracle,
  matchesBeforeOracle,
  type AgentEvalOracleObservation,
} from "./agent-eval-oracle.js";

const executeFile = promisify(execFile);
export const AGENT_EVAL_ORACLE_VERSION = "oracle-v3-exact-final-state";

/** 预检成功后可供同一矩阵正式运行复用的低敏证书。 */
export interface AgentEvalPreflightCertificate {
  readonly schemaVersion: number;
  readonly fixtureId: string;
  readonly buggyHead: string;
  readonly dependencyKey: string;
  readonly oracleVersion: string;
  readonly beforeOracleMatched: boolean;
  readonly cleanAfterOracleMatched: boolean;
}

/** 依赖链接的本轮所有权。共享依赖目标永远不属于 lease。 */
export interface AgentEvalDependencyLease {
  readonly target: string;
  readonly source: string;
}

/** 零模型预检结果；不包含 SQL、源码、模型正文或绝对临时路径。 */
export interface AgentEvalPreflightResult {
  readonly schemaVersion: 2;
  readonly fixtureId: string;
  readonly status: "passed" | "failed" | "infra_error";
  readonly initialFailureMatched: boolean;
  readonly cleanBaselineMatched: boolean;
  readonly certificate: AgentEvalPreflightCertificate | null;
  readonly beforeDiagnostic: AgentEvalOracleDiagnostic | null;
  readonly cleanDiagnostic: AgentEvalOracleDiagnostic | null;
  readonly actionCount: number;
  readonly durationMs: number;
  readonly browserErrorCount: number;
  readonly failureCode: string | null;
  readonly archivePath: string | null;
}

/** 预检参数；依赖仓库必须由调用方显式提供，避免评测期间联网安装。 */
export interface AgentEvalPreflightOptions {
  readonly fixtureId: string;
  readonly fixtureRoot?: string;
  readonly dependencyRepoRoot: string;
  readonly archiveRoot?: string;
  readonly timeoutMs?: number;
}

/** 游戏修复 Eval 当前支持的被测 Profile。 */
export type GameRepairEvalProfile = "pi-original" | "maintainer-current";

/** 一次真实模型游戏修复 Eval 的统一低敏结果。 */
export interface GameRepairEvalResultV5 {
  readonly schemaVersion: 5;
  readonly runId: string;
  readonly fixtureId: string;
  readonly profile: GameRepairEvalProfile;
  readonly repetition: number;
  readonly status: "passed" | "failed" | "infra_error";
  readonly externalCorrectness: {
    readonly initialFailureMatched: boolean;
    readonly afterOracleMatched: boolean | null;
    readonly forbiddenPathsUntouched: boolean | null;
    readonly headUnchanged: boolean | null;
  };
  readonly workflowClosure: PiWorkflowClosure;
  readonly agentOutcome: PiRunMetrics & {
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
  readonly provenance: BenchmarkProvenance | null;
  readonly agentFailureCode: string | null;
  readonly judgeFailureCode: string | null;
  readonly diagnostics: {
    readonly beforeOracle: AgentEvalOracleDiagnostic | null;
    readonly afterOracle: AgentEvalOracleDiagnostic | null;
    readonly lastToolName: string | null;
    readonly lastFinishStatus: string | null;
    readonly evidenceGraph: PiRunDiagnostics["evidenceGraph"];
  };
  readonly archivePath: string | null;
}

/** 一次真实模型游戏修复 Eval 的参数。 */
export interface GameRepairEvalOptions {
  readonly fixtureId: string;
  readonly fixtureRoot?: string;
  readonly dependencyRepoRoot: string;
  readonly profile: GameRepairEvalProfile;
  readonly repetition: number;
  readonly archiveRoot?: string;
  readonly timeoutMs?: number;
  readonly preflightCertificate?: AgentEvalPreflightCertificate;
  /** 仅转发当前模型的可见文本和工具名，不参与判分或归档。 */
  readonly onLiveEvent?: (event: PiMaintainerLiveEvent) => void;
}

function dependencyKey(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
}

function validPreflightCertificate(input: {
  readonly certificate: AgentEvalPreflightCertificate;
  readonly fixtureId: string;
  readonly buggyHead: string;
  readonly dependencyRepoRoot: string;
}): boolean {
  return input.certificate.schemaVersion === 1
    && input.certificate.fixtureId === input.fixtureId
    && input.certificate.buggyHead === input.buggyHead
    && input.certificate.dependencyKey === dependencyKey(input.dependencyRepoRoot)
    && input.certificate.oracleVersion === AGENT_EVAL_ORACLE_VERSION
    && input.certificate.beforeOracleMatched
    && input.certificate.cleanAfterOracleMatched;
}

/**
 * 判定一次游戏修复是否通过外部任务 Oracle。
 *
 * @param input 初始故障、修复后 Oracle 与 Git 安全边界事实。
 * @returns 仅当任务故障被复现、修复后目标满足且未改提交/禁写路径时为 true；不执行测试或构建。
 */
export function gameRepairExternalCorrectnessPassed(input: {
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
export function gameRepairJudgeOutcome(input: {
  readonly infrastructureFailure: boolean;
  readonly externalCorrectnessPassed: boolean;
  readonly workflowClosurePassed: boolean | null;
}): GameRepairEvalResultV5["judgeOutcome"] {
  const status = input.infrastructureFailure
    ? "infra_error"
    : input.externalCorrectnessPassed ? "passed" : "failed";
  return {
    status,
    externalCorrectnessPassed: input.externalCorrectnessPassed,
    workflowClosurePassed: input.workflowClosurePassed,
  };
}

interface AgentEvalOracleRun {
  readonly matched: boolean;
  readonly actionCount: number;
  readonly browserErrorCount: number;
  readonly failureCode: string | null;
  readonly diagnostic: AgentEvalOracleDiagnostic;
}

export interface AgentEvalOracleDiagnostic {
  readonly oracle: string;
  readonly finalStepIndex: number | null;
  readonly finalOp: AgentEvalReproductionStep["op"] | null;
  readonly finalFloor: number | null;
  readonly finalMode: string | null;
  readonly finalAdvanced: boolean | null;
  readonly finalBossDefeated: boolean | null;
  readonly reloadObserved: boolean;
  readonly queryEvents: readonly string[];
  readonly planClasses: readonly string[];
}

type AgentEvalObservation = AgentEvalOracleObservation;

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown-error";
  const message = error.message.toLowerCase();
  if (/^[a-z0-9-]+$/u.test(message)) return message;
  if (message.includes("chromium")) return "chromium-unavailable";
  if (message.includes("vite")) return "vite-unavailable";
  if (message.includes("node_modules")) return "dependencies-unavailable";
  if (message.includes("fixture") || message.includes("base.json")) return "fixture-invalid";
  return "eval-error";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 为一个物化仓库建立可回收的游戏依赖链接。
 *
 * @param repositoryRoot 已物化的临时仓库。
 * @param dependencyRepoRoot 已安装依赖的只读来源仓库。
 * @returns 本轮新建的链接 lease。
 * @throws 依赖缺失、目标已存在、路径相同或源不是目录时拒绝。
 */
export async function provisionAgentEvalDependencies(input: {
  readonly repositoryRoot: string;
  readonly dependencyRepoRoot: string;
}): Promise<AgentEvalDependencyLease> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const dependencyRepoRoot = resolve(input.dependencyRepoRoot);
  const source = resolve(dependencyRepoRoot, "game", "node_modules");
  const target = resolve(repositoryRoot, "game", "node_modules");
  if (source === target) throw new Error("评测依赖源不能与物化仓库相同");
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("dependencyRepoRoot/game/node_modules 必须是真实目录");
  }
  if (await exists(target)) throw new Error("物化仓库已经存在 node_modules");
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  return { target, source };
}

/** 删除本轮实际创建的依赖链接，不删除共享依赖目录。 */
export async function releaseAgentEvalDependencies(
  lease: AgentEvalDependencyLease,
): Promise<void> {
  const information = await lstat(lease.target);
  if (!information.isSymbolicLink()) throw new Error("拒绝删除非链接依赖目标");
  await rm(lease.target, { recursive: true, force: true });
}

async function executeStep(
  driver: GameDriver,
  step: AgentEvalReproductionStep,
  secretInputs: Readonly<Record<string, string>>,
): Promise<{
  readonly ok: boolean;
  readonly event: string;
  readonly view?: Awaited<ReturnType<GameDriver["currentView"]>>;
}> {
  if (step.op === "go") {
    const result = await driver.go(step.target, step.maxSteps);
    return { ok: result.ok, event: result.event, view: result.view };
  }
  if (step.op === "use") {
    const result = await driver.use(step.actionId);
    return { ok: result.ok, event: result.event, view: result.view };
  }
  if (step.op === "input-sql") {
    const sql = secretInputs[step.inputRef];
    if (sql === undefined) throw new Error("复现引用的隐藏输入不存在");
    const result = await driver.inputSql(sql);
    return { ok: result.ok, event: result.event, view: result.view };
  }
  if (step.op === "query") {
    const result = await driver.query();
    return { ok: result.ok, event: result.event, view: result.view };
  }
  if (step.op === "reload") {
    await driver.beginReproduction();
    const replay = await driver.reloadAndReplay([]);
    return { ok: replay.passed, event: replay.failure ?? "reloaded", view: replay.finalView };
  }
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, step.milliseconds));
  return { ok: true, event: "waited" };
}

async function runBrowserOracle(input: {
  readonly repositoryRoot: string;
  readonly testCase: AgentEvalCase;
  readonly phase: "before" | "after";
  readonly timeoutMs: number;
}): Promise<AgentEvalOracleRun> {
  let server: GameServer | null = null;
  let browser: GameBrowser | null = null;
  let actionCount = 0;
  let failureCode: string | null = null;
  const browserErrors: string[] = [];
  const observations: AgentEvalObservation[] = [];
  try {
    server = await startGameServer(input.repositoryRoot);
    browser = new GameBrowser(server.url, (kind) => browserErrors.push(kind), null);
    await browser.open(input.testCase.publicCase.startFloor, true);
    if (input.testCase.publicCase.startPreset) {
      await browser.prepare(input.testCase.publicCase.startPreset);
    }
    const driver = new GameDriver(browser);
    await driver.beginReproduction();
    const deadline = Date.now() + input.timeoutMs;
    let reloadObserved = false;
    for (let stepIndex = 0; stepIndex < input.testCase.reproduction.steps.length; stepIndex += 1) {
      const step = input.testCase.reproduction.steps[stepIndex];
      if (!step) continue;
      if (Date.now() > deadline) throw new Error("oracle-timeout");
      const result = await executeStep(
        driver,
        step,
        input.testCase.expected.secretInputs,
      );
      if (step.op === "reload") reloadObserved = true;
      const view = result.view ?? await driver.currentView();
      observations.push({
        ok: result.ok,
        event: result.event,
        stepIndex,
        op: step.op,
        isFinal: stepIndex === input.testCase.reproduction.steps.length - 1,
        reloadObserved,
        planClass: classifyAgentEvalPlan(view),
        view,
        judge: await driver.judge(input.testCase.publicCase.startFloor),
      });
      actionCount += 1;
    }
  } catch (error) {
    failureCode = safeErrorCode(error);
  } finally {
    await browser?.close().catch((error: unknown) => {
      failureCode ??= safeErrorCode(error);
    });
    await server?.close().catch((error: unknown) => {
      failureCode ??= safeErrorCode(error);
    });
  }
  let matched = false;
  if (!failureCode && browserErrors.length === 0) {
    try {
      matched = input.phase === "before"
        ? matchesBeforeOracle(input.testCase.expected.beforeOracle, observations)
        : matchesAfterOracle(input.testCase.expected.afterOracle, observations);
    } catch (error) {
      failureCode = safeErrorCode(error);
    }
  }
  return {
    matched,
    actionCount,
    browserErrorCount: browserErrors.length,
    failureCode,
    diagnostic: (() => {
      const final = observations.find((entry) => entry.isFinal) ?? observations.at(-1) ?? null;
      return {
        oracle: input.phase === "before"
          ? input.testCase.expected.beforeOracle
          : input.testCase.expected.afterOracle,
        finalStepIndex: final?.stepIndex ?? null,
        finalOp: final?.op ?? null,
        finalFloor: final?.view.floor ?? null,
        finalMode: final?.view.mode ?? null,
        finalAdvanced: final?.judge.advanced ?? null,
        finalBossDefeated: final?.judge.bossDefeated ?? null,
        reloadObserved: final?.reloadObserved ?? false,
        queryEvents: observations.filter((entry) => entry.op === "query").map((entry) => entry.event),
        planClasses: observations.filter((entry) => entry.op === "query").map((entry) => entry.planClass),
      };
    })(),
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

async function writeArchive(
  archiveRoot: string | undefined,
  result: AgentEvalPreflightResult,
): Promise<string | null> {
  if (!archiveRoot) return null;
  const directory = resolve(archiveRoot);
  await mkdir(directory, { recursive: true });
  const path = join(directory, result.fixtureId + "-preflight.json");
  await writeFile(path, JSON.stringify({ ...result, archivePath: null }, null, 2) + "\n", "utf8");
  return path;
}

async function writeGameRepairArchive(
  archiveRoot: string | undefined,
  result: GameRepairEvalResultV5,
): Promise<string | null> {
  if (!archiveRoot) return null;
  const directory = resolve(archiveRoot);
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    result.fixtureId + "-" + result.profile + "-" + String(result.repetition) + ".json",
  );
  await writeFile(path, JSON.stringify({ ...result, archivePath: null }, null, 2) + "\n", "utf8");
  return path;
}

/**
 * 运行一轮真实模型游戏修复 Eval。
 *
 * @param options 案例、依赖来源、Profile、重复编号和低敏归档目录。
 * @returns 同时包含任务正确性和模型运行指标的统一成绩单；不输出 Prompt、源码、SQL 或答案。
 * @remarks 当前 `pi-original` Profile 只运行原生 Pi 工具。优化版 Profile 会在后续分支
 * 复用相同的物化、Oracle 和指标层，保证比较只改变 Agent 编排策略；代码检查由被测
 * Maintainer 内部流程或独立质量门禁负责，不在外层逐案例重复执行。
 */
export async function runGameRepairEval(
  options: GameRepairEvalOptions,
): Promise<GameRepairEvalResultV5> {
  const startedAt = performance.now();
  const runId = randomUUID();
  let testCase: AgentEvalCase | null = null;
  let temporaryRoot: string | null = null;
  let materializedRoot: string | null = null;
  let dependencyLease: AgentEvalDependencyLease | null = null;
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
  let infrastructureFailure = false;
  let agentFailureCode: string | null = null;
  let judgeFailureCode: string | null = null;
  let beforeDiagnostic: AgentEvalOracleDiagnostic | null = null;
  let afterDiagnostic: AgentEvalOracleDiagnostic | null = null;
  let runDiagnostics: PiRunDiagnostics = {
    lastToolName: null,
    lastFinishStatus: null,
    evidenceGraph: [],
  };
  let workflowClosure: PiWorkflowClosure = {
    applicable: options.profile === "maintainer-current",
    taskState: null,
    proposed: options.profile === "maintainer-current" ? false : null,
    executed: options.profile === "maintainer-current" ? false : null,
    writeAttempted: options.profile === "maintainer-current" ? false : null,
    retainedChanges: options.profile === "maintainer-current" ? false : null,
    verified: options.profile === "maintainer-current" ? false : null,
    readyToApply: options.profile === "maintainer-current" ? false : null,
    paused: options.profile === "maintainer-current" ? false : null,
  };
  let provenance: BenchmarkProvenance | null = null;
  let piMetrics: PiRunMetrics = {
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
    taskQueuePeak: 0,
    episodes: 0,
    recoveries: 0,
    inspectCalls: 0,
    inspectExecutions: 0,
    inspectReceiptHits: 0,
    inspectBundles: 0,
    inspectBundleWindows: 0,
    inspectFailures: 0,
    routedSearchExpansions: 0,
    floorRoutedInspectCalls: 0,
    floorScopesVisited: 0,
    floorRouteCurrentExecutions: 0,
    floorRouteAdjacentExecutions: 0,
    floorRouteSharedExecutions: 0,
    floorRouteFallbackExecutions: 0,
    writeAttempts: 0,
    writeRejected: 0,
    writeFailures: 0,
    writeNoops: 0,
    writeMutations: 0,
    writeReplayFailures: 0,
    loopGuardBlocks: 0,
    telemetryParseErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    contextTokens: null,
    contextPercent: null,
    failureCode: null,
  };
  try {
    testCase = await readAgentEvalCase({
      id: options.fixtureId,
      ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
    });
    const timeoutMs = Math.min(
      options.timeoutMs ?? testCase.publicCase.timeoutMs,
      GAME_REPAIR_TIMEOUT_MAX_MS,
    );
    temporaryRoot = await mkdtemp(join(tmpdir(), "dungeon-game-repair-eval-"));
    materializedRoot = join(temporaryRoot, "repository");
    await materializeAgentEvalFixture({
      id: testCase.publicCase.fixtureId,
      ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
      destination: materializedRoot,
    });
    dependencyLease = await provisionAgentEvalDependencies({
      repositoryRoot: materializedRoot,
      dependencyRepoRoot: options.dependencyRepoRoot,
    });
    const baseHead = (await gitOutput(materializedRoot, ["rev-parse", "HEAD"])).trim();
    if (options.preflightCertificate) {
      if (!validPreflightCertificate({
        certificate: options.preflightCertificate,
        fixtureId: testCase.publicCase.fixtureId,
        buggyHead: baseHead,
        dependencyRepoRoot: options.dependencyRepoRoot,
      })) throw new Error("preflight-certificate-mismatch");
      initialFailureMatched = true;
    } else {
      const before = await runBrowserOracle({
        repositoryRoot: materializedRoot,
        testCase,
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
    provenance = await collectBenchmarkProvenance({
      repositoryRoot: materializedRoot,
      profile: options.profile,
      publicPrompt: testCase.publicCase.prompt,
    });
    agentStarted = true;
    const commonRunOptions = {
      runId,
      repositoryRoot: materializedRoot,
      runtimeRoot: join(temporaryRoot, "pi-runtime"),
      prompt: testCase.publicCase.prompt,
      timeoutMs,
    };
    const profileOutcome = options.profile === "pi-original"
      ? await runPiOriginal(commonRunOptions)
      : await runPiMaintainer({
          ...commonRunOptions,
        startFloor: testCase.publicCase.startFloor,
        startPreset: testCase.publicCase.startPreset,
        ...(options.onLiveEvent ? { onLiveEvent: options.onLiveEvent } : {}),
      });
    piMetrics = profileOutcome.metrics;
    const evaluationRoot = profileOutcome.evaluationRoot;
    workflowClosure = profileOutcome.workflowClosure;
    runDiagnostics = profileOutcome.diagnostics;
    if (piMetrics.failureCode) agentFailureCode = piMetrics.failureCode;
    if (piMetrics.status === "infra_error") infrastructureFailure = true;
    const after = await runBrowserOracle({
      repositoryRoot: evaluationRoot,
      testCase,
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
    forbiddenPathsUntouched = !touchesForbiddenPath(paths, testCase.expected.forbiddenPaths);
    const finalHead = (await gitOutput(evaluationRoot, ["rev-parse", "HEAD"])).trim();
    headUnchanged = baseHead === finalHead;
    if (!afterOracleMatched) judgeFailureCode ??= "after-oracle-not-matched";
    if (!forbiddenPathsUntouched) judgeFailureCode ??= "forbidden-path-changed";
    if (!headUnchanged) judgeFailureCode ??= "unexpected-commit";
  } catch (error) {
    if (!agentStarted) infrastructureFailure = true;
    judgeFailureCode ??= safeErrorCode(error);
  } finally {
    if (dependencyLease) {
      await releaseAgentEvalDependencies(dependencyLease).catch((error: unknown) => {
        infrastructureFailure = true;
        judgeFailureCode ??= safeErrorCode(error);
      });
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
        .catch((error: unknown) => {
          infrastructureFailure = true;
          judgeFailureCode ??= safeErrorCode(error);
        });
    }
  }
  const externalCorrectnessPassed = gameRepairExternalCorrectnessPassed({
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
  const judgeOutcome = gameRepairJudgeOutcome({
    infrastructureFailure,
    externalCorrectnessPassed,
    workflowClosurePassed,
  });
  const resultWithoutArchive: GameRepairEvalResultV5 = {
    schemaVersion: 5,
    runId,
    fixtureId: options.fixtureId,
    profile: options.profile,
    repetition: options.repetition,
    status: judgeOutcome.status,
    externalCorrectness: {
      initialFailureMatched,
      afterOracleMatched,
      forbiddenPathsUntouched,
      headUnchanged,
    },
    workflowClosure,
    agentOutcome: {
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
    modelId: provenance?.modelId ?? null,
    provenance,
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
  const archivePath = await writeGameRepairArchive(options.archiveRoot, resultWithoutArchive)
    .catch(() => null);
  return { ...resultWithoutArchive, archivePath };
}

/**
 * 执行一个案例的零 Token 初始故障预检。
 *
 * @param options 案例、依赖来源和可选归档目录。
 * @returns 低敏预检结果；模型不会在该阶段启动。
 * @remarks 预检会创建并删除临时仓库、Vite、Chromium 和依赖链接，适合每次 Eval
 * 前运行。依赖、浏览器或案例格式错误属于 `infra_error`，不会被算作 Agent 失败。
 */
export async function runAgentEvalPreflight(
  options: AgentEvalPreflightOptions,
): Promise<AgentEvalPreflightResult> {
  const startedAt = performance.now();
  let testCase: AgentEvalCase | null = null;
  let temporaryRoot: string | null = null;
  let materializedRoot: string | null = null;
  let dependencyLease: AgentEvalDependencyLease | null = null;
  let cleanDependencyLease: AgentEvalDependencyLease | null = null;
  let actionCount = 0;
  let initialFailureMatched = false;
  let cleanBaselineMatched = false;
  let certificate: AgentEvalPreflightCertificate | null = null;
  let beforeDiagnostic: AgentEvalOracleDiagnostic | null = null;
  let cleanDiagnostic: AgentEvalOracleDiagnostic | null = null;
  let failureCode: string | null = null;
  let browserErrorCount = 0;
  try {
    testCase = await readAgentEvalCase({
      id: options.fixtureId,
      ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
    });
    const timeoutMs = options.timeoutMs ?? testCase.publicCase.timeoutMs;
    temporaryRoot = await mkdtemp(join(tmpdir(), "dungeon-agent-eval-"));
    materializedRoot = join(temporaryRoot, "repository");
    await materializeAgentEvalFixture({
      id: testCase.publicCase.fixtureId,
      ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
      destination: materializedRoot,
    });
    dependencyLease = await provisionAgentEvalDependencies({
      repositoryRoot: materializedRoot,
      dependencyRepoRoot: options.dependencyRepoRoot,
    });
    const oracle = await runBrowserOracle({
      repositoryRoot: materializedRoot,
      testCase,
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
      await materializeAgentEvalFixture({
        id: testCase.publicCase.fixtureId,
        ...(options.fixtureRoot ? { fixtureRoot: options.fixtureRoot } : {}),
        destination: cleanRoot,
        variant: "clean",
      });
      cleanDependencyLease = await provisionAgentEvalDependencies({
        repositoryRoot: cleanRoot,
        dependencyRepoRoot: options.dependencyRepoRoot,
      });
      const cleanOracle = await runBrowserOracle({
        repositoryRoot: cleanRoot,
        testCase,
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
          schemaVersion: 1,
          fixtureId: testCase.publicCase.fixtureId,
          buggyHead: (await gitOutput(materializedRoot, ["rev-parse", "HEAD"])).trim(),
          dependencyKey: dependencyKey(options.dependencyRepoRoot),
          oracleVersion: AGENT_EVAL_ORACLE_VERSION,
          beforeOracleMatched: true,
          cleanAfterOracleMatched: true,
        };
      }
    }
  } catch (error) {
    failureCode = safeErrorCode(error);
  } finally {
    if (cleanDependencyLease) {
      await releaseAgentEvalDependencies(cleanDependencyLease).catch((error: unknown) => {
        failureCode ??= safeErrorCode(error);
      });
    }
    if (dependencyLease) {
      await releaseAgentEvalDependencies(dependencyLease).catch((error: unknown) => {
        failureCode ??= safeErrorCode(error);
      });
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
        .catch((error: unknown) => { failureCode ??= safeErrorCode(error); });
    }
  }
  const resultWithoutArchive: AgentEvalPreflightResult = {
    schemaVersion: 2,
    fixtureId: options.fixtureId,
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
  const archivePath = await writeArchive(options.archiveRoot, resultWithoutArchive)
    .catch(() => null);
  return { ...resultWithoutArchive, archivePath };
}
