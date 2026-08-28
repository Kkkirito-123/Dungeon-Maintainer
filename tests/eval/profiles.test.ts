import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PI_BASELINE_SOURCE,
  verifyPiBaselineSource,
} from "../../src/eval/profiles/profile.js";
import { buildPiBaselineArguments } from "../../src/eval/profiles/pi-baseline.js";
import {
  classifyMaintainerRunStatus,
  evalSettledDecision,
} from "../../src/eval/profiles/maintainer.js";
import { requestWithDeadline } from "../../src/eval/profiles/rpc-deadline.js";
import { buildMaintainerWorkflowClosure } from "../../src/eval/domain/result.js";

describe("Pi Eval baseline 来源", () => {
  it("固定官方 v0.84.2 commit，并校验本地真实执行包", async () => {
    const source = await verifyPiBaselineSource(process.cwd());
    assert.deepEqual(
      {
        repository: source.repository,
        tag: source.tag,
        commit: source.commit,
        packageName: source.packageName,
        packageVersion: source.packageVersion,
        packageIntegrity: source.packageIntegrity,
      },
      PI_BASELINE_SOURCE,
    );
    assert.match(source.cliHash, /^[a-f0-9]{64}$/u);
  });

  it("Pi Baseline 只加载固定原生工具和独立 Provider", () => {
    const args = buildPiBaselineArguments({
      runId: "run-id",
      sessionDirectory: "session",
      model: "model",
    });
    assert.equal(args.includes("read,bash,edit,write"), true);
    assert.equal(args.includes("dungeon-eval-baseline"), true);
    assert.equal(args.includes("--no-extensions"), true);
  });

  it("Maintainer settled 分类不再依赖无效 queueActive 或固定延迟", () => {
    assert.deepEqual(evalSettledDecision({ taskState: "ready_to_apply" }), { failureCode: null });
    assert.deepEqual(evalSettledDecision({ taskState: "paused" }), { failureCode: "maintainer-paused" });
    assert.equal(classifyMaintainerRunStatus({ completed: true, failureCode: "maintainer-paused" }), "settled");
  });

  it("区分写入尝试、真实 mutation 和最终保留变更", () => {
    const result = buildMaintainerWorkflowClosure({
      taskState: "active",
      proposed: true,
      writeAttempts: 2,
      writeMutations: 1,
      changedPathCount: 0,
      replayPassed: false,
      readyToApply: false,
      paused: false,
    });
    assert.equal(result.writeAttempted, true);
    assert.equal(result.executed, true);
    assert.equal(result.retainedChanges, false);
  });

  it("RPC deadline 在失败或超时时返回显式 fallback", async () => {
    assert.equal(await requestWithDeadline(async () => { throw new Error("x"); }, 50, "fallback"), "fallback");
    assert.equal(await requestWithDeadline(async () => await new Promise<string>(() => undefined), 10, "timeout"), "timeout");
  });
});
