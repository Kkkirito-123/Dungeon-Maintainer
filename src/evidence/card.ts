/**
 * 当前任务证据卡投影。
 *
 * 本模块只把 EvidenceStore 中已经脱敏的 active 记录压缩为短文本，供每轮动态上下文
 * 使用。它不读取证据工件、不复制源码和检查日志，也不修改证据状态。
 */

import type { EvidenceRecord } from "./types.js";

const CARD_MAX_BYTES = 4 * 1024;

function cardLine(
  record: EvidenceRecord,
  records: readonly EvidenceRecord[],
): string {
  const location = record.path
    ? " path=" + record.path
      + (record.startLine ? ":" + String(record.startLine) : "")
      + (record.lineCount ? "+" + String(record.lineCount) : "")
    : "";
  const version = record.baseHash
    ? " hash=" + record.baseHash.slice(0, 12)
    : record.worktreeHash ? " worktree=" + record.worktreeHash.slice(0, 12) : "";
  const upstream = record.links.length > 0
    ? " upstream=" + record.links.slice(0, 4).join(",")
    : "";
  const downstream = records
    .filter((candidate) => candidate.links.includes(record.id))
    .slice(0, 4)
    .map((candidate) => candidate.id);
  return "- [" + record.kind + "/" + record.status + "] id=" + record.id
    + location
    + version
    + upstream
    + (downstream.length > 0 ? " downstream=" + downstream.join(",") : "")
    + "；"
    + record.summary.slice(0, 200);
}

/** 把当前 active 证据投影为固定格式的渐进式披露卡片。 */
export function buildEvidenceCard(records: readonly EvidenceRecord[]): string {
  const active = records.filter((record) => record.status === "active");
  const selected = active.slice(-12);
  if (selected.length === 0) return "";
  const output: string[] = [];
  let bytes = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const record = selected[index];
    if (!record) continue;
    const line = cardLine(record, active);
    const lineBytes = Buffer.byteLength(line + (output.length > 0 ? "\n" : ""), "utf8");
    if (bytes + lineBytes > CARD_MAX_BYTES) continue;
    output.unshift(line);
    bytes += lineBytes;
  }
  return output.join("\n");
}
