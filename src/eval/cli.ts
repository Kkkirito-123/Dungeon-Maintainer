/**
 * Eval 命令行参数和命令分发。
 *
 * CLI 只接受固定选项，不接受任意命令、场景路径或脚本。`check` 与 `game-contract`
 * 都是静态检查；只有 preflight/run/suite/compare 会进入真实评测流程。
 */

import { resolve } from "node:path";
import { readEvalDataset } from "./domain/dataset.js";
import { EVAL_TIMEOUT_MAX_MS } from "./domain/scenario.js";
import { runEvalPreflight } from "./execution/preflight.js";
import { runEvalScenario, type EvalRunProfile } from "./execution/run.js";
import {
  normalizeEvalWorkers,
  runEvalSuite,
  type EvalSuiteProfile,
} from "./execution/suite.js";
import { runGameContractCheck } from "./game-contract.js";
import { startEvalProgressPage } from "./ui/server.js";

const HELP = [
  "Dungeon Maintainer Eval",
  "",
  "用法：",
  "  pnpm eval -- check --repo <当前游戏仓库>",
  "  pnpm eval -- preflight --scenario <id> --dependencies <游戏仓库>",
  "  pnpm eval -- run --scenario <id> --profile maintainer|pi-baseline --dependencies <游戏仓库>",
  "  pnpm eval -- suite --profile maintainer --workers 2 --dependencies <游戏仓库>",
  "  pnpm eval -- compare --workers 1 --dependencies <游戏仓库>",
  "  pnpm eval -- game-contract --repo <当前游戏仓库>",
].join("\n");

interface EvalCommonRunCliOptions {
  readonly dependencyRepoRoot: string;
  readonly archiveRoot: string;
  readonly timeoutMs: number | null;
}

export interface EvalPreflightCliOptions extends EvalCommonRunCliOptions {
  readonly scenarioId: string;
}

export interface EvalRunCliOptions extends EvalCommonRunCliOptions {
  readonly scenarioId: string;
  readonly profile: EvalRunProfile;
  readonly repetition: number;
}

export interface EvalSuiteCliOptions extends EvalCommonRunCliOptions {
  readonly profile: EvalSuiteProfile;
  readonly repetitions: number;
  readonly workers: number;
  readonly ui: "progress" | "none";
  readonly resumeDirectory: string | null;
}

function pairs(args: readonly string[], command: string): Map<string, string> | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  if (args.length % 2 !== 0) throw new Error(command + " 参数必须成对提供");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(command + " 参数必须成对提供");
    if (values.has(name)) throw new Error(command + " 参数不能重复：" + name);
    values.set(name, value);
  }
  return values;
}

function take(values: Map<string, string>, name: string): string | null {
  const value = values.get(name) ?? null;
  values.delete(name);
  return value;
}

function safeId(value: string | null, label: string): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(label + " 必须是安全 ID");
  }
  return value;
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(label + " 必须在 " + String(minimum) + " 至 " + String(maximum) + " 之间");
  }
  return parsed;
}

function commonOptions(
  values: Map<string, string>,
  command: string,
  defaultArchive: string,
): EvalCommonRunCliOptions {
  const dependencies = take(values, "--dependencies");
  if (!dependencies) throw new Error(command + " 缺少 --dependencies");
  const timeoutValue = take(values, "--timeout-ms");
  return {
    dependencyRepoRoot: resolve(dependencies),
    archiveRoot: resolve(take(values, "--archive-root") ?? defaultArchive),
    timeoutMs: timeoutValue === null
      ? null
      : boundedInteger(timeoutValue, EVAL_TIMEOUT_MAX_MS, 60_000, EVAL_TIMEOUT_MAX_MS, "--timeout-ms"),
  };
}

function rejectUnknown(values: Map<string, string>, command: string): void {
  const unknown = values.keys().next().value;
  if (unknown) throw new Error("未知 " + command + " 参数：" + unknown);
}

/** 解析单场景预检。 */
export function parseEvalPreflightArgs(args: readonly string[]): EvalPreflightCliOptions | null {
  const values = pairs(args, "preflight");
  if (!values) return null;
  const scenarioId = safeId(take(values, "--scenario"), "--scenario");
  const common = commonOptions(values, "preflight", resolve("eval-results", "preflight"));
  rejectUnknown(values, "preflight");
  return { scenarioId, ...common };
}

/** 解析单场景运行。 */
export function parseEvalRunArgs(args: readonly string[]): EvalRunCliOptions | null {
  const values = pairs(args, "run");
  if (!values) return null;
  const scenarioId = safeId(take(values, "--scenario"), "--scenario");
  const profile = take(values, "--profile");
  if (profile !== "maintainer" && profile !== "pi-baseline") {
    throw new Error("--profile 只允许 maintainer 或 pi-baseline");
  }
  const repetition = boundedInteger(take(values, "--repetition"), 1, 1, 100, "--repetition");
  const common = commonOptions(values, "run", resolve("eval-results", "run"));
  rejectUnknown(values, "run");
  return { scenarioId, profile, repetition, ...common };
}

/** 解析 Suite 或 Compare；Compare 固定双方 Profile 且默认单 Worker。 */
export function parseEvalSuiteArgs(
  args: readonly string[],
  compare = false,
): EvalSuiteCliOptions | null {
  const command = compare ? "compare" : "suite";
  const values = pairs(args, command);
  if (!values) return null;
  const requestedProfile = take(values, "--profile");
  let profile: EvalSuiteProfile;
  if (compare) {
    if (requestedProfile !== null && requestedProfile !== "both") {
      throw new Error("compare 固定使用双方 Profile");
    }
    profile = "both";
  } else {
    const singleProfile = requestedProfile ?? "maintainer";
    if (singleProfile !== "maintainer" && singleProfile !== "pi-baseline") {
      throw new Error("suite 只允许单个 Profile");
    }
    profile = singleProfile;
  }
  const repetitions = boundedInteger(take(values, "--repetitions"), 1, 1, 10, "--repetitions");
  const workers = normalizeEvalWorkers(
    boundedInteger(take(values, "--workers"), compare ? 1 : 2, 1, 4, "--workers"),
    compare ? 1 : 2,
  );
  const uiValue = take(values, "--ui") ?? (process.stdout.isTTY ? "progress" : "none");
  if (uiValue !== "progress" && uiValue !== "none") throw new Error("--ui 只允许 progress 或 none");
  const resume = take(values, "--resume");
  const common = commonOptions(values, command, resolve("eval-results", command));
  rejectUnknown(values, command);
  return {
    profile,
    repetitions,
    workers,
    ui: uiValue,
    resumeDirectory: resume ? resolve(resume) : null,
    ...common,
  };
}

/** 执行选中的 Eval 命令并返回退出码。 */
export async function runEvalCli(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (command === "check") {
    const values = pairs(args.slice(1), "check");
    if (!values) { console.log(HELP); return 0; }
    const repo = take(values, "--repo");
    if (!repo) throw new Error("check 缺少 --repo");
    const dataset = await readEvalDataset(resolve(repo));
    rejectUnknown(values, "check");
    process.stdout.write(JSON.stringify({
      status: "passed",
      datasetId: dataset.id,
      scenarioCount: dataset.scenarioIds.length,
      datasetFingerprint: dataset.fingerprint,
    }, null, 2) + "\n");
    return 0;
  }
  if (command === "game-contract") {
    const values = pairs(args.slice(1), "game-contract");
    if (!values) { console.log(HELP); return 0; }
    const repo = take(values, "--repo");
    if (!repo) throw new Error("game-contract 缺少 --repo");
    rejectUnknown(values, "game-contract");
    const result = await runGameContractCheck(repo);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "passed" ? 0 : 1;
  }
  if (command === "preflight") {
    const options = parseEvalPreflightArgs(args.slice(1));
    if (!options) { console.log(HELP); return 0; }
    const dataset = await readEvalDataset(options.dependencyRepoRoot);
    const result = await runEvalPreflight({
      scenarioId: options.scenarioId,
      datasetFingerprint: dataset.fingerprint,
      dependencyRepoRoot: options.dependencyRepoRoot,
      archiveRoot: options.archiveRoot,
      ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "passed" ? 0 : 1;
  }
  if (command === "run") {
    const options = parseEvalRunArgs(args.slice(1));
    if (!options) { console.log(HELP); return 0; }
    const dataset = await readEvalDataset(options.dependencyRepoRoot);
    const result = await runEvalScenario({
      scenarioId: options.scenarioId,
      datasetFingerprint: dataset.fingerprint,
      dependencyRepoRoot: options.dependencyRepoRoot,
      profile: options.profile,
      repetition: options.repetition,
      archiveRoot: options.archiveRoot,
      ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "passed" ? 0 : 1;
  }
  if (command === "suite" || command === "compare") {
    const options = parseEvalSuiteArgs(args.slice(1), command === "compare");
    if (!options) { console.log(HELP); return 0; }
    const progress = options.ui === "progress" ? await startEvalProgressPage(true) : null;
    try {
      const result = await runEvalSuite({
        dependencyRepoRoot: options.dependencyRepoRoot,
        archiveRoot: options.archiveRoot,
        repetitions: options.repetitions,
        profile: options.profile,
        workers: options.workers,
        ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.resumeDirectory ? { resumeDirectory: options.resumeDirectory } : {}),
        ...(progress ? { onProgress: (event: Parameters<typeof progress.publish>[0]) => progress.publish(event) } : {}),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return result.status === "passed" ? 0 : 1;
    } finally {
      await progress?.close();
    }
  }
  throw new Error("未知 eval 命令：" + command);
}
