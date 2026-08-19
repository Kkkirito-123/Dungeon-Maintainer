/**
 * V1 测试使用的真实临时 Git 仓库和任务夹具。
 *
 * 本文件只在系统临时目录创建可删除的数据，不访问用户游戏仓库。Git 命令全部通过
 * execFile 参数数组执行；每个调用方负责在测试结束时调用 dispose，避免残留 worktree。
 */

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { TaskRecord } from "../src/task/types.js";

const executeFile = promisify(execFile);

/** 真实临时 Git 仓库及其清理句柄。 */
export interface TemporaryGitRepository {
  temporaryRoot: string;
  repoRoot: string;
  baseHead: string;
  dispose(): Promise<void>;
}

/**
 * 在指定目录执行固定 Git 参数。
 *
 * @param cwd 临时仓库或 worktree。
 * @param args 测试源码声明的参数数组。
 * @returns 去除首尾空白的 stdout。
 */
export async function runTestGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await executeFile("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

/**
 * 创建带一个基线提交的真实临时仓库。
 *
 * @param files 项目相对路径到 UTF-8 内容的映射。
 * @returns 仓库根、基线提交和递归清理函数。
 */
export async function createTemporaryGitRepository(
  files: Readonly<Record<string, string>>,
): Promise<TemporaryGitRepository> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dungeon-maintainer-v1-"));
  const repoRoot = join(temporaryRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  await runTestGit(repoRoot, ["init"]);
  await runTestGit(repoRoot, ["config", "user.email", "maintainer-test@example.invalid"]);
  await runTestGit(repoRoot, ["config", "user.name", "Dungeon Maintainer Test"]);
  await runTestGit(repoRoot, ["config", "core.autocrlf", "false"]);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(repoRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await runTestGit(repoRoot, ["add", "."]);
  await runTestGit(repoRoot, ["commit", "-m", "test baseline"]);
  const baseHead = await runTestGit(repoRoot, ["rev-parse", "HEAD"]);
  return {
    temporaryRoot,
    repoRoot,
    baseHead,
    dispose: async () => {
      await runTestGit(repoRoot, ["worktree", "prune"]).catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** 读取测试文件的 UTF-8 正文。 */
export async function readTestFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

/**
 * 创建不触发文件副作用的完整 schema v2 任务对象。
 *
 * @param overrides 需要覆盖的精确字段。
 * @returns 适合纯函数或参数构造测试的任务记录。
 */
export function createTaskRecordFixture(
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 2,
    id: "task-fixture",
    objective: "定位并修复测试问题",
    repoRoot: "C:/fixture/repo",
    baseHead: "a".repeat(40),
    worktreeRoot: "C:/fixture/worktree",
    piSessionDir: "C:/fixture/task/pi",
    state: "active",
    createdAt: now,
    updatedAt: now,
    changedPaths: [],
    patchLines: 0,
    baseHashes: {},
    checks: [],
    reproductions: [],
    activeReproductionId: null,
    verification: null,
    approval: null,
    patchPath: null,
    reversePatchPath: null,
    appliedHashes: {},
    conclusion: null,
    ...overrides,
  };
}
