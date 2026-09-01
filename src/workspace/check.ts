/**
 * SQL Dungeon 固定质量检查。
 *
 * Agent 只能选择维护器源码登记的 CheckId，不能传命令、参数、cwd 或环境变量。
 * 子进程使用 shell:false，环境移除常见凭据字段；完整脱敏日志写入任务 checks 目录，
 * 模型仅看到状态和末尾有限行。结果绑定完整 worktree Hash，代码变化后不会误用。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import { checkEvidence } from "../evidence/projector.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { CheckRecord } from "../evidence/types.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { hashWorktree } from "./git.js";

/** 模型可以选择的固定检查 ID。 */
export type CheckId =
  | "rules-test"
  | "rules-validate"
  | "agent-test"
  | "game-related-test"
  | "game-test"
  | "game-architecture"
  | "game-build";

/** 不经过 Shell 拼接的固定检查定义。 */
export interface CheckSpec {
  id: CheckId;
  file: string;
  args: readonly string[];
}

const CHECKS: Readonly<Record<CheckId, CheckSpec>> = {
  "rules-test": {
    id: "rules-test",
    file: "python",
    args: ["scripts/test_validate_rules.py"],
  },
  "rules-validate": {
    id: "rules-validate",
    file: "python",
    args: ["scripts/validate-rules.py"],
  },
  "agent-test": {
    id: "agent-test",
    file: "python",
    args: ["-m", "unittest", "discover", "-s", "agent/tests"],
  },
  "game-related-test": {
    id: "game-related-test",
    file: "pnpm",
    args: [],
  },
  "game-test": {
    id: "game-test",
    file: "pnpm",
    args: ["--dir", "game", "test"],
  },
  "game-architecture": {
    id: "game-architecture",
    file: "pnpm",
    args: ["--dir", "game", "architecture:check"],
  },
  "game-build": {
    id: "game-build",
    file: "pnpm",
    args: ["--dir", "game", "build"],
  },
};

export type CheckOutput = (line: string) => void;
const ANSI_ESCAPE = new RegExp(
  String.fromCharCode(27) + "\\[[0-?]*[ -/]*[@-~]",
  "gu",
);

/**
 * 根据变更路径返回候选验证前必须通过的轻量检查。
 *
 * @param paths 任务记录的精确变更路径。
 * @returns 去重后的固定检查 ID。
 */
export function requiredChecks(paths: readonly string[]): CheckId[] {
  const checks: CheckId[] = [];
  if (paths.some((path) => path.startsWith("game/tests/") && path.endsWith(".ts"))) {
    checks.push("game-related-test");
  }
  if (paths.includes("game/scripts/check-architecture.mjs")) checks.push("game-architecture");
  return checks;
}

/** `publish` 创建 PR 前必须通过的完整质量门。 */
export function requiredPublishChecks(paths: readonly string[]): CheckId[] {
  if (paths.some((path) => path.startsWith("game/src/") || path.startsWith("game/tests/"))) {
    return ["game-test", "game-architecture", "game-build"];
  }
  if (paths.includes("game/scripts/check-architecture.mjs")) return ["game-architecture"];
  return [];
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(
    ([name]) => (
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/u.test(name)
      || !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(name)
    ),
  ));
}

function pnpmCliPath(): string | null {
  const pathCandidates: string[] = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    pathCandidates.push(
      join(directory, "node_modules", "pnpm", "bin", "pnpm.mjs"),
      join(directory, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    );
  }

  const isJavaScriptCli = (candidate: string): boolean => (
    candidate.length > 0
    && /\.(?:cjs|mjs|js)$/iu.test(candidate)
    && existsSync(candidate)
  );
  const isCorepack = (candidate: string): boolean => /[\\/]corepack[\\/]/iu.test(candidate);

  // PATH 中的真实 pnpm 入口优先于 Corepack。Corepack 会按 packageManager
  // 自动下载并切换版本；固定检查必须复用当前已安装的 pnpm，避免离线环境或
  // 版本漂移把本来通过的游戏检查误报为失败。
  const preferred = [process.env.npm_execpath ?? "", ...pathCandidates]
    .filter((candidate) => !isCorepack(candidate) && isJavaScriptCli(candidate));
  if (preferred.length > 0) return preferred[0] ?? null;

  const fallback = [
    process.env.npm_execpath ?? "",
    ...pathCandidates,
    join(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
  ];
  return fallback.find(isJavaScriptCli) ?? null;
}

function checkInvocation(spec: CheckSpec): { file: string; args: readonly string[] } {
  if (process.platform !== "win32" || spec.file !== "pnpm") {
    return { file: spec.file, args: spec.args };
  }
  const cli = pnpmCliPath();
  if (!cli) throw new Error("Windows 环境找不到可由 Node 直接执行的 pnpm CLI");
  // Windows 的 pnpm 通常是 .cmd/.ps1，shell:false 无法直接 CreateProcess。固定检查
  // 改由当前 Node 执行 pnpm 的 JS 入口，继续保持无 Shell、无模型参数拼接。
  return { file: process.execPath, args: [cli, ...spec.args] };
}

async function runFixedCommand(
  spec: CheckSpec,
  cwd: string,
  signal?: AbortSignal,
  onOutput?: CheckOutput,
): Promise<{ code: number | null; output: string; durationMs: number }> {
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const invocation = checkInvocation(spec);
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: safeEnvironment(),
      shell: false,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let pending = "";
    const emit = (line: string): void => {
      const safe = redactText(line)
        .replace(ANSI_ESCAPE, "")
        .trim();
      if (safe) onOutput?.(safe.slice(0, 500));
    };
    const collect = (chunk: Buffer): void => {
      chunks.push(chunk);
      if (!onOutput) return;
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r\n?|\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const abort = (): void => {
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (pending) emit(pending);
      resolve({
        code,
        output: Buffer.concat(chunks).toString("utf8"),
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

async function runChangedGameTests(
  task: TaskRecord,
  signal?: AbortSignal,
  onOutput?: CheckOutput,
): Promise<{ code: number | null; output: string; durationMs: number }> {
  const tests = task.changedPaths.filter((path) => (
    path.startsWith("game/tests/")
    && path.endsWith(".ts")
    && !path.split("/").includes("..")
  )).map((path) => path.slice("game/".length));
  if (tests.length === 0) {
    return { code: 0, output: "没有直接修改的游戏测试文件。", durationMs: 0 };
  }
  return await runFixedCommand({
    id: "game-related-test",
    file: "pnpm",
    args: [
      "--dir",
      "game",
      "exec",
      "vitest",
      "run",
      ...tests,
      "--passWithNoTests",
      "--no-file-parallelism",
    ],
  }, task.worktreeRoot, signal, onOutput);
}

/** 固定检查执行结果及模型可见尾迹。 */
export interface CheckExecutionResult {
  record: CheckRecord;
  cached: boolean;
  exitCode: number | null;
  tail: string;
}

/** 把检查失败压缩成可直接定位的提示；完整日志仍保留在进度面板和 checks 文件。 */
export function formatCheckFailure(result: CheckExecutionResult): string {
  const outcome = result.exitCode === null
    ? "状态=" + result.record.status
    : "退出码=" + String(result.exitCode);
  const tail = result.tail
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  return result.record.id + " 未通过（" + outcome
    + "，耗时=" + (result.record.durationMs / 1_000).toFixed(1) + " 秒）"
    + (tail ? "；日志尾部：" + tail.slice(0, 600) : "");
}

/**
 * 执行或复用一个固定检查。
 *
 * @param store 当前任务存储。
 * @param evidence 当前任务证据存储。
 * @param task 当前任务。
 * @param id 维护器源码登记的检查 ID。
 * @param signal 取消时终止子进程。
 * @param options 独立诊断工具保持任务状态；验证流水线使用默认状态迁移。
 */
export async function runCheck(
  store: TaskStore,
  evidence: EvidenceStore,
  task: TaskRecord,
  id: CheckId,
  signal?: AbortSignal,
  options: { preserveTaskState?: boolean; onOutput?: CheckOutput } = {},
): Promise<CheckExecutionResult> {
  signal?.throwIfAborted();
  const worktreeHash = await hashWorktree(task.worktreeRoot);
  const checksDir = join(store.taskDir(task.id), "checks");
  const cached = (await evidence.checks()).find(
    (record) => record.id === id && record.worktreeHash === worktreeHash,
  );
  if (cached) {
    const expectedLogPath = join(checksDir, id + "-" + worktreeHash.slice(0, 12) + ".log");
    const log = await readFile(expectedLogPath, "utf8");
    await appendEvent(store, task.id, "tool.check", {
      id,
      status: cached.status,
      cached: true,
    });
    options.onOutput?.("检查 " + id + "：命中缓存（" + (cached.durationMs / 1_000).toFixed(1) + " 秒）");
    return {
      record: cached,
      cached: true,
      exitCode: cached.status === "passed" ? 0 : null,
      tail: log.split(/\r?\n/u).slice(-80).join("\n"),
    };
  }
  if (!options.preserveTaskState) {
    if (task.state === "ready_to_apply") await store.transition(task, "active");
    if (task.state === "active") await store.transition(task, "verifying");
  }
  await mkdir(checksDir, { recursive: true });
  let status: CheckRecord["status"] = "blocked";
  let command: {
    code: number | null;
    output: string;
    durationMs: number;
  };
  try {
    options.onOutput?.("检查 " + id + "：开始");
    command = id === "game-related-test"
      ? await runChangedGameTests(task, signal, options.onOutput)
      : await runFixedCommand(CHECKS[id], task.worktreeRoot, signal, options.onOutput);
    status = command.code === 0 ? "passed" : "failed";
  } catch (error) {
    command = {
      code: null,
      output: "检查进程无法启动："
        + (error instanceof Error ? error.name : "UnknownError"),
      durationMs: 0,
    };
  }
  options.onOutput?.(
    "检查 " + id + "：退出码 " + (command.code === null ? "blocked" : String(command.code))
    + "，耗时 " + (command.durationMs / 1_000).toFixed(1) + " 秒",
  );
  signal?.throwIfAborted();
  const logPath = join(
    checksDir,
    id + "-" + worktreeHash.slice(0, 12) + ".log",
  );
  const safeLog = redactText(command.output);
  await writeFile(logPath, safeLog, "utf8");
  const record: CheckRecord = {
    id,
    worktreeHash,
    status,
    durationMs: command.durationMs,
    logPath,
    savedAt: new Date().toISOString(),
  };
  await evidence.capture(checkEvidence(record));
  await appendEvent(store, task.id, "tool.check", {
    id,
    status,
    cached: false,
    durationMs: command.durationMs,
  });
  return {
    record,
    cached: false,
    exitCode: command.code,
    tail: safeLog.split(/\r?\n/u).slice(-80).join("\n"),
  };
}

/** 返回全部固定检查 ID，供工具 schema 和测试使用。 */
export function checkIds(): CheckId[] {
  return Object.keys(CHECKS) as CheckId[];
}
