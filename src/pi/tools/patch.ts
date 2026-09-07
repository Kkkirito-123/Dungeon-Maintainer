/**
 * Pi `edit` 受限修改工具。
 *
 * 本文件只把 Pi 的严格 TypeBox 参数、方案授权和浏览器刷新顺序连接到 workspace
 * patch；真正的路径、realpath、baseHash、唯一匹配、隐私和预算校验均由安全层执行。
 * 有活动复现时，写入前保留复现起点，写入后用新代码恢复检查点并重放同一语义动作。
 * 静态问题无需为了取得写入资格而先制造失败检查。拒绝审批不会写入字节；刷新失败会保留
 * worktree 变化和事件证据，但正式仓库仍不受影响。模型只能在总方案已经获批后看到
 * 本工具，因此核心路径不会再弹出第二个确认框；workspace 层仍保留精确摘要与一次性
 * 消费记录，供非模型调用和安全测试使用。
 */

import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import type { GameDriver, ReplayResult } from "../../game/driver.js";
import type { EvidenceStore } from "../../evidence/store.js";
import { appendEvent } from "../../logging/events.js";
import { redactText } from "../../logging/redact.js";
import { readActiveReproduction } from "../../repair/reproduction.js";
import { replayReproduction } from "../../repair/replay.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import {
  applyPrecisePatch,
  type PrecisePatchResult,
} from "../../workspace/patch.js";
import {
  assertWritePathAllowed,
  validateWriteScopePaths,
} from "../../workspace/write-scope.js";
import { hashWorktree } from "../../workspace/git.js";
import { resolveProjectPath } from "../../workspace/policy.js";
import { withProgress } from "../../progress/reporter.js";

const PatchEditParameters = Type.Object({
  mode: Type.Union([
    Type.Literal("replace"),
    Type.Literal("write"),
    Type.Literal("create"),
  ]),
  path: Type.String({ minLength: 1, maxLength: 300 }),
  baseHash: Type.String({ minLength: 7, maxLength: 64 }),
  oldText: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  newText: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  content: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
}, { additionalProperties: false });

/** `patch` 的严格参数契约。 */
export const PatchParameters = Type.Object({
  edits: Type.Array(PatchEditParameters, { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });

type EditInput = Static<typeof PatchParameters>;

/** 补丁写入及立即重放的有限结果。 */
export interface PatchToolDetails extends PrecisePatchResult {
  replay: {
    passed: boolean;
    actionCount: number;
    failure: string | null;
  } | null;
}

/** 注册工具所需的单任务与浏览器依赖。 */
export interface PatchToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  currentDriver(): GameDriver | null;
  ensureGame(): Promise<GameDriver>;
  approveExecution(): void;
  isExecutionApproved(): boolean;
  setRefreshFailure(failure: string | null): void;
}

class EditAuthorizationError extends Error {
  readonly reasonCode: "authorization-denied" | "authorization-unavailable" | "path-rejected";

  constructor(message: string, reasonCode: EditAuthorizationError["reasonCode"]) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知写入错误";
  return redactText(message).replace(/\s+/gu, " ").trim().slice(0, 400)
    || "未知写入错误";
}

async function recordWriteOutcome(
  context: PatchToolContext,
  outcome: "rejected" | "failed" | "noop" | "mutated" | "mutated_replay_failed",
  worktreeHash: string,
  reasonCode: string,
): Promise<void> {
  await appendEvent(context.store, context.task.id, "tool.write_outcome", {
    toolName: "edit",
    outcome,
    count: 1,
    worktreeHash: worktreeHash.slice(0, 16),
    reasonCode,
  }).catch(() => undefined);
}

async function authorizeEdit(
  context: PatchToolContext,
  extensionContext: ExtensionContext,
  input: EditInput,
): Promise<void> {
  let paths: string[];
  try {
    paths = await validateWriteScopePaths(
      context.task.worktreeRoot,
      input.edits.map((edit) => edit.path),
    );
  } catch (error) {
    throw new EditAuthorizationError(safeFailure(error), "path-rejected");
  }

  if (!context.isExecutionApproved()) {
    const message = [
      "模型准备修改以下文件：",
      ...paths.map((path) => "- " + path),
      "",
      "批准后，本轮只允许修改这些文件；代码仍只写入 detached worktree，最终验证通过后才可 /apply。",
    ].join("\n");
    const approved = extensionContext.hasUI
      && await extensionContext.ui.confirm("是否允许本次代码修改", message);
    const digest = createHash("sha256")
      .update(context.task.id + ":" + context.task.baseHead + ":" + paths.join("\n"))
      .digest("hex");
    await appendEvent(context.store, context.task.id, "execution.approval", {
      digest: digest.slice(0, 16),
      approved,
      pathCount: paths.length,
      source: "first-write",
    }).catch(() => undefined);
    if (!approved) {
      throw new EditAuthorizationError(
        "用户未批准本次代码修改；worktree 保持不变。",
        "authorization-denied",
      );
    }
    try {
      await context.store.approveWriteScope(context.task, paths, digest);
      context.approveExecution();
    } catch (error) {
      throw new EditAuthorizationError(
        "无法保存本次写入授权：" + safeFailure(error),
        "authorization-unavailable",
      );
    }
  }

  try {
    await Promise.all(paths.map(async (path) => {
      const scoped = assertWritePathAllowed(context.task, path);
      await resolveProjectPath(context.task.worktreeRoot, scoped, "write");
    }));
  } catch (error) {
    throw new EditAuthorizationError(safeFailure(error), "path-rejected");
  }
}

/**
 * 向单个 Pi 会话注册 `patch`。
 *
 * @param pi 当前 Extension API。
 * @param context 与一个 taskId/worktree 绑定的执行依赖。
 */
export function registerEditTool(
  pi: ExtensionAPI,
  context: PatchToolContext,
): void {
  pi.registerTool({
    name: "edit",
    label: "修改代码",
    description: "在 detached worktree 中按 baseHash 做唯一替换、整文件写入或创建文本文件；最多 3 文件、累计 120 行。",
    promptSnippet: "用 edit 在隔离 worktree 做受限修改",
    promptGuidelines: [
      "运行时问题优先用 finish 保存可重放复现；check 是诊断与验证证据，不是写入资格。",
      "edit 必须使用最近 inspect read 返回的 baseHash；replace 还必须提供唯一 oldText/newText，write/create 只提供 content。",
      "补丁后先观察自动刷新重放结果，再决定是否继续修改。",
    ],
    executionMode: "sequential",
    parameters: PatchParameters,
    async execute(_toolCallId, input: EditInput, signal, _onUpdate, extensionContext) {
      const beforeHash = await hashWorktree(context.task.worktreeRoot);
      try {
        await authorizeEdit(context, extensionContext, input);
        const response = await withProgress(
          extensionContext.ui,
          "edit",
          input,
          async (progress) => {
          progress.line("检查写入范围和基线");
          const reproduction = await readActiveReproduction(
            context.store,
            context.evidence,
            context.task,
          );
          let driver = context.currentDriver();
          if (reproduction && !driver) {
            throw new Error("活动复现的浏览器会话不可用；先执行 /play 恢复场景");
          }
          progress.line(reproduction ? "保留复现检查点" : "准备补丁");
          // workspace 回调不返回值，用状态盒把重放结果带回工具响应。
          const replayState: { current: ReplayResult | null } = { current: null };
          const scopedInput = {
            edits: await Promise.all(input.edits.map(async (edit) => {
              const path = assertWritePathAllowed(context.task, edit.path);
              if (edit.mode === "replace") {
                if (edit.content !== undefined || edit.oldText === undefined || edit.newText === undefined) {
                  throw new Error("replace 只接受 oldText 和 newText");
                }
                return { path, baseHash: edit.baseHash, oldText: edit.oldText, newText: edit.newText };
              }
              if (edit.oldText !== undefined || edit.newText !== undefined || edit.content === undefined) {
                throw new Error(`${edit.mode} 只接受 content`);
              }
              if (edit.mode === "create") {
                if (edit.baseHash !== "missing") throw new Error("create 必须使用 missing baseHash");
                return { path, baseHash: edit.baseHash, oldText: "", newText: edit.content };
              }
              if (edit.baseHash === "missing") throw new Error("write 不能用于尚未创建的文件");
              const target = await resolveProjectPath(context.task.worktreeRoot, path, "write");
              const oldText = await readFile(target.absolute, "utf8");
              return { path, baseHash: edit.baseHash, oldText, newText: edit.content };
            })),
          };
          progress.line("写入 detached worktree");
          const result = await applyPrecisePatch({
            task: context.task,
            store: context.store,
            evidence: context.evidence,
            beforePatch: async () => {
              // 已有复现时必须保留最初检查点，绝不能在症状发生后重新覆盖起点。
              await driver?.ensureReproductionCheckpoint();
            },
            afterPatch: async () => {
              if (reproduction) {
                progress.line("刷新并重放复现");
                driver ??= await context.ensureGame();
                const replayHash = await hashWorktree(context.task.worktreeRoot);
                replayState.current = await replayReproduction(
                  context.store,
                  context.task,
                  driver,
                  reproduction,
                  replayHash,
                );
                if (!replayState.current.passed) {
                  throw new Error(
                    "新代码刷新后的复现重放失败："
                    + (replayState.current.failure ?? "未知游戏错误"),
                  );
                }
                progress.line("复现重放通过");
              }
            }
          }, scopedInput, signal);
          const replay = replayState.current;
          const details: PatchToolDetails = {
            ...result,
            replay: replay ? {
              passed: replay.passed,
              actionCount: replay.actionCount,
              failure: replay.failure,
            } : null,
          };
          await appendEvent(context.store, context.task.id, "game.refresh", {
            replayed: replay !== null,
            passed: replay?.passed ?? true,
            actionCount: replay?.actionCount ?? 0,
          });
          progress.line("补丁完成：" + result.paths.join(", "));
          return {
            content: [{
              type: "text" as const,
              text: [
                "已在 detached worktree 修改：" + result.paths.join(", "),
                "正式游戏仓库尚未变化。",
                replay
                  ? "右侧游戏已刷新并重放 "
                    + String(replay.actionCount)
                    + " 个语义动作。"
                  : "右侧游戏已加载最新 worktree。",
              ].join("\n"),
            }],
            details,
          };
          },
        );
        const afterHash = await hashWorktree(context.task.worktreeRoot);
        const changed = afterHash !== beforeHash;
        if (changed) context.setRefreshFailure(null);
        await recordWriteOutcome(
          context,
          changed ? "mutated" : "noop",
          afterHash,
          changed ? "worktree-mutated" : "worktree-unchanged",
        );
        return response;
      } catch (error) {
        const afterHash = await hashWorktree(context.task.worktreeRoot);
        const changed = afterHash !== beforeHash;
        if (changed) {
          context.setRefreshFailure(
            "edit 已写入，但右侧刷新重放未通过：" + safeFailure(error),
          );
        }
        await recordWriteOutcome(
          context,
          error instanceof EditAuthorizationError
            ? "rejected"
            : changed ? "mutated_replay_failed" : "failed",
          afterHash,
          error instanceof EditAuthorizationError
            ? error.reasonCode
            : changed ? "refresh-replay-failed" : "tool-execution-failed",
        );
        throw error;
      }
    },
  });
}
