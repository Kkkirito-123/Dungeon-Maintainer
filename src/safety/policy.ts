/**
 * 项目路径与修改权限策略。
 *
 * 本模块在文件系统层落实“可读、自动修改、核心批准、永久禁止”四类边界。
 * 提示词只能帮助模型理解规则，真正的授权判断必须经过这里；任何绝对路径、`..`、
 * 仓库外符号链接、凭据文件和生成目录都会在文件工具执行前被拒绝。
 */

import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskRecord } from "../runtime/task.js";

/** 文件相对目标项目的权限类别。 */
export type PathClass = "auto" | "core" | "denied";

/** 一次补丁权限判断的结果。 */
export interface PatchDecision {
  kind: "allow" | "approval" | "deny";
  paths: string[];
  reason: string;
}

const deniedSegments = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".vite",
  "__pycache__",
  ".venv",
  "venv",
]);

const legalFiles = new Set(["license", "license.md", "copying", "attributions.md"]);
const rootCoreFiles = new Set([
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
 * 规范化模型提供的项目相对路径。
 * @param value 不允许绝对地址或父目录跳转的路径。
 * @returns 使用 `/` 分隔、无 `.` 段的相对路径。
 * @throws 当路径为空、绝对、越界或包含 NUL 时抛出错误。
 */
export function normalizeProjectPath(value: string): string {
  if (!value || value.includes("\0") || isAbsolute(value)) throw new Error("路径必须是非空项目相对路径");
  const normalized = slash(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("路径不得离开项目根目录");
  return parts.join("/");
}

/**
 * 对相对路径分类。
 * @param path 已规范化的项目相对路径。
 * @param operation `read` 允许查看法律文件，`write` 会额外禁止修改它们。
 * @returns 自动、核心或永久禁止类别。
 */
export function classifyPath(path: string, operation: "read" | "write"): PathClass {
  const normalized = normalizeProjectPath(path);
  const lower = normalized.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1) ?? "";
  if (
    parts.some((part) => deniedSegments.has(part)) ||
    name === ".env" || name.startsWith(".env.") ||
    name.includes("credential") || name.includes("secret") ||
    name === "auth.json"
  ) return "denied";
  if (operation === "write" && legalFiles.has(name)) return "denied";

  if (
    lower.startsWith("game/docs/") ||
    lower.startsWith("game/tests/") ||
    lower.startsWith("game/src/presentation/")
  ) return "auto";

  if (
    lower.startsWith("game/src/domain/") ||
    lower.startsWith("game/src/content/") ||
    lower.startsWith("game/src/contracts/") ||
    lower.startsWith("game/src/infrastructure/storage/") ||
    lower.startsWith("game/src/application/") ||
    lower.startsWith("agent/") ||
    lower.startsWith("scripts/") ||
    lower.startsWith(".github/") ||
    rootCoreFiles.has(lower)
  ) return "core";

  return "core";
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("找不到可验证的父目录");
      current = parent;
    }
  }
}

/**
 * 解析并验证项目路径，阻止符号链接逃逸。
 *
 * @param root 目标仓库根目录。
 * @param projectPath 模型提供的项目相对路径。
 * @param operation 读取或写入，用于应用不同的永久禁止规则。
 * @returns 经过真实路径边界验证的绝对地址和规范相对地址。
 * @throws 当目标或其最近父目录解析到仓库外时抛出错误。
 */
export async function resolveProjectPath(
  root: string,
  projectPath: string,
  operation: "read" | "write",
): Promise<{ absolute: string; relative: string }> {
  const normalized = normalizeProjectPath(projectPath);
  if (classifyPath(normalized, operation) === "denied") throw new Error(`禁止访问路径：${normalized}`);
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, normalized);
  const existing = await nearestExisting(candidate);
  const realExisting = await realpath(existing);
  const escaped = relative(realRoot, realExisting);
  if (escaped.startsWith("..") || isAbsolute(escaped)) throw new Error(`路径通过符号链接离开项目：${normalized}`);
  return { absolute: candidate, relative: normalized };
}

/**
 * 判断一组文件是否可修改。
 *
 * @param task 当前任务；核心批准只对其中绑定的精确路径生效。
 * @param paths 计划修改的项目相对路径。
 * @returns 允许、需要核心批准或永久拒绝。
 */
export function decidePatch(task: TaskRecord, paths: readonly string[]): PatchDecision {
  const normalized = [...new Set(paths.map(normalizeProjectPath))].sort();
  const denied = normalized.filter((path) => classifyPath(path, "write") === "denied");
  if (denied.length > 0) return { kind: "deny", paths: denied, reason: "包含永久禁止修改的路径" };
  const core = normalized.filter((path) => classifyPath(path, "write") === "core");
  if (core.length === 0) return { kind: "allow", paths: normalized, reason: "全部位于自动修改范围" };

  const approval = task.approval;
  // token 在 CLI 输入时即一次性消费；approvedAt 代表绑定路径在本任务内持续获准。
  const approved = approval?.approvedAt !== null;
  const exact = Boolean(approved && approval && core.every((path) => approval.paths.includes(path)));
  if (exact) return { kind: "allow", paths: normalized, reason: "核心路径已获得本任务一次性批准" };
  return { kind: "approval", paths: core, reason: "核心路径需要任务级一次批准" };
}
