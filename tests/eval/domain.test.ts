import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyEvalOraclePlan,
  matchesAfterOracle,
  matchesBeforeOracle,
  parseEvalOracleAfter,
  parseEvalOracleBefore,
  type EvalOracleObservation,
} from "../../src/eval/domain/oracle.js";
import type { PlayJudge, PlayView } from "../../src/game/protocol.js";

function view(overrides: Partial<PlayView> = {}): PlayView {
  return {
    revision: "00000001",
    floor: 1,
    mode: "explore",
    hp: { current: 2, max: 2, armor: 0 },
    progress: { lessons: 0, rooms: 0, moves: 0, queries: 0, hintLevel: 0 },
    actions: [],
    target: null,
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
  overrides: Partial<EvalOracleObservation> = {},
): EvalOracleObservation {
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

  it("transition reload 案例只使用现行过渡卡住和楼层推进 Oracle", () => {
    const stuck = observation({
      reloadObserved: true,
      view: view({ mode: "transition" }),
      judge: judge({ mode: "transition", advanced: false }),
    });
    assert.equal(matchesBeforeOracle("transition-stuck", [stuck]), true);
    assert.equal(matchesAfterOracle("floor-advanced", [stuck]), false);

    const advanced = observation({
      reloadObserved: true,
      view: view({ floor: 2, mode: "explore" }),
      judge: judge({ advanced: true }),
    });
    assert.equal(matchesBeforeOracle("transition-stuck", [advanced]), false);
    assert.equal(matchesAfterOracle("floor-advanced", [advanced]), true);
  });

  it("旧 Oracle 别名不再解析", () => {
    assert.throws(() => parseEvalOracleBefore("transition-lost"), /不受支持/u);
    assert.throws(() => parseEvalOracleAfter("transition-restored"), /不受支持/u);
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
    assert.equal(classifyEvalOraclePlan(scanView), "scan");
    assert.equal(classifyEvalOraclePlan(searchView), "search");
    assert.equal(matchesBeforeOracle("stale-query-plan", [
      observation({ op: "query", planClass: "scan", view: scanView }),
    ]), true);
    assert.equal(matchesAfterOracle("query-plan-current", [
      observation({
        op: "query",
        event: "query-accepted",
        planClass: "search",
        view: searchView,
      }),
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
    assert.equal(matchesAfterOracle("query-plan-current", [
      observation({ op: "query", event: "query-accepted", planClass: "scan", view: scanView }),
    ]), false);
  });

  it("最终胜场 Oracle 不接受中间态曾经等于一", () => {
    const transient = observation({
      isFinal: false,
      view: view({ mode: "victory" }),
      judge: judge({ victories: 1 }),
    });
    const duplicated = observation({
      stepIndex: 1,
      view: view({ mode: "victory" }),
      judge: judge({ victories: 2 }),
    });
    assert.equal(matchesAfterOracle("victory-count-once", [transient, duplicated]), false);
    assert.equal(matchesAfterOracle("victory-count-once", [
      { ...duplicated, judge: judge({ victories: 1 }) },
    ]), true);
  });
});
