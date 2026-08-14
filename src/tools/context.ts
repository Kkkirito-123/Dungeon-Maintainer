/**
 * 五个维护工具共享的任务上下文与低敏返回格式。
 *
 * 本模块只连接任务记录、隔离 worktree 和 SQL Dungeon 适配器；它不执行模型请求，
 * 也不提供 Shell、任意文件写入或目标仓库之外的访问能力。工具实现必须通过这里
 * 持有的 `TaskStore` 更新事实，不能另建一套内存状态，否则恢复任务时会丢失审批、
 * 检查和补丁信息。错误正文可能包含代码，因此审计事件只记录动作类型和结果状态。
 */

import type { TaskRecord, TaskStore } from "../runtime/task.js";

/** 工具执行期间唯一可变的任务引用。 */
export interface ToolContext {
  /** 当前任务；调用工具后可能原地更新并持久化。 */
  task: TaskRecord;
  /** 任务事实存储，禁止写入凭据、完整 SQL 或游戏快照。 */
  store: TaskStore;
}

/** 返回给模型的文本及供 CLI/测试读取的结构化细节。 */
export interface ToolOutput<T> {
  /** 已裁剪、可进入模型上下文的纯文本。 */
  text: string;
  /** 不含密钥和大正文的结构化结果。 */
  details: T;
}

/**
 * 检查调用是否已被取消。
 * @param signal Pi Runtime 传入的任务取消信号。
 * @throws 当用户中止任务时抛出标准 AbortError。
 */
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/**
 * 追加一条不包含代码正文的工具审计事件。
 * @param context 当前任务上下文。
 * @param tool 固定工具名。
 * @param status 执行状态，不得包含模型或文件正文。
 */
export async function audit(
  context: ToolContext,
  tool: "inspect" | "patch" | "check" | "play" | "finish",
  status: string,
): Promise<void> {
  await context.store.append(context.task.id, {
    at: new Date().toISOString(),
    type: `tool.${tool}`,
    detail: { status },
  });
}
