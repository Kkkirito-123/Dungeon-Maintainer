/**
 * 补丁封装、显式 apply 与丢弃前快照。
 *
 * 本模块把 worktree 变化保存为 patch.diff 和 reverse.diff，并在写回正式仓库前重新
 * 验证任务状态、VerificationRecord、完整 worktree Hash、目标 HEAD、工作区洁净度
 * 和每个文件的真实字节 Hash。任一条件不满足都在 git apply 前拒绝，不尝试自动合并。
 *
 * reverse.diff 与 patch.diff 保存同一份已验证补丁，回滚方向由 Git 解释；V1 不暴露
 * 自动回滚命令，但保留恢复产物供人工检查。所有操作都不会 commit、push 或创建 PR。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "../task/types.js";
import {
  hashFile,
  hashWorktree,
  pathExists,
  readRepo,
  runGit,
  runGitRaw,
} from "./git.js";
import { normalizeProjectPath } from "./policy.js";

async function includeUntrackedFiles(worktreeRoot: string): Promise<void> {
  const raw = await runGitRaw(worktreeRoot, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  for (const path of raw.split("\0").filter(Boolean)) {
    await runGit(worktreeRoot, ["add", "--intent-to-add", "--", path]);
  }
}

/**
 * 仅保存 worktree 当前 diff，不验证正式仓库。
 *
 * /discard 使用该函数保留恢复线索，即使正式仓库在任务期间变脏也不会因此丢失
 * worktree 补丁。它只写任务目录，不应用任何变化。
 */
export async function snapshotWorktreePatch(
  task: TaskRecord,
  taskDir: string,
): Promise<string | null> {
  await includeUntrackedFiles(task.worktreeRoot);
  const patch = await runGitRaw(task.worktreeRoot, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--",
  ]);
  if (!patch) return null;
  await mkdir(taskDir, { recursive: true });
  const patchPath = join(taskDir, "patch.diff");
  await writeFile(patchPath, patch, "utf8");
  return patchPath;
}

/** 封装补丁返回的并发保护信息。 */
export interface CapturedPatch {
  paths: string[];
  baseHashes: Record<string, string>;
  patchPath: string;
  reversePatchPath: string;
}

/**
 * 生成可安全 apply 的正向和反向补丁。
 *
 * @param task 已完成工具修改的任务。
 * @param taskDir 任务产物目录。
 * @returns 变更路径、正式仓库基线 Hash 和补丁路径。
 * @throws 目标仓库漂移、没有变化或文件不属于 baseHead 时拒绝。
 */
export async function capturePatch(
  task: TaskRecord,
  taskDir: string,
): Promise<CapturedPatch> {
  const targetState = await readRepo(task.repoRoot);
  if (!targetState.clean) {
    throw new Error("目标仓库存在未提交修改，不能生成可应用补丁");
  }
  if (targetState.head !== task.baseHead) {
    throw new Error("目标仓库 HEAD 已变化，不能生成旧基线补丁");
  }
  await includeUntrackedFiles(task.worktreeRoot);
  const rawNames = await runGitRaw(task.worktreeRoot, [
    "diff",
    "--name-only",
    "-z",
    "--",
  ]);
  const paths = rawNames.split("\0").filter(Boolean).map(normalizeProjectPath);
  if (paths.length === 0) throw new Error("任务没有可应用的代码变化");
  const patch = await runGitRaw(task.worktreeRoot, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--",
  ]);
  await mkdir(taskDir, { recursive: true });
  const patchPath = join(taskDir, "patch.diff");
  const reversePatchPath = join(taskDir, "reverse.diff");
  await Promise.all([
    writeFile(patchPath, patch, "utf8"),
    writeFile(reversePatchPath, patch, "utf8"),
  ]);

  const baseHashes = Object.fromEntries(await Promise.all(paths.map(
    async (path) => {
      let expectedBlob: string | null = null;
      try {
        expectedBlob = await runGit(
          task.repoRoot,
          ["rev-parse", task.baseHead + ":" + path],
        );
      } catch {
        expectedBlob = null;
      }
      const present = await pathExists(join(task.repoRoot, path));
      if (expectedBlob === null) {
        if (present) throw new Error("目标文件已偏离任务基线：" + path);
        return [path, "missing"] as const;
      }
      if (!present) throw new Error("目标文件已偏离任务基线：" + path);
      const targetBlob = await runGit(
        task.repoRoot,
        ["hash-object", "--path=" + path, "--", path],
      );
      if (targetBlob !== expectedBlob) {
        throw new Error("目标文件已偏离任务基线：" + path);
      }
      // Git blob 会规范文本换行；先证明语义属于 baseHead，再保存目标工作区真实字节
      // Hash，才能在 Windows CRLF 环境中同时避免误报和覆盖并发编辑。
      return [path, await hashFile(task.repoRoot, path)] as const;
    },
  )));
  return { paths, baseHashes, patchPath, reversePatchPath };
}

/**
 * 将已验证补丁应用到正式仓库但不提交。
 *
 * @param task 状态为 ready_to_apply 的任务。
 * @returns 应用后每个变更文件的 Hash。
 * @throws 验证过期、目标漂移、补丁检查失败或产物缺失时拒绝。
 */
export async function applyTaskPatch(
  task: TaskRecord,
): Promise<Record<string, string>> {
  if (
    task.state !== "ready_to_apply"
    || !task.patchPath
    || !task.verification
  ) {
    throw new Error("任务尚未完成验证，不能 apply");
  }
  if (!await pathExists(task.patchPath)) {
    throw new Error("任务补丁文件已丢失");
  }
  const currentWorktreeHash = await hashWorktree(task.worktreeRoot);
  if (currentWorktreeHash !== task.verification.worktreeHash) {
    throw new Error("worktree 在验证后发生变化，请重新 /verify");
  }
  const state = await readRepo(task.repoRoot);
  if (!state.clean) throw new Error("目标仓库存在未提交修改，拒绝 apply");
  if (state.head !== task.baseHead) {
    throw new Error("目标仓库 HEAD 与任务 baseHead 不一致");
  }
  for (const path of task.changedPaths) {
    const expected = task.baseHashes[path];
    if (expected === undefined || await hashFile(task.repoRoot, path) !== expected) {
      throw new Error("目标文件已偏离任务基线：" + path);
    }
  }
  await runGit(task.repoRoot, ["apply", "--check", "--", task.patchPath]);
  await runGit(task.repoRoot, ["apply", "--", task.patchPath]);
  return Object.fromEntries(await Promise.all(task.changedPaths.map(
    async (path) => [path, await hashFile(task.repoRoot, path)] as const,
  )));
}

/**
 * 读取可展示给 /diff 的补丁正文。
 *
 * @param task 当前任务。
 * @returns 任务产物或实时 worktree diff。
 */
export async function readTaskDiff(task: TaskRecord): Promise<string> {
  if (task.patchPath && await pathExists(task.patchPath)) {
    return await readFile(task.patchPath, "utf8");
  }
  await includeUntrackedFiles(task.worktreeRoot);
  return await runGitRaw(task.worktreeRoot, [
    "diff",
    "--no-ext-diff",
    "--unified=3",
    "--",
  ]);
}
