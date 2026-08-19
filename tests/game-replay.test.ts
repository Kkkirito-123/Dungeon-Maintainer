import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameBrowser } from "../src/game/browser.js";
import { GameDriver } from "../src/game/driver.js";
import type {
  PlayJudge,
  PlayResult,
  PlayView,
} from "../src/game/protocol.js";
import {
  checkIds,
  requiredChecks,
} from "../src/workspace/check.js";

function playView(overrides: Partial<PlayView> = {}): PlayView {
  return {
    floor: 1,
    mode: "explore",
    hp: { current: 2, max: 2, armor: 0 },
    progress: {
      lessons: 0,
      rooms: 1,
      moves: 0,
      queries: 0,
      hintLevel: 0,
    },
    actions: [{ id: "objective", label: "前往目标" }],
    room: "入口",
    mission: { title: "SELECT", body: "找到目标", lesson: "投影" },
    record: null,
    prompt: "继续探索",
    banner: "准备完成复现",
    ...overrides,
  };
}

function playResult(event: string, view = playView()): PlayResult {
  return { ok: true, event, steps: event.startsWith("go") ? 2 : 0, view };
}

class RecordingBrowser {
  readonly calls: string[] = [];
  checkpointCount = 0;
  failNextGo = false;

  async look(): Promise<PlayView> {
    this.calls.push("look");
    return playView();
  }

  async checkpoint(): Promise<void> {
    this.calls.push("checkpoint");
    this.checkpointCount += 1;
  }

  async reloadFromCheckpoint(): Promise<PlayView> {
    this.calls.push("reload");
    return playView({ banner: "检查点已恢复" });
  }

  async go(): Promise<PlayResult> {
    this.calls.push("go");
    if (this.failNextGo) {
      this.failNextGo = false;
      return { ...playResult("blocked"), ok: false };
    }
    return playResult("go-complete");
  }

  async use(): Promise<PlayResult> {
    this.calls.push("use");
    return playResult("action:interact");
  }

  async query(): Promise<PlayResult> {
    this.calls.push("query");
    return playResult("query-accepted", playView({ mode: "combat" }));
  }

  async judge(): Promise<PlayJudge> {
    this.calls.push("judge");
    return {
      floor: 1,
      mode: "explore",
      lessons: 0,
      requiredLessons: 5,
      bossDefeated: false,
      migrationSteps: 0,
      migrationComplete: false,
      advanced: false,
    };
  }

  async focus(): Promise<void> {
    this.calls.push("focus");
  }
}

describe("浏览器检查点、刷新、恢复和语义重放", () => {
  it("源码刷新后先恢复并重建同一起点检查点，再按原顺序重放", async () => {
    const browser = new RecordingBrowser();
    const driver = new GameDriver(browser as unknown as GameBrowser);

    await driver.beginReproduction();
    await driver.ensureReproductionCheckpoint();
    await driver.go("objective", 8);
    await driver.use("interact");
    await driver.query();
    const actions = driver.trace.snapshot();
    assert.deepEqual(actions.map((entry) => entry.action), ["go", "use", "query"]);
    assert.equal(browser.checkpointCount, 1);

    browser.calls.length = 0;
    const replay = await driver.reloadAndReplay(actions);
    assert.equal(replay.passed, true);
    assert.equal(replay.actionCount, 3);
    assert.deepEqual(browser.calls, ["reload", "checkpoint", "go", "use", "query"]);
    assert.equal(browser.checkpointCount, 2);
  });

  it("任一重放动作失败都会停止后续动作并返回稳定失败原因", async () => {
    const browser = new RecordingBrowser();
    const driver = new GameDriver(browser as unknown as GameBrowser);
    await driver.beginReproduction();
    await driver.go("objective", 8);
    await driver.use("interact");
    const actions = driver.trace.snapshot();
    browser.failNextGo = true;
    browser.calls.length = 0;

    const replay = await driver.reloadAndReplay(actions);
    assert.equal(replay.passed, false);
    assert.equal(replay.failure, "blocked");
    assert.equal(replay.actionCount, 1);
    assert.deepEqual(browser.calls, ["reload", "checkpoint", "go"]);
  });
});

describe("固定检查白名单", () => {
  it("游戏源码变化固定要求测试、架构检查和生产构建", () => {
    assert.deepEqual(requiredChecks(["game/src/domain/session.ts"]), [
      "game-test",
      "game-architecture",
      "game-build",
    ]);
    assert.deepEqual(requiredChecks(["game/tests/session.test.ts"]), ["game-test"]);
    assert.deepEqual(requiredChecks(["README.md"]), []);
    assert.deepEqual(checkIds(), [
      "rules-test",
      "rules-validate",
      "agent-test",
      "game-test",
      "game-architecture",
      "game-build",
    ]);
  });
});
