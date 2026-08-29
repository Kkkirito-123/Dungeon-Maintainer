/**
 * EvalOracle 的纯规则匹配器。
 *
 * 本模块只读取低敏步骤观测，不启动浏览器、不读取 fixture 文件，也不接触 SQL 或源码。
 * 步骤位置、最终态、是否经历 reload、查询结果序列和计划类别都由 runner 预先投影，
 * 从而让判分规则可独立单测并避免用任意中间瞬态误判最终功能。
 */

import type { PlayJudge, PlayView } from "../../game/protocol.js";
import type { EvalScenarioStep } from "./scenario.js";

/** 显式浏览器预检及其证书绑定的精确 Oracle 版本。 */
export const EVAL_ORACLE_VERSION = "oracle-exact-final-state";

export type EvalOraclePlanClass = "scan" | "search" | "placeholder" | "none";

const BEFORE_ORACLES = [
  "terminal-action-unavailable",
  "combat-stalled",
  "boss-stuck-one-hp",
  "floor-transition-stuck",
  "transition-stuck",
  "stale-query-plan",
  "victory-count-duplicated",
] as const;

const AFTER_ORACLES = [
  "terminal-action-available",
  "combat-progressed",
  "boss-defeated",
  "floor-advanced",
  "query-plan-current",
  "victory-count-once",
] as const;

/** 当前 7 个案例允许的故障态 Oracle ID。 */
export type EvalOracleBefore = typeof BEFORE_ORACLES[number];

/** 当前 7 个案例允许的修复态 Oracle ID。 */
export type EvalOracleAfter = typeof AFTER_ORACLES[number];

const BEFORE_ORACLE_SET = new Set<string>(BEFORE_ORACLES);
const AFTER_ORACLE_SET = new Set<string>(AFTER_ORACLES);

/** 严格读取当前故障态 Oracle ID，旧别名直接拒绝。 */
export function parseEvalOracleBefore(value: unknown): EvalOracleBefore {
  if (typeof value !== "string" || !BEFORE_ORACLE_SET.has(value)) {
    throw new Error("expected.json beforeOracle 不受支持");
  }
  return value as EvalOracleBefore;
}

/** 严格读取当前修复态 Oracle ID，旧别名直接拒绝。 */
export function parseEvalOracleAfter(value: unknown): EvalOracleAfter {
  if (typeof value !== "string" || !AFTER_ORACLE_SET.has(value)) {
    throw new Error("expected.json afterOracle 不受支持");
  }
  return value as EvalOracleAfter;
}

/** 单个复现步骤完成后的低敏 Oracle 观测。 */
export interface EvalOracleObservation {
  readonly stepIndex: number;
  readonly op: EvalScenarioStep["op"];
  readonly isFinal: boolean;
  readonly reloadObserved: boolean;
  readonly ok: boolean;
  readonly event: string;
  readonly planClass: EvalOraclePlanClass;
  readonly view: PlayView;
  readonly judge: PlayJudge;
}

function finalObservation(
  observations: readonly EvalOracleObservation[],
): EvalOracleObservation | null {
  return observations.find((entry) => entry.isFinal) ?? observations.at(-1) ?? null;
}

/** 把玩家可见执行计划压缩为不含正文的稳定类别。 */
export function classifyEvalOraclePlan(view: PlayView): EvalOraclePlanClass {
  const text = view.terminal?.plan.join("\n").toUpperCase() ?? "";
  if (text.includes("等待 EXPLAIN")) return "placeholder";
  if (text.includes("SEARCH")) return "search";
  if (text.includes("SCAN")) return "scan";
  return "none";
}

/** 匹配注入故障版本必须呈现的公开失败。 */
export function matchesBeforeOracle(
  oracle: EvalOracleBefore,
  observations: readonly EvalOracleObservation[],
): boolean {
  if (oracle === "terminal-action-unavailable") {
    return observations.some((entry) => !entry.ok && entry.event === "action-not-available");
  }
  if (oracle === "combat-stalled") return observations.some((entry) => (
    entry.event === "query-accepted" && (entry.judge.stageIndex ?? 0) === 0
  ));
  if (oracle === "boss-stuck-one-hp") return observations.some((entry) => entry.judge.bossHp === 1);
  if (oracle === "floor-transition-stuck") {
    const final = finalObservation(observations);
    return Boolean(final
      && final.view.mode === "explore"
      && final.judge.bossDefeated
      && !final.judge.advanced);
  }
  if (oracle === "transition-stuck") return observations.some((entry) => (
    entry.view.mode === "transition" && !entry.judge.advanced
  ));
  if (oracle === "stale-query-plan") {
    const queries = observations.filter((entry) => entry.op === "query");
    return queries.length === 1
      && (queries[0]?.planClass === "scan" || queries[0]?.event === "query-rejected");
  }
  return observations.some((entry) => (entry.judge.victories ?? 0) > 1);
}

/** 匹配修复版本最终必须满足的公开结果。 */
export function matchesAfterOracle(
  oracle: EvalOracleAfter,
  observations: readonly EvalOracleObservation[],
): boolean {
  if (oracle === "terminal-action-available") {
    return observations.some((entry) => entry.ok && entry.event === "action:terminal");
  }
  if (oracle === "combat-progressed") return observations.some((entry) => (
    entry.event === "query-accepted" && (entry.judge.stageIndex ?? 0) > 0
  ));
  if (oracle === "boss-defeated") return observations.some((entry) => entry.judge.bossDefeated);
  if (oracle === "floor-advanced") {
    const final = finalObservation(observations);
    return Boolean(final && (final.judge.advanced || final.view.floor > final.judge.floor));
  }
  if (oracle === "query-plan-current") {
    const queries = observations.filter((entry) => entry.op === "query");
    return queries.length === 1
      && (queries[0]?.planClass === "search" || queries[0]?.event === "query-accepted");
  }
  return observations.some((entry) => (
    entry.view.mode === "victory" && (entry.judge.victories ?? 0) === 1
  ));
}
