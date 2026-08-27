/**
 * 当前任务证据卡投影。
 *
 * 本模块只把 EvidenceStore 中已经脱敏的 active 记录压缩为短文本，供每轮动态上下文
 * 使用。它不读取证据工件、不复制源码和检查日志，也不修改证据状态。
 */

import type { EvidenceRecord } from "./types.js";

const CARD_MAX_BYTES = 2 * 1024;
const CARD_MAX_RECORDS = 8;
const KEY_KINDS: readonly EvidenceRecord["kind"][] = [
  "reproduction",
  "claim",
  "change",
  "check",
  "verification",
];

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
    ? " upstream=" + record.links.slice(0, 2).join(",")
    : "";
  const downstream = records
    .filter((candidate) => candidate.links.includes(record.id))
    .slice(0, 2)
    .map((candidate) => candidate.id);
  return "- [" + record.kind + "/" + record.status + "] id=" + record.id
    + location
    + version
    + upstream
    + (downstream.length > 0 ? " downstream=" + downstream.join(",") : "")
    + "；"
    + record.summary.slice(0, 120);
}

function compareRecords(left: EvidenceRecord, right: EvidenceRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * 把当前 active 证据投影为固定格式的渐进式披露卡片。
 *
 * 每种闭环关键事实只保留最新一条，再用最新源码窗口补足八条；高频游戏快照不会进入
 * 模型卡片，但仍保留在账本和 Shell 面板中。这样上下文只承担主动记忆，不复制工件正文。
 */
export function buildEvidenceCard(records: readonly EvidenceRecord[]): string {
  const active = records
    .filter((record) => record.status === "active")
    .sort(compareRecords);
  const selected: EvidenceRecord[] = [];
  for (const kind of KEY_KINDS) {
    const latest = active.filter((record) => record.kind === kind).at(-1);
    if (latest) selected.push(latest);
  }
  for (let index = active.length - 1; index >= 0 && selected.length < CARD_MAX_RECORDS; index -= 1) {
    const record = active[index];
    if (record?.kind === "source" && !selected.some((item) => item.id === record.id)) {
      selected.push(record);
    }
  }
  selected.sort(compareRecords);
  if (selected.length === 0) return "";
  const output: string[] = [];
  let bytes = 0;
  for (const record of selected) {
    const line = cardLine(record, active);
    const lineBytes = Buffer.byteLength(line + (output.length > 0 ? "\n" : ""), "utf8");
    if (bytes + lineBytes > CARD_MAX_BYTES) continue;
    output.push(line);
    bytes += lineBytes;
  }
  return output.join("\n");
}
