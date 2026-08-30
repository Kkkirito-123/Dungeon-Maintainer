/** 测试用 Benchmark Adapter v2；只模拟维护器消费的 JSON 边界。 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeFakeGameAdapter(root: string): Promise<void> {
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "benchmark-adapter.mjs"), `
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const args = process.argv.slice(2);
const command = args[0];
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const fixtureId = value("--fixture") ?? "terminal-action-bug";
const fingerprint = "b".repeat(64);
const testCase = {
  schemaVersion: 1, fixtureId, category: "terminal-answer-consistency",
  prompt: "终端动作不可用，请修复。", evidenceSummary: "动作不可用。",
  startFloor: 1, startPreset: "f1-admin-boss", timeoutMs: 60000,
};
let result;
if (command === "catalog") {
  result = { schemaVersion: 2, adapterVersion: 2, suite: "full", cases: [testCase], sourceFingerprint: fingerprint };
} else if (command === "describe") {
  result = {
    schemaVersion: 2, adapterVersion: 2, suite: "full", case: testCase,
    reproduction: { schemaVersion: 1, fixtureId, steps: [{ op: "go", target: "objective", maxSteps: 64 }, { op: "use", actionId: "terminal" }] },
    expected: {
      schemaVersion: 3, fixtureId, secretInputs: {},
      beforeOracle: "terminal-action-unavailable", afterOracle: "terminal-action-available",
      requiredChecks: [], forbiddenPaths: [], expectedRouteFeatures: ["feature.terminal-action"],
    },
    sourceFingerprint: fingerprint,
  };
} else if (command === "materialize") {
  const destination = resolve(value("--destination"));
  await mkdir(destination);
  result = {
    schemaVersion: 2, adapterVersion: 2, fixtureId,
    variant: value("--variant"), destination, baseCommit: "a".repeat(40),
    dirtyPaths: value("--variant") === "broken" ? ["game/src/example.ts"] : [],
    sourceFingerprint: fingerprint,
  };
} else {
  throw new Error("unsupported");
}
process.stdout.write(JSON.stringify(result) + "\\n");
`, "utf8");
}
