/**
 * Pi 原生编辑工具与任务记录之间的变化同步。
 *
 * Pi 的 edit/write/bash 会直接修改 detached worktree，不经过维护器 patch 工具。本模块
 * 重新从 Git 读取真实增量，把 changedPaths 写回 task.json，并使旧补丁、审批和验证
 * 失效。它不限制 Pi 能修改哪些文件，也不把任何变化写入正式游戏仓库；正式写回仍由
 * `/verify` 封装补丁、`/apply` 检查来源快照后完成。
 *
 * 失败时保留 worktree 原始内容并抛错。调用方可以再次同步或让用户检查 Diff，不会
 * 因任务摘要写入失败而回滚 Pi 已完成的本地编辑。
 */

import { appendEvent } from "../logging/events.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { hashWorktree, worktreeChangedPaths } from "./git.js";

/**
 * 将当前 worktree 增量同步到任务事实，并让过期验证失效。
 *
 * @param store 当前任务存储。
 * @param task 与 Pi cwd 绑定的任务对象。
 * @param source 触发同步的低敏来源名称，例如 edit、write、bash 或 verify。
 * @returns 当前全部变更路径。
 * @throws 终态任务、Git 读取失败或任务持久化失败。
 */
export async function syncWorktreeChanges(
  store: TaskStore,
  task: TaskRecord,
  source: string,
): Promise<string[]> {
  if (task.state === "applied" || task.state === "discarded") {
    throw new Error("终态任务不能同步新的 worktree 修改");
  }
  const [paths, worktreeHash] = await Promise.all([
    worktreeChangedPaths(task.worktreeRoot),
    hashWorktree(task.worktreeRoot),
  ]);
  const samePaths = paths.join("\n") === [...task.changedPaths].sort().join("\n");
  if (samePaths && task.verification?.worktreeHash === worktreeHash) {
    return paths;
  }

  task.changedPaths = paths;
  task.patchLines = 0;
  task.baseHashes = {};
  task.approval = null;
  task.verification = null;
  task.patchPath = null;
  task.reversePatchPath = null;

  if (
    task.state === "awaiting_approval"
    || task.state === "verifying"
    || task.state === "ready_to_apply"
    || task.state === "blocked"
  ) {
    await store.transition(task, "active");
  } else {
    await store.save(task);
  }
  await appendEvent(store, task.id, "worktree.native_change", {
    source,
    pathCount: paths.length,
    worktreeHash: worktreeHash.slice(0, 12),
  });
  return paths;
}
