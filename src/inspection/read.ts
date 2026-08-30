/** 分页源码读取、覆盖索引和 Evidence 捕获。 */

import { readFile, stat } from "node:fs/promises";
import { inspectActionKey, sourceEvidence } from "../evidence/projector.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { EvidenceRecord } from "../evidence/types.js";
import { redactCredentials } from "../logging/redact.js";
import { hashBytes, hashFile } from "../workspace/git.js";
import { resolveProjectPath } from "../workspace/policy.js";
import {
  aggregateCacheKind,
  clipInspectionText,
  DEFAULT_READ_LINES,
  inspectionReceipt,
  isSemanticAlias,
  MAX_BUNDLE_SOURCE_BYTES,
  MAX_INSPECT_BODY_BYTES,
  MAX_INSPECT_LINES,
  renderCapturedInspectionText,
} from "./output.js";
import type {
  InspectDetails,
  InspectInput,
  InspectItemDetails,
  InspectReadRange,
} from "./types.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Inspection 执行读取和证据捕获所需的最小依赖。 */
export interface InspectionContext {
  root: string;
  evidence: EvidenceStore;
}

interface LineInterval {
  start: number;
  end: number;
}

interface PreparedReadRange {
  target: Awaited<ReturnType<typeof resolveProjectPath>>;
  startLine: number;
  lineCount: number;
  baseHash: string;
  existing: EvidenceRecord[];
  uncovered: LineInterval[];
}

interface PendingReadCapture {
  input: InspectInput;
  clipped: ReturnType<typeof clipInspectionText>;
  contentHash: string;
  baseHash: string;
}

export interface ReadRangePreview {
  text: string;
  details: InspectDetails;
  items: InspectItemDetails[];
  captures: PendingReadCapture[];
}

export interface CaptureInspectionOptions {
  baseHash: string | null;
  worktreeHash: string | null;
  scope?: readonly string[];
  links?: readonly string[];
  matchCount?: number;
  complete?: boolean;
  bundleWindows?: number;
  candidateFiles?: number;
  selectedFiles?: number;
}

async function readPage(
  target: { absolute: string },
  startLine = 1,
  lineCount = DEFAULT_READ_LINES,
): Promise<string> {
  const information = await stat(target.absolute);
  if (!information.isFile() || information.size > MAX_FILE_BYTES) {
    throw new Error("inspect 只读取不超过 2 MiB 的文本文件");
  }
  const value = await readFile(target.absolute, "utf8");
  if (value.includes("\0")) throw new Error("inspect 不读取二进制文件");
  return value.split(/\r?\n/u)
    .slice(startLine - 1, startLine - 1 + lineCount)
    .map((line, index) => (
      String(startLine + index).padStart(5, " ") + " " + line
    ))
    .join("\n");
}

function uncoveredIntervals(
  startLine: number,
  lineCount: number,
  covered: readonly LineInterval[],
): LineInterval[] {
  const requestedEnd = startLine + lineCount;
  const normalized = covered.map((interval) => ({
    start: Math.max(startLine, interval.start),
    end: Math.min(requestedEnd, interval.end),
  })).filter((interval) => interval.start < interval.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: LineInterval[] = [];
  for (const interval of normalized) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const output: LineInterval[] = [];
  let cursor = startLine;
  for (const interval of merged) {
    if (cursor < interval.start) output.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < requestedEnd) output.push({ start: cursor, end: requestedEnd });
  return output;
}

function evidenceCoverageEnd(record: {
  startLine: number;
  lineCount: number;
  metadata: Record<string, unknown>;
}): number {
  const requestedLineCount = record.metadata.eof === true
    && typeof record.metadata.requestedLineCount === "number"
    ? record.metadata.requestedLineCount
    : record.lineCount;
  return record.startLine + requestedLineCount;
}

function coveringEvidenceRecords(
  startLine: number,
  lineCount: number,
  records: readonly EvidenceRecord[],
): EvidenceRecord[] {
  const requestedEnd = startLine + lineCount;
  const candidates = records.filter((record) => (
    typeof record.startLine === "number"
    && typeof record.lineCount === "number"
    && record.startLine < requestedEnd
    && evidenceCoverageEnd({
      startLine: record.startLine,
      lineCount: record.lineCount,
      metadata: record.metadata,
    }) > startLine
  ));
  const selected: EvidenceRecord[] = [];
  let cursor = startLine;
  while (cursor < requestedEnd) {
    const next = candidates.filter((record) => (
      (record.startLine as number) <= cursor
      && evidenceCoverageEnd({
        startLine: record.startLine as number,
        lineCount: record.lineCount as number,
        metadata: record.metadata,
      }) > cursor
    )).sort((left, right) => (
      evidenceCoverageEnd({
        startLine: right.startLine as number,
        lineCount: right.lineCount as number,
        metadata: right.metadata,
      }) - evidenceCoverageEnd({
        startLine: left.startLine as number,
        lineCount: left.lineCount as number,
        metadata: left.metadata,
      })
    ))[0];
    if (!next) return [];
    selected.push(next);
    cursor = evidenceCoverageEnd({
      startLine: next.startLine as number,
      lineCount: next.lineCount as number,
      metadata: next.metadata,
    });
  }
  return selected;
}

function coveredReadRange(
  path: string,
  startLine: number,
  lineCount: number,
  baseHash: string,
  existing: readonly EvidenceRecord[],
): { text: string; details: InspectDetails; items: InspectItemDetails[] } {
  const covering = coveringEvidenceRecords(startLine, lineCount, existing);
  const first = covering[0];
  if (!first) throw new Error("inspect 读取覆盖索引不完整");
  const items = covering.map((record) => ({
    path,
    startLine: record.startLine as number,
    lineCount: record.lineCount as number,
    evidenceId: record.id,
    baseHash,
    receiptOnly: true,
  }));
  const actionKey = inspectActionKey({ action: "read", path, startLine, lineCount });
  const details: InspectDetails = {
    action: "read",
    evidenceId: first.id,
    contentHash: first.fingerprint,
    baseHash,
    lines: 0,
    truncated: false,
    actionKey,
    cacheKind: "exact",
    items,
  };
  return {
    text: inspectionReceipt({ evidenceId: first.id, action: "read", baseHash })
      + "\ncovered=" + path + ":" + String(startLine) + "-"
      + String(startLine + lineCount - 1)
      + "\ncoveringEvidence=" + items.map((item) => (
        item.evidenceId + ":" + String(item.startLine) + "+" + String(item.lineCount)
      )).join(","),
    details,
    items,
  };
}

function readPathCacheKey(path: string): string {
  const normalized = path.replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function prepareReadRange(
  context: InspectionContext,
  range: InspectReadRange,
): Promise<PreparedReadRange> {
  // 先走一次 realpath 边界检查，再复用它返回的规范项目路径做 Hash、读取和缓存比较。
  const target = await resolveProjectPath(context.root, range.path, "read");
  const startLine = range.startLine ?? 1;
  const lineCount = range.lineCount ?? DEFAULT_READ_LINES;
  const baseHash = await hashFile(context.root, target.relative);
  const pathKey = readPathCacheKey(target.relative);
  const existing = (await context.evidence.active("source")).filter((record) => (
    record.actionKey !== null
      && typeof record.path === "string"
      && readPathCacheKey(record.path) === pathKey
      && record.baseHash === baseHash
      && typeof record.startLine === "number"
      && typeof record.lineCount === "number"
  ));
  const uncovered = uncoveredIntervals(startLine, lineCount, existing.map((record) => ({
    start: record.startLine as number,
    end: evidenceCoverageEnd({
      startLine: record.startLine as number,
      lineCount: record.lineCount as number,
      metadata: record.metadata,
    }),
  })));
  return { target, startLine, lineCount, baseHash, existing, uncovered };
}

export async function captureInspectionText(
  context: InspectionContext,
  input: InspectInput,
  raw: string,
  options: CaptureInspectionOptions,
): Promise<{ text: string; details: InspectDetails }> {
  const clipped = clipInspectionText(redactCredentials(raw));
  const contentHash = hashBytes(Buffer.from(clipped.text, "utf8"));
  const resolvedScope = options.scope ?? [];
  const actionKey = inspectActionKey(input, resolvedScope);
  const details: InspectDetails = {
    action: input.action,
    evidenceId: "",
    contentHash,
    baseHash: options.baseHash,
    lines: clipped.lines,
    truncated: clipped.truncated,
    actionKey,
    cacheKind: "none",
    scope: [...resolvedScope],
    ...(options.matchCount === undefined ? {} : { matchCount: options.matchCount }),
    ...(options.complete === undefined ? {} : { complete: options.complete }),
    ...(options.bundleWindows === undefined ? {} : { bundleWindows: options.bundleWindows }),
    ...(options.candidateFiles === undefined ? {} : { candidateFiles: options.candidateFiles }),
    ...(options.selectedFiles === undefined ? {} : { selectedFiles: options.selectedFiles }),
  };
  const projected = sourceEvidence(input, details, options.worktreeHash, resolvedScope);
  projected.links = [...(options.links ?? [])];
  const saved = await context.evidence.captureText(projected, clipped.text);
  details.evidenceId = saved.record.id;
  const semanticHit = !saved.added && isSemanticAlias(saved.record, actionKey);
  if (semanticHit) {
    details.cacheKind = "semantic";
    return {
      text: inspectionReceipt({
        evidenceId: saved.record.id,
        action: input.action,
        baseHash: options.baseHash,
        scope: resolvedScope,
        ...(options.matchCount === undefined ? {} : { matchCount: options.matchCount }),
        ...(options.complete === undefined ? {} : { complete: options.complete }),
        ...(options.bundleWindows === undefined
          ? {} : { bundleWindows: options.bundleWindows }),
      }) + "\nsemanticResult=true",
      details,
    };
  }
  details.cacheKind = "none";
  return {
    text: renderCapturedInspectionText(details.evidenceId, contentHash, options.baseHash, clipped),
    details,
  };
}

export async function findCachedInspection(
  context: InspectionContext,
  input: InspectInput,
  resolvedScope: readonly string[],
  validityKey: string,
): Promise<{ text: string; details: InspectDetails } | null> {
  const actionKey = inspectActionKey(input, resolvedScope);
  const cached = await context.evidence.findReusable(actionKey, validityKey);
  if (!cached) return null;
  const scope = typeof cached.metadata.scope === "string"
    ? cached.metadata.scope.split("\n").filter(Boolean)
    : [];
  const matchCount = typeof cached.metadata.matchCount === "number"
    ? cached.metadata.matchCount
    : null;
  const complete = typeof cached.metadata.complete === "boolean"
    ? cached.metadata.complete
    : null;
  const bundleWindows = typeof cached.metadata.bundleWindows === "number"
    ? cached.metadata.bundleWindows
    : null;
  return {
    text: inspectionReceipt({
      evidenceId: cached.id,
      action: input.action,
      baseHash: cached.baseHash,
      scope,
      matchCount,
      complete,
      bundleWindows,
    }),
    details: {
      action: input.action,
      evidenceId: cached.id,
      contentHash: cached.fingerprint,
      baseHash: cached.baseHash,
      lines: cached.lineCount ?? 0,
      truncated: false,
      actionKey,
      cacheKind: "exact",
      scope,
      ...(matchCount === null ? {} : { matchCount }),
      ...(complete === null ? {} : { complete }),
      ...(typeof cached.metadata.bundleWindows === "number"
        ? { bundleWindows: cached.metadata.bundleWindows }
        : {}),
      ...(typeof cached.metadata.candidateFiles === "number"
        ? { candidateFiles: cached.metadata.candidateFiles }
        : {}),
      ...(typeof cached.metadata.selectedFiles === "number"
        ? { selectedFiles: cached.metadata.selectedFiles }
        : {}),
    },
  };
}

export async function inspectReadRange(
  context: InspectionContext,
  range: InspectReadRange,
  signal?: AbortSignal,
): Promise<{ text: string; details: InspectDetails; items: InspectItemDetails[] }> {
  signal?.throwIfAborted();
  const { target, startLine, lineCount, baseHash, existing, uncovered } = await prepareReadRange(
    context,
    range,
  );
  if (uncovered.length === 0) {
    return coveredReadRange(target.relative, startLine, lineCount, baseHash, existing);
  }

  const outputs: string[] = [];
  const items: InspectItemDetails[] = [];
  const capturedDetails: InspectDetails[] = [];
  for (const interval of uncovered) {
    const requestedCount = interval.end - interval.start;
    const readInput: InspectInput = {
      action: "read",
      path: target.relative,
      startLine: interval.start,
      lineCount: requestedCount,
    };
    const raw = await readPage(target, interval.start, requestedCount);
    const captured = await captureInspectionText(context, readInput, raw, {
      baseHash,
      worktreeHash: null,
    });
    outputs.push(captured.text);
    capturedDetails.push(captured.details);
    items.push({
      path: target.relative,
      startLine: interval.start,
      lineCount: captured.details.lines,
      evidenceId: captured.details.evidenceId,
      baseHash,
      receiptOnly: captured.details.cacheKind !== "none",
    });
  }
  const first = capturedDetails[0];
  if (!first) throw new Error("inspect read 未生成源码证据");
  return {
    text: outputs.join("\n"),
    details: {
      ...first,
      lines: capturedDetails.reduce((sum, details) => sum + details.lines, 0),
      cacheKind: aggregateCacheKind(capturedDetails),
      items,
    },
    items,
  };
}

export async function previewReadRange(
  context: InspectionContext,
  range: InspectReadRange,
  signal?: AbortSignal,
): Promise<ReadRangePreview> {
  signal?.throwIfAborted();
  const { target, startLine, lineCount, baseHash, existing, uncovered } = await prepareReadRange(
    context,
    range,
  );
  if (uncovered.length === 0) {
    const covered = coveredReadRange(
      target.relative,
      startLine,
      lineCount,
      baseHash,
      existing,
    );
    return { ...covered, captures: [] };
  }

  const outputs: string[] = [];
  const items: InspectItemDetails[] = [];
  const capturedDetails: InspectDetails[] = [];
  const captures: PendingReadCapture[] = [];
  for (const interval of uncovered) {
    const requestedCount = interval.end - interval.start;
    const readInput: InspectInput = {
      action: "read",
      path: target.relative,
      startLine: interval.start,
      lineCount: requestedCount,
    };
    const raw = await readPage(target, interval.start, requestedCount);
    const clipped = clipInspectionText(redactCredentials(raw), MAX_BUNDLE_SOURCE_BYTES);
    const contentHash = hashBytes(Buffer.from(clipped.text, "utf8"));
    const evidenceId = "0000000000000000";
    const details: InspectDetails = {
      action: "read",
      evidenceId,
      contentHash,
      baseHash,
      lines: clipped.lines,
      truncated: clipped.truncated,
      actionKey: inspectActionKey(readInput),
      cacheKind: "none",
    };
    outputs.push(renderCapturedInspectionText(evidenceId, contentHash, baseHash, clipped));
    captures.push({ input: readInput, clipped, contentHash, baseHash });
    capturedDetails.push(details);
    items.push({
      path: target.relative,
      startLine: interval.start,
      lineCount: clipped.lines,
      evidenceId,
      baseHash,
      receiptOnly: false,
    });
  }
  const first = capturedDetails[0];
  if (!first) throw new Error("inspect read preview 未生成源码窗口");
  return {
    text: outputs.join("\n"),
    details: {
      ...first,
      lines: capturedDetails.reduce((sum, details) => sum + details.lines, 0),
      items,
    },
    items,
    captures,
  };
}

/** 把已通过 bundle 最终预算的 preview 提交到证据账本，不再次读取文件。 */
export async function capturePreviewReadRange(
  context: InspectionContext,
  preview: ReadRangePreview,
): Promise<{ text: string; details: InspectDetails; items: InspectItemDetails[] }> {
  if (preview.captures.length === 0) return preview;
  const outputs: string[] = [];
  const items: InspectItemDetails[] = [];
  const details: InspectDetails[] = [];
  for (const capture of preview.captures) {
    const projectedDetails: InspectDetails = {
      action: "read",
      evidenceId: "",
      contentHash: capture.contentHash,
      baseHash: capture.baseHash,
      lines: capture.clipped.lines,
      truncated: capture.clipped.truncated,
      actionKey: inspectActionKey(capture.input),
      cacheKind: "none",
    };
    const projected = sourceEvidence(capture.input, projectedDetails, null);
    const saved = await context.evidence.captureText(projected, capture.clipped.text);
    projectedDetails.evidenceId = saved.record.id;
    const semanticHit = !saved.added
      && isSemanticAlias(saved.record, projectedDetails.actionKey);
    projectedDetails.cacheKind = semanticHit ? "semantic" : "none";
    outputs.push(semanticHit
      ? inspectionReceipt({
        evidenceId: projectedDetails.evidenceId,
        action: "read",
        baseHash: capture.baseHash,
      }) + "\nsemanticResult=true"
      : renderCapturedInspectionText(
        projectedDetails.evidenceId,
        capture.contentHash,
        capture.baseHash,
        capture.clipped,
      ));
    details.push(projectedDetails);
    items.push({
      path: capture.input.path ?? "",
      startLine: capture.input.startLine ?? 1,
      lineCount: capture.clipped.lines,
      evidenceId: projectedDetails.evidenceId,
      baseHash: capture.baseHash,
      receiptOnly: semanticHit,
    });
  }
  const first = details[0];
  if (!first) throw new Error("inspect bundle 未提交源码窗口");
  return {
    text: outputs.join("\n"),
    details: {
      ...first,
      lines: details.reduce((sum, entry) => sum + entry.lines, 0),
      cacheKind: aggregateCacheKind(details),
      items,
    },
    items,
  };
}

function readManyReceiptIndex(items: readonly InspectItemDetails[]): string {
  return [
    "[READ_MANY_RECEIPT items=" + String(items.length) + "]",
    ...items.map((item) => (
      item.path + ":" + String(item.startLine) + "+" + String(item.lineCount)
      + " baseHash=" + item.baseHash
      + " evidence=" + item.evidenceId
      + " receiptOnly=" + String(item.receiptOnly)
    )),
  ].join("\n");
}

export async function inspectReadMany(
  context: InspectionContext,
  input: InspectInput,
  signal?: AbortSignal,
): Promise<{ text: string; details: InspectDetails }> {
  if (!input.ranges || input.ranges.length === 0) throw new Error("read_many 必须提供 ranges");
  const requestedLines = input.ranges.reduce((sum, range) => (
    sum + (range.lineCount ?? DEFAULT_READ_LINES)
  ), 0);
  if (requestedLines > MAX_INSPECT_LINES) throw new Error("read_many 总请求不能超过 240 行");
  const previews: ReadRangePreview[] = [];
  for (const range of input.ranges) {
    previews.push(await previewReadRange(context, range, signal));
  }
  const selected: ReadRangePreview[] = [];
  const previewOutputs: string[] = [];
  const previewItems: InspectItemDetails[] = [];
  const truncatedMarker = "[批量读取结果已按 4 KiB 预算省略未展示范围]";
  const bodyBudget = MAX_INSPECT_BODY_BYTES - Buffer.byteLength("\n" + truncatedMarker, "utf8");
  for (const preview of previews) {
    const candidateOutputs = [...previewOutputs, preview.text];
    const candidateItems = [...previewItems, ...preview.items];
    const candidateBody = [
      readManyReceiptIndex(candidateItems),
      ...candidateOutputs,
    ].join("\n");
    if (Buffer.byteLength(candidateBody, "utf8") > bodyBudget) continue;
    selected.push(preview);
    previewOutputs.push(preview.text);
    previewItems.push(...preview.items);
  }

  const outputs: string[] = [];
  const items: InspectItemDetails[] = [];
  const details: InspectDetails[] = [];
  for (const preview of selected) {
    const output = await capturePreviewReadRange(context, preview);
    outputs.push(output.text);
    items.push(...output.items);
    details.push(output.details);
  }
  const omitted = selected.length < previews.length;
  const body = [
    readManyReceiptIndex(items),
    ...outputs,
    ...(omitted ? [truncatedMarker] : []),
  ].join("\n");
  const first = details[0];
  if (!first) throw new Error("read_many 未生成源码证据");
  return {
    text: body,
    details: {
      ...first,
      action: "read_many",
      actionKey: inspectActionKey(input),
      lines: details.reduce((sum, entry) => sum + entry.lines, 0),
      truncated: omitted || details.some((entry) => entry.truncated),
      cacheKind: aggregateCacheKind(details),
      items,
    },
  };
}
