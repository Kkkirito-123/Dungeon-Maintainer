/**
 * 单浏览器语义动作、检查点和重放编排。
 *
 * GameDriver 是 Pi 游戏工具与底层 Playwright 客户端之间的唯一入口。第一次 look 或
 * /play 会先在页面 sessionStorage 建立复现起点并清空环形 Trace；后续 go/use/query
 * 只记录有限语义。源码修改后先 reload 消费检查点，再立刻重建同一起点检查点，最后
 * 按原顺序重放动作，因此后续 /verify 仍能从相同起点再次验证。
 */

import { SemanticTrace, type SemanticTraceEntry } from "../logging/trace.js";
import type {
  PlayJudge,
  PlayResult,
  PlayView,
} from "./protocol.js";
import type { GameBrowser } from "./browser.js";

/** 一次重放的公开验证结果。 */
export interface ReplayResult {
  passed: boolean;
  actionCount: number;
  finalView: PlayView;
  failure: string | null;
}

/** 当前 Pi 任务的游戏驱动。 */
export class GameDriver {
  readonly trace = new SemanticTrace(500);
  private checkpointReady = false;
  private lastView: PlayView | null = null;

  /** @param browser 已打开协议 v2 页面。 */
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

  /** 执行有限 BFS 移动并记录语义结果。 */
  async go(
    target: "objective" | "frontier",
    maxSteps: number,
  ): Promise<PlayResult> {
    await this.ensureCheckpoint();
    const result = await this.browser.go(target, maxSteps);
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
    const result = await this.browser.use(actionId);
    this.lastView = result.view;
    this.trace.push({
      action: "use",
      arguments: { actionId },
      ok: result.ok,
      summary: result.event + " · " + result.view.banner,
    });
    return result;
  }

  /** 提交桥内部答案，不接收 SQL 参数。 */
  async query(): Promise<PlayResult> {
    await this.ensureCheckpoint();
    const result = await this.browser.query();
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
    const restored = await this.browser.reloadFromCheckpoint();
    // reload 已消费一次性 sessionStorage。重放前立即重建相同起点，后续 /verify 才能
    // 再次从同一状态开始，而不是从本次重放后的症状状态开始。
    await this.browser.checkpoint();
    this.trace.clear();
    this.checkpointReady = true;
    this.lastView = restored;
    let failure: string | null = null;
    let actionCount = 0;
    for (const action of actions) {
      if (action.action === "look") continue;
      try {
        let result: PlayResult;
        if (action.action === "go") {
          const target = action.arguments.target;
          const maxSteps = action.arguments.maxSteps;
          if (
            (target !== "objective" && target !== "frontier")
            || typeof maxSteps !== "number"
          ) {
            throw new Error("复现 go 参数损坏");
          }
          result = await this.go(target, maxSteps);
        } else if (action.action === "use") {
          const actionId = action.arguments.actionId;
          if (typeof actionId !== "string") {
            throw new Error("复现 use 参数损坏");
          }
          result = await this.use(actionId);
        } else {
          result = await this.query();
        }
        actionCount += 1;
        if (!result.ok) {
          failure = result.event;
          break;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : "重放失败";
        break;
      }
    }
    const finalView = this.lastView;
    return {
      passed: failure === null,
      actionCount,
      finalView,
      failure,
    };
  }

  /** 读取隐藏裁判摘要，仅供验证层调用。 */
  async judge(floor: number): Promise<PlayJudge> {
    return await this.browser.judge(floor);
  }

  private async ensureCheckpoint(): Promise<void> {
    if (!this.checkpointReady) await this.beginReproduction();
  }
}
