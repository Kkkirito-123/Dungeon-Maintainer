import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseEvalPreflightArgs,
  parseEvalRunArgs,
  parseEvalSuiteArgs,
} from "../../src/eval/cli.js";

describe("Eval CLI", () => {
  it("使用当前游戏 / Scenario / Profile / Worker 统一命名", () => {
    const preflight = parseEvalPreflightArgs([
      "--scenario", "terminal-action-bug",
      "--dependencies", "game-repo",
    ]);
    assert.equal(preflight?.scenarioId, "terminal-action-bug");
    assert.equal(preflight.dependencyRepoRoot.endsWith("game-repo"), true);

    const run = parseEvalRunArgs([
      "--scenario", "terminal-action-bug",
      "--profile", "pi-baseline",
      "--dependencies", "game-repo",
    ]);
    assert.equal(run?.profile, "pi-baseline");

    const suite = parseEvalSuiteArgs(["--dependencies", "game-repo"]);
    assert.equal(suite?.profile, "maintainer");
    assert.equal(suite.workers, 2);

    const compare = parseEvalSuiteArgs(["--dependencies", "game-repo"], true);
    assert.equal(compare?.profile, "both");
    assert.equal(compare.workers, 1);
  });

  it("拒绝旧命令参数和不安全 ID", () => {
    assert.throws(() => parseEvalPreflightArgs([
      "--fixture", "terminal-action-bug",
      "--dependencies", "game-repo",
    ]), /--scenario/u);
    assert.throws(() => parseEvalRunArgs([
      "--scenario", "../escape",
      "--profile", "maintainer",
      "--dependencies", "game-repo",
    ]), /安全 ID/u);
    assert.throws(() => parseEvalRunArgs([
      "--scenario", "terminal-action-bug",
      "--profile", "maintainer-current",
      "--dependencies", "game-repo",
    ]), /profile/u);
    assert.throws(() => parseEvalSuiteArgs([
      "--workers", "5",
      "--dependencies", "game-repo",
    ]), /1 至 4/u);
    assert.throws(() => parseEvalSuiteArgs([
      "--dataset", "eval-v1",
      "--dependencies", "game-repo",
    ]), /未知 suite 参数/u);
  });
});
