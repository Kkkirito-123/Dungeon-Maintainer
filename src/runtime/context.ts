/**
 * 模型上下文裁剪与事实压缩。
 *
 * Pi Agent 仍保留完整进程内 transcript，本模块仅在发送下一次模型请求前构造更小的
 * 视图。达到模型窗口约 75% 时，旧对话会替换为确定性任务摘要，并保留最近完整的
 * 工具调用链。摘要必须保留目标、审批精确路径、失败检查、修改文件和验证状态；
 * 不包含进度日志、API Key、SQL、地图、浏览器快照或补丁正文。若无法找到安全切点，
 * 返回原消息，宁可让供应商报告窗口错误也不制造断裂的工具上下文。
 */

import {
  estimateContextTokens, shouldCompact, type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { TaskRecord } from "./task.js";

const SETTINGS = { enabled: true, reserveTokens: 4_096, keepRecentTokens: 8_000 } as const;

function summary(task: TaskRecord): string {
  const failed = task.checks.filter((item) => item.status !== "passed")
    .map((item) => `${item.id}:${item.status}`).join(", ") || "无";
  const passed = task.checks.filter((item) => item.status === "passed")
    .map((item) => item.id).join(", ") || "无";
  return [
    "[压缩后的任务事实]",
    `目标：${task.objective}`,
    `模式：${task.mode}；状态：${task.state}；基线：${task.baseHead}`,
    `批准范围：${task.approval?.paths.join(", ") || "无"}`,
    `已修改文件：${task.changedPaths.join(", ") || "无"}`,
    `已通过检查：${passed}`,
    `失败或阻断检查：${failed}`,
    "继续遵守 inspect/patch/check/play/finish 工具边界；不要假定未记录的事实。",
  ].join("\n");
}

function safeTailStart(messages: AgentMessage[]): number {
  let start = Math.max(1, messages.length - 8);
  while (start > 1 && messages[start]?.role === "toolResult") start -= 1;
  if (messages[start]?.role === "toolResult") return -1;
  return start;
}

/**
 * 在约 75% 上下文占用后生成安全的发送视图。
 * @param messages Pi Agent 当前完整消息。
 * @param task 必须保留的任务事实。
 * @param contextWindow 当前模型窗口。
 * @returns 原消息或“事实摘要 + 最近工具链”；不修改传入数组。
 */
export function compactContext(
  messages: AgentMessage[],
  task: TaskRecord,
  contextWindow: number,
): AgentMessage[] {
  const tokens = estimateContextTokens(messages).tokens;
  // shouldCompact 内部会减去 reserveTokens，因此这里先加回保留量，
  // 让实际触发点稳定落在配置窗口的约 75%，包括最小 8K 窗口。
  const thresholdWindow = Math.floor(contextWindow * 0.75) + SETTINGS.reserveTokens;
  if (!shouldCompact(tokens, thresholdWindow, SETTINGS)) return messages;
  const start = safeTailStart(messages);
  if (start < 0) return messages;
  const fact: AgentMessage = { role: "user", content: summary(task), timestamp: Date.now() };
  return [fact, ...messages.slice(start)];
}
