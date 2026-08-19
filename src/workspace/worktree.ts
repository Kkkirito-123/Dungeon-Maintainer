/**
 * detached worktree 创建、依赖复用和安全清理。
 *
 * 修改任务始终从目标仓库 baseHead 创建隔离 worktree；目标工作区必须干净且 HEAD
 * 不得漂移。游戏 node_modules 是可再生忽略目录，可以通过 junction 或符号链接复用，
 * 但路径策略永久禁止 Agent 访问。清理前会确认目标正好位于配置的 worktrees 父目录，
 * 防止错误路径导致递归删除用户文件。
 */

import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { TaskRecord } from "../task/types.js";
import { pathExists, readRepo, runGit } from "./git.js";

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
  const state = await readRepo(repoRoot);
  if (!state.clean) throw new Error("start 要求目标游戏仓库工作区干净");
  if (state.head !== baseHead) {
    throw new Error("目标仓库 HEAD 已变化，不能创建旧基线任务");
  }
  const target = resolve(worktreesDir, taskId);
  if (await pathExists(target)) throw new Error("任务 worktree 已存在");
  await mkdir(dirname(target), { recursive: true });
  await runGit(state.root, ["worktree", "add", "--detach", target, baseHead]);
  await linkGameDependencies(state.root, target);
  return target;
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
