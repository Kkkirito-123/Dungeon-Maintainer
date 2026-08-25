/**
 * Shell 与 tree 工具共享的工作树、可恢复任务和沙箱文件目录。
 *
 * 本模块只返回低敏路径摘要和状态标记，不读取文件正文、不创建任务、不启动 Pi，也不
 * 修改 Git。合法来源树必须来自当前 Git common-dir 的工作树列表且通过固定 SQL Dungeon
 * 项目标识校验；维护器自己的 detached worktree 不会伪装成来源树。
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { inspectDungeonRepository } from "../app/repository.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord, TaskState } from "../task/types.js";
import { runGitRaw } from "./git.js";
import { classifyPath, normalizeProjectPath } from "./policy.js";
import { hasActiveWriteScope } from "./write-scope.js";
import { EvidenceStore } from "../evidence/store.js";

/** Shell 左侧显示的合法 Git 来源工作树。 */
export interface RepositoryWorktreeSummary {
  id: string;
  branch: string;
  dirtyFiles: number;
  current: boolean;
}

interface RepositoryWorktreeCandidate extends RepositoryWorktreeSummary {
  path: string;
}

/** Shell 左侧显示的可恢复维护任务。 */
export interface RecoverableTaskSummary {
  id: string;
  name: string;
  state: TaskState;
  branch: string;
  changedFiles: number;
  current: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Shell 右侧文件树的单文件安全标记。 */
export interface WorkspaceFileSummary {
  path: string;
  approved: boolean;
  modified: boolean;
  denied: boolean;
  validation: "not_run" | "passed" | "failed";
}

function pathInside(parent: string, target: string): boolean {
  const escaped = relative(resolve(parent), resolve(target));
  return !escaped || (!escaped.startsWith("..") && !isAbsolute(escaped));
}

function stableTreeId(path: string): string {
  const normalized = process.platform === "win32"
    ? resolve(path).toLowerCase()
    : resolve(path);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

async function gitCommonDir(root: string): Promise<string> {
  const raw = await runGitRaw(root, ["rev-parse", "--git-common-dir"]);
  return await realpath(resolve(root, raw.trim()));
}

async function listCandidates(
  task: TaskRecord,
  store: TaskStore,
): Promise<RepositoryWorktreeCandidate[]> {
  const raw = await runGitRaw(task.repoRoot, ["worktree", "list", "--porcelain"]);
  const maintenanceRoot = resolve(store.dataDir, "worktrees");
  const paths = raw.split(/\r?\n\r?\n/u)
    .map((block) => block.split(/\r?\n/u)
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length))
    .filter((path): path is string => !!path)
    .filter((path) => !pathInside(maintenanceRoot, path));
  const candidates: RepositoryWorktreeCandidate[] = [];
  for (const path of paths.slice(0, 30)) {
    try {
      const state = await inspectDungeonRepository(path);
      candidates.push({
        id: stableTreeId(state.root),
        path: state.root,
        branch: state.branch,
        dirtyFiles: state.status
          ? state.status.split(/\r?\n/u).filter(Boolean).length
          : 0,
        current: resolve(state.root) === resolve(task.repoRoot),
      });
    } catch {
      // 同一 common-dir 可以注册非游戏 worktree；固定项目标识不通过时不暴露。
    }
  }
  return candidates;
}

/**
 * 枚举当前 Git common-dir 内可作为新任务来源的 SQL Dungeon 工作树。
 *
 * @param task 当前任务。
 * @param store 维护器数据目录，用于排除内部 detached worktree。
 * @returns 不含绝对路径的来源树摘要。
 */
export async function listRepositoryWorktrees(
  task: TaskRecord,
  store: TaskStore,
): Promise<RepositoryWorktreeSummary[]> {
  return (await listCandidates(task, store)).map((candidate) => ({
    id: candidate.id,
    branch: candidate.branch,
    dirtyFiles: candidate.dirtyFiles,
    current: candidate.current,
  }));
}

/**
 * 将刚刚展示的 12 位工作树 ID 重新解析为合法来源路径。
 *
 * @param task 当前任务。
 * @param store 当前任务存储。
 * @param id Shell 或 Agent 提交的稳定 ID。
 * @returns 重新枚举后仍然存在的来源树绝对路径。
 * @throws ID 不属于当前 common-dir 时拒绝。
 */
export async function resolveRepositoryWorktree(
  task: TaskRecord,
  store: TaskStore,
  id: string,
): Promise<string> {
  const candidate = (await listCandidates(task, store)).find((entry) => entry.id === id);
  if (!candidate) throw new Error("工作树 ID 不属于当前 SQL Dungeon 仓库");
  return candidate.path;
}

/**
 * 列出同一 Git common-dir 下尚未终结的维护任务。
 *
 * @param task 当前活动任务。
 * @param store 任务事实存储。
 * @returns 可由单一 AppController 恢复的任务摘要。
 */
export async function listRecoverableTasks(
  task: TaskRecord,
  store: TaskStore,
): Promise<RecoverableTaskSummary[]> {
  const currentCommonDir = await gitCommonDir(task.worktreeRoot);
  const output: RecoverableTaskSummary[] = [];
  for (const id of await store.listIds()) {
    try {
      const candidate = await store.read(id);
      if (candidate.state === "applied" || candidate.state === "discarded") continue;
      if (await gitCommonDir(candidate.worktreeRoot) !== currentCommonDir) continue;
      output.push({
        id: candidate.id,
        name: candidate.displayName,
        state: candidate.state,
        branch: candidate.sourceBranch,
        changedFiles: candidate.changedPaths.length,
        current: candidate.id === task.id,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
    } catch {
      // 损坏或已丢失的任务由显式 resume 报错；目录面板只展示可验证摘要。
    }
  }
  return output.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * 读取当前 detached worktree 的文件名和沙箱标记。
 *
 * @param task 当前任务。
 * @returns 最多 4,000 个 Git 已跟踪或未跟踪源文件，不含文件正文。
 */
export async function readWorkspaceTree(
  task: TaskRecord,
  dataDir: string,
): Promise<WorkspaceFileSummary[]> {
  const raw = await runGitRaw(task.worktreeRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const paths = [...new Set(raw.split("\0").filter(Boolean).map(normalizeProjectPath))]
    .sort()
    .slice(0, 4_000);
  const evidence = new EvidenceStore(dataDir, task);
  const lastCheck = (await evidence.checks()).at(-1);
  const validation = task.verification?.replayPassed
    ? "passed"
    : lastCheck && lastCheck.status !== "passed" ? "failed" : "not_run";
  const scopeActive = hasActiveWriteScope(task);
  return paths.map((path) => ({
    path,
    approved: scopeActive && task.writeScope.allowedPaths.includes(path),
    modified: task.changedPaths.includes(path),
    denied: classifyPath(path, "write") === "denied",
    validation,
  }));
}
