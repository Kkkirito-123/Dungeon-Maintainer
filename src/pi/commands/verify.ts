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

/**
 * `/verify` 所需的任务、Evidence 与可选浏览器依赖。
 *
 * 当前 GameDriver 为空时只能验证不依赖活动复现的修改；任务、存储和 Evidence 必须绑定
 * 同一 detached worktree，验证结果才可安全关联完整 worktree Hash。
 */
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
 * @returns 无返回值；处理器通过后保存补丁与验证记录，并把任务迁移到 `ready_to_apply`。
 * @throws 注册冲突时同步抛错；执行时传播检查、Hash、浏览器恢复、重放和补丁封装错误。
 * @remarks 验证只读取 detached worktree 并写任务证据，不修改正式仓库；源码再次变化会使
 * 绑定旧完整 Hash 的结果失效。
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
            // 权威验证器按固定顺序运行直接检查、刷新/恢复、重建检查点、语义重放和补丁封装，
            // 最终记录完整 worktree Hash；命令层不根据模型正文推断 PASS。
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
