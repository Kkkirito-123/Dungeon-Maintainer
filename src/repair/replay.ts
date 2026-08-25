/**
 * 持久化复现与浏览器重放的连接层。
 *
 * 本模块先验证相同高层动作能完整执行，再校验复现记录中显式声明的
 * 玩家可见断言和 hidden judge 断言。它只把通用失败码写入任务事件，
 * 不返回或记录 judge 字段、实际值和完整摘要。
 */

import { appendEvent } from "../logging/events.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import type { GameDriver, ReplayResult } from "../game/driver.js";
import type { PlayView } from "../game/protocol.js";
import type { ReproductionRecord } from "./reproduction.js";

const successfulReplayCache = new Map<string, ReplayResult>();

function replayCacheKey(
  task: TaskRecord,
  reproduction: ReproductionRecord,
  worktreeHash: string,
): string {
  return [task.id, reproduction.id, worktreeHash].join("\0");
}

/** 返回完全绑定当前任务、复现和 worktree Hash 的成功重放；失败结果永不复用。 */
export function cachedSuccessfulReplay(
  task: TaskRecord,
  reproduction: ReproductionRecord,
  worktreeHash: string,
): ReplayResult | null {
  return successfulReplayCache.get(replayCacheKey(task, reproduction, worktreeHash)) ?? null;
}

function visibleAssertionFailure(
  view: PlayView,
  reproduction: ReproductionRecord,
  replay: ReplayResult,
): string | null {
  const assertions = reproduction.assertions;
  if (assertions.floor !== undefined && view.floor !== assertions.floor) {
    return "player-assertion-failed:floor";
  }
  if (assertions.mode !== undefined && view.mode !== assertions.mode) {
    return "player-assertion-failed:mode";
  }
  if (
    assertions.minLessons !== undefined
    && assertions.advancedFromFloor === undefined
    && view.progress.lessons < assertions.minLessons
  ) {
    return "player-assertion-failed:minLessons";
  }
  if (
    assertions.queryAccepted !== undefined
    && replay.queryAccepted !== assertions.queryAccepted
  ) {
    return "player-assertion-failed:queryAccepted";
  }
  if (
    assertions.queryAcceptedSequence !== undefined
    && JSON.stringify(replay.queryAcceptedSequence) !== JSON.stringify(assertions.queryAcceptedSequence)
  ) {
    return "player-assertion-failed:queryAcceptedSequence";
  }
  if (
    assertions.queryPlanSequence !== undefined
    && JSON.stringify(replay.queryPlanSequence) !== JSON.stringify(assertions.queryPlanSequence)
  ) {
    return "player-assertion-failed:queryPlanSequence";
  }
  if (
    assertions.terminalOpen !== undefined
    && (view.terminal !== null) !== assertions.terminalOpen
  ) {
    return "player-assertion-failed:terminalOpen";
  }
  return null;
}

async function reproductionAssertionFailure(
  driver: GameDriver,
  reproduction: ReproductionRecord,
  view: PlayView,
  replay: ReplayResult,
): Promise<string | null> {
  const visibleFailure = visibleAssertionFailure(view, reproduction, replay);
  if (visibleFailure) return visibleFailure;
  const assertions = reproduction.assertions;
  if (
    assertions.minStageIndex !== undefined
    && (replay.maxObservedStageIndex ?? -1) < assertions.minStageIndex
  ) return "reproduction-assertion-failed:minStageIndex";
  if (
    assertions.advancedFromFloor === undefined
    && assertions.bossDefeated === undefined
  ) return null;
  const judgeFloor = assertions.advancedFromFloor ?? assertions.floor ?? view.floor;
  try {
    const judge = await driver.judge(judgeFloor);
    if (
      assertions.advancedFromFloor !== undefined
      && !judge.advanced
    ) return "reproduction-assertion-failed";
    if (
      assertions.advancedFromFloor !== undefined
      && assertions.minLessons !== undefined
      && judge.lessons < assertions.minLessons
    ) return "reproduction-assertion-failed";
    if (
      assertions.bossDefeated !== undefined
      && judge.bossDefeated !== assertions.bossDefeated
    ) return "reproduction-assertion-failed";
  } catch {
    return "reproduction-assertion-unavailable";
  }
  return null;
}

/**
 * 刷新游戏并重放一个已持久化复现。
 *
 * @param store 当前任务存储。
 * @param task 当前任务。
 * @param driver 当前浏览器驱动。
 * @param reproduction 活动复现记录。
 * @returns 动作和显式断言共同决定的重放结果。
 */
export async function replayReproduction(
  store: TaskStore,
  task: TaskRecord,
  driver: GameDriver,
  reproduction: ReproductionRecord,
  cacheWorktreeHash?: string,
): Promise<ReplayResult> {
  let result = await driver.reloadAndReplay(reproduction.actions);
  if (result.passed) {
    const failure = await reproductionAssertionFailure(
      driver,
      reproduction,
      result.finalView,
      result,
    );
    if (failure) result = { ...result, passed: false, failure };
  }
  await appendEvent(store, task.id, "reproduction.replayed", {
    id: reproduction.id,
    passed: result.passed,
    actionCount: result.actionCount,
    failure: result.failure,
  });
  if (result.passed && cacheWorktreeHash) {
    successfulReplayCache.set(
      replayCacheKey(task, reproduction, cacheWorktreeHash),
      result,
    );
  }
  return result;
}
