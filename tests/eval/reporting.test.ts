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
import {
  summarizeEvalSuiteRuns,
  summarizeEvalUsage,
} from "../../src/eval/reporting/report.js";
import type { EvalRunResult } from "../../src/eval/execution/run.js";

function checkpointRun(scenarioId: string, runFingerprint: string): EvalRunResult {
  return {
    schemaVersion: 7,
    runId: "run-" + scenarioId,
    scenarioId,
    profile: "maintainer",
    repetition: 1,
    status: "passed",
    agentResult: {
      status: "settled",
      totalTokens: 1,
      toolCalls: 1,
      durationMs: 2,
      totalDurationMs: 3,
      diagnosisMs: 1,
      inspectCalls: 1,
      inspectExecutions: 1,
      inspectReceiptHits: 0,
      readCalls: 1,
    },
    externalCorrectness: {
      sourcePatchMaterialized: true,
      agentSettled: true,
      afterOracleMatched: true,
    },
    workflowClosure: { paused: false },
    oracleOutcome: {
      status: "passed",
      externalCorrectnessPassed: true,
      workflowClosurePassed: true,
      actionCount: 2,
      browserErrorCount: 0,
      durationMs: 1,
    },
    identity: { runFingerprint },
  } as EvalRunResult;
}

describe("Eval reporting", () => {
  it("精确汇总 Agent、Oracle、工具调用和时间", () => {
    const results = [
      {
        agentResult: {
          totalTokens: 101,
          toolCalls: 7,
          durationMs: 1_200,
          totalDurationMs: 1_500,
        },
        oracleOutcome: { durationMs: 13 },
      },
      {
        agentResult: {
          totalTokens: 202,
          toolCalls: 9,
          durationMs: 2_300,
          totalDurationMs: 2_900,
        },
        oracleOutcome: { durationMs: 17 },
      },
    ] as EvalRunResult[];

    assert.deepEqual(summarizeEvalUsage(results, 3_456.7), {
      agentTokens: 303,
      totalTokens: 303,
      toolCalls: 16,
      sumAgentDurationMs: 3_500,
      sumOracleDurationMs: 30,
      sumRunDurationMs: 4_400,
      suiteWallDurationMs: 3_457,
    });
  });

  it("按功能结果和 Agent 收尾分别汇总", () => {
    const summary = summarizeEvalSuiteRuns({
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
        scenarioIds: ["first", "second"],
      }), true);
      assert.equal(evalSuiteCheckpointIsCompatible({
        ...checkpoint,
        results: [
          { ...checkpoint.results[0], oracleOutcome: undefined },
          checkpoint.results[1],
        ],
      }, {
        runFingerprint: checkpoint.runFingerprint,
        datasetId: "eval-v1",
        profile: "maintainer",
        repetitions: 1,
        expectedRuns: 2,
        scenarioIds: ["first", "second"],
      }), false);
      assert.deepEqual(read?.results.map((result) => result.scenarioId), ["first", "second"]);
      assert.equal((await readFile(join(root, "checkpoint.json"), "utf8")).endsWith("\n"), true);
      assert.equal(evalSuiteCheckpointIsCompatible(read, {
        runFingerprint: checkpoint.runFingerprint,
        datasetId: "eval-v2",
        profile: "maintainer",
        repetitions: 1,
        expectedRuns: 2,
        scenarioIds: ["first", "second"],
      }), false);

      const expected = {
        runFingerprint: checkpoint.runFingerprint,
        datasetId: "eval-v1",
        profile: "maintainer" as const,
        repetitions: 1,
        expectedRuns: 2,
        scenarioIds: ["first", "second"],
      };
      assert.equal(evalSuiteCheckpointIsCompatible({
        ...checkpoint,
        results: [checkpoint.results[0], checkpoint.results[0]],
      }, expected), false);
      assert.equal(evalSuiteCheckpointIsCompatible({
        ...checkpoint,
        results: [checkpoint.results[0]],
        runFailures: [{ scenarioId: "first", profile: "maintainer", repetition: 1, code: "infra" }],
      }, expected), false);
      assert.equal(evalSuiteCheckpointIsCompatible({
        ...checkpoint,
        results: [{ ...checkpoint.results[0], scenarioId: "outside" }, checkpoint.results[1]],
      }, expected), false);
      assert.equal(evalSuiteCheckpointIsCompatible({
        ...checkpoint,
        results: [{ ...checkpoint.results[0], repetition: 2 }, checkpoint.results[1]],
      }, expected), false);
      assert.equal(evalSuiteCheckpointIsCompatible({
        ...checkpoint,
        results: [{ ...checkpoint.results[0], identity: null }, checkpoint.results[1]],
      }, expected), false);
      assert.equal(evalSuiteCheckpointIsCompatible({
        ...checkpoint,
        results: [{ ...checkpoint.results[0], runId: "" }, checkpoint.results[1]],
      }, expected), false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
