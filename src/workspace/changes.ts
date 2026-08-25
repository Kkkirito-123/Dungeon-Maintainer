/**
 * Pi 原生编辑工具与任务记录之间的变化同步。
 *
 * Pi 的 write 会直接修改 detached worktree，不经过维护器 patch 工具。本模块
 * 重新从 Git 读取真实增量，把 changedPaths 写回 task.json，并使旧补丁、审批、检查、
 * 源码证据和验证失效；随后追加一条 change 证据。它不限制 Pi 能修改哪些文件，也不把
 * 任何变化写入正式游戏仓库；正式写回仍由 `/verify` 和 `/apply` 完成。
 *
 * 失败时保留 worktree 原始内容并抛错。调用方可以再次同步或让用户检查 Diff，不会
 * 因任务摘要写入失败而回滚 Pi 已完成的本地编辑。
 */

import { appendEvent } from "../logging/events.js";
import { changeEvidence } from "../evidence/projector.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { hashWorktree, worktreeChangedPaths } from "./git.js";

/**
 * 将当前 worktree 增量同步到任务事实，并让过期验证失效。
 *
 * @param store 当前任务存储。
 * @param task 与 Pi cwd 绑定的任务对象。
 * @param source 触发同步的低敏来源名称，例如 write 或 verify。
 * @param evidence 可选 EvidenceStore；Extension/verification 传入以执行失效和 change 记账。
 * @returns 当前全部变更路径。
 * @throws 终态任务、Git 读取失败或任务持久化失败。
 */
export async function syncWorktreeChanges(
  store: TaskStore,
  task: TaskRecord,
  source: string,
  evidence?: EvidenceStore,
): Promise<string[]> {
  if (task.state === "applied" || task.state === "discarded") {
    throw new Error("终态任务不能同步新的 worktree 修改");
  }
  const [paths, worktreeHash] = await Promise.all([
    worktreeChangedPaths(task.worktreeRoot),
    hashWorktree(task.worktreeRoot),
  ]);
  const samePaths = paths.join("\n") === [...task.changedPaths].sort().join("\n");
  const latestChange = evidence ? await evidence.latest("change") : null;
  if (
    samePaths
    && (
      task.verification?.worktreeHash === worktreeHash
      || latestChange?.worktreeHash === worktreeHash
    )
  ) {
    // 原生 write 后已经同步过同一 Hash，随后手动 check 产生的 PASS 仍属于当前代码。
    // verify 再次进入时若继续 invalidatePaths，会把可复用检查误标 stale 并重跑。
    // 只有完整 worktree Hash 真正变化时，才允许下方失效旧检查和验证。
    return paths;
  }

  task.changedPaths = paths;
  task.patchLines = 0;
  task.baseHashes = {};
  task.approval = null;
  task.verification = null;
  task.patchPath = null;
  task.reversePatchPath = null;

  if (evidence) {
    await evidence.invalidatePaths(paths);
    const proposed = (await evidence.active("claim"))
      .filter((record) => record.metadata.finishStatus === "proposed")
      .at(-1);
    await evidence.capture(changeEvidence(paths, worktreeHash, proposed ? [proposed.id] : []));
  }

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
