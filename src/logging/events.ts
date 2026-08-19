/**
 * 低敏事件日志入口。
 *
 * 该模块把工具、浏览器和任务生命周期事件统一写入 events.jsonl。调用方只能传入
 * 标量字段；字符串会脱敏并限制长度，避免错误对象、模型正文或游戏快照被意外展开。
 * 事件日志用于恢复和诊断，不承担 Pi 原生会话存储职责。
 */

import { redactText } from "./redact.js";
import type { TaskStore } from "../task/store.js";

/** 事件允许持久化的标量。 */
export type EventScalar = string | number | boolean | null;

function sanitizeDetail(
  detail: Readonly<Record<string, EventScalar>>,
): Record<string, EventScalar> {
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => [
    key,
    typeof value === "string"
      ? redactText(value).replace(/\s+/gu, " ").slice(0, 500)
      : value,
  ]));
}

/**
 * 追加一条类型化低敏事件。
 *
 * @param store 当前 TaskStore。
 * @param taskId 目标任务 ID。
 * @param type 稳定的点分事件名。
 * @param detail 不含嵌套对象的有限字段。
 */
export async function appendEvent(
  store: TaskStore,
  taskId: string,
  type: string,
  detail: Readonly<Record<string, EventScalar>> = {},
): Promise<void> {
  await store.append(taskId, {
    at: new Date().toISOString(),
    type,
    detail: sanitizeDetail(detail),
  });
}
