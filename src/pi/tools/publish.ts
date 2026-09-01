/**
 * Pi `publish` 窄域 GitHub 发布工具。
 *
 * 本文件只把用户明确要求的“提交 PR”连接到 workspace/publish；模型不能传命令、路径、
 * 分支、远端或合并选项。执行层先生成固定中文预览并等待确认，再运行发布前质量门、
 * commit、push 和 gh pr create。取消、验证失败或网络失败都不会触碰正式工作区，
 * 合并始终由用户在 GitHub 手动完成。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EvidenceStore } from "../../evidence/store.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import {
  formatPublishPreview,
  publishTask,
} from "../../workspace/publish.js";
import {
  formatCheckFailure,
  requiredPublishChecks,
  runCheck,
} from "../../workspace/check.js";
import { withProgress } from "../../progress/reporter.js";

/** `publish` 不接受任何模型可控参数。 */
export const PublishParameters = Type.Object({}, { additionalProperties: false });

/** 发布工具的单任务依赖。 */
export interface PublishToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
}

/**
 * 注册固定 `publish` 工具。
 *
 * @param pi 当前 Pi Extension API。
 * @param context 与 taskId、正式仓库和 detached worktree 绑定的事实存储。
 */
export function registerPublishTool(
  pi: ExtensionAPI,
  context: PublishToolContext,
): void {
  pi.registerTool({
    name: "publish",
    label: "提交 GitHub PR",
    description: "在用户确认固定预览后，把已验证游戏变更提交、推送并创建中文 GitHub PR；不会合并。",
    promptSnippet: "用户明确要求提交 PR 时用 publish",
    promptGuidelines: [
      "只有用户明确要求提交/创建 GitHub PR 时才调用 publish；普通修复完成后不要主动发布。",
      "publish 只接受空参数，并且要求任务已经通过验证；确认框会展示仓库、分支、文件、PR 文案和 Diff 预览。",
      "用户取消或发布失败时不要重复猜测参数；报告原因，合并由用户在 GitHub 手动处理。",
    ],
    executionMode: "sequential",
    parameters: PublishParameters,
    async execute(
      _toolCallId,
      _input,
      signal,
      _onUpdate,
      extensionContext: ExtensionContext,
    ) {
      if (!extensionContext.hasUI) {
        throw new Error("当前模式不能显示 GitHub PR 发布确认框");
      }
      return await withProgress(
        extensionContext.ui,
        "publish",
        undefined,
        async (progress) => {
          const result = await publishTask({
            task: context.task,
            store: context.store,
            taskDir: context.store.taskDir(context.task.id),
            ...(signal ? { signal } : {}),
            progress: (line) => progress.line(line),
            confirm: async (preview) => await extensionContext.ui.confirm(
              "确认提交 GitHub PR",
              formatPublishPreview(preview),
            ),
            runChecks: async () => {
              const checks = requiredPublishChecks(context.task.changedPaths);
              for (const id of checks) {
                const check = await runCheck(
                  context.store,
                  context.evidence,
                  context.task,
                  id,
                  signal,
                  {
                    preserveTaskState: true,
                    onOutput: (line) => progress.line(line),
                  },
                );
                if (check.record.status !== "passed") {
                  throw new Error("发布前完整检查未通过：" + formatCheckFailure(check));
                }
              }
            },
          });
          if (!result) {
            progress.done("用户取消发布");
            extensionContext.ui.notify("已取消发布；未创建提交、推送或 PR", "info");
            return {
              content: [{ type: "text", text: "用户取消了 GitHub PR 发布；正式仓库未变化。" }],
              details: { status: "cancelled" as const },
              terminate: true,
            };
          }
          extensionContext.ui.notify(
            "PR 已创建：" + result.prUrl + "；合并请在 GitHub 手动完成",
            "info",
          );
          return {
            content: [{
              type: "text",
              text: [
                "已创建 GitHub PR：" + result.prUrl,
                "分支：" + result.branch,
                "提交：" + result.commitSha,
                "合并请由用户在 GitHub 手动完成。",
              ].join("\n"),
            }],
            details: {
              status: "published" as const,
              repository: result.repository,
              baseBranch: result.baseBranch,
              branch: result.branch,
              commitSha: result.commitSha,
              prUrl: result.prUrl,
              changedPaths: result.changedPaths,
            },
            terminate: true,
          };
        },
      );
    },
  });
}
