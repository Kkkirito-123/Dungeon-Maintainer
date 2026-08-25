/**
 * 内置 Agent Eval fixture 物化边界测试。
 *
 * 测试只在系统临时目录构造最小 fixture 并创建真实 Git 仓库，覆盖确定性基线、
 * 补丁结果、路径穿越、已有目标和 manifest 不一致后的回收。它不读写用户游戏
 * 仓库，每个用例都在 `finally` 中删除自己创建的精确临时根目录。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { materializeAgentEvalFixture } from "../src/benchmark/agent-eval-fixture.js";
import { readAgentEvalCase } from "../src/benchmark/agent-eval-case.js";
import { collectProjectContextFingerprint } from "../src/benchmark/provenance.js";
import {
  provisionAgentEvalDependencies,
  releaseAgentEvalDependencies,
} from "../src/benchmark/agent-eval-runner.js";
import { runTestGit } from "./testSupport.js";
import { createTaskWorktreeSnapshot } from "../src/workspace/worktree.js";

const SOURCE = "export const value = 1;\n";
const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

interface FixtureOverrides {
  id?: string;
  baselineFileCount?: number;
  patchSha256?: string;
  dirtyPaths?: string[];
}

async function writeFixture(
  fixtureRoot: string,
  directoryId: string,
  overrides: FixtureOverrides = {},
): Promise<void> {
  const fixtureDirectory = join(fixtureRoot, directoryId);
  await mkdir(join(fixtureDirectory, "repository", "src"), { recursive: true });
  await writeFile(
    join(fixtureDirectory, "repository", "src", "example.ts"),
    SOURCE,
    "utf8",
  );
  await writeFile(join(fixtureDirectory, "source.patch"), PATCH, "utf8");
  await writeFile(join(fixtureDirectory, "fixture.json"), JSON.stringify({
    schemaVersion: 1,
    id: overrides.id ?? directoryId,
    baseCommit: "a".repeat(40),
    baselineFileCount: overrides.baselineFileCount ?? 1,
    repositoryDir: "repository",
    sourcePatch: "source.patch",
    patchSha256: overrides.patchSha256
      ?? createHash("sha256").update(PATCH).digest("hex"),
    dirtyPaths: overrides.dirtyPaths ?? ["src/example.ts"],
  }, null, 2) + "\n", "utf8");
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

async function countFixtureFiles(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.notEqual(entry.name.toLowerCase(), ".git");
    assert.notEqual(entry.name.toLowerCase(), "node_modules");
    if (entry.isDirectory()) count += await countFixtureFiles(join(root, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

describe("Agent Eval fixture materializer", () => {
  it("严格分离 terminal 案例的公开任务、复现动作和隐藏验收", async () => {
    const fixtureRoot = resolve(process.cwd(), "test-fixtures", "agent-evals");
    const testCase = await readAgentEvalCase({
      fixtureRoot,
      id: "terminal-action-bug",
    });
    assert.equal(testCase.publicCase.prompt.includes("不可用"), true);
    assert.deepEqual(testCase.reproduction.steps, [
      { op: "go", target: "objective", maxSteps: 64 },
      { op: "use", actionId: "terminal" },
    ]);
    assert.equal(Object.keys(testCase.expected.secretInputs).length, 0);
    assert.equal(testCase.expected.beforeOracle, "terminal-action-unavailable");
    assert.equal(testCase.expected.afterOracle, "terminal-action-available");
  });

  it("内置 terminal-action-bug 复用 468 文件共享基线且只注入一个脏路径", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "maintainer-agent-eval-real-"));
    try {
      const fixtureRoot = resolve(process.cwd(), "test-fixtures", "agent-evals");
      const repositoryRoot = join(fixtureRoot, "_bases", "game-repair-v1", "repository");
      assert.equal(await countFixtureFiles(repositoryRoot), 468);
      const result = await materializeAgentEvalFixture({
        fixtureRoot,
        id: "terminal-action-bug",
        destination: join(temporaryRoot, "materialized"),
      });
      assert.deepEqual(result.dirtyPaths, [
        "game/src/devtools/dungeon-agent/actions.ts",
      ]);
      assert.match(
        await readFile(
          join(result.destination, "game", "src", "devtools", "dungeon-agent", "actions.ts"),
          "utf8",
        ),
        /terminal: "#open-sql-broken"/u,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("Bug source repo 与 Maintainer detached worktree 的 AGENTS/Skills 指纹一致", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "maintainer-agent-eval-context-"));
    try {
      const source = await materializeAgentEvalFixture({
        fixtureRoot: resolve(process.cwd(), "test-fixtures", "agent-evals"),
        id: "terminal-action-bug",
        destination: join(temporaryRoot, "source"),
      });
      const snapshot = await createTaskWorktreeSnapshot(
        "context-fairness",
        source.destination,
        source.baseCommit,
        join(temporaryRoot, "worktrees"),
      );
      assert.deepEqual(
        await collectProjectContextFingerprint(snapshot.root),
        await collectProjectContextFingerprint(source.destination),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("依赖 lease 只删除本轮 junction，不删除共享 node_modules", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "maintainer-agent-eval-deps-"));
    try {
      const repositoryRoot = join(temporaryRoot, "repository");
      const dependencyRepoRoot = join(temporaryRoot, "dependency-source");
      const source = join(dependencyRepoRoot, "game", "node_modules");
      await mkdir(join(repositoryRoot, "game"), { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "marker.txt"), "shared", "utf8");

      const lease = await provisionAgentEvalDependencies({
        repositoryRoot,
        dependencyRepoRoot,
      });
      assert.equal(await readFile(join(lease.target, "marker.txt"), "utf8"), "shared");
      await releaseAgentEvalDependencies(lease);

      await assertMissing(lease.target);
      assert.equal(await readFile(join(source, "marker.txt"), "utf8"), "shared");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("把 Bug 版本建立为唯一干净 root commit，不暴露正确版本父提交", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "maintainer-agent-eval-"));
    try {
      const fixtureRoot = join(temporaryRoot, "test-fixtures", "agent-evals");
      const destination = join(temporaryRoot, "materialized");
      await writeFixture(fixtureRoot, "sample");

      const result = await materializeAgentEvalFixture({
        fixtureRoot,
        id: "sample",
        destination,
      });

      assert.equal(result.destination, resolve(destination));
      assert.equal(result.baseCommit, await runTestGit(destination, ["rev-parse", "HEAD"]));
      assert.deepEqual(result.dirtyPaths, ["src/example.ts"]);
      assert.equal(
        await readFile(join(destination, "src", "example.ts"), "utf8"),
        "export const value = 2;\n",
      );
      assert.equal(
        await runTestGit(destination, ["show", "HEAD:src/example.ts"]),
        "export const value = 2;",
      );
      assert.equal(await runTestGit(destination, ["status", "--porcelain"]), "");
      assert.equal(await runTestGit(destination, ["rev-list", "--count", "HEAD"]), "1");
      await assert.rejects(runTestGit(destination, ["rev-parse", "HEAD^"]));
      assert.equal(await runTestGit(destination, ["config", "core.autocrlf"]), "false");
      assert.equal(
        await runTestGit(destination, ["config", "user.name"]),
        "Dungeon Maintainer Agent Eval",
      );
      assert.equal(
        await runTestGit(destination, ["config", "user.email"]),
        "agent-eval@dungeon-maintainer.invalid",
      );
      assert.deepEqual(
        (await runTestGit(destination, [
          "show",
          "--no-patch",
          "--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI",
          "HEAD",
        ])).split("\n"),
        [
          "Dungeon Maintainer Agent Eval",
          "agent-eval@dungeon-maintainer.invalid",
          "2000-01-01T00:00:00Z",
          "Dungeon Maintainer Agent Eval",
          "agent-eval@dungeon-maintainer.invalid",
          "2000-01-01T00:00:00Z",
        ],
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("拒绝路径穿越和已存在的目标目录", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "maintainer-agent-eval-"));
    try {
      const fixtureRoot = join(temporaryRoot, "fixtures");
      await writeFixture(fixtureRoot, "sample");
      for (const id of ["../sample", "..\\sample", "C:sample"]) {
        const destination = join(temporaryRoot, "target-" + createHash("sha256").update(id).digest("hex"));
        await assert.rejects(
          materializeAgentEvalFixture({ fixtureRoot, id, destination }),
          /安全的单一目录名/u,
        );
        await assertMissing(destination);
      }

      const existingDestination = join(temporaryRoot, "existing");
      await mkdir(existingDestination);
      await assert.rejects(
        materializeAgentEvalFixture({
          fixtureRoot,
          id: "sample",
          destination: existingDestination,
        }),
        /已存在/u,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("拒绝 manifest 元数据不一致且不留下半成品", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "maintainer-agent-eval-"));
    try {
      const fixtureRoot = join(temporaryRoot, "fixtures");
      await writeFixture(fixtureRoot, "wrong-hash", { patchSha256: "0".repeat(64) });
      const hashDestination = join(temporaryRoot, "hash-target");
      await assert.rejects(
        materializeAgentEvalFixture({
          fixtureRoot,
          id: "wrong-hash",
          destination: hashDestination,
        }),
        /SHA-256/u,
      );
      await assertMissing(hashDestination);

      await writeFixture(fixtureRoot, "wrong-count", { baselineFileCount: 2 });
      const countDestination = join(temporaryRoot, "count-target");
      await assert.rejects(
        materializeAgentEvalFixture({
          fixtureRoot,
          id: "wrong-count",
          destination: countDestination,
        }),
        /文件数/u,
      );
      await assertMissing(countDestination);

      await writeFixture(fixtureRoot, "wrong-dirty", { dirtyPaths: ["src/other.ts"] });
      const dirtyDestination = join(temporaryRoot, "dirty-target");
      await assert.rejects(
        materializeAgentEvalFixture({
          fixtureRoot,
          id: "wrong-dirty",
          destination: dirtyDestination,
        }),
        /dirtyPaths/u,
      );
      await assertMissing(dirtyDestination);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
