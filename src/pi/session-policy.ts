/**
 * Pi 会话、模型和 Shell 安全策略。
 *
 * 本模块集中处理任务与 Pi 运行时的身份绑定，以及 V1 不允许的会话切换、分叉、树导航
 * 和用户 Shell。它不启动游戏、不注册维护工具、不改变任务状态；Extension 入口只负责在
 * 正确时机调用这些策略。
 *
 * `realpath` 校验用于防止 cwd、session-dir 或 session 文件通过符号链接指向别处。taskId
 * 与 session-id 固定绑定，是把聊天、审批、补丁和 worktree 证据保持在同一任务中的关键。
 * 任一事实漂移都抛错或取消操作，不尝试创建新会话或执行替代命令。
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MaintainerConfig } from "../config.js";
import { appendEvent } from "../logging/events.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";

const PROVIDER_ID = "dungeon-maintainer";

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalPath(path: string): Promise<string> {
  return comparablePath(await realpath(path));
}

/**
 * 验证当前 Pi 运行时没有脱离任务记录。
 *
 * @param context Pi 提供的只读会话上下文。
 * @param task 由父进程创建的任务记录。
 * @returns 验证成功时无返回值。
 * @throws cwd、session-id、session-dir 或 session 文件名任一不一致时拒绝启动。
 */
export async function assertTaskSessionBinding(
  context: ExtensionContext,
  task: TaskRecord,
): Promise<void> {
  const [contextCwd, taskWorktree, sessionDir, taskSessionDir] = await Promise.all([
    canonicalPath(context.cwd),
    canonicalPath(task.worktreeRoot),
    canonicalPath(context.sessionManager.getSessionDir()),
    canonicalPath(task.piSessionDir),
  ]);
  const managerCwd = await canonicalPath(context.sessionManager.getCwd());
  if (contextCwd !== taskWorktree || managerCwd !== taskWorktree) {
    throw new Error("Pi cwd 与任务 detached worktree 不一致");
  }
  if (context.sessionManager.getSessionId() !== task.id) {
    // taskId 与 Pi session-id 固定绑定，才能保证聊天、审批、补丁和 worktree
    // 不会在用户切换会话后悄悄指向不同任务。
    throw new Error("Pi session-id 与任务 ID 不一致");
  }
  if (sessionDir !== taskSessionDir) {
    throw new Error("Pi session-dir 与任务记录不一致");
  }
  const sessionFile = context.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Pi 当前不是可恢复的持久化会话");
  if (await canonicalPath(dirname(sessionFile)) !== taskSessionDir) {
    throw new Error("Pi 会话文件不属于当前任务目录");
  }
  if (!basename(sessionFile).endsWith("_" + task.id + ".jsonl")) {
    throw new Error("Pi 会话文件名没有绑定当前任务 ID");
  }
}

/**
 * 安装 V1 固定模型和危险交互阻断钩子。
 *
 * @param pi 当前 Pi Extension API。
 * @param store 任务事件存储，只写低敏安全摘要。
 * @param task 当前任务。
 * @param config 固定 Provider 与模型配置。
 * @remarks Pi 内置命令先于同名 Extension 命令处理，所以必须使用生命周期钩子取消；
 * 仅注册 `/new` 等同名命令无法阻止会话已经被替换。
 */
export function registerSessionPolicyHooks(
  pi: ExtensionAPI,
  store: TaskStore,
  task: TaskRecord,
  config: MaintainerConfig,
): void {
  pi.on("model_select", async (event, context) => {
    if (event.model.provider === PROVIDER_ID && event.model.id === config.model) {
      return;
    }
    const expected = context.modelRegistry.find(PROVIDER_ID, config.model);
    if (!expected || !await pi.setModel(expected)) {
      throw new Error("无法恢复固定 Dungeon Maintainer 模型");
    }
    context.ui.notify("当前任务已恢复固定维护模型", "warning");
  });

  pi.on("user_bash", async (_event, context) => {
    await appendEvent(store, task.id, "security.user_bash_blocked");
    context.ui.notify("! 与 !! Shell 已禁用；请使用受限维护工具", "warning");
    return {
      result: {
        output: "Dungeon Maintainer 禁止执行用户 Shell",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("session_before_switch", (_event, context) => {
    // Pi 内置命令会先于同名 Extension 命令分发，所以必须在真正替换运行时前取消；
    // 这同时覆盖 /new、/resume 与 /import，避免聊天脱离 taskId 和 worktree。
    context.ui.notify("当前任务禁止 /new 或切换到其他 Pi 会话", "warning");
    return { cancel: true };
  });
  pi.on("session_before_fork", (_event, context) => {
    // /fork 与 /clone 最终都会进入同一分叉钩子，不能依靠无效的同名命令覆盖。
    context.ui.notify("当前任务禁止 fork Pi 会话", "warning");
    return { cancel: true };
  });
  pi.on("session_before_tree", (_event, context) => {
    context.ui.notify("当前任务禁止切换 Pi 会话分支", "warning");
    return { cancel: true };
  });
}
