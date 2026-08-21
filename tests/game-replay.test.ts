import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GameBrowser } from "../src/game/browser.js";
import { GameDriver } from "../src/game/driver.js";
import type {
  PlayJudge,
  PlayResult,
  PlayView,
} from "../src/game/protocol.js";
import { replayReproduction } from "../src/repair/replay.js";
import {
  replayableTraceActions,
  type ReproductionRecord,
} from "../src/repair/reproduction.js";
import { TaskStore } from "../src/task/store.js";
import {
  checkIds,
  requiredChecks,
} from "../src/workspace/check.js";
import { createTaskRecordFixture } from "./testSupport.js";

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
    actions: [
      { id: "objective", label: "前往目标" },
      { id: "interact", label: "交互" },
    ],
    room: "入口",
    mission: { title: "SELECT", body: "找到目标", lesson: "投影" },
    record: null,
    terminal: null,
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
  goResults: PlayResult[] = [];
  transitionOnUse = false;
  terminalOpenOnUse = false;
  queryAccepted = true;
  inputValue = "";
  private transitionPending = false;
  private queryReady = false;
  judgeResult: PlayJudge = {
    floor: 1,
    mode: "explore",
    lessons: 0,
    requiredLessons: 5,
    bossDefeated: false,
    migrationSteps: 0,
    migrationComplete: false,
    advanced: false,
  };

  async look(): Promise<PlayView> {
    this.calls.push("look");
    if (this.transitionPending) {
      this.transitionPending = false;
      return playView({ floor: 2, mode: "explore" });
    }
    if (this.queryReady) {
      return playView({
        mode: "combat",
        actions: [{ id: "query", label: "提交答案" }],
      });
    }
    return playView();
  }

  async checkpoint(): Promise<void> {
    this.calls.push("checkpoint");
    this.checkpointCount += 1;
  }

  async reloadFromCheckpoint(): Promise<PlayView> {
    this.calls.push("reload");
    this.transitionPending = false;
    this.queryReady = false;
    return playView({ banner: "检查点已恢复" });
  }

  async go(): Promise<PlayResult> {
    this.calls.push("go");
    const queued = this.goResults.shift();
    if (queued) return queued;
    if (this.failNextGo) {
      this.failNextGo = false;
      return { ...playResult("blocked"), ok: false };
    }
    return playResult("go-complete");
  }

  async use(): Promise<PlayResult> {
    this.calls.push("use");
    if (this.terminalOpenOnUse) {
      this.queryReady = true;
      return playResult("action:terminal", playView({
        mode: "combat",
        terminal: {
          kind: "combat",
          title: "SELECT",
          objective: "查询目标",
          lessonId: "select",
          stageId: "select-1",
          stageIndex: 0,
          task: null,
          schema: ["monsters"],
          locks: [],
          hints: [],
          inputSql: "",
          status: { kind: "neutral", text: "" },
          result: "",
          plan: [],
        },
      }));
    }
    if (this.transitionOnUse) {
      this.transitionPending = true;
      return playResult("action:interact", playView({ mode: "transition" }));
    }
    this.queryReady = true;
    return playResult("action:interact");
  }

  async query(): Promise<PlayResult> {
    this.calls.push("query");
    this.queryReady = false;
    const event = this.queryAccepted ? "query-accepted" : "query-rejected";
    return {
      ...playResult(event, playView({ mode: "combat" })),
      ok: this.queryAccepted,
    };
  }

  async inputSql(sql: string): Promise<PlayResult> {
    this.calls.push("inputSql");
    this.inputValue = sql;
    this.queryReady = true;
    return playResult("input-accepted", playView({
      mode: "combat",
      terminal: {
        kind: "combat",
        title: "SELECT",
        objective: "查询目标",
        lessonId: "select",
        stageId: "select-1",
        stageIndex: 0,
        task: null,
        schema: ["monsters"],
        locks: [],
        hints: [],
        inputSql: sql,
        status: { kind: "neutral", text: "" },
        result: "",
        plan: [],
      },
    }));
  }

  async judge(): Promise<PlayJudge> {
    this.calls.push("judge");
    return { ...this.judgeResult };
  }

  async focus(): Promise<void> {
    this.calls.push("focus");
  }
}

describe("浏览器检查点、刷新、恢复和语义重放", () => {
  it("统一 Shell 中执行游戏动作前重新聚焦 iframe 游戏根节点", async () => {
    const browser = new GameBrowser("http://127.0.0.1:5173", () => undefined, null);
    const calls: string[] = [];
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const frame = {
      evaluate: async <T>(
        operation: (input: { name: string; values: unknown[] }) => T | Promise<T>,
        input: { name: string; values: unknown[] },
      ): Promise<T> => {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: {
            querySelector: (selector: string) => selector === "#game-root"
              ? { focus: () => calls.push("focus") }
              : null,
          },
        });
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: {
            __DUNGEON_PLAYTEST__: {
              go: async () => {
                calls.push("go");
                return playResult("move-complete");
              },
            },
          },
        });
        try {
          return await operation(input);
        } finally {
          if (previousDocument) {
            Object.defineProperty(globalThis, "document", previousDocument);
          } else {
            Reflect.deleteProperty(globalThis, "document");
          }
          if (previousWindow) {
            Object.defineProperty(globalThis, "window", previousWindow);
          } else {
            Reflect.deleteProperty(globalThis, "window");
          }
        }
      },
    };
    const internals = browser as unknown as {
      needGameFrame: () => Promise<typeof frame>;
    };
    internals.needGameFrame = async () => frame;

    const result = await browser.go("objective", 8);

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["focus", "go"]);
  });

  it("Vite 自动恢复只跳过一次导航，后续验证会真正消费新 checkpoint", async () => {
    const browser = new GameBrowser("http://127.0.0.1:5173", () => undefined, null);
    let navigationCount = 0;
    let timeOrigin = 1;
    const frame = {
      goto: async () => {
        navigationCount += 1;
        timeOrigin += 1;
      },
    };
    const internals = browser as unknown as {
      needGameFrame: () => Promise<typeof frame>;
      waitForReady: (currentFrame?: typeof frame) => Promise<void>;
      restorationState: (currentFrame: typeof frame) => Promise<{
        restored: boolean;
        timeOrigin: number;
      }>;
      look: () => Promise<PlayView>;
    };
    internals.needGameFrame = async () => frame;
    internals.waitForReady = async () => undefined;
    internals.restorationState = async () => ({ restored: true, timeOrigin });
    internals.look = async () => playView({ banner: "Vite 已恢复检查点" });

    const autoRestored = await browser.reloadFromCheckpoint();
    const explicitlyRestored = await browser.reloadFromCheckpoint();

    assert.equal(autoRestored.banner, "Vite 已恢复检查点");
    assert.equal(explicitlyRestored.banner, "Vite 已恢复检查点");
    assert.equal(navigationCount, 1);
  });

  it("实时投影不覆盖复现检查点，也不把自动状态读取写入 Trace", async () => {
    const browser = new RecordingBrowser();
    const driver = new GameDriver(browser as unknown as GameBrowser);

    const view = await driver.peek();

    assert.equal(view.floor, 1);
    assert.deepEqual(browser.calls, ["look"]);
    assert.equal(browser.checkpointCount, 0);
    assert.deepEqual(driver.trace.snapshot(), []);
  });

  it("一次 objective 工具调用内部跨过非终止 action/task 边界直到进入目标模式", async () => {
    const browser = new RecordingBrowser();
    browser.goResults.push(
      { ...playResult("action"), steps: 6 },
      { ...playResult("task"), steps: 2 },
      playResult("mode", playView({
        mode: "combat",
        actions: [{ id: "terminal", label: "打开当前 SQL 战斗终端" }],
      })),
    );
    const driver = new GameDriver(browser as unknown as GameBrowser);

    await driver.beginReproduction();
    browser.calls.length = 0;
    const result = await driver.go("objective", 64);

    assert.equal(result.event, "mode");
    assert.equal(result.view.mode, "combat");
    assert.equal(result.steps, 8);
    assert.deepEqual(browser.calls, ["go", "go", "go"]);
    assert.deepEqual(driver.trace.snapshot().map((entry) => entry.action), ["go"]);
  });

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
    assert.deepEqual(browser.calls, [
      "reload",
      "checkpoint",
      "look",
      "go",
      "look",
      "use",
      "look",
      "query",
    ]);
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
    assert.deepEqual(browser.calls, ["reload", "checkpoint", "look", "go"]);
  });

  it("input_sql 只保存长度并可在同一进程刷新重放", async () => {
    const browser = new RecordingBrowser();
    const driver = new GameDriver(browser as unknown as GameBrowser);
    await driver.beginReproduction();
    await driver.use("interact");
    await driver.inputSql("SELECT id FROM monsters");
    await driver.query();
    const actions = driver.trace.snapshot();
    const input = actions.find((entry) => entry.action === "input-sql");
    assert.ok(input);
    assert.equal(input.arguments.inputLength, "SELECT id FROM monsters".length);
    assert.ok(!JSON.stringify(input).includes("SELECT id"));

    const replay = await driver.reloadAndReplay(actions);
    assert.equal(replay.passed, true);
    assert.equal(replay.actionCount, 3);
    assert.ok(browser.calls.includes("inputSql"));
  });

  it("任务重启后缺少内存 SQL 正文会明确阻断重放", async () => {
    const originalBrowser = new RecordingBrowser();
    const originalDriver = new GameDriver(originalBrowser as unknown as GameBrowser);
    await originalDriver.beginReproduction();
    await originalDriver.use("interact");
    await originalDriver.inputSql("SELECT id FROM monsters");
    const actions = originalDriver.trace.snapshot();

    const resumedBrowser = new RecordingBrowser();
    const resumedDriver = new GameDriver(resumedBrowser as unknown as GameBrowser);
    await resumedDriver.beginReproduction();
    resumedBrowser.calls.length = 0;
    const replay = await resumedDriver.reloadAndReplay(actions);
    assert.equal(replay.passed, false);
    assert.equal(replay.failure, "replay-input-unavailable");
    assert.deepEqual(resumedBrowser.calls, []);
  });

  it("原复现中的失败探测不阻断后续动作和结果断言", async () => {
    const browser = new RecordingBrowser();
    const driver = new GameDriver(browser as unknown as GameBrowser);
    await driver.beginReproduction();
    browser.failNextGo = true;
    await driver.go("objective", 8);
    await driver.use("interact");
    const actions = driver.trace.snapshot();
    assert.deepEqual(actions.map((entry) => entry.ok), [false, true]);
    browser.calls.length = 0;

    const replay = await driver.reloadAndReplay(actions);

    assert.equal(replay.passed, true);
    assert.equal(replay.actionCount, 2);
    assert.deepEqual(browser.calls, [
      "reload",
      "checkpoint",
      "look",
      "go",
      "look",
      "use",
    ]);
  });

  it("可重放 Trace 省略中途失败探测，但保留终止故障动作", async () => {
    const browser = new RecordingBrowser();
    const driver = new GameDriver(browser as unknown as GameBrowser);
    await driver.beginReproduction();
    await driver.use("continue");
    browser.failNextGo = true;
    await driver.go("objective", 8);
    await driver.use("interact");
    assert.deepEqual(
      replayableTraceActions(driver.trace.snapshot()).map((entry) => entry.action),
      ["use"],
    );

    browser.failNextGo = true;
    await driver.go("objective", 8);
    const normalized = replayableTraceActions(driver.trace.snapshot());
    assert.deepEqual(normalized.map((entry) => entry.action), ["use", "go"]);
    assert.deepEqual(normalized.map((entry) => entry.ok), [true, false]);
  });

  it("终止动作进入 transition 时有限等待自动楼层切换", async () => {
    const browser = new RecordingBrowser();
    browser.transitionOnUse = true;
    const driver = new GameDriver(browser as unknown as GameBrowser);
    await driver.beginReproduction();
    await driver.use("interact");
    const actions = driver.trace.snapshot();
    browser.calls.length = 0;

    const replay = await driver.reloadAndReplay(actions);

    assert.equal(replay.passed, true);
    assert.equal(replay.finalView.floor, 2);
    assert.equal(replay.finalView.mode, "explore");
    assert.deepEqual(browser.calls, ["reload", "checkpoint", "look", "use", "look"]);
  });

  it("重放中间动作暂时离开 explore 时等待后再移动", async () => {
    const browser = new RecordingBrowser();
    browser.transitionOnUse = true;
    const driver = new GameDriver(browser as unknown as GameBrowser);
    await driver.beginReproduction();
    await driver.use("interact");
    await driver.go("objective", 8);
    const actions = driver.trace.snapshot();
    browser.calls.length = 0;

    const replay = await driver.reloadAndReplay(actions);

    assert.equal(replay.passed, true);
    assert.equal(replay.actionCount, 2);
    assert.deepEqual(browser.calls, ["reload", "checkpoint", "look", "use", "look", "go"]);
  });

  it("动作全部成功但 hidden judge 断言为假时仍判定失败", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "maintainer-replay-"));
    try {
      const store = new TaskStore(dataRoot);
      const task = createTaskRecordFixture({ id: "judge-false" });
      const browser = new RecordingBrowser();
      browser.transitionOnUse = true;
      browser.judgeResult = {
        ...browser.judgeResult,
        lessons: 5,
        advanced: true,
      };
      const driver = new GameDriver(browser as unknown as GameBrowser);
      await driver.beginReproduction();
      await driver.use("interact");
      const reproduction: ReproductionRecord = {
        schemaVersion: 2,
        id: "judge-reproduction",
        title: "层主结算",
        expected: "层主已击败",
        actual: "动作可执行",
        evidence: ["玩家可见状态"],
        actions: driver.trace.snapshot(),
        assertions: {
          floor: 2,
          mode: "explore",
          minLessons: 5,
          advancedFromFloor: 1,
          bossDefeated: true,
        },
        createdAt: new Date(0).toISOString(),
      };

      const replay = await replayReproduction(store, task, driver, reproduction);

      assert.equal(replay.passed, false);
      assert.equal(replay.failure, "reproduction-assertion-failed");
      assert.equal(browser.calls.at(-1), "judge");
      const events = await readFile(
        join(store.taskDir(task.id), "events.jsonl"),
        "utf8",
      );
      assert.ok(!events.includes("bossDefeated"));
      assert.ok(!events.includes("requiredLessons"));
      assert.ok(!events.includes("migrationComplete"));
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("queryAccepted 断言阻止失败查询被误判为修复通过", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "maintainer-replay-query-"));
    try {
      const store = new TaskStore(dataRoot);
      const task = createTaskRecordFixture({ id: "query-rejected" });
      const browser = new RecordingBrowser();
      const driver = new GameDriver(browser as unknown as GameBrowser);
      await driver.beginReproduction();
      await driver.use("interact");
      browser.queryAccepted = false;
      await driver.query();
      const reproduction: ReproductionRecord = {
        schemaVersion: 2,
        id: "query-reproduction",
        title: "默认查询被错误拒绝",
        expected: "查询被接受",
        actual: "查询被拒绝",
        evidence: ["玩家可见 banner"],
        actions: driver.trace.snapshot(),
        assertions: {
          floor: 1,
          mode: "combat",
          queryAccepted: true,
        },
        createdAt: new Date(0).toISOString(),
      };

      const rejected = await replayReproduction(store, task, driver, reproduction);
      assert.equal(rejected.passed, false);
      assert.equal(rejected.queryAccepted, false);
      assert.equal(rejected.failure, "player-assertion-failed:queryAccepted");

      browser.queryAccepted = true;
      const accepted = await replayReproduction(store, task, driver, reproduction);
      assert.equal(accepted.passed, true);
      assert.equal(accepted.queryAccepted, true);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("terminalOpen 断言阻止终端按钮失效被误判为刷新通过", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "maintainer-replay-terminal-"));
    try {
      const store = new TaskStore(dataRoot);
      const task = createTaskRecordFixture({ id: "terminal-closed" });
      const browser = new RecordingBrowser();
      const driver = new GameDriver(browser as unknown as GameBrowser);
      await driver.beginReproduction();
      await driver.use("interact");
      const reproduction: ReproductionRecord = {
        schemaVersion: 2,
        id: "terminal-reproduction",
        title: "战斗终端打不开",
        expected: "点击终端动作后 textarea 可见",
        actual: "动作返回但终端仍关闭",
        evidence: ["玩家投影 terminal 为 null"],
        actions: driver.trace.snapshot(),
        assertions: { floor: 1, mode: "explore", terminalOpen: true },
        createdAt: new Date(0).toISOString(),
      };

      const closed = await replayReproduction(store, task, driver, reproduction);
      assert.equal(closed.passed, false);
      assert.equal(closed.failure, "player-assertion-failed:terminalOpen");

      browser.terminalOpenOnUse = true;
      reproduction.assertions.mode = "combat";
      const opened = await replayReproduction(store, task, driver, reproduction);
      assert.equal(opened.passed, true);
      assert.notEqual(opened.finalView.terminal, null);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
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
