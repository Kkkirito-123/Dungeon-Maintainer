/**
 * Dungeon Maintainer 固定 Pi 用户命令的装配入口。
 *
 * 本文件只注册 `/play`、`/diff`、`/verify`、`/apply` 和 `/discard`，不实现
 * 命令业务，也不允许项目配置动态追加命令。所有命令共享同一个 TaskRecord、
 * TaskStore、浏览器驱动和资源关闭函数，避免恢复任务时出现第二套内存状态。
 * 命令注册本身不访问文件或启动浏览器；具体副作用仍由各自模块的安全边界负责。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EvidenceStore } from "../../evidence/store.js";
import type { GameDriver } from "../../game/driver.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { registerApplyCommand } from "./apply.js";
import { registerDiffCommand } from "./diff.js";
import { registerDiscardCommand } from "./discard.js";
import { registerPlayCommand } from "./play.js";
import { registerVerifyCommand } from "./verify.js";

/** 五个固定用户命令共享的单任务依赖。 */
export interface MaintainerCommandContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  currentDriver(): GameDriver | null;
  ensureGame(): Promise<GameDriver>;
  closeGame(): Promise<void>;
}

/**
 * 注册 1.0 的全部用户命令。
 *
 * @param pi 当前 Pi Extension API。
 * @param context 与 taskId、worktree 和浏览器会话固定绑定的依赖。
 */
export function registerMaintainerCommands(
  pi: ExtensionAPI,
  context: MaintainerCommandContext,
): void {
  registerPlayCommand(pi, context);
  registerDiffCommand(pi, context);
  registerVerifyCommand(pi, context);
  registerApplyCommand(pi, context);
  registerDiscardCommand(pi, context);
}
