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

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import type { GameDriver, ReplayResult } from "../../game/driver.js";
import type { EvidenceStore } from "../../evidence/store.js";
import { appendEvent } from "../../logging/events.js";
import { readActiveReproduction } from "../../repair/reproduction.js";
import { replayReproduction } from "../../repair/replay.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import {
  applyPrecisePatch,
  type PrecisePatchResult,
} from "../../workspace/patch.js";
import { assertWritePathAllowed } from "../../workspace/write-scope.js";
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
  isExecutionApproved(): boolean;
}

async function confirmCorePatch(
  context: ExtensionContext,
  task: TaskRecord,
  paths: readonly string[],
  changedLines: number,
): Promise<boolean> {
  if (!context.hasUI) return false;
  const message = [
    "任务目标：" + task.objective,
    "Git 基线：" + task.baseHead,
    "精确路径：",
    ...paths.map((path) => "  - " + path),
    "修改规模：本次约 " + String(changedLines) + " 行补丁成本",
    "授权只绑定本任务、本基线、本路径和本次正文 Hash，且仅可使用一次。",
  ].join("\n");
  return await context.ui.confirm("确认核心代码修改", message);
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
      return await withProgress(
        extensionContext.ui,
        "edit",
        input,
        async (progress) => {
          progress.line("检查写入范围和基线");
          if (!context.isExecutionApproved()) {
            throw new Error("完整修复方案尚未获用户确认，不能修改代码。");
          }
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
            confirmCore: async (paths, changedLines) => {
              // 已批准的方案直接复用授权；其它调用仍走一次性核心确认。
              if (context.isExecutionApproved()) return true;
              return await confirmCorePatch(
                extensionContext,
                context.task,
                paths,
                changedLines,
              );
            },
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
              type: "text",
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
    },
  });
}
