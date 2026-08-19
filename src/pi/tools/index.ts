/**
 * Dungeon Maintainer 固定 Pi 工具面的唯一装配入口。
 *
 * 本文件只注册计划规定的 `inspect/patch/check/finish/look/go/use/query`，不做业务
 * 执行，也不允许项目配置或外部 Extension 动态追加 Shell、任意读写和浏览器脚本。
 * 调用方必须传入同一个 TaskRecord、TaskStore 与单浏览器访问器，确保任务恢复后没有
 * 第二套内存状态。任一工具注册失败会阻止 Extension 完成加载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GameDriver } from "../../game/driver.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { registerCheckTool } from "./check.js";
import { registerFinishTool } from "./finish.js";
import { registerGameTools } from "./game.js";
import { registerInspectTool } from "./inspect.js";
import { registerPatchTool } from "./patch.js";

/** 八个固定工具共享的运行依赖。 */
export interface MaintainerToolContext {
  task: TaskRecord;
  store: TaskStore;
  currentDriver(): GameDriver | null;
  requireDriver(): GameDriver;
  ensureGame(): Promise<GameDriver>;
}

/**
 * 注册 V1 的全部模型工具。
 *
 * @param pi 当前 Extension API。
 * @param context 与一个 taskId/worktree 绑定的运行依赖。
 */
export function registerMaintainerTools(
  pi: ExtensionAPI,
  context: MaintainerToolContext,
): void {
  registerInspectTool(pi, context);
  registerPatchTool(pi, context);
  registerCheckTool(pi, context);
  registerFinishTool(pi, context);
  registerGameTools(pi, context);
}
