/**
 * 维护器 `edit` 的写入协调器。
 *
 * 本模块只在 Pi 生命周期中执行写入授权、worktree 写前后 Hash 归因、刷新失败门禁和
 * 低敏结果分类。实际文件写入与刷新重放由 `tools/patch.ts` 完成；这里不注册工具、
 * 不加载 Pi 原生 write，也不持有跨请求授权。
 */

import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { hashWorktree } from "../workspace/git.js";
import type { ToolSafetyGate } from "./tool-safety-gate.js";

export interface NativeWriteCoordinatorOptions {
  task: TaskRecord;
  store: TaskStore;
  safetyGate: ToolSafetyGate;
}

/** 与一个 taskId 和 detached worktree 绑定的 edit 生命周期处理函数。 */
export interface NativeWriteCoordinator {
  onToolCall(
    event: ToolCallEvent,
    context: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined>;
  onToolResult(
    event: ToolResultEvent,
    context: ExtensionContext,
  ): Promise<undefined>;
  onTurnEnd(context: ExtensionContext): Promise<void>;
  /** Agent 请求结束时丢弃不能跨请求复用的写前 Hash。 */
  clearRequestAttributions(): void;
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知写入错误";
  return redactText(message).replace(/\s+/gu, " ").trim().slice(0, 400)
    || "未知写入错误";
}

/** 创建当前 Extension 实例唯一的 edit 写入协调器。 */
export function createNativeWriteCoordinator(
  options: NativeWriteCoordinatorOptions,
): NativeWriteCoordinator {
  const { task, store, safetyGate } = options;
  const pendingWriteHashes = new Map<string, string>();
  let lastRefreshFailure: string | null = null;

  const recordWriteOutcome = async (
    outcome: "rejected" | "failed" | "noop" | "mutated" | "mutated_replay_failed",
    worktreeHash: string,
    reasonCode: string,
  ): Promise<void> => {
    try {
      await appendEvent(store, task.id, "tool.write_outcome", {
        toolName: "edit",
        outcome,
        count: 1,
        worktreeHash: worktreeHash.slice(0, 16),
        reasonCode,
      });
    } catch {
      // 低敏审计失败不能反向改变 edit 的执行结果或权限。
    }
  };

  const block = (reason: string): ToolCallEventResult => ({
    block: true,
    terminate: false,
    reason,
  });

  const onToolCall = async (
    event: ToolCallEvent,
    context: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    if (
      event.toolName === "check"
      || (event.toolName === "finish" && event.input.status === "result")
    ) {
      if (pendingWriteHashes.size > 0) {
        return block("代码写入仍在执行，必须等待 edit 返回后再检查或提交结果。");
      }
      if (lastRefreshFailure) {
        return block(
          "代码刷新门禁未通过：" + lastRefreshFailure + " 请继续修复后重试。",
        );
      }
    }
    if (event.toolName !== "edit") return undefined;

    const beforeHash = await hashWorktree(task.worktreeRoot);
    const safety = await safetyGate.authorize(
      "edit",
      event.input,
      context,
    );
    if (safety.kind === "block") {
      await recordWriteOutcome("rejected", beforeHash, safety.reasonCode);
      return block(safety.reason);
    }
    pendingWriteHashes.set(event.toolCallId, beforeHash);
    return undefined;
  };

  const onToolResult = async (event: ToolResultEvent): Promise<undefined> => {
    if (event.toolName !== "edit") return undefined;
    const beforeHash = pendingWriteHashes.get(event.toolCallId);
    pendingWriteHashes.delete(event.toolCallId);
    if (!beforeHash) return undefined;

    const afterHash = await hashWorktree(task.worktreeRoot);
    const changed = afterHash !== beforeHash;
    const details = event.details && typeof event.details === "object"
      ? event.details as Record<string, unknown>
      : null;
    const replay = details?.replay && typeof details.replay === "object"
      ? details.replay as Record<string, unknown>
      : null;
    const refreshFailed = event.isError || replay?.passed === false;

    if (changed && refreshFailed) {
      const failureText = event.content
        .map((item) => item.type === "text" ? item.text : "")
        .filter(Boolean)
        .join(" ");
      lastRefreshFailure = "edit 已写入，但右侧刷新重放未通过："
        + safeFailure(new Error(failureText || "未知刷新错误"));
    } else if (changed) {
      lastRefreshFailure = null;
    }

    await recordWriteOutcome(
      changed
        ? refreshFailed ? "mutated_replay_failed" : "mutated"
        : event.isError ? "failed" : "noop",
      afterHash,
      changed
        ? refreshFailed ? "refresh-replay-failed" : "worktree-mutated"
        : event.isError ? "tool-execution-failed" : "worktree-unchanged",
    );
    return undefined;
  };

  return {
    onToolCall,
    onToolResult,
    onTurnEnd: () => {
      pendingWriteHashes.clear();
      return Promise.resolve();
    },
    clearRequestAttributions: () => pendingWriteHashes.clear(),
  };
}
