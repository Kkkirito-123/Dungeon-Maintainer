/**
 * Pi `check` 固定检查工具。
 *
 * 本文件仅把模型选择的 CheckId 传给 workspace 白名单执行器；模型不能提供命令、
 * 参数、cwd 或环境变量。完整输出经脱敏后写入任务 checks 目录，Pi 只看到末尾有限
 * 文本。检查记录绑定完整 worktree Hash，源码变化后不会复用旧 PASS。进程缺失、
 * 取消和非零退出分别保留 blocked/failed 证据，不会触碰正式仓库。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EvidenceStore } from "../../evidence/store.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { runCheck } from "../../workspace/check.js";

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
    Type.Literal("game-test"),
    Type.Literal("game-architecture"),
    Type.Literal("game-build"),
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
    description: "运行维护器源码登记的 SQL Dungeon 测试、规则、架构或生产构建检查。",
    promptSnippet: "用 check 运行固定质量门",
    promptGuidelines: [
      "诊断时优先 game-related-test；finish(result) 会运行候选聚焦验证，完整质量门只在 /apply 前运行一次。",
      "不得把失败检查描述为通过；根据日志尾部继续定位。",
    ],
    executionMode: "sequential",
    parameters: CheckParameters,
    async execute(_toolCallId, input, signal) {
      const result = await runCheck(
        context.store,
        context.evidence,
        context.task,
        input.id,
        signal,
      );
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
  });
}
