/**
 * SQL Dungeon 的窄域 GitHub 发布流程。
 *
 * 本模块只把已验证任务的固定补丁发布为一个 GitHub Pull Request；它不提供任意命令、
 * 自定义远端、分支或合并能力。预览阶段只读取任务、Git 和补丁，确认后才在维护器
 * 数据目录下创建临时 worktree，执行固定的 git commit/push 与 gh pr create。正式仓库
 * 和任务验证 worktree 都不被提交或切换。临时 worktree 在成功或失败后清理；网络失败
 * 不回滚已经存在的远端提交，但会保留任务状态、事件和本地分支供人工恢复。
 */

import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import {
  hashBytes,
  hashFile,
  hashWorktree,
  pathExists,
  readRepo,
  runGit,
  runGitRaw,
  worktreeChangedPaths,
} from "./git.js";
import { normalizeProjectPath } from "./policy.js";
import { assertChangedPathsWithinApprovedScope } from "./write-scope.js";

const executeFile = promisify(execFile);
const MAX_CLI_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_PREVIEW_CHARS = 12 * 1024;
const PUBLISH_WORKTREE_NAME = ".publish-worktree";
const PUBLISH_BRANCH_PREFIX = "dungeon-maintainer/";
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/u;

/** 确认框和模型结果共享的发布预览；不含完整模型正文或凭据。 */
export interface PublishPreview {
  repository: string;
  baseBranch: string;
  branch: string;
  commitTitle: string;
  prTitle: string;
  prBody: string;
  changedPaths: string[];
  diffPreview: string;
  diffHash: string;
  worktreeHash: string;
  taskState: "ready_to_apply" | "applied";
}

/** 发布成功后返回的低敏结果。 */
export interface PublishResult extends PublishPreview {
  commitSha: string;
  prUrl: string;
}

/** 发布工具的窄域执行依赖；runGh 仅供测试替换，不向模型暴露。 */
export interface PublishTaskOptions {
  task: TaskRecord;
  store: TaskStore;
  taskDir: string;
  signal?: AbortSignal;
  confirm(preview: PublishPreview): Promise<boolean>;
  /** 发布前的固定完整质量门；省略仅用于不涉及游戏代码的测试夹具。 */
  runChecks?: () => Promise<void>;
  /** 测试替换 gh 进程；生产环境始终使用固定 gh 参数。 */
  runGh?: (cwd: string, args: readonly string[]) => Promise<string>;
  /** 测试替换固定 Git 调用；生产环境始终使用 workspace/git.ts。 */
  runGit?: (cwd: string, args: readonly string[]) => Promise<string>;
}

function oneLine(value: string, limit: number): string {
  const output = redactText(value)
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\p{Cc}/gu, " ")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return output || "维护游戏变更";
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知发布错误";
  return oneLine(message, 400);
}

function clipDiff(value: string): string {
  if (value.length <= MAX_DIFF_PREVIEW_CHARS) return value;
  return value.slice(0, MAX_DIFF_PREVIEW_CHARS)
    + "\n[Diff 预览已截断；完整内容可用 /diff 查看]";
}

function parseNames(value: string): string[] {
  return value
    .split("\0")
    .filter(Boolean)
    .map(normalizeProjectPath)
    .sort();
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function assertSafeBranch(branch: string): void {
  if (!SAFE_BRANCH.test(branch) || branch.includes("..")) {
    throw new Error("来源分支名称不符合发布边界");
  }
}

/**
 * 从 origin URL 解析 GitHub 仓库名。
 *
 * @param remote `git remote get-url origin` 的原文。
 * @returns `owner/repository`，供 gh 的 `--repo` 固定参数使用。
 * @throws 非 github.com、缺少 owner/repository 或含非法字符时拒绝。
 */
export function parseGitHubRepository(remote: string): string {
  const value = remote.trim().replace(/\.git$/iu, "");
  const match = value.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+)$/iu,
  );
  const owner = match?.[1];
  const repository = match?.[2];
  if (
    !owner
    || !repository
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(owner)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(repository)
  ) {
    throw new Error("origin 必须是 github.com 上的明确仓库");
  }
  return owner + "/" + repository;
}

async function resolveBaseBranch(task: TaskRecord): Promise<string> {
  let branch = task.sourceBranch.trim();
  if (branch === "(detached)" || !SAFE_BRANCH.test(branch)) {
    const remoteHead = await runGit(
      task.repoRoot,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ).catch(() => "");
    branch = remoteHead.startsWith("origin/")
      ? remoteHead.slice("origin/".length)
      : remoteHead;
  }
  assertSafeBranch(branch);
  return branch;
}

async function assertTaskSnapshot(
  task: TaskRecord,
  changedPaths: readonly string[],
): Promise<void> {
  if (!task.sourceSnapshotHash || task.sourceDirtyFiles !== 0) {
    throw new Error("来源工作树含未提交基线，不能自动发布 PR；请先保持来源树干净");
  }
  const source = await readRepo(task.repoRoot);
  if (source.head !== task.baseHead) {
    throw new Error("正式仓库 HEAD 与任务 baseHead 不一致");
  }
  const sourcePaths = await worktreeChangedPaths(task.repoRoot);
  if (task.state === "ready_to_apply") {
    if (!source.clean || sourcePaths.length > 0) {
      throw new Error("正式仓库在发布前发生变化，请先处理本地修改");
    }
    if (await hashWorktree(task.repoRoot) !== task.sourceSnapshotHash) {
      throw new Error("正式仓库已偏离任务启动快照");
    }
    return;
  }

  // /apply 后正式仓库只应包含本任务的精确增量；仍从 baseHead 的临时 worktree
  // 生成 PR，避免把用户其它未提交内容带入远端。
  if (!samePaths(sourcePaths, changedPaths)) {
    throw new Error("已应用任务的正式仓库包含额外修改，不能自动发布");
  }
  for (const path of changedPaths) {
    const expected = task.appliedHashes[path];
    if (!expected || await hashFile(task.repoRoot, path) !== expected) {
      throw new Error("已应用文件与任务记录不一致：" + path);
    }
  }
}

async function assertTaskReady(
  task: TaskRecord,
  taskDir: string,
): Promise<{
  patchPath: string;
  changedPaths: string[];
  worktreeHash: string;
  taskState: "ready_to_apply" | "applied";
}> {
  if (task.state !== "ready_to_apply" && task.state !== "applied") {
    throw new Error("任务尚未完成验证，不能发布 PR");
  }
  if (!task.verification || !task.patchPath || task.changedPaths.length === 0) {
    throw new Error("任务缺少可发布的验证补丁");
  }
  const expectedPatchPath = resolve(join(taskDir, "patch.diff"));
  if (resolve(task.patchPath) !== expectedPatchPath || !await pathExists(expectedPatchPath)) {
    throw new Error("任务补丁路径无效或已丢失");
  }
  const changedPaths = assertChangedPathsWithinApprovedScope(task, task.changedPaths);
  const worktreeHash = await hashWorktree(task.worktreeRoot);
  if (worktreeHash !== task.verification.worktreeHash) {
    throw new Error("验证后 worktree 发生变化，请重新 /verify");
  }
  const actualPaths = await worktreeChangedPaths(task.worktreeRoot);
  if (!samePaths(actualPaths, changedPaths)) {
    throw new Error("worktree 变更路径与验证记录不一致，请重新 /verify");
  }
  await assertTaskSnapshot(task, changedPaths);
  return {
    patchPath: expectedPatchPath,
    changedPaths,
    worktreeHash,
    taskState: task.state,
  };
}

/**
 * 生成发布前预览，不产生 Git、网络或文件写入副作用。
 *
 * @param task 当前已验证任务。
 * @param taskDir 任务事实目录，必须是 TaskStore.taskDir(task.id)。
 * @returns 固定仓库、分支、提交、PR 和 Diff 摘要。
 */
export async function createPublishPreview(
  task: TaskRecord,
  taskDir: string,
): Promise<PublishPreview> {
  const ready = await assertTaskReady(task, taskDir);
  const remote = await runGit(task.repoRoot, ["remote", "get-url", "origin"]);
  const repository = parseGitHubRepository(remote);
  const baseBranch = await resolveBaseBranch(task);
  const branch = PUBLISH_BRANCH_PREFIX + task.id;
  assertSafeBranch(branch);
  const diff = await readFile(ready.patchPath, "utf8");
  if (!diff) throw new Error("任务补丁为空，不能创建 PR");
  const summary = oneLine(task.objective || task.displayName, 160);
  const commitTitle = oneLine("修复游戏问题：" + summary, 120);
  const prTitle = oneLine("修复游戏：" + summary, 240);
  const checks = task.verification?.checkIds.length
    ? task.verification.checkIds.join("、")
    : "已完成维护器验证";
  const prBody = [
    "## 变更说明",
    summary,
    "",
    "## 变更文件",
    ...ready.changedPaths.map((path) => "- " + path),
    "",
    "## 验证",
    "- " + checks,
    "- 浏览器重放：" + (task.verification?.replayPassed ? "通过" : "未通过"),
    "",
    "由 Dungeon Maintainer 生成；合并前请人工审核。",
  ].join("\n");
  return {
    repository,
    baseBranch,
    branch,
    commitTitle,
    prTitle,
    prBody,
    changedPaths: ready.changedPaths,
    diffPreview: clipDiff(redactText(diff)),
    diffHash: hashBytes(Buffer.from(diff, "utf8")),
    worktreeHash: ready.worktreeHash,
    taskState: ready.taskState,
  };
}

/**
 * 把固定发布元数据渲染成确认框正文。
 *
 * @param preview 已通过事实校验的发布预览。
 * @returns 供 UI 确认框展示的有限文本，不执行任何副作用。
 */
export function formatPublishPreview(preview: PublishPreview): string {
  return [
    "发布前预览（确认后才会执行）",
    "GitHub 仓库：" + preview.repository,
    "目标分支：" + preview.baseBranch,
    "发布分支：" + preview.branch,
    "提交标题：" + preview.commitTitle,
    "PR 标题：" + preview.prTitle,
    "变更文件：",
    ...preview.changedPaths.map((path) => "  - " + path),
    "",
    "PR 正文：",
    preview.prBody,
    "",
    "Diff 预览：",
    preview.diffPreview,
    "",
    "确认后只执行固定 commit、push 和创建 PR；不会合并，也不会修改正式工作区。",
  ].join("\n");
}

async function runGitHubCli(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await executeFile("gh", [...args], {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" },
    encoding: "utf8",
    maxBuffer: MAX_CLI_OUTPUT_BYTES,
    windowsHide: true,
  });
  return result.stdout;
}

function pullRequestUrl(value: string, repository: string): string {
  const match = value.match(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+/iu);
  if (!match?.[0]) throw new Error("gh 未返回可识别的 PR 地址");
  const expectedPrefix = "https://github.com/" + repository + "/pull/";
  if (!match[0].toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
    throw new Error("gh 返回的 PR 地址与目标仓库不一致");
  }
  return match[0];
}

function previewKey(preview: PublishPreview): string {
  return JSON.stringify([
    preview.repository,
    preview.baseBranch,
    preview.branch,
    preview.diffHash,
    preview.worktreeHash,
  ]);
}

async function assertRemoteBranchAbsent(
  task: TaskRecord,
  branch: string,
  git: (cwd: string, args: readonly string[]) => Promise<string>,
): Promise<void> {
  const refs = await git(task.repoRoot, ["ls-remote", "--heads", "origin", branch]);
  if (refs.trim()) throw new Error("发布分支已存在于 origin：" + branch);
}

/**
 * 在一次确认后提交、推送并创建中文 PR。
 *
 * @param options 当前任务、确认回调和可选固定质量门。
 * @returns 用户取消时返回 null，成功时返回提交和 PR 地址。
 * @throws 任务漂移、GitHub 认证、固定 Git 操作或 PR 创建失败时抛错；不会执行 merge。
 */
export async function publishTask(
  options: PublishTaskOptions,
): Promise<PublishResult | null> {
  const { task, taskDir, signal } = options;
  const git = options.runGit ?? runGit;
  const preview = await createPublishPreview(task, taskDir);
  const approved = await options.confirm(preview);
  if (!approved) {
    await appendEvent(options.store, task.id, "publish.cancelled", {
      pathCount: preview.changedPaths.length,
    }).catch(() => undefined);
    return null;
  }

  let publishRoot: string | null = null;
  let worktreeCreated = false;
  try {
    signal?.throwIfAborted();
    const confirmedPreview = await createPublishPreview(task, taskDir);
    if (previewKey(confirmedPreview) !== previewKey(preview)) {
      throw new Error("确认后任务内容发生变化，请重新打开发布预览");
    }
    if (options.runChecks) await options.runChecks();
    signal?.throwIfAborted();
    const checkedPreview = await createPublishPreview(task, taskDir);
    if (previewKey(checkedPreview) !== previewKey(preview)) {
      throw new Error("质量检查后任务内容发生变化，请重新打开发布预览");
    }
    await appendEvent(options.store, task.id, "publish.started", {
      branch: preview.branch,
      pathCount: preview.changedPaths.length,
    }).catch(() => undefined);
    await assertRemoteBranchAbsent(task, preview.branch, git);

    publishRoot = join(taskDir, PUBLISH_WORKTREE_NAME);
    if (await pathExists(publishRoot)) {
      throw new Error("上一次发布留下了临时 worktree，请先人工清理：" + publishRoot);
    }
    await mkdir(taskDir, { recursive: true });
    await git(task.repoRoot, ["worktree", "add", "--detach", publishRoot, task.baseHead]);
    worktreeCreated = true;
    const patchPath = join(taskDir, "patch.diff");
    await git(publishRoot, ["apply", "--binary", "--check", "--", patchPath]);
    await git(publishRoot, ["apply", "--binary", "--", patchPath]);
    const appliedPaths = await worktreeChangedPaths(publishRoot);
    if (!samePaths(appliedPaths, preview.changedPaths)) {
      throw new Error("发布补丁包含未预览的文件变化");
    }
    await git(publishRoot, ["switch", "-c", preview.branch]);
    await git(publishRoot, ["add", "--", ...preview.changedPaths]);
    const staged = parseNames(await runGitRaw(
      publishRoot,
      ["diff", "--cached", "--name-only", "-z", "--"],
    ));
    if (!samePaths(staged, preview.changedPaths)) {
      throw new Error("暂存区包含未预览的文件变化");
    }
    await git(publishRoot, ["commit", "-m", preview.commitTitle]);
    const commitSha = await git(publishRoot, ["rev-parse", "HEAD"]);
    await git(publishRoot, ["push", "--set-upstream", "origin", preview.branch]);
    const gh = options.runGh ?? runGitHubCli;
    const ghOutput = await gh(publishRoot, [
      "pr",
      "create",
      "--repo",
      preview.repository,
      "--base",
      preview.baseBranch,
      "--head",
      preview.branch,
      "--title",
      preview.prTitle,
      "--body",
      preview.prBody,
    ]);
    const prUrl = pullRequestUrl(ghOutput, preview.repository);
    await appendEvent(options.store, task.id, "publish.succeeded", {
      branch: preview.branch,
      baseBranch: preview.baseBranch,
      commit: commitSha.slice(0, 16),
      prUrl,
      pathCount: preview.changedPaths.length,
    }).catch(() => undefined);
    return { ...preview, commitSha, prUrl };
  } catch (error) {
    await appendEvent(options.store, task.id, "publish.failed", {
      reason: safeFailure(error),
    }).catch(() => undefined);
    throw new Error("发布 PR 失败：" + safeFailure(error), { cause: error });
  } finally {
    if (publishRoot && (worktreeCreated || await pathExists(publishRoot))) {
      await git(task.repoRoot, ["worktree", "remove", "--force", publishRoot])
        .catch(async (error: unknown) => {
          await appendEvent(options.store, task.id, "publish.cleanup_failed", {
            reason: safeFailure(error),
          }).catch(() => undefined);
        });
    }
  }
}
