/**
 * 基于 baseHash 的精确文本补丁。
 *
 * patch 只支持唯一旧文本替换或创建新文本文件，不支持删除、移动、模糊匹配、整仓库
 * 格式化和任意覆盖。所有文件先完成路径、真实路径、Hash、预算、隐私和唯一匹配校验，
 * 核心路径再通过 Pi 确认框绑定本次精确补丁摘要。确认拒绝时不会写入任何字节。
 *
 * beforePatch 必须在第一字节写入前建立浏览器复现检查点；afterPatch 在写入后等待 Vite
 * 并执行刷新重放。回调失败会保留 worktree 改动和事件证据，但绝不会触碰正式仓库。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendEvent } from "../logging/events.js";
import { selectChangeUpstreamIds } from "../evidence/links.js";
import { changeEvidence } from "../evidence/projector.js";
import type { EvidenceStore } from "../evidence/store.js";
import { containsCredentialText } from "../logging/redact.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { hashBytes, hashFile, hashWorktree, pathExists } from "./git.js";
import {
  classifyPath,
  decidePatch,
  resolveProjectPath,
} from "./policy.js";
import { assertWritePathAllowed } from "./write-scope.js";

const MAX_FILES = 3;
const MAX_LINES = 120;
const MAX_TEXT_BYTES = 64 * 1024;

/** 单个精确文本修改。 */
export interface PreciseEdit {
  path: string;
  baseHash: string;
  oldText: string;
  newText: string;
}

/** 一次 patch 调用。 */
export interface PrecisePatchInput {
  edits: PreciseEdit[];
}

/** patch 成功后的低敏结果。 */
export interface PrecisePatchResult {
  paths: string[];
  hashes: Record<string, string>;
  changedLines: number;
}

/** patch 所需的任务、审批和浏览器生命周期依赖。 */
export interface PatchExecutionContext {
  task: TaskRecord;
  store: TaskStore;
  evidence?: EvidenceStore;
  confirmCore(paths: readonly string[], changedLines: number): Promise<boolean>;
  beforePatch(): Promise<void>;
  afterPatch(): Promise<void>;
}

function lineCost(oldText: string, newText: string): number {
  const count = (value: string): number => (
    value.length === 0 ? 0 : value.split(/\r?\n/u).length
  );
  return count(oldText) + count(newText);
}

interface NormalizedTextView {
  readonly text: string;
  /** 规范化文本每个边界对应的原始 UTF-16 偏移。 */
  readonly offsets: readonly number[];
}

/**
 * 构造可安全回写的换行规范化视图。
 *
 * @remarks 仅把 CRLF/CR 视为 LF 用于匹配；offsets 让替换仍保留未触及区域的原始字节。
 */
function normalizedTextView(value: string): NormalizedTextView {
  const characters: string[] = [];
  const offsets: number[] = [0];
  let index = 0;
  while (index < value.length) {
    const start = index;
    if (value[index] === "\r") {
      index += value[index + 1] === "\n" ? 2 : 1;
      characters.push("\n");
    } else {
      index += 1;
      characters.push(value.slice(start, index));
    }
    offsets.push(index);
  }
  return { text: characters.join(""), offsets };
}

/** 在原始匹配片段的换行风格下渲染模型替换正文。 */
function replacementWithLocalNewlines(
  newText: string,
  originalMatch: string,
  surroundingText: string,
): string {
  let newline = "\n";
  if (originalMatch.includes("\r\n")) {
    newline = "\r\n";
  } else if (surroundingText.includes("\r\n")) {
    // oldText 常常只包含一行；优先采用匹配片段之后的行尾，混合换行文件
    // 才能保留目标行自身风格，而不是被上一行的 CRLF 带偏。
    const after = surroundingText.slice(surroundingText.indexOf(originalMatch) + originalMatch.length);
    newline = after.startsWith("\r\n") ? "\r\n" : "\n";
  }
  return newText.replace(/\r\n|\r|\n/gu, newline);
}

function patchDigest(
  task: TaskRecord,
  edits: readonly PreciseEdit[],
): string {
  const safeShape = edits.map((edit) => ({
    path: edit.path,
    baseHash: edit.baseHash,
    oldHash: hashBytes(Buffer.from(edit.oldText, "utf8")),
    newHash: hashBytes(Buffer.from(edit.newText, "utf8")),
  }));
  return createHash("sha256").update(JSON.stringify({
    taskId: task.id,
    baseHead: task.baseHead,
    edits: safeShape,
  })).digest("hex");
}

/**
 * 在 detached worktree 中应用一批精确修改。
 *
 * @param context 绑定当前任务和 Pi 确认框的执行上下文。
 * @param input 最多三个文件的精确编辑。
 * @param signal 用户取消信号。
 * @returns 路径、最新 Hash 和累计行数成本。
 */
export async function applyPrecisePatch(
  context: PatchExecutionContext,
  input: PrecisePatchInput,
  signal?: AbortSignal,
): Promise<PrecisePatchResult> {
  signal?.throwIfAborted();
  const { task, store } = context;
  if (task.state === "applied" || task.state === "discarded") {
    throw new Error("终态任务不能继续修改");
  }
  if (
    task.state === "verifying"
    || task.state === "ready_to_apply"
    || task.state === "blocked"
  ) {
    // 检查会把任务置为 verifying，而静态错误通常正是先检查失败、再进入修改。
    // 审批状态机只从 active 发起，因此补丁校验前先显式回到可编辑状态。
    await store.transition(task, "active");
  }
  if (task.state !== "active") {
    throw new Error("当前任务状态不能修改代码");
  }
  if (input.edits.length < 1 || input.edits.length > MAX_FILES) {
    throw new Error("patch 每次必须包含 1 到 3 个文件");
  }
  const rawPaths = input.edits.map((edit) => assertWritePathAllowed(task, edit.path));
  if (new Set(rawPaths).size !== rawPaths.length) {
    throw new Error("同一批 patch 不能重复修改同一路径");
  }
  const decision = decidePatch(rawPaths);
  if (decision.kind === "deny") {
    throw new Error("补丁越权：" + decision.paths.join(", "));
  }
  const changedLines = input.edits.reduce(
    (total, edit) => total + lineCost(edit.oldText, edit.newText),
    0,
  );
  if (task.patchLines + changedLines > MAX_LINES) {
    throw new Error("PATCH_BUDGET_EXCEEDED: 单任务最多修改 120 行");
  }
  if (input.edits.some((edit) => (
    Buffer.byteLength(edit.oldText, "utf8") > MAX_TEXT_BYTES
    || Buffer.byteLength(edit.newText, "utf8") > MAX_TEXT_BYTES
  ))) {
    throw new Error("单个 patch 文本不能超过 64 KiB");
  }
  if (input.edits.some((edit) => (
    containsCredentialText(edit.oldText) || containsCredentialText(edit.newText)
  ))) {
    throw new Error("patch 不允许凭据正文");
  }

  const staged: Array<{
    absolute: string;
    relative: string;
    content: string;
  }> = [];
  for (const edit of input.edits) {
    signal?.throwIfAborted();
    const target = await resolveProjectPath(
      task.worktreeRoot,
      edit.path,
      "write",
    );
    const currentHash = await hashFile(task.worktreeRoot, target.relative);
    if (currentHash !== edit.baseHash) {
      throw new Error("baseHash 冲突：" + target.relative);
    }
    const present = await pathExists(target.absolute);
    if (!present) {
      if (edit.baseHash !== "missing" || edit.oldText !== "") {
        throw new Error("新文件必须使用 missing Hash 和空 oldText");
      }
      staged.push({ ...target, content: edit.newText });
      continue;
    }
    const current = await readFile(target.absolute, "utf8");
    if (current.includes("\0")) {
      throw new Error("不支持二进制文件：" + target.relative);
    }
    if (!edit.oldText || edit.oldText === edit.newText) {
      throw new Error("替换必须提供不同的非空 oldText");
    }
    const currentView = normalizedTextView(current);
    const oldView = normalizedTextView(edit.oldText);
    const first = currentView.text.indexOf(oldView.text);
    if (
      first < 0
      || currentView.text.indexOf(oldView.text, first + oldView.text.length) >= 0
    ) {
      throw new Error("oldText 必须唯一匹配：" + target.relative);
    }
    const originalStart = currentView.offsets[first];
    const originalEnd = currentView.offsets[first + oldView.text.length];
    if (originalStart === undefined || originalEnd === undefined) {
      throw new Error("oldText 匹配范围无效：" + target.relative);
    }
    const originalMatch = current.slice(originalStart, originalEnd);
    staged.push({
      ...target,
      content: current.slice(0, originalStart)
        + replacementWithLocalNewlines(
          edit.newText,
          originalMatch,
          current.slice(Math.max(0, originalStart - 2), Math.min(current.length, originalEnd + 2)),
        )
        + current.slice(originalEnd),
    });
  }

  const allPaths = new Set([
    ...task.changedPaths,
    ...staged.map((item) => item.relative),
  ]);
  if (allPaths.size > MAX_FILES) {
    throw new Error("PATCH_BUDGET_EXCEEDED: 单任务最多修改 3 个文件");
  }

  if (decision.kind === "approval") {
    const digest = patchDigest(task, input.edits);
    await store.requestApproval(task, decision.paths, digest);
    const approved = await context.confirmCore(decision.paths, changedLines);
    await store.resolveApproval(task, approved);
    if (!approved) {
      await appendEvent(store, task.id, "approval.rejected", {
        pathCount: decision.paths.length,
      });
      throw new Error("用户拒绝核心路径修改");
    }
    await store.consumeApproval(task, digest);
    await appendEvent(store, task.id, "approval.used", {
      pathCount: decision.paths.length,
      digest: digest.slice(0, 12),
    });
  }

  // 检查点必须先于第一字节源码写入。即使 Vite 立即观察到文件变化，后续 reload
  // 也只能从这份已确认的复现起点恢复，避免用重置后的楼层伪造修复成功。
  await context.beforePatch();
  for (const item of staged) {
    signal?.throwIfAborted();
    await mkdir(dirname(item.absolute), { recursive: true });
    await writeFile(item.absolute, item.content, "utf8");
  }

  task.changedPaths = [...allPaths].sort();
  task.patchLines += changedLines;
  task.verification = null;
  task.patchPath = null;
  task.reversePatchPath = null;
  const hashes = Object.fromEntries(staged.map((item) => [
    item.relative,
    hashBytes(Buffer.from(item.content, "utf8")),
  ]));
  if (context.evidence) {
    const worktreeHash = await hashWorktree(task.worktreeRoot);
    const paths = staged.map((item) => item.relative);
    const links = selectChangeUpstreamIds(await context.evidence.active(), paths);
    await context.evidence.invalidatePaths(
      paths,
      worktreeHash,
    );
    await context.evidence.capture(changeEvidence(
      paths,
      worktreeHash,
      links,
    ));
  }
  // 核心审批无论批准或拒绝都会回到 active；非核心补丁从入口起也保持 active。
  // 此处只持久化补丁元数据，避免制造一个实际上不可达的重复状态分支。
  await store.save(task);
  await appendEvent(store, task.id, "tool.patch", {
    pathCount: staged.length,
    changedLines,
  });
  await context.afterPatch();
  return {
    paths: staged.map((item) => item.relative),
    hashes,
    changedLines,
  };
}

/** 判断新核心文件是否已经经过当前补丁审批，供测试和诊断使用。 */
export function isCorePath(path: string): boolean {
  return classifyPath(path, "write") === "core";
}
