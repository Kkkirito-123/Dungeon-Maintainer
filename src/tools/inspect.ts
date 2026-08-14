/**
 * 受限代码检查工具。
 *
 * `inspect` 提供 Git 状态、浅目录树、文本搜索、分页读取和 worktree Diff 五种只读
 * 操作。每次最多返回 400 行或 48 KiB，并给正文生成证据 ID 与 SHA-256；模型只能
 * 引用该证据，不能借此读取 `.env`、生成目录、仓库外符号链接或完整二进制文件。
 * 搜索使用固定参数启动 `rg`，不接收 Shell 字符串；未安装 `rg` 时明确失败。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { classifyPath, resolveProjectPath } from "../safety/policy.js";
import { hashBytes, hashFile, readRepo } from "../safety/worktree.js";
import { redactText } from "../safety/redact.js";
import { audit, checkAbort, type ToolContext, type ToolOutput } from "./context.js";

const exec = promisify(execFile);
const MAX_LINES = 400;
const MAX_BYTES = 48 * 1024;

/** `inspect` 的严格参数；各操作只读取其需要的字段。 */
export const InspectParams = Type.Object({
  action: Type.Union([
    Type.Literal("status"), Type.Literal("tree"), Type.Literal("search"),
    Type.Literal("read"), Type.Literal("diff"),
  ]),
  path: Type.Optional(Type.String({ maxLength: 300 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
}, { additionalProperties: false });

/** `inspect` 工具参数类型。 */
export type InspectInput = Static<typeof InspectParams>;

/** 可验证的只读证据。 */
export interface InspectResult {
  action: InspectInput["action"];
  evidenceId: string;
  hash: string;
  truncated: boolean;
  lines: number;
  /** read 操作对应完整文件的 Hash，供 patch 并发保护；其他操作不返回。 */
  baseHash?: string;
}

function clip(value: string): { text: string; truncated: boolean; lines: number } {
  const source = value.replaceAll("\0", "");
  const rows = source.split(/\r?\n/u);
  let text = rows.slice(0, MAX_LINES).join("\n");
  let truncated = rows.length > MAX_LINES;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_BYTES) {
    text = bytes.subarray(0, MAX_BYTES).toString("utf8");
    truncated = true;
  }
  return { text, truncated, lines: text ? text.split(/\r?\n/u).length : 0 };
}

async function gitDiff(root: string): Promise<string> {
  const result = await exec("git", ["diff", "--no-ext-diff", "--unified=3", "--"], {
    cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  return result.stdout;
}

async function tree(root: string, projectPath = "."): Promise<string> {
  const base = projectPath === "."
    ? { absolute: root, relative: "" }
    : await resolveProjectPath(root, projectPath, "read");
  const output: string[] = [];
  const queue: Array<{ absolute: string; depth: number }> = [{ absolute: base.absolute, depth: 0 }];
  while (queue.length > 0 && output.length < MAX_LINES) {
    const current = queue.shift();
    if (!current || current.depth > 3) continue;
    const entries = (await readdir(current.absolute, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const path = relative(root, `${current.absolute}/${entry.name}`).replaceAll("\\", "/");
      if (!path || classifyPath(path, "read") === "denied") continue;
      output.push(`${"  ".repeat(current.depth)}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        queue.push({ absolute: `${current.absolute}/${entry.name}`, depth: current.depth + 1 });
      }
      if (output.length >= MAX_LINES) break;
    }
  }
  return output.join("\n");
}

async function search(root: string, query: string, projectPath?: string): Promise<string> {
  const target = projectPath
    ? (await resolveProjectPath(root, projectPath, "read")).absolute
    : root;
  try {
    const result = await exec("rg", ["--json", "--line-number", "--color", "never", "--max-count", "80", "--", query, target], {
      cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    const output: string[] = [];
    for (const row of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      const event: unknown = JSON.parse(row);
      if (!event || typeof event !== "object" || !("type" in event) || event.type !== "match" || !("data" in event)) continue;
      const data = event.data as { path?: { text?: unknown }; lines?: { text?: unknown }; line_number?: unknown };
      if (typeof data.path?.text !== "string" || typeof data.lines?.text !== "string") continue;
      const path = relative(root, data.path.text).replaceAll("\\", "/");
      if (!path || path.startsWith("../") || classifyPath(path, "read") === "denied") continue;
      const line = typeof data.line_number === "number" ? data.line_number : 0;
      output.push(`${path}:${String(line)}:${data.lines.text.replace(/\r?\n$/u, "")}`);
      if (output.length >= 80) break;
    }
    return output.join("\n");
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    if (code === "ENOENT") throw new Error("inspect search 需要本机安装 rg");
    if (code === 1 || code === "1") return "";
    // rg 的 stdout 是 JSON 事件流，异常时可能只写出半条事件。原样回传既会绕过
    // 路径过滤，也可能把禁止目录的匹配带入模型，因此失败只暴露中性分类。
    throw new Error("inspect search 执行失败");
  }
}

async function readPage(root: string, path: string, startLine = 1): Promise<string> {
  const target = await resolveProjectPath(root, path, "read");
  const info = await stat(target.absolute);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("inspect 只读取不超过 2 MiB 的文本文件");
  const value = await readFile(target.absolute, "utf8");
  if (value.includes("\0")) throw new Error("inspect 不读取二进制文件");
  return value.split(/\r?\n/u).slice(startLine - 1, startLine - 1 + MAX_LINES)
    .map((line, index) => `${String(startLine + index).padStart(5, " ")} ${line}`).join("\n");
}

/**
 * 执行一次只读检查。
 * @param context 当前任务和隔离 worktree。
 * @param input 严格操作参数；`read` 需要路径，`search` 需要查询文本。
 * @param signal 用户取消信号。
 * @returns 已裁剪正文和可追踪证据元数据。
 * @throws 路径越权、字段缺失、二进制文件或外部命令失败。
 */
export async function inspect(
  context: ToolContext,
  input: InspectInput,
  signal?: AbortSignal,
): Promise<ToolOutput<InspectResult>> {
  checkAbort(signal);
  const root = context.task.worktreeRoot ?? context.task.repoRoot;
  let raw: string;
  if (input.action === "status") {
    const state = await readRepo(root);
    raw = `HEAD ${state.head}\nCLEAN ${String(state.clean)}\n${state.status || "(clean)"}`;
  } else if (input.action === "tree") {
    raw = await tree(root, input.path ?? ".");
  } else if (input.action === "search") {
    if (!input.query) throw new Error("search 必须提供 query");
    raw = await search(root, input.query, input.path);
  } else if (input.action === "read") {
    if (!input.path) throw new Error("read 必须提供 path");
    raw = await readPage(root, input.path, input.startLine);
  } else {
    raw = await gitDiff(root);
  }
  checkAbort(signal);
  const clipped = clip(redactText(raw));
  const hash = hashBytes(Buffer.from(clipped.text, "utf8"));
  const evidenceId = createHash("sha256")
    .update(`${context.task.id}:${input.action}:${hash}`).digest("hex").slice(0, 16);
  await audit(context, "inspect", "ok");
  const baseHash = input.action === "read" && input.path ? await hashFile(root, input.path) : undefined;
  const meta = `[EVIDENCE id=${evidenceId} contentHash=${hash}${baseHash ? ` baseHash=${baseHash}` : ""}]`;
  const details: InspectResult = {
    action: input.action, evidenceId, hash, truncated: clipped.truncated, lines: clipped.lines,
    ...(baseHash ? { baseHash } : {}),
  };
  return {
    text: `${meta}\n${clipped.text}${clipped.truncated ? "\n[内容已按 400 行或 48 KiB 截断]" : ""}`,
    details,
  };
}

/**
 * 创建 Pi Core 可调用的 inspect 工具。
 * @param context 绑定单一任务的执行上下文。
 * @returns 顺序执行且无法访问 Shell 参数的 AgentTool。
 */
export function inspectTool(context: ToolContext): AgentTool<typeof InspectParams, InspectResult> {
  return {
    name: "inspect", label: "检查代码", executionMode: "sequential",
    description: "查看状态、目录树、搜索、分页读取或当前补丁；每次返回有限证据。",
    parameters: InspectParams,
    execute: async (_id, input, signal) => {
      const output = await inspect(context, input, signal);
      return { content: [{ type: "text", text: output.text }], details: output.details };
    },
  };
}
