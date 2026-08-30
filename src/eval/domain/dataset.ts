/** 当前游戏 Adapter 暴露的 Benchmark 套件清单。 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { invokeGameBenchmarkAdapter } from "../game-adapter.js";

/** 报告和 checkpoint 使用的唯一当前套件 ID。 */
export const DEFAULT_EVAL_DATASET_ID = "game-current";

/** 一份绑定当前游戏工作树的评测套件。 */
export interface EvalDataset {
  readonly id: typeof DEFAULT_EVAL_DATASET_ID;
  readonly root: string;
  readonly scenarioIds: readonly string[];
  readonly fingerprint: string;
}
function safeId(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    || value === "."
    || value === ".."
  ) throw new Error("benchmark-adapter-case-invalid");
  return value;
}

/** 读取当前游戏 Adapter 的 full catalog，不保留维护器内置源码快照。 */
export async function readEvalDataset(gameRepoRoot: string): Promise<EvalDataset> {
  const root = await realpath(resolve(gameRepoRoot));
  const catalog = await invokeGameBenchmarkAdapter(root, ["catalog"]);
  if (
    catalog.suite !== "full"
    || !Array.isArray(catalog.cases)
    || typeof catalog.sourceFingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(catalog.sourceFingerprint)
  ) {
    throw new Error("benchmark-adapter-catalog-invalid");
  }
  const scenarioIds = catalog.cases.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("benchmark-adapter-case-invalid");
    }
    return safeId((entry as Record<string, unknown>).fixtureId);
  });
  if (scenarioIds.length === 0 || new Set(scenarioIds).size !== scenarioIds.length) {
    throw new Error("benchmark-adapter-catalog-invalid");
  }
  return {
    id: DEFAULT_EVAL_DATASET_ID,
    root,
    scenarioIds,
    fingerprint: catalog.sourceFingerprint,
  };
}
