import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readEvalDataset } from "../../src/eval/domain/dataset.js";
import { readEvalScenario } from "../../src/eval/domain/scenario.js";
import { writeFakeGameAdapter } from "./gameAdapterFixture.js";

describe("当前游戏 Benchmark catalog", () => {
  it("只从 Adapter v2 读取当前案例和隐藏 runner 描述", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-game-adapter-"));
    try {
      await writeFakeGameAdapter(root);
      const dataset = await readEvalDataset(root);
      assert.equal(dataset.id, "game-current");
      assert.deepEqual(dataset.scenarioIds, ["terminal-action-bug"]);
      assert.equal(dataset.fingerprint, "b".repeat(64));

      const scenario = await readEvalScenario({
        scenarioId: "terminal-action-bug",
        gameRepoRoot: root,
      });
      assert.equal(scenario.publicCase.startPreset, "f1-admin-boss");
      assert.equal(scenario.reproduction.steps.length, 2);
      assert.equal(scenario.expected.afterOracle, "terminal-action-available");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
