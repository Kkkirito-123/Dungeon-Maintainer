/**
 * Harness 的脱敏实时事件协议。
 *
 * 事件用于 CLI、游戏同窗面板和低敏审计，只公开观察、规划、动作、验证、缓存、发现、
 * 修复与检查阶段。它不承载 prompt、completion、隐藏思维、工具参数、代码正文、SQL、
 * 地图、快照或凭据。调用方仍需把外部输入限长后再构造事件。
 */

import type { HarnessPhase } from "./contract.js";
import type { Diagnosis } from "../runtime/task.js";

interface EventBase {
  schemaVersion: 1;
  at: string;
}

/** 可发送到环境面板的严格事件联合。 */
export type HarnessEvent =
  | (EventBase & { type: "phase"; phase: HarnessPhase; turn?: number; message: string })
  | (EventBase & { type: "action"; phase: HarnessPhase; action: string; state: "start" | "done" | "error"; ok?: boolean; message: string })
  | (EventBase & { type: "cache"; state: "hit" | "miss" | "store" | "skip"; scope: "decision" | "result"; message: string })
  | (EventBase & { type: "finding"; level: "info" | "review" | "error"; message: string })
  | (EventBase & { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; total: number })
  | (EventBase & {
      type: "control";
      state: "idle" | "diagnosing" | "diagnosed" | "fixing" | "needs_approval" | "verifying" | "ready_to_apply" | "applied" | "failed";
      canCheck: boolean;
      canFix: boolean;
      canApply: boolean;
      message: string;
    })
  | (EventBase & { type: "diagnosis"; diagnosis: Diagnosis })
  | (EventBase & { type: "status"; status: string; message: string });

/**
 * 构造带统一时间字段的事件。
 * @param event 已通过调用方限长的事件正文。
 * @param now 测试可注入的当前时间；生产默认使用系统时间。
 * @returns 可直接广播且不含工具参数的 Harness 事件。
 */
export function harnessEvent<T extends Omit<HarnessEvent, "schemaVersion" | "at">>(
  event: T,
  now = Date.now(),
): T & EventBase {
  return { schemaVersion: 1, at: new Date(now).toISOString(), ...event };
}
