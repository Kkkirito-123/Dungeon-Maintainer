/**
 * 用户批准总方案后的精确写入范围门禁。
 *
 * 本模块只判断任务当前是否拥有活动白名单，以及目标项目相对路径是否精确位于该
 * 白名单。真实路径、符号链接和敏感目录仍由 workspace/policy 负责；两层检查必须
 * 同时通过，避免“在 worktree 内”被误当成“可以修改任意文件”。
 */

import { lstat } from "node:fs/promises";
import type { TaskRecord } from "../task/types.js";
import {
  normalizeProjectPath,
  resolveProjectPath,
} from "./policy.js";

/** 当前任务是否仍持有用户批准且尚未关闭的写入范围。 */
export function hasActiveWriteScope(task: TaskRecord): boolean {
  return task.writeScope.state === "approved"
    && task.writeScope.approvedAt !== null
    && task.writeScope.closedAt === null;
}

/**
 * 规范化并去重总方案中的精确文件路径。
 *
 * @param paths Agent 在 proposed 方案中声明的项目相对文件。
 * @returns 稳定排序后的精确路径。
 */
export function normalizeWriteScopePaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("执行方案必须声明至少一个允许修改的文件");
  }
  return [...new Set(paths.map(normalizeProjectPath))].sort();
}

/**
 * 在弹出方案确认前验证白名单中的每个文件仍位于当前 worktree 内且允许写入。
 *
 * @param root 当前 detached worktree 根目录。
 * @param paths Agent 声明的精确项目相对文件。
 * @returns 已规范化、去重并稳定排序的文件列表。
 * @throws 敏感路径、绝对路径、父目录、符号链接或 junction 越界时拒绝。
 */
export async function validateWriteScopePaths(
  root: string,
  paths: readonly string[],
): Promise<string[]> {
  const normalized = normalizeWriteScopePaths(paths);
  await Promise.all(normalized.map(
    async (path) => {
      const resolved = await resolveProjectPath(root, path, "write");
      try {
        const target = await lstat(resolved.absolute);
        if (!target.isFile()) {
          throw new Error("允许修改范围必须指向具体文件，不能是目录：" + path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // 新文件在方案确认时可以尚不存在；后续 write/patch 仍只允许这个精确路径。
      }
    },
  ));
  return normalized;
}

/**
 * 验证最终变更没有超出曾经由用户批准的文件集合。
 *
 * 写入范围在 result 成功后会关闭，因此这里检查批准事实而非活动状态；这样 `/apply`
 * 仍能复核已经冻结的白名单，同时恢复的 v2 任务必须重新批准范围后才能验证或应用。
 *
 * @param task 当前任务。
 * @param paths Git 事实得到的最终变更路径。
 * @returns 规范化并稳定排序后的变更路径。
 * @throws 没有批准范围或任一变更越界时拒绝。
 */
export function assertChangedPathsWithinApprovedScope(
  task: TaskRecord,
  paths: readonly string[],
): string[] {
  if (!task.writeScope.approvedAt || task.writeScope.allowedPaths.length === 0) {
    throw new Error("当前任务没有已批准的修改文件范围");
  }
  const normalized = [...new Set(paths.map(normalizeProjectPath))].sort();
  const outside = normalized.filter(
    (path) => !task.writeScope.allowedPaths.includes(path),
  );
  if (outside.length > 0) {
    throw new Error("最终变更超出已批准方案：" + outside.join(", "));
  }
  return normalized;
}

/**
 * 验证单个写入目标属于当前活动白名单。
 *
 * @param task 当前任务。
 * @param path edit/write/patch 提供的项目路径。
 * @returns 规范化项目相对路径。
 * @throws 未批准、范围已关闭或路径未列入方案时拒绝。
 */
export function assertWritePathAllowed(task: TaskRecord, path: string): string {
  const normalized = normalizeProjectPath(path);
  if (!hasActiveWriteScope(task)) {
    throw new Error("当前没有已批准的修改文件范围");
  }
  if (!task.writeScope.allowedPaths.includes(normalized)) {
    throw new Error("修改路径不在已批准方案中：" + normalized);
  }
  return normalized;
}
