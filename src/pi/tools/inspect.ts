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
  architecturePartition,
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

/** `inspect` 的严格参数契约。 */
export const InspectParameters = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("tree"),
    Type.Literal("search"),
    Type.Literal("bundle"),
    Type.Literal("read"),
    Type.Literal("read_many"),
    Type.Literal("diff"),
  ]),
  path: Type.Optional(Type.String({ maxLength: 300 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
  partitionId: Type.Optional(Type.String({ minLength: 3, maxLength: 80 })),
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
}

function clip(value: string): {
  text: string;
  lines: number;
  truncated: boolean;
} {
  const rows = value.replaceAll("\0", "").split(/\r?\n/u);
  let text = rows.slice(0, MAX_LINES).join("\n");
  let truncated = rows.length > MAX_LINES;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_BODY_BYTES) {
    text = bytes.subarray(0, MAX_BODY_BYTES).toString("utf8");
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
  root: string,
  projectPath: string,
  startLine = 1,
  lineCount = DEFAULT_READ_LINES,
): Promise<string> {
  const target = await resolveProjectPath(root, projectPath, "read");
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

function receiptText(details: {
  evidenceId: string;
  action: string;
  baseHash?: string | null;
  scope?: readonly string[];
  complete?: boolean | null;
  matchCount?: number | null;
}): string {
  return [
    "[CACHE HIT ALREADY_SEEN evidence=" + details.evidenceId + " action=" + details.action + "]",
    details.baseHash ? "baseHash=" + details.baseHash : null,
    details.scope && details.scope.length > 0 ? "scope=" + details.scope.join(",") : null,
    typeof details.matchCount === "number" ? "matches=" + String(details.matchCount) : null,
    typeof details.complete === "boolean" ? "complete=" + String(details.complete) : null,
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
  };
  const projected = sourceEvidence(input, details, options.worktreeHash, resolvedScope);
  const saved = await context.evidence.captureText(projected, clipped.text);
  details.evidenceId = saved.record.id;
  const metadata = "[EVIDENCE id="
    + details.evidenceId
    + " contentHash="
    + contentHash
    + (options.baseHash ? " baseHash=" + options.baseHash : "")
    + "]";
  return {
    text: metadata
      + "\n"
      + clipped.text
      + (clipped.truncated ? "\n[内容已按 240 行或 4 KiB 截断]" : ""),
    details,
  };
}

async function inspectReadRange(
  context: InspectToolContext,
  range: InspectReadRange,
  signal?: AbortSignal,
): Promise<{ text: string; details: InspectDetails; items: InspectItemDetails[] }> {
  signal?.throwIfAborted();
  const root = context.task.worktreeRoot;
  const startLine = range.startLine ?? 1;
  const lineCount = range.lineCount ?? DEFAULT_READ_LINES;
  const baseHash = await hashFile(root, range.path);
  const existing = (await context.evidence.active("source")).filter((record) => (
    record.actionKey !== null
    &&
    record.path === range.path.replaceAll("\\", "/")
    && record.baseHash === baseHash
    && typeof record.startLine === "number"
    && typeof record.lineCount === "number"
  ));
  const uncovered = uncoveredIntervals(startLine, lineCount, existing.map((record) => ({
    start: record.startLine as number,
    end: (record.startLine as number) + (record.lineCount as number),
  })));
  if (uncovered.length === 0) {
    const evidenceId = existing[0]?.id ?? "covered";
    const actionKey = inspectActionKey({
      action: "read",
      path: range.path,
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
        + "\ncovered=" + range.path + ":" + String(startLine) + "-" + String(startLine + lineCount - 1),
      details,
      items: [{ path: range.path, startLine, lineCount, evidenceId, baseHash, receiptOnly: true }],
    };
  }

  const outputs: string[] = [];
  const items: InspectItemDetails[] = [];
  const capturedDetails: InspectDetails[] = [];
  for (const interval of uncovered) {
    const requestedCount = interval.end - interval.start;
    const readInput: InspectInput = {
      action: "read",
      path: range.path,
      startLine: interval.start,
      lineCount: requestedCount,
    };
    const raw = await readPage(root, range.path, interval.start, requestedCount);
    const captured = await captureSourceText(context, readInput, raw, {
      baseHash,
      worktreeHash: null,
    });
    outputs.push(captured.text);
    capturedDetails.push(captured.details);
    items.push({
      path: range.path,
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
}

interface SearchScopePlan {
  stages: SearchScopeStage[];
  locked: boolean;
  cacheScope: string[];
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
      stages: [{ level: "explicit-path", roots: [input.path] }],
      locked: true,
      cacheScope: ["explicit-path:" + input.path],
    };
  }
  if (input.partitionId) {
    const map = context.architectureMap?.() ?? null;
    const partition = architecturePartition(map, input.partitionId);
    const area = architectureArea(map, input.partitionId);
    const root = partition?.root ?? area?.root;
    if (!root) throw new Error("未知架构分区：" + input.partitionId);
    return {
      stages: [{ level: partition ? "explicit-partition" : "explicit-area", roots: [root] }],
      locked: true,
      cacheScope: [(partition ? "explicit-partition:" : "explicit-area:") + root],
    };
  }
  const route = context.architectureRoute?.() ?? null;
  if (!route || route.primaryAreas.length === 0) {
    return {
      stages: [{ level: "repository", roots: [] }],
      locked: false,
      cacheScope: ["repository"],
    };
  }
  const seen = new Set<string>();
  const stages: SearchScopeStage[] = [];
  const push = (level: string, roots: readonly string[]): void => {
    const unique = uniqueRoots(roots, seen);
    if (unique.length > 0) stages.push({ level, roots: unique });
  };
  push("primary-partition", route.primaryPartitions.map((partition) => partition.root));
  push("partition-neighbor", route.neighborPartitions.map((partition) => partition.root));
  push("owning-area", route.primaryAreas.map((area) => area.root));
  push("area-neighbor", route.neighborAreas.map((area) => area.root));
  stages.push({ level: "repository", roots: [] });
  return {
    stages,
    locked: false,
    cacheScope: stages.flatMap((stage) => [stage.level + ":" + (stage.roots.join(",") || ".")]),
  };
}

async function scopedSearch(
  root: string,
  query: string,
  plan: SearchScopePlan,
): Promise<SearchOutput & { scope: string[]; expansionLevel: string; expanded: boolean }> {
  let result: SearchOutput = { text: "", matchCount: 0, complete: true };
  const scope: string[] = [];
  let expansionLevel = plan.stages[0]?.level ?? "repository";
  for (const [index, stage] of plan.stages.entries()) {
    result = await searchText(root, query, stage.roots);
    scope.push(...(stage.roots.length > 0 ? stage.roots : ["."]));
    expansionLevel = stage.level;
    if (result.matchCount > 0 || plan.locked) {
      return { ...result, scope, expansionLevel, expanded: index > 0 };
    }
  }
  return {
    ...result,
    scope,
    expansionLevel,
    expanded: plan.stages.length > 1,
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
    const outputs = [];
    const items: InspectItemDetails[] = [];
    const details: InspectDetails[] = [];
    for (const range of input.ranges) {
      const output = await inspectReadRange(context, range, signal);
      outputs.push(output.text);
      items.push(...output.items);
      details.push(output.details);
    }
    const batchIndex = [
      "[READ_MANY_RECEIPT items=" + String(items.length) + "]",
      ...items.map((item) => (
        item.path + ":" + String(item.startLine) + "+" + String(item.lineCount)
        + " baseHash=" + item.baseHash
        + " evidence=" + item.evidenceId
        + " receiptOnly=" + String(item.receiptOnly)
      )),
    ].join("\n");
    const combined = clip(batchIndex + "\n" + outputs.join("\n"));
    const first = details[0];
    if (!first) throw new Error("read_many 未生成源码证据");
    return {
      text: combined.text + (combined.truncated ? "\n[批量读取结果已按 240 行或 4 KiB 截断]" : ""),
      details: {
        ...first,
        action: "read_many",
        actionKey: inspectActionKey(input),
        lines: details.reduce((sum, entry) => sum + entry.lines, 0),
        truncated: combined.truncated,
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
  const worktreeHash = await hashWorktree(root);
  const scopePlan = input.action === "search" || input.action === "bundle"
    ? searchScopePlan(context, input)
    : { stages: [], locked: false, cacheScope: [] };
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
    const result = await scopedSearch(root, input.query, scopePlan);
    scope = result.scope;
    expanded = result.expanded;
    expansionLevel = result.expansionLevel;
    matchCount = result.matchCount;
    complete = result.complete;
    if (input.action === "bundle") {
      const ranges = bundleRanges(result.text);
      const outputs: string[] = [];
      const items: InspectItemDetails[] = [];
      for (const range of ranges) {
        const output = await inspectReadRange(context, range, signal);
        const candidate = outputs.length === 0
          ? output.text
          : outputs.join("\n") + "\n" + output.text;
        if (outputs.length > 0 && Buffer.byteLength(candidate, "utf8") > MAX_BODY_BYTES) break;
        outputs.push(output.text);
        items.push(...output.items);
      }
      const index = [
        "[BUNDLE_RECEIPT scope=" + scope.join(",")
          + " matches=" + String(matchCount)
          + " windows=" + String(outputs.length)
          + " expansionLevel=" + result.expansionLevel
          + " expanded=" + String(expanded)
          + " scopeLocked=" + String(scopePlan.locked)
          + "]",
        ...items.map((item) => (
          item.path + ":" + String(item.startLine) + "+" + String(item.lineCount)
          + " baseHash=" + item.baseHash
          + " evidence=" + item.evidenceId
          + " receiptOnly=" + String(item.receiptOnly)
        )),
      ].join("\n");
      const captured = await captureSourceText(context, input, [index, ...outputs].join("\n"), {
        baseHash: null,
        worktreeHash,
        scope: scopePlan.cacheScope,
        matchCount,
        complete,
        expanded,
        expansionLevel: result.expansionLevel,
        bundleWindows: outputs.length,
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
    description: "按游戏职责区域查看 Git 状态、浅目录、一次性源码 bundle、文本搜索、分页文件或当前 Diff。",
    promptSnippet: "用 inspect 获取代码与 Git 证据",
    promptGuidelines: [
      "定位源码时默认先用 inspect bundle；只有上下文不足时再补 read/read_many。",
      "修改前必须取得目标文件的 baseHash；bundle 窗口已包含可用于 patch 的 baseHash。",
      "search 默认使用本轮游戏区域路由；给出 path 或 partitionId 时固定该范围，不要无理由全仓搜索。",
      "bundle 最多返回 4 个 48 行窗口且总计不超过 192 行；ALREADY_SEEN 不需要再次读取。",
    ],
    executionMode: "sequential",
    parameters: InspectParameters,
    async execute(_toolCallId, input, signal) {
      try {
        const output = await inspectTask(context, input, signal);
        await appendEvent(context.store, context.task.id, "tool.inspect", {
          action: input.action,
          outcome: output.details.receiptOnly === true ? "receipt" : "execution",
          expanded: output.details.expanded ?? false,
          bundleWindows: output.details.bundleWindows ?? 0,
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
        });
        throw error;
      }
    },
  });
}
