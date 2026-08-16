/**
 * SQL Dungeon 到通用 Harness Runner 的薄装配入口。
 *
 * 本模块只把 CLI 的楼层参数映射为静态场景，并传入 SQL Dungeon 适配器。模型循环、
 * 缓存、报告、实时事件、代码工具和隐藏验证均由各自模块拥有。它不再实现第二套状态
 * 机或报告逻辑，也不能改变桥的权限边界。
 */

import type { RuntimeConfig } from "../../runtime/config.js";
import type { RuntimeModel } from "../../runtime/model.js";
import type { TaskRecord, TaskStore } from "../../runtime/task.js";
import type { HarnessEventSink } from "../../harness/contract.js";
import { runHarness, type HarnessRunResult } from "../../harness/runner.js";
import { floorScenarioId, sqlDungeonAdapter } from "./adapter.js";

/** CLI 保留的 SQL Dungeon 参数面。 */
export interface AgentPlayOptions {
  task: TaskRecord;
  store: TaskStore;
  config: RuntimeConfig;
  floors: number[];
  headed: boolean;
  url?: string;
  fresh?: boolean;
  signal?: AbortSignal;
  onEvent?: HarnessEventSink;
  model?: RuntimeModel;
}

/** 通用报告加一次性核心审批 token。 */
export type AgentPlayResult = HarnessRunResult;

/**
 * 用 Pi Agent 诊断指定楼层。
 * @param options 任务、楼层、浏览器和模型；密钥只由 Runtime 闭包读取。
 * @returns 通用 Harness 报告；目标分支在显式 apply 前不会变化。
 */
export async function runAgentPlaytest(options: AgentPlayOptions): Promise<AgentPlayResult> {
  return await runHarness({
    task: options.task,
    store: options.store,
    config: options.config,
    adapter: sqlDungeonAdapter,
    scenarioIds: options.floors.map(floorScenarioId),
    headed: options.headed,
    ...(options.url ? { url: options.url } : {}),
    ...(options.fresh ? { fresh: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
}
