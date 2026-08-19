/**
 * `dungeon-maintain resume` 的安全恢复流程。
 *
 * 本模块只恢复原 schema v2 任务：验证状态、任务路径、正式仓库根和 baseHead、运行依赖、
 * detached worktree 及唯一 Pi session 文件后，使用原 taskId/cwd/session-dir 重新启动 Pi。
 * 它绝不从正式仓库静默重建丢失的 worktree 或新建会话。
 *
 * 正式仓库仍需在 `/apply` 前保持干净；Pi 退出后的终态清理由 task-lifecycle 负责。
 */

import type { MaintainerConfig } from "../config.js";
import { requireApiKey } from "../config.js";
import { TaskStore } from "../task/store.js";
import { inspectDungeonRepository, verifyRuntimeDependencies } from "./repository.js";
import { runPiProcess, verifyPiSession } from "./pi-process.js";
import { assertTaskLocalPaths, cleanupFinishedWorktree } from "./task-lifecycle.js";
import { verifyTaskWorktree } from "../workspace/worktree.js";
import { comparablePath } from "./path.js";

/**
 * 恢复同一个任务、Pi 会话与 detached worktree。
 *
 * @param taskId 已存在的 schema v2 任务 ID。
 * @param config 维护器运行配置。
 * @returns Pi 子进程退出码。
 * @throws 任务、仓库、worktree、会话或依赖任一事实漂移时安全阻断。
 */
export async function resumeMaintainer(
  taskId: string,
  config: MaintainerConfig,
): Promise<number> {
  requireApiKey(config);
  const store = new TaskStore(config.dataDir);
  const task = await store.read(taskId);
  if (task.state === "applied" || task.state === "discarded") {
    throw new Error("终态任务不能 resume");
  }
  assertTaskLocalPaths(task, store);
  const state = await inspectDungeonRepository(task.repoRoot);
  if (
    comparablePath(state.root) !== comparablePath(task.repoRoot)
    || state.head !== task.baseHead
  ) {
    throw new Error("正式仓库根目录或 HEAD 已偏离任务 baseHead");
  }
  await verifyRuntimeDependencies(state.root);
  await verifyTaskWorktree(task);
  await verifyPiSession(task);
  console.log("恢复任务：" + task.id);
  console.log("继续使用原 Pi 会话与 worktree；正式仓库仍需显式 /apply");
  const exitCode = await runPiProcess(task, config);
  await cleanupFinishedWorktree(store, task.id);
  return exitCode;
}
