/**
 * Git 基线、隔离 worktree、补丁应用与回滚。
 *
 * 模型没有 Git 或 Shell 工具；只有本模块能以固定参数调用 Git。修改任务从干净目标
 * 仓库的 `baseHead` 创建 detached worktree，目标分支在显式 `apply` 前保持不变。
 * 应用和回滚都会重新验证提交、工作区及文件 Hash，冲突时宁可拒绝也不覆盖用户工作。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskRecord } from "../runtime/task.js";
import { classifyPath, normalizeProjectPath } from "./policy.js";

const exec = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function linkGameDependencies(repoRoot: string, worktreeRoot: string): Promise<void> {
  const source = resolve(repoRoot, "game", "node_modules");
  const target = resolve(worktreeRoot, "game", "node_modules");
  if (!await exists(source) || await exists(target)) return;
  // Git worktree 不复制忽略的依赖目录。这里只共享可再生的 node_modules，模型路径策略
  // 仍永久禁止访问它；源代码、存档和任务产物都不会通过该链接共享。
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

/** 将目标工作区的当前未提交快照复制进试玩 worktree，避免试玩读取旧 HEAD。 */
async function copyDirtySnapshot(repoRoot: string, worktreeRoot: string, patchDir: string): Promise<void> {
  const patch = await gitRaw(repoRoot, ["diff", "--binary", "HEAD", "--"]);
  let patchPath: string | null = null;
  try {
    if (patch) {
      patchPath = join(patchDir, "dirty.patch");
      await writeFile(patchPath, patch, "utf8");
      await git(worktreeRoot, ["apply", "--binary", patchPath]);
    }
    const untracked = (await git(repoRoot, ["ls-files", "--others", "--exclude-standard"]))
      .split(/\r?\n/u).filter(Boolean);
    for (const value of untracked) {
      const relativePath = normalizeProjectPath(value);
      if (classifyPath(relativePath, "write") === "denied") continue;
      const source = resolve(repoRoot, relativePath);
      const target = resolve(worktreeRoot, relativePath);
      const info = await lstat(source);
      if (!info.isFile()) continue;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  } finally {
    if (patchPath) await rm(patchPath, { force: true });
  }
}

/** Git 仓库的规范根目录、当前提交和脏状态。 */
export interface RepoState {
  root: string;
  head: string;
  clean: boolean;
  status: string;
}

/**
 * 读取 Git 仓库状态。
 * @param path 仓库内任意路径。
 * @returns 规范仓库根、HEAD 和 porcelain 状态。
 * @throws 当路径不是 Git 工作树时抛出 Git 错误。
 */
export async function readRepo(path: string): Promise<RepoState> {
  const root = resolve(await git(path, ["rev-parse", "--show-toplevel"]));
  const [head, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return { root, head, clean: status.length === 0, status };
}

/**
 * 创建任务专用 detached worktree。
 * @param task 已记录目标仓库和基线提交的修改任务。
 * @param worktreesDir 统一数据目录下的 worktree 父目录。
 * @returns 新 worktree 的绝对路径；若目标已有游戏依赖，会以忽略目录链接复用。
 * @throws 当目标仓库不干净、HEAD 漂移或目录已存在时拒绝。
 */
export async function createTaskWorktree(
  task: TaskRecord,
  worktreesDir: string,
  allowDirtyTarget = false,
): Promise<string> {
  const state = await readRepo(task.repoRoot);
  // 试玩只从 baseHead 创建隔离副本，不读取或覆盖目标工作区的未提交修改。
  if (!state.clean && !allowDirtyTarget) throw new Error("修改任务要求目标仓库工作区干净");
  if (state.head !== task.baseHead) throw new Error("目标仓库 HEAD 已变化，不能沿用旧任务基线");
  const target = resolve(worktreesDir, task.id);
  if (await exists(target)) throw new Error("任务 worktree 已存在");
  await mkdir(dirname(target), { recursive: true });
  await git(state.root, ["worktree", "add", "--detach", target, task.baseHead]);
  await linkGameDependencies(state.root, target);
  if (allowDirtyTarget) await copyDirtySnapshot(state.root, target, worktreesDir);
  return target;
}

/**
 * 删除已经不再使用的任务 worktree。
 * @param repoRoot 注册该 worktree 的目标仓库。
 * @param worktreeRoot 精确任务目录；调用者不得传父目录或通配符。
 */
export async function removeTaskWorktree(repoRoot: string, worktreeRoot: string): Promise<void> {
  const target = resolve(worktreeRoot);
  const dependencies = resolve(target, "game", "node_modules");
  try {
    if ((await lstat(dependencies)).isSymbolicLink()) await rm(dependencies, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await git(repoRoot, ["worktree", "remove", "--force", target]);
}

/**
 * 计算文本或文件字节的 SHA-256。
 * @param value 原始字节。
 * @returns 小写十六进制摘要。
 */
export function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 读取项目文件 Hash；缺失文件使用稳定的 `missing` 标记。
 * @param root 仓库或 worktree 根目录。
 * @param projectPath 已规范化的项目相对路径。
 */
export async function hashFile(root: string, projectPath: string): Promise<string> {
  const path = join(root, normalizeProjectPath(projectPath));
  return await exists(path) ? hashBytes(await readFile(path)) : "missing";
}

/**
 * 计算当前 worktree 的可复用检查键。
 *
 * Hash 同时覆盖 HEAD、已跟踪 Diff 及未跟踪文件内容；检查或试玩只允许在该值完全
 * 一致时命中缓存。任何代码变化都会使缓存失效，生成目录由 Git ignore 排除。
 * @param root 目标仓库或隔离 worktree 根目录。
 * @returns 小写 SHA-256，不包含文件正文。
 */
export async function hashWorktree(root: string): Promise<string> {
  const [head, diff, others] = await Promise.all([
    gitRaw(root, ["rev-parse", "HEAD"]),
    gitRaw(root, ["diff", "--binary", "--no-ext-diff", "--"]),
    gitRaw(root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  let untracked = "";
  for (const path of others.split(/\r?\n/u).filter(Boolean).sort()) {
    untracked += `${path}:${hashBytes(await readFile(join(root, path)))}\n`;
  }
  return createHash("sha256").update(head).update(diff).update(untracked).digest("hex");
}

/**
 * 生成包含已跟踪和新文本文件的正向/反向补丁。
 *
 * @param task 已建立 worktree 的任务。
 * @param taskDir 任务产物目录。
 * @returns 变更路径以及补丁位置；不会提交 worktree。
 * @throws 当没有变化或 Git 无法生成补丁时抛出错误。
 */
export async function capturePatch(
  task: TaskRecord,
  taskDir: string,
): Promise<{
  paths: string[];
  baseHashes: Record<string, string>;
  patchPath: string;
  reversePatchPath: string;
}> {
  if (!task.worktreeRoot) throw new Error("任务尚未创建 worktree");
  const targetState = await readRepo(task.repoRoot);
  if (!targetState.clean) throw new Error("目标仓库存在未提交修改，不能生成可应用补丁");
  if (targetState.head !== task.baseHead) throw new Error("目标仓库 HEAD 已变化，不能生成旧基线补丁");
  const untracked = (await git(task.worktreeRoot, ["ls-files", "--others", "--exclude-standard"]))
    .split(/\r?\n/).filter(Boolean);
  for (const path of untracked) await git(task.worktreeRoot, ["add", "--intent-to-add", "--", path]);
  const names = (await git(task.worktreeRoot, ["diff", "--name-only", "--"])).split(/\r?\n/).filter(Boolean);
  if (names.length === 0) throw new Error("任务没有可应用的代码变化");
  const patch = await gitRaw(task.worktreeRoot, ["diff", "--binary", "--no-ext-diff", "--"]);
  await mkdir(taskDir, { recursive: true });
  const patchPath = join(taskDir, "patch.diff");
  const reversePatchPath = join(taskDir, "reverse.diff");
  await Promise.all([
    writeFile(patchPath, patch, "utf8"),
    // 反向文件保留同一份已验证补丁；回滚时由 Git 的 --reverse 解释方向，避免两份 diff 漂移。
    writeFile(reversePatchPath, patch, "utf8"),
  ]);
  const paths = names.map(normalizeProjectPath);
  const baseHashes = Object.fromEntries(await Promise.all(paths.map(async (path) => {
    let expectedBlob: string | null = null;
    try { expectedBlob = await git(task.repoRoot, ["rev-parse", `${task.baseHead}:${path}`]); }
    catch { expectedBlob = null; }
    const present = await exists(join(task.repoRoot, path));
    if (expectedBlob === null) {
      if (present) throw new Error(`目标文件已偏离任务基线：${path}`);
      return [path, "missing"] as const;
    }
    if (!present) throw new Error(`目标文件已偏离任务基线：${path}`);
    const targetBlob = await git(task.repoRoot, ["hash-object", `--path=${path}`, "--", path]);
    if (targetBlob !== expectedBlob) throw new Error(`目标文件已偏离任务基线：${path}`);
    // Git blob 会统一文本换行，不能用它保护 Windows 工作区字节。先用 blob
    // 证明语义仍属于 baseHead，再保存目标文件真实 Hash 供 apply 并发检查。
    return [path, await hashFile(task.repoRoot, path)] as const;
  })));
  return { paths, baseHashes, patchPath, reversePatchPath };
}

/**
 * 将已验证补丁应用到目标分支但不提交。
 *
 * @param task 状态为 `ready_to_apply` 且包含补丁的任务。
 * @returns 应用后每个变更文件的 Hash，供安全回滚验证。
 * @throws 当目标 HEAD、工作区或基线文件 Hash 变化时拒绝。
 */
export async function applyTaskPatch(task: TaskRecord): Promise<Record<string, string>> {
  if (task.state !== "ready_to_apply" || !task.patchPath || !task.worktreeRoot) {
    throw new Error("任务尚未准备好应用");
  }
  const state = await readRepo(task.repoRoot);
  if (!state.clean) throw new Error("目标仓库存在未提交修改，拒绝应用补丁");
  if (state.head !== task.baseHead) throw new Error("目标仓库 HEAD 与任务基线不一致");
  for (const path of task.changedPaths) {
    const targetHash = await hashFile(task.repoRoot, path);
    const baseHash = task.baseHashes[path];
    if (baseHash === undefined || targetHash !== baseHash) {
      throw new Error(`目标文件已偏离任务基线：${path}`);
    }
  }
  await git(task.repoRoot, ["apply", "--check", "--", task.patchPath]);
  await git(task.repoRoot, ["apply", "--", task.patchPath]);
  return Object.fromEntries(await Promise.all(
    task.changedPaths.map(async (path) => [path, await hashFile(task.repoRoot, path)] as const),
  ));
}

/**
 * 安全撤销一个已应用但未被继续编辑的任务补丁。
 * @param task 包含反向补丁和应用后文件 Hash 的任务。
 * @throws 当任一变更文件被用户继续修改时拒绝自动回滚。
 */
export async function revertTaskPatch(task: TaskRecord): Promise<void> {
  if (task.state !== "applied" || !task.reversePatchPath) throw new Error("任务当前不能回滚");
  for (const path of task.changedPaths) {
    if (await hashFile(task.repoRoot, path) !== task.appliedHashes[path]) {
      throw new Error(`文件在应用后已被继续修改，拒绝自动回滚：${path}`);
    }
  }
  await git(task.repoRoot, ["apply", "--reverse", "--check", "--", task.reversePatchPath]);
  await git(task.repoRoot, ["apply", "--reverse", "--", task.reversePatchPath]);
}

/**
 * 仅供测试清理尚未注册为 Git worktree 的临时目录。
 * @param path 测试创建的精确目录。
 */
export async function removeTestDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
