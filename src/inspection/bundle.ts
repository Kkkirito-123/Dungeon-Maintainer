/** 搜索结果到有限源码窗口 bundle 的选择、预算和证据提交。 */

import {
  MAX_BUNDLE_BODY_BYTES,
} from "./output.js";
import {
  captureInspectionText,
  capturePreviewReadRange,
  previewReadRange,
  type InspectionContext,
} from "./read.js";
import { countSearchCandidateFiles, type SearchResult } from "./search.js";
import type {
  InspectDetails,
  InspectInput,
  InspectItemDetails,
  InspectReadRange,
} from "./types.js";

const BUNDLE_WINDOW_LINES = 48;
const MAX_BUNDLE_LINES = 192;

function bundleRanges(searchTextValue: string): InspectReadRange[] {
  const candidates: Array<{ path: string; line: number }> = [];
  for (const row of searchTextValue.split(/\r?\n/u)) {
    const match = /^(.*):(\d+):/u.exec(row);
    if (!match?.[1] || !match[2]) continue;
    const line = Number(match[2]);
    if (!Number.isSafeInteger(line)) continue;
    candidates.push({ path: match[1], line });
  }
  const distinctPaths = new Set(candidates.map((candidate) => candidate.path));
  const windowLines = distinctPaths.size > 1 ? 24 : BUNDLE_WINDOW_LINES;
  const selected: Array<InspectReadRange & { end: number }> = [];
  const perPath = new Map<string, number>();
  for (const candidate of candidates) {
    const startLine = Math.max(1, candidate.line - Math.floor(windowLines / 3));
    const end = startLine + windowLines;
    const count = perPath.get(candidate.path) ?? 0;
    if (count >= 2) continue;
    if (selected.some((range) => (
      range.path === candidate.path
      && startLine < range.end
      && range.startLine !== undefined
      && range.startLine < end
    ))) continue;
    selected.push({ path: candidate.path, startLine, lineCount: windowLines, end });
    perPath.set(candidate.path, count + 1);
    if (selected.reduce((sum, range) => sum + (range.lineCount ?? windowLines), 0) >= MAX_BUNDLE_LINES) break;
  }
  return selected.map((range) => ({
    path: range.path,
    startLine: range.startLine ?? 1,
    lineCount: range.lineCount ?? BUNDLE_WINDOW_LINES,
  }));
}

function bundleBodyBudget(previews: readonly { range: InspectReadRange }[]): number {
  const distinctPaths = new Set(previews.map((preview) => preview.range.path));
  // 多文件 bundle 为索引和每个路径的 Hash 预留更紧的正文预算；单文件巨型
  // 源码仍可使用完整 4 KiB，避免路径很多时把正文挤成不可用的回执。
  return distinctPaths.size > 1 ? 3 * 1024 : MAX_BUNDLE_BODY_BYTES;
}

function bundleReceiptIndex(input: {
  scope: readonly string[];
  matchCount: number;
  windows: number;
  items: readonly InspectItemDetails[];
}): string {
  return [
    "[BUNDLE_RECEIPT scope=" + input.scope.join(",")
      + " matches=" + String(input.matchCount)
      + " windows=" + String(input.windows)
      + "]",
    ...input.items.map((item) => (
      item.path + ":" + String(item.startLine) + "+" + String(item.lineCount)
        + " baseHash=" + item.baseHash
        + " evidence=" + item.evidenceId
        + " receiptOnly=" + String(item.receiptOnly)
    )),
  ].join("\n");
}

function sourceWindowCount(items: readonly InspectItemDetails[]): number {
  return items.filter((item) => !item.receiptOnly).length;
}

function sourceFileCount(items: readonly InspectItemDetails[]): number {
  return new Set(items.filter((item) => !item.receiptOnly).map((item) => item.path)).size;
}

export async function inspectBundle(
  context: InspectionContext,
  input: InspectInput,
  search: SearchResult,
  worktreeHash: string,
  signal?: AbortSignal,
): Promise<{ text: string; details: InspectDetails }> {
  const ranges = bundleRanges(search.text);
  // 先读取未持久化 preview，按最终正文和索引预算选择窗口；被预算淘汰的窗口
  // 不会进入 Evidence Ledger，后续精确 read 仍会返回真实源码。
  const previews: Array<{
    range: InspectReadRange;
    preview: Awaited<ReturnType<typeof previewReadRange>>;
  }> = [];
  for (const range of ranges) {
    previews.push({
      range,
      preview: await previewReadRange(context, range, signal),
    });
  }
  const outputs: string[] = [];
  const items: InspectItemDetails[] = [];
  const selected: typeof previews = [];
  for (const candidate of previews) {
    const candidateOutputs = [...outputs, candidate.preview.text];
    const candidateItems = [...items, ...candidate.preview.items];
    const index = bundleReceiptIndex({
      scope: search.scope,
      matchCount: search.matchCount,
      windows: sourceWindowCount(candidateItems),
      items: candidateItems,
    });
    const candidateBody = [index, ...candidateOutputs].join("\n");
    if (Buffer.byteLength(candidateBody, "utf8") > bundleBodyBudget(previews)) continue;
    selected.push(candidate);
    outputs.push(candidate.preview.text);
    items.push(...candidate.preview.items);
  }

  // 预算确定后才执行真正的读取/证据写入；preview 的占位 ID 与真实 ID 等长，
  // 因而最终正文仍满足同一预算。已有覆盖窗口只生成回执，不重复保存正文。
  outputs.length = 0;
  items.length = 0;
  for (const candidate of selected) {
    const output = await capturePreviewReadRange(context, candidate.preview);
    outputs.push(output.text);
    items.push(...output.items);
  }
  const index = bundleReceiptIndex({
    scope: search.scope,
    matchCount: search.matchCount,
    windows: sourceWindowCount(items),
    items,
  });
  const captured = await captureInspectionText(context, input, [index, ...outputs].join("\n"), {
    baseHash: null,
    worktreeHash,
    scope: search.scope,
    links: [...new Set(items.map((item) => item.evidenceId))],
    matchCount: search.matchCount,
    complete: search.complete,
    bundleWindows: sourceWindowCount(items),
    candidateFiles: countSearchCandidateFiles(search.text),
    selectedFiles: sourceFileCount(items),
  });
  captured.details.items = items;
  return captured;
}
