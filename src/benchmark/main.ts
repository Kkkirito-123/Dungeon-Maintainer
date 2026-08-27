#!/usr/bin/env node
/**
 * Dungeon Maintainer 基准入口。
 *
 * 默认运行零模型 Shell 基准；提供游戏仓库时再运行真实 Vite/Chromium 桥基准，提供
 * task 目录时追加真实 Pi token/自主闭环分析。输出始终为不含正文的当前结果 JSON。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAgentEvalPreflight,
  runGameRepairEval,
  type GameRepairEvalProfile,
} from "./agent-eval-runner.js";
import { GAME_REPAIR_TIMEOUT_MAX_MS } from "./agent-eval-case.js";
import { runGameBridgeBenchmark } from "./game.js";
import {
  runGameRepairMatrix,
  runGameRepairPreflightMatrix,
  type GameRepairMatrixProfile,
  type GameRepairSuite,
} from "./game-repair-matrix.js";
import { startBenchmarkProgressPage } from "./progress.js";
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
  dependencyRepoRoot: string;
  archiveRoot: string;
  timeoutMs: number | null;
}

/** 单轮真实模型游戏修复 Eval 的有限参数。 */
export interface GameRepairEvalCliOptions {
  fixtureId: string;
  dependencyRepoRoot: string;
  archiveRoot: string;
  timeoutMs: number | null;
  profile: GameRepairEvalProfile;
  repetition: number;
}

/** 固定 7 案例矩阵的有限参数。 */
export interface GameRepairMatrixCliOptions {
  dependencyRepoRoot: string;
  archiveRoot: string;
  timeoutMs: number | null;
  repetitions: number;
  profile: GameRepairMatrixProfile;
  resumeDirectory: string | null;
}

export interface BenchmarkSuiteCliOptions {
  dependencyRepoRoot: string;
  archiveRoot: string;
  suite: GameRepairSuite;
  ui: "progress" | "none";
  resumeDirectory: string | null;
}

const HELP = [
  "Dungeon Maintainer Benchmark",
  "",
  "用法：",
  "  pnpm benchmark",
  "  pnpm benchmark -- --repo <游戏仓库>",
  "  pnpm benchmark -- --repo <游戏仓库> --task-dir <task目录> [--out <report.json>]",
  "  pnpm benchmark -- preflight --fixture <案例> --dependency-repo <依赖仓库>",
  "  pnpm benchmark -- preflight-matrix --dependency-repo <依赖仓库> [--archive-root <目录>]",
  "  pnpm benchmark -- game-repair --profile maintainer-current --fixture <案例> --dependency-repo <依赖仓库>",
  "  pnpm benchmark -- game-repair-matrix --profile maintainer-current|pi-original|both --dependency-repo <依赖仓库> --archive-root <目录> --repetitions 1",
  "  pnpm benchmark -- benchmark-suite --suite four-regressions|full --dependency-repo <依赖仓库> [--ui progress|none] [--resume <归档目录>]",
].join("\n");

/** 解析仅运行当前 Maintainer 的固定回归套件；案例、重复次数和超时不能任意注入。 */
export function parseBenchmarkSuiteArgs(args: readonly string[]): BenchmarkSuiteCliOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  let dependencyRepoRoot: string | null = null;
  let archiveRoot = resolve("benchmark-results", "pro-current");
  let suite: GameRepairSuite | null = null;
  let ui: "progress" | "none" = process.stdout.isTTY ? "progress" : "none";
  let resumeDirectory: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error("benchmark-suite 参数必须成对提供");
    if (name === "--dependency-repo") dependencyRepoRoot = resolve(value);
    else if (name === "--archive-root") archiveRoot = resolve(value);
    else if (name === "--suite") {
      if (value !== "four-regressions" && value !== "full") throw new Error("未知 benchmark suite：" + value);
      suite = value;
    } else if (name === "--ui") {
      if (value !== "progress" && value !== "none") throw new Error("--ui 只允许 progress 或 none");
      ui = value;
    } else if (name === "--resume") resumeDirectory = resolve(value);
    else throw new Error("未知 benchmark-suite 参数：" + name);
  }
  if (!suite) throw new Error("benchmark-suite 缺少 --suite");
  if (!dependencyRepoRoot) throw new Error("benchmark-suite 缺少 --dependency-repo");
  return { dependencyRepoRoot, archiveRoot, suite, ui, resumeDirectory };
}

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
  let dependencyRepoRoot: string | null = null;
  let archiveRoot = resolve("benchmark-results", "preflight");
  let timeoutMs: number | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error("preflight 参数必须成对提供");
    if (name === "--fixture") fixtureId = value;
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
    else if (name === "--dependency-repo") dependencyRepoRoot = resolve(value);
    else if (name === "--archive-root") archiveRoot = resolve(value);
    else if (name === "--profile") {
      if (value !== "pi-original" && value !== "maintainer-current") {
        throw new Error("未知 game-repair Profile：" + value);
      }
      profile = value;
    } else if (name === "--repetition") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error("--repetition 必须在 1 至 100 之间");
      }
      repetition = parsed;
    } else if (name === "--timeout-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 60_000 || parsed > GAME_REPAIR_TIMEOUT_MAX_MS) {
        throw new Error("--timeout-ms 必须在 60000 至 600000 之间");
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
    dependencyRepoRoot,
    archiveRoot,
    timeoutMs,
    profile,
    repetition,
  };
}

/** 解析固定 7 案例矩阵参数；不接受自定义案例清单或任意命令。 */
export function parseGameRepairMatrixArgs(
  args: readonly string[],
  defaultArchiveRoot = resolve("benchmark-results", "game-repair-final"),
): GameRepairMatrixCliOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  let dependencyRepoRoot: string | null = null;
  let archiveRoot = defaultArchiveRoot;
  let timeoutMs: number | null = null;
  let repetitions = 1;
  let profile: GameRepairMatrixProfile = "both";
  let resumeDirectory: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error("game-repair-matrix 参数必须成对提供");
    if (name === "--dependency-repo") dependencyRepoRoot = resolve(value);
    else if (name === "--archive-root") archiveRoot = resolve(value);
    else if (name === "--profile") {
      if (value !== "maintainer-current" && value !== "pi-original" && value !== "both") {
        throw new Error("未知 game-repair-matrix Profile：" + value);
      }
      profile = value;
    } else if (name === "--repetitions") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
        throw new Error("--repetitions 必须在 1 至 10 之间");
      }
      repetitions = parsed;
    } else if (name === "--timeout-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 60_000 || parsed > GAME_REPAIR_TIMEOUT_MAX_MS) {
        throw new Error("--timeout-ms 必须在 60000 至 600000 之间");
      }
      timeoutMs = parsed;
    } else if (name === "--resume") resumeDirectory = resolve(value);
    else {
      throw new Error("未知 game-repair-matrix 参数：" + name);
    }
  }
  if (!dependencyRepoRoot) throw new Error("game-repair-matrix 缺少 --dependency-repo");
  return {
    dependencyRepoRoot,
    archiveRoot,
    timeoutMs,
    repetitions,
    profile,
    resumeDirectory,
  };
}

/** 执行选中的基准并返回进程退出码。 */
export async function runBenchmarkCli(args: readonly string[]): Promise<number> {
  if (args[0] === "benchmark-suite") {
    const suite = parseBenchmarkSuiteArgs(args.slice(1));
    if (!suite) {
      console.log(HELP);
      return 0;
    }
    const progress = suite.ui === "progress" ? await startBenchmarkProgressPage(true) : null;
    const startedAt = new Date().toISOString();
    progress?.publish({ phase: "starting", fixtureId: null, profile: "maintainer-current",
      repetition: null, completed: 0, total: suite.suite === "four-regressions" ? 12 : 7,
      status: "running", cumulativeTokens: 0, cumulativeToolCalls: 0, startedAt,
      workerId: null, workerCount: 6 });
    try {
      const result = await runGameRepairMatrix({
        dependencyRepoRoot: suite.dependencyRepoRoot,
        archiveRoot: suite.archiveRoot,
        suite: suite.suite,
        repetitions: suite.suite === "four-regressions" ? 3 : 1,
        timeoutMs: suite.suite === "four-regressions" ? 300_000 : 600_000,
        profile: "maintainer-current",
        concurrency: 6,
        ...(suite.resumeDirectory ? { resumeDirectory: suite.resumeDirectory } : {}),
        ...(progress ? { onProgress: (event: Parameters<typeof progress.publish>[0]) => progress.publish(event) } : {}),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return result.status === "passed" ? 0 : 1;
    } finally {
      await progress?.close();
    }
  }
  if (args[0] === "preflight-matrix") {
    const matrix = parseGameRepairMatrixArgs(
      args.slice(1),
      resolve("benchmark-results", "preflight-final"),
    );
    if (!matrix) {
      console.log(HELP);
      return 0;
    }
    const result = await runGameRepairPreflightMatrix({
      dependencyRepoRoot: matrix.dependencyRepoRoot,
      archiveRoot: matrix.archiveRoot,
      ...(matrix.timeoutMs === null ? {} : { timeoutMs: matrix.timeoutMs }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "passed" ? 0 : 1;
  }
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
      ...(gameRepair.timeoutMs === null ? {} : { timeoutMs: gameRepair.timeoutMs }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "passed" ? 0 : 1;
  }
  if (args[0] === "game-repair-matrix") {
    const matrix = parseGameRepairMatrixArgs(args.slice(1));
    if (!matrix) {
      console.log(HELP);
      return 0;
    }
    const result = await runGameRepairMatrix({
      dependencyRepoRoot: matrix.dependencyRepoRoot,
      archiveRoot: matrix.archiveRoot,
      repetitions: matrix.repetitions,
      profile: matrix.profile,
      ...(matrix.timeoutMs === null ? {} : { timeoutMs: matrix.timeoutMs }),
      ...(matrix.resumeDirectory ? { resumeDirectory: matrix.resumeDirectory } : {}),
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
