/**
 * 浏览器 Oracle 执行器。
 *
 * 本模块只负责依赖链接、游戏进程、固定复现动作和低敏诊断。纯判定规则留在
 * `oracle.ts`，fixture 读取与预检编排留在各自模块。
 */

import { lstat, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { GameBrowser } from "../../game/browser.js";
import { GameDriver } from "../../game/driver.js";
import { startGameServer, type GameServer } from "../../game/server.js";
import {
  classifyEvalOraclePlan,
  matchesAfterOracle,
  matchesBeforeOracle,
  type EvalOracleObservation,
} from "../domain/oracle.js";
import type { EvalScenario, EvalScenarioStep } from "../domain/scenario.js";

/** 依赖链接的本轮所有权。共享依赖目标永远不属于 lease。 */
export interface EvalDependencyLease {
  readonly target: string;
  readonly source: string;
}

/** 一轮浏览器 Oracle 的低敏诊断。 */
export interface EvalOracleDiagnostic {
  readonly oracle: string;
  readonly finalStepIndex: number | null;
  readonly finalOp: EvalScenarioStep["op"] | null;
  readonly finalEvent: string | null;
  readonly finalFloor: number | null;
  readonly finalMode: string | null;
  readonly finalAdvanced: boolean | null;
  readonly finalBossDefeated: boolean | null;
  readonly finalClaimableReward: string | null;
  readonly finalVictories: number | null;
  readonly reloadObserved: boolean;
  readonly stepEvents: readonly string[];
  readonly queryEvents: readonly string[];
  readonly planClasses: readonly string[];
}

export interface EvalOracleRun {
  readonly matched: boolean;
  readonly actionCount: number;
  readonly browserErrorCount: number;
  readonly failureCode: string | null;
  readonly diagnostic: EvalOracleDiagnostic;
}

/** 把异常正文压缩为不含凭据、路径或模型正文的稳定 Eval 原因码。 */
export function evalFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown-error";
  const message = error.message.toLowerCase();
  if (/^[a-z0-9-]+$/u.test(message)) return message;
  if (
    message.includes("blocked_env")
    || message.includes("api key")
    || message.includes("api_key")
    || message.includes("鉴权")
  ) return "model-auth-unavailable";
  if (message.includes("model") || message.includes("provider")) return "model-unavailable";
  if (message.includes("chromium")) return "chromium-unavailable";
  if (message.includes("vite")) return "vite-unavailable";
  if (message.includes("node_modules")) return "dependencies-unavailable";
  if (message.includes("fixture") || message.includes("base.json")) return "fixture-invalid";
  return "eval-error";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 为一个物化仓库建立可回收的游戏依赖链接。 */
export async function provisionEvalDependencies(input: {
  readonly repositoryRoot: string;
  readonly dependencyRepoRoot: string;
}): Promise<EvalDependencyLease> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const dependencyRepoRoot = resolve(input.dependencyRepoRoot);
  const source = resolve(dependencyRepoRoot, "game", "node_modules");
  const target = resolve(repositoryRoot, "game", "node_modules");
  if (source === target) throw new Error("评测依赖源不能与物化仓库相同");
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("dependencyRepoRoot/game/node_modules 必须是真实目录");
  }
  if (await pathExists(target)) throw new Error("物化仓库已经存在 node_modules");
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  return { target, source };
}

/** 删除本轮实际创建的依赖链接，不删除共享依赖目录。 */
export async function releaseEvalDependencies(lease: EvalDependencyLease): Promise<void> {
  const information = await lstat(lease.target);
  if (!information.isSymbolicLink()) throw new Error("拒绝删除非链接依赖目标");
  await rm(lease.target, { recursive: true, force: true });
}

async function executeStep(
  driver: GameDriver,
  step: EvalScenarioStep,
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

/** 在全新 Vite/Chromium 上下文中执行一次固定 Oracle。 */
export async function runEvalBrowserOracle(input: {
  readonly repositoryRoot: string;
  readonly scenario: EvalScenario;
  readonly phase: "before" | "after";
  readonly timeoutMs: number;
}): Promise<EvalOracleRun> {
  let server: GameServer | null = null;
  let browser: GameBrowser | null = null;
  let actionCount = 0;
  let failureCode: string | null = null;
  const browserErrors: string[] = [];
  const observations: EvalOracleObservation[] = [];
  try {
    server = await startGameServer(input.repositoryRoot);
    browser = new GameBrowser(server.url, (kind) => browserErrors.push(kind), null);
    await browser.open(input.scenario.publicCase.startFloor, true);
    if (input.scenario.publicCase.startPreset) {
      await browser.prepare(input.scenario.publicCase.startPreset);
    }
    const driver = new GameDriver(browser);
    await driver.beginReproduction();
    const deadline = Date.now() + input.timeoutMs;
    let reloadObserved = false;
    for (let stepIndex = 0; stepIndex < input.scenario.reproduction.steps.length; stepIndex += 1) {
      const step = input.scenario.reproduction.steps[stepIndex];
      if (!step) continue;
      if (Date.now() > deadline) throw new Error("oracle-timeout");
      const result = await executeStep(driver, step, input.scenario.expected.secretInputs);
      if (step.op === "reload") reloadObserved = true;
      const view = result.view ?? await driver.currentView();
      observations.push({
        ok: result.ok,
        event: result.event,
        stepIndex,
        op: step.op,
        isFinal: stepIndex === input.scenario.reproduction.steps.length - 1,
        reloadObserved,
        planClass: classifyEvalOraclePlan(view),
        view,
        judge: await driver.judge(input.scenario.publicCase.startFloor),
      });
      actionCount += 1;
    }
  } catch (error) {
    failureCode = evalFailureCode(error);
  } finally {
    await browser?.close().catch((error: unknown) => {
      failureCode ??= evalFailureCode(error);
    });
    await server?.close().catch((error: unknown) => {
      failureCode ??= evalFailureCode(error);
    });
  }
  let matched = false;
  if (!failureCode && browserErrors.length === 0) {
    try {
      matched = input.phase === "before"
        ? matchesBeforeOracle(input.scenario.expected.beforeOracle, observations)
        : matchesAfterOracle(input.scenario.expected.afterOracle, observations);
    } catch (error) {
      failureCode = evalFailureCode(error);
    }
  }
  const final = observations.find((entry) => entry.isFinal) ?? observations.at(-1) ?? null;
  return {
    matched,
    actionCount,
    browserErrorCount: browserErrors.length,
    failureCode,
    diagnostic: {
      oracle: input.phase === "before"
        ? input.scenario.expected.beforeOracle
        : input.scenario.expected.afterOracle,
      finalStepIndex: final?.stepIndex ?? null,
      finalOp: final?.op ?? null,
      finalEvent: final?.event ?? null,
      finalFloor: final?.view.floor ?? null,
      finalMode: final?.view.mode ?? null,
      finalAdvanced: final?.judge.advanced ?? null,
      finalBossDefeated: final?.judge.bossDefeated ?? null,
      finalClaimableReward: final?.judge.claimableReward ?? null,
      finalVictories: final?.judge.victories ?? null,
      reloadObserved: final?.reloadObserved ?? false,
      stepEvents: observations.map((entry) => entry.event),
      queryEvents: observations.filter((entry) => entry.op === "query").map((entry) => entry.event),
      planClasses: observations.filter((entry) => entry.op === "query").map((entry) => entry.planClass),
    },
  };
}

/** 预检遇到瞬时页面错误时，用全新 Vite/Chromium 上下文重试一次。 */
export async function runEvalPreflightBrowserOracle(
  input: Parameters<typeof runEvalBrowserOracle>[0],
): Promise<EvalOracleRun> {
  const first = await runEvalBrowserOracle(input);
  return first.browserErrorCount > 0 ? await runEvalBrowserOracle(input) : first;
}
