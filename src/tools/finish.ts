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
import { redactText } from "../safety/redact.js";
import { audit, type ToolContext, type ToolOutput } from "./context.js";

/** 允许模型声明的四种业务结论。 */
export const FinishParams = Type.Object({
  status: Type.Union([Type.Literal("diagnosed"), Type.Literal("needs_approval"), Type.Literal("ready"), Type.Literal("blocked")]),
  summary: Type.String({ minLength: 1, maxLength: 1200 }),
  risk: Type.String({ minLength: 1, maxLength: 600 }),
  checks: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 12 }),
}, { additionalProperties: false });
/** finish 参数类型。 */
export type FinishInput = Static<typeof FinishParams>;

/** 最终任务摘要。 */
export interface FinishResult {
  state: string;
  patchPath: string | null;
  reportPath: string;
  changedPaths: string[];
}

function cell(value: string): string {
  return redactText(value).replaceAll("|", "\\|").replace(/\r?\n/gu, " ").trim();
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

## 改动范围

${paths}

- 累计补丁预算：${String(task.changedPaths.length)} / 3 个文件，${String(task.patchLines)} / 120 行。

## 固定检查

${checks}

## 实机试玩

${plays}

## 模型用量

- 回合：${String(task.usage.turns)} / 20
- 工具调用：${String(task.usage.toolCalls)} / 40
- Token：${String(tokenTotal)} / 64000
`;
  await writeFile(reportPath, body, "utf8");
  return reportPath;
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
  const passed = new Set(task.checks.filter((item) => item.status === "passed" && item.hash === currentHash).map((item) => item.id));
  const falseClaims = input.checks.filter((id) => !passed.has(id));
  if (falseClaims.length > 0) throw new Error(`以下检查没有真实通过记录：${falseClaims.join(", ")}`);
  const summary = redactText(input.summary);
  const risk = redactText(input.risk);
  task.conclusion = `结论：${summary}\n风险：${risk}`;

  if (input.status === "needs_approval") {
    if (task.state !== "needs_approval") throw new Error("任务没有待处理的核心审批");
  } else if (input.status === "ready") {
    if (task.mode !== "fix" || !task.worktreeRoot) throw new Error("只有 fix worktree 可以生成补丁");
    if (input.checks.length === 0) throw new Error("ready 至少需要一个真实通过的检查");
    const captured = await capturePatch(task, context.store.taskDir(task.id));
    const expected = [...task.changedPaths].sort();
    if (captured.paths.join("\n") !== expected.join("\n")) {
      throw new Error("worktree 包含未经过 patch 工具记录的文件变化");
    }
    task.changedPaths = captured.paths;
    task.baseHashes = captured.baseHashes;
    task.patchPath = captured.patchPath;
    task.reversePatchPath = captured.reversePatchPath;
    if (task.state !== "verifying") throw new Error("ready 前必须处于 verifying 状态");
    await context.store.transition(task, "ready_to_apply");
  } else if (input.status === "blocked") {
    if (task.state !== "blocked") await context.store.transition(task, "blocked");
  } else {
    if (task.mode !== "diagnose") throw new Error("fix 任务不能以 diagnosed 跳过补丁或阻断说明");
    if (task.state !== "verifying" && task.state !== "diagnosing") throw new Error("诊断任务状态不允许结束");
    await context.store.save(task);
  }
  await context.store.save(task);
  const reportPath = await writeReport(context, { ...input, summary, risk });
  await audit(context, "finish", input.status);
  return {
    text: `${summary}\n风险：${risk}\n状态：${task.state}\n报告：${reportPath}`,
    details: { state: task.state, patchPath: task.patchPath, reportPath, changedPaths: task.changedPaths },
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
