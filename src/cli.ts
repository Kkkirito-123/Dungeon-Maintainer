#!/usr/bin/env node
/**
 * Dungeon Maintainer 唯一命令入口。
 *
 * CLI 负责解析固定命令、创建或恢复任务、展示核心批准 token，以及调用安全的
 * `apply/revert`。它不实现模型决策、文件权限、Git 补丁或试玩规则。`fix` 只在干净
 * 目标仓库创建 detached worktree；`apply` 前会再次检查 HEAD、工作区与 baseHash。
 * 无参数时进入轻量交互循环，所有子命令仍走同一解析和执行函数。
 *
 * stdout 只输出任务 ID、状态、中文摘要和产物路径；API Key、prompt、completion、
 * SQL、地图和快照永远不打印。Ctrl+C 通过 AbortSignal 中止当前模型或浏览器运行。
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyProject } from "./adapters/sql-dungeon/adapter.js";
import { runAgent, type RunResult } from "./runtime/agent.js";
import { loadConfig, type RuntimeConfig } from "./runtime/config.js";
import type { RuntimeModel } from "./runtime/model.js";
import { TaskStore, type TaskMode, type TaskRecord } from "./runtime/task.js";
import {
  applyTaskPatch, createTaskWorktree, readRepo, revertTaskPatch,
} from "./safety/worktree.js";
import { play } from "./tools/play.js";

/** CLI 依赖，测试可注入隔离配置和输出。 */
export interface CliDeps {
  config: RuntimeConfig;
  /** 仅供测试注入的 Pi Faux 模型；真实 CLI 不设置。 */
  model?: RuntimeModel;
  write(line: string): void;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (["--repo", "--floor", "--url"].includes(value)) { index += 1; continue; }
    if (["--suite", "--headed"].includes(value)) continue;
    output.push(value);
  }
  return output;
}

function help(): string {
  return `Dungeon Maintainer V1

用法：
  dungeon-maintain
  dungeon-maintain diagnose --repo <path> "<问题>"
  dungeon-maintain fix --repo <path> "<问题>"
  dungeon-maintain approve <task-id> <token>
  dungeon-maintain status <task-id>
  dungeon-maintain apply <task-id>
  dungeon-maintain revert <task-id>
  dungeon-maintain play --repo <path> --floor <1-8> [--headed] [--url <localhost>]
  dungeon-maintain play --repo <path> --suite game-v1 [--headed] [--url <localhost>]`;
}

async function modelRun(
  config: RuntimeConfig,
  store: TaskStore,
  task: TaskRecord,
  signal: AbortSignal,
  model?: RuntimeModel,
): Promise<RunResult> {
  try {
    return await runAgent(config, store, task, {
      signal,
      ...(model ? { model } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知运行错误";
    task.conclusion = message.startsWith("BLOCKED_ENV") ? message : `运行失败：${error instanceof Error ? error.name : "UnknownError"}`;
    if (task.state !== "blocked" && task.state !== "failed") {
      await store.transition(task, message.startsWith("BLOCKED_ENV") ? "blocked" : "failed");
    }
    return { outcome: message.startsWith("BLOCKED_ENV") ? "blocked" : "failed", approvalToken: null, text: task.conclusion };
  }
}

async function createTask(
  mode: TaskMode,
  repoArg: string | undefined,
  objective: string,
  deps: CliDeps,
  signal: AbortSignal,
): Promise<number> {
  if (!repoArg || !objective.trim()) throw new Error(`${mode} 需要 --repo 和非空问题描述`);
  const state = await readRepo(resolve(repoArg));
  await verifyProject(state.root);
  const store = new TaskStore(deps.config.dataDir);
  const task = await store.create({ mode, objective, repoRoot: state.root, baseHead: state.head });
  if (mode === "fix") {
    task.worktreeRoot = await createTaskWorktree(task, join(deps.config.dataDir, "worktrees"));
    await store.save(task);
  }
  await store.transition(task, "diagnosing");
  deps.write(`任务：${task.id}`);
  const result = await modelRun(deps.config, store, task, signal, deps.model);
  if (result.approvalToken) {
    deps.write(`核心修改计划：\n${task.plan.map((line) => `- ${line}`).join("\n")}`);
    deps.write(`批准命令：dungeon-maintain approve ${task.id} ${result.approvalToken}`);
  } else if (result.text) {
    deps.write(result.text);
  }
  deps.write(`状态：${result.outcome}`);
  return ["failed", "blocked", "aborted"].includes(result.outcome) ? 1 : 0;
}

async function approve(args: string[], deps: CliDeps, signal: AbortSignal): Promise<number> {
  const [taskId, token] = args;
  if (!taskId || !token) throw new Error("approve 需要 task-id 和 token");
  const store = new TaskStore(deps.config.dataDir);
  const task = await store.read(taskId);
  await store.approve(task, token);
  deps.write(`核心路径已批准：${task.approval?.paths.join(", ") ?? "无"}`);
  const result = await modelRun(deps.config, store, task, signal, deps.model);
  if (result.approvalToken) {
    deps.write(`新增核心修改计划：\n${task.plan.map((line) => `- ${line}`).join("\n")}`);
    deps.write(`批准命令：dungeon-maintain approve ${task.id} ${result.approvalToken}`);
  } else if (result.text) deps.write(result.text);
  deps.write(`状态：${result.outcome}`);
  return ["failed", "blocked", "aborted"].includes(result.outcome) ? 1 : 0;
}

async function status(taskId: string | undefined, deps: CliDeps): Promise<number> {
  if (!taskId) throw new Error("status 需要 task-id");
  const task = await new TaskStore(deps.config.dataDir).read(taskId);
  deps.write([
    `任务：${task.id}`,
    `模式：${task.mode}`,
    `状态：${task.state}`,
    `目标：${task.objective}`,
    `基线：${task.baseHead}`,
    `文件：${task.changedPaths.join(", ") || "无"}`,
    `检查：${task.checks.map((item) => `${item.id}:${item.status}`).join(", ") || "无"}`,
    `试玩：${task.plays.map((item) => `${item.key}:${item.status}`).join(", ") || "无"}`,
    `用量：回合 ${String(task.usage.turns)} / 工具 ${String(task.usage.toolCalls)} / Token ${String(task.usage.input + task.usage.output + task.usage.cacheRead + task.usage.cacheWrite)}`,
    `结论：${task.conclusion ?? "尚未结束"}`,
  ].join("\n"));
  return 0;
}

async function apply(taskId: string | undefined, deps: CliDeps): Promise<number> {
  if (!taskId) throw new Error("apply 需要 task-id");
  const store = new TaskStore(deps.config.dataDir);
  const task = await store.read(taskId);
  task.appliedHashes = await applyTaskPatch(task);
  await store.transition(task, "applied");
  deps.write(`补丁已应用到目标工作区：${task.changedPaths.join(", ")}`);
  return 0;
}

async function revert(taskId: string | undefined, deps: CliDeps): Promise<number> {
  if (!taskId) throw new Error("revert 需要 task-id");
  const store = new TaskStore(deps.config.dataDir);
  const task = await store.read(taskId);
  await revertTaskPatch(task);
  await store.transition(task, "reverted");
  deps.write(`补丁已安全回滚：${task.changedPaths.join(", ")}`);
  return 0;
}

async function playCommand(args: string[], deps: CliDeps, signal: AbortSignal): Promise<number> {
  const repoArg = valueAfter(args, "--repo");
  if (!repoArg) throw new Error("play 需要 --repo");
  const state = await readRepo(resolve(repoArg));
  await verifyProject(state.root);
  const rawFloor = valueAfter(args, "--floor");
  const suite = args.includes("--suite");
  const floor = rawFloor ? Number(rawFloor) : undefined;
  if (!suite && (!Number.isInteger(floor) || (floor ?? 0) < 1 || (floor ?? 0) > 8)) {
    throw new Error("play 需要 --floor 1..8 或 --suite game-v1");
  }
  if (suite && valueAfter(args, "--suite") !== "game-v1") throw new Error("只支持 --suite game-v1");
  const store = new TaskStore(deps.config.dataDir);
  const task = await store.create({ mode: "diagnose", objective: suite ? "执行八层确定性试玩" : `执行第 ${String(floor)} 层确定性试玩`, repoRoot: state.root, baseHead: state.head });
  await store.transition(task, "diagnosing");
  deps.write(`任务：${task.id}`);
  const url = valueAfter(args, "--url");
  const output = await play({ task, store }, {
    scope: suite ? "suite" : "floor",
    ...(floor ? { floor } : {}),
    headed: args.includes("--headed"),
    ...(url ? { url } : {}),
  }, signal);
  task.conclusion = output.text;
  await store.save(task);
  deps.write(output.text);
  deps.write(`报告：${output.details.reportPath}`);
  return output.details.status === "PASS" ? 0 : 1;
}

/**
 * 执行一个已经拆分的 CLI 命令。
 * @param args 不含 node 与脚本名的参数。
 * @param deps 配置与输出函数。
 * @param signal 当前命令的取消信号。
 * @returns 进程退出码。
 */
export async function runCommand(args: string[], deps: CliDeps, signal: AbortSignal): Promise<number> {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") { deps.write(help()); return 0; }
  const rest = args.slice(1);
  if (command === "diagnose" || command === "fix") {
    return await createTask(command, valueAfter(rest, "--repo"), positional(rest).join(" "), deps, signal);
  }
  if (command === "approve") return await approve(rest, deps, signal);
  if (command === "status") return await status(rest[0], deps);
  if (command === "apply") return await apply(rest[0], deps);
  if (command === "revert") return await revert(rest[0], deps);
  if (command === "play") return await playCommand(rest, deps, signal);
  throw new Error(`未知命令：${command}`);
}

function splitLine(line: string): string[] {
  const values: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of line.matchAll(pattern)) values.push(match[1] ?? match[2] ?? match[3] ?? "");
  return values;
}

async function interactive(deps: CliDeps): Promise<number> {
  const io = createInterface({ input: stdin, output: stdout });
  deps.write("Dungeon Maintainer 交互模式。输入 help 查看命令，exit 退出。");
  try {
    for (;;) {
      const line = (await io.question("maintainer> ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") return 0;
      const controller = new AbortController();
      try { await runCommand(splitLine(line), deps, controller.signal); }
      catch (error) { deps.write(`错误：${error instanceof Error ? error.message : "未知错误"}`); }
    }
  } finally { io.close(); }
}

/** 真实进程入口。 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const deps: CliDeps = { config: loadConfig(), write: (line) => stdout.write(`${line}\n`) };
  if (argv.length === 0) return await interactive(deps);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try { return await runCommand(argv, deps, controller.signal); }
  catch (error) { deps.write(`错误：${error instanceof Error ? error.message : "未知错误"}`); return 1; }
  finally { process.removeListener("SIGINT", stop); }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await main();
}
