import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PI_BASELINE_SOURCE,
  verifyPiBaselineSource,
} from "../src/benchmark/pi-baseline-source.js";

describe("Pi Benchmark baseline 来源", () => {
  it("固定官方 v0.84.2 commit，并校验本地真实执行包", async () => {
    const source = await verifyPiBaselineSource(process.cwd());
    assert.deepEqual(
      {
        repository: source.repository,
        tag: source.tag,
        commit: source.commit,
        packageName: source.packageName,
        packageVersion: source.packageVersion,
        packageIntegrity: source.packageIntegrity,
      },
      PI_BASELINE_SOURCE,
    );
    assert.match(source.cliHash, /^[a-f0-9]{64}$/u);
  });
});
