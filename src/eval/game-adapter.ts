/** 当前游戏 Benchmark Adapter 的固定进程边界。 */

import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const ADAPTER_PATH = join("scripts", "benchmark-adapter.mjs");

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("benchmark-adapter-invalid");
  }
  return value as Record<string, unknown>;
}
/** 调用当前游戏拥有的 Adapter，并只接受协议 v2 JSON。 */
export async function invokeGameBenchmarkAdapter(
  gameRepoRoot: string,
  args: readonly string[],
): Promise<Record<string, unknown>> {
  const requestedRoot = resolve(gameRepoRoot);
  const rootInformation = await lstat(requestedRoot);
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    throw new Error("benchmark-adapter-repo-invalid");
  }
  const root = await realpath(requestedRoot);
  const adapter = join(root, ADAPTER_PATH);
  const adapterInformation = await lstat(adapter);
  if (!adapterInformation.isFile() || adapterInformation.isSymbolicLink()) {
    throw new Error("benchmark-adapter-missing");
  }
  let stdout: string;
  try {
    ({ stdout } = await executeFile(process.execPath, [adapter, ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch {
    throw new Error("benchmark-adapter-error");
  }
  let output: unknown;
  try {
    output = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("benchmark-adapter-invalid");
  }
  const result = record(output);
  if (result.schemaVersion !== 2 || result.adapterVersion !== 2) {
    throw new Error("benchmark-adapter-version-mismatch");
  }
  return result;
}
