/**
 * Pi `inspect` 受限只读工具。
 *
 * 本文件负责把状态、浅目录、文本搜索、分页读取和 worktree Diff 转换为有限模型证据；
 * 不负责修改文件、执行任意命令或判断修复是否完成。所有路径都先经过 workspace
 * policy 的 realpath 边界检查，搜索仅以固定参数调用 ripgrep。输出最多 400 行或
 * 8 KiB，并在进入 Pi 上下文前脱敏；`.env`、生成目录、二进制和仓库外符号链接
 * 始终不可读。主要失败模式是路径越权、文件过大、`rg` 缺失或搜索进程异常。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { appendEvent } from "../../logging/events.js";
import { redactText } from "../../logging/redact.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { hashBytes, hashFile, readRepo, worktreeDiff } from "../../workspace/git.js";
import {
  classifyPath,
  resolveProjectPath,
} from "../../workspace/policy.js";

const exec = promisify(execFile);
const MAX_LINES = 400;
const MAX_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** `inspect` 的严格参数契约。 */
export const InspectParameters = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("tree"),
    Type.Literal("search"),
    Type.Literal("read"),
    Type.Literal("diff"),
  ]),
  path: Type.Optional(Type.String({ maxLength: 300 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
}, { additionalProperties: false });

/** `inspect` 参数的 TypeScript 投影。 */
export type InspectInput = Static<typeof InspectParameters>;

/** 返回给 Pi 的低敏证据元数据。 */
export interface InspectDetails {
  action: InspectInput["action"];
  evidenceId: string;
  contentHash: string;
  baseHash: string | null;
  lines: number;
  truncated: boolean;
}

/** 注册工具所需的单任务依赖。 */
export interface InspectToolContext {
  task: TaskRecord;
  store: TaskStore;
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
  if (bytes.byteLength > MAX_BYTES) {
    text = bytes.subarray(0, MAX_BYTES).toString("utf8");
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

async function searchText(
  root: string,
  query: string,
  projectPath?: string,
): Promise<string> {
  const target = projectPath
    ? (await resolveProjectPath(root, projectPath, "read")).absolute
    : root;
  try {
    const result = await exec("rg", [
      "--json",
      "--line-number",
      "--color",
      "never",
      "--max-count",
      "80",
      "--",
      query,
      target,
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const output: string[] = [];
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
      output.push(
        path
        + ":"
        + String(line)
        + ":"
        + data.lines.text.replace(/\r?\n$/u, ""),
      );
      if (output.length >= 80) break;
    }
    return output.join("\n");
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    if (code === "ENOENT") throw new Error("inspect search 需要本机安装 rg");
    if (code === 1 || code === "1") return "";
    // rg 失败时 stdout 可能只有半条 JSON。拒绝回传原始错误，避免绕过路径过滤。
    throw new Error("inspect search 执行失败");
  }
}

async function readPage(
  root: string,
  projectPath: string,
  startLine = 1,
): Promise<string> {
  const target = await resolveProjectPath(root, projectPath, "read");
  const information = await stat(target.absolute);
  if (!information.isFile() || information.size > MAX_FILE_BYTES) {
    throw new Error("inspect 只读取不超过 2 MiB 的文本文件");
  }
  const value = await readFile(target.absolute, "utf8");
  if (value.includes("\0")) throw new Error("inspect 不读取二进制文件");
  return value.split(/\r?\n/u)
    .slice(startLine - 1, startLine - 1 + MAX_LINES)
    .map((line, index) => (
      String(startLine + index).padStart(5, " ") + " " + line
    ))
    .join("\n");
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
  let raw: string;
  let baseHash: string | null = null;
  if (input.action === "status") {
    const state = await readRepo(root);
    raw = [
      "HEAD " + state.head,
      "CLEAN " + String(state.clean),
      state.status || "(clean)",
    ].join("\n");
  } else if (input.action === "tree") {
    raw = await readTree(root, input.path ?? ".");
  } else if (input.action === "search") {
    if (!input.query) throw new Error("search 必须提供 query");
    raw = await searchText(root, input.query, input.path);
  } else if (input.action === "read") {
    if (!input.path) throw new Error("read 必须提供 path");
    raw = await readPage(root, input.path, input.startLine);
    baseHash = await hashFile(root, input.path);
  } else {
    raw = await worktreeDiff(root);
  }
  signal?.throwIfAborted();
  const clipped = clip(redactText(raw));
  const contentHash = hashBytes(Buffer.from(clipped.text, "utf8"));
  const evidenceId = createHash("sha256")
    .update(context.task.id + ":" + input.action + ":" + contentHash)
    .digest("hex")
    .slice(0, 16);
  const details: InspectDetails = {
    action: input.action,
    evidenceId,
    contentHash,
    baseHash,
    lines: clipped.lines,
    truncated: clipped.truncated,
  };
  await appendEvent(context.store, context.task.id, "tool.inspect", {
    action: input.action,
    evidenceId,
    lines: clipped.lines,
    truncated: clipped.truncated,
  });
  const metadata = "[EVIDENCE id="
    + evidenceId
    + " contentHash="
    + contentHash
    + (baseHash ? " baseHash=" + baseHash : "")
    + "]";
  return {
    text: metadata
      + "\n"
      + clipped.text
      + (clipped.truncated ? "\n[内容已按 400 行或 8 KiB 截断]" : ""),
    details,
  };
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
    description: "查看 Git 状态、浅目录、文本搜索、分页文件或当前 Diff；输出受路径和大小限制。",
    promptSnippet: "用 inspect 获取代码与 Git 证据",
    promptGuidelines: [
      "修改前必须用 inspect read 获取目标文件的 baseHash。",
      "优先 search 缩小范围，再分页 read；不要重复读取无关大文件。",
    ],
    executionMode: "sequential",
    parameters: InspectParameters,
    async execute(_toolCallId, input, signal) {
      const output = await inspectTask(context, input, signal);
      return {
        content: [{ type: "text", text: output.text }],
        details: output.details,
      };
    },
  });
}
