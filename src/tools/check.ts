/**
 * 固定质量检查工具。
 *
 * 模型只能选择 SQL Dungeon 适配器登记的检查 ID，不能提供命令、参数、工作目录或
 * 环境变量。完整 stdout/stderr 写入任务的 `checks/`，模型仅看到退出状态和末尾
 * 80 行；子进程环境会移除常见凭据字段。缓存键绑定整个 worktree 的 Git Diff Hash，
 * 任意代码变化会自动失效，失败结果也可复用以避免无意义重复执行。
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hashWorktree } from "../safety/worktree.js";
import { redactText } from "../safety/redact.js";
import { audit, checkAbort, type ToolContext, type ToolOutput } from "./context.js";

/** 固定检查输入。 */
export const CheckParams = Type.Object({
  id: Type.Union([
    Type.Literal("rules-test"), Type.Literal("rules-validate"), Type.Literal("agent-test"),
    Type.Literal("game-test"), Type.Literal("game-architecture"), Type.Literal("game-build"),
  ]),
}, { additionalProperties: false });
/** 固定检查参数类型。 */
export type CheckInput = Static<typeof CheckParams>;

/** 维护器公开给模型的固定检查标识。 */
export type CheckId = CheckInput["id"];

/** 一个不含 Shell 字符串拼接的固定检查定义。 */
export interface CheckSpec {
  id: CheckId;
  file: string;
  args: readonly string[];
}

/**
 * 项目适配器注入的检查目录。
 *
 * 目录只能由维护器源码静态创建；目标仓库配置和模型均不能增加命令、参数或环境变量。
 * `required` 只决定完成补丁前必须真实通过哪些检查，不执行任何命令。
 */
export interface CheckCatalog {
  spec(id: CheckId): CheckSpec;
  required(paths: readonly string[]): CheckId[];
}

/** 检查摘要。 */
export interface CheckResult {
  id: string;
  status: "passed" | "failed" | "blocked";
  ms: number;
  cached: boolean;
  hash: string;
  logPath: string;
}

function safeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(
    ([name]) => !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(name),
  ));
}

async function runCommand(file: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<{ code: number | null; log: string; ms: number }> {
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: safeEnv(), shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer) => { chunks.push(chunk); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code, log: Buffer.concat(chunks).toString("utf8"), ms: Math.round(performance.now() - started) });
    });
  });
}

/**
 * 执行或复用一个固定检查。
 * @param context 当前任务与隔离 worktree。
 * @param input 适配器登记的检查 ID。
 * @param signal 取消时终止子进程。
 * @returns 状态、耗时、缓存命中和完整日志路径。
 */
export async function check(
  context: ToolContext,
  input: CheckInput,
  signal?: AbortSignal,
): Promise<ToolOutput<CheckResult>> {
  checkAbort(signal);
  const task = context.task;
  const root = task.worktreeRoot ?? task.repoRoot;
  const hash = await hashWorktree(root);
  const cached = task.checks.find((item) => item.id === input.id && item.hash === hash);
  if (cached) {
    const log = await readFile(cached.logPath, "utf8");
    await audit(context, "check", "cache");
    return { text: `[CACHE] ${input.id}: ${cached.status}\n${log.split(/\r?\n/u).slice(-80).join("\n")}`, details: { ...cached, cached: true } };
  }
  if (!context.checks) throw new Error("当前任务没有配置固定检查目录");
  const spec = context.checks.spec(input.id);
  if (task.state === "diagnosing" || task.state === "editing" || task.state === "approved") {
    await context.store.transition(task, "verifying");
  }
  const checksDir = join(context.store.taskDir(task.id), "checks");
  await mkdir(checksDir, { recursive: true });
  let status: CheckResult["status"] = "blocked";
  let result: { code: number | null; log: string; ms: number };
  try {
    result = await runCommand(spec.file, spec.args, root, signal);
    status = result.code === 0 ? "passed" : "failed";
  } catch (error) {
    result = { code: null, log: `检查进程无法启动：${error instanceof Error ? error.name : "UnknownError"}`, ms: 0 };
  }
  checkAbort(signal);
  const logPath = join(checksDir, `${input.id}-${hash.slice(0, 12)}.log`);
  const safeLog = redactText(result.log);
  await writeFile(logPath, safeLog, "utf8");
  const record = { id: input.id, hash, status, ms: result.ms, logPath, savedAt: new Date().toISOString() } as const;
  task.checks = task.checks.filter((item) => !(item.id === input.id && item.hash === hash));
  task.checks.push(record);
  await context.store.save(task);
  await audit(context, "check", status);
  const tail = safeLog.split(/\r?\n/u).slice(-80).join("\n");
  return { text: `${input.id}: ${status} (${String(result.ms)} ms)\n${tail}`, details: { ...record, cached: false } };
}

/**
 * 创建 Pi Core 可调用的 check 工具。
 * @param context 单一任务上下文。
 * @returns 只能运行固定 ID 的顺序工具。
 */
export function checkTool(context: ToolContext): AgentTool<typeof CheckParams, CheckResult> {
  return {
    name: "check", label: "运行检查", executionMode: "sequential",
    description: "运行 SQL Dungeon 登记的固定测试或构建检查；不能传 Shell 或参数。",
    parameters: CheckParams,
    execute: async (_id, input, signal) => {
      const output = await check(context, input, signal);
      return { content: [{ type: "text", text: output.text }], details: output.details };
    },
  };
}
