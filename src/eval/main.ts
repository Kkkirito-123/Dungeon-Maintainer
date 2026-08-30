#!/usr/bin/env node
/** Eval 可执行入口；参数解析和业务编排位于 cli.ts。 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEvalCli } from "./cli.js";

export { runEvalCli } from "./cli.js";

const executedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;

if (executedDirectly) {
  runEvalCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error("Dungeon Maintainer Eval 失败："
        + (error instanceof Error ? error.message : "未知错误"));
      process.exitCode = 1;
    },
  );
}
