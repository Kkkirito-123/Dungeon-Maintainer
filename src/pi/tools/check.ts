/**
 * Pi `check` 固定诊断工具。
 *
 * 本文件仅把模型选择的 CheckId 传给 workspace 白名单执行器；模型不能提供命令、
 * 参数、cwd 或环境变量。完整输出经脱敏后写入任务 checks 目录，Pi 只看到末尾有限
 * 文本。检查记录绑定完整 worktree Hash，源码变化后不会复用旧 PASS。进程缺失、
 * 取消和非零退出分别保留 blocked/failed 证据，不会触碰正式仓库。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EvidenceStore } from "../../evidence/store.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { withProgress } from "../../progress/reporter.js";
import { formatCheckFailure, runCheck } from "../../workspace/check.js";

function clipCheckTail(value: string): string {
  const text = value.slice(-4 * 1024);
  return text.length === value.length ? text : "[检查输出已按 4 KiB 截断]\n" + text;
}

/** `check` 的固定标识参数。 */
export const CheckParameters = Type.Object({
  id: Type.Union([
    Type.Literal("rules-test"),
    Type.Literal("rules-validate"),
    Type.Literal("agent-test"),
    Type.Literal("game-related-test"),
  ]),
}, { additionalProperties: false });

/** 注册检查工具所需的单任务依赖。 */
export interface CheckToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
}

/**
 * 向单个 Pi 会话注册 `check`。
 *
 * @param pi 当前 Extension API。
 * @param context 当前任务和事实存储。
 */
export function registerCheckTool(
  pi: ExtensionAPI,
  context: CheckToolContext,
): void {
  pi.registerTool({
    name: "check",
    label: "运行检查",
    description: "运行维护器源码登记的 SQL Dungeon 聚焦诊断检查。",
    promptSnippet: "用 check 运行聚焦诊断检查",
    promptGuidelines: [
      "只有测试、规则或构建症状需要定向诊断时才调用 check；正常修改完成后自然结束。",
      "用户明确要求立即验证时，finish(result) 只运行直接改动测试和必要的直接检查；不要在写入后预先重复运行 game-related-test。",
      "完整 game-test、game-architecture 和 game-build 不属于模型工具，只在 /apply 或 publish 前运行一次。",
      "不得把失败检查描述为通过；根据日志尾部继续定位。",
    ],
    executionMode: "sequential",
    parameters: CheckParameters,
    async execute(
      _toolCallId,
      input,
      signal,
      _onUpdate,
      extensionContext: ExtensionContext,
    ) {
      return await withProgress(
        extensionContext.ui,
        "check",
        input,
        async (progress) => {
          progress.line("运行固定检查：" + input.id);
          const result = await runCheck(
            context.store,
            context.evidence,
            context.task,
            input.id,
            signal,
            {
              preserveTaskState: true,
              onOutput: (line) => progress.line(line),
            },
          );
          if (result.record.status !== "passed") {
            progress.fail(new Error(formatCheckFailure(result)));
          } else {
            progress.line(result.cached ? "命中检查缓存" : "检查输出已完成");
          }
          return {
            content: [{
              type: "text",
              text: [
                input.id + ": " + result.record.status,
                result.cached ? "[CACHE]" : "[FRESH]",
                clipCheckTail(result.tail),
              ].filter(Boolean).join("\n"),
            }],
            details: {
              id: result.record.id,
              status: result.record.status,
              cached: result.cached,
              durationMs: result.record.durationMs,
              worktreeHash: result.record.worktreeHash,
            },
          };
        },
      );
    },
  });
}
