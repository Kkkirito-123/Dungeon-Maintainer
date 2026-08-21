/**
 * `dungeon-maintain start` 的单任务启动流程。
 *
 * 本模块按固定顺序校验 SQL Dungeon 来源工作树、运行依赖和 baseHead，将当前内容复制为
 * detached 快照 worktree，创建 Pi 会话目录，最后交给 Pi RPC 与统一 Shell。来源树可以脏，
 * 但启动过程保持只读；若任务记录尚未成功写入，失败清理仅针对本次创建的 worktree。
 *
 * 本模块不实现模型工具、浏览器动作、补丁或 apply。Pi 退出后只有终态任务会被清理，
 * 中途退出保留 task.json、日志、会话和 worktree 供 resume 使用。
 */

import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MaintainerConfig } from "../config.js";
import { TaskStore, createTaskId } from "../task/store.js";
import { INITIAL_TASK_OBJECTIVE } from "../task/types.js";
import { inspectDungeonRepository, verifyRuntimeDependencies } from "./repository.js";
import { runPiProcess } from "./pi-process.js";
import { cleanupFinishedWorktree } from "./task-lifecycle.js";
import {
  createTaskWorktreeSnapshot,
  removeTaskWorktree,
} from "../workspace/worktree.js";

/**
 * 创建任务、来源快照 worktree 并进入统一 Chromium Shell。
 *
 * @param repoPath 用户指定的正式游戏仓库路径。
 * @param config 维护器运行配置。
 * @returns Pi 子进程退出码。
 * @throws 仓库、依赖、worktree 或任务初始化失败时抛出。
 */
export async function startMaintainer(
  repoPath: string,
  config: MaintainerConfig,
): Promise<number> {
  const state = await inspectDungeonRepository(repoPath);
  await verifyRuntimeDependencies(state.root);
  const store = new TaskStore(config.dataDir);
  const taskId = createTaskId();
  const worktreesDir = join(config.dataDir, "worktrees");
  const snapshot = await createTaskWorktreeSnapshot(
    taskId,
    state.root,
    state.head,
    worktreesDir,
  );
  const worktreeRoot = snapshot.root;
  const piSessionDir = join(store.taskDir(taskId), "pi");
  try {
    await mkdir(piSessionDir, { recursive: true });
    const task = await store.create({
      id: taskId,
      objective: INITIAL_TASK_OBJECTIVE,
      repoRoot: state.root,
      baseHead: state.head,
      sourceBranch: snapshot.sourceBranch,
      sourceDirtyFiles: snapshot.sourceDirtyFiles,
      sourceSnapshotHash: snapshot.sourceSnapshotHash,
      worktreeRoot,
      piSessionDir,
    });
    console.log("任务 ID：" + task.id);
    console.log("正式仓库在 /apply 前保持不变：" + task.repoRoot);
    console.log(
      "来源工作树：" + task.sourceBranch
      + "（未提交文件 " + String(task.sourceDirtyFiles) + "）",
    );
    console.log("隔离 worktree：" + task.worktreeRoot);
    const exitCode = await runPiProcess(task, config);
    await cleanupFinishedWorktree(store, task.id);
    return exitCode;
  } catch (error) {
    const taskFileExists = await access(join(store.taskDir(taskId), "task.json"))
      .then(() => true)
      .catch(() => false);
    if (!taskFileExists) {
      await removeTaskWorktree(state.root, worktreeRoot, worktreesDir).catch(
        () => undefined,
      );
    }
    throw error;
  }
}
