/**
 * Pi `/discard` 证据保留与任务放弃命令。
 *
 * 本文件先把 detached worktree 最终 Diff 保存到任务目录，再把任务置为 discarded、
 * 关闭 Vite/Chromium 并退出 Pi。真正递归删除 worktree 由已回到维护器仓库 cwd 的父
 * 进程完成，避免 Windows 在 Pi 仍以 worktree 为当前目录时删除失败。删除目标仍由
 * workspace/worktree 的父目录边界检查保护；task.json、events、检查和补丁证据保留。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { snapshotWorktreePatch } from "../../workspace/apply.js";
import { withProgress } from "../../progress/reporter.js";

/** `/discard` 所需的任务和资源清理依赖。 */
export interface DiscardCommandContext {
  task: TaskRecord;
  store: TaskStore;
  closeGame(): Promise<void>;
}

/**
 * 注册 `/discard`。
 *
 * @param pi 当前 Extension API。
 * @param context 当前任务、存储和幂等资源关闭函数。
 */
export function registerDiscardCommand(
  pi: ExtensionAPI,
  context: DiscardCommandContext,
): void {
  pi.registerCommand("discard", {
    description: "保存最终 Diff 后放弃任务并安全清理 detached worktree",
    async handler(args, commandContext) {
      if (args.trim()) {
        commandContext.ui.notify("/discard 不接受参数", "warning");
        return;
      }
      if (context.task.state === "applied") {
        commandContext.ui.notify("已 applied 的任务不能 discard", "error");
        return;
      }
      if (context.task.state === "discarded") {
        commandContext.ui.notify("任务已经 discarded", "info");
        return;
      }
      await withProgress(
        commandContext.ui,
        "discard",
        undefined,
        async (progress) => {
          progress.line("等待确认并保存最终 Diff");
          const approved = commandContext.hasUI && await commandContext.ui.confirm(
            "放弃当前维护任务",
            [
              "任务：" + context.task.id,
              "worktree：" + context.task.worktreeRoot,
              "最终 Diff 和审计证据会保留，隔离 worktree 将在 Pi 退出后删除。",
              "正式游戏仓库不会改变。",
            ].join("\n"),
          );
          if (!approved) {
            progress.done("用户取消 discard");
            commandContext.ui.notify("已取消 discard", "info");
            return;
          }
          progress.line("保存最终 Diff 并更新任务状态");
          const patchPath = await snapshotWorktreePatch(
            context.task,
            context.store.taskDir(context.task.id),
          );
          if (patchPath) context.task.patchPath = patchPath;
          await context.store.transition(context.task, "discarded");
          await appendEvent(context.store, context.task.id, "command.discard", {
            patchSaved: patchPath !== null,
            pathCount: context.task.changedPaths.length,
          });
          progress.line("关闭游戏并退出维护器");
          await context.closeGame();
          commandContext.ui.notify(
            "任务已放弃；证据已保留，正在退出并清理 worktree",
            "info",
          );
          commandContext.shutdown();
        },
      );
    },
  });
}
