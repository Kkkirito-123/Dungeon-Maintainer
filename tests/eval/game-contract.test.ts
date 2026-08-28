import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runGameContractCheck } from "../../src/eval/game-contract.js";

describe("GameContractCheck", () => {
  it("只检查当前游戏合同，不依赖 EvalDataset 或 benchmark adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-game-contract-"));
    try {
      const protocolDirectory = join(root, "game", "src", "devtools", "dungeon-agent");
      await mkdir(protocolDirectory, { recursive: true });
      await writeFile(join(root, "game", "package.json"), JSON.stringify({
        scripts: { test: "test", build: "build", "architecture:check": "architecture" },
      }), "utf8");
      await writeFile(join(protocolDirectory, "protocol.ts"), [
        "interface Bridge { readonly version: 3;",
        "look(): void; go(): void; use(): void; inputSql(): void; query(): void;",
        "prepare(): void; checkpoint(): void; judge(): void; events(): void; }",
      ].join("\n"), "utf8");
      const result = await runGameContractCheck(root);
      assert.equal(result.status, "passed");
      assert.equal(result.checks.every((check) => check.passed), true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
