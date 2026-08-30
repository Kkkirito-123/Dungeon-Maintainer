#!/usr/bin/env node
/**
 * Dungeon Maintainer 外部 CLI 入口。
 *
 * 本文件只解析 `start --repo <游戏仓库>`、`resume <task-id>` 与内置 `eval`，把业务
 * 交给对应入口，
 * 并将失败转换为简短中文错误和非零退出码。它不读取游戏文件、不创建 worktree、
 * 不启动 Pi，也不吞掉异常细节中的凭据；用户输入之外没有可执行 Shell 字符串。
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runEvalCli } from "./eval/main.js";
import { resumeMaintainer, startMaintainer } from "./app.js";

/** CLI 解析后的固定动作。 */
export type MaintainerCliCommand =
  | { action: "start"; repo: string }
  | { action: "resume"; taskId: string }
  | { action: "eval"; args: string[] }
  | { action: "help" };

const HELP = [
  "Dungeon Maintainer 1.0",
  "",
  "用法：",
  "  dungeon-maintain start --repo <游戏仓库>",
  "  dungeon-maintain resume <task-id>",
  "  dungeon-maintain eval [eval 参数]",
].join("\n");

/**
 * 解析固定 CLI 参数。
 *
 * @param args 不含 node 与脚本路径的参数。
 * @returns start、resume 或 help。
 * @throws 缺参、重复参数和未知命令时拒绝。
 */
export function parseMaintainerCli(args: readonly string[]): MaintainerCliCommand {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { action: "help" };
  }
  if (args[0] === "start") {
    if (args.length !== 3 || args[1] !== "--repo" || !args[2]?.trim()) {
      throw new Error("start 用法：dungeon-maintain start --repo <游戏仓库>");
    }
    return { action: "start", repo: args[2] };
  }
  if (args[0] === "resume") {
    if (args.length !== 2 || !args[1]?.trim()) {
      throw new Error("resume 用法：dungeon-maintain resume <task-id>");
    }
    return { action: "resume", taskId: args[1] };
  }
  if (args[0] === "eval") {
    return { action: "eval", args: [...args.slice(1)] };
  }
  throw new Error("未知命令：" + (args[0] ?? ""));
}

/** 执行当前进程命令并返回退出码。 */
export async function runMaintainerCli(
  args: readonly string[],
): Promise<number> {
  const command = parseMaintainerCli(args);
  if (command.action === "help") {
    console.log(HELP);
    return 0;
  }
  if (command.action === "eval") return await runEvalCli(command.args);
  const config = loadConfig();
  return command.action === "start"
    ? await startMaintainer(command.repo, config)
    : await resumeMaintainer(command.taskId, config);
}

const executedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;

if (executedDirectly) {
  runMaintainerCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        "Dungeon Maintainer 启动失败："
        + (error instanceof Error ? error.message : "未知错误"),
      );
      process.exitCode = 1;
    },
  );
}
