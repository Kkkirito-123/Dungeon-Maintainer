import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TaskStore } from "../src/task/store.js";
import { capturePatch } from "../src/workspace/apply.js";
import {
  createPublishPreview,
  formatPublishPreview,
  parseGitHubRepository,
  publishTask,
} from "../src/workspace/publish.js";
import { hashWorktree, runGit } from "../src/workspace/git.js";
import {
  createTaskWorktreeSnapshot,
  removeTaskWorktree,
} from "../src/workspace/worktree.js";
import {
  createTemporaryGitRepository,
  runTestGit,
} from "./testSupport.js";

async function createReadyPublishTask(suffix: string) {
  const repository = await createTemporaryGitRepository({
    "README.md": "before\n",
  });
  await runTestGit(repository.repoRoot, [
    "remote",
    "add",
    "origin",
    "https://github.com/example/dungeon.git",
  ]);
  const dataDir = join(repository.temporaryRoot, "publish-data-" + suffix);
  const store = new TaskStore(dataDir);
  const taskId = "task-publish-" + suffix;
  const snapshot = await createTaskWorktreeSnapshot(
    taskId,
    repository.repoRoot,
    repository.baseHead,
    join(dataDir, "worktrees"),
  );
  const task = await store.create({
    id: taskId,
    objective: "修复游戏遭遇概率",
    repoRoot: repository.repoRoot,
    baseHead: repository.baseHead,
    sourceBranch: "main",
    sourceDirtyFiles: snapshot.sourceDirtyFiles,
    sourceSnapshotHash: snapshot.sourceSnapshotHash,
    worktreeRoot: snapshot.root,
    piSessionDir: join(store.taskDir(taskId), "pi"),
  });
  await store.transition(task, "active");
  await store.approveWriteScope(task, ["README.md"], "publish-scope");
  await writeFile(join(snapshot.root, "README.md"), "after\n", "utf8");
  const captured = await capturePatch(task, store.taskDir(taskId));
  task.changedPaths = captured.paths;
  task.baseHashes = captured.baseHashes;
  task.patchPath = captured.patchPath;
  task.reversePatchPath = captured.reversePatchPath;
  task.verification = {
    worktreeHash: await hashWorktree(snapshot.root),
    checkIds: [],
    reproductionId: null,
    replayPassed: true,
    verifiedAt: new Date().toISOString(),
  };
  await store.transition(task, "verifying");
  await store.transition(task, "ready_to_apply");
  return { repository, store, task, worktreeRoot: snapshot.root };
}

async function disposeReadyTask(
  fixture: Awaited<ReturnType<typeof createReadyPublishTask>>,
): Promise<void> {
  await removeTaskWorktree(
    fixture.repository.repoRoot,
    fixture.worktreeRoot,
    join(fixture.store.dataDir, "worktrees"),
  ).catch(() => undefined);
  await fixture.repository.dispose();
}

describe("窄域 GitHub PR 发布", () => {
  it("只解析 github.com，并拒绝其它远端", () => {
    assert.equal(parseGitHubRepository("https://github.com/a/b.git"), "a/b");
    assert.equal(parseGitHubRepository("git@github.com:a/b"), "a/b");
    assert.throws(
      () => parseGitHubRepository("https://gitlab.com/a/b.git"),
      /github\.com/u,
    );
  });

  it("未验证任务在确认前拒绝，用户取消不产生发布副作用", async () => {
    const fixture = await createReadyPublishTask("cancel");
    try {
      fixture.task.state = "active";
      await assert.rejects(
        createPublishPreview(fixture.task, fixture.store.taskDir(fixture.task.id)),
        /尚未完成验证/u,
      );
      fixture.task.state = "ready_to_apply";
      const ghCalls: string[][] = [];
      const result = await publishTask({
        task: fixture.task,
        store: fixture.store,
        taskDir: fixture.store.taskDir(fixture.task.id),
        confirm: async (preview) => {
          assert.match(formatPublishPreview(preview), /Diff 预览/u);
          return false;
        },
        runGh: async (_cwd, args) => {
          ghCalls.push([...args]);
          return "";
        },
      });
      assert.equal(result, null);
      assert.deepEqual(ghCalls, []);
      assert.equal(await runTestGit(fixture.repository.repoRoot, ["rev-parse", "HEAD"]), fixture.repository.baseHead);
      assert.match(
        await readFile(join(fixture.store.taskDir(fixture.task.id), "events.jsonl"), "utf8"),
        /publish\.cancelled/u,
      );
    } finally {
      await disposeReadyTask(fixture);
    }
  });

  it("确认后在临时 worktree 走固定 commit/push/PR，且不执行 merge", async () => {
    const fixture = await createReadyPublishTask("success");
    try {
      const gitCalls: string[][] = [];
      const ghCalls: string[][] = [];
      const order: string[] = [];
      const fixedGit = async (cwd: string, args: readonly string[]): Promise<string> => {
        gitCalls.push([...args]);
        if (args[0] === "ls-remote" || args[0] === "push") return "";
        return await runGit(cwd, args);
      };
      const result = await publishTask({
        task: fixture.task,
        store: fixture.store,
        taskDir: fixture.store.taskDir(fixture.task.id),
        confirm: async (preview) => {
          order.push("confirm");
          assert.equal(preview.branch, "dungeon-maintainer/task-publish-success");
          assert.deepEqual(preview.changedPaths, ["README.md"]);
          return true;
        },
        runChecks: async () => {
          order.push("checks");
        },
        runGit: fixedGit,
        runGh: async (_cwd, args) => {
          ghCalls.push([...args]);
          order.push("gh");
          return "https://github.com/example/dungeon/pull/42\n";
        },
      });
      assert.ok(result);
      assert.equal(result.prUrl, "https://github.com/example/dungeon/pull/42");
      assert.deepEqual(order, ["confirm", "checks", "gh"]);
      assert.ok(gitCalls.some((args) => args[0] === "commit" && args[1] === "-m"));
      assert.ok(gitCalls.some((args) => args[0] === "push" && args.includes("--set-upstream")));
      assert.deepEqual(ghCalls[0]?.slice(0, 4), ["pr", "create", "--repo", "example/dungeon"]);
      assert.ok(!ghCalls.flat().includes("merge"));
      assert.equal(await runTestGit(fixture.repository.repoRoot, ["rev-parse", "HEAD"]), fixture.repository.baseHead);
      assert.equal(await runTestGit(fixture.worktreeRoot, ["rev-parse", "HEAD"]), fixture.repository.baseHead);
      assert.match(
        await readFile(join(fixture.store.taskDir(fixture.task.id), "events.jsonl"), "utf8"),
        /publish\.succeeded/u,
      );
    } finally {
      await disposeReadyTask(fixture);
    }
  });
});
