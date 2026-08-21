/**
 * 固定参数 Git 访问与内容 Hash。
 *
 * Agent 从不获得 Shell 或 Git 参数，本模块是维护器调用 Git 的最底层边界。所有命令
 * 使用 execFile 和静态参数数组，不经过 shell。它只读取仓库事实、生成 diff 和计算
 * Hash，不决定任务状态、审批或是否可以 apply。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { normalizeProjectPath } from "./policy.js";

const exec = promisify(execFile);

/**
 * 执行固定 Git 命令并保留原始换行。
 *
 * @param cwd Git 工作树中的目录。
 * @param args 由维护器代码构造的参数数组，不能来自模型自由文本。
 * @returns stdout 原文。
 */
export async function runGitRaw(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

/**
 * 执行固定 Git 命令并裁掉首尾空白。
 *
 * @param cwd Git 工作树中的目录。
 * @param args 固定参数数组。
 * @returns 规范化 stdout。
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return (await runGitRaw(cwd, args)).trim();
}

/** Git 仓库根、当前提交和工作区状态。 */
export interface RepoState {
  root: string;
  head: string;
  branch: string;
  clean: boolean;
  status: string;
}

/**
 * 读取 Git 仓库状态。
 *
 * @param path 仓库内任意路径。
 * @returns 规范根目录、HEAD 和 porcelain 状态。
 */
export async function readRepo(path: string): Promise<RepoState> {
  const root = resolve(await runGit(path, ["rev-parse", "--show-toplevel"]));
  const [head, branch, status] = await Promise.all([
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, ["branch", "--show-current"]),
    runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return {
    root,
    head,
    branch: branch || "(detached)",
    clean: status.length === 0,
    status,
  };
}

/** 判断精确路径是否存在。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 计算原始字节的 SHA-256。
 *
 * @param value 原始文件字节。
 * @returns 小写十六进制摘要。
 */
export function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 读取项目文件 Hash；缺失文件返回 missing。
 *
 * @param root 仓库或 worktree 根目录。
 * @param projectPath 规范项目相对路径。
 */
export async function hashFile(
  root: string,
  projectPath: string,
): Promise<string> {
  const path = join(root, normalizeProjectPath(projectPath));
  return await pathExists(path)
    ? hashBytes(await readFile(path))
    : "missing";
}

/**
 * 计算完整 worktree Hash。
 *
 * Hash 覆盖 HEAD、已跟踪 diff 及所有未跟踪文件字节。它不读取忽略目录，因此共享的
 * node_modules 不参与验证。代码任意变化都会使检查和 VerificationRecord 失效。
 */
export async function hashWorktree(root: string): Promise<string> {
  const [head, staged, diff, others] = await Promise.all([
    runGitRaw(root, ["rev-parse", "HEAD"]),
    runGitRaw(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--"]),
    runGitRaw(root, ["diff", "--binary", "--no-ext-diff", "--"]),
    runGitRaw(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  let untracked = "";
  for (const path of others.split("\0").filter(Boolean).sort()) {
    untracked += path + ":" + hashBytes(await readFile(join(root, path))) + "\n";
  }
  return createHash("sha256")
    .update(head)
    .update(staged)
    .update(diff)
    .update(untracked)
    .digest("hex");
}

/**
 * 读取当前 worktree 文本 diff。
 *
 * @param root 任务 worktree。
 * @returns 不包含外部 diff 工具的 Git diff。
 */
export async function worktreeDiff(root: string): Promise<string> {
  return await runGitRaw(root, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--",
  ]);
}

/**
 * 列出 detached worktree 相对其 index 的全部源码变化。
 *
 * @param root 任务 worktree 根目录。
 * @returns 排序去重后的项目相对路径，包含未跟踪文件。
 * @remarks 启动时来源工作树快照已暂存到 index，因此这里得到的只是 Agent 后续增量，
 * 不会把用户启动前已有的本地修改误算成 Agent 修改。
 */
export async function worktreeChangedPaths(root: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGitRaw(root, ["diff", "--name-only", "-z", "--"]),
    runGitRaw(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  return [...new Set(
    (tracked + untracked)
      .split("\0")
      .filter(Boolean)
      .map(normalizeProjectPath),
  )].sort();
}
