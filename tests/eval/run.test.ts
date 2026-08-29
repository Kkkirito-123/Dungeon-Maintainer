import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyEvalFailure,
  evalExternalCorrectnessPassed,
  evalOracleOutcome,
} from "../../src/eval/execution/run.js";

describe("Eval 功能判定", () => {
  it("只在故障已物化、Agent 正常结束且 after Oracle 命中时通过", () => {
    assert.equal(evalExternalCorrectnessPassed({
      sourcePatchMaterialized: true,
      agentSettled: true,
      afterOracleMatched: true,
    }), true);
    assert.equal(evalExternalCorrectnessPassed({
      sourcePatchMaterialized: true,
      agentSettled: false,
      afterOracleMatched: true,
    }), false);
    assert.equal(evalExternalCorrectnessPassed({
      sourcePatchMaterialized: true,
      agentSettled: true,
      afterOracleMatched: false,
    }), false);
  });

  it("Maintainer 工作流状态不参与功能成绩", () => {
    assert.equal(evalOracleOutcome({
      infrastructureFailure: false,
      externalCorrectnessPassed: true,
      workflowClosurePassed: false,
    }).status, "passed");
  });

  it("区分 Agent 未结束、功能未恢复和基础设施错误", () => {
    assert.equal(classifyEvalFailure({ status: "failed", agentSettled: false }), "agent");
    assert.equal(classifyEvalFailure({ status: "failed", agentSettled: true }), "oracle");
    assert.equal(classifyEvalFailure({ status: "infra_error", agentSettled: true }), "infrastructure");
  });
});
