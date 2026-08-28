import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readEvalDataset } from "../../src/eval/domain/dataset.js";
import { readEvalScenario } from "../../src/eval/domain/scenario.js";

describe("EvalDataset", () => {
  it("eval-v1 固定包含七个可独立读取的场景", async () => {
    const dataset = await readEvalDataset();
    assert.equal(dataset.id, "eval-v1");
    assert.equal(dataset.scenarioIds.length, 7);
    assert.match(dataset.fingerprint, /^[0-9a-f]{64}$/u);
    for (const scenarioId of dataset.scenarioIds) {
      const scenario = await readEvalScenario({ scenarioId, datasetRoot: dataset.root });
      assert.equal(scenario.publicCase.scenarioId, scenarioId);
      assert.equal(scenario.reproduction.scenarioId, scenarioId);
      assert.equal(scenario.expected.scenarioId, scenarioId);
    }
  });
});
