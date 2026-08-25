/**
 * Pi `patch` 精确修改工具。
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
import { Type } from "typebox";
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

const PatchEditParameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 300 }),
  baseHash: Type.String({ minLength: 7, maxLength: 64 }),
  oldText: Type.String({ maxLength: 64 * 1024 }),
  newText: Type.String({ maxLength: 64 * 1024 }),
}, { additionalProperties: false });

/** `patch` 的严格参数契约。 */
export const PatchParameters = Type.Object({
  edits: Type.Array(PatchEditParameters, { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });

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
export function registerPatchTool(
  pi: ExtensionAPI,
  context: PatchToolContext,
): void {
  pi.registerTool({
    name: "patch",
    label: "修改代码",
    description: "在 detached worktree 中按 baseHash 做唯一文本替换或创建文本文件；最多 3 文件、累计 120 行。",
    promptSnippet: "用 patch 在隔离 worktree 做精确修改",
    promptGuidelines: [
      "运行时问题优先用 finish 保存可重放复现；check 是诊断与验证证据，不是写入资格。",
      "patch 必须使用最近 inspect read 返回的 baseHash 和唯一 oldText。",
      "补丁后先观察自动刷新重放结果，再决定是否继续修改。",
    ],
    executionMode: "sequential",
    parameters: PatchParameters,
    async execute(_toolCallId, input, signal, _onUpdate, extensionContext) {
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
      // 回调会在 workspace 层内部执行；用显式状态盒保留结果，避免把异步回调赋值
      // 误判成当前作用域中永远不会发生的控制流，同时不把刷新职责泄漏到安全层。
      const replayState: { current: ReplayResult | null } = { current: null };
      const scopedInput = {
        edits: input.edits.map((edit) => ({
          ...edit,
          path: assertWritePathAllowed(context.task, edit.path),
        })),
      };
      const result = await applyPrecisePatch({
        task: context.task,
        store: context.store,
        evidence: context.evidence,
        confirmCore: async (paths, changedLines) => {
          // 总方案确认已经授权当前 Agent 运行完成其中的代码修改。patch 在诊断阶段
          // 不可见，因此这里无需为同一方案重复打断用户；未获总授权的非标准调用
          // 仍回退到原有精确核心路径确认。
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
          }
        },
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
  });
}
