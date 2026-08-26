/**
 * Pi `inspect` 受限只读工具。
 *
 * 本文件负责把状态、浅目录、文本搜索、分页读取和 worktree Diff 转换为有限模型证据；
 * 不负责修改文件、执行任意命令或判断修复是否完成。所有路径都先经过 workspace
 * policy 的 realpath 边界检查，搜索仅以固定参数调用 ripgrep。读取默认返回 80 行，
 * 单次输出仍不超过 240 行或 4 KiB，并在进入 Pi 上下文前脱敏；`.env`、生成目录、二进制和仓库外符号链接
 * 始终不可读。主要失败模式是路径越权、文件过大、`rg` 缺失或搜索进程异常。
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inspectActionKey, sourceEvidence } from "../../evidence/projector.js";
import type { EvidenceStore } from "../../evidence/store.js";
import type {
  InspectDetails,
  InspectInput,
  InspectItemDetails,
  InspectReadRange,
} from "../../inspection/types.js";
import {
  architectureArea,
  architectureFeature,
  architectureFloorScope,
  architecturePartition,
  architectureReferenceRoots,
  type ArchitectureMap,
  type ArchitectureRoute,
} from "../../inspection/architecture-map.js";
import { appendEvent } from "../../logging/events.js";
import { redactCredentials } from "../../logging/redact.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { hashBytes, hashFile, hashWorktree, readRepo, worktreeDiff } from "../../workspace/git.js";
import {
  classifyPath,
  resolveProjectPath,
} from "../../workspace/policy.js";

const exec = promisify(execFile);
const MAX_LINES = 240;
const MAX_BYTES = 4 * 1024;
const MAX_BODY_BYTES = MAX_BYTES - 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 160;
const BUNDLE_WINDOW_LINES = 48;
const MAX_BUNDLE_LINES = 192;
// 为 bundle 外层 EVIDENCE 头和截断标记预留空间，确保最终返回仍低于 4 KiB。
const MAX_BUNDLE_BODY_BYTES = MAX_BODY_BYTES - 256;
// 为 bundle 索引、路径和证据元数据再预留空间；长单行源码也必须至少留下一个窗口，
// 不能因为默认源码预算过大而把整个 bundle 变成零窗口回执。
const MAX_BUNDLE_SOURCE_BYTES = MAX_BUNDLE_BODY_BYTES - 768;

/** `inspect` 的严格参数契约。 */
export const InspectParameters = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("tree"),
    Type.Literal("bundle"),
    Type.Literal("search"),
    Type.Literal("read"),
    Type.Literal("read_many"),
    Type.Literal("diff"),
  ], {
    description: "定位源码默认选择 bundle；它会一次搜索并返回带 baseHash 的相关源码窗口。只有 bundle 上下文不足时才选择 search/read/read_many。",
  }),
  path: Type.Optional(Type.String({ maxLength: 300 })),
  query: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 160,
    description: "bundle/search 的搜索词；首次源码定位应与 action=bundle 一起使用。",
  })),
  startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
  partitionId: Type.Optional(Type.String({ minLength: 3, maxLength: 80 })),
  featureId: Type.Optional(Type.String({
    pattern: "^feature\\.[a-z][a-z0-9.-]*$",
    maxLength: 100,
    description: "已知功能边界时传稳定 feature ID；搜索严格限制在该功能登记的所有 roots。",
  })),
  floorId: Type.Optional(Type.String({
    pattern: "^floor\\.\\d{2,3}$",
    maxLength: 40,
    description: "已知故障楼层时传稳定 floor scope ID；仍按当前层、相邻层、共享父级服务依次定位。",
  })),
  ranges: Type.Optional(Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 300 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 4 })),
}, { additionalProperties: false });

export type { InspectDetails, InspectInput } from "../../inspection/types.js";

/** 注册工具所需的单任务依赖。 */
export interface InspectToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  architectureMap?(): ArchitectureMap | null;
  architectureRoute?(): ArchitectureRoute | null;
  /** 复用 Extension 循环门禁在同一次外部调用中已经计算的 worktree Hash。 */
  inspectWorktreeHash?(toolCallId: string): string | undefined;
}

function clip(value: string, maximumBytes = MAX_BODY_BYTES): {
  text: string;
  lines: number;
  truncated: boolean;
} {
  const rows = value.replaceAll("\0", "").split(/\r?\n/u);
  let text = rows.slice(0, MAX_LINES).join("\n");
  let truncated = rows.length > MAX_LINES;
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

async function readTree(root: string, projectPath = "."): Promise<string> {
  const base = projectPath === "."
    ? { absolute: root }
    : await resolveProjectPath(root, projectPath, "read");
  const output: string[] = [];
  const queue: Array<{ absolute: string; depth: number }> = [{
    absolute: base.absolute,
    depth: 0,
  }];
  while (queue.length > 0 && output.length < MAX_LINES) {
    const current = queue.shift();
    if (!current || current.depth > 3) continue;
    const entries = (await readdir(current.absolute, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = current.absolute + "/" + entry.name;
      const projectRelative = relative(root, absolute).replaceAll("\\", "/");
      if (
        !projectRelative
        || classifyPath(projectRelative, "read") === "denied"
      ) continue;
      output.push(
        "  ".repeat(current.depth)
        + entry.name
        + (entry.isDirectory() ? "/" : ""),
      );
      // 目录符号链接可能指向仓库外。树只展示名字，不跟随链接继续枚举。
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        queue.push({ absolute, depth: current.depth + 1 });
      }
      if (output.length >= MAX_LINES) break;
    }
  }
  return output.join("\n");
}

interface SearchOutput {
  text: string;
  matchCount: number;
  complete: boolean;
}

async function searchText(
  root: string,
  query: string,
  projectPaths: readonly string[],
): Promise<SearchOutput> {
  const targets = projectPaths.length > 0
    ? await Promise.all(projectPaths.map(async (projectPath) => (
      (await resolveProjectPath(root, projectPath, "read")).absolute
    )))
    : [root];
  try {
    const result = await exec("rg", [
      "--json",
      "--line-number",
      "--color",
      "never",
      "--max-count",
      "81",
      "--",
      query,
      ...targets,
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const matches: Array<{
      path: string;
      line: number;
      text: string;
      order: number;
    }> = [];
    const priority = (candidatePath: string): number => {
      const normalized = candidatePath.replaceAll("\\", "/");
      const lower = candidatePath.toLowerCase();
      let score = 0;
      for (let index = 0; index < projectPaths.length; index += 1) {
        const scope = projectPaths[index]?.replaceAll("\\", "/").replace(/\/$/u, "");
        if (scope && (normalized === scope || normalized.startsWith(scope + "/"))) {
          score += 1_000 - index;
          break;
        }
      }
      if (lower.includes("/src/")) score += 100;
      if (lower.includes("/tests/") || lower.includes("/docs/") || lower.includes("readme")) {
        score -= 250;
      }
      if (lower.includes("agents")) score -= 500;
      return score;
    };
    let order = 0;
    for (const row of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      const event: unknown = JSON.parse(row);
      if (
        !event
        || typeof event !== "object"
        || !("type" in event)
        || event.type !== "match"
        || !("data" in event)
      ) continue;
      const data = event.data as {
        path?: { text?: unknown };
        lines?: { text?: unknown };
        line_number?: unknown;
      };
      if (
        typeof data.path?.text !== "string"
        || typeof data.lines?.text !== "string"
      ) continue;
      const path = relative(root, data.path.text).replaceAll("\\", "/");
      if (
        !path
        || path.startsWith("../")
        || classifyPath(path, "read") === "denied"
      ) continue;
      const line = typeof data.line_number === "number" ? data.line_number : 0;
      matches.push({
        path,
        line,
        text: data.lines.text.replace(/\r?\n$/u, ""),
        order,
      });
      order += 1;
    }
    matches.sort((left, right) => (
      priority(right.path) - priority(left.path)
      || left.order - right.order
    ));
    const selected = matches.slice(0, 80);
    return {
      text: selected.map((match) => (
        match.path + ":" + String(match.line) + ":" + match.text
      )).join("\n"),
      matchCount: matches.length,
      complete: matches.length <= 80,
    };
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    if (code === "ENOENT") throw new Error("inspect search 需要本机安装 rg");
    if (code === 1 || code === "1") return { text: "", matchCount: 0, complete: true };
    // rg 失败时 stdout 可能只有半条 JSON。拒绝回传原始错误，避免绕过路径过滤。
    throw new Error("inspect search 执行失败");
  }
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

interface LineInterval {
  start: number;
  end: number;
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

function readPathCacheKey(path: string): string {
  const normalized = path.replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

interface PreparedReadRange {
  target: Awaited<ReturnType<typeof resolveProjectPath>>;
  startLine: number;
  lineCount: number;
  baseHash: string;
  existing: Awaited<ReturnType<EvidenceStore["active"]>>;
  uncovered: LineInterval[];
}

async function prepareReadRange(
  context: InspectToolContext,
  range: InspectReadRange,
): Promise<PreparedReadRange> {
  const root = context.task.worktreeRoot;
  // 先走一次 realpath 边界检查，再复用它返回的规范项目路径做 Hash、读取和缓存比较。
  const target = await resolveProjectPath(root, range.path, "read");
  const startLine = range.startLine ?? 1;
  const lineCount = range.lineCount ?? DEFAULT_READ_LINES;
  const baseHash = await hashFile(root, target.relative);
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

function receiptText(details: {
  evidenceId: string;
  action: string;
  baseHash?: string | null;
  scope?: readonly string[];
  complete?: boolean | null;
  matchCount?: number | null;
  floorRouteLevel?: InspectDetails["floorRouteLevel"];
  floorScopeCount?: number | null;
}): string {
  return [
    "[CACHE HIT ALREADY_SEEN evidence=" + details.evidenceId + " action=" + details.action + "]",
    details.baseHash ? "baseHash=" + details.baseHash : null,
    details.scope && details.scope.length > 0 ? "scope=" + details.scope.join(",") : null,
    typeof details.matchCount === "number" ? "matches=" + String(details.matchCount) : null,
    typeof details.complete === "boolean" ? "complete=" + String(details.complete) : null,
    details.floorRouteLevel && details.floorRouteLevel !== "none"
      ? "floorRouteLevel=" + details.floorRouteLevel : null,
    typeof details.floorScopeCount === "number"
      ? "floorScopeCount=" + String(details.floorScopeCount) : null,
    "相同有效版本的证据已在上下文中，不重复发送正文。",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function suggestedRanges(searchTextValue: string): string[] {
  const suggestions = new Map<string, LineInterval>();
  for (const row of searchTextValue.split(/\r?\n/u)) {
    const match = /^(.*):(\d+):/u.exec(row);
    if (!match) continue;
    const path = match[1];
    const line = Number(match[2]);
    if (!path || !Number.isSafeInteger(line) || suggestions.has(path)) continue;
    suggestions.set(path, { start: Math.max(1, line - 30), end: line + 50 });
    if (suggestions.size >= 4) break;
  }
  return [...suggestions].map(([path, interval]) => (
    path + ":" + String(interval.start) + "-" + String(interval.end)
  ));
}

async function captureSourceText(
  context: InspectToolContext,
  input: InspectInput,
  raw: string,
  options: {
    baseHash: string | null;
    worktreeHash: string | null;
    scope?: readonly string[];
    matchCount?: number;
    complete?: boolean;
    expanded?: boolean;
    expansionLevel?: string;
    bundleWindows?: number;
    floorRouteLevel?: InspectDetails["floorRouteLevel"];
    floorScopeCount?: number;
  },
): Promise<{ text: string; details: InspectDetails }> {
  const clipped = clip(redactCredentials(raw));
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
    cacheHit: false,
    receiptOnly: false,
    scope: [...resolvedScope],
    ...(options.matchCount === undefined ? {} : { matchCount: options.matchCount }),
    ...(options.complete === undefined ? {} : { complete: options.complete }),
    ...(options.expanded === undefined ? {} : { expanded: options.expanded }),
    ...(options.expansionLevel === undefined ? {} : { expansionLevel: options.expansionLevel }),
    ...(options.bundleWindows === undefined ? {} : { bundleWindows: options.bundleWindows }),
    ...(options.floorRouteLevel === undefined ? {} : { floorRouteLevel: options.floorRouteLevel }),
    ...(options.floorScopeCount === undefined ? {} : { floorScopeCount: options.floorScopeCount }),
  };
  const projected = sourceEvidence(input, details, options.worktreeHash, resolvedScope);
  const saved = await context.evidence.captureText(projected, clipped.text);
  details.evidenceId = saved.record.id;
  return {
    text: renderCapturedText(details.evidenceId, contentHash, options.baseHash, clipped),
    details,
  };
}

/** 生成与真实证据相同形状的有限源码正文；preview 使用固定长度 ID，不写入账本。 */
function renderCapturedText(
  evidenceId: string,
  contentHash: string,
  baseHash: string | null,
  clipped: { text: string; truncated: boolean },
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

async function inspectReadRange(
  context: InspectToolContext,
  range: InspectReadRange,
  signal?: AbortSignal,
): Promise<{ text: string; details: InspectDetails; items: InspectItemDetails[] }> {
  signal?.throwIfAborted();
  const { target, startLine, lineCount, baseHash, existing, uncovered } = await prepareReadRange(
    context,
    range,
  );
  if (uncovered.length === 0) {
    const evidenceId = existing[0]?.id ?? "covered";
    const actionKey = inspectActionKey({
      action: "read",
      path: target.relative,
      startLine,
      lineCount,
    });
    const details: InspectDetails = {
      action: "read",
      evidenceId,
      contentHash: existing[0]?.fingerprint ?? baseHash,
      baseHash,
      lines: 0,
      truncated: false,
      actionKey,
      cacheHit: true,
      receiptOnly: true,
    };
    return {
      text: receiptText({ evidenceId, action: "read", baseHash })
        + "\ncovered=" + target.relative + ":" + String(startLine) + "-"
        + String(startLine + lineCount - 1),
      details,
      items: [{
        path: target.relative,
        startLine,
        lineCount,
        evidenceId,
        baseHash,
        receiptOnly: true,
      }],
    };
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
    const captured = await captureSourceText(context, readInput, raw, {
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
      receiptOnly: false,
    });
  }
  const first = capturedDetails[0];
  if (!first) throw new Error("inspect read 未生成源码证据");
  return {
    text: outputs.join("\n"),
    details: {
      ...first,
      lines: capturedDetails.reduce((sum, details) => sum + details.lines, 0),
      items,
    },
    items,
  };
}

interface SearchScopeStage {
  level: string;
  roots: string[];
  floorScopeCount: number;
}

interface SearchScopePlan {
  stages: SearchScopeStage[];
  locked: boolean;
  cacheScope: string[];
  floorRouted: boolean;
  /** bundle 字面查询零命中时，在同一 feature 范围内使用的稳定职责词正则。 */
  fallbackQuery: string | null;
}

function conceptualSearchQuery(responsibilities: readonly string[]): string | null {
  const terms = [...new Set(responsibilities.flatMap((value) => (
    value.split(/[\s,，、；;：:/与和及]+/u).flatMap((part) => (
      part.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
    ))
  )))];
  const escaped: string[] = [];
  let length = 4;
  for (const term of terms) {
    const candidate = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (length + candidate.length + 1 > 150) break;
    escaped.push(candidate);
    length += candidate.length + 1;
    if (escaped.length >= 10) break;
  }
  return escaped.length > 0 ? "(?:" + escaped.join("|") + ")" : null;
}

function uniqueRoots(values: readonly string[], seen: Set<string>): string[] {
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function searchScopePlan(
  context: InspectToolContext,
  input: InspectInput,
): SearchScopePlan {
  if (input.path) {
    return {
      stages: [{ level: "explicit-path", roots: [input.path], floorScopeCount: 0 }],
      locked: true,
      cacheScope: ["explicit-path:" + input.path],
      floorRouted: false,
      fallbackQuery: null,
    };
  }
  if (input.partitionId) {
    const map = context.architectureMap?.() ?? null;
    const partition = architecturePartition(map, input.partitionId);
    const area = architectureArea(map, input.partitionId);
    const root = partition?.root ?? area?.root;
    if (!root) throw new Error("未知架构分区：" + input.partitionId);
    return {
      stages: [{
        level: partition ? "explicit-partition" : "explicit-area",
        roots: [root],
        floorScopeCount: 0,
      }],
      locked: true,
      cacheScope: [(partition ? "explicit-partition:" : "explicit-area:") + root],
      floorRouted: false,
      fallbackQuery: null,
    };
  }
  const map = context.architectureMap?.() ?? null;
  if (input.featureId) {
    const feature = architectureFeature(map, input.featureId);
    if (!feature) throw new Error("未知架构功能：" + input.featureId);
    const roots = architectureReferenceRoots(map, feature.roots);
    return {
      stages: [{ level: "explicit-feature", roots, floorScopeCount: 0 }],
      locked: true,
      cacheScope: [
        "map-revision:" + String(map?.boundaryRevision ?? 0),
        "explicit-feature:" + feature.id + ":" + roots.join(","),
      ],
      floorRouted: false,
      fallbackQuery: conceptualSearchQuery([feature.responsibility]),
    };
  }
  const route = context.architectureRoute?.() ?? null;
  const explicitFloorScope = input.floorId
    ? architectureFloorScope(map, input.floorId)
    : null;
  if (input.floorId && !explicitFloorScope) throw new Error("未知楼层 scope：" + input.floorId);
  const currentFloorScope = explicitFloorScope ?? route?.currentFloorScope ?? null;
  const neighborFloorScopes = explicitFloorScope
    ? map?.floorScopes.filter((scope) => explicitFloorScope.neighbors.includes(scope.id)) ?? []
    : route?.neighborFloorScopes ?? [];
  const floorSharedPartitions = explicitFloorScope
    ? map?.partitions.filter((partition) => (
      explicitFloorScope.sharedPartitions.includes(partition.id)
    )) ?? []
    : route?.sharedPartitions ?? [];
  if (
    !currentFloorScope
    && (!route || (route.primaryFeatures.length === 0 && route.primaryAreas.length === 0))
  ) {
    return {
      stages: [{ level: "repository", roots: [], floorScopeCount: 0 }],
      locked: false,
      cacheScope: ["repository"],
      floorRouted: false,
      fallbackQuery: null,
    };
  }
  const seen = new Set<string>();
  const stages: SearchScopeStage[] = [];
  const push = (level: string, roots: readonly string[], floorScopeCount = 0): void => {
    const unique = uniqueRoots(roots, seen);
    if (unique.length > 0) stages.push({ level, roots: unique, floorScopeCount });
  };
  if (route && route.primaryFeatures.length > 0) {
    push("feature-primary", route.featurePrimaryRoots);
    push("feature-adjacent", route.featureAdjacentRoots);
    push("feature-shared", route.featureSharedRoots);
    push("feature-fallback", route.featureFallbackRoots);
    if (currentFloorScope) push("floor-context", currentFloorScope.roots, 1);
  } else if (currentFloorScope) {
    push("floor-current", currentFloorScope.roots, 1);
    push(
      "floor-adjacent",
      neighborFloorScopes.flatMap((scope) => scope.roots),
      neighborFloorScopes.length,
    );
    push("floor-shared", floorSharedPartitions.map((partition) => partition.root));
  } else if (route) {
    push("primary-partition", route.primaryPartitions.map((partition) => partition.root));
    push("partition-neighbor", route.neighborPartitions.map((partition) => partition.root));
  }
  const owningAreaIds = new Set(floorSharedPartitions.map((partition) => partition.parentId));
  if (explicitFloorScope) {
    route?.primaryAreas.forEach((area) => owningAreaIds.add(area.id));
  }
  if (currentFloorScope && map) {
    for (const area of map.areas) {
      const areaRoot = area.root.replaceAll("\\", "/").replace(/\/$/u, "");
      if (currentFloorScope.roots.some((root) => (
        root === areaRoot || root.startsWith(areaRoot + "/")
      ))) owningAreaIds.add(area.id);
    }
  }
  const primaryAreas = explicitFloorScope && map
    ? map.areas.filter((area) => owningAreaIds.has(area.id))
    : route?.primaryAreas ?? [];
  const primaryAreaIds = new Set(primaryAreas.map((area) => area.id));
  const neighborAreaIds = new Set(primaryAreas.flatMap((area) => area.neighbors));
  const neighborAreas = explicitFloorScope && map
    ? map.areas.filter((area) => (
      neighborAreaIds.has(area.id) && !primaryAreaIds.has(area.id)
    ))
    : route?.neighborAreas ?? [];
  push("owning-area", primaryAreas.map((area) => area.root));
  push("area-neighbor", neighborAreas.map((area) => area.root));
  stages.push({ level: "repository", roots: [], floorScopeCount: 0 });
  return {
    stages,
    locked: false,
    cacheScope: [
      "map-revision:" + String(map?.boundaryRevision ?? 0),
      ...stages.flatMap((stage) => [stage.level + ":" + (stage.roots.join(",") || ".")]),
    ],
    floorRouted: currentFloorScope !== null && (route?.primaryFeatures.length ?? 0) === 0,
    fallbackQuery: route && route.primaryFeatures.length > 0
      ? conceptualSearchQuery(route.primaryFeatures.map((feature) => feature.responsibility))
      : null,
  };
}

/**
 * 预览一个源码窗口但不写入 Evidence Ledger。
 *
 * bundle 必须先完成最终 4 KiB 预算选择，再提交真正展示的窗口；否则被预算丢弃的
 * 代码会错误地变成 ALREADY_SEEN。preview 只复用同样的路径、Hash、覆盖判断和裁剪
 * 规则，返回固定长度的占位 evidence ID，供预算计算使用。
 */
interface PendingReadCapture {
  input: InspectInput;
  clipped: ReturnType<typeof clip>;
  contentHash: string;
  baseHash: string;
}

interface ReadRangePreview {
  text: string;
  details: InspectDetails;
  items: InspectItemDetails[];
  captures: PendingReadCapture[];
}

async function previewReadRange(
  context: InspectToolContext,
  range: InspectReadRange,
  signal?: AbortSignal,
): Promise<ReadRangePreview> {
  signal?.throwIfAborted();
  const { target, startLine, lineCount, baseHash, existing, uncovered } = await prepareReadRange(
    context,
    range,
  );
  if (uncovered.length === 0) {
    const evidenceId = existing[0]?.id ?? "covered";
    const actionKey = inspectActionKey({
      action: "read",
      path: target.relative,
      startLine,
      lineCount,
    });
    const details: InspectDetails = {
      action: "read",
      evidenceId,
      contentHash: existing[0]?.fingerprint ?? baseHash,
      baseHash,
      lines: 0,
      truncated: false,
      actionKey,
      cacheHit: true,
      receiptOnly: true,
    };
    return {
      text: receiptText({ evidenceId, action: "read", baseHash })
        + "\ncovered=" + target.relative + ":" + String(startLine) + "-"
        + String(startLine + lineCount - 1),
      details,
      items: [{
        path: target.relative,
        startLine,
        lineCount,
        evidenceId,
        baseHash,
        receiptOnly: true,
      }],
      captures: [],
    };
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
    const clipped = clip(redactCredentials(raw), MAX_BUNDLE_SOURCE_BYTES);
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
      cacheHit: false,
      receiptOnly: false,
    };
    outputs.push(renderCapturedText(evidenceId, contentHash, baseHash, clipped));
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
async function capturePreviewReadRange(
  context: InspectToolContext,
  preview: Awaited<ReturnType<typeof previewReadRange>>,
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
      cacheHit: false,
      receiptOnly: false,
    };
    const projected = sourceEvidence(capture.input, projectedDetails, null);
    const saved = await context.evidence.captureText(projected, capture.clipped.text);
    projectedDetails.evidenceId = saved.record.id;
    outputs.push(renderCapturedText(
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
      receiptOnly: false,
    });
  }
  const first = details[0];
  if (!first) throw new Error("inspect bundle 未提交源码窗口");
  return {
    text: outputs.join("\n"),
    details: {
      ...first,
      lines: details.reduce((sum, entry) => sum + entry.lines, 0),
      items,
    },
    items,
  };
}

async function scopedSearch(
  root: string,
  query: string,
  plan: SearchScopePlan,
  followSharedImports = false,
): Promise<SearchOutput & {
  scope: string[];
  expansionLevel: string;
  expanded: boolean;
  floorRouteLevel: NonNullable<InspectDetails["floorRouteLevel"]>;
  floorScopeCount: number;
}> {
  let result: SearchOutput = { text: "", matchCount: 0, complete: true };
  const scope: string[] = [];
  let expansionLevel = plan.stages[0]?.level ?? "repository";
  let floorScopeCount = 0;
  const floorRouteLevel = (level: string): NonNullable<InspectDetails["floorRouteLevel"]> => {
    if (!plan.floorRouted) return "none";
    if (level === "floor-current") return "current";
    if (level === "floor-adjacent") return "adjacent";
    if (level === "floor-shared") return "shared";
    return "fallback";
  };
  const importOnlyMatches = (text: string): boolean => {
    const matches = text.split(/\r?\n/u).filter(Boolean);
    return matches.length > 0 && matches.every((row) => {
      const parsed = /^.*:\d+:(.*)$/u.exec(row);
      const source = parsed?.[1]?.trim() ?? "";
      return /^(?:import\b|export\s+.*\bfrom\b)/u.test(source);
    });
  };
  for (const [index, stage] of plan.stages.entries()) {
    result = await searchText(root, query, stage.roots);
    if (followSharedImports && result.matchCount === 0 && plan.fallbackQuery) {
      result = await searchText(root, plan.fallbackQuery, stage.roots);
    }
    scope.push(...(stage.roots.length > 0 ? stage.roots : ["."]));
    floorScopeCount += stage.floorScopeCount;
    expansionLevel = stage.level;
    if (
      followSharedImports
      && result.matchCount > 0
      && (stage.level === "floor-current" || stage.level === "floor-adjacent")
      && importOnlyMatches(result.text)
    ) {
      const sharedStage = plan.stages.find((candidate) => candidate.level === "floor-shared");
      if (sharedStage) {
        const provider = await searchText(root, query, sharedStage.roots);
        if (provider.matchCount > 0) {
          const sharedScope = sharedStage.roots.length > 0 ? sharedStage.roots : ["."];
          return {
            text: [result.text, provider.text].filter(Boolean).join("\n"),
            matchCount: result.matchCount + provider.matchCount,
            complete: result.complete && provider.complete,
            scope: [...scope, ...sharedScope],
            expansionLevel: sharedStage.level,
            expanded: true,
            floorRouteLevel: "shared",
            floorScopeCount,
          };
        }
      }
    }
    if (result.matchCount > 0 || plan.locked) {
      return {
        ...result,
        scope,
        expansionLevel,
        expanded: index > 0,
        floorRouteLevel: floorRouteLevel(expansionLevel),
        floorScopeCount,
      };
    }
  }
  return {
    ...result,
    scope,
    expansionLevel,
    expanded: plan.stages.length > 1,
    floorRouteLevel: floorRouteLevel(expansionLevel),
    floorScopeCount,
  };
}

function bundleRanges(searchTextValue: string): InspectReadRange[] {
  const selected: Array<InspectReadRange & { end: number }> = [];
  for (const row of searchTextValue.split(/\r?\n/u)) {
    const match = /^(.*):(\d+):/u.exec(row);
    if (!match?.[1] || !match[2]) continue;
    const line = Number(match[2]);
    if (!Number.isSafeInteger(line)) continue;
    const startLine = Math.max(1, line - 16);
    const end = startLine + BUNDLE_WINDOW_LINES;
    if (selected.some((range) => (
      range.path === match[1]
      && startLine < range.end
      && range.startLine !== undefined
      && range.startLine < end
    ))) continue;
    selected.push({ path: match[1], startLine, lineCount: BUNDLE_WINDOW_LINES, end });
    if (selected.length * BUNDLE_WINDOW_LINES >= MAX_BUNDLE_LINES) break;
  }
  return selected.map((range) => ({
    path: range.path,
    startLine: range.startLine ?? 1,
    lineCount: range.lineCount ?? BUNDLE_WINDOW_LINES,
  }));
}

function bundleReceiptIndex(input: {
  scope: readonly string[];
  matchCount: number | undefined;
  windows: number;
  expansionLevel: string | undefined;
  expanded: boolean;
  scopeLocked: boolean;
  floorRouteLevel: InspectDetails["floorRouteLevel"];
  floorScopeCount: number;
  items: readonly InspectItemDetails[];
}): string {
  return [
    "[BUNDLE_RECEIPT scope=" + input.scope.join(",")
      + " matches=" + String(input.matchCount)
      + " windows=" + String(input.windows)
      + " expansionLevel=" + String(input.expansionLevel)
      + " expanded=" + String(input.expanded)
      + " scopeLocked=" + String(input.scopeLocked)
      + " floorRouteLevel=" + String(input.floorRouteLevel)
      + " floorScopeCount=" + String(input.floorScopeCount)
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

/**
 * 执行一次受限只读检查。
 *
 * @param context 当前任务和存储。
 * @param input 严格动作参数；read 需要 path，search 需要 query。
 * @param signal Pi 取消信号。
 * @returns 可进入模型上下文的有限正文与 Hash 元数据。
 * @throws 路径越权、字段缺失、二进制、文件过大或固定外部程序失败。
 */
export async function inspectTask(
  context: InspectToolContext,
  input: InspectInput,
  signal?: AbortSignal,
  knownWorktreeHash?: string,
): Promise<{ text: string; details: InspectDetails }> {
  signal?.throwIfAborted();
  const root = context.task.worktreeRoot;
  if (input.action === "read") {
    if (!input.path) throw new Error("read 必须提供 path");
    return await inspectReadRange(context, {
      path: input.path,
      ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
      ...(input.lineCount === undefined ? {} : { lineCount: input.lineCount }),
    }, signal);
  }
  if (input.action === "read_many") {
    if (!input.ranges || input.ranges.length === 0) throw new Error("read_many 必须提供 ranges");
    const requestedLines = input.ranges.reduce((sum, range) => (
      sum + (range.lineCount ?? DEFAULT_READ_LINES)
    ), 0);
    if (requestedLines > MAX_LINES) throw new Error("read_many 总请求不能超过 240 行");
    const previews: ReadRangePreview[] = [];
    for (const range of input.ranges) {
      previews.push(await previewReadRange(context, range, signal));
    }
    const selected: ReadRangePreview[] = [];
    const previewOutputs: string[] = [];
    const previewItems: InspectItemDetails[] = [];
    const truncatedMarker = "[批量读取结果已按 4 KiB 预算省略未展示范围]";
    const bodyBudget = MAX_BODY_BYTES - Buffer.byteLength("\n" + truncatedMarker, "utf8");
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
        cacheHit: details.every((entry) => entry.cacheHit),
        receiptOnly: details.every((entry) => entry.receiptOnly === true),
        items,
      },
    };
  }

  let raw: string;
  let scope: string[] = [];
  let matchCount: number | undefined;
  let complete: boolean | undefined;
  let expanded = false;
  let expansionLevel: string | undefined;
  let floorRouteLevel: InspectDetails["floorRouteLevel"] = "none";
  let floorScopeCount = 0;
  const worktreeHash = knownWorktreeHash ?? await hashWorktree(root);
  const scopePlan = input.action === "search" || input.action === "bundle"
    ? searchScopePlan(context, input)
    : { stages: [], locked: false, cacheScope: [], floorRouted: false, fallbackQuery: null };
  const actionKey = inspectActionKey(input, scopePlan.cacheScope);
  const validityKey = worktreeHash;
  const cached = await context.evidence.findReusable(actionKey, validityKey);
  if (cached) {
    const cachedScope = typeof cached.metadata.scope === "string"
      ? cached.metadata.scope.split("\n").filter(Boolean)
      : [];
    const cachedMatches = typeof cached.metadata.matchCount === "number"
      ? cached.metadata.matchCount
      : null;
    const cachedComplete = typeof cached.metadata.complete === "boolean"
      ? cached.metadata.complete
      : null;
    return {
      text: receiptText({
        evidenceId: cached.id,
        action: input.action,
        baseHash: cached.baseHash,
        scope: cachedScope,
        matchCount: cachedMatches,
        complete: cachedComplete,
        floorRouteLevel: typeof cached.metadata.floorRouteLevel === "string"
          ? cached.metadata.floorRouteLevel as InspectDetails["floorRouteLevel"]
          : "none",
        floorScopeCount: typeof cached.metadata.floorScopeCount === "number"
          ? cached.metadata.floorScopeCount
          : 0,
      }),
      details: {
        action: input.action,
        evidenceId: cached.id,
        contentHash: cached.fingerprint,
        baseHash: cached.baseHash,
        lines: cached.lineCount ?? 0,
        truncated: false,
        actionKey,
        cacheHit: true,
        receiptOnly: true,
        scope: cachedScope,
        ...(cachedMatches === null ? {} : { matchCount: cachedMatches }),
        ...(cachedComplete === null ? {} : { complete: cachedComplete }),
        expanded: cached.metadata.expanded === true,
        ...(typeof cached.metadata.expansionLevel === "string"
          ? { expansionLevel: cached.metadata.expansionLevel }
          : {}),
        ...(typeof cached.metadata.bundleWindows === "number"
          ? { bundleWindows: cached.metadata.bundleWindows }
          : {}),
        floorRouteLevel: typeof cached.metadata.floorRouteLevel === "string"
          ? cached.metadata.floorRouteLevel as NonNullable<InspectDetails["floorRouteLevel"]>
          : "none",
        floorScopeCount: typeof cached.metadata.floorScopeCount === "number"
          ? cached.metadata.floorScopeCount
          : 0,
      },
    };
  }
  if (input.action === "status") {
    const state = await readRepo(root);
    raw = [
      "HEAD " + state.head,
      "CLEAN " + String(state.clean),
      state.status || "(clean)",
    ].join("\n");
  } else if (input.action === "tree") {
    raw = await readTree(root, input.path ?? ".");
  } else if (input.action === "search" || input.action === "bundle") {
    if (!input.query) throw new Error("search 必须提供 query");
    const result = await scopedSearch(root, input.query, scopePlan, input.action === "bundle");
    scope = result.scope;
    expanded = result.expanded;
    expansionLevel = result.expansionLevel;
    floorRouteLevel = result.floorRouteLevel;
    floorScopeCount = result.floorScopeCount;
    matchCount = result.matchCount;
    complete = result.complete;
    if (input.action === "bundle") {
      const ranges = bundleRanges(result.text);
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
          scope,
          matchCount,
          windows: sourceWindowCount(candidateItems),
          expansionLevel: result.expansionLevel,
          expanded,
          scopeLocked: scopePlan.locked,
          floorRouteLevel: result.floorRouteLevel,
          floorScopeCount: result.floorScopeCount,
          items: candidateItems,
        });
        const candidateBody = [index, ...candidateOutputs].join("\n");
        if (Buffer.byteLength(candidateBody, "utf8") > MAX_BUNDLE_BODY_BYTES) continue;
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
        scope,
        matchCount,
        windows: sourceWindowCount(items),
        expansionLevel: result.expansionLevel,
        expanded,
        scopeLocked: scopePlan.locked,
        floorRouteLevel: result.floorRouteLevel,
        floorScopeCount: result.floorScopeCount,
        items,
      });
      const captured = await captureSourceText(context, input, [index, ...outputs].join("\n"), {
        baseHash: null,
        worktreeHash,
        scope: scopePlan.cacheScope,
        matchCount,
        complete,
        expanded,
        expansionLevel: result.expansionLevel,
        bundleWindows: sourceWindowCount(items),
        floorRouteLevel: result.floorRouteLevel,
        floorScopeCount: result.floorScopeCount,
      });
      captured.details.items = items;
      return captured;
    }
    const suggestions = suggestedRanges(result.text);
    raw = [
      "[SEARCH_RECEIPT scope=" + scope.join(",")
        + " matches=" + String(matchCount)
        + " complete=" + String(complete)
        + " expanded=" + String(expanded)
        + " scopeLocked=" + String(scopePlan.locked)
        + " expansionLevel=" + result.expansionLevel
        + " floorRouteLevel=" + result.floorRouteLevel
        + " floorScopeCount=" + String(result.floorScopeCount)
        + "]",
      suggestions.length > 0 ? "suggestedRanges=" + suggestions.join(",") : "suggestedRanges=(none)",
      result.text || "(no matches)",
    ].join("\n");
  } else {
    raw = await worktreeDiff(root);
  }
  signal?.throwIfAborted();
  return await captureSourceText(context, input, raw, {
    baseHash: null,
    worktreeHash,
    scope: input.action === "search" ? scopePlan.cacheScope : scope,
    ...(matchCount === undefined ? {} : { matchCount }),
    ...(complete === undefined ? {} : { complete }),
    expanded,
    ...(expansionLevel === undefined ? {} : { expansionLevel }),
    floorRouteLevel,
    floorScopeCount,
  });
}

/**
 * 向单个 Pi 会话注册 `inspect`。
 *
 * @param pi 当前 Extension API。
 * @param context 与任务绑定的只读依赖。
 */
export function registerInspectTool(
  pi: ExtensionAPI,
  context: InspectToolContext,
): void {
  pi.registerTool({
    name: "inspect",
    label: "检查代码",
    description: "按游戏楼层 scope 与职责区域查看 Git 状态、浅目录、一次性源码 bundle、文本搜索、分页文件或当前 Diff。",
    promptSnippet: "用 inspect 获取代码与 Git 证据",
    promptGuidelines: [
      "定位源码时默认先用 inspect bundle；只有上下文不足时再补 read/read_many。",
      "修改前必须取得目标文件的 baseHash；bundle 窗口已包含可用于 patch 的 baseHash。",
      "search 默认使用本轮游戏功能路由；给出 path、partitionId 或 featureId 时固定该范围，不要无理由全仓搜索。",
      "功能路由先查 primary/adjacent/shared，再使用楼层上下文和 area；只有没有功能命中时才按当前层、相邻层、共享父级 partition 扩展。相邻层不是复用依赖。",
      "bundle 最多返回 4 个 48 行窗口且总计不超过 192 行；ALREADY_SEEN 不需要再次读取。",
    ],
    executionMode: "sequential",
    parameters: InspectParameters,
    async execute(toolCallId, input, signal) {
      try {
        const output = await inspectTask(
          context,
          input,
          signal,
          context.inspectWorktreeHash?.(toolCallId),
        );
        await appendEvent(context.store, context.task.id, "tool.inspect", {
          action: input.action,
          outcome: output.details.receiptOnly === true ? "receipt" : "execution",
          expanded: output.details.expanded ?? false,
          bundleWindows: output.details.bundleWindows ?? 0,
          floorRouteLevel: output.details.floorRouteLevel ?? "none",
          floorScopeCount: output.details.floorScopeCount ?? 0,
        });
        return {
          content: [{ type: "text", text: output.text }],
          details: output.details,
        };
      } catch (error) {
        await appendEvent(context.store, context.task.id, "tool.inspect", {
          action: input.action,
          outcome: "failure",
          expanded: false,
          bundleWindows: 0,
          floorRouteLevel: "none",
          floorScopeCount: 0,
        });
        throw error;
      }
    },
  });
}
