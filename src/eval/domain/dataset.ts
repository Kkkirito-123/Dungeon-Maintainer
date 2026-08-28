/**
 * 固定 EvalDataset 的定位与完整性读取。
 *
 * Dataset 由维护器版本化，不读取当前游戏工作树。它只声明场景顺序并计算内容指纹，
 * 不解析场景语义、不物化仓库，也不启动任何检查或模型。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 当前内置且可复现的 EvalDataset ID。 */
export const DEFAULT_EVAL_DATASET_ID = "eval-v1";

/** 一份已验证的固定评测数据集。 */
export interface EvalDataset {
  readonly id: string;
  readonly root: string;
  readonly scenarioRoot: string;
  readonly scenarioIds: readonly string[];
  readonly fingerprint: string;
}

function projectRoot(): string {
  const sourceOrDistRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return sourceOrDistRoot.endsWith("dist") ? dirname(sourceOrDistRoot) : sourceOrDistRoot;
}

/** 返回维护器内置数据集的父目录。 */
export function defaultEvalDatasetsRoot(): string {
  return join(projectRoot(), "eval-datasets");
}

function safeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    || value === "."
    || value === ".."
  ) throw new Error(label + " 不是安全 ID");
  return value;
}

async function requireDirectory(path: string, label: string): Promise<string> {
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error(label + " 必须是真实目录");
  }
  return realpath(path);
}

async function readTrackedFile(path: string, label: string): Promise<Buffer> {
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(label + " 必须是普通文件");
  }
  return readFile(path);
}

/**
 * 读取一份固定 EvalDataset，并按稳定文件顺序计算内容指纹。
 *
 * @param datasetId 数据集 ID；当前 CLI 默认 `eval-v1`。
 * @param datasetsRoot 可选的数据集父目录，仅供测试注入。
 * @returns 数据集根、场景根、固定场景顺序和 SHA-256 内容指纹。
 * @throws 目录链接、schema 漂移、重复场景或场景文件缺失时拒绝。
 */
export async function readEvalDataset(
  datasetId = DEFAULT_EVAL_DATASET_ID,
  datasetsRoot = defaultEvalDatasetsRoot(),
): Promise<EvalDataset> {
  const id = safeId(datasetId, "EvalDataset ID");
  const parent = await requireDirectory(resolve(datasetsRoot), "EvalDataset 父目录");
  const root = await requireDirectory(join(parent, id), "EvalDataset");
  const manifestBytes = await readTrackedFile(join(root, "dataset.json"), "dataset.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("dataset.json 不是有效 UTF-8 JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dataset.json 必须是对象");
  }
  const manifest = parsed as Record<string, unknown>;
  if (Object.keys(manifest).sort().join("\n") !== ["id", "scenarioIds", "schemaVersion"].join("\n")) {
    throw new Error("dataset.json 字段与 schema v1 不一致");
  }
  if (manifest.schemaVersion !== 1 || manifest.id !== id || !Array.isArray(manifest.scenarioIds)) {
    throw new Error("dataset.json 内容与 schema v1 不一致");
  }
  const scenarioIds = manifest.scenarioIds.map((entry) => safeId(entry, "Scenario ID"));
  if (scenarioIds.length === 0 || new Set(scenarioIds).size !== scenarioIds.length) {
    throw new Error("dataset.json 必须包含不重复的场景");
  }
  const scenarioRoot = await requireDirectory(join(root, "scenarios"), "Scenario 根目录");
  const hash = createHash("sha256").update(manifestBytes);
  hash.update(await readTrackedFile(join(root, "base", "base.json"), "base.json"));
  for (const scenarioId of scenarioIds) {
    const directory = await requireDirectory(join(scenarioRoot, scenarioId), "Scenario");
    for (const file of ["case.json", "reproduction.json", "expected.json", "fixture.json", "source.patch"]) {
      hash.update(scenarioId).update(file).update(await readTrackedFile(join(directory, file), file));
    }
  }
  return { id, root, scenarioRoot, scenarioIds, fingerprint: hash.digest("hex") };
}
