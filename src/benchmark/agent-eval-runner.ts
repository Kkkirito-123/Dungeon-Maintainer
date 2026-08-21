/**
 * 游戏修复 Agent Eval 的确定性准备与零 Token 预检。
 *
 * 本模块负责读取案例、物化临时 Git 仓库、复用显式依赖目录、启动 Vite/无头
 * Chromium 并执行固定复现动作。它不启动模型、不把隐藏 expected 或 SQL 返回给
 * Agent，也不负责判断模型修改是否正确。所有资源都通过本轮 lease 记录，并在
 * finally 中按固定顺序回收；预检失败会返回低敏结果而不是留下后台进程。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readAgentEvalCase, type AgentEvalCase, type AgentEvalReproductionStep } from "./agent-eval-case.js";
import { materializeAgentEvalFixture } from "./agent-eval-fixture.js";
import { runPiOriginal, type PiOriginalRunMetrics } from "./pi-original.js";
import { GameBrowser } from "../game/browser.js";
import { GameDriver } from "../game/driver.js";
import { startGameServer, type GameServer } from "../game/server.js";

const executeFile = promisify(execFile);

/** 依赖链接的本轮所有权。共享依赖目标永远不属于 lease。 */
export interface AgentEvalDependencyLease {
  readonly target: string;
  readonly source: string;
}

/** 零模型预检结果；不包含 SQL、源码、模型正文或绝对临时路径。 */
export interface AgentEvalPreflightResult {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly status: "passed" | "failed" | "infra_error";
  readonly initialFailureMatched: boolean;
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
export type GameRepairEvalProfile = "pi-original";

/** 单个固定检查的低敏结果。 */
export interface AgentEvalCheckResult {
  readonly passed: boolean;
  readonly durationMs: number;
}

/** 一次真实模型游戏修复 Eval 的统一低敏结果。 */
export interface GameRepairEvalResultV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly fixtureId: string;
  readonly profile: GameRepairEvalProfile;
  readonly repetition: number;
  readonly status: "passed" | "failed" | "infra_error";
  readonly correctness: {
    readonly initialFailureMatched: boolean;
    readonly afterOracleMatched: boolean;
    readonly requiredChecksPassed: boolean;
    readonly forbiddenPathsUntouched: boolean;
    readonly headUnchanged: boolean;
  };
  readonly metrics: PiOriginalRunMetrics & {
    readonly totalDurationMs: number;
    readonly beforeActionCount: number;
    readonly afterActionCount: number;
    readonly browserErrorCount: number;
    readonly requiredCheckCount: number;
    readonly passedCheckCount: number;
    readonly checkDurationMs: number;
    readonly changedFileCount: number;
  };
  readonly failureCode: string | null;
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
}

interface AgentEvalOracleRun {
  readonly matched: boolean;
  readonly actionCount: number;
  readonly browserErrorCount: number;
  readonly failureCode: string | null;
}

interface AgentEvalObservation {
  readonly ok: boolean;
  readonly event: string;
  readonly view: Awaited<ReturnType<GameDriver["currentView"]>>;
  readonly judge: Awaited<ReturnType<GameDriver["judge"]>>;
}

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
): Promise<{ readonly ok: boolean; readonly event: string }> {
  if (step.op === "go") {
    const result = await driver.go(step.target, step.maxSteps);
    return { ok: result.ok, event: result.event };
  }
  if (step.op === "use") {
    const result = await driver.use(step.actionId);
    return { ok: result.ok, event: result.event };
  }
  if (step.op === "input-sql") {
    const sql = secretInputs[step.inputRef];
    if (sql === undefined) throw new Error("复现引用的隐藏输入不存在");
    const result = await driver.inputSql(sql);
    return { ok: result.ok, event: result.event };
  }
  if (step.op === "query") {
    const result = await driver.query();
    return { ok: result.ok, event: result.event };
  }
  if (step.op === "reload") {
    await driver.beginReproduction();
    const replay = await driver.reloadAndReplay([]);
    return { ok: replay.passed, event: replay.failure ?? "reloaded" };
  }
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, step.milliseconds));
  return { ok: true, event: "waited" };
}

function matchesBeforeOracle(
  oracle: string,
  observations: readonly AgentEvalObservation[],
): boolean {
  if (oracle === "terminal-action-unavailable") {
    return observations.some((entry) => !entry.ok && entry.event === "action-not-available");
  }
  if (oracle === "no-failure") return observations.every((entry) => entry.ok);
  if (oracle === "query-rejected") return observations.some((entry) => entry.event === "query-rejected");
  if (oracle === "combat-stalled") return observations.some((entry) => (
    entry.event === "query-accepted" && (entry.judge.stageIndex ?? 0) === 0
  ));
  if (oracle === "boss-stuck-one-hp") return observations.some((entry) => entry.judge.bossHp === 1);
  if (oracle === "reward-missing") return observations.some((entry) => (entry.judge.claimableReward ?? null) === null);
  if (oracle === "portal-blocked") return observations.some((entry) => (
    entry.event !== "query-accepted" && entry.view.mode === "explore" && !entry.judge.advanced
  ));
  if (oracle === "floor-transition-stuck") return observations.some((entry) => (
    entry.view.mode === "explore" && entry.judge.bossDefeated && !entry.judge.advanced
  ));
  if (oracle === "transition-stuck") return observations.some((entry) => (
    entry.view.mode === "transition" && !entry.judge.advanced
  ));
  if (oracle === "boss-hp-reset") {
    return observations.some((entry) => (
      entry.event === "query-accepted"
      && entry.judge.lessons === entry.judge.requiredLessons
      && !entry.judge.bossDefeated
      && (entry.judge.bossHp ?? 0) > 0
    ));
  }
  if (oracle === "transition-lost") {
    const transitionAt = observations.findIndex((entry) => entry.view.mode === "transition");
    return transitionAt >= 0 && observations.slice(transitionAt + 1).some((entry) => (
      entry.view.mode === "explore" && !entry.judge.advanced
    ));
  }
  if (oracle === "sandbox-state-leaked") {
    const queryEvents = observations.filter((entry) => entry.event.startsWith("query-"));
    return queryEvents.some((entry) => entry.event === "query-accepted")
      && queryEvents.some((entry) => entry.event === "query-rejected");
  }
  if (oracle === "stale-query-plan") return observations.some((entry) => (
    entry.view.terminal?.plan.some((line) => line.includes("SCAN")) ?? false
  ));
  if (oracle === "plan-placeholder") return observations.some((entry) => (
    entry.view.terminal?.plan.some((line) => line.includes("等待 EXPLAIN")) ?? false
  ));
  if (oracle === "plan-missing") return observations.some((entry) => (
    entry.event === "query-accepted" && (entry.view.terminal?.plan.length ?? 0) === 0
  ));
  if (oracle === "guidance-route-missing") return observations.some((entry) => (
    entry.judge.lessons < entry.judge.requiredLessons
    && entry.judge.guidanceDistance === null
  ));
  if (oracle === "victory-count-duplicated") return observations.some((entry) => (entry.judge.victories ?? 0) > 1);
  if (oracle === "victory-not-committed") return observations.some((entry) => entry.view.mode !== "victory");
  throw new Error("不支持的 beforeOracle：" + oracle);
}

function matchesAfterOracle(
  oracle: string,
  observations: readonly AgentEvalObservation[],
): boolean {
  if (oracle === "terminal-action-available") {
    return observations.some((entry) => entry.ok && entry.event === "action:terminal");
  }
  if (oracle === "no-failure") return observations.every((entry) => entry.ok);
  if (oracle === "query-accepted") return observations.some((entry) => entry.event === "query-accepted");
  if (oracle === "combat-progressed") return observations.some((entry) => (
    entry.event === "query-accepted" && (entry.judge.stageIndex ?? 0) > 0
  ));
  if (oracle === "boss-defeated") return observations.some((entry) => entry.judge.bossDefeated);
  if (oracle === "reward-available") return observations.some((entry) => (entry.judge.claimableReward ?? null) !== null);
  if (oracle === "portal-unlocked") return observations.some((entry) => entry.view.mode === "combat");
  if (oracle === "floor-advanced") return observations.some((entry) => entry.judge.advanced || entry.view.floor > entry.judge.floor);
  if (oracle === "boss-hp-zero") {
    const defeatedAt = observations.findIndex((entry) => entry.judge.bossDefeated);
    return defeatedAt >= 0 && observations.slice(defeatedAt).every((entry) => entry.judge.bossDefeated || entry.judge.advanced);
  }
  if (oracle === "transition-restored") {
    const last = observations.at(-1);
    return Boolean(last && (last.view.mode === "transition" || last.judge.advanced));
  }
  if (oracle === "sandbox-isolated") {
    const queryEvents = observations.filter((entry) => entry.event.startsWith("query-"));
    return queryEvents.length >= 2 && queryEvents.every((entry) => entry.event === "query-accepted");
  }
  if (oracle === "query-plan-current") return observations.some((entry) => (
    entry.view.terminal?.plan.some((line) => line.includes("SEARCH")) ?? false
  ));
  if (oracle === "guidance-route-available") return observations.some((entry) => (
    typeof entry.judge.guidanceDistance === "number"
  ));
  if (oracle === "victory-count-once") return observations.some((entry) => entry.view.mode === "victory" && (entry.judge.victories ?? 0) === 1);
  if (oracle === "victory-committed") return observations.some((entry) => entry.view.mode === "victory");
  throw new Error("不支持的 afterOracle：" + oracle);
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
    for (const step of input.testCase.reproduction.steps) {
      if (Date.now() > deadline) throw new Error("oracle-timeout");
      const result = await executeStep(
        driver,
        step,
        input.testCase.expected.secretInputs,
      );
      observations.push({
        ...result,
        view: await driver.currentView(),
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
  };
}

const CHECK_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  "game-test": ["test"],
  "game-architecture": ["architecture:check"],
  "game-build": ["build"],
};

async function runRequiredChecks(
  repositoryRoot: string,
  checkIds: readonly string[],
): Promise<AgentEvalCheckResult[]> {
  const results: AgentEvalCheckResult[] = [];
  const pnpmCli = process.platform === "win32"
    ? join(
      process.env.APPDATA?.trim() || "",
      "npm",
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.cjs",
    )
    : null;
  if (pnpmCli) {
    const information = await lstat(pnpmCli);
    if (!information.isFile()) throw new Error("pnpm-cli-unavailable");
  }
  for (const checkId of checkIds) {
    const args = CHECK_ARGUMENTS[checkId];
    const startedAt = performance.now();
    if (!args) {
      results.push({ passed: false, durationMs: 0 });
      continue;
    }
    try {
      await executeFile(
        pnpmCli ? process.execPath : "pnpm",
        [...(pnpmCli ? [pnpmCli] : []), ...args],
        {
        cwd: join(repositoryRoot, "game"),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        },
      );
      results.push({
        passed: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch {
      results.push({
        passed: false,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }
  return results;
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
  result: GameRepairEvalResultV1,
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
 * @returns 同时包含正确性和模型运行指标的统一成绩单；不输出 Prompt、源码、SQL 或答案。
 * @remarks 当前 `pi-original` Profile 只运行原生 Pi 工具。优化版 Profile 会在后续分支
 * 复用相同的物化、Oracle、检查和指标层，保证比较只改变 Agent 编排策略。
 */
export async function runGameRepairEval(
  options: GameRepairEvalOptions,
): Promise<GameRepairEvalResultV1> {
  const startedAt = performance.now();
  const runId = randomUUID();
  let testCase: AgentEvalCase | null = null;
  let temporaryRoot: string | null = null;
  let materializedRoot: string | null = null;
  let dependencyLease: AgentEvalDependencyLease | null = null;
  let initialFailureMatched = false;
  let afterOracleMatched = false;
  let browserErrorCount = 0;
  let beforeActionCount = 0;
  let afterActionCount = 0;
  let checkDurationMs = 0;
  let requiredCheckCount = 0;
  let passedCheckCount = 0;
  let changedFileCount = 0;
  let forbiddenPathsUntouched = true;
  let headUnchanged = true;
  let agentStarted = false;
  let infrastructureFailure = false;
  let failureCode: string | null = null;
  let piMetrics: PiOriginalRunMetrics = {
    status: "infra_error",
    durationMs: 0,
    diagnosisMs: null,
    turns: 0,
    toolCalls: 0,
    diagnosticToolCalls: 0,
    readCalls: 0,
    writeCalls: 0,
    consecutiveDuplicateToolCalls: 0,
    queuePeak: 0,
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
    const timeoutMs = options.timeoutMs ?? testCase.publicCase.timeoutMs;
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
    const before = await runBrowserOracle({
      repositoryRoot: materializedRoot,
      testCase,
      phase: "before",
      timeoutMs,
    });
    initialFailureMatched = before.matched;
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
    const baseHead = (await gitOutput(materializedRoot, ["rev-parse", "HEAD"])).trim();
    agentStarted = true;
    piMetrics = await runPiOriginal({
      runId,
      repositoryRoot: materializedRoot,
      runtimeRoot: join(temporaryRoot, "pi-runtime"),
      prompt: testCase.publicCase.prompt,
      timeoutMs,
    });
    if (piMetrics.failureCode) failureCode = piMetrics.failureCode;
    if (piMetrics.status === "infra_error") infrastructureFailure = true;
    const after = await runBrowserOracle({
      repositoryRoot: materializedRoot,
      testCase,
      phase: "after",
      timeoutMs,
    });
    afterOracleMatched = after.matched;
    afterActionCount = after.actionCount;
    browserErrorCount += after.browserErrorCount;
    failureCode ??= after.failureCode;
    const checkStartedAt = performance.now();
    const checkResults = await runRequiredChecks(
      materializedRoot,
      testCase.expected.requiredChecks,
    );
    checkDurationMs = Math.round(performance.now() - checkStartedAt);
    requiredCheckCount = checkResults.length;
    passedCheckCount = checkResults.filter((entry) => entry.passed).length;
    const paths = await changedPaths(materializedRoot);
    changedFileCount = paths.length;
    forbiddenPathsUntouched = !touchesForbiddenPath(paths, testCase.expected.forbiddenPaths);
    const finalHead = (await gitOutput(materializedRoot, ["rev-parse", "HEAD"])).trim();
    headUnchanged = baseHead === finalHead;
    if (!afterOracleMatched) failureCode ??= "after-oracle-not-matched";
    if (passedCheckCount !== requiredCheckCount) failureCode ??= "required-check-failed";
    if (!forbiddenPathsUntouched) failureCode ??= "forbidden-path-changed";
    if (!headUnchanged) failureCode ??= "unexpected-commit";
  } catch (error) {
    if (!agentStarted) infrastructureFailure = true;
    failureCode ??= safeErrorCode(error);
  } finally {
    if (dependencyLease) {
      await releaseAgentEvalDependencies(dependencyLease).catch((error: unknown) => {
        infrastructureFailure = true;
        failureCode ??= safeErrorCode(error);
      });
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
        .catch((error: unknown) => {
          infrastructureFailure = true;
          failureCode ??= safeErrorCode(error);
        });
    }
  }
  const resultWithoutArchive: GameRepairEvalResultV1 = {
    schemaVersion: 1,
    runId,
    fixtureId: options.fixtureId,
    profile: options.profile,
    repetition: options.repetition,
    status: infrastructureFailure ? "infra_error" : failureCode ? "failed" : "passed",
    correctness: {
      initialFailureMatched,
      afterOracleMatched,
      requiredChecksPassed: requiredCheckCount === passedCheckCount,
      forbiddenPathsUntouched,
      headUnchanged,
    },
    metrics: {
      ...piMetrics,
      totalDurationMs: Math.round(performance.now() - startedAt),
      beforeActionCount,
      afterActionCount,
      browserErrorCount,
      requiredCheckCount,
      passedCheckCount,
      checkDurationMs,
      changedFileCount,
    },
    failureCode,
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
  let actionCount = 0;
  let initialFailureMatched = false;
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
    failureCode = oracle.failureCode
      ?? (initialFailureMatched ? null : "initial-failure-not-matched");
  } catch (error) {
    failureCode = safeErrorCode(error);
  } finally {
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
    schemaVersion: 1,
    fixtureId: options.fixtureId,
    status: failureCode
      ? (failureCode === "initial-failure-not-matched" ? "failed" : "infra_error")
      : "passed",
    initialFailureMatched,
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
