/**
 * 当前任务证据卡投影。
 *
 * 本模块只把 EvidenceStore 中已经脱敏的 active 记录压缩为短文本，供每轮动态上下文
 * 使用。它不读取证据工件、不复制源码和检查日志，也不修改证据状态。
 */

import type { EvidenceRecord } from "./types.js";

/** 把当前 active 证据投影为固定格式的渐进式披露卡片。 */
export function buildEvidenceCard(records: readonly EvidenceRecord[]): string {
  const selected = records
    .filter((record) => (
      record.kind !== "source" || record.metadata.action === "read"
    ))
    .slice(-12);
  if (selected.length === 0) return "当前没有 active 证据。";
  return selected.map((record) => {
    const location = record.path
      ? " path=" + record.path + (record.startLine ? ":" + String(record.startLine) : "")
      : "";
    const version = record.baseHash
      ? " hash=" + record.baseHash.slice(0, 12)
      : record.worktreeHash ? " worktree=" + record.worktreeHash.slice(0, 12) : "";
    return "- [" + record.kind + "] id=" + record.id + location + version
      + "；" + record.summary;
  }).join("\n");
}
