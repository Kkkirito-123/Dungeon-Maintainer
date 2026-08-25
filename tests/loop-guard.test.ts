import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoopGuard, stableDigest, type LoopAction } from "../src/pi/loop-guard.js";

function action(name: string, input: unknown = { path: "src/game.ts" }): LoopAction {
  return { toolName: "inspect", input, route: name };
}

function recordWithoutEvidence(
  guard: LoopGuard,
  nextAction: LoopAction,
  result: unknown = { matches: ["src/game.ts:10"] },
): void {
  assert.equal(guard.evaluateAction(nextAction).kind, "allow");
  assert.equal(guard.recordOutcome({
    action: nextAction,
    result,
    evidenceRevision: 0,
  }), false);
}

describe("领域化循环门禁", () => {
  it("对象键顺序不影响稳定 SHA-256 摘要", () => {
    const left = stableDigest({ query: "state", scope: { path: "src", depth: 2 } });
    const right = stableDigest({ scope: { depth: 2, path: "src" }, query: "state" });
    assert.equal(left, right);
    assert.match(left, /^[a-f0-9]{64}$/u);
  });

  it("在相同动作和结果第三次执行前阻止且不增加计数", () => {
    const guard = new LoopGuard();
    const inspectState = action("inspect-state");
    recordWithoutEvidence(guard, inspectState);
    recordWithoutEvidence(guard, inspectState);

    const countBeforeBlock = guard.noProgressCount;
    const outcomesBeforeBlock = guard.recentOutcomes.length;
    assert.deepEqual(guard.evaluateAction(inspectState), {
      kind: "block",
      reason: "exact_action_result",
      noProgressCount: 2,
    });
    assert.equal(guard.noProgressCount, countBeforeBlock);
    assert.equal(guard.recentOutcomes.length, outcomesBeforeBlock);
    assert.equal(guard.evaluateAction(inspectState).kind, "block");
  });

  it("在尝试形成 A-B-A-B 的第四步前冻结两条路线", () => {
    const guard = new LoopGuard();
    const routeA = action("route-a", { query: "state" });
    const routeB = action("route-b", { path: "src/game.ts" });
    recordWithoutEvidence(guard, routeA, { result: "A" });
    recordWithoutEvidence(guard, routeB, { result: "B" });
    recordWithoutEvidence(guard, routeA, { result: "A2" });

    assert.deepEqual(guard.evaluateAction(routeB), {
      kind: "block",
      reason: "alternating_route",
      noProgressCount: 3,
    });
    assert.equal(guard.recentOutcomes.length, 3);
    assert.equal(guard.evaluateAction(routeA).kind, "block");
    assert.equal(guard.evaluateAction(routeB).kind, "block");
  });

  it("五次无进展只触发一次策略重置，八次无进展进入硬停止", () => {
    const guard = new LoopGuard();
    for (let index = 0; index < 5; index += 1) {
      const suffix = String(index);
      recordWithoutEvidence(
        guard,
        action(`route-${suffix}`, { query: `query-${suffix}` }),
        { result: index },
      );
    }

    const sixth = action("route-5", { query: "query-5" });
    assert.deepEqual(guard.evaluateAction(sixth), {
      kind: "strategy_reset",
      reason: "no_progress",
      noProgressCount: 5,
    });
    assert.equal(guard.noProgressCount, 5);
    assert.equal(guard.recentOutcomes.length, 5);
    recordWithoutEvidence(guard, sixth, { result: 5 });
    recordWithoutEvidence(guard, action("route-6", { query: "query-6" }), { result: 6 });
    recordWithoutEvidence(guard, action("route-7", { query: "query-7" }), { result: 7 });

    assert.deepEqual(guard.evaluateAction(action("route-8", { query: "query-8" })), {
      kind: "hard_stop",
      reason: "no_progress",
      noProgressCount: 8,
    });
    assert.equal(guard.noProgressCount, 8);
    assert.equal(guard.recentOutcomes.length, 8);
  });

  it("EvidenceStore revision 与显式进展会清零次数并解除冻结", () => {
    const guard = new LoopGuard();
    const repeated = action("repeated");
    recordWithoutEvidence(guard, repeated);
    recordWithoutEvidence(guard, repeated);
    assert.equal(guard.evaluateAction(repeated).kind, "block");

    const progressAction = action("progress", { query: "new-fact" });
    assert.equal(guard.evaluateAction(progressAction).kind, "allow");
    assert.equal(guard.recordOutcome({
      action: progressAction,
      result: { matches: ["src/game.ts:20"] },
      evidenceRevision: 1,
    }), true);
    assert.equal(guard.progressRevision, 1);
    assert.equal(guard.noProgressCount, 0);
    assert.equal(guard.evaluateAction(repeated).kind, "allow");
    assert.equal(guard.recordOutcome({
      action: repeated,
      result: { matches: ["src/game.ts:20"] },
      evidenceRevision: 1,
    }), false);
    assert.equal(guard.progressRevision, 1);
    assert.equal(guard.noProgressCount, 1);
    assert.equal(guard.recordOutcome({
      action: action("same-evidence", { query: "terminal state" }),
      result: { matches: ["src/game.ts:20"] },
      evidenceRevision: 1,
      madeProgress: true,
    }), true);
    assert.equal(guard.progressRevision, 2);
    assert.equal(guard.noProgressCount, 0);
  });

  it("只保留最近八项并能为新任务清空全部状态", () => {
    const guard = new LoopGuard();
    for (let index = 0; index < 5; index += 1) {
      const suffix = String(index);
      recordWithoutEvidence(
        guard,
        action(`first-${suffix}`, { query: `first-${suffix}` }),
        { value: index },
      );
    }
    assert.equal(guard.evaluateAction(action("strategy-reset", { query: "reset" })).kind, "strategy_reset");
    const progress = action("progress-route", { query: "progress" });
    assert.equal(guard.evaluateAction(progress).kind, "allow");
    assert.equal(guard.recordOutcome({
      action: progress,
      result: { value: "progress" },
      evidenceRevision: 1,
    }), true);
    for (let index = 5; index < 10; index += 1) {
      const suffix = String(index);
      recordWithoutEvidence(
        guard,
        action(`first-${suffix}`, { query: `first-${suffix}` }),
        { value: index },
      );
    }
    assert.equal(guard.recentOutcomes.length, 8);

    guard.resetForNewTask();
    assert.equal(guard.progressRevision, 0);
    assert.equal(guard.noProgressCount, 0);
    assert.deepEqual(guard.recentOutcomes, []);
    assert.equal(guard.evaluateAction(action("first-0", { query: "first-0" })).kind, "allow");
  });

  it("新 Episode 清除 hard stop 计数但保留已冻结动作，强制 recover 换路线", () => {
    const guard = new LoopGuard();
    const repeated = { toolName: "inspect", input: { action: "status" } };
    for (let index = 0; index < 2; index += 1) {
      assert.equal(guard.evaluateAction(repeated).kind, "allow");
      guard.recordOutcome({ action: repeated, result: { same: true }, evidenceRevision: 0 });
    }
    assert.equal(guard.evaluateAction(repeated).kind, "block");
    guard.beginEpisode();
    assert.equal(guard.noProgressCount, 0);
    assert.equal(guard.evaluateAction(repeated).kind, "block");
    assert.equal(guard.evaluateAction({
      toolName: "inspect",
      input: { action: "search", query: "different-route" },
    }).kind, "allow");
  });
});
