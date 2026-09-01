/**
 * Pi `/play` 游戏聚焦与复现命令。
 *
 * 本文件负责确保 headed Chromium 可用、把窗口带到前台，并在任务存在活动复现时
 * 从新的临时检查点重放同一组语义动作。它不接收 URL、楼层、选择器、脚本或 SQL，
 * 也不修改源码。浏览器丢失时会重新创建临时 Context；重放失败只报告失败，不会
 * 伪造验证记录或改变任务为 ready_to_apply。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GameDriver } from "../../game/driver.js";
import type { EvidenceStore } from "../../evidence/store.js";
import { appendEvent } from "../../logging/events.js";
import { readActiveReproduction } from "../../repair/reproduction.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { withProgress } from "../../progress/reporter.js";

/** `/play` 所需的任务和浏览器访问器。 */
export interface PlayCommandContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  ensureGame(): Promise<GameDriver>;
}

/**
 * 注册 `/play`。
 *
 * @param pi 当前 Extension API。
 * @param context 当前任务与单浏览器生命周期。
 */
export function registerPlayCommand(
  pi: ExtensionAPI,
  context: PlayCommandContext,
): void {
  pi.registerCommand("play", {
    description: "聚焦右侧游戏，并从当前检查点重放活动复现",
    async handler(args, commandContext) {
      if (args.trim()) {
        commandContext.ui.notify("/play 不接受参数", "warning");
        return;
      }
      await withProgress(
        commandContext.ui,
        "play",
        undefined,
        async (progress) => {
          progress.line("启动并聚焦游戏");
          const driver = await context.ensureGame();
          const reproduction = await readActiveReproduction(
            context.store,
            context.evidence,
            context.task,
          );
          if (reproduction) {
            progress.line("恢复检查点并重放复现");
            await driver.focus();
            // 同一浏览器会话中保留最初检查点；恢复任务时浏览器是新的，才以相同
            // 初始页面补建检查点。绝不能在症状状态覆盖原复现起点。
            await driver.ensureReproductionCheckpoint();
            const replay = await driver.reloadAndReplay(reproduction.actions);
            if (!replay.passed) {
              progress.fail(new Error("复现重放失败：" + (replay.failure ?? "未知错误")));
            } else {
              progress.line("复现重放通过，共 " + String(replay.actionCount) + " 个动作");
            }
            await appendEvent(context.store, context.task.id, "command.play", {
              reproductionId: reproduction.id,
              passed: replay.passed,
              actionCount: replay.actionCount,
            });
            commandContext.ui.notify(
              replay.passed
                ? "游戏已聚焦并重放 " + String(replay.actionCount) + " 个动作"
                : "复现重放失败：" + (replay.failure ?? "未知错误"),
              replay.passed ? "info" : "error",
            );
            return;
          }
          progress.line("建立新的复现起点");
          await driver.focusAndRestart();
          await appendEvent(context.store, context.task.id, "command.play", {
            reproductionId: null,
            passed: true,
            actionCount: 0,
          });
          commandContext.ui.notify("游戏已聚焦，并建立新的复现起点", "info");
        },
      );
    },
  });
}
