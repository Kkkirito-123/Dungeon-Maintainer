/**
 * SQL Dungeon 确定性试玩状态执行器。
 *
 * 试玩不使用 LLM：Runner 根据玩家投影的稳定 `mode/actions` 选择固定动作，移动和
 * 路线规划交给游戏桥内部 BFS。优先级依次为关闭阻塞覆盖层、提交桥内答案、领取或
 * 离开结算、必要交互、前往 objective；objective 无路时桥内部回退最近 frontier。
 * 每批最多移动 64 个真实步，状态变化后重新规划。连续五次签名不变或三次相同错误
 * 会停止并分类，防止死循环；一个楼层失败不会阻止后续目标楼层。
 *
 * 隐藏裁判只用于最终 PASS 断言，它的结果不会作为动作提示，也不会进入维护模型。
 * 截图和步骤仅保存脱敏证据。试玩本身的 token 使用恒为 0。
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { verifyProject } from "./adapter.js";
import {
  BrowserError, GameBrowser, startGame, type BrowserResult, type PlayJudge, type PlayView,
} from "./browser.js";
import {
  type FloorReport, type PlayReport, type PlayStatus, type PlayStep, type PlayTrace,
  writePlayReport,
} from "./report.js";
import { hashWorktree } from "../../safety/worktree.js";
import { redactText } from "../../safety/redact.js";

const MAX_TURNS = 600;
const MAX_MOVES = 20_000;
const NO_PROGRESS_LIMIT = 5;
const SAME_ERROR_LIMIT = 3;

/** `runPlaytest` 的可信本地参数；不接受模型命令或 SQL。 */
export interface PlayOptions {
  repoRoot: string;
  outputRoot: string;
  floors: number[];
  headed: boolean;
  url?: string;
  signal?: AbortSignal;
}

/** 便于测试注入的协议 v2 浏览器最小接口。 */
export interface PlayBrowser {
  openFloor(floor: number): Promise<PlayView>;
  look(): Promise<PlayView>;
  go(target: "objective" | "frontier", maxSteps: number): Promise<BrowserResult>;
  use(actionId: string): Promise<BrowserResult>;
  query(): Promise<BrowserResult>;
  judge(floor: number): Promise<PlayJudge>;
  wait(ms?: number): Promise<void>;
  screenshot(path: string): Promise<void>;
}

interface Counts {
  battles: number;
  queries: number;
  deaths: number;
  stuck: number;
  moves: number;
}

function signature(view: PlayView): string {
  return JSON.stringify({
    floor: view.floor,
    mode: view.mode,
    hp: view.hp,
    progress: view.progress,
    actions: view.actions.map((action) => action.id),
    room: view.room,
    mission: view.mission.title,
    record: view.record ? [view.record.kicker, view.record.title] : null,
  });
}

function trace(view: PlayView): PlayTrace {
  const safe = (value: string) => redactText(value).replace(/\s+/gu, " ").trim().slice(0, 240);
  return {
    mission: safe(view.mission.title),
    prompt: safe(view.prompt),
    banner: safe(view.banner),
    actions: view.actions.map((action) => action.id).slice(0, 12),
  };
}

function passed(judge: PlayJudge, floor: number): boolean {
  return judge.bossDefeated && judge.lessons >= judge.requiredLessons && (
    floor === 8 ? judge.migrationComplete : judge.advanced
  );
}

function statusFromFailure(error: unknown, noProgress: number, sameError: number): PlayStatus {
  if (noProgress >= NO_PROGRESS_LIMIT) return "LIMIT_REACHED";
  if (sameError >= SAME_ERROR_LIMIT || error instanceof BrowserError) return "BLOCKED_TOOL";
  return "FAIL_GAME";
}

function nextAction(view: PlayView): { kind: "use"; id: string } | { kind: "query" } | { kind: "go"; target: "objective" | "frontier" } | { kind: "wait" } {
  const ids = new Set(view.actions.map((action) => action.id));
  for (const id of ["continue", "close-review", "take-all", "leave-loot", "close-inventory", "leave"] as const) {
    if (ids.has(id)) return { kind: "use", id };
  }
  if (ids.has("wait")) return { kind: "wait" };
  if (view.mode === "combat" || view.mode === "challenge" || ids.has("query")) return { kind: "query" };
  if (ids.has("interact")) return { kind: "use", id: "interact" };
  if (ids.has("objective")) return { kind: "go", target: "objective" };
  if (ids.has("frontier")) return { kind: "go", target: "frontier" };
  if (ids.has("rest")) return { kind: "use", id: "rest" };
  return { kind: "wait" };
}

async function perform(browser: PlayBrowser, action: ReturnType<typeof nextAction>): Promise<BrowserResult> {
  if (action.kind === "use") return await browser.use(action.id);
  if (action.kind === "query") return await browser.query();
  if (action.kind === "go") return await browser.go(action.target, 64);
  // 正式游戏在 Reduced Motion 下仍保留 900ms 的层末结算展示。一次等待跨过完整
  // 窗口，避免五次短轮询恰好触发“连续无进展”上限而误报 MIGRATE 卡死。
  await browser.wait(1_000);
  return { ok: true, event: "passive-wait", steps: 0, view: await browser.look() };
}

/**
 * 在已启动浏览器中执行一个楼层。
 * @param browser 只实现协议 v2 固定方法的浏览器。
 * @param floor 1 至 8。
 * @param steps 本次 suite 共享的脱敏步骤数组。
 * @param screenshotDir 失败或成功终态截图目录。
 * @param signal 取消信号。
 * @returns 客观楼层报告；不会抛出普通游戏失败。
 */
export async function runFloor(
  browser: PlayBrowser,
  floor: number,
  steps: PlayStep[],
  screenshotDir: string,
  signal?: AbortSignal,
): Promise<FloorReport> {
  const started = performance.now();
  const counts: Counts = { battles: 0, queries: 0, deaths: 0, stuck: 0, moves: 0 };
  let previous = "";
  let previousMode = "";
  let noProgress = 0;
  let lastError = "";
  let sameError = 0;
  let terminalError: unknown = null;
  let judge: PlayJudge = {
    floor, mode: "unknown", lessons: 0, requiredLessons: 0, bossDefeated: false,
    migrationSteps: 0, migrationComplete: false, advanced: false,
  };

  try {
    await browser.openFloor(floor);
    for (let turn = 0; turn < MAX_TURNS && counts.moves <= MAX_MOVES; turn += 1) {
      signal?.throwIfAborted();
      const view = await browser.look();
      judge = await browser.judge(floor);
      if (passed(judge, floor)) break;
      if (view.mode === "combat" && previousMode !== "combat") counts.battles += 1;
      if (view.mode === "death-review" && previousMode !== "death-review") counts.deaths += 1;
      previousMode = view.mode;
      const action = nextAction(view);
      const before = performance.now();
      let result: BrowserResult;
      try {
        result = await perform(browser, action);
      } catch (error) {
        const name = error instanceof Error ? error.name : "UnknownError";
        sameError = name === lastError ? sameError + 1 : 1;
        lastError = name;
        counts.stuck += 1;
        steps.push({ id: steps.length + 1, floor, action: action.kind, event: `tool-error:${name}`.slice(0, 80), ok: false, ms: Math.round(performance.now() - before), moves: 0, mode: view.mode, trace: trace(view) });
        if (sameError >= SAME_ERROR_LIMIT) { terminalError = error; break; }
        continue;
      }
      if (action.kind === "query") counts.queries += 1;
      counts.moves += result.steps;
      const current = signature(result.view);
      noProgress = current === previous && result.steps === 0 ? noProgress + 1 : 0;
      previous = current;
      if (!result.ok) {
        counts.stuck += 1;
        sameError = result.event === lastError ? sameError + 1 : 1;
        lastError = result.event;
      } else {
        sameError = 0;
        lastError = "";
      }
      steps.push({
        id: steps.length + 1,
        floor,
        action: action.kind,
        event: result.event.replace(/[^a-zA-Z0-9:_-]/gu, "-").slice(0, 80),
        ok: result.ok,
        ms: Math.round(performance.now() - before),
        moves: Math.max(0, Math.min(64, result.steps)),
        mode: view.mode.slice(0, 32),
        trace: trace(result.view),
      });
      if (noProgress >= NO_PROGRESS_LIMIT || sameError >= SAME_ERROR_LIMIT) break;
    }
    judge = await browser.judge(floor);
  } catch (error) {
    terminalError = error;
  }

  const complete = passed(judge, floor);
  const status: PlayStatus = complete ? "PASS" : statusFromFailure(terminalError, noProgress, sameError);
  const suffix = complete ? "complete" : "failed";
  try { await browser.screenshot(join(screenshotDir, `floor-${String(floor)}-${suffix}.png`)); } catch { /* 报告保留步骤，截图失败不覆盖主分类 */ }
  const floorSteps = steps.filter((step) => step.floor === floor);
  const evidence = floorSteps.slice(-5).map((step) => step.id);
  const reason = complete
    ? `课程 ${String(judge.lessons)}/${String(judge.requiredLessons)}、Boss 与${floor === 8 ? "七步 MIGRATE" : "真实升层"}均经隐藏裁判确认。`
    : `在 ${String(floorSteps.length)} 个语义动作后停止：课程 ${String(judge.lessons)}/${String(judge.requiredLessons)}，Boss=${String(judge.bossDefeated)}，无进展=${String(noProgress)}，同类错误=${String(sameError)}。`;
  return {
    floor, status, ms: Math.round(performance.now() - started), moves: counts.moves,
    battles: counts.battles, queries: counts.queries, deaths: counts.deaths,
    stuck: counts.stuck, lessons: judge.lessons, requiredLessons: judge.requiredLessons,
    bossDefeated: judge.bossDefeated, advanced: judge.advanced,
    migrationComplete: judge.migrationComplete, summary: reason, evidence,
  };
}

function overall(floors: FloorReport[]): PlayStatus {
  if (floors.length > 0 && floors.every((floor) => floor.status === "PASS")) return "PASS";
  for (const status of ["FAIL_GAME", "BLOCKED_TOOL", "LIMIT_REACHED"] as const) {
    if (floors.some((floor) => floor.status === status)) return status;
  }
  return "BLOCKED_TOOL";
}

/**
 * 自启服务并顺序尝试全部目标楼层。
 * @param options 仓库、输出目录、楼层和可选本机 URL。
 * @returns 已写盘的脱敏总报告；即使单层失败也包含后续层结果。
 * @throws 项目标识错误、浏览器无法启动或报告无法写入。
 */
export async function runPlaytest(options: PlayOptions): Promise<PlayReport> {
  await verifyProject(options.repoRoot);
  const codeHash = await hashWorktree(options.repoRoot);
  const runId = `${new Date().toISOString().replace(/[-:.]/gu, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const output = join(options.outputRoot, runId);
  const screenshots = join(output, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const startedAt = new Date().toISOString();
  const steps: PlayStep[] = [];
  const floors: FloorReport[] = [];
  const server = await startGame(options.repoRoot, options.url, options.signal);
  const browser = new GameBrowser(server.url, options.headed, output);
  try {
    await browser.open();
    for (const floor of options.floors) {
      options.signal?.throwIfAborted();
      floors.push(await runFloor(browser, floor, steps, screenshots, options.signal));
    }
  } finally {
    await browser.close().catch(() => undefined);
    await server.close();
  }
  const status = overall(floors);
  const summary = [
    `确定性试玩状态：${status}；已尝试楼层 ${floors.map((floor) => floor.floor).join(", ")}。`,
    `总移动 ${String(floors.reduce((sum, floor) => sum + floor.moves, 0))}，战斗 ${String(floors.reduce((sum, floor) => sum + floor.battles, 0))}，查询 ${String(floors.reduce((sum, floor) => sum + floor.queries, 0))}。`,
    "路径规划、答案选择和浏览器执行未调用模型，Token 为 0；详细客观证据见报告路径。",
  ].join("\n");
  return await writePlayReport({
    schemaVersion: 1, runId, status, codeHash, startedAt,
    finishedAt: new Date().toISOString(), floors, steps, summary,
  }, output);
}
