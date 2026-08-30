/** 受限源码发现：浅目录列表、固定参数文本搜索和搜索结果导航。 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { InspectInput } from "./types.js";
import { MAX_INSPECT_LINES } from "./output.js";
import { classifyPath, resolveProjectPath } from "../workspace/policy.js";

const exec = promisify(execFile);

export interface SearchResult {
  text: string;
  matchCount: number;
  complete: boolean;
  scope: string[];
}

export interface SearchScopePlan {
  roots: string[];
}

interface LineInterval {
  start: number;
  end: number;
}

export async function listProjectFiles(root: string, projectPath = "."): Promise<string> {
  const base = projectPath === "."
    ? { absolute: root }
    : await resolveProjectPath(root, projectPath, "read");
  const output: string[] = [];
  const queue: Array<{ absolute: string; depth: number }> = [{
    absolute: base.absolute,
    depth: 0,
  }];
  while (queue.length > 0 && output.length < MAX_INSPECT_LINES) {
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
      // 目录符号链接可能指向仓库外。只展示名字，不跟随链接继续枚举。
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        queue.push({ absolute, depth: current.depth + 1 });
      }
      if (output.length >= MAX_INSPECT_LINES) break;
    }
  }
  return output.join("\n");
}

async function searchText(
  root: string,
  query: string,
  projectPaths: readonly string[],
  literalTerms: readonly string[] = [],
): Promise<Omit<SearchResult, "scope">> {
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
    const literalPriority = (candidatePath: string, text: string): number => {
      const candidate = (candidatePath + "\n" + text).toLocaleLowerCase("en-US");
      return literalTerms.reduce((score, term) => (
        candidate.includes(term.toLocaleLowerCase("en-US"))
          ? Math.max(score, term.length)
          : score
      ), 0);
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
      || literalPriority(right.path, right.text) - literalPriority(left.path, left.text)
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

function literalSearchFallback(query: string): { query: string; terms: string[] } | null {
  const terms = [...new Map(query.trim().split(/\s+/u)
    .filter((term) => term.length >= 2)
    .map((term) => [term.toLocaleLowerCase("en-US"), term])).values()];
  if (terms.length < 2) return null;
  const symbolTerms = terms.filter((term) => (
    /[a-z][A-Z]|[_.$]|[A-Za-z]\d|\d[A-Za-z]/u.test(term)
  ));
  if (symbolTerms.length === 0) return null;
  const candidates = (symbolTerms.length >= 2 ? symbolTerms : terms)
    .sort((left, right) => right.length - left.length);
  const selected: string[] = [];
  let length = 4;
  for (const term of candidates) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (length + escaped.length + 1 > 150) break;
    selected.push(escaped);
    length += escaped.length + 1;
    if (selected.length >= 8) break;
  }
  return selected.length >= 2
    ? { query: "(?:" + selected.join("|") + ")", terms: candidates.slice(0, selected.length) }
    : null;
}

export function planSearchScope(input: InspectInput): SearchScopePlan {
  return { roots: input.path ? [input.path] : [] };
}

export async function runScopedSearch(
  root: string,
  query: string,
  plan: SearchScopePlan,
): Promise<SearchResult> {
  const scope = plan.roots.length > 0 ? plan.roots : ["."];
  const literalFallback = literalSearchFallback(query);
  let result = await searchText(root, query, plan.roots);
  if (result.matchCount === 0 && literalFallback) {
    result = await searchText(root, literalFallback.query, plan.roots, literalFallback.terms);
  }
  return { ...result, scope };
}

export function suggestReadRanges(searchTextValue: string): string[] {
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

export function countSearchCandidateFiles(text: string): number {
  const paths = new Set<string>();
  for (const row of text.split(/\r?\n/u)) {
    const match = /^(.*):(\d+):/u.exec(row);
    if (match?.[1]) paths.add(match[1]);
  }
  return paths.size;
}
