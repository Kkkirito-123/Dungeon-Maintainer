/**
 * 任务路径绑定与终态 worktree 清理。
 *
 * 本模块只处理已持久化任务的本地路径事实：确认 Pi 会话目录和 detached worktree
 * 仍位于维护器数据目录，并在任务进入 applied/discarded 后调用 workspace 的精确清理。
 * 它不读取正式仓库 HEAD、不启动 Pi、不执行 apply；冲突判断仍由 workspace/apply.ts 负责。
 *
 * 所有删除都经过 `removeTaskWorktree` 的父目录边界检查。若清理失败，任务证据保留且
 * 错误向上抛出，避免把“未清理”伪装成完成。
 */

import { join } from "node:path";
import { appendEvent } from "../logging/events.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { comparablePath } from "./path.js";
import { pathExists } from "../workspace/git.js";
import { removeTaskWorktree } from "../workspace/worktree.js";

/**
 * 验证任务记录中的本地路径仍绑定当前维护器数据目录。
 *
 * @param task 从 task.json 读取并通过 schema v4 校验的任务。
 * @param store 当前维护器任务存储。
 * @throws 路径逃逸或 baseHead 格式非法时拒绝恢复。
 */
export function assertTaskLocalPaths(task: TaskRecord, store: TaskStore): void {
  const expectedSessionDir = join(store.taskDir(task.id), "pi");
  const expectedWorktree = join(store.dataDir, "worktrees", task.id);
  if (comparablePath(task.piSessionDir) !== comparablePath(expectedSessionDir)) {
    throw new Error("任务 piSessionDir 已脱离维护器任务目录");
  }
  if (comparablePath(task.worktreeRoot) !== comparablePath(expectedWorktree)) {
    throw new Error("任务 worktreeRoot 已脱离维护器 worktrees 目录");
  }
  if (!/^[0-9a-f]{40,64}$/iu.test(task.baseHead)) {
    throw new Error("任务 baseHead 不是有效 Git 对象 ID");
  }
}

/**
 * 仅删除 applied/discarded 任务的精确 worktree。
 *
 * @param store 当前维护器任务存储。
 * @param taskId 任务 ID。
 * @returns 终态或 worktree 已不存在时正常返回。
 * @throws 任务读取或 workspace 安全清理失败时抛出。
 */
export async function cleanupFinishedWorktree(
  store: TaskStore,
  taskId: string,
): Promise<void> {
  const latest = await store.read(taskId);
  if (latest.state !== "applied" && latest.state !== "discarded") return;
  if (!await pathExists(latest.worktreeRoot)) return;
  await removeTaskWorktree(
    latest.repoRoot,
    latest.worktreeRoot,
    join(store.dataDir, "worktrees"),
  );
  await appendEvent(store, latest.id, "worktree.removed", {
    terminalState: latest.state,
  });
}
