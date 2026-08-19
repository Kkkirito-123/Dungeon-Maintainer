import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TaskStore } from "../src/task/store.js";
import {
  applyTaskPatch,
  capturePatch,
  snapshotWorktreePatch,
} from "../src/workspace/apply.js";
import {
  hashFile,
  hashWorktree,
  readRepo,
} from "../src/workspace/git.js";
import { applyPrecisePatch } from "../src/workspace/patch.js";
import {
  createTaskWorktree,
  removeTaskWorktree,
  verifyTaskWorktree,
} from "../src/workspace/worktree.js";
import {
  createTemporaryGitRepository,
  readTestFile,
  runTestGit,
} from "./testSupport.js";

describe("detached worktree 与显式 apply", () => {
  it("验证前所有修改只在 worktree，验证后 apply 到正式工作区但不提交", async () => {
    const path = "game/src/presentation/status.ts";
    const repository = await createTemporaryGitRepository({
      [path]: "export const status = 'before';\n",
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      worktreeRoot = await createTaskWorktree(
        "task-apply",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-apply",
        objective: "更新状态展示",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-apply"), "pi"),
      });
      await store.transition(task, "active");
      await verifyTaskWorktree(task);
      await applyPrecisePatch({
        task,
        store,
        confirmCore: async () => {
          throw new Error("presentation 路径不应请求核心审批");
        },
        beforePatch: async () => undefined,
        afterPatch: async () => undefined,
      }, { edits: [{
        path,
        baseHash: await hashFile(worktreeRoot, path),
        oldText: "export const status = 'before';",
        newText: "export const status = 'after';",
      }] });

      assert.equal(
        await readTestFile(join(worktreeRoot, path)),
        "export const status = 'after';\n",
      );
      assert.equal(
        await readTestFile(join(repository.repoRoot, path)),
        "export const status = 'before';\n",
      );

      const captured = await capturePatch(task, store.taskDir(task.id));
      assert.deepEqual(captured.paths, [path]);
      task.baseHashes = captured.baseHashes;
      task.patchPath = captured.patchPath;
      task.reversePatchPath = captured.reversePatchPath;
      task.verification = {
        worktreeHash: await hashWorktree(worktreeRoot),
        checkIds: ["game-test", "game-architecture", "game-build"],
        reproductionId: "reproduction-1",
        replayPassed: true,
        verifiedAt: new Date().toISOString(),
      };
      await store.transition(task, "verifying");
      await store.transition(task, "ready_to_apply");

      const appliedHashes = await applyTaskPatch(task);
      assert.equal(appliedHashes[path], await hashFile(repository.repoRoot, path));
      assert.equal(
        await readTestFile(join(repository.repoRoot, path)),
        "export const status = 'after';\n",
      );
      assert.equal(await runTestGit(repository.repoRoot, ["rev-parse", "HEAD"]), repository.baseHead);
      assert.match((await readRepo(repository.repoRoot)).status, /status\.ts/u);
      assert.equal(
        await readFile(captured.patchPath, "utf8"),
        await readFile(captured.reversePatchPath, "utf8"),
      );
    } finally {
      if (worktreeRoot) {
        await removeTaskWorktree(
          repository.repoRoot,
          worktreeRoot,
          worktreesDir,
        ).catch(() => undefined);
      }
      await repository.dispose();
    }
  });

  it("未验证、验证后 worktree 漂移和目标仓库漂移都会拒绝 apply", async () => {
    const path = "game/src/presentation/status.ts";
    const repository = await createTemporaryGitRepository({
      [path]: "export const status = 'before';\n",
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      worktreeRoot = await createTaskWorktree(
        "task-drift",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-drift",
        objective: "验证冲突保护",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-drift"), "pi"),
      });
      await store.transition(task, "active");
      await assert.rejects(applyTaskPatch(task), /尚未完成验证/u);

      await writeFile(join(worktreeRoot, path), "export const status = 'after';\n", "utf8");
      task.changedPaths = [path];
      const captured = await capturePatch(task, store.taskDir(task.id));
      task.baseHashes = captured.baseHashes;
      task.patchPath = captured.patchPath;
      task.reversePatchPath = captured.reversePatchPath;
      task.verification = {
        worktreeHash: await hashWorktree(worktreeRoot),
        checkIds: [],
        reproductionId: "reproduction-1",
        replayPassed: true,
        verifiedAt: new Date().toISOString(),
      };
      await store.transition(task, "verifying");
      await store.transition(task, "ready_to_apply");

      await writeFile(join(worktreeRoot, path), "export const status = 'drifted';\n", "utf8");
      await assert.rejects(applyTaskPatch(task), /验证后发生变化/u);
      await writeFile(join(worktreeRoot, path), "export const status = 'after';\n", "utf8");
      task.verification.worktreeHash = await hashWorktree(worktreeRoot);
      await writeFile(join(repository.repoRoot, path), "export const status = 'user edit';\n", "utf8");
      await assert.rejects(applyTaskPatch(task), /未提交修改/u);
    } finally {
      if (worktreeRoot) {
        await removeTaskWorktree(
          repository.repoRoot,
          worktreeRoot,
          worktreesDir,
        ).catch(() => undefined);
      }
      await repository.dispose();
    }
  });

  it("discard 快照保留最终 diff，清理只接受精确任务子目录", async () => {
    const path = "game/src/presentation/status.ts";
    const repository = await createTemporaryGitRepository({
      [path]: "export const status = 'before';\n",
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      worktreeRoot = await createTaskWorktree(
        "task-discard",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      const taskDir = join(dataDir, "tasks", "task-discard");
      await writeFile(join(worktreeRoot, path), "export const status = 'discarded';\n", "utf8");
      const patchPath = await snapshotWorktreePatch({
        schemaVersion: 2,
        id: "task-discard",
        objective: "discard",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot,
        piSessionDir: join(taskDir, "pi"),
        state: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        changedPaths: [path],
        patchLines: 2,
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
      }, taskDir);
      assert.ok(patchPath);
      assert.match(await readFile(patchPath, "utf8"), /discarded/u);
      await assert.rejects(
        removeTaskWorktree(repository.repoRoot, worktreesDir, worktreesDir),
        /非任务级/u,
      );

      await removeTaskWorktree(repository.repoRoot, worktreeRoot, worktreesDir);
      worktreeRoot = null;
      assert.equal(
        await readTestFile(join(repository.repoRoot, path)),
        "export const status = 'before';\n",
      );
    } finally {
      if (worktreeRoot) {
        await removeTaskWorktree(
          repository.repoRoot,
          worktreeRoot,
          worktreesDir,
        ).catch(() => undefined);
      }
      await repository.dispose();
    }
  });
});
