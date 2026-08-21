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

const HELP = [
  "Dungeon Maintainer Benchmark",
  "",
  "用法：",
  "  pnpm benchmark",
  "  pnpm benchmark -- --repo <游戏仓库>",
  "  pnpm benchmark -- --repo <游戏仓库> --task-dir <task目录> [--out <report.json>]",
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

/** 执行选中的基准并返回进程退出码。 */
export async function runBenchmarkCli(args: readonly string[]): Promise<number> {
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
