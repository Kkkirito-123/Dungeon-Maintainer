/**
 * 证据链的低敏读取投影。
 *
 * 本模块是模型 `evidence` 工具与统一 Shell 面板共享的唯一展示边界：它只暴露证据
 * 类型、状态、摘要、源码范围、版本 Hash 和图关系，不返回原始 metadata、绝对路径或
 * 模型正文。工件读取按证据类型限定在当前任务的 evidence/checks/reproductions 目录，
 * 同时执行 realpath 校验、二次脱敏和固定尾部裁剪，不能借 artifactRef 读取其它任务文件。
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactText } from "../logging/redact.js";
import type { EvidenceStore } from "./store.js";
import type {
  EvidenceKind,
  EvidenceRecord,
  EvidenceStatus,
} from "./types.js";

const ARTIFACT_MAX_BYTES = 4 * 1024;
const ARTIFACT_MAX_LINES = 80;

/** 模型与 Shell 共用的有限证据节点。 */
export interface EvidenceNode {
  id: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  summary: string;
  path: string | null;
  startLine: number | null;
  lineCount: number | null;
  baseHash: string | null;
  worktreeHash: string | null;
  upstreamIds: string[];
  downstreamIds: string[];
  createdAt: string;
}

/** `evidence(get)` 可返回的受限工件尾部。 */
export interface EvidenceArtifactPreview {
  available: boolean;
  kind: "source" | "check" | "reproduction" | "unsupported";
  text: string;
  truncated: boolean;
  reason: "available" | "unsupported" | "missing" | "unsafe";
}

/** 单条证据及其可选工件预览。 */
export interface EvidenceDetail {
  revision: number;
  record: EvidenceNode;
  artifact: EvidenceArtifactPreview;
}

/** Shell SSE 使用的当前任务全量低敏快照。 */
export interface EvidenceSnapshot {
  taskId: string;
  revision: number;
  records: EvidenceNode[];
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(".." + sep)
    && !isAbsolute(fromRoot);
}

function nodeFromRecord(
  record: EvidenceRecord,
  records: readonly EvidenceRecord[],
): EvidenceNode {
  const knownIds = new Set(records.map((item) => item.id));
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    summary: record.summary.slice(0, 800),
    path: record.path,
    startLine: record.startLine,
    lineCount: record.lineCount,
    baseHash: record.baseHash,
    worktreeHash: record.worktreeHash,
    upstreamIds: record.links.filter((id) => knownIds.has(id)),
    downstreamIds: records
      .filter((candidate) => candidate.links.includes(record.id))
      .map((candidate) => candidate.id),
    createdAt: record.createdAt,
  };
}

function artifactKind(record: EvidenceRecord): EvidenceArtifactPreview["kind"] {
  return record.kind === "source"
    || record.kind === "check"
    || record.kind === "reproduction"
    ? record.kind
    : "unsupported";
}

function unavailableArtifact(
  kind: EvidenceArtifactPreview["kind"],
  reason: EvidenceArtifactPreview["reason"],
): EvidenceArtifactPreview {
  return { available: false, kind, text: "", truncated: false, reason };
}

function clipArtifact(value: string): { text: string; truncated: boolean } {
  const redacted = redactText(value).replaceAll("\0", "");
  const allLines = redacted.split(/\r?\n/u);
  const lines = allLines.slice(-ARTIFACT_MAX_LINES);
  let text = lines.join("\n");
  let truncated = lines.length < allLines.length;
  while (Buffer.byteLength(text, "utf8") > ARTIFACT_MAX_BYTES && text.length > 0) {
    truncated = true;
    text = text.slice(Math.max(1, Math.floor(text.length / 16)));
  }
  return { text, truncated };
}

function expectedArtifactRoot(store: EvidenceStore, record: EvidenceRecord): string | null {
  const taskDirectory = join(store.dataDir, "tasks", store.task.id);
  if (record.kind === "source") return join(taskDirectory, "evidence");
  if (record.kind === "check") return join(taskDirectory, "checks");
  if (record.kind === "reproduction") return join(taskDirectory, "reproductions");
  return null;
}

function expectedArtifactPath(
  store: EvidenceStore,
  record: EvidenceRecord,
): string | null {
  const taskDirectory = join(store.dataDir, "tasks", store.task.id);
  if (!record.artifactRef) return null;
  const candidate = resolve(taskDirectory, record.artifactRef);
  if (record.kind === "source") {
    const expected = join(taskDirectory, "evidence", record.id + ".txt");
    return resolve(candidate) === resolve(expected) ? candidate : null;
  }
  if (record.kind === "reproduction") {
    const reproductionId = record.metadata.reproductionId;
    if (typeof reproductionId !== "string") return null;
    const expected = join(taskDirectory, "reproductions", reproductionId + ".json");
    return resolve(candidate) === resolve(expected) ? candidate : null;
  }
  return record.kind === "check" ? candidate : null;
}

/**
 * 读取一条证据的安全工件尾部。
 *
 * 路径必须同时通过类型目录、预期文件身份与 realpath 三重校验。检查日志允许当前
 * checks 目录内的历史合法文件名；源码和复现则必须与证据 ID/复现 ID 精确对应。
 */
export async function readEvidenceArtifactPreview(
  store: EvidenceStore,
  record: EvidenceRecord,
): Promise<EvidenceArtifactPreview> {
  const kind = artifactKind(record);
  if (kind === "unsupported") return unavailableArtifact(kind, "unsupported");
  const root = expectedArtifactRoot(store, record);
  const candidate = expectedArtifactPath(store, record);
  if (!root || !candidate) {
    return unavailableArtifact(kind, record.artifactRef ? "unsafe" : "missing");
  }
  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    if (!isWithin(realRoot, realCandidate)) return unavailableArtifact(kind, "unsafe");
    const information = await stat(realCandidate);
    if (!information.isFile()) return unavailableArtifact(kind, "unsafe");
    const clipped = clipArtifact(await readFile(realCandidate, "utf8"));
    return {
      available: true,
      kind,
      text: clipped.text,
      truncated: clipped.truncated,
      reason: "available",
    };
  } catch (error) {
    return unavailableArtifact(
      kind,
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe",
    );
  }
}

/** 按模型工具筛选条件返回最新优先的有限证据节点。 */
export async function listEvidenceNodes(
  store: EvidenceStore,
  options: {
    status?: EvidenceStatus | "all";
    kind?: EvidenceKind;
    limit?: number;
  } = {},
): Promise<{ revision: number; records: EvidenceNode[] }> {
  const all = await store.list();
  const status = options.status ?? "active";
  const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
  const selected = all
    .filter((record) => (
      (status === "all" || record.status === status)
      && (!options.kind || record.kind === options.kind)
    ))
    .sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id)
    ))
    .slice(0, limit)
    .map((record) => nodeFromRecord(record, all));
  return { revision: store.revision, records: selected };
}

/** 返回一条当前任务证据及其安全工件预览。 */
export async function getEvidenceDetail(
  store: EvidenceStore,
  evidenceId: string,
): Promise<EvidenceDetail | null> {
  const all = await store.list();
  const record = all.find((candidate) => candidate.id === evidenceId);
  if (!record) return null;
  return {
    revision: store.revision,
    record: nodeFromRecord(record, all),
    artifact: await readEvidenceArtifactPreview(store, record),
  };
}

/** 返回 Shell 面板需要的当前任务全量证据快照。 */
export async function buildEvidenceSnapshot(
  store: EvidenceStore,
): Promise<EvidenceSnapshot> {
  const records = await store.list();
  return {
    taskId: store.task.id,
    revision: store.revision,
    records: records.map((record) => nodeFromRecord(record, records)),
  };
}
