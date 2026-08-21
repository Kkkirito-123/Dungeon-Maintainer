/**
 * 项目路径与修改权限策略。
 *
 * 本模块在文件系统层落实自动修改、核心审批和永久禁止三类边界。提示词只能帮助
 * Agent 理解规则，真正的访问必须经过 normalizeProjectPath、classifyPath 和
 * resolveProjectPath。真实路径检查会解析目标或最近存在的父目录，阻止仓库内符号
 * 链接指向外部路径。
 */

import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** 文件相对目标项目的权限类别。 */
export type PathClass = "auto" | "core" | "denied";

/** 一组补丁路径的权限判断。 */
export interface PatchDecision {
  kind: "allow" | "approval" | "deny";
  paths: string[];
  reason: string;
}

const DENIED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".vite",
  "__pycache__",
  ".venv",
  "venv",
]);
const LEGAL_FILES = new Set([
  "license",
  "license.md",
  "copying",
  "attributions.md",
]);
const ROOT_CORE_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "tsconfig.json",
  "vite.config.ts",
  "agents.md",
  "agents.zh-cn.md",
  "architecture.md",
]);

function slash(value: string): string {
  return value.split(sep).join("/");
}

/**
 * 规范化 Agent 提供的项目相对路径。
 *
 * @param value 不允许绝对地址或父目录跳转的路径。
 * @returns 使用正斜杠且没有点段的相对路径。
 * @throws 路径为空、绝对、包含 NUL 或父目录跳转时拒绝。
 */
export function normalizeProjectPath(value: string): string {
  if (!value || value.includes("\0") || isAbsolute(value)) {
    throw new Error("路径必须是非空项目相对路径");
  }
  const normalized = slash(value.replaceAll("\\", "/")).replace(/^\.\//u, "");
  const parts = normalized.split("/").filter(
    (part) => part.length > 0 && part !== ".",
  );
  if (parts.some((part) => part === "..")) {
    throw new Error("路径不得离开项目根目录");
  }
  const result = parts.join("/");
  if (!result) {
    throw new Error("路径必须指向项目内的具体文件");
  }
  return result;
}

async function assertNoLinkedWriteSegment(
  realRoot: string,
  candidate: string,
  normalized: string,
): Promise<void> {
  const segments = relative(realRoot, candidate).split(sep).filter(Boolean);
  let current = realRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("写入路径不能经过符号链接或 junction：" + normalized);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * 对规范相对路径分类。
 *
 * @param path 项目相对路径。
 * @param operation 读取或写入；法律文件只禁止写入。
 * @returns 自动、核心或永久禁止类别。
 */
export function classifyPath(
  path: string,
  operation: "read" | "write",
): PathClass {
  const normalized = normalizeProjectPath(path);
  const lower = normalized.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1) ?? "";
  if (
    parts.some((part) => DENIED_SEGMENTS.has(part))
    || name === ".env"
    || name.startsWith(".env.")
    || name.includes("credential")
    || name.includes("secret")
    || name === "auth.json"
  ) {
    return "denied";
  }
  if (operation === "write" && LEGAL_FILES.has(name)) return "denied";
  if (
    lower.startsWith("game/docs/")
    || lower.startsWith("game/tests/")
    || lower.startsWith("game/src/presentation/")
  ) {
    return "auto";
  }
  if (
    lower.startsWith("game/src/domain/")
    || lower.startsWith("game/src/content/")
    || lower.startsWith("game/src/contracts/")
    || lower.startsWith("game/src/infrastructure/")
    || lower.startsWith("game/src/application/")
    || lower.startsWith("game/src/devtools/")
    || lower.startsWith("agent/")
    || lower.startsWith("scripts/")
    || lower.startsWith(".github/")
    || ROOT_CORE_FILES.has(lower)
  ) {
    return "core";
  }
  return "core";
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("找不到可验证的父目录");
      current = parent;
    }
  }
}

/**
 * 解析并验证项目路径，阻止符号链接逃逸。
 *
 * @param root 目标仓库或任务 worktree 根目录。
 * @param projectPath Agent 提供的相对路径。
 * @param operation 读取或写入。
 * @returns 经过真实路径边界验证的绝对路径和规范相对路径。
 * @throws 路径永久禁止或真实路径落到仓库外时拒绝。
 */
export async function resolveProjectPath(
  root: string,
  projectPath: string,
  operation: "read" | "write",
): Promise<{ absolute: string; relative: string }> {
  const normalized = normalizeProjectPath(projectPath);
  if (classifyPath(normalized, operation) === "denied") {
    throw new Error("禁止访问路径：" + normalized);
  }
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, normalized);
  if (operation === "write") {
    // 即使链接仍指向 worktree 内部，也不能把可变链接当成冻结的批准文件；否则
    // 审批后替换链接即可把同一相对路径重定向到另一目标。
    await assertNoLinkedWriteSegment(realRoot, candidate, normalized);
  }
  const existing = await nearestExisting(candidate);
  const realExisting = await realpath(existing);
  const escaped = relative(realRoot, realExisting);
  // 只做字符串前缀检查不足以防止 junction 或符号链接逃逸，必须比较 realpath。
  if (escaped.startsWith("..") || isAbsolute(escaped)) {
    throw new Error("路径通过符号链接离开项目：" + normalized);
  }
  return { absolute: candidate, relative: normalized };
}

/**
 * 判断一组文件的写权限。
 *
 * @param paths 计划修改的项目相对路径。
 * @returns 永久拒绝、需要 Pi 确认框或可自动修改。
 */
export function decidePatch(paths: readonly string[]): PatchDecision {
  const normalized = [...new Set(paths.map(normalizeProjectPath))].sort();
  const denied = normalized.filter(
    (path) => classifyPath(path, "write") === "denied",
  );
  if (denied.length > 0) {
    return {
      kind: "deny",
      paths: denied,
      reason: "包含永久禁止修改的路径",
    };
  }
  const core = normalized.filter(
    (path) => classifyPath(path, "write") === "core",
  );
  if (core.length > 0) {
    return {
      kind: "approval",
      paths: core,
      reason: "核心路径需要本次精确补丁审批",
    };
  }
  return {
    kind: "allow",
    paths: normalized,
    reason: "全部位于自动修改范围",
  };
}
