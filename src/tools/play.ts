/**
 * SQL Dungeon 确定性试玩工具入口。
 *
 * 本文件只把一次 `play` 调用转给适配器 Runner，并负责 worktree Hash 缓存和任务记录。
 * 浏览器内的移动、BFS、答案提交和隐藏裁判不经过模型，因此试玩本身产生 0 token；
 * 模型只能读取压缩报告，不能逐步控制角色，也不能获得 SQL、地图、答案或快照。
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runPlaytest } from "../adapters/sql-dungeon/player.js";
import { readPlayReport, type PlayReport } from "../adapters/sql-dungeon/report.js";
import { hashWorktree } from "../safety/worktree.js";
import { audit, checkAbort, type ToolContext, type ToolOutput } from "./context.js";

/** 一次确定性试玩的严格参数。 */
export const PlayParams = Type.Object({
  scope: Type.Union([Type.Literal("floor"), Type.Literal("suite")]),
  floor: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  headed: Type.Optional(Type.Boolean()),
  url: Type.Optional(Type.String({ maxLength: 300 })),
}, { additionalProperties: false });
/** play 参数类型。 */
export type PlayInput = Static<typeof PlayParams>;

/** 返回模型的试玩索引。 */
export interface PlayResult {
  status: string;
  reportPath: string;
  floors: number[];
  cached: boolean;
}

/**
 * 执行确定性试玩并记录压缩结果。
 * @param context 当前任务与 worktree。
 * @param input 单层或八层套件；单层必须提供 floor。
 * @param signal 取消时关闭浏览器和自启服务。
 * @returns 不含 SQL、地图和完整快照的摘要及报告路径。
 */
export async function play(
  context: ToolContext,
  input: PlayInput,
  signal?: AbortSignal,
): Promise<ToolOutput<PlayResult>> {
  checkAbort(signal);
  if (input.scope === "floor" && input.floor === undefined) throw new Error("单层试玩必须提供 floor");
  const root = context.task.worktreeRoot ?? context.task.repoRoot;
  const key = `${input.scope}:${String(input.floor ?? "all")}`;
  const codeHash = await hashWorktree(root);
  const cached = [...context.task.plays].reverse().find((item) => item.key === key && item.hash === codeHash);
  if (cached) {
    const report = await readPlayReport(cached.reportPath);
    await audit(context, "play", "cache");
    return {
      text: `[CACHE / 0 TOKENS]\n${report.summary}`,
      details: { status: report.status, reportPath: report.reportPath, floors: report.floors.map((item) => item.floor), cached: true },
    };
  }
  const report: PlayReport = await runPlaytest({
    repoRoot: root,
    outputRoot: `${context.store.taskDir(context.task.id)}/play`,
    floors: input.scope === "suite" ? [1, 2, 3, 4, 5, 6, 7, 8] : [input.floor ?? 1],
    headed: input.headed ?? false,
    ...(input.url ? { url: input.url } : {}),
    ...(signal ? { signal } : {}),
  });
  const record = {
    key,
    hash: report.codeHash,
    status: report.status,
    reportPath: report.reportPath,
    savedAt: new Date().toISOString(),
  };
  context.task.plays.push(record);
  await context.store.save(context.task);
  await audit(context, "play", report.status);
  return {
    text: report.summary,
    details: { status: report.status, reportPath: report.reportPath, floors: report.floors.map((item) => item.floor), cached: false },
  };
}

/**
 * 创建 Pi Core 可调用的 play 工具。
 * @param context 单一任务上下文。
 * @returns 一次调用完成整层或整套测试的顺序工具。
 */
export function playTool(context: ToolContext): AgentTool<typeof PlayParams, PlayResult> {
  return {
    name: "play", label: "实机试玩", executionMode: "sequential",
    description: "启动确定性浏览器试玩；一次调用完成单层或八层，不让模型逐步移动。",
    parameters: PlayParams,
    execute: async (_id, input, signal) => {
      const output = await play(context, input, signal);
      return { content: [{ type: "text", text: output.text }], details: output.details };
    },
  };
}
