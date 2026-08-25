import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyAgentEvalPlan,
  matchesAfterOracle,
  matchesBeforeOracle,
  type AgentEvalOracleObservation,
} from "../src/benchmark/agent-eval-oracle.js";
import type { PlayJudge, PlayView } from "../src/game/protocol.js";

function view(overrides: Partial<PlayView> = {}): PlayView {
  return {
    floor: 1,
    mode: "explore",
    hp: { current: 2, max: 2, armor: 0 },
    progress: { lessons: 0, rooms: 0, moves: 0, queries: 0, hintLevel: 0 },
    actions: [],
    room: "start",
    mission: { title: "任务", body: "", lesson: "SELECT" },
    record: null,
    terminal: null,
    prompt: "",
    banner: "",
    ...overrides,
  };
}

function judge(overrides: Partial<PlayJudge> = {}): PlayJudge {
  return {
    floor: 1,
    mode: "explore",
    lessons: 0,
    requiredLessons: 2,
    bossDefeated: false,
    migrationSteps: 0,
    migrationComplete: false,
    advanced: false,
    ...overrides,
  };
}

function observation(
  overrides: Partial<AgentEvalOracleObservation> = {},
): AgentEvalOracleObservation {
  return {
    stepIndex: 0,
    op: "wait",
    isFinal: true,
    reloadObserved: false,
    ok: true,
    event: "waited",
    planClass: "none",
    view: view(),
    judge: judge(),
    ...overrides,
  };
}

describe("Agent Eval 精确 Oracle", () => {
  it("楼层推进只按最终稳定态判分，不把正常中间态当成死锁", () => {
    const transient = observation({
      isFinal: false,
      judge: judge({ bossDefeated: true, advanced: false }),
    });
    const advanced = observation({
      stepIndex: 1,
      view: view({ floor: 2 }),
      judge: judge({ bossDefeated: true, advanced: true }),
    });
    assert.equal(matchesBeforeOracle("floor-transition-stuck", [transient, advanced]), false);
    assert.equal(matchesAfterOracle("floor-advanced", [transient, advanced]), true);

    const stuck = observation({ judge: judge({ bossDefeated: true, advanced: false }) });
    assert.equal(matchesBeforeOracle("floor-transition-stuck", [stuck]), true);
    assert.equal(matchesAfterOracle("floor-advanced", [stuck]), false);
  });

  it("transition reload 案例必须实际经过 reload", () => {
    const lostWithoutReload = observation({
      view: view({ mode: "explore" }),
      judge: judge({ advanced: false }),
    });
    assert.equal(matchesBeforeOracle("transition-lost", [lostWithoutReload]), false);

    const lostAfterReload = observation({ ...lostWithoutReload, reloadObserved: true });
    assert.equal(matchesBeforeOracle("transition-lost", [lostAfterReload]), true);
    assert.equal(matchesAfterOracle("transition-restored", [lostAfterReload]), false);

    const restored = observation({
      reloadObserved: true,
      view: view({ mode: "transition" }),
      judge: judge({ mode: "transition" }),
    });
    assert.equal(matchesAfterOracle("transition-restored", [restored]), true);
  });

  it("事务隔离精确比较两次 query 的数量、顺序和结果", () => {
    const accepted = observation({ op: "query", event: "query-accepted" });
    const rejected = observation({ stepIndex: 1, op: "query", event: "query-rejected" });
    assert.equal(matchesBeforeOracle("sandbox-state-leaked", [accepted, rejected]), true);
    assert.equal(matchesBeforeOracle("sandbox-state-leaked", [rejected, accepted]), false);
    assert.equal(matchesAfterOracle("sandbox-isolated", [accepted, accepted]), true);
    assert.equal(matchesAfterOracle("sandbox-isolated", [accepted, accepted, accepted]), false);
  });

  it("计划 Oracle 只读取 query 后的 SCAN/SEARCH 分类", () => {
    const scanView = view({ terminal: {
      kind: "combat", title: "SELECT", objective: "", lessonId: "select",
      stageId: "select-1", stageIndex: 0, task: null, schema: [], locks: [], hints: [],
      inputSql: "", status: { kind: "success", text: "" }, result: "", plan: ["SCAN monsters"],
    } });
    const scanTerminal = scanView.terminal;
    assert.ok(scanTerminal);
    const searchView = view({ terminal: { ...scanTerminal, plan: ["SEARCH monsters USING INDEX idx"] } });
    assert.equal(classifyAgentEvalPlan(scanView), "scan");
    assert.equal(classifyAgentEvalPlan(searchView), "search");
    assert.equal(matchesBeforeOracle("stale-query-plan", [
      observation({ op: "query", planClass: "scan", view: scanView }),
    ]), true);
    assert.equal(matchesAfterOracle("query-plan-current", [
      observation({ op: "query", planClass: "search", view: searchView }),
    ]), true);
    assert.equal(matchesAfterOracle("query-plan-current", [
      observation({ op: "wait", planClass: "search", view: searchView }),
    ]), false);
    assert.equal(matchesBeforeOracle("stale-query-plan", [
      observation({ op: "query", event: "query-rejected", planClass: "none" }),
    ]), true);
    assert.equal(matchesAfterOracle("query-plan-current", [
      observation({ op: "query", event: "query-accepted", planClass: "none" }),
    ]), true);
  });
});
