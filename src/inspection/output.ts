/** Inspection 各动作共享的输出预算、裁剪和回执格式。 */

import type { EvidenceRecord } from "../evidence/types.js";
import type { InspectDetails } from "./types.js";

export const MAX_INSPECT_LINES = 240;
export const MAX_INSPECT_BYTES = 4 * 1024;
export const MAX_INSPECT_BODY_BYTES = MAX_INSPECT_BYTES - 256;
export const DEFAULT_READ_LINES = 80;
export const MAX_READ_LINES = 160;
export const MAX_BUNDLE_BODY_BYTES = MAX_INSPECT_BODY_BYTES - 256;
export const MAX_BUNDLE_SOURCE_BYTES = MAX_BUNDLE_BODY_BYTES - 768;

export interface ClippedInspectionText {
  text: string;
  lines: number;
  truncated: boolean;
}

export function clipInspectionText(
  value: string,
  maximumBytes = MAX_INSPECT_BODY_BYTES,
): ClippedInspectionText {
  const rows = value.replaceAll("\0", "").split(/\r?\n/u);
  let text = rows.slice(0, MAX_INSPECT_LINES).join("\n");
  let truncated = rows.length > MAX_INSPECT_LINES;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > maximumBytes) {
    text = bytes.subarray(0, maximumBytes).toString("utf8");
    truncated = true;
  }
  return {
    text,
    lines: text ? text.split(/\r?\n/u).length : 0,
    truncated,
  };
}

export function inspectionReceipt(details: {
  evidenceId: string;
  action: string;
  baseHash?: string | null;
  scope?: readonly string[];
  complete?: boolean | null;
  matchCount?: number | null;
  bundleWindows?: number | null;
}): string {
  return [
    "[CACHE HIT ALREADY_SEEN evidence=" + details.evidenceId + " action=" + details.action + "]",
    details.baseHash ? "baseHash=" + details.baseHash : null,
    details.scope && details.scope.length > 0 ? "scope=" + details.scope.join(",") : null,
    typeof details.matchCount === "number" ? "matches=" + String(details.matchCount) : null,
    typeof details.complete === "boolean" ? "complete=" + String(details.complete) : null,
    typeof details.bundleWindows === "number"
      ? "windows=" + String(details.bundleWindows) : null,
    "相同有效版本的证据已在上下文中，不重复发送正文。",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function renderCapturedInspectionText(
  evidenceId: string,
  contentHash: string,
  baseHash: string | null,
  clipped: Pick<ClippedInspectionText, "text" | "truncated">,
): string {
  const metadata = "[EVIDENCE id="
    + evidenceId
    + " contentHash="
    + contentHash
    + (baseHash ? " baseHash=" + baseHash : "")
    + "]";
  return metadata
    + "\n"
    + clipped.text
    + (clipped.truncated ? "\n[内容已按 240 行或 4 KiB 截断]" : "");
}

export function aggregateCacheKind(
  details: readonly InspectDetails[],
): InspectDetails["cacheKind"] {
  const kinds = details.map((entry) => entry.cacheKind);
  if (kinds.includes("none")) return "none";
  return kinds.includes("semantic") ? "semantic" : "exact";
}

export function isSemanticAlias(record: EvidenceRecord, actionKey: string): boolean {
  return record.actionKey !== actionKey
    && record.actionAliases.includes(actionKey);
}
