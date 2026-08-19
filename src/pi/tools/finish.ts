/**
 * Pi `finish` 诊断与复现结论工具。
 *
 * 本文件保存低敏中文结论，并在 `reproduced` 状态下把当前 500 条以内的语义 Trace
 * 截取为可重放用例。它不相信模型声称测试通过，也不生成补丁、apply、commit 或
 * ready_to_apply；只有用户执行 `/verify` 才能完成固定检查与重放并进入可应用状态。
 * SQL、答案、完整地图、存档和凭据会在持久化前脱敏。复现缺少真实 go/use/query
 * 动作时明确拒绝，避免把单次 look 当成运行证据。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GameDriver } from "../../game/driver.js";
import { appendEvent } from "../../logging/events.js";
import { redactText } from "../../logging/redact.js";
import { saveReproduction } from "../../repair/reproduction.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";

const ReproductionParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 160 }),
  expected: Type.String({ minLength: 1, maxLength: 400 }),
  actual: Type.String({ minLength: 1, maxLength: 400 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: 8,
  }),
}, { additionalProperties: false });

/** `finish` 的严格结论契约。 */
export const FinishParameters = Type.Object({
  status: Type.Union([
    Type.Literal("reproduced"),
    Type.Literal("diagnosed"),
    Type.Literal("result"),
    Type.Literal("blocked"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 1_200 }),
  risk: Type.String({ minLength: 1, maxLength: 600 }),
  reproduction: Type.Optional(ReproductionParameters),
}, { additionalProperties: false });

/** 注册结论工具所需的单任务和 Trace 依赖。 */
export interface FinishToolContext {
  task: TaskRecord;
  store: TaskStore;
  currentDriver(): GameDriver | null;
}

function plain(value: string, limit: number): string {
  if (/[<>]|\p{Cc}/u.test(value)) {
    throw new Error("finish 只接受无 HTML 和控制字符的纯文本");
  }
  const output = redactText(value).replace(/\s+/gu, " ").trim().slice(0, limit);
  if (!output) throw new Error("finish 结论不能为空");
  return output;
}

/**
 * 向单个 Pi 会话注册 `finish`。
 *
 * @param pi 当前 Extension API。
 * @param context 当前任务、存储和可选浏览器 Trace。
 */
export function registerFinishTool(
  pi: ExtensionAPI,
  context: FinishToolContext,
): void {
  pi.registerTool({
    name: "finish",
    label: "提交结论",
    description: "保存诊断、可重放复现、修复结果或阻断结论；不会替代 /verify 或 /apply。",
    promptSnippet: "用 finish 保存诊断或复现结论并结束当前 Agent 回合",
    promptGuidelines: [
      "运行时问题复现成功后，以 reproduced 保存检查点后的语义动作、期望、实际和证据。",
      "代码修改后用 result 总结现状；不要声称 ready_to_apply，用户必须执行 /verify。",
      "确认无法继续且原因客观时才用 blocked。",
    ],
    executionMode: "sequential",
    parameters: FinishParameters,
    async execute(_toolCallId, input) {
      if (
        context.task.state === "applied"
        || context.task.state === "discarded"
      ) {
        throw new Error("终态任务不能继续提交诊断或复现结论");
      }
      const summary = plain(input.summary, 1_200);
      const risk = plain(input.risk, 600);
      let reproductionId: string | null = null;
      if (input.status === "reproduced") {
        if (!input.reproduction) {
          throw new Error("reproduced 必须提供期望、实际和证据");
        }
        if (context.task.state === "awaiting_approval") {
          throw new Error("核心补丁仍在等待确认，不能同时覆盖复现状态");
        }
        if (context.task.state !== "active") {
          // 新复现会改变验证依据。即使旧代码曾 ready，也必须先回到 active，
          // 让 VerificationRecord 失效后再保存新的语义动作窗口。
          await context.store.transition(context.task, "active");
        }
        const driver = context.currentDriver();
        if (!driver) throw new Error("浏览器不可用，不能保存运行时复现");
        const reproduction = await saveReproduction(
          context.store,
          context.task,
          driver.trace,
          {
            title: input.reproduction.title,
            expected: input.reproduction.expected,
            actual: input.reproduction.actual,
            evidence: input.reproduction.evidence,
          },
        );
        reproductionId = reproduction.id;
      } else if (input.reproduction) {
        throw new Error("只有 reproduced 状态可以携带 reproduction");
      }

      context.task.conclusion = "结论：" + summary + "\n风险：" + risk;
      if (input.status === "blocked" && context.task.state !== "blocked") {
        await context.store.transition(context.task, "blocked");
      } else {
        await context.store.save(context.task);
      }
      await appendEvent(context.store, context.task.id, "tool.finish", {
        status: input.status,
        reproductionId,
      });
      return {
        content: [{
          type: "text",
          text: [
            summary,
            "风险：" + risk,
            reproductionId ? "复现：" + reproductionId : "",
            context.task.state === "ready_to_apply"
              ? "任务已验证，可由用户执行 /apply。"
              : "任务尚未通过 /verify。",
          ].filter(Boolean).join("\n"),
        }],
        details: {
          status: input.status,
          state: context.task.state,
          reproductionId,
          changedPaths: [...context.task.changedPaths],
        },
        // 保存复现是修复流程的中间检查点；若用户已经要求修复，应允许同一 Agent
        // 继续定位和 patch。其余结论则结束本次模型循环，避免无证据地追加动作。
        terminate: input.status !== "reproduced",
      };
    },
  });
}
