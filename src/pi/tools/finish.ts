/**
 * Pi `finish` 诊断、总方案审批与复现结论工具。
 *
 * 本文件保存低敏中文结论，并在 `reproduced` 状态下把当前 500 条以内的语义 Trace
 * 截取为可重放用例。`proposed` 会先展示病因、完整方案、验证和风险；用户确认后只为
 * 当前 Agent 运行开放 Pi 原生 Coding 工具。它不相信模型声称测试通过；`result` 会自动
 * 调用 repair verification，只有固定检查、刷新重放和隐藏断言全部通过才进入 ready_to_apply。
 * `/verify` 仅作为用户显式重试入口，正式仓库仍只能由 `/apply` 修改。
 * SQL、答案、完整地图、存档和凭据会在持久化前脱敏。复现缺少真实 go/use/input_sql/query
 * 动作时明确拒绝，避免把单次 look 当成运行证据。
 */

import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { claimEvidence } from "../../evidence/projector.js";
import { readDiagnosticEvidence } from "../../evidence/diagnostic.js";
import type { EvidenceStore } from "../../evidence/store.js";
import type { GameDriver } from "../../game/driver.js";
import { appendEvent } from "../../logging/events.js";
import { redactText } from "../../logging/redact.js";
import { saveReproduction } from "../../repair/reproduction.js";
import type { VerificationResult } from "../../repair/verification.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { validateWriteScopePaths } from "../../workspace/write-scope.js";

const ReproductionAssertionsParameters = Type.Object({
  floor: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  mode: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  minLessons: Type.Optional(Type.Integer({ minimum: 0 })),
  minStageIndex: Type.Optional(Type.Integer({
    minimum: 0,
    description: "修复后战斗终端 stageIndex 至少达到的值；战斗题目阶段必须使用本字段，不能写 advancedFromFloor。",
  })),
  advancedFromFloor: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 8,
    description: "修复后应离开的楼层号，只用于楼层/传送门推进，不表示战斗终端题目阶段。",
  })),
  bossDefeated: Type.Optional(Type.Boolean()),
  queryAccepted: Type.Optional(Type.Boolean({
    description: "修复后重放期望查询是否被接受，不是当前故障现场值。",
  })),
  queryAcceptedSequence: Type.Optional(Type.Array(Type.Boolean(), {
    minItems: 1,
    maxItems: 8,
    description: "按提交顺序精确声明每次 query 修复后是否被接受。",
  })),
  queryPlanSequence: Type.Optional(Type.Array(Type.Union([
    Type.Literal("scan"),
    Type.Literal("search"),
    Type.Literal("none"),
  ]), {
    minItems: 1,
    maxItems: 8,
    description: "按提交顺序精确声明每次 query 展示的计划类别。",
  })),
  terminalOpen: Type.Optional(Type.Boolean({
    description: "修复后重放期望终端是否打开；终端本应打开时必须填 true。",
  })),
}, { additionalProperties: false, minProperties: 1 });

const ReproductionParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 160 }),
  expected: Type.String({ minLength: 1, maxLength: 400 }),
  actual: Type.String({ minLength: 1, maxLength: 400 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: 8,
  }),
  assertions: ReproductionAssertionsParameters,
}, { additionalProperties: false });

const PlanStepParameters = Type.Union([
  Type.String({ minLength: 1, maxLength: 300 }),
  Type.Object({
    text: Type.String({ minLength: 1, maxLength: 300 }),
  }, { additionalProperties: false }),
]);

const ExecutionPlanParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 160 }),
  steps: Type.Array(PlanStepParameters, {
    minItems: 1,
    maxItems: 8,
  }),
  verification: Type.String({ minLength: 1, maxLength: 600 }),
  allowedPaths: Type.Array(Type.String({
    minLength: 1,
    maxLength: 300,
    description: "精确项目相对文件路径；每项只能是单个文件，不能是目录。",
  }), {
    minItems: 1,
    maxItems: 12,
  }),
}, { additionalProperties: false });
// 只拒绝“根因或修改目标仍未确定”的方案。验证步骤本来就描述未来要执行的检查，
// 因此“需要运行测试验证”不能被误判为未完成诊断。
const UNRESOLVED_PLAN_PATTERN =
  /(?:仍需(?:确认|检查|读取|定位|查找|补充)|需(?:要)?(?:先|进一步)(?:确认|检查|读取|定位|查找|补充)|必须先(?:确认|检查|读取|定位|查找)|尚未(?:确认|检查|读取|定位|查明)|未及(?:读取|检查|定位)|不确定|无法确认|有待(?:确认|检查|读取|定位|查明))/iu;

/** `finish` 的严格结论契约。 */
export const FinishParameters = Type.Object({
  status: Type.Union([
    Type.Literal("reproduced"),
    Type.Literal("diagnosed"),
    Type.Literal("proposed"),
    Type.Literal("result"),
    Type.Literal("blocked"),
  ]),
  summary: Type.String({
    minLength: 1,
    maxLength: 1_200,
    description: "简短明确的结论；不得写未确认推测。",
  }),
  risk: Type.String({
    minLength: 1,
    maxLength: 600,
    description: "至少一个短句；没有实际风险时填写“无”。",
  }),
  reproduction: Type.Optional(ReproductionParameters),
  plan: Type.Optional(ExecutionPlanParameters),
}, { additionalProperties: false });

/** 注册结论工具所需的单任务和 Trace 依赖。 */
export interface FinishToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  currentDriver(): GameDriver | null;
  approveExecution(): void;
  completeExecution(): void;
  isExecutionApproved(): boolean;
  repairRequested(): boolean;
  verifyTask(signal?: AbortSignal): Promise<VerificationResult>;
}

function plain(value: string, limit: number): string {
  const normalized = value
    .replace(/[\r\n\t]+/gu, " ")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");
  if (/\p{Cc}/u.test(normalized)) {
    throw new Error("finish 只接受无控制字符的纯文本");
  }
  const output = redactText(normalized).replace(/\s+/gu, " ").trim().slice(0, limit);
  if (!output) throw new Error("finish 结论不能为空");
  return output;
}

function verificationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知验证错误";
  return redactText(message).replace(/\s+/gu, " ").trim().slice(0, 400)
    || "未知验证错误";
}

function assertExpectedBoolean(
  expected: string,
  field: "queryAccepted" | "terminalOpen",
  actual: boolean | undefined,
): void {
  const match = expected.match(new RegExp(field + "\\s*=\\s*(true|false)", "iu"));
  if (!match) return;
  const required = match[1]?.toLowerCase() === "true";
  if (actual !== required) {
    throw new Error(
      "复现断言 " + field + " 必须描述修复后的期望值 " + String(required)
      + "，不能填写当前故障现场值。",
    );
  }
}

/**
 * proposed 阶段的证据软提示。
 *
 * 这些提示帮助模型补齐证据链，但不改变既有审批流程；只有 result 阶段的固定检查、
 * 刷新重放和隐藏断言继续承担硬门禁，避免诊断阶段因额外读取而拖慢任务。
 */
async function proposedEvidenceWarnings(
  evidence: EvidenceStore,
): Promise<string[]> {
  const warnings: string[] = [];
  let state;
  try {
    state = await readDiagnosticEvidence(evidence);
  } catch {
    // proposed 的证据提示必须是软门槛；账本损坏或历史工件缺失不能阻止用户审批，
    // 只把异常降级为可见提示，result 阶段仍会通过真实验证暴露问题。
    return ["证据账本读取不完整；请在执行前用 evidence(list/get) 检查现有记录。"];
  }
  if (!state.hasReproduction) {
    warnings.push("未保存可重放复现；若这是非运行时问题可以忽略。");
  }
  if (!state.hasSourceRead) {
    warnings.push("当前源码证据不足；建议在执行前补一次 inspect read/bundle。");
  }
  if (state.actionNotAvailable && state.missingActionEvidence.length > 0) {
    warnings.push("action-not-available 证据仍缺少：" + state.missingActionEvidence.join("、") + "。");
  }
  return warnings;
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
    description: "保存诊断、提交一次性完整修复方案、记录复现；result 会完成固定验证，但自然结束本轮不会自动触发验证，也不会执行 /apply。",
    promptSnippet: "可用 proposed 预先说明多文件方案；完成后用 result 保存结果",
    promptGuidelines: [
      "运行时问题复现成功后，以 reproduced 保存语义动作及至少一项修复后应满足的结构化结果断言；不要把当前故障值当成断言。",
      "首次 query-accepted 已经证明 stageIndex 未按期望推进时立即 reproduced，不要再追加 input_sql/query 确认；阶段目标使用 minStageIndex。",
      "用户要求修复时，定位病因后可直接 patch/write；首次写入会自动申请精确文件权限。只有需要提前说明多文件方案时才用 proposed。",
      "代码修改后用 result；工具会自动运行当前代码的固定检查、刷新重放和隐藏断言，失败时继续修复。",
      "确认无法继续且原因客观时才用 blocked。",
    ],
    executionMode: "sequential",
    parameters: FinishParameters,
    async execute(
      _toolCallId,
      input,
      signal,
      _onUpdate,
      extensionContext: ExtensionContext,
    ) {
      if (
        context.task.state === "applied"
        || context.task.state === "discarded"
      ) {
        throw new Error("终态任务不能继续提交诊断或复现结论");
      }
      const summary = plain(input.summary, 1_200);
      const risk = plain(input.risk, 600);
      if (input.status === "diagnosed" && context.repairRequested()) {
        throw new Error(
          "当前用户请求要求修复，diagnosed 不是终态；请继续提交 proposed，或在客观无法继续时提交 blocked。",
        );
      }
      if (input.status === "proposed" && !input.plan) {
        throw new Error("proposed 必须给出一次性完整方案和验证方法");
      }
      if (input.status !== "proposed" && input.plan) {
        throw new Error("只有 proposed 状态可以携带执行方案");
      }
      let reproductionId: string | null = null;
      if (input.status === "reproduced") {
        if (!input.reproduction) {
          throw new Error("reproduced 必须提供期望、实际和证据");
        }
        assertExpectedBoolean(
          input.reproduction.expected,
          "terminalOpen",
          input.reproduction.assertions.terminalOpen,
        );
        assertExpectedBoolean(
          input.reproduction.expected,
          "queryAccepted",
          input.reproduction.assertions.queryAccepted,
        );
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
          context.evidence,
          context.task,
          driver.trace,
          {
            title: input.reproduction.title,
            expected: input.reproduction.expected,
            actual: input.reproduction.actual,
            evidence: input.reproduction.evidence,
            assertions: input.reproduction.assertions,
          },
        );
        reproductionId = reproduction.id;
      } else if (input.reproduction) {
        if (input.status !== "proposed" || !(await context.evidence.latest("reproduction"))) {
          throw new Error("只有 reproduced 状态可以新建 reproduction；proposed 只能重复携带当前已保存的复现");
        }
      }

      let executionApproved: boolean | null = null;
      let verification: VerificationResult | null = null;
      let planSummary = "";
      let planTitle: string | undefined;
      let planSteps: string[] | undefined;
      let planVerification: string | undefined;
      let planAllowedPaths: string[] | undefined;
      let evidenceWarnings: string[] = [];
      if (input.status === "proposed" && input.plan) {
        const title = plain(input.plan.title, 160);
        const steps = input.plan.steps.map((step) => plain(
          typeof step === "string" ? step : step.text,
          300,
        ));
        const verification = plain(input.plan.verification, 600);
        if (UNRESOLVED_PLAN_PATTERN.test([
          summary,
          risk,
          title,
          ...steps,
        ].join(" "))) {
          throw new Error(
            "完整修复方案仍包含未确认推测；请删除未证实的顺手修改，只保留现有证据直接证明的最小修复后重新 proposed。",
          );
        }
        const allowedPaths = await validateWriteScopePaths(
          context.task.worktreeRoot,
          input.plan.allowedPaths,
        );
        planTitle = title;
        planSteps = steps;
        planVerification = verification;
        planAllowedPaths = allowedPaths;
        evidenceWarnings = await proposedEvidenceWarnings(context.evidence);
        planSummary = [
          "方案：" + title,
          ...steps.map((step, index) => String(index + 1) + ". " + step),
          "验证：" + verification,
          "允许修改文件：" + allowedPaths.join(", "),
        ].join("\n");
        const approvalMessage = [
          "病因：" + summary,
          "",
          planSummary,
          evidenceWarnings.length > 0
            ? "\n证据提示（软提示，不会阻止批准）：\n" + evidenceWarnings.map((warning) => "- " + warning).join("\n")
            : "",
          "",
          "风险：" + risk,
          "",
          "确认后将为当前 Agent 运行开放 Pi 原生 write 与精确 patch，并在 detached worktree 一次执行完整方案。",
        ].join("\n");
        const factLinks = (await context.evidence.active())
          .filter((record) => (
            record.kind === "source"
            || record.kind === "game"
            || record.kind === "check"
            || record.kind === "reproduction"
          ))
          .map((record) => record.id);
        await context.evidence.capture(claimEvidence({
          status: input.status,
          summary,
          risk,
          planTitle,
          planSteps,
          verification: planVerification,
          allowedPaths: planAllowedPaths,
          links: factLinks,
        }));
        executionApproved = await extensionContext.ui.confirm(
          "是否执行完整修复方案",
          approvalMessage,
        );
        const digest = createHash("sha256")
          .update(context.task.id + ":" + context.task.baseHead + ":" + approvalMessage)
          .digest("hex");
        await appendEvent(context.store, context.task.id, "execution.approval", {
          digest: digest.slice(0, 16),
          approved: executionApproved,
        });
        if (executionApproved) {
          await context.store.approveWriteScope(context.task, allowedPaths, digest);
          context.approveExecution();
        } else {
          await context.store.closeWriteScope(context.task);
          context.completeExecution();
        }
      } else if (input.status === "result") {
        if (!context.isExecutionApproved()) {
          throw new Error("当前 Agent 运行没有已批准的修复方案；请使用 /verify 人工重试旧修改");
        }
        try {
          verification = await context.verifyTask(signal);
        } catch (error) {
          await appendEvent(context.store, context.task.id, "tool.finish", {
            status: "result",
            verificationPassed: false,
          });
          throw new Error(
            "自动验证未通过；保留修改权限，请继续修复后再次提交 result："
            + verificationFailure(error),
          );
        }
        if (
          context.task.state !== "ready_to_apply"
          || verification.changedPaths.length === 0
        ) {
          throw new Error("自动验证没有生成绑定当前变更的可应用结果");
        }
        context.completeExecution();
        await context.store.closeWriteScope(context.task);
      } else if (input.status === "blocked") {
        context.completeExecution();
        await context.store.closeWriteScope(context.task);
      }

      if (input.status === "result" || input.status === "blocked" || input.status === "diagnosed") {
        const terminalLinks = input.status === "result"
          ? (await context.evidence.active("verification")).map((record) => record.id)
          : (await context.evidence.active())
            .filter((record) => record.kind !== "claim")
            .map((record) => record.id);
        await context.evidence.capture(claimEvidence({
          status: input.status,
          summary,
          risk,
          links: terminalLinks,
        }));
      }

      if (input.status === "blocked" && context.task.state !== "blocked") {
        await context.store.transition(context.task, "blocked");
      } else {
        await context.store.save(context.task);
      }
      await appendEvent(context.store, context.task.id, "tool.finish", {
        status: input.status,
        reproductionId,
        verificationPassed: verification !== null,
      });
      const visibleConclusion = [
        summary,
        input.status === "blocked" ? "阻塞：" + risk : "风险：" + risk,
        input.status === "result" ? "候选聚焦验证通过；现在可以执行 /apply，写回前会运行完整质量门。" : "",
        executionApproved === false ? "用户未批准执行；worktree 保持不变。" : "",
      ].filter(Boolean).join("\n");
      if (
        input.status === "diagnosed"
        || input.status === "result"
        || input.status === "blocked"
        || executionApproved === false
      ) {
        // 这些状态会 terminate，Pi 不会再生成 assistant 正文；必须在结束模型循环前
        // 把已经脱敏的结论显式送到 Shell，否则用户只会看到“本轮处理完成”。
        extensionContext.ui.notify(
          visibleConclusion,
          input.status === "blocked" ? "warning" : "info",
        );
      }
      return {
        content: [{
          type: "text",
          text: [
            summary,
            planSummary,
            "风险：" + risk,
            executionApproved !== true && evidenceWarnings.length > 0
              ? "证据提示：" + evidenceWarnings.join(" ")
              : "",
            executionApproved === true
              ? "用户已批准方案，调查阶段结束；立即在 allowedPaths 内使用 patch/write 完整执行，不要再次询问或遍历 evidence。只有缺少精确 oldText/baseHash 时才定向回读对应文件一次。"
              : "",
            executionApproved === false ? "用户未批准执行；worktree 保持不变。" : "",
            reproductionId ? "复现：" + reproductionId : "",
            context.task.state === "ready_to_apply"
              ? "任务已验证，可由用户执行 /apply。"
              : "任务尚未完成验证。",
          ].filter(Boolean).join("\n"),
        }],
        details: {
          status: input.status,
          state: context.task.state,
          reproductionId,
          changedPaths: [...context.task.changedPaths],
          executionApproved,
          evidenceWarnings,
          verification: verification ? {
            worktreeHash: verification.record.worktreeHash,
            checkIds: verification.record.checkIds,
            replayPassed: verification.record.replayPassed,
          } : null,
        },
        // 复现和获批方案都在同一个 Pi Agent turn 内继续；拒绝、最终结果、诊断结论
        // 或真实阻塞才结束本次自然请求，不创建隐藏的后继模型回合。
        terminate: input.status === "proposed"
          ? executionApproved !== true
          : input.status !== "reproduced",
      };
    },
  });
}
