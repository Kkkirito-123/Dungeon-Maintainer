/**
 * Dungeon Maintainer 统一 Shell 的前后端协议。
 *
 * 本文件只定义本机 Shell 使用的低敏 JSON 结构，不保存完整 Prompt、模型思维链、
 * SQL、管理员答案或游戏隐藏状态。后端通过这些结构向浏览器推送摘要，前端只负责
 * 展示和收集用户输入；真正的任务权限、补丁校验和 Pi 会话仍由后端执行。
 *
 * 可能的副作用仅限于浏览器页面中的内存状态和 SSE 连接。所有写请求都必须由
 * ShellServer 校验任务 ID 与一次性令牌，不能把本协议当成通用远程控制接口。
 */

import type { TaskRecord, TaskState } from "../task/types.js";
import { promptTokenLimit } from "../agent/token-control.js";

/** Shell 可选择的 Pi 模型安全摘要。 */
export interface ShellModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/** Shell 请求 AppController 切换到来源工作树或可恢复任务。 */
export interface ShellTaskSwitchRequest {
  kind: "worktree" | "task";
  id: string;
}

/** Shell 底部状态栏显示的阶段。 */
export type ShellPhase =
  | "diagnose"
  | "reproduce"
  | "patch"
  | "verify"
  | "approval"
  | "compacting"
  | "idle";

/** 统一 Shell 状态栏的数据契约。 */
export interface ShellStatus {
  activeTaskId: string;
  taskName: string;
  taskCreatedAt: string;
  taskState: TaskState;
  phase: ShellPhase;
  modelProvider: string;
  model: string;
  availableModels: ShellModelOption[];
  thinkingLevel: string;
  availableThinkingLevels: string[];
  autoCompactionEnabled: boolean;
  pendingMessageCount: number;
  sourceBranch: string;
  sourceDirtyFiles: number;
  contextUsed: number | null;
  contextLimit: number;
  contextPercent: number | null;
  promptTokenLimit: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turnTotalTokens: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCacheReadTokens: number;
  sessionCacheWriteTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolBudget: number;
  viteState: "starting" | "ready" | "compiling" | "error" | "stopped";
  browserState: "starting" | "ready" | "error" | "stopped";
  bridgeState: "unknown" | "ready" | "unavailable";
  worktreeState: "clean" | "changed" | "error";
  diffFiles: number;
  verificationState: "not_run" | "running" | "passed" | "failed";
}

/** 左侧聊天区固定显示的当前动作状态。 */
export type ShellActivityState = "waiting" | "working" | "approval" | "done" | "error";

/** 浏览器可以收到的事件类型。 */
export type ShellEvent =
  | { type: "state"; status: ShellStatus; gameUrl: string | null }
  | { type: "chat.user"; text: string }
  | { type: "chat.text"; text: string; done: boolean }
  | { type: "chat.tool"; name: string; phase: "start" | "end"; error: boolean }
  | { type: "activity"; state: ShellActivityState; text: string; elapsedSeconds: number }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "approval"; request: ShellApprovalRequest }
  | { type: "game"; state: "starting" | "ready" | "error" | "stopped"; gameUrl: string | null }
  | { type: "closed"; code: number };

/** Shell 内确认框使用的安全摘要。 */
export interface ShellApprovalRequest {
  id: string;
  title: string;
  message: string;
  kind: "confirm" | "select" | "input" | "editor";
  options?: string[];
}

/** Shell 页面提交的 UI 响应。 */
export type ShellUiResponse =
  | { id: string; confirmed: boolean }
  | { id: string; value: string }
  | { id: string; cancelled: true };

/** ShellServer 启动时需要的最小配置。 */
export interface ShellStatusConfig {
  model: string;
  contextWindow: number;
  maxOutputTokens?: number;
  task: TaskRecord;
}

/** 从任务记录更新 worktree 和验证摘要。 */
export function statusFromTask(current: ShellStatus, task: TaskRecord): ShellStatus {
  return {
    ...current,
    activeTaskId: task.id,
    taskName: task.displayName,
    taskCreatedAt: task.createdAt,
    taskState: task.state,
    sourceBranch: task.sourceBranch,
    sourceDirtyFiles: task.sourceDirtyFiles,
    worktreeState: task.changedPaths.length > 0 ? "changed" : "clean",
    diffFiles: task.changedPaths.length,
    verificationState: task.verification
      ? task.verification.replayPassed ? "passed" : "failed"
      : "not_run",
  };
}

/** 创建不含敏感正文的默认状态。 */
export function createInitialStatus(config: ShellStatusConfig): ShellStatus {
  return statusFromTask({
    activeTaskId: config.task.id,
    taskName: config.task.displayName,
    taskCreatedAt: config.task.createdAt,
    taskState: config.task.state,
    phase: "idle",
    modelProvider: "dungeon-maintainer",
    model: config.model,
    availableModels: [],
    thinkingLevel: config.task.thinkingLevel,
    availableThinkingLevels: ["off"],
    autoCompactionEnabled: true,
    pendingMessageCount: 0,
    sourceBranch: config.task.sourceBranch,
    sourceDirtyFiles: config.task.sourceDirtyFiles,
    contextUsed: null,
    contextLimit: config.contextWindow,
    contextPercent: null,
    promptTokenLimit: promptTokenLimit(config.contextWindow, config.maxOutputTokens ?? 4_096),
    turnInputTokens: 0,
    turnOutputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turnTotalTokens: 0,
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionCacheReadTokens: 0,
    sessionCacheWriteTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    toolBudget: 16,
    viteState: "starting",
    browserState: "starting",
    bridgeState: "unknown",
    worktreeState: "clean",
    diffFiles: 0,
    verificationState: "not_run",
  }, config.task);
}
