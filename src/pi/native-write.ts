/**
 * Pi 原生 write 与精确 patch 的写后协调。
 *
 * 本模块负责写入安全门、原生 write 的目标归因、并行批次、刷新重放门禁和低敏
 * 写入结果分类。它不拥有用户请求状态，也不注册工具或命令；Extension 入口按 Pi
 * 生命周期把这里的处理函数接到 tool_call、tool_result 与 turn_end。
 */

import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { EvidenceStore } from "../evidence/store.js";
import type { GameDriver } from "../game/driver.js";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import type { SemanticTraceEntry } from "../logging/trace.js";
import {
  readActiveReproduction,
  type ReproductionRecord,
} from "../repair/reproduction.js";
import { replayReproduction } from "../repair/replay.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { syncWorktreeChanges } from "../workspace/changes.js";
import { hashBytes, hashFile, hashWorktree } from "../workspace/git.js";
import { normalizeProjectPath } from "../workspace/policy.js";
import type { ToolSafetyGate } from "./tool-safety-gate.js";

const NATIVE_WRITE_TOOLS = new Set(["write"]);
const WRITE_TOOLS = new Set(["write", "patch"]);

interface NativeWriteGameRuntime {
  currentDriver(): GameDriver | null;
  ensure(): Promise<GameDriver>;
}

interface NativeWritePreparation {
  baselineHash: string;
  driver: GameDriver | null;
  actions: readonly SemanticTraceEntry[];
  reproduction: ReproductionRecord | null;
}

interface NativeWriteBatch {
  preparation: Promise<NativeWritePreparation>;
  pendingToolCallIds: Set<string>;
  attributedTargets: Set<string>;
  flushPromise: Promise<NativeRefreshOutcome> | null;
}

interface NativeWriteAttribution {
  /** 真实读写和 Hash 使用的规范项目相对路径。 */
  path: string;
  /** Windows 下大小写折叠后的批次内唯一目标键。 */
  targetKey: string;
  beforeHash: string;
  expectedHash: string;
}

interface NativeRefreshOutcome {
  changed: boolean;
  passed: boolean;
  text: string;
}

interface NativeWriteResult {
  content: ToolResultEvent["content"];
  isError?: boolean;
}

export interface NativeWriteCoordinatorOptions {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  gameRuntime: NativeWriteGameRuntime;
  safetyGate: ToolSafetyGate;
}

/** 与一个 taskId 和 worktree 绑定的写入处理函数。 */
export interface NativeWriteCoordinator {
  onToolCall(
    event: ToolCallEvent,
    context: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined>;
  onToolResult(
    event: ToolResultEvent,
    context: ExtensionContext,
  ): Promise<NativeWriteResult | undefined>;
  onTurnEnd(context: ExtensionContext): Promise<void>;
  /** Agent 请求结束时丢弃不能跨请求复用的单次 write 归因。 */
  clearRequestAttributions(): void;
}

async function captureNativeWriteAttribution(
  task: TaskRecord,
  input: Readonly<Record<string, unknown>>,
): Promise<NativeWriteAttribution> {
  if (typeof input.path !== "string" || typeof input.content !== "string") {
    throw new TypeError("原生写入缺少合法 path 或 content。");
  }
  const path = normalizeProjectPath(input.path.trim());
  return {
    path,
    targetKey: process.platform === "win32"
      ? path.toLocaleLowerCase("en-US")
      : path,
    beforeHash: await hashFile(task.worktreeRoot, path),
    expectedHash: hashBytes(Buffer.from(input.content, "utf8")),
  };
}

function safeRefreshFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知刷新错误";
  return redactText(message).replace(/\s+/gu, " ").trim().slice(0, 400)
    || "未知刷新错误";
}

/**
 * 创建单任务写入协调器。闭包内状态只覆盖当前 Pi Extension 实例，不持久化授权副本。
 */
export function createNativeWriteCoordinator(
  options: NativeWriteCoordinatorOptions,
): NativeWriteCoordinator {
  const { task, store, evidence, gameRuntime, safetyGate } = options;
  const pendingWriteHashes = new Map<string, string>();
  const pendingNativeWrites = new Map<string, NativeWriteAttribution>();
  let nativeWriteBatch: NativeWriteBatch | null = null;
  let lastRefreshFailure: string | null = null;

  const recordWriteOutcome = async (
    toolName: string,
    outcome: "rejected" | "failed" | "noop" | "mutated" | "mutated_replay_failed",
    worktreeHash: string,
    reasonCode: string,
  ): Promise<void> => {
    try {
      await appendEvent(store, task.id, "tool.write_outcome", {
        toolName,
        outcome,
        count: 1,
        worktreeHash: worktreeHash.slice(0, 16),
        reasonCode,
      });
    } catch {
      // 写入结果只进入低敏审计，不得反向改变工具执行策略。
    }
  };

  const publishRefreshOutcome = (
    context: ExtensionContext,
    outcome: NativeRefreshOutcome,
  ): void => {
    context.ui.notify(outcome.text, outcome.passed ? "info" : "error");
  };

  const flushNativeWriteBatch = async (): Promise<NativeRefreshOutcome | null> => {
    const batch = nativeWriteBatch;
    if (!batch) return null;
    batch.flushPromise ??= (async () => {
      let prepared: NativeWritePreparation | null = null;
      let refreshEventWritten = false;
      try {
        prepared = await batch.preparation;
        const currentHash = await hashWorktree(task.worktreeRoot);
        if (currentHash === prepared.baselineHash) {
          return {
            changed: false,
            passed: true,
            text: "原生工具未产生代码变化，无需刷新右侧游戏。",
          };
        }
        await syncWorktreeChanges(store, task, "native-tools", evidence);
        const replay = prepared.driver
          ? prepared.reproduction
            ? await replayReproduction(
              store,
              task,
              prepared.driver,
              prepared.reproduction,
              currentHash,
            )
            : await prepared.driver.reloadAndReplay([])
          : null;
        await appendEvent(store, task.id, "game.refresh", {
          replayed: replay !== null && prepared.actions.length > 0,
          passed: replay?.passed ?? true,
          actionCount: replay?.actionCount ?? 0,
        });
        refreshEventWritten = true;
        if (replay && !replay.passed) {
          throw new Error(replay.failure ?? "未知游戏错误");
        }
        lastRefreshFailure = null;
        return {
          changed: true,
          passed: true,
          text: replay
            ? "原生代码修改已同步；右侧游戏已刷新并重放 "
              + String(replay.actionCount)
              + " 个语义动作。"
            : "原生代码修改已同步；当前没有运行时复现，因此未启动浏览器。",
        };
      } catch (error) {
        if (prepared && !refreshEventWritten) {
          await appendEvent(store, task.id, "game.refresh", {
            replayed: prepared.driver !== null && prepared.actions.length > 0,
            passed: false,
            actionCount: 0,
          }).catch(() => undefined);
        }
        lastRefreshFailure = "原生代码已写入，但右侧刷新重放未通过："
          + safeRefreshFailure(error);
        return {
          changed: true,
          passed: false,
          text: lastRefreshFailure,
        };
      }
    })();
    const outcome = await batch.flushPromise;
    if (nativeWriteBatch === batch) nativeWriteBatch = null;
    return outcome;
  };

  const refreshGateFailure = async (): Promise<string | null> => {
    const batch = nativeWriteBatch;
    if (batch) {
      if (batch.pendingToolCallIds.size > 0 && !batch.flushPromise) {
        return "原生代码修改仍在执行，必须等待同步刷新完成后再检查或提交结果。";
      }
      const outcome = await flushNativeWriteBatch();
      if (outcome && !outcome.passed) return outcome.text;
    }
    return lastRefreshFailure;
  };

  const onTurnEnd = async (context: ExtensionContext): Promise<void> => {
    // 正常写入在最后一个 native tool_result 中完成刷新；这里只处理取消或第三方
    // 扩展导致 tool_result 缺失的异常路径，不能再把正常刷新延迟到整轮结束。
    if (!nativeWriteBatch) {
      pendingNativeWrites.clear();
      pendingWriteHashes.clear();
      return;
    }
    const pendingIds = [...nativeWriteBatch.pendingToolCallIds];
    nativeWriteBatch.pendingToolCallIds.clear();
    const outcome = await flushNativeWriteBatch();
    const finalHash = await hashWorktree(task.worktreeRoot);
    for (const toolCallId of pendingIds) {
      await recordWriteOutcome(
        "write",
        "failed",
        finalHash,
        "tool-result-missing",
      );
      pendingWriteHashes.delete(toolCallId);
    }
    pendingNativeWrites.clear();
    pendingWriteHashes.clear();
    if (outcome?.changed) publishRefreshOutcome(context, outcome);
  };

  const onToolCall = async (
    event: ToolCallEvent,
    context: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    const input = event.input as Record<string, unknown>;
    let preWorktreeHash: string | null = null;
    const localSafetyBlock = (message: string): ToolCallEventResult => ({
      block: true,
      terminate: false,
      reason: message,
    });

    if (
      event.toolName === "check"
      || (event.toolName === "finish" && event.input.status === "result")
    ) {
      const failure = await refreshGateFailure();
      if (failure) {
        return localSafetyBlock(
          "代码刷新门禁未通过：" + failure + " 请继续修复后重试。",
        );
      }
    }
    if (WRITE_TOOLS.has(event.toolName)) {
      preWorktreeHash ??= await hashWorktree(task.worktreeRoot);
      const safety = await safetyGate.authorize(
        event.toolName as "write" | "patch",
        input,
        context,
      );
      if (safety.kind === "block") {
        await recordWriteOutcome(
          event.toolName,
          "rejected",
          preWorktreeHash,
          safety.reasonCode,
        );
        return localSafetyBlock(safety.reason);
      }
      pendingWriteHashes.set(event.toolCallId, preWorktreeHash);
    }
    if (NATIVE_WRITE_TOOLS.has(event.toolName)) {
      let attribution: NativeWriteAttribution;
      try {
        attribution = await captureNativeWriteAttribution(task, input);
      } catch (error) {
        pendingWriteHashes.delete(event.toolCallId);
        await recordWriteOutcome(
          event.toolName,
          "rejected",
          preWorktreeHash ?? await hashWorktree(task.worktreeRoot),
          "write-attribution-unavailable",
        );
        return localSafetyBlock(
          "无法建立本次写入的目标文件证据：" + safeRefreshFailure(error),
        );
      }
      const batch = nativeWriteBatch ?? {
        preparation: (async () => {
          const [baselineHash, reproduction] = await Promise.all([
            hashWorktree(task.worktreeRoot),
            readActiveReproduction(store, evidence, task),
          ]);
          let driver = gameRuntime.currentDriver();
          if (reproduction && !driver) driver = await gameRuntime.ensure();
          await driver?.ensureReproductionCheckpoint();
          return {
            baselineHash,
            driver,
            actions: reproduction?.actions ?? [],
            reproduction,
          };
        })(),
        pendingToolCallIds: new Set<string>(),
        attributedTargets: new Set<string>(),
        flushPromise: null,
      };
      nativeWriteBatch = batch;
      try {
        await batch.preparation;
      } catch (error) {
        pendingWriteHashes.delete(event.toolCallId);
        if (nativeWriteBatch === batch && batch.pendingToolCallIds.size === 0) {
          nativeWriteBatch = null;
        }
        await recordWriteOutcome(
          event.toolName,
          "rejected",
          preWorktreeHash ?? await hashWorktree(task.worktreeRoot),
          "refresh-checkpoint-unavailable",
        );
        return localSafetyBlock(
          "写入前无法建立安全刷新检查点：" + safeRefreshFailure(error),
        );
      }
      batch.pendingToolCallIds.add(event.toolCallId);
      pendingNativeWrites.set(event.toolCallId, attribution);
    }
    return undefined;
  };

  const onToolResult = async (
    event: ToolResultEvent,
    context: ExtensionContext,
  ): Promise<NativeWriteResult | undefined> => {
    const details = event.details && typeof event.details === "object"
      ? event.details as Record<string, unknown>
      : null;
    const preWriteHash = pendingWriteHashes.get(event.toolCallId) ?? null;
    pendingWriteHashes.delete(event.toolCallId);
    const nativeWriteAttribution = pendingNativeWrites.get(event.toolCallId) ?? null;
    pendingNativeWrites.delete(event.toolCallId);
    const postWorktreeHash = WRITE_TOOLS.has(event.toolName)
      ? await hashWorktree(task.worktreeRoot)
      : null;
    if (!NATIVE_WRITE_TOOLS.has(event.toolName)) {
      if (event.toolName === "patch" && preWriteHash && postWorktreeHash) {
        const changed = postWorktreeHash !== preWriteHash;
        const replay = details?.replay && typeof details.replay === "object"
          ? details.replay as Record<string, unknown>
          : null;
        const refreshFailed = event.isError || replay?.passed === false;
        if (changed) {
          if (refreshFailed) {
            const failureText = event.content
              .map((item) => item.type === "text" ? item.text : "")
              .filter(Boolean)
              .join(" ");
            lastRefreshFailure = "精确补丁已写入，但右侧刷新重放未通过："
              + safeRefreshFailure(new Error(failureText || "未知补丁刷新错误"));
          } else if (replay?.passed === true) {
            // patch 自身的 afterPatch 已经完成刷新/重放；它与原生 write
            // 共享同一个门禁事实，因此成功修复必须清除上一轮刷新失败。
            lastRefreshFailure = null;
          }
        }
        const outcome = changed
          ? refreshFailed ? "mutated_replay_failed" : "mutated"
          : event.isError ? "failed" : "noop";
        await recordWriteOutcome(
          event.toolName,
          outcome,
          postWorktreeHash,
          changed
            ? refreshFailed ? "refresh-replay-failed" : "worktree-mutated"
            : event.isError ? "tool-execution-failed" : "worktree-unchanged",
        );
      }
      return undefined;
    }
    const batch = nativeWriteBatch;
    if (!batch || !batch.pendingToolCallIds.delete(event.toolCallId)) {
      if (preWriteHash && postWorktreeHash) {
        await recordWriteOutcome(
          event.toolName,
          "failed",
          postWorktreeHash,
          "write-batch-missing",
        );
      }
      return undefined;
    }
    // delete 与 size 判断必须在第一个 await 之前完成；并行结果恢复后再读共享 Set，
    // 可能让多个调用都误以为自己是最后一个并重复附加刷新正文。
    const finalizesBatch = batch.pendingToolCallIds.size === 0;
    let ownWriteProgress = false;
    if (
      !event.isError
      && nativeWriteAttribution
      && nativeWriteAttribution.beforeHash !== nativeWriteAttribution.expectedHash
    ) {
      const targetHash = await hashFile(
        task.worktreeRoot,
        nativeWriteAttribution.path,
      ).catch(() => null);
      // Hash I/O 可以并发；真正的所有权判断和认领之间不能再有 await。
      if (
        targetHash === nativeWriteAttribution.expectedHash
        && !batch.attributedTargets.has(nativeWriteAttribution.targetKey)
      ) {
        batch.attributedTargets.add(nativeWriteAttribution.targetKey);
        ownWriteProgress = true;
      }
    }
    // Pi 的并行 native batch 会先触发全部 tool_call，再按完成顺序触发 tool_result；
    // 只有最后一个结果负责刷新，确保多个并行写入不会各自消费一次检查点。
    if (!finalizesBatch) {
      if (preWriteHash && postWorktreeHash) {
        await recordWriteOutcome(
          event.toolName,
          ownWriteProgress ? "mutated" : event.isError ? "failed" : "noop",
          postWorktreeHash,
          ownWriteProgress ? "target-mutated" : event.isError
            ? "tool-execution-failed"
            : "target-unchanged",
        );
      }
      return undefined;
    }
    const outcome = await flushNativeWriteBatch();
    if (preWriteHash && postWorktreeHash) {
      const classification = ownWriteProgress
        ? outcome?.passed === false ? "mutated_replay_failed" : "mutated"
        : event.isError ? "failed" : "noop";
      await recordWriteOutcome(
        event.toolName,
        classification,
        postWorktreeHash,
        ownWriteProgress
          ? outcome?.passed === false ? "refresh-replay-failed" : "target-mutated"
          : event.isError ? "tool-execution-failed" : "target-unchanged",
      );
    }
    if (!outcome?.changed) return undefined;
    publishRefreshOutcome(context, outcome);
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: outcome.text },
      ],
      ...(outcome.passed ? {} : { isError: true }),
    };
  };

  return {
    onToolCall,
    onToolResult,
    onTurnEnd,
    clearRequestAttributions: () => pendingNativeWrites.clear(),
  };
}
