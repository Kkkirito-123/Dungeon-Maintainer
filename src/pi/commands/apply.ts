/**
 * Pi `/apply` 显式写回命令。
 *
 * 本文件是正式游戏仓库的唯一写入口。执行前由 workspace apply 重新验证任务状态、
 * worktree Hash、目标工作区洁净度、HEAD、逐文件 baseHash 和 `git apply --check`；
 * 用户还需在 Pi 确认框中确认精确路径。成功只把补丁写入工作区，不 commit、push、
 * PR 或部署。如果补丁已应用但 task.json 持久化失败，会立即用同一补丁反向恢复，
 * 避免正式仓库与任务状态分裂。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { applyTaskPatch } from "../../workspace/apply.js";
import { runGit } from "../../workspace/git.js";
import { withProgress } from "../../progress/reporter.js";

/** `/apply` 所需的当前任务依赖。 */
export interface ApplyCommandContext {
  task: TaskRecord;
  store: TaskStore;
}

async function rollbackAfterSaveFailure(task: TaskRecord): Promise<void> {
  if (!task.patchPath) return;
  // apply 已通过正向 --check 后才可能到这里；反向仍先 --check，防止覆盖用户在极短
  // 时间窗内的新编辑。失败时保留仓库现状并把原始持久化错误交给用户人工处理。
  await runGit(task.repoRoot, [
    "apply",
    "--reverse",
    "--check",
    "--",
    task.patchPath,
  ]);
  await runGit(task.repoRoot, [
    "apply",
    "--reverse",
    "--",
    task.patchPath,
  ]);
}

/**
 * 注册 `/apply`。
 *
 * @param pi 当前 Extension API。
 * @param context 当前任务与事实存储。
 */
export function registerApplyCommand(
  pi: ExtensionAPI,
  context: ApplyCommandContext,
): void {
  pi.registerCommand("apply", {
    description: "显式把已验证补丁应用到正式游戏仓库，但不提交",
    async handler(args, commandContext) {
      if (args.trim()) {
        commandContext.ui.notify("/apply 不接受参数", "warning");
        return;
      }
      if (context.task.state !== "ready_to_apply") {
        commandContext.ui.notify("任务尚未通过 /verify，不能 apply", "error");
        return;
      }
      if (!commandContext.hasUI) {
        commandContext.ui.notify("当前模式不能显示 apply 确认框", "error");
        return;
      }
      const approved = await commandContext.ui.confirm(
        "应用补丁到正式游戏仓库",
        [
          "任务：" + context.task.id,
          "基线：" + context.task.baseHead,
          "路径：",
          ...context.task.changedPaths.map((path) => "  - " + path),
          "只修改工作区；不会 commit、push、创建 PR 或部署。",
        ].join("\n"),
      );
      if (!approved) {
        await appendEvent(context.store, context.task.id, "command.apply", {
          applied: false,
          pathCount: context.task.changedPaths.length,
        });
        commandContext.ui.notify("已取消 apply，正式仓库未变化", "info");
        return;
      }

      try {
        await withProgress(
          commandContext.ui,
          "apply",
          { taskId: context.task.id, paths: context.task.changedPaths },
          async (progress) => {
            progress.line("校验已验证补丁并写回正式工作区");
            commandContext.ui.notify("正在校验已验证补丁并写回正式工作区…", "info");

            const previousState = context.task.state;
            const appliedHashes = await applyTaskPatch(context.task);
            try {
              progress.line("补丁写回完成，保存任务状态");
              context.task.appliedHashes = appliedHashes;
              await context.store.transition(context.task, "applied");
            } catch (error) {
              progress.line("任务状态保存失败，回滚正式工作区");
              await rollbackAfterSaveFailure(context.task);
              context.task.state = previousState;
              context.task.appliedHashes = {};
              await context.store.save(context.task).catch(() => undefined);
              throw new Error("apply 后任务持久化失败，正式仓库已安全恢复", {
                cause: error,
              });
            }
            await appendEvent(context.store, context.task.id, "command.apply", {
              applied: true,
              pathCount: context.task.changedPaths.length,
            });
            progress.line("补丁已应用到正式游戏工作区");
            commandContext.ui.notify(
              "补丁已应用到正式游戏工作区；未创建提交",
              "info",
            );
          },
        );
      } catch (error) {
        commandContext.ui.notify(
          error instanceof Error ? error.message : "应用补丁失败",
          "error",
        );
        throw error;
      }
    },
  });
}
