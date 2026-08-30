import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { EVAL_ORACLE_VERSION } from "../../src/eval/domain/oracle.js";
import {
  isEvalPreflightCertificateCurrent,
  resolveEvalRunIdentity,
} from "../../src/eval/execution/preflight.js";
import { createEvalRunIdentity } from "../../src/eval/reporting/identity.js";

describe("EvalPreflight certificate", () => {
  it("绑定 Scenario、Bug HEAD、依赖和 Run 身份", () => {
    const input = {
      scenarioId: "terminal-action-bug",
      buggyHead: "a".repeat(40),
      dependencyRepoRoot: "dependency",
      runFingerprint: "b".repeat(64),
    };
    const certificate = {
      schemaVersion: 2,
      scenarioId: input.scenarioId,
      buggyHead: input.buggyHead,
      dependencyKey: createHash("sha256")
        .update(resolve(input.dependencyRepoRoot))
        .digest("hex")
        .slice(0, 16),
      oracleVersion: EVAL_ORACLE_VERSION,
      runFingerprint: input.runFingerprint,
      beforeOracleMatched: true,
      cleanAfterOracleMatched: true,
    };
    assert.equal(isEvalPreflightCertificateCurrent({ ...input, certificate }), true);
    assert.equal(isEvalPreflightCertificateCurrent({
      ...input,
      certificate: { ...certificate, buggyHead: "c".repeat(40) },
    }), false);
    assert.equal(isEvalPreflightCertificateCurrent({ ...input, certificate: null }), false);
  });

  it("拒绝复用其它 Dataset 的运行身份", async () => {
    const identity = createEvalRunIdentity({
      evalCommit: "a".repeat(40),
      evalWorktreeHash: "b".repeat(64),
      datasetFingerprint: "c".repeat(64),
      oracleVersion: EVAL_ORACLE_VERSION,
      modelId: "model",
      modelConfigHash: "d".repeat(64),
    });
    assert.equal(await resolveEvalRunIdentity(identity.datasetFingerprint, identity), identity);
    await assert.rejects(
      resolveEvalRunIdentity("e".repeat(64), identity),
      /eval-run-fingerprint-mismatch/u,
    );
  });
});
