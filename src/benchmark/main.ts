#!/usr/bin/env node
/**
 * Dungeon Maintainer 基准入口。
 *
 * 默认运行零模型 Shell 基准；提供游戏仓库时再运行真实 Vite/Chromium 桥基准，提供
 * task 目录时追加真实 Pi token/自主闭环分析。输出始终为不含正文的 schema v1 JSON。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAgentEvalPreflight,
  runGameRepairEval,
  type GameRepairEvalProfile,
} from "./agent-eval-runner.js";
import { runGameBridgeBenchmark } from "./game.js";
import { runShellBenchmark } from "./shell.js";
import { analyzeTaskBenchmark } from "./task.js";
import type { DungeonBenchmarkReport } from "./types.js";

/** 基准命令的有限参数。 */
export interface BenchmarkOptions {
  repo: string | null;
  taskDirectory: string | null;
  contextWindow: number;
  outputPath: string | null;
}

/** 单个游戏修复案例零模型预检的有限参数。 */
export interface AgentEvalPreflightCliOptions {
  fixtureId: string;
  fixtureRoot: string | null;
  dependencyRepoRoot: string;
  archiveRoot: string;
  timeoutMs: number | null;
}

/** 单轮真实模型游戏修复 Eval 的有限参数。 */
export interface GameRepairEvalCliOptions {
  fixtureId: string;
  fixtureRoot: string | null;
  dependencyRepoRoot: string;
  archiveRoot: string;
  timeoutMs: number | null;
  profile: GameRepairEvalProfile;
  repetition: number;
}

const HELP = [
  "Dungeon Maintainer Benchmark",
  "",
  "用法：",
  "  pnpm benchmark",
  "  pnpm benchmark -- --repo <游戏仓库>",
  "  pnpm benchmark -- --repo <游戏仓库> --task-dir <task目录> [--out <report.json>]",
  "  pnpm benchmark -- preflight --fixture <案例> --dependency-repo <依赖仓库>",
  "  pnpm benchmark -- game-repair --profile pi-original --fixture <案例> --dependency-repo <依赖仓库>",
].join("\n");

/** 解析不接受命令、脚本或模型提示的固定基准参数。 */
export function parseBenchmarkArgs(args: readonly string[]): BenchmarkOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  const options: BenchmarkOptions = {
    repo: null,
    taskDirectory: null,
    contextWindow: 64_000,
    outputPath: null,
  };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error("benchmark 参数必须成对提供");
    if (name === "--repo") options.repo = resolve(value);
    else if (name === "--task-dir") options.taskDirectory = resolve(value);
    else if (name === "--out") options.outputPath = resolve(value);
    else if (name === "--context-window") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 8_000) {
        throw new Error("--context-window 必须是不小于 8000 的整数");
      }
      options.contextWindow = parsed;
    } else {
      throw new Error("未知 benchmark 参数：" + name);
    }
  }
  return options;
}

/**
 * 解析游戏修复案例的零模型预检参数。
 *
 * @param args `preflight` 后的固定成对参数；不接受命令、脚本或 Prompt。
 * @returns 已规范化参数；请求帮助时返回 `null`。
 * @throws 缺少案例/依赖仓库、未知参数、非法 ID 或超时时拒绝。
 */
export function parseAgentEvalPreflightArgs(
  args: readonly string[],
): AgentEvalPreflightCliOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  let fixtureId: string | null = null;
  let fixtureRoot: string | null = null;
  let dependencyRepoRoot: string | null = null;
  let archiveRoot = resolve("benchmark-results", "preflight");
  let timeoutMs: number | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error("preflight 参数必须成对提供");
    if (name === "--fixture") fixtureId = value;
    else if (name === "--fixture-root") fixtureRoot = resolve(value);
    else if (name === "--dependency-repo") dependencyRepoRoot = resolve(value);
    else if (name === "--archive-root") archiveRoot = resolve(value);
    else if (name === "--timeout-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 10_000 || parsed > 1_800_000) {
        throw new Error("--timeout-ms 必须在 10000 至 1800000 之间");
      }
      timeoutMs = parsed;
    } else {
      throw new Error("未知 preflight 参数：" + name);
    }
  }
  if (!fixtureId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(fixtureId)) {
    throw new Error("--fixture 必须是安全的案例 ID");
  }
  if (!dependencyRepoRoot) throw new Error("preflight 缺少 --dependency-repo");
  return {
    fixtureId,
    fixtureRoot,
    dependencyRepoRoot,
    archiveRoot,
    timeoutMs,
  };
}

/**
 * 解析一轮真实模型游戏修复 Eval 参数。
 *
 * @param args `game-repair` 后的固定成对参数。
 * @returns 已规范化的 Profile、案例、重复编号、依赖和归档目录。
 * @throws 缺少必需字段、未知 Profile、非法 ID、重复编号或超时时拒绝。
 */
export function parseGameRepairEvalArgs(
  args: readonly string[],
): GameRepairEvalCliOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  let fixtureId: string | null = null;
  let fixtureRoot: string | null = null;
  let dependencyRepoRoot: string | null = null;
  let profile: GameRepairEvalProfile | null = null;
  let repetition = 1;
  let archiveRoot = resolve("benchmark-results", "game-repair");
  let timeoutMs: number | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error("game-repair 参数必须成对提供");
    if (name === "--fixture") fixtureId = value;
    else if (name === "--fixture-root") fixtureRoot = resolve(value);
    else if (name === "--dependency-repo") dependencyRepoRoot = resolve(value);
    else if (name === "--archive-root") archiveRoot = resolve(value);
    else if (name === "--profile") {
      if (value !== "pi-original") throw new Error("未知 game-repair Profile：" + value);
      profile = value;
    } else if (name === "--repetition") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error("--repetition 必须在 1 至 100 之间");
      }
      repetition = parsed;
    } else if (name === "--timeout-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 60_000 || parsed > 1_800_000) {
        throw new Error("--timeout-ms 必须在 60000 至 1800000 之间");
      }
      timeoutMs = parsed;
    } else {
      throw new Error("未知 game-repair 参数：" + name);
    }
  }
  if (!fixtureId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(fixtureId)) {
    throw new Error("--fixture 必须是安全的案例 ID");
  }
  if (!profile) throw new Error("game-repair 缺少 --profile");
  if (!dependencyRepoRoot) throw new Error("game-repair 缺少 --dependency-repo");
  return {
    fixtureId,
    fixtureRoot,
    dependencyRepoRoot,
    archiveRoot,
    timeoutMs,
    profile,
    repetition,
  };
}

/** 执行选中的基准并返回进程退出码。 */
export async function runBenchmarkCli(args: readonly string[]): Promise<number> {
  if (args[0] === "preflight") {
    const preflight = parseAgentEvalPreflightArgs(args.slice(1));
    if (!preflight) {
      console.log(HELP);
      return 0;
    }
    const result = await runAgentEvalPreflight({
      fixtureId: preflight.fixtureId,
      dependencyRepoRoot: preflight.dependencyRepoRoot,
      archiveRoot: preflight.archiveRoot,
      ...(preflight.fixtureRoot ? { fixtureRoot: preflight.fixtureRoot } : {}),
      ...(preflight.timeoutMs === null ? {} : { timeoutMs: preflight.timeoutMs }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "passed" ? 0 : 1;
  }
  if (args[0] === "game-repair") {
    const gameRepair = parseGameRepairEvalArgs(args.slice(1));
    if (!gameRepair) {
      console.log(HELP);
      return 0;
    }
    const result = await runGameRepairEval({
      fixtureId: gameRepair.fixtureId,
      dependencyRepoRoot: gameRepair.dependencyRepoRoot,
      profile: gameRepair.profile,
      repetition: gameRepair.repetition,
      archiveRoot: gameRepair.archiveRoot,
      ...(gameRepair.fixtureRoot ? { fixtureRoot: gameRepair.fixtureRoot } : {}),
      ...(gameRepair.timeoutMs === null ? {} : { timeoutMs: gameRepair.timeoutMs }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "passed" ? 0 : 1;
  }
  const options = parseBenchmarkArgs(args);
  if (!options) {
    console.log(HELP);
    return 0;
  }
  const scenarios = [await runShellBenchmark()];
  if (options.repo) scenarios.push(await runGameBridgeBenchmark(options.repo));
  if (options.taskDirectory) {
    scenarios.push(await analyzeTaskBenchmark(
      options.taskDirectory,
      options.contextWindow,
    ));
  }
  const report: DungeonBenchmarkReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed: scenarios.every((entry) => entry.passed),
    scenarios,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, json, "utf8");
  }
  process.stdout.write(json);
  return report.passed ? 0 : 1;
}

const executedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;

if (executedDirectly) {
  runBenchmarkCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        "Dungeon Maintainer Benchmark 失败："
        + (error instanceof Error ? error.message : "未知错误"),
      );
      process.exitCode = 1;
    },
  );
}
