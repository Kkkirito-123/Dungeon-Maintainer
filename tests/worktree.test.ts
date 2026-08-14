/** Git 集成测试验证 worktree 隔离、显式应用和安全回滚。 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { TaskStore } from "../src/runtime/task.js";
import {
  applyTaskPatch,
  capturePatch,
  createTaskWorktree,
  hashFile,
  readRepo,
  removeTaskWorktree,
  revertTaskPatch,
} from "../src/safety/worktree.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, windowsHide: true });
}

async function readyFixture(context: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "maintainer-apply-"));
  const repo = join(sandbox, "repo");
  const data = join(sandbox, "data");
  const relative = join("game", "tests", "sample.ts");
  await mkdir(join(repo, "game", "tests"), { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Maintainer Test");
  await git(repo, "config", "core.autocrlf", "false");
  await writeFile(join(repo, relative), "export const value = 1;\n", "utf8");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const state = await readRepo(repo);
  const store = new TaskStore(data);
  const task = await store.create({ mode: "fix", objective: "修改测试文件", repoRoot: state.root, baseHead: state.head });
  await store.transition(task, "diagnosing");
  task.worktreeRoot = await createTaskWorktree(task, join(data, "worktrees"));
  await writeFile(join(task.worktreeRoot, relative), "export const value = 2;\n", "utf8");
  const captured = await capturePatch(task, store.taskDir(task.id));
  task.changedPaths = captured.paths;
  task.baseHashes = captured.baseHashes;
  task.patchPath = captured.patchPath;
  task.reversePatchPath = captured.reversePatchPath;
  await store.transition(task, "verifying");
  await store.transition(task, "ready_to_apply");
  context.after(async () => {
    if (task.worktreeRoot) await removeTaskWorktree(repo, task.worktreeRoot).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  return { repo, relative, task };
}

void test("worktree 修改不会影响目标仓库，补丁需显式应用并可回滚", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "maintainer-git-"));
  const repo = join(sandbox, "repo");
  const data = join(sandbox, "data");
  await mkdir(join(repo, "game", "tests"), { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Maintainer Test");
  await git(repo, "config", "core.autocrlf", "false");
  await writeFile(join(repo, "game", "tests", "sample.ts"), "export const value = 1;\n", "utf8");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const state = await readRepo(repo);
  const store = new TaskStore(data);
  const task = await store.create({
    mode: "fix",
    objective: "修改测试文件",
    repoRoot: state.root,
    baseHead: state.head,
  });
  await store.transition(task, "diagnosing");
  task.worktreeRoot = await createTaskWorktree(task, join(data, "worktrees"));
  context.after(async () => {
    if (task.worktreeRoot) {
      await removeTaskWorktree(repo, task.worktreeRoot).catch(() => undefined);
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  const relative = join("game", "tests", "sample.ts");
  await writeFile(join(task.worktreeRoot, relative), "export const value = 2;\n", "utf8");
  assert.equal(await readFile(join(repo, relative), "utf8"), "export const value = 1;\n");

  const captured = await capturePatch(task, store.taskDir(task.id));
  task.changedPaths = captured.paths;
  task.baseHashes = captured.baseHashes;
  task.patchPath = captured.patchPath;
  task.reversePatchPath = captured.reversePatchPath;
  await store.transition(task, "verifying");
  await store.transition(task, "ready_to_apply");
  task.appliedHashes = await applyTaskPatch(task);
  await store.transition(task, "applied");
  assert.equal(await readFile(join(repo, relative), "utf8"), "export const value = 2;\n");

  await revertTaskPatch(task);
  await store.transition(task, "reverted");
  assert.equal(await readFile(join(repo, relative), "utf8"), "export const value = 1;\n");
});

void test("补丁基线使用目标工作区真实字节并兼容 Windows CRLF", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "maintainer-crlf-"));
  const repo = join(sandbox, "repo");
  const data = join(sandbox, "data");
  const relative = join("game", "tests", "sample.ts");
  await mkdir(join(repo, "game", "tests"), { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Maintainer Test");
  await git(repo, "config", "core.autocrlf", "true");
  await writeFile(join(repo, relative), "export const value = 1;\r\n", "utf8");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const state = await readRepo(repo);
  const store = new TaskStore(data);
  const task = await store.create({ mode: "fix", objective: "验证 CRLF 基线", repoRoot: repo, baseHead: state.head });
  await store.transition(task, "diagnosing");
  task.worktreeRoot = await createTaskWorktree(task, join(data, "worktrees"));
  context.after(async () => {
    if (task.worktreeRoot) await removeTaskWorktree(repo, task.worktreeRoot).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  await writeFile(join(task.worktreeRoot, relative), "export const value = 2;\r\n", "utf8");

  const captured = await capturePatch(task, store.taskDir(task.id));
  assert.equal(captured.baseHashes[relative.replaceAll("\\", "/")], await hashFile(repo, relative));
  task.changedPaths = captured.paths;
  task.baseHashes = captured.baseHashes;
  task.patchPath = captured.patchPath;
  task.reversePatchPath = captured.reversePatchPath;
  await store.transition(task, "verifying");
  await store.transition(task, "ready_to_apply");
  task.appliedHashes = await applyTaskPatch(task);
  await store.transition(task, "applied");
  await revertTaskPatch(task);
  assert.equal((await readRepo(repo)).clean, true);
});

void test("worktree 只通过忽略目录链接复用游戏依赖", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "maintainer-deps-"));
  const repo = join(sandbox, "repo");
  const data = join(sandbox, "data");
  await mkdir(join(repo, "game", "node_modules", "fixture"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "game/node_modules/\n", "utf8");
  await writeFile(join(repo, "game", "source.ts"), "export {};\n", "utf8");
  await writeFile(join(repo, "game", "node_modules", "fixture", "marker.txt"), "shared\n", "utf8");
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Maintainer Test");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const state = await readRepo(repo);
  const store = new TaskStore(data);
  const task = await store.create({ mode: "fix", objective: "复用依赖", repoRoot: state.root, baseHead: state.head });
  await store.transition(task, "diagnosing");
  task.worktreeRoot = await createTaskWorktree(task, join(data, "worktrees"));
  context.after(async () => {
    if (task.worktreeRoot) await removeTaskWorktree(repo, task.worktreeRoot).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const linked = join(task.worktreeRoot, "game", "node_modules");
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.equal(await readFile(join(linked, "fixture", "marker.txt"), "utf8"), "shared\n");
  assert.equal((await readRepo(task.worktreeRoot)).clean, true);
  await removeTaskWorktree(repo, task.worktreeRoot);
  task.worktreeRoot = null;
  assert.equal(await readFile(join(repo, "game", "node_modules", "fixture", "marker.txt"), "utf8"), "shared\n");
});

void test("目标 HEAD 漂移后拒绝应用旧补丁", async (context) => {
  const { repo, relative, task } = await readyFixture(context);
  await writeFile(join(repo, "head-change.txt"), "new head\n", "utf8");
  await git(repo, "add", "head-change.txt");
  await git(repo, "commit", "-m", "move head");

  await assert.rejects(applyTaskPatch(task), /HEAD 与任务基线不一致/u);
  assert.equal(await readFile(join(repo, relative), "utf8"), "export const value = 1;\n");
});

void test("目标工作区存在用户修改时拒绝应用补丁", async (context) => {
  const { repo, relative, task } = await readyFixture(context);
  await writeFile(join(repo, "user-work.txt"), "uncommitted\n", "utf8");

  await assert.rejects(applyTaskPatch(task), /存在未提交修改/u);
  assert.equal(await readFile(join(repo, relative), "utf8"), "export const value = 1;\n");
});

void test("目标文件字节偏离 baseHash 时拒绝应用补丁", async (context) => {
  const { repo, relative, task } = await readyFixture(context);
  await git(repo, "update-index", "--assume-unchanged", "--", relative);
  await writeFile(join(repo, relative), "export const value = 9;\n", "utf8");
  assert.equal((await readRepo(repo)).clean, true);

  await assert.rejects(applyTaskPatch(task), /目标文件已偏离任务基线/u);
  assert.equal(await readFile(join(repo, relative), "utf8"), "export const value = 9;\n");
});
