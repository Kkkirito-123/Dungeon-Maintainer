/**
 * 当前任务诊断证据的确定性门禁。
 *
 * 本模块只读取 EvidenceStore 已持久化的 active 证据和脱敏工件，不依赖模型上下文
 * 或 Extension 进程内计数。因此 Pi 重启后仍能判断源码证据是否足以提交方案。
 * 普通故障要求一次当前版本源码读取；
 * `action-not-available` 额外要求执行分支、失败动作映射和真实 DOM 三类证据。
 */

import type { EvidenceStore } from "./store.js";
import type { EvidenceRecord } from "./types.js";

/** Extension、队列闭环和测试共用的低敏诊断状态。 */
export interface DiagnosticEvidenceState {
  hasFailure: boolean;
  hasSourceRead: boolean;
  sourceEvidenceReady: boolean;
  hasReproduction: boolean;
  hasFailedCheck: boolean;
  hasGameEvidence: boolean;
  hasGameFailure: boolean;
  actionNotAvailable: boolean;
  missingActionEvidence: string[];
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sourcePath(record: EvidenceRecord): string {
  return (record.path ?? "").replaceAll("\\", "/").toLowerCase();
}

/**
 * 从当前 active reproduction 的可重放 Trace 提取真正作为故障触发点的不可用动作。
 *
 * 游戏探测期间可能先误点 continue 等无关动作；这些失败会保留为 game evidence，
 * 但 replayableTraceActions 会把中途失败排除在正式复现之外。诊断门禁因此必须以
 * active reproduction 为准，不能让任务期间任意一次 action-not-available 污染其它 Bug。
 */
async function unavailableActionsInReproduction(
  evidence: EvidenceStore,
  reproduction: EvidenceRecord | null,
): Promise<Set<string>> {
  if (!reproduction) return new Set<string>();
  const artifact = await evidence.getEvidenceArtifact(reproduction.id);
  if (!artifact) return new Set<string>();
  let value: unknown;
  try {
    value = JSON.parse(artifact);
  } catch {
    return new Set<string>();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Set<string>();
  }
  const actions = (value as Record<string, unknown>).actions;
  if (!Array.isArray(actions)) return new Set<string>();
  const unavailable = /action-not-available|动作不可用/iu;
  return new Set(actions.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const action = entry as Record<string, unknown>;
    const args = action.arguments;
    if (
      action.action !== "use"
      || action.ok !== false
      || typeof action.summary !== "string"
      || !unavailable.test(action.summary)
      || !args
      || typeof args !== "object"
      || Array.isArray(args)
    ) return [];
    const actionId = (args as Record<string, unknown>).actionId;
    return typeof actionId === "string" && actionId ? [actionId] : [];
  }));
}

/** 从持久化证据重建当前诊断门禁；不会写入账本或改变证据状态。 */
export async function readDiagnosticEvidence(
  evidence: EvidenceStore,
): Promise<DiagnosticEvidenceState> {
  const [reproduction, checks, sources, games] = await Promise.all([
    evidence.latest("reproduction"),
    evidence.checks(),
    evidence.active("source"),
    evidence.active("game"),
  ]);
  const hasFailedCheck = checks.some((record) => record.status !== "passed");
  const hasReproduction = reproduction !== null;
  const failedGames = games.filter((record) => record.metadata.ok === false);
  const failedActions = await unavailableActionsInReproduction(evidence, reproduction);
  const actionNotAvailable = failedActions.size > 0;
  let executionEvidence = false;
  let mappingEvidence = false;
  let domEvidence = false;
  let sourceReadCount = 0;

  for (const record of sources) {
    if (record.metadata.action === "read") sourceReadCount += 1;
    const text = await evidence.getEvidenceArtifact(record.id) ?? "";
    const path = sourcePath(record);
    if (
      record.metadata.action === "read"
      && /(?:^|\/)bridge\.[cm]?[jt]sx?$/u.test(path)
      && /DUNGEON_AGENT_ACTION_SELECTORS\s*[\s\S]*actionId/u.test(text)
      && /action-not-available|clickDungeonAgentAction/u.test(text)
    ) {
      executionEvidence = true;
    }
    if (
      record.metadata.action === "read"
      && /(?:^|\/)actions\.[cm]?[jt]sx?$/u.test(path)
      && /DUNGEON_AGENT_ACTION_SELECTORS/u.test(text)
      && [...failedActions].some((actionId) => new RegExp(
        "(?:^|\\n)\\s*(?:\\d+\\s+)?[\"'`]?" + escapedPattern(actionId)
          + "[\"'`]?\\s*:\\s*[\"'`][^\"'`]+[\"'`]",
        "u",
      ).test(text))
    ) {
      mappingEvidence = true;
    }
    if (
      (
        (record.metadata.action === "read" && path.includes("/presentation/dom/"))
        || (
          record.metadata.action === "search"
          && /(?:^|\n)[^\n]*\/presentation\/dom\/[^:\n]+:\d+:[^\n]*/u.test(text)
        )
      )
      && /(?:id\s*=\s*["'][^"']+["']|[A-Za-z_$][\w$]*\s*:\s*["']#[^"']+["'])/u.test(text)
      && /open-sql|sqlButton|terminal/iu.test(text)
    ) {
      domEvidence = true;
    }
  }

  const missingActionEvidence: string[] = [];
  if (actionNotAvailable) {
    if (!executionEvidence) missingActionEvidence.push("use 执行分支");
    if (!mappingEvidence) {
      missingActionEvidence.push([...failedActions].join("/") + " 的动作映射字面量");
    }
    if (!domEvidence) missingActionEvidence.push("真实 DOM 按钮定义");
  }
  const sourceEvidenceReady = actionNotAvailable
    ? missingActionEvidence.length === 0
    : sourceReadCount >= 1;
  return {
    hasFailure: hasReproduction || hasFailedCheck,
    hasSourceRead: sourceReadCount > 0,
    sourceEvidenceReady,
    hasReproduction,
    hasFailedCheck,
    hasGameEvidence: games.length > 0,
    hasGameFailure: failedGames.length > 0,
    actionNotAvailable,
    missingActionEvidence,
  };
}
