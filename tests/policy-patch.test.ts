import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TaskStore } from "../src/task/store.js";
import { hashFile } from "../src/workspace/git.js";
import {
  applyPrecisePatch,
  isCorePath,
} from "../src/workspace/patch.js";
import {
  classifyPath,
  decidePatch,
  normalizeProjectPath,
  resolveProjectPath,
} from "../src/workspace/policy.js";
import {
  createTaskWorktree,
  removeTaskWorktree,
} from "../src/workspace/worktree.js";
import {
  createTemporaryGitRepository,
  readTestFile,
} from "./testSupport.js";

describe("项目路径和真实路径边界", () => {
  it("拒绝绝对路径、父目录、生成目录、凭据和法律文件写入", () => {
    assert.equal(normalizeProjectPath("./game/src/view.ts"), "game/src/view.ts");
    assert.throws(() => normalizeProjectPath("../outside.ts"), /不得离开/u);
    assert.throws(() => normalizeProjectPath("C:/outside.ts"), /项目相对路径/u);
    assert.equal(classifyPath("game/node_modules/pkg/index.js", "read"), "denied");
    assert.equal(classifyPath(".env", "write"), "denied");
    assert.equal(classifyPath("LICENSE", "write"), "denied");
    assert.equal(classifyPath("game/src/presentation/view.ts", "write"), "auto");
    assert.equal(classifyPath("game/src/domain/session.ts", "write"), "core");
    assert.equal(isCorePath("game/src/devtools/dungeon-agent/bridge.ts"), true);
    assert.deepEqual(decidePatch(["game/tests/view.test.ts"]).kind, "allow");
  });

  it("realpath 检查阻止仓库内 junction 指向仓库外", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const outside = join(repository.temporaryRoot, "outside");
      const linked = join(repository.repoRoot, "game", "src", "linked");
      await mkdir(outside, { recursive: true });
      await mkdir(join(repository.repoRoot, "game", "src"), { recursive: true });
      await writeFile(join(outside, "external.ts"), "export const value = 1;\n", "utf8");
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        resolveProjectPath(repository.repoRoot, "game/src/linked/external.ts", "read"),
        /符号链接离开项目/u,
      );
    } finally {
      await repository.dispose();
    }
  });
});

describe("baseHash 精确补丁与一次性核心审批", () => {
  it("拒绝审批时不写任何字节，批准后只修改 detached worktree", async () => {
    const repository = await createTemporaryGitRepository({
      "game/src/domain/core.ts": "export const coreValue = 1;\n",
      "game/src/presentation/view.ts": "export const viewValue = 1;\n",
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      worktreeRoot = await createTaskWorktree(
        "task-patch",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-patch",
        objective: "修改核心值",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-patch"), "pi"),
      });
      await store.transition(task, "active");
      const path = "game/src/domain/core.ts";
      const baseHash = await hashFile(worktreeRoot, path);
      let checkpointCalls = 0;
      let replayCalls = 0;
      const edit = {
        path,
        baseHash,
        oldText: "export const coreValue = 1;",
        newText: "export const coreValue = 2;",
      };

      await assert.rejects(applyPrecisePatch({
        task,
        store,
        confirmCore: async () => false,
        beforePatch: async () => { checkpointCalls += 1; },
        afterPatch: async () => { replayCalls += 1; },
      }, { edits: [edit] }), /用户拒绝/u);
      assert.equal(
        await readTestFile(join(worktreeRoot, path)),
        "export const coreValue = 1;\n",
      );
      assert.equal(checkpointCalls, 0);
      assert.equal(replayCalls, 0);

      const result = await applyPrecisePatch({
        task,
        store,
        confirmCore: async (paths, changedLines) => {
          assert.deepEqual(paths, [path]);
          assert.equal(changedLines, 2);
          return true;
        },
        beforePatch: async () => { checkpointCalls += 1; },
        afterPatch: async () => { replayCalls += 1; },
      }, { edits: [edit] });

      assert.deepEqual(result.paths, [path]);
      assert.equal(checkpointCalls, 1);
      assert.equal(replayCalls, 1);
      assert.ok(task.approval?.usedAt);
      assert.equal(
        await readTestFile(join(worktreeRoot, path)),
        "export const coreValue = 2;\n",
      );
      assert.equal(
        await readTestFile(join(repository.repoRoot, path)),
        "export const coreValue = 1;\n",
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

  it("在任何写入前拒绝 Hash 冲突、重复匹配和补丁预算超限", async () => {
    const repository = await createTemporaryGitRepository({
      "game/src/presentation/view.ts": [
        "export const duplicated = 1;",
        "export const duplicated = 1;",
        "",
      ].join("\n"),
    });
    const dataDir = join(repository.temporaryRoot, "data");
    const worktreesDir = join(dataDir, "worktrees");
    let worktreeRoot: string | null = null;
    try {
      worktreeRoot = await createTaskWorktree(
        "task-conflict",
        repository.repoRoot,
        repository.baseHead,
        worktreesDir,
      );
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-conflict",
        objective: "测试冲突",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot,
        piSessionDir: join(store.taskDir("task-conflict"), "pi"),
      });
      await store.transition(task, "active");
      let beforePatchCalled = false;
      const context = {
        task,
        store,
        confirmCore: async () => true,
        beforePatch: async () => { beforePatchCalled = true; },
        afterPatch: async () => undefined,
      };
      const path = "game/src/presentation/view.ts";

      await assert.rejects(applyPrecisePatch(context, { edits: [{
        path,
        baseHash: "0".repeat(64),
        oldText: "export const duplicated = 1;",
        newText: "export const duplicated = 2;",
      }] }), /baseHash 冲突/u);

      const baseHash = await hashFile(worktreeRoot, path);
      await assert.rejects(applyPrecisePatch(context, { edits: [{
        path,
        baseHash,
        oldText: "export const duplicated = 1;",
        newText: "export const duplicated = 2;",
      }] }), /唯一匹配/u);

      await assert.rejects(applyPrecisePatch(context, { edits: [{
        path: "game/src/presentation/large.ts",
        baseHash: "missing",
        oldText: "",
        newText: Array.from(
          { length: 121 },
          (_, index) => "line-" + String(index),
        ).join("\n"),
      }] }), /PATCH_BUDGET_EXCEEDED/u);
      assert.equal(beforePatchCalled, false);
      assert.equal(await readFile(join(worktreeRoot, path), "utf8"), [
        "export const duplicated = 1;",
        "export const duplicated = 1;",
        "",
      ].join("\n"));
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
