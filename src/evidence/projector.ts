/**
 * 工具结果到 EvidenceRecord 的确定性投影。
 *
 * 本模块不读写文件、不调用模型，只把已经完成的源码读取、检查、复现、方案、修改和
 * 验证转换为有限结构化证据。摘要只使用工具元数据和模型已提交的 finish 结论，不保存
 * 完整源码、SQL、隐藏答案或检查日志正文。
 */

import { createHash } from "node:crypto";
import type { InspectInput, InspectDetails } from "../inspection/types.js";
import type { ReproductionRecord } from "../repair/reproduction.js";
import type { VerificationRecord } from "../task/types.js";
import type { CheckRecord, EvidenceCandidate } from "./types.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function inspectActionKey(
  input: InspectInput,
  resolvedScope: readonly string[] = [],
): string {
  return digest({ tool: "inspect", input, resolvedScope: [...resolvedScope] });
}

export function sourceEvidence(
  input: InspectInput,
  details: InspectDetails,
  worktreeHash: string | null,
  resolvedScope: readonly string[] = [],
): EvidenceCandidate {
  const path = input.path?.replaceAll("\\", "/") ?? null;
  const validityKey = input.action === "read"
    ? details.baseHash ?? "missing"
    : worktreeHash ?? "unknown-worktree";
  const location = path
    ? path + (input.action === "read" ? ":" + String(input.startLine ?? 1) : "")
    : input.action;
  return {
    kind: "source",
    actionKey: inspectActionKey(input, resolvedScope),
    fingerprint: details.contentHash,
    status: "active",
    summary: "inspect " + input.action + " 已取得当前版本证据：" + location,
    artifactRef: null,
    path,
    startLine: input.action === "read" ? input.startLine ?? 1 : null,
    lineCount: input.action === "read" ? input.lineCount ?? details.lines : null,
    baseHash: details.baseHash,
    worktreeHash,
    validityKey,
    links: [],
    metadata: {
      action: input.action,
      lines: details.lines,
      truncated: details.truncated,
      scope: resolvedScope.join("\n") || null,
      matchCount: details.matchCount ?? null,
      complete: details.complete ?? null,
      expanded: details.expanded ?? null,
    },
  };
}

/** 把一次游戏语义动作压缩为不含 SQL、地图和隐藏裁判正文的证据。 */
export function gameEvidence(input: {
  toolName: string;
  actionId?: unknown;
  target?: unknown;
  ok: boolean;
  event?: unknown;
}): EvidenceCandidate {
  const actionId = typeof input.actionId === "string" ? input.actionId.slice(0, 80) : null;
  const target = typeof input.target === "string" ? input.target.slice(0, 80) : null;
  const event = typeof input.event === "string" ? input.event.slice(0, 120) : null;
  return {
    kind: "game",
    actionKey: null,
    fingerprint: digest(input),
    status: "active",
    summary: "游戏动作 " + input.toolName + "：" + (input.ok ? "成功" : "失败")
      + (event ? "；事件 " + event : ""),
    artifactRef: null,
    path: null,
    startLine: null,
    lineCount: null,
    baseHash: null,
    worktreeHash: null,
    validityKey: "runtime",
    links: [],
    metadata: {
      toolName: input.toolName,
      actionId,
      target,
      ok: input.ok,
      event,
    },
  };
}

export function checkEvidence(record: CheckRecord): EvidenceCandidate {
  return {
    kind: "check",
    actionKey: digest({ tool: "check", id: record.id }),
    fingerprint: digest({
      id: record.id,
      worktreeHash: record.worktreeHash,
      status: record.status,
    }),
    status: "active",
    summary: "固定检查 " + record.id + "：" + record.status,
    artifactRef: record.logPath,
    path: null,
    startLine: null,
    lineCount: null,
    baseHash: null,
    worktreeHash: record.worktreeHash,
    validityKey: record.worktreeHash,
    links: [],
    metadata: {
      id: record.id,
      status: record.status,
      durationMs: record.durationMs,
      logPath: record.logPath,
    },
  };
}

export function reproductionEvidence(
  record: ReproductionRecord,
  artifactRef: string,
): EvidenceCandidate {
  return {
    kind: "reproduction",
    actionKey: null,
    fingerprint: digest({ id: record.id, assertions: record.assertions, actions: record.actions }),
    status: "active",
    summary: record.title + "；期望：" + record.expected + "；实际：" + record.actual,
    artifactRef,
    path: null,
    startLine: null,
    lineCount: null,
    baseHash: null,
    worktreeHash: null,
    validityKey: record.id,
    links: [],
    metadata: {
      reproductionId: record.id,
      actionCount: record.actions.length,
    },
  };
}

export function claimEvidence(input: {
  status: string;
  summary: string;
  risk: string;
  planTitle?: string;
  planSteps?: readonly string[];
  verification?: string;
  allowedPaths?: readonly string[];
  links: readonly string[];
}): EvidenceCandidate {
  return {
    kind: "claim",
    actionKey: null,
    fingerprint: digest(input),
    status: "active",
    summary: input.summary,
    artifactRef: null,
    path: null,
    startLine: null,
    lineCount: null,
    baseHash: null,
    worktreeHash: null,
    validityKey: input.status,
    links: [...input.links],
    metadata: {
      finishStatus: input.status,
      risk: input.risk,
      planTitle: input.planTitle ?? null,
      planSteps: input.planSteps?.join("\n") ?? null,
      verification: input.verification ?? null,
      allowedPaths: input.allowedPaths?.join("\n") ?? null,
    },
  };
}

export function changeEvidence(
  paths: readonly string[],
  worktreeHash: string,
  links: readonly string[],
): EvidenceCandidate {
  return {
    kind: "change",
    actionKey: null,
    fingerprint: digest({ paths: [...paths].sort(), worktreeHash }),
    status: "active",
    summary: "代码修改：" + [...paths].sort().join(", "),
    artifactRef: null,
    path: null,
    startLine: null,
    lineCount: null,
    baseHash: null,
    worktreeHash,
    validityKey: worktreeHash,
    links: [...links],
    metadata: { pathCount: paths.length },
  };
}

export function verificationEvidence(
  record: VerificationRecord,
  links: readonly string[],
): EvidenceCandidate {
  return {
    kind: "verification",
    actionKey: null,
    fingerprint: digest(record),
    status: "active",
    summary: "固定验证通过；检查 " + record.checkIds.join(", "),
    artifactRef: null,
    path: null,
    startLine: null,
    lineCount: null,
    baseHash: null,
    worktreeHash: record.worktreeHash,
    validityKey: record.worktreeHash,
    links: [...links],
    metadata: {
      replayPassed: record.replayPassed,
      reproductionId: record.reproductionId,
      checkIds: record.checkIds.join("\n"),
    },
  };
}
