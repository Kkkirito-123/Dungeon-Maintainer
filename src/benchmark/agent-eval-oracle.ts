/**
 * Agent Eval 的纯 Oracle 匹配器。
 *
 * 本模块只读取低敏步骤观测，不启动浏览器、不读取 fixture 文件，也不接触 SQL 或源码。
 * 步骤位置、最终态、是否经历 reload、查询结果序列和计划类别都由 runner 预先投影，
 * 从而让判分规则可独立单测并避免用任意中间瞬态误判最终功能。
 */

import type { PlayJudge, PlayView } from "../game/protocol.js";
import type { AgentEvalReproductionStep } from "./agent-eval-case.js";

export type AgentEvalPlanClass = "scan" | "search" | "placeholder" | "none";

/** 单个复现步骤完成后的低敏 Oracle 观测。 */
export interface AgentEvalOracleObservation {
  readonly stepIndex: number;
  readonly op: AgentEvalReproductionStep["op"];
  readonly isFinal: boolean;
  readonly reloadObserved: boolean;
  readonly ok: boolean;
  readonly event: string;
  readonly planClass: AgentEvalPlanClass;
  readonly view: PlayView;
  readonly judge: PlayJudge;
}

function finalObservation(
  observations: readonly AgentEvalOracleObservation[],
): AgentEvalOracleObservation | null {
  return observations.find((entry) => entry.isFinal) ?? observations.at(-1) ?? null;
}

function queryEvents(observations: readonly AgentEvalOracleObservation[]): string[] {
  return observations
    .filter((entry) => entry.op === "query")
    .map((entry) => entry.event);
}

/** 把玩家可见执行计划压缩为不含正文的稳定类别。 */
export function classifyAgentEvalPlan(view: PlayView): AgentEvalPlanClass {
  const text = view.terminal?.plan.join("\n").toUpperCase() ?? "";
  if (text.includes("等待 EXPLAIN")) return "placeholder";
  if (text.includes("SEARCH")) return "search";
  if (text.includes("SCAN")) return "scan";
  return "none";
}

/** 匹配注入故障版本必须呈现的公开失败。 */
export function matchesBeforeOracle(
  oracle: string,
  observations: readonly AgentEvalOracleObservation[],
): boolean {
  if (oracle === "terminal-action-unavailable") {
    return observations.some((entry) => !entry.ok && entry.event === "action-not-available");
  }
  if (oracle === "no-failure") return observations.every((entry) => entry.ok);
  if (oracle === "query-rejected") return observations.some((entry) => entry.event === "query-rejected");
  if (oracle === "combat-stalled") return observations.some((entry) => (
    entry.event === "query-accepted" && (entry.judge.stageIndex ?? 0) === 0
  ));
  if (oracle === "boss-stuck-one-hp") return observations.some((entry) => entry.judge.bossHp === 1);
  if (oracle === "reward-missing") return observations.some((entry) => (entry.judge.claimableReward ?? null) === null);
  if (oracle === "portal-blocked") return observations.some((entry) => (
    entry.event !== "query-accepted" && entry.view.mode === "explore" && !entry.judge.advanced
  ));
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
  if (oracle === "boss-hp-reset") return observations.some((entry) => (
    entry.event === "query-accepted"
    && entry.judge.lessons === entry.judge.requiredLessons
    && !entry.judge.bossDefeated
    && (entry.judge.bossHp ?? 0) > 0
  ));
  if (oracle === "transition-lost") {
    const final = finalObservation(observations);
    return Boolean(final
      && final.reloadObserved
      && final.view.mode === "explore"
      && !final.judge.advanced);
  }
  if (oracle === "sandbox-state-leaked") {
    return queryEvents(observations).join("\n") === "query-accepted\nquery-rejected";
  }
  if (oracle === "stale-query-plan") {
    const queries = observations.filter((entry) => entry.op === "query");
    return queries.length === 1
      && (queries[0]?.planClass === "scan" || queries[0]?.event === "query-rejected");
  }
  if (oracle === "plan-placeholder") return observations.some((entry) => entry.planClass === "placeholder");
  if (oracle === "plan-missing") return observations.some((entry) => (
    entry.op === "query" && entry.event === "query-accepted" && entry.planClass === "none"
  ));
  if (oracle === "guidance-route-missing") return observations.some((entry) => (
    entry.judge.lessons < entry.judge.requiredLessons && entry.judge.guidanceDistance === null
  ));
  if (oracle === "victory-count-duplicated") return observations.some((entry) => (entry.judge.victories ?? 0) > 1);
  if (oracle === "victory-not-committed") return observations.some((entry) => entry.view.mode !== "victory");
  throw new Error("不支持的 beforeOracle：" + oracle);
}

/** 匹配修复版本最终必须满足的公开结果。 */
export function matchesAfterOracle(
  oracle: string,
  observations: readonly AgentEvalOracleObservation[],
): boolean {
  if (oracle === "terminal-action-available") {
    return observations.some((entry) => entry.ok && entry.event === "action:terminal");
  }
  if (oracle === "no-failure") return observations.every((entry) => entry.ok);
  if (oracle === "query-accepted") return observations.some((entry) => entry.event === "query-accepted");
  if (oracle === "combat-progressed") return observations.some((entry) => (
    entry.event === "query-accepted" && (entry.judge.stageIndex ?? 0) > 0
  ));
  if (oracle === "boss-defeated") return observations.some((entry) => entry.judge.bossDefeated);
  if (oracle === "reward-available") return observations.some((entry) => (entry.judge.claimableReward ?? null) !== null);
  if (oracle === "portal-unlocked") return observations.some((entry) => entry.view.mode === "combat");
  if (oracle === "floor-advanced") {
    const final = finalObservation(observations);
    return Boolean(final && (final.judge.advanced || final.view.floor > final.judge.floor));
  }
  if (oracle === "boss-hp-zero") {
    const defeatedAt = observations.findIndex((entry) => entry.judge.bossDefeated);
    return defeatedAt >= 0 && observations.slice(defeatedAt).every((entry) => entry.judge.bossDefeated || entry.judge.advanced);
  }
  if (oracle === "transition-restored") {
    const final = finalObservation(observations);
    return Boolean(final
      && final.reloadObserved
      && (final.view.mode === "transition" || final.judge.advanced));
  }
  if (oracle === "sandbox-isolated") {
    return queryEvents(observations).join("\n") === "query-accepted\nquery-accepted";
  }
  if (oracle === "query-plan-current") {
    const queries = observations.filter((entry) => entry.op === "query");
    return queries.length === 1
      && (queries[0]?.planClass === "search" || queries[0]?.event === "query-accepted");
  }
  if (oracle === "guidance-route-available") return observations.some((entry) => (
    typeof entry.judge.guidanceDistance === "number"
  ));
  if (oracle === "victory-count-once") return observations.some((entry) => entry.view.mode === "victory" && (entry.judge.victories ?? 0) === 1);
  if (oracle === "victory-committed") return observations.some((entry) => entry.view.mode === "victory");
  throw new Error("不支持的 afterOracle：" + oracle);
}
