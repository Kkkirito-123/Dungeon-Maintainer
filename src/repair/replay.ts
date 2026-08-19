/**
 * 持久化复现与浏览器重放的连接层。
 *
 * 本模块不判断业务问题是否已经修复，只验证相同高层动作在刷新后的新代码上能否
 * 完整执行，并把结果以低敏事件写入任务。期望与实际语义仍由 Agent 在 finish 中
 * 比较；隐藏 judge 不进入模型工具结果，也不作为所有问题都适用的通用通过条件。
 */

import { appendEvent } from "../logging/events.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import type { GameDriver, ReplayResult } from "../game/driver.js";
import type { ReproductionRecord } from "./reproduction.js";

/**
 * 刷新游戏并重放一个已持久化复现。
 *
 * @param store 当前任务存储。
 * @param task 当前任务。
 * @param driver 当前浏览器驱动。
 * @param reproduction 活动复现记录。
 * @returns 动作层重放结果。
 */
export async function replayReproduction(
  store: TaskStore,
  task: TaskRecord,
  driver: GameDriver,
  reproduction: ReproductionRecord,
): Promise<ReplayResult> {
  const result = await driver.reloadAndReplay(reproduction.actions);
  await appendEvent(store, task.id, "reproduction.replayed", {
    id: reproduction.id,
    passed: result.passed,
    actionCount: result.actionCount,
    failure: result.failure,
  });
  return result;
}
