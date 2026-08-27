import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkEvidence, claimEvidence } from "../src/evidence/projector.js";
import { EvidenceStore } from "../src/evidence/store.js";
import { TaskStore } from "../src/task/store.js";
import { syncWorktreeChanges } from "../src/workspace/changes.js";
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
  createTaskWorktreeSnapshot,
  removeTaskWorktree,
  verifyTaskWorktree,
} from "../src/workspace/worktree.js";
import {
  createTemporaryGitRepository,
  readTestFile,
  runTestGit,
} from "./testSupport.js";

describe("detached worktree 与显式 apply", () => {
  it("同一 worktree Hash 重复同步保留检查缓存，Hash 变化后才使其失效", async () => {
    const path = "game/src/presentation/idempotent-sync.ts";
    const repository = await createTemporaryGitRepository({
      [path]: "export const value = 'before';\n",
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      worktreeRoot = await createTaskWorktree(
        "task-idempotent-sync",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-idempotent-sync",
        objective: "验证重复变化同步不会重跑固定检查",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-idempotent-sync"), "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);

      await writeFile(join(worktreeRoot, path), "export const value = 'first';\n", "utf8");
      await syncWorktreeChanges(store, task, "edit", evidence);
      const firstHash = await hashWorktree(worktreeRoot);
      const check = checkEvidence({
        id: "game-test",
        worktreeHash: firstHash,
        status: "passed",
        durationMs: 1,
        logPath: join(store.taskDir(task.id), "checks", "game-test.log"),
        savedAt: new Date().toISOString(),
      });
      const savedCheck = await evidence.capture(check);
      const revisionAfterCheck = evidence.revision;

      await syncWorktreeChanges(store, task, "verify", evidence);
      assert.equal(evidence.revision, revisionAfterCheck);
      assert.equal((await evidence.get(savedCheck.record.id))?.status, "active");
      assert.ok(check.actionKey);
      assert.ok(await evidence.findReusable(check.actionKey, firstHash));

      const proposal = await evidence.capture(claimEvidence({
        status: "proposed",
        summary: "修改同步方案",
        risk: "无",
        links: [savedCheck.record.id],
      }));

      // 路径集合没有变化，但文件内容和完整 worktree Hash 已改变；旧检查必须失效。
      await writeFile(join(worktreeRoot, path), "export const value = 'second';\n", "utf8");
      const secondHash = await hashWorktree(worktreeRoot);
      assert.notEqual(secondHash, firstHash);
      await syncWorktreeChanges(store, task, "write", evidence);
      assert.equal((await evidence.get(savedCheck.record.id))?.status, "stale");
      assert.equal(await evidence.findReusable(check.actionKey, firstHash), null);
      const secondChange = (await evidence.active("change")).find(
        (record) => record.worktreeHash === secondHash,
      );
      assert.ok(secondChange);
      assert.deepEqual(secondChange.links, [proposal.record.id]);
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

  it("Pi 原生编辑会登记真实 worktree 增量并使旧验证失效", async () => {
    const path = "game/src/presentation/native-edit.ts";
    const repository = await createTemporaryGitRepository({
      [path]: "export const value = 'before';\n",
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      worktreeRoot = await createTaskWorktree(
        "task-native-edit",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-native-edit",
        objective: "验证 Pi 原生编辑同步",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-native-edit"), "pi"),
      });
      await store.transition(task, "active");

      // 直接写文件模拟 Pi 原生 edit/write；它不经过维护器 patch 工具。
      await writeFile(join(worktreeRoot, path), "export const value = 'native';\n", "utf8");
      assert.deepEqual(await syncWorktreeChanges(store, task, "edit"), [path]);
      assert.deepEqual(task.changedPaths, [path]);
      assert.equal(
        await readTestFile(join(repository.repoRoot, path)),
        "export const value = 'before';\n",
      );

      task.verification = {
        worktreeHash: await hashWorktree(worktreeRoot),
        checkIds: [],
        reproductionId: null,
        replayPassed: true,
        verifiedAt: new Date().toISOString(),
      };
      await store.transition(task, "verifying");
      await store.transition(task, "ready_to_apply");
      await writeFile(join(worktreeRoot, path), "export const value = 'changed-again';\n", "utf8");
      await syncWorktreeChanges(store, task, "write");
      assert.equal(task.state, "active");
      assert.equal(task.verification, null);
      assert.deepEqual(task.changedPaths, [path]);
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
        sourceBranch: "main",
        sourceDirtyFiles: 0,
        sourceSnapshotHash: await hashWorktree(repository.repoRoot),
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-apply"), "pi"),
      });
      await store.transition(task, "active");
      const sourceSnapshotHash = task.sourceSnapshotHash;
      task.sourceSnapshotHash = null;
      await assert.rejects(
        capturePatch(task, store.taskDir(task.id)),
        /缺少来源工作树快照/u,
      );
      task.sourceSnapshotHash = sourceSnapshotHash;
      await store.approveWriteScope(task, [path], "scope-task-apply");
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
        sourceBranch: "main",
        sourceDirtyFiles: 0,
        sourceSnapshotHash: await hashWorktree(repository.repoRoot),
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-drift"), "pi"),
      });
      await store.transition(task, "active");
      await assert.rejects(applyTaskPatch(task), /尚未完成验证/u);
      await store.approveWriteScope(task, [path], "scope-task-drift");

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
      await assert.rejects(applyTaskPatch(task), /来源工作树已偏离任务启动快照/u);
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
        schemaVersion: 4,
        id: "task-discard",
        displayName: "丢弃测试",
        objective: "discard",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        sourceBranch: "main",
        sourceDirtyFiles: 0,
        sourceSnapshotHash: null,
        worktreeRoot,
        piSessionDir: join(taskDir, "pi"),
        modelProfileId: "default",
        thinkingLevel: "off",
        writeScope: {
          state: "unapproved",
          allowedPaths: [path],
          digest: null,
          approvedAt: null,
          closedAt: null,
        },
        state: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        changedPaths: [path],
        patchLines: 2,
        baseHashes: {},
        verification: null,
        approval: null,
        patchPath: null,
        reversePatchPath: null,
        appliedHashes: {},
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

  it("脏来源树成为隔离基线，apply 只写回 Agent 增量", async () => {
    const existingPath = "game/src/presentation/status.ts";
    const untrackedPath = "game/src/presentation/local.ts";
    const repository = await createTemporaryGitRepository({
      [existingPath]: "export const status = 'committed';\n",
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      await writeFile(join(repository.repoRoot, existingPath), "export const status = 'local';\n", "utf8");
      await writeFile(join(repository.repoRoot, untrackedPath), "export const local = true;\n", "utf8");
      const snapshot = await createTaskWorktreeSnapshot(
        "task-dirty-source",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      worktreeRoot = snapshot.root;
      assert.equal(snapshot.sourceDirtyFiles, 2);
      assert.equal(
        await readTestFile(join(worktreeRoot, existingPath)),
        "export const status = 'local';\n",
      );
      assert.equal(
        await readTestFile(join(worktreeRoot, untrackedPath)),
        "export const local = true;\n",
      );
      assert.equal(await runTestGit(worktreeRoot, ["diff", "--name-only"]), "");

      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-dirty-source",
        objective: "在本地修改基础上继续修复",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        sourceBranch: snapshot.sourceBranch,
        sourceDirtyFiles: snapshot.sourceDirtyFiles,
        sourceSnapshotHash: snapshot.sourceSnapshotHash,
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-dirty-source"), "pi"),
      });
      await store.transition(task, "active");
      await store.approveWriteScope(
        task,
        [existingPath, untrackedPath],
        "scope-task-dirty-source",
      );
      await applyPrecisePatch({
        task,
        store,
        confirmCore: async () => {
          throw new Error("presentation 路径不应请求核心审批");
        },
        beforePatch: async () => undefined,
        afterPatch: async () => undefined,
      }, { edits: [
        {
          path: existingPath,
          baseHash: await hashFile(worktreeRoot, existingPath),
          oldText: "export const status = 'local';",
          newText: "export const status = 'agent';",
        },
        {
          path: untrackedPath,
          baseHash: await hashFile(worktreeRoot, untrackedPath),
          oldText: "export const local = true;",
          newText: "export const local = false;",
        },
      ] });
      const captured = await capturePatch(task, store.taskDir(task.id));
      assert.deepEqual(captured.paths.sort(), [existingPath, untrackedPath].sort());
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
      await applyTaskPatch(task);
      assert.equal(
        await readTestFile(join(repository.repoRoot, existingPath)),
        "export const status = 'agent';\n",
      );
      assert.equal(
        await readTestFile(join(repository.repoRoot, untrackedPath)),
        "export const local = false;\n",
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
