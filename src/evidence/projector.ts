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

function safeInspectQuery(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  // 源码查询通常是符号或症状；若模型误把完整 SQL 当 query，不把 SQL 复制进账本。
  if (/\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+[\w*(]/iu.test(normalized)) {
    return "[sensitive-query]";
  }
  return normalized.slice(0, 160);
}

export function inspectActionKey(
  input: InspectInput,
  resolvedScope: readonly string[] = [],
): string {
  const normalizedPath = (value: string | undefined): string | null => (
    value?.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "").replace(/\/+/gu, "/")
      .replace(/\/$/u, "")
      .toLocaleLowerCase("en-US") ?? null
  );
  const normalized = {
    action: input.action,
    path: normalizedPath(input.path),
    query: input.query?.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US") ?? null,
    startLine: input.action === "read" ? input.startLine ?? 1 : input.startLine ?? null,
    lineCount: input.action === "read" ? input.lineCount ?? 80 : input.lineCount ?? null,
    ranges: input.ranges?.map((range) => ({
      path: normalizedPath(range.path),
      startLine: range.startLine ?? 1,
      lineCount: range.lineCount ?? 80,
    })).sort((left, right) => (
      (left.path ?? "").localeCompare(right.path ?? "")
      || left.startLine - right.startLine
      || left.lineCount - right.lineCount
    )) ?? [],
  };
  return digest({
    tool: "inspect",
    input: normalized,
    resolvedScope: resolvedScope.map((scope) => normalizedPath(scope)).sort(),
  });
}

export function sourceEvidence(
  input: InspectInput,
  details: InspectDetails,
  worktreeHash: string | null,
  resolvedScope: readonly string[] = [],
): EvidenceCandidate {
  const path = input.path?.replaceAll("\\", "/") ?? null;
  const validityKey = input.action === "read"
    // 文件内容相同不代表同一位置。路径必须同时进入有效版本和结果身份，否则
    // 第二个同内容文件会被第一个文件的 evidence ID 吞并，覆盖图永远无法闭合。
    ? [path ?? "missing-path", details.baseHash ?? "missing"].join("\0")
    : worktreeHash ?? "unknown-worktree";
  const location = path
    ? path + (input.action === "read" ? ":" + String(input.startLine ?? 1) : "")
    : input.action;
  return {
    kind: "source",
    actionKey: inspectActionKey(input, resolvedScope),
    fingerprint: input.action === "read"
      ? digest({ path, contentHash: details.contentHash })
      : details.contentHash,
    status: "active",
    summary: [
      "inspect " + input.action + " 已取得当前版本证据：" + location,
      typeof details.matchCount === "number" ? "matches=" + String(details.matchCount) : null,
      typeof details.bundleWindows === "number"
        ? "windows=" + String(details.bundleWindows) : null,
    ].filter((value): value is string => value !== null).join("；"),
    artifactRef: null,
    path,
    startLine: input.action === "read" ? input.startLine ?? 1 : null,
    // 覆盖账本必须记录实际展示的行数；文件末尾或输出截断时，不能把未展示行
    // 标成 ALREADY_SEEN，否则后续精确 read 会错误地只返回回执。
    lineCount: input.action === "read" ? details.lines : null,
    baseHash: details.baseHash,
    worktreeHash,
    validityKey,
    links: [],
    metadata: {
      action: input.action,
      // query 只用于状态栏展示已经调查过的范围，不复制完整 SQL。
      query: safeInspectQuery(input.query),
      lines: details.lines,
      truncated: details.truncated,
      scope: resolvedScope.join("\n") || null,
      matchCount: details.matchCount ?? null,
      complete: details.complete ?? null,
      bundleWindows: details.bundleWindows ?? null,
      candidateFiles: details.candidateFiles ?? null,
      selectedFiles: details.selectedFiles ?? null,
      requestedLineCount: input.action === "read" ? input.lineCount ?? null : null,
      eof: input.action === "read"
        && !details.truncated
        && typeof input.lineCount === "number"
        && details.lines < input.lineCount,
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
