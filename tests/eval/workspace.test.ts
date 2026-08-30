/** 当前游戏 Adapter 物化和依赖 lease 边界。 */

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  provisionEvalDependencies,
  releaseEvalDependencies,
} from "../../src/eval/execution/browser-oracle.js";
import { createEvalWorkspace } from "../../src/eval/execution/workspace.js";
import { writeFakeGameAdapter } from "./gameAdapterFixture.js";

describe("当前游戏 Benchmark materializer", () => {
  it("通过 Adapter v2 在指定新目录物化 broken/clean 仓库", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-game-materialize-"));
    try {
      await writeFakeGameAdapter(root);
      const broken = await createEvalWorkspace({
        gameRepoRoot: root,
        scenarioId: "terminal-action-bug",
        destination: join(root, "broken"),
      });
      assert.equal(broken.root, resolve(root, "broken"));
      assert.equal(broken.baseCommit, "a".repeat(40));
      assert.deepEqual(broken.dirtyPaths, ["game/src/example.ts"]);

      const clean = await createEvalWorkspace({
        gameRepoRoot: root,
        scenarioId: "terminal-action-bug",
        destination: join(root, "clean"),
        variant: "clean",
      });
      assert.deepEqual(clean.dirtyPaths, []);
      assert.equal(clean.sourceFingerprint, broken.sourceFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("依赖 lease 只删除本轮 junction，不删除当前游戏 node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-game-deps-"));
    try {
      const repositoryRoot = join(root, "repository");
      const gameRepoRoot = join(root, "game-source");
      const source = join(gameRepoRoot, "game", "node_modules");
      await mkdir(join(repositoryRoot, "game"), { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "marker.txt"), "shared", "utf8");

      const lease = await provisionEvalDependencies({
        repositoryRoot,
        dependencyRepoRoot: gameRepoRoot,
      });
      assert.equal(await readFile(join(lease.target, "marker.txt"), "utf8"), "shared");
      await releaseEvalDependencies(lease);
      await assert.rejects(access(lease.target));
      assert.equal(await readFile(join(source, "marker.txt"), "utf8"), "shared");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
