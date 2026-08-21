/**
 * detached worktree 创建、依赖复用和安全清理。
 *
 * 修改任务始终从来源工作树 baseHead 创建隔离 worktree；来源可以包含未提交修改，
 * 这些修改会被精确复制并暂存在任务 worktree 的 Git index 中，成为只读快照基线。
 * Agent 后续修改保持未暂存，因此 diff/apply 只包含 Agent 增量，不会把用户原改动重复写回。
 * 游戏 node_modules 是可再生忽略目录，可以通过 junction 或符号链接复用，但路径策略
 * 永久禁止 Agent 访问。清理前会确认目标正好位于配置的 worktrees 父目录。
 */

import {
  copyFile,
  lstat,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { TaskRecord } from "../task/types.js";
import {
  hashWorktree,
  pathExists,
  readRepo,
  runGit,
  runGitRaw,
} from "./git.js";
import { classifyPath, normalizeProjectPath } from "./policy.js";

async function linkGameDependencies(
  repoRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const source = resolve(repoRoot, "game", "node_modules");
  const target = resolve(worktreeRoot, "game", "node_modules");
  if (!await pathExists(source) || await pathExists(target)) return;
  await symlink(
    source,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

/**
 * 创建任务专用 detached worktree。
 *
 * @param taskId 新任务 ID。
 * @param repoRoot 目标游戏仓库根目录。
 * @param baseHead 启动时记录的提交。
 * @param worktreesDir 维护器数据目录中的 worktrees 父目录。
 * @returns 新 worktree 的绝对路径。
 */
export async function createTaskWorktree(
  taskId: string,
  repoRoot: string,
  baseHead: string,
  worktreesDir: string,
): Promise<string> {
  return (await createTaskWorktreeSnapshot(
    taskId,
    repoRoot,
    baseHead,
    worktreesDir,
  )).root;
}

/** 创建来源工作树快照后返回的低敏事实。 */
export interface TaskWorktreeSnapshot {
  root: string;
  sourceBranch: string;
  sourceDirtyFiles: number;
  sourceSnapshotHash: string;
}

async function copyUntrackedSnapshot(
  sourceRoot: string,
  targetRoot: string,
): Promise<void> {
  const raw = await runGitRaw(sourceRoot, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  for (const rawPath of raw.split("\0").filter(Boolean)) {
    const path = normalizeProjectPath(rawPath);
    if (classifyPath(path, "read") === "denied") {
      // 未跟踪文件没有 Git blob 可以作为安全替代；静默跳过会让右侧展示的并非用户
      // 当前工作树，所以必须明确阻断这一种无法可信复制的输入。
      throw new Error("脏工作树包含禁止读取的未跟踪路径，无法建立完整快照");
    }
    const source = resolve(sourceRoot, path);
    const information = await lstat(source);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error("脏工作树包含无法安全复制的未跟踪链接或特殊文件");
    }
    const target = resolve(targetRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

/**
 * 从当前来源工作树建立隔离快照。
 *
 * @param taskId 新任务 ID。
 * @param repoRoot 用户选中的本地 Git 工作树。
 * @param baseHead 启动检查时记录的 HEAD。
 * @param worktreesDir 维护器专用 worktree 父目录。
 * @returns 隔离根目录以及不含文件正文的来源分支、脏文件数和完整快照 Hash。
 * @throws HEAD 漂移、来源在复制中变化、禁止路径或特殊文件无法安全复制时回收目标并拒绝。
 */
export async function createTaskWorktreeSnapshot(
  taskId: string,
  repoRoot: string,
  baseHead: string,
  worktreesDir: string,
): Promise<TaskWorktreeSnapshot> {
  const state = await readRepo(repoRoot);
  if (state.head !== baseHead) {
    throw new Error("目标仓库 HEAD 已变化，不能创建旧基线任务");
  }
  const sourceSnapshotHash = await hashWorktree(state.root);
  const target = resolve(worktreesDir, taskId);
  if (await pathExists(target)) throw new Error("任务 worktree 已存在");
  await mkdir(dirname(target), { recursive: true });
  const temporaryPatch = resolve(worktreesDir, "." + taskId + ".source.patch");
  let created = false;
  try {
    await runGit(state.root, ["worktree", "add", "--detach", target, baseHead]);
    created = true;
    const trackedPatch = await runGitRaw(state.root, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "HEAD",
      "--",
    ]);
    if (trackedPatch) {
      await writeFile(temporaryPatch, trackedPatch, "utf8");
      await runGit(target, ["apply", "--binary", "--", temporaryPatch]);
    }
    await copyUntrackedSnapshot(state.root, target);
    // 来源未提交内容只进入任务 index 作为基线；后续普通 git diff 因而只看到
    // Agent 增量，既能渲染用户当前树，又不会在 /apply 时重复用户已有修改。
    await runGit(target, ["add", "-A", "--"]);
    if (await hashWorktree(state.root) !== sourceSnapshotHash) {
      throw new Error("来源工作树在建立快照期间发生变化，请重新 start");
    }
    await linkGameDependencies(state.root, target);
    return {
      root: target,
      sourceBranch: state.branch,
      sourceDirtyFiles: state.status
        ? state.status.split(/\r?\n/u).filter(Boolean).length
        : 0,
      sourceSnapshotHash,
    };
  } catch (error) {
    if (created) {
      await runGit(state.root, ["worktree", "remove", "--force", target])
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(temporaryPatch, { force: true }).catch(() => undefined);
  }
}

/**
 * 验证恢复任务所需的 worktree 仍然存在且属于同一 baseHead。
 *
 * @param task 持久化任务。
 * @throws 目录丢失、Git 根不匹配或 HEAD 漂移时拒绝恢复。
 */
export async function verifyTaskWorktree(task: TaskRecord): Promise<void> {
  if (!await pathExists(task.worktreeRoot)) {
    throw new Error("任务 worktree 已丢失，不能静默重建");
  }
  const state = await readRepo(task.worktreeRoot);
  if (state.root !== resolve(task.worktreeRoot)) {
    throw new Error("任务 worktree Git 根与记录不一致");
  }
  if (state.head !== task.baseHead) {
    throw new Error("任务 worktree HEAD 已偏离 baseHead");
  }
}

/**
 * 删除已结束任务的精确 worktree。
 *
 * @param repoRoot 注册该 worktree 的目标仓库。
 * @param worktreeRoot 要删除的任务 worktree。
 * @param worktreesDir 配置中的父目录，用于删除前边界校验。
 */
export async function removeTaskWorktree(
  repoRoot: string,
  worktreeRoot: string,
  worktreesDir: string,
): Promise<void> {
  const parent = resolve(worktreesDir);
  const target = resolve(worktreeRoot);
  const escaped = relative(parent, target);
  if (!escaped || escaped.startsWith("..") || escaped.includes("/") || escaped.includes("\\")) {
    throw new Error("拒绝删除非任务级 worktree 路径");
  }
  const dependencies = resolve(target, "game", "node_modules");
  try {
    if ((await lstat(dependencies)).isSymbolicLink()) {
      await rm(dependencies, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await runGit(repoRoot, ["worktree", "remove", "--force", target]);
}
