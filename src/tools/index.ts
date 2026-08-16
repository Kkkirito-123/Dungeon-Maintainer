/**
 * 维护器固定工具面的唯一导出。
 *
 * Runtime 只能从这里获得四个通用维护工具，不能按项目配置动态加载代码。`play` 在 SQL
 * Dungeon 适配器中单独装配游戏工具与维护工具；所有工具强制顺序执行，避免同一批
 * 修改、检查和完成声明发生竞态。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { checkTool } from "./check.js";
import type { ToolContext } from "./context.js";
import { finishTool } from "./finish.js";
import { inspectTool } from "./inspect.js";
import { patchTool } from "./patch.js";

/**
 * 创建绑定单个任务的完整工具集合。
 * @param context 任务、store 和隔离 worktree 引用。
 * @returns 固定顺序 `inspect/patch/check/finish`，不得追加 Shell 工具。
 */
export function createTools(context: ToolContext): AgentTool[] {
  return [inspectTool(context), patchTool(context), checkTool(context), finishTool(context)];
}
