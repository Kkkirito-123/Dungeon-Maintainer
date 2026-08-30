/**
 * Eval Profile 的共享运行结果。
 *
 * Domain 只声明两个 Profile 都必须返回的低敏事实，不依赖任何具体 Profile 实现。
 */

import type { TaskState } from "../../task/types.js";

/** 所有 Profile 共享的低敏运行指标。 */
export interface ProfileRunMetrics {
  readonly status: "settled" | "timeout" | "infra_error";
  readonly durationMs: number;
  readonly diagnosisMs: number | null;
  readonly turns: number;
  readonly toolCalls: number;
  readonly diagnosticToolCalls: number;
  readonly readCalls: number;
  readonly writeCalls: number;
  readonly consecutiveDuplicateToolCalls: number;
  readonly piMessageQueuePeak: number;
  readonly inspectCalls: number;
  readonly inspectExecutions: number;
  readonly inspectReceiptHits: number;
  readonly semanticEvidenceHits: number;
  readonly inspectBundles: number;
  readonly inspectBundleWindows: number;
  readonly inspectFailures: number;
  readonly inspectCandidateFiles: number;
  readonly inspectSelectedFiles: number;
  readonly writeAttempts: number;
  readonly writeRejected: number;
  readonly writeFailures: number;
  readonly writeNoops: number;
  /** Maintainer 可由遥测精确统计；Pi Baseline 无法可靠区分成功写入与真实 mutation。 */
  readonly writeMutations: number | null;
  readonly writeReplayFailures: number;
  readonly telemetryParseErrors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cacheHitRate: number;
  readonly uncachedTokens: number;
  readonly contextTokens: number | null;
  readonly contextPercent: number | null;
  readonly failureCode: string | null;
}

/** Profile 自身能证明的工作流闭环；Pi Baseline 没有 Maintainer 状态。 */
export interface ProfileWorkflowClosure {
  readonly applicable: boolean;
  readonly taskState: TaskState | null;
  readonly proposed: boolean | null;
  readonly executed: boolean | null;
  readonly writeAttempted: boolean | null;
  readonly retainedChanges: boolean | null;
  readonly verified: boolean | null;
  readonly readyToApply: boolean | null;
  readonly paused: boolean | null;
}

/** 不含工具正文、Prompt、源码或 SQL 的运行收尾诊断。 */
export interface ProfileRunDiagnostics {
  readonly lastToolName: string | null;
  readonly lastFinishStatus: string | null;
  readonly evidenceGraph: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly links: readonly string[];
    readonly worktreeHash: string | null;
  }[];
}

/** 单次 Profile 执行结果；workspaceRoot 只供同进程判卷，不写入公开报告。 */
export interface ProfileRunResult {
  readonly metrics: ProfileRunMetrics;
  readonly workspaceRoot: string;
  readonly workflowClosure: ProfileWorkflowClosure;
  readonly diagnostics: ProfileRunDiagnostics;
}

/** 从真实写入遥测和最终任务状态构造 Maintainer 工作流闭环。 */
export function buildMaintainerWorkflowClosure(input: {
  taskState: TaskState | null;
  proposed: boolean;
  writeAttempts: number;
  writeMutations: number;
  changedPathCount: number;
  replayPassed: boolean;
  readyToApply: boolean;
  paused: boolean;
}): ProfileWorkflowClosure {
  return {
    applicable: true,
    taskState: input.taskState,
    proposed: input.proposed,
    executed: input.writeMutations > 0,
    writeAttempted: input.writeAttempts > 0,
    retainedChanges: input.changedPathCount > 0,
    verified: input.replayPassed,
    readyToApply: input.readyToApply,
    paused: input.paused,
  };
}
