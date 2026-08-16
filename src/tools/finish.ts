/**
 * 任务结束声明与补丁封装工具。
 *
 * `finish` 不相信模型自行声称“测试已通过”：ready 状态必须存在当前 worktree Hash 下
 * 的真实通过记录，随后才生成正向和反向补丁。诊断与阻断结论只保存中文摘要，
 * 不把代码、SQL、地图或完整浏览器状态写入任务记录。核心审批缺失时只能结束为
 * `needs_approval`，目标分支在独立 `apply` 命令前始终不变。
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capturePatch, hashWorktree } from "../safety/worktree.js";
import { containsPrivateText, redactText } from "../safety/redact.js";
import { classifyPath, normalizeProjectPath } from "../safety/policy.js";
import type { Diagnosis } from "../runtime/task.js";
import { audit, type ToolContext, type ToolOutput } from "./context.js";

/** Dashboard 可展示的严格诊断结构。 */
export const DiagnosisParams = Type.Object({
  result: Type.Union([
    Type.Literal("fault"), Type.Literal("healthy"), Type.Literal("blocked"),
  ]),
  issue: Type.String({ minLength: 1, maxLength: 160 }),
  cause: Type.String({ minLength: 1, maxLength: 400 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 6 }),
  fix: Type.String({ minLength: 1, maxLength: 600 }),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 3 }),
  risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
}, { additionalProperties: false });

/** 允许模型声明的四种业务结论。 */
export const FinishParams = Type.Object({
  status: Type.Union([Type.Literal("diagnosed"), Type.Literal("needs_approval"), Type.Literal("ready"), Type.Literal("blocked")]),
  summary: Type.String({ minLength: 1, maxLength: 1200 }),
  risk: Type.String({ minLength: 1, maxLength: 600 }),
  checks: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 12 }),
  diagnosis: Type.Optional(DiagnosisParams),
}, { additionalProperties: false });
/** finish 参数类型。 */
export type FinishInput = Static<typeof FinishParams>;

/** 最终任务摘要。 */
export interface FinishResult {
  state: string;
  patchPath: string | null;
  reportPath: string;
  changedPaths: string[];
  diagnosis: Diagnosis | null;
}

function cell(value: string): string {
  return redactText(value).replaceAll("|", "\\|").replace(/\r?\n/gu, " ").trim();
}

function plain(value: string, label: string, limit: number): string {
  if (/[<>]|\p{Cc}/u.test(value)) throw new Error(`${label} 必须是无 HTML 和控制字符的纯文本`);
  if (containsPrivateText(value)) throw new Error(`${label} 不得包含 SQL、凭据或完整游戏状态`);
  const output = redactText(value).replace(/\s+/gu, " ").trim().slice(0, limit);
  if (!output) throw new Error(`${label} 不能为空`);
  return output;
}

function cleanDiagnosis(value: Diagnosis): Diagnosis {
  const paths = [...new Set(value.paths.map(normalizeProjectPath))];
  if (paths.length > 3) throw new Error("诊断文件最多三个");
  if (paths.some((path) => classifyPath(path, "write") === "denied")) {
    throw new Error("诊断方案包含永久禁止路径");
  }
  if (value.result !== "fault" && paths.length > 0) {
    throw new Error("只有 fault 诊断可以声明修改文件");
  }
  return {
    result: value.result,
    issue: plain(value.issue, "故障", 160),
    cause: plain(value.cause, "原因", 400),
    evidence: value.evidence.slice(0, 6).map((item) => plain(item, "证据", 160)),
    fix: plain(value.fix, "解决方法", 600),
    paths,
    risk: value.risk,
  };
}

async function writeReport(
  context: ToolContext,
  input: FinishInput,
): Promise<string> {
  const task = context.task;
  const reportPath = join(context.store.taskDir(task.id), "report.md");
  const tokenTotal = task.usage.input + task.usage.output + task.usage.cacheRead + task.usage.cacheWrite;
  const checks = task.checks.length === 0
    ? "- 未运行固定检查。"
    : task.checks.map((item) => `- \`${cell(item.id)}\`：${cell(item.status)}，${String(item.ms)} ms`).join("\n");
  const plays = task.plays.length === 0
    ? "- 未运行实机试玩。"
    : task.plays.map((item) => `- \`${cell(item.key)}\`：${cell(item.status)}；证据：\`${cell(item.reportPath)}\``).join("\n");
  const paths = task.changedPaths.length === 0
    ? "- 无代码改动。"
    : task.changedPaths.map((path) => `- \`${cell(path)}\``).join("\n");
  const diagnosis = task.diagnosis
    ? `## 结构化诊断

- 结果：\`${task.diagnosis.result}\`
- 故障：${cell(task.diagnosis.issue)}
- 原因：${cell(task.diagnosis.cause)}
- 解决方法：${cell(task.diagnosis.fix)}
- 风险：\`${task.diagnosis.risk}\`
- 证据：${task.diagnosis.evidence.map(cell).join("；") || "无"}
- 建议文件：${task.diagnosis.paths.map((path) => `\`${cell(path)}\``).join("、") || "无"}

`
    : "";
  const body = `# Dungeon Maintainer 任务报告

- 任务：\`${task.id}\`
- 模式：\`${task.mode}\`
- 状态：\`${task.state}\`
- Git 基线：\`${task.baseHead}\`
- 目标：${cell(task.objective)}

## 结论

${cell(input.summary)}

## 风险

${cell(input.risk)}

${diagnosis}## 改动范围

${paths}

- 累计补丁预算：${String(task.changedPaths.length)} / 3 个文件，${String(task.patchLines)} / 120 行。

## 固定检查

${checks}

## 实机试玩

${plays}

## 模型用量

- 累计回合：${String(task.usage.turns)}
- 累计工具调用：${String(task.usage.toolCalls)}
- Token：${String(tokenTotal)} / 64000
`;
  await writeFile(reportPath, body, "utf8");
  return reportPath;
}

function passedChecks(context: ToolContext, hash: string): Set<string> {
  return new Set(context.task.checks
    .filter((item) => item.status === "passed" && item.hash === hash)
    .map((item) => item.id));
}

/**
 * 在真实检查与隐藏复测都完成后封装补丁。
 *
 * @param context 当前修复任务；Dashboard 由 Runner 在隐藏裁判通过后调用。
 * @throws 缺少适配器要求的检查、worktree 含未登记变化或任务状态不正确时拒绝。
 */
export async function finalizeReady(context: ToolContext): Promise<void> {
  const task = context.task;
  if (task.mode !== "fix" || !task.worktreeRoot) throw new Error("只有 fix worktree 可以生成补丁");
  if (task.state !== "verifying") throw new Error("ready 前必须处于 verifying 状态");
  const currentHash = await hashWorktree(task.worktreeRoot);
  const passed = passedChecks(context, currentHash);
  const missing = (context.stage === "repair" ? context.checks?.required(task.changedPaths) ?? [] : [])
    .filter((id) => !passed.has(id));
  if (missing.length > 0) throw new Error(`缺少适配器要求的检查：${missing.join(", ")}`);
  const captured = await capturePatch(task, context.store.taskDir(task.id));
  const expected = [...task.changedPaths].sort();
  if (captured.paths.join("\n") !== expected.join("\n")) {
    throw new Error("worktree 包含未经过 patch 工具记录的文件变化");
  }
  task.changedPaths = captured.paths;
  task.baseHashes = captured.baseHashes;
  task.patchPath = captured.patchPath;
  task.reversePatchPath = captured.reversePatchPath;
  await context.store.transition(task, "ready_to_apply");
}

/**
 * 核验并结束当前任务。
 * @param context 当前任务上下文。
 * @param input 中文总结、风险和模型声明的检查 ID。
 * @returns 持久化状态及补丁位置。
 * @throws ready 缺少实际通过检查、诊断任务要求补丁或状态不允许结束时抛错。
 */
export async function finish(context: ToolContext, input: FinishInput): Promise<ToolOutput<FinishResult>> {
  const task = context.task;
  const currentHash = await hashWorktree(task.worktreeRoot ?? task.repoRoot);
  const passed = passedChecks(context, currentHash);
  const falseClaims = input.checks.filter((id) => !passed.has(id));
  if (falseClaims.length > 0) throw new Error(`以下检查没有真实通过记录：${falseClaims.join(", ")}`);
  const summary = redactText(input.summary);
  const risk = redactText(input.risk);
  const diagnosis = input.diagnosis ? cleanDiagnosis(input.diagnosis) : null;
  if (context.stage === "probe" && !diagnosis) throw new Error("Dashboard 排查必须返回结构化诊断");
  if (diagnosis) task.diagnosis = diagnosis;
  task.conclusion = `结论：${summary}\n风险：${risk}`;

  if (input.status === "needs_approval") {
    if (task.state !== "needs_approval") throw new Error("任务没有待处理的核心审批");
  } else if (input.status === "ready") {
    if (task.mode !== "fix" || !task.worktreeRoot) throw new Error("只有 fix worktree 可以生成补丁");
    if (input.checks.length === 0) throw new Error("ready 至少需要一个真实通过的检查");
    if (task.state !== "verifying") throw new Error("ready 前必须处于 verifying 状态");
    const missing = (context.stage === "repair" ? context.checks?.required(task.changedPaths) ?? [] : [])
      .filter((id) => !passed.has(id));
    if (missing.length > 0) throw new Error(`缺少适配器要求的检查：${missing.join(", ")}`);
    if (context.deferReady) await context.store.save(task);
    else await finalizeReady(context);
  } else if (input.status === "blocked") {
    if (task.state !== "blocked") await context.store.transition(task, "blocked");
  } else {
    if (task.mode !== "diagnose" && context.stage !== "probe") {
      throw new Error("fix 任务不能以 diagnosed 跳过补丁或阻断说明");
    }
    if (context.stage === "probe" && task.changedPaths.length > 0) {
      throw new Error("Dashboard 排查阶段不能包含代码改动");
    }
    if (task.state !== "verifying" && task.state !== "diagnosing") throw new Error("诊断任务状态不允许结束");
    await context.store.save(task);
  }
  await context.store.save(task);
  const reportPath = await writeReport(context, { ...input, summary, risk });
  await audit(context, "finish", input.status);
  return {
    text: `${summary}\n风险：${risk}\n状态：${task.state}\n报告：${reportPath}`,
    details: {
      state: task.state,
      patchPath: task.patchPath,
      reportPath,
      changedPaths: task.changedPaths,
      diagnosis: task.diagnosis,
    },
  };
}

/**
 * 创建 Pi Core 可调用的 finish 工具。
 * @param context 单一任务上下文。
 * @returns 成功后终止当前自动工具循环的顺序工具。
 */
export function finishTool(context: ToolContext): AgentTool<typeof FinishParams, FinishResult> {
  return {
    name: "finish", label: "结束任务", executionMode: "sequential",
    description: "核验真实检查并生成诊断结论、审批请求、补丁或阻断报告。",
    parameters: FinishParams,
    execute: async (_id, input) => {
      const output = await finish(context, input);
      return { content: [{ type: "text", text: output.text }], details: output.details, terminate: true };
    },
  };
}
