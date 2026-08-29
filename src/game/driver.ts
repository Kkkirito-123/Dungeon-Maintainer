/**
 * 单浏览器语义动作、检查点和重放编排。
 *
 * GameDriver 是 Pi 游戏工具与底层 Playwright 客户端之间的唯一入口。第一次 look 或
 * /play 会先在页面 sessionStorage 建立复现起点并清空环形 Trace；模型通过 look/act/query
 * 操作游戏，驱动仍用 go/use/input-sql/query 记录有限重放语义。源码修改后先 reload
 * 消费检查点，再立刻重建同一起点检查点，最后
 * 按原顺序重放动作，因此后续 /verify 仍能从相同起点再次验证。
 */

import { SemanticTrace, type SemanticTraceEntry } from "../logging/trace.js";
import type {
  PlayJudge,
  PlayResult,
  PlayView,
} from "./protocol.js";
import type { GameBrowser } from "./browser.js";

const TRANSITION_POLL_INTERVAL_MS = 50;
const TRANSITION_POLL_ATTEMPTS = 40;

/** 一次重放的公开验证结果。 */
export interface ReplayResult {
  passed: boolean;
  actionCount: number;
  finalView: PlayView;
  failure: string | null;
  queryAccepted: boolean | null;
  queryAcceptedSequence: boolean[];
  queryPlanSequence: Array<"scan" | "search" | "none">;
  /** 整个重放窗口中玩家可见终端曾达到的最大 stageIndex；终端从未出现时为 null。 */
  maxObservedStageIndex: number | null;
}

function visibleStageIndex(view: PlayView): number | null {
  const stageIndex = view.terminal?.stageIndex;
  return typeof stageIndex === "number" && Number.isInteger(stageIndex) && stageIndex >= 0
    ? stageIndex
    : null;
}

function visibleQueryPlan(view: PlayView): "scan" | "search" | "none" {
  const plan = view.terminal?.plan.join("\n").toUpperCase() ?? "";
  if (plan.includes("SEARCH")) return "search";
  if (plan.includes("SCAN")) return "scan";
  return "none";
}

/** 当前 Pi 任务的游戏驱动。 */
export class GameDriver {
  readonly trace = new SemanticTrace(500);
  private checkpointReady = false;
  private lastView: PlayView | null = null;
  /** SQL 只在当前进程内按 Trace 序号保留，永不写入复现文件或事件日志。 */
  private readonly replayInputSql = new Map<number, string>();
  private pendingSql: string | null = null;

  /** @param browser 已打开协议 1.0 页面。 */
  constructor(private readonly browser: GameBrowser) {}

  /**
   * 显式开始新的复现窗口。
   *
   * @returns 检查点处玩家投影。
   */
  async beginReproduction(): Promise<PlayView> {
    const view = await this.browser.look();
    await this.browser.checkpoint();
    this.trace.clear();
    this.replayInputSql.clear();
    this.pendingSql = null;
    this.checkpointReady = true;
    this.lastView = view;
    return view;
  }

  /** 只把 headed 游戏窗口带到前台，不改变当前复现检查点。 */
  async focus(): Promise<void> {
    await this.browser.focus();
  }

  /** 将游戏窗口带到前台并重新建立复现起点。 */
  async focusAndRestart(): Promise<PlayView> {
    await this.focus();
    return await this.beginReproduction();
  }

  /**
   * 确认源码写入前已经存在复现起点。
   *
   * 已有检查点时保持原样，不能在症状状态重新覆盖起点；没有检查点时才以当前页面
   * 建立一个新的起点。该方法不追加语义动作。
   */
  async ensureReproductionCheckpoint(): Promise<void> {
    await this.ensureCheckpoint();
  }

  /**
   * 读取当前玩家投影，但不建立检查点也不写入复现 Trace。
   *
   * 该入口只供每轮 Agent 开始前注入一份小型实时状态，避免为了回答当前位置而额外
   * 消耗一次模型工具往返；真正的复现仍必须通过 `look/act/query` 留下语义证据。
   */
  async peek(): Promise<PlayView> {
    const view = await this.browser.look();
    this.lastView = view;
    return view;
  }

  /** 读取玩家投影并记录 look。 */
  async look(): Promise<PlayView> {
    await this.ensureCheckpoint();
    const view = await this.browser.look();
    this.lastView = view;
    this.trace.push({
      action: "look",
      arguments: {},
      ok: true,
      summary: view.banner || view.mission.title,
    });
    return view;
  }

  /** 消费模型最近一次 look 返回的修订和动作。 */
  async act(revision: string, actionId: string, maxSteps: number): Promise<PlayResult> {
    await this.ensureCheckpoint();
    const result = await this.browser.act(revision, actionId, maxSteps);
    this.lastView = result.view;
    const movement = actionId === "objective" || actionId === "frontier";
    this.trace.push({
      action: movement ? "go" : "use",
      arguments: movement
        ? { target: actionId, maxSteps }
        : { actionId },
      ok: result.ok,
      summary: result.event + " · " + result.view.banner,
    });
    return result;
  }

  /** 执行有限 BFS 移动并记录语义结果。 */
  async go(
    target: "objective" | "frontier",
    maxSteps: number,
  ): Promise<PlayResult> {
    await this.ensureCheckpoint();
    const view = this.lastView ?? await this.browser.look();
    const result = await this.browser.act(view.revision, target, maxSteps);
    this.lastView = result.view;
    this.trace.push({
      action: "go",
      arguments: { target, maxSteps },
      ok: result.ok,
      summary: result.event + " · " + result.view.banner,
    });
    return result;
  }

  /** 执行玩家视图提供的稳定动作。 */
  async use(actionId: string): Promise<PlayResult> {
    await this.ensureCheckpoint();
    const view = this.lastView ?? await this.browser.look();
    const result = await this.browser.act(view.revision, actionId, 1);
    this.lastView = result.view;
    this.trace.push({
      action: "use",
      arguments: { actionId },
      ok: result.ok,
      summary: result.event + " · " + result.view.banner,
    });
    return result;
  }

  /**
   * 向当前已打开的固定 textarea 写入 SQL。
   *
   * SQL 正文只留在当前 GameDriver 进程，供同一进程内刷新重放；Trace 仅保存长度，
   * 因此任务重启后没有输入正文时，重放会明确返回 replay-input-unavailable。
   */
  async inputSql(sql: string): Promise<PlayResult> {
    if (typeof sql !== "string" || sql.length > 16 * 1024 || sql.includes("\u0000")) {
      throw new Error("SQL 输入无效或超过 16 KiB");
    }
    await this.ensureCheckpoint();
    const view = this.lastView ?? await this.browser.look();
    const terminalOpen = (view.mode === "combat" || view.mode === "challenge")
      && view.terminal !== null;
    const result: PlayResult = {
      ok: terminalOpen,
      event: terminalOpen ? "input-buffered" : "terminal-not-open",
      steps: 0,
      view,
    };
    this.pendingSql = sql;
    const entry = this.trace.push({
      action: "input-sql",
      arguments: { inputLength: sql.length },
      ok: result.ok,
      summary: result.event + " · length=" + String(sql.length),
    });
    this.replayInputSql.set(entry.sequence, sql);
    return result;
  }

  /** 把进程内 SQL 写入当前 textarea 并提交真实查询。 */
  async query(sql?: string, revision?: string): Promise<PlayResult> {
    if (sql !== undefined) {
      const input = await this.inputSql(sql);
      if (!input.ok) return input;
    }
    await this.ensureCheckpoint();
    if (this.pendingSql === null) throw new Error("当前没有可提交的 SQL 输入");
    const view = this.lastView ?? await this.browser.look();
    const result = await this.browser.query(revision ?? view.revision, this.pendingSql);
    this.pendingSql = null;
    this.lastView = result.view;
    this.trace.push({
      action: "query",
      arguments: {},
      ok: result.ok,
      summary: result.event + " · " + result.view.banner,
    });
    return result;
  }

  /**
   * 刷新最新 worktree 代码并重放既有语义动作。
   *
   * @param actions 已持久化复现动作。
   * @returns 是否所有动作均可再次执行及最终玩家视图。
   */
  async reloadAndReplay(
    actions: readonly SemanticTraceEntry[],
  ): Promise<ReplayResult> {
    if (!this.checkpointReady) {
      throw new Error("当前没有可用于源码刷新的复现检查点");
    }
    const currentView = this.lastView;
    if (!currentView) throw new Error("当前复现检查点缺少玩家投影");
    for (const action of actions) {
      if (action.action !== "input-sql") continue;
      const inputLength = action.arguments.inputLength;
      const sql = this.replayInputSql.get(action.sequence);
      if (
        typeof inputLength !== "number"
        || typeof sql !== "string"
        || sql.length !== inputLength
      ) {
        return {
          passed: false,
          actionCount: 0,
          finalView: currentView,
          failure: "replay-input-unavailable",
          queryAccepted: null,
          queryAcceptedSequence: [],
          queryPlanSequence: [],
          maxObservedStageIndex: visibleStageIndex(currentView),
        };
      }
    }
    const restored = await this.browser.reloadFromCheckpoint();
    // reload 已消费一次性 sessionStorage。重放前立即重建相同起点，后续 /verify 才能
    // 再次从同一状态开始，而不是从本次重放后的症状状态开始。
    await this.browser.checkpoint();
    this.trace.clear();
    this.checkpointReady = true;
    this.lastView = restored;
    this.pendingSql = null;
    let failure: string | null = null;
    let actionCount = 0;
    let queryAccepted: boolean | null = null;
    const queryAcceptedSequence: boolean[] = [];
    const queryPlanSequence: Array<"scan" | "search" | "none"> = [];
    let maxObservedStageIndex = visibleStageIndex(restored);
    const observeStageIndex = (view: PlayView): void => {
      const stageIndex = visibleStageIndex(view);
      if (stageIndex === null) return;
      maxObservedStageIndex = maxObservedStageIndex === null
        ? stageIndex
        : Math.max(maxObservedStageIndex, stageIndex);
    };
    for (const action of actions) {
      if (action.action === "look") continue;
      try {
        // 正常控制循环在每个语义动作前都会重读玩家投影。重放也必须
        // 保留这个固定同步点，否则 DOM 展示与 Session 状态的短暂时序会让
        // 后续 query/use 在旧投影上紧接执行。
        this.lastView = await this.browser.look();
        observeStageIndex(this.lastView);
        let result: PlayResult;
        if (action.action === "input-sql") {
          const inputLength = action.arguments.inputLength;
          const sql = this.replayInputSql.get(action.sequence);
          if (
            typeof inputLength !== "number"
            || typeof sql !== "string"
            || sql.length !== inputLength
          ) {
            failure = "replay-input-unavailable";
            break;
          }
          if (!await this.waitForQueryMode()) {
            failure = "replay-query-not-ready";
            break;
          }
          result = await this.inputSql(sql);
        } else if (action.action === "go") {
          const target = action.arguments.target;
          const maxSteps = action.arguments.maxSteps;
          if (
            (target !== "objective" && target !== "frontier")
            || typeof maxSteps !== "number"
          ) {
            throw new Error("复现 go 参数损坏");
          }
          if (!await this.waitForExploreMode()) {
            failure = "replay-movement-not-ready";
            break;
          }
          result = await this.go(target, maxSteps);
        } else if (action.action === "use") {
          const actionId = action.arguments.actionId;
          if (typeof actionId !== "string") {
            throw new Error("复现 use 参数损坏");
          }
          if (!await this.waitForUseAction(actionId)) {
            failure = "replay-use-not-ready";
            break;
          }
          result = await this.use(actionId);
        } else {
          if (!await this.waitForQueryMode()) {
            failure = "replay-query-not-ready";
            break;
          }
          result = await this.query();
          queryAccepted = result.ok;
          queryAcceptedSequence.push(result.ok);
          queryPlanSequence.push(visibleQueryPlan(result.view));
        }
        observeStageIndex(result.view);
        actionCount += 1;
        // 原复现中已失败的探测动作可以继续重放，最终是否修复由
        // 结构化断言判定。但原本成功的链路动作若变为失败，属于回归必须立即阻断。
        if (!result.ok && action.ok) {
          failure = result.event;
          break;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : "重放失败";
        break;
      }
    }
    if (failure === null) await this.settleAutomaticTransition();
    const finalView = this.lastView;
    observeStageIndex(finalView);
    return {
      passed: failure === null,
      actionCount,
      finalView,
      failure,
      queryAccepted,
      queryAcceptedSequence,
      queryPlanSequence,
      maxObservedStageIndex,
    };
  }

  /** 读取隐藏裁判摘要，仅供验证层调用。 */
  async judge(floor: number): Promise<PlayJudge> {
    return await this.browser.judge(floor);
  }

  /** 读取当前玩家投影与检查器分离的实时视图。 */
  async currentView(): Promise<PlayView> {
    return await this.peek();
  }

  private async settleAutomaticTransition(): Promise<void> {
    const transition = this.lastView;
    if (!transition || transition.mode !== "transition") return;
    for (let attempt = 0; attempt < TRANSITION_POLL_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TRANSITION_POLL_INTERVAL_MS);
      });
      const view = await this.browser.look();
      this.lastView = view;
      if (view.mode !== "transition" || view.floor !== transition.floor) return;
    }
  }

  private async waitForExploreMode(): Promise<boolean> {
    if (this.lastView?.mode === "explore") return true;
    for (let attempt = 0; attempt < TRANSITION_POLL_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TRANSITION_POLL_INTERVAL_MS);
      });
      const view = await this.browser.look();
      this.lastView = view;
      if (view.mode === "explore") return true;
    }
    return false;
  }

  private async waitForQueryMode(): Promise<boolean> {
    if (this.lastView?.mode === "combat" || this.lastView?.mode === "challenge") {
      return true;
    }
    for (let attempt = 0; attempt < TRANSITION_POLL_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TRANSITION_POLL_INTERVAL_MS);
      });
      const view = await this.browser.look();
      this.lastView = view;
      if (view.mode === "combat" || view.mode === "challenge") return true;
    }
    return false;
  }

  private async waitForUseAction(actionId: string): Promise<boolean> {
    if (this.lastView?.actions.some((action) => action.id === actionId)) return true;
    for (let attempt = 0; attempt < TRANSITION_POLL_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TRANSITION_POLL_INTERVAL_MS);
      });
      const view = await this.browser.look();
      this.lastView = view;
      if (view.actions.some((action) => action.id === actionId)) return true;
    }
    return false;
  }

  private async ensureCheckpoint(): Promise<void> {
    if (!this.checkpointReady) await this.beginReproduction();
  }
}
