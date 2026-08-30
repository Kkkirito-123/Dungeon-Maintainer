/** 通过当前游戏 Adapter 物化隔离 Benchmark 仓库。 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { invokeGameBenchmarkAdapter } from "../game-adapter.js";

/** EvalWorkspace 创建参数。 */
export interface EvalWorkspaceOptions {
  readonly scenarioId: string;
  readonly destination: string;
  readonly gameRepoRoot: string;
  readonly variant?: "broken" | "clean";
}

/** Adapter 已建立的单提交仓库事实。 */
export interface EvalWorkspace {
  readonly root: string;
  readonly baseCommit: string;
  readonly dirtyPaths: readonly string[];
  readonly sourceFingerprint: string;
}

function safeProjectPath(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("benchmark-adapter-materialization-invalid");
  return value;
}

/** 物化当前源码的 broken 或 clean 版本；隐藏案例仍留在游戏仓库。 */
export async function createEvalWorkspace(
  options: EvalWorkspaceOptions,
): Promise<EvalWorkspace> {
  const destination = resolve(options.destination);
  const result = await invokeGameBenchmarkAdapter(options.gameRepoRoot, [
    "materialize",
    "--fixture", options.scenarioId,
    "--destination", destination,
    "--variant", options.variant ?? "broken",
  ]);
  if (
    result.fixtureId !== options.scenarioId
    || result.variant !== (options.variant ?? "broken")
    || typeof result.baseCommit !== "string"
    || !/^[0-9a-f]{40}$/u.test(result.baseCommit)
    || typeof result.sourceFingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(result.sourceFingerprint)
    || typeof result.destination !== "string"
    || !Array.isArray(result.dirtyPaths)
  ) throw new Error("benchmark-adapter-materialization-invalid");
  const root = await realpath(destination);
  if (root !== await realpath(result.destination)) {
    throw new Error("benchmark-adapter-materialization-invalid");
  }
  return {
    root,
    baseCommit: result.baseCommit,
    dirtyPaths: result.dirtyPaths.map(safeProjectPath).sort(),
    sourceFingerprint: result.sourceFingerprint,
  };
}
