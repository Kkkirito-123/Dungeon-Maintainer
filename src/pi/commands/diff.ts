/**
 * Pi `/diff` worktree 补丁查看命令。
 *
 * 本文件只读取已封装补丁或当前 detached worktree Diff，并在 Pi 多行查看器中展示；
 * 编辑器返回值会被丢弃，因此不会形成第二条写文件路径。命令不读取正式仓库外文件、
 * 不执行外部 diff 工具，也不改变任务状态。无变化时给出明确通知。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { readTaskDiff } from "../../workspace/apply.js";
import { withProgress } from "../../progress/reporter.js";

/** `/diff` 所需的当前任务依赖。 */
export interface DiffCommandContext {
  task: TaskRecord;
  store: TaskStore;
}

/**
 * 注册 `/diff`。
 *
 * @param pi 当前 Extension API。
 * @param context 当前任务与事件存储。
 */
export function registerDiffCommand(
  pi: ExtensionAPI,
  context: DiffCommandContext,
): void {
  pi.registerCommand("diff", {
    description: "查看 detached worktree 当前补丁",
    async handler(args, commandContext) {
      if (args.trim()) {
        commandContext.ui.notify("/diff 不接受参数", "warning");
        return;
      }
      await withProgress(
        commandContext.ui,
        "diff",
        undefined,
        async (progress) => {
          progress.line("读取 detached worktree Diff");
          const diff = await readTaskDiff(context.task);
          await appendEvent(context.store, context.task.id, "command.diff", {
            bytes: Buffer.byteLength(diff, "utf8"),
          });
          if (!diff) {
            commandContext.ui.notify("当前 worktree 没有代码变化", "info");
            return;
          }
          progress.line("打开 Diff 查看器");
          // Pi 的 editor 是现成的大文本查看面；返回正文被有意忽略，不能借此修改文件。
          await commandContext.ui.editor("当前 worktree Diff（关闭即可）", diff);
        },
      );
    },
  });
}
