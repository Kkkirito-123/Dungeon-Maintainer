import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  evalSuiteCheckpointIsCompatible,
  readEvalSuiteCheckpoint,
  writeEvalSuiteCheckpoint,
} from "../../src/eval/reporting/checkpoint.js";
import { createEvalRunIdentity, evalRunIdentityIsCurrent } from "../../src/eval/reporting/identity.js";
import { summarizeEvalSuiteRuns } from "../../src/eval/reporting/report.js";
import type { EvalRunResult } from "../../src/eval/execution/run.js";

function checkpointRun(scenarioId: string, runFingerprint: string): EvalRunResult {
  return {
    schemaVersion: 5,
    runId: "run-" + scenarioId,
    scenarioId,
    profile: "maintainer",
    repetition: 1,
    status: "passed",
    agentResult: { status: "settled", totalTokens: 1, toolCalls: 1 },
    identity: { runFingerprint },
  } as EvalRunResult;
}

describe("Eval reporting", () => {
  it("按功能结果和 Agent 收尾分别汇总", () => {
    const summary = summarizeEvalSuiteRuns({
      preflightPassed: true,
      expectedRuns: 2,
      results: [
        { profile: "maintainer", status: "passed", agentResult: { status: "settled" }, workflowClosure: { paused: false } },
        { profile: "pi-baseline", status: "failed", agentResult: { status: "timeout" }, workflowClosure: { paused: null } },
      ],
      runFailures: [],
    });
    assert.equal(summary.status, "failed");
    assert.equal(summary.byProfile.maintainer.passed, 1);
    assert.equal(summary.byProfile["pi-baseline"].failed, 1);
    assert.equal(summary.runByProfile["pi-baseline"].timeout, 1);
  });

  it("运行身份由 Dataset 指纹绑定", () => {
    const identity = createEvalRunIdentity({
      evalCommit: "a".repeat(40),
      evalWorktreeHash: "b".repeat(64),
      datasetFingerprint: "c".repeat(64),
      oracleVersion: "oracle-v1",
      modelId: "model",
      modelConfigHash: "d".repeat(64),
    });
    assert.equal(evalRunIdentityIsCurrent(identity), true);
    assert.equal(evalRunIdentityIsCurrent({ ...identity, datasetFingerprint: "e".repeat(64) }), false);
  });

  it("Checkpoint 原子写入、严格匹配并保留固定结果顺序", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-checkpoint-"));
    try {
      const checkpoint = {
        schemaVersion: 3 as const,
        runFingerprint: "a".repeat(64),
        datasetId: "eval-v1",
        profile: "maintainer" as const,
        repetitions: 1,
        expectedRuns: 2,
        results: [
          checkpointRun("first", "a".repeat(64)),
          checkpointRun("second", "a".repeat(64)),
        ],
        runFailures: [],
      };
      await writeEvalSuiteCheckpoint(root, checkpoint);
      const read = await readEvalSuiteCheckpoint(join(root, "checkpoint.json"));
      assert.equal(evalSuiteCheckpointIsCompatible(read, {
        runFingerprint: checkpoint.runFingerprint,
        datasetId: "eval-v1",
        profile: "maintainer",
        repetitions: 1,
        expectedRuns: 2,
      }), true);
      assert.deepEqual(read?.results.map((result) => result.scenarioId), ["first", "second"]);
      assert.equal((await readFile(join(root, "checkpoint.json"), "utf8")).endsWith("\n"), true);
      assert.equal(evalSuiteCheckpointIsCompatible(read, {
        runFingerprint: checkpoint.runFingerprint,
        datasetId: "eval-v2",
        profile: "maintainer",
        repetitions: 1,
        expectedRuns: 2,
      }), false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
