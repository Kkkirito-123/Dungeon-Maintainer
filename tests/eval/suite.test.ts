import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evalSuiteProfiles,
  normalizeEvalWorkers,
  runEvalWorkerPool,
} from "../../src/eval/execution/suite.js";

describe("EvalSuite Worker", () => {
  it("只接受 1 至 4 Worker，并保持 Profile 命名和交替顺序", () => {
    assert.equal(normalizeEvalWorkers(undefined, 2), 2);
    assert.throws(() => normalizeEvalWorkers(0, 2), /1 至 4/u);
    assert.throws(() => normalizeEvalWorkers(5, 2), /1 至 4/u);
    assert.deepEqual(evalSuiteProfiles("maintainer", 0), ["maintainer"]);
    assert.deepEqual(evalSuiteProfiles("both", 0), ["maintainer", "pi-baseline"]);
    assert.deepEqual(evalSuiteProfiles("both", 1), ["pi-baseline", "maintainer"]);
  });

  for (const workers of [1, 2, 4]) {
    it(String(workers) + " Worker 完成结果一致且按输入顺序返回", async () => {
      const completed: number[] = [];
      const results = await runEvalWorkerPool([0, 1, 2, 3, 4, 5], workers, async (value) => {
        await new Promise<void>((resolve) => setTimeout(resolve, (5 - value) * 2));
        completed.push(value);
        return value * 10;
      });
      assert.deepEqual(results.map((entry) => entry.status === "fulfilled" ? entry.value : null), [0, 10, 20, 30, 40, 50]);
      if (workers > 1) assert.notDeepEqual(completed, [0, 1, 2, 3, 4, 5]);
    });
  }

  it("单个 Job 失败不取消其它 Job", async () => {
    const visited: number[] = [];
    const results = await runEvalWorkerPool([1, 2, 3], 2, async (value) => {
      visited.push(value);
      if (value === 2) throw new Error("expected");
      return value;
    });
    assert.deepEqual([...visited].sort(), [1, 2, 3]);
    assert.deepEqual(results.map((entry) => entry.status), ["fulfilled", "rejected", "fulfilled"]);
  });
});
