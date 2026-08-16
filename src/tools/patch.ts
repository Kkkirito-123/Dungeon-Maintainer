/**
 * 精确文本补丁工具。
 *
 * `patch` 只允许“唯一旧文本替换”或许可目录中的新文本文件。调用方必须携带读取时
 * 的 SHA-256 `baseHash`，因此文件在检查后被其他动作改动时会立即拒绝。路径分类、
 * 符号链接真实路径和一次性核心审批均由安全层再次校验；这里不支持删除、移动、
 * 任意覆盖、二进制写入或模糊匹配。3 个文件与 120 行是整个任务的累计预算，模型
 * 不能通过拆成多次工具调用绕过；预算耗尽后明确拒绝，由用户缩小任务或人工处理。
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { classifyPath, decidePatch, resolveProjectPath } from "../safety/policy.js";
import { hashBytes, hashFile } from "../safety/worktree.js";
import { containsPrivateText } from "../safety/redact.js";
import { audit, checkAbort, type ToolContext, type ToolOutput } from "./context.js";

const MAX_FILES = 3;
const MAX_LINES = 120;
const MAX_TEXT = 64 * 1024;

/** 单个精确文本改动。 */
export const PatchEdit = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 300 }),
  baseHash: Type.String({ minLength: 7, maxLength: 64 }),
  oldText: Type.String({ maxLength: MAX_TEXT }),
  newText: Type.String({ maxLength: MAX_TEXT }),
}, { additionalProperties: false });

/** `patch` 的严格参数。 */
export const PatchParams = Type.Object(
  { edits: Type.Array(PatchEdit, { minItems: 1, maxItems: MAX_FILES }) },
  { additionalProperties: false },
);
/** `patch` 工具参数。 */
export type PatchInput = Static<typeof PatchParams>;

/** 补丁写入结果，不回传代码正文。 */
export interface PatchResult {
  paths: string[];
  hashes: Record<string, string>;
  changedLines: number;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function lineCost(oldText: string, newText: string): number {
  const count = (value: string) => value ? value.split(/\r?\n/u).length : 0;
  return count(oldText) + count(newText);
}

/**
 * 在 worktree 中应用一批精确文本改动。
 * @param context 修改任务；普通诊断任务不能调用，试玩任务只能在隔离 worktree 中调用。
 * @param input 最多三个文件的唯一替换或新文件内容。
 * @param signal 用户取消信号。
 * @returns 修改路径、最新 Hash 和行数预算。
 * @throws 无 worktree、Hash 冲突、非唯一匹配、越权路径或预算超限。
 */
export async function patch(
  context: ToolContext,
  input: PatchInput,
  signal?: AbortSignal,
): Promise<ToolOutput<PatchResult>> {
  checkAbort(signal);
  const task = context.task;
  if ((!context.allowPatch && task.mode !== "fix") || !task.worktreeRoot) {
    throw new Error("只有 fix 或试玩任务的隔离 worktree 可以修改");
  }
  const paths = input.edits.map((edit) => edit.path);
  if (new Set(paths).size !== paths.length) throw new Error("同一批补丁不能重复修改同一路径");
  const decision = decidePatch(task, paths);
  if (decision.kind === "deny") throw new Error(`补丁越权：${decision.paths.join(", ")}`);
  if (decision.kind === "approval") throw new Error(`NEEDS_APPROVAL:${decision.paths.join(",")}`);
  const totalLines = input.edits.reduce((sum, edit) => sum + lineCost(edit.oldText, edit.newText), 0);
  const taskPaths = new Set([...task.changedPaths, ...paths]);
  if (taskPaths.size > MAX_FILES) {
    throw new Error(`PATCH_BUDGET_EXCEEDED: 单任务最多修改 ${String(MAX_FILES)} 个文件`);
  }
  if (task.patchLines + totalLines > MAX_LINES) {
    throw new Error(`PATCH_BUDGET_EXCEEDED: 单任务最多修改 ${String(MAX_LINES)} 行`);
  }
  if (input.edits.some((edit) => containsPrivateText(edit.oldText) || containsPrivateText(edit.newText))) {
    throw new Error("patch 不允许 SQL、答案、地图状态或凭据正文进入模型补丁");
  }

  const staged: Array<{ absolute: string; relative: string; content: string }> = [];
  for (const edit of input.edits) {
    checkAbort(signal);
    const target = await resolveProjectPath(task.worktreeRoot, edit.path, "write");
    const currentHash = await hashFile(task.worktreeRoot, target.relative);
    if (currentHash !== edit.baseHash) throw new Error(`baseHash 冲突：${target.relative}`);
    const present = await exists(target.absolute);
    if (!present) {
      if (edit.baseHash !== "missing" || edit.oldText !== "") throw new Error("新文件必须使用 missing Hash 和空 oldText");
      if (classifyPath(target.relative, "write") !== "auto" && !task.approval?.paths.includes(target.relative)) {
        throw new Error(`新核心文件未获批准：${target.relative}`);
      }
      staged.push({ ...target, content: edit.newText });
      continue;
    }
    const current = await readFile(target.absolute, "utf8");
    if (current.includes("\0")) throw new Error(`不支持二进制文件：${target.relative}`);
    if (!edit.oldText || edit.oldText === edit.newText) throw new Error("替换必须提供不同的非空 oldText");
    const first = current.indexOf(edit.oldText);
    if (first < 0 || current.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
      throw new Error(`oldText 必须唯一匹配：${target.relative}`);
    }
    staged.push({ ...target, content: current.slice(0, first) + edit.newText + current.slice(first + edit.oldText.length) });
  }

  // 检查点必须先于第一字节源码写入。Vite 即使立即触发刷新，也只能恢复这份
  // 已确认状态；检查点失败会在 worktree 仍保持原样时终止补丁。
  await context.beforePatch?.();
  for (const item of staged) {
    checkAbort(signal);
    await mkdir(dirname(item.absolute), { recursive: true });
    await writeFile(item.absolute, item.content, "utf8");
  }
  task.changedPaths = [...new Set([...task.changedPaths, ...staged.map((item) => item.relative)])].sort();
  task.patchLines += totalLines;
  if (task.state === "diagnosing" || task.state === "approved" || task.state === "verifying") {
    await context.store.transition(task, "editing");
  }
  else await context.store.save(task);
  const hashes = Object.fromEntries(staged.map((item) => (
    [item.relative, hashBytes(Buffer.from(item.content, "utf8"))] as const
  )));
  await audit(context, "patch", "ok");
  await context.onPatch?.();
  return { text: `已在隔离 worktree 修改 ${String(staged.length)} 个文件；目标分支未变化。`, details: { paths: staged.map((x) => x.relative), hashes, changedLines: totalLines } };
}

/**
 * 创建 Pi Core 可调用的 patch 工具。
 * @param context 绑定 fix 任务的上下文。
 * @returns 仅支持精确替换的顺序工具。
 */
export function patchTool(context: ToolContext): AgentTool<typeof PatchParams, PatchResult> {
  return {
    name: "patch", label: "修改代码", executionMode: "sequential",
    description: "在隔离 worktree 中按 baseHash 做唯一文本替换；不支持删除、移动或任意覆盖。",
    parameters: PatchParams,
    execute: async (_id, input, signal) => {
      const output = await patch(context, input, signal);
      return { content: [{ type: "text", text: output.text }], details: output.details };
    },
  };
}
