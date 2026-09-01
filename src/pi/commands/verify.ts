/**
 * Pi `/verify` 轻量验证命令。
 *
 * 本文件调用 repair verification 作为进入 `ready_to_apply` 的唯一入口：只运行变更列表中
 * 直接修改的测试（架构检查脚本变更运行对应直接检查），恢复浏览器检查点并重放活动复现，
 * 最后封装 patch.diff 并绑定完整 worktree Hash。它不接受命令参数，也不相信模型口头 PASS。
 * 任一步失败都会保留检查和重放证据，但不修改正式仓库；源码继续变化后旧验证自动失效。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EvidenceStore } from "../../evidence/store.js";
import type { GameDriver } from "../../game/driver.js";
import { appendEvent } from "../../logging/events.js";
import { verifyTask } from "../../repair/verification.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { withProgress } from "../../progress/reporter.js";

/** `/verify` 所需的任务和可选浏览器依赖。 */
export interface VerifyCommandContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  currentDriver(): GameDriver | null;
}

/**
 * 注册 `/verify`。
 *
 * @param pi 当前 Extension API。
 * @param context 当前任务、存储和单浏览器访问器。
 */
export function registerVerifyCommand(
  pi: ExtensionAPI,
  context: VerifyCommandContext,
): void {
  pi.registerCommand("verify", {
    description: "运行直接改动测试，恢复检查点并重放复现，然后封装候选补丁",
    async handler(args, commandContext) {
      if (args.trim()) {
        commandContext.ui.notify("/verify 不接受参数", "warning");
        return;
      }
      try {
        await withProgress(
          commandContext.ui,
          "verify",
          undefined,
          async (progress) => {
            const result = await verifyTask(
              context.store,
              context.evidence,
              context.task,
              context.currentDriver(),
              commandContext.signal,
              (line) => progress.line(line),
            );
            await appendEvent(context.store, context.task.id, "command.verify", {
              passed: true,
              pathCount: result.changedPaths.length,
              worktreeHash: result.record.worktreeHash.slice(0, 12),
            });
            commandContext.ui.notify(
              "验证通过：" + result.changedPaths.join(", ") + "；现在可以执行 /apply 写回已验证补丁",
              "info",
            );
          },
        );
      } catch (error) {
        await appendEvent(context.store, context.task.id, "command.verify", {
          passed: false,
          pathCount: context.task.changedPaths.length,
          worktreeHash: null,
        });
        commandContext.ui.notify(
          "验证未通过："
          + (error instanceof Error ? error.message : "未知错误"),
          "error",
        );
        throw error;
      }
    },
  });
}
