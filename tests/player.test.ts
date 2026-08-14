/** 确定性试玩测试验证 64 步宏移动、隐藏裁判和重复错误中止，不启动真实浏览器。 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFloor, type PlayBrowser } from "../src/adapters/sql-dungeon/player.js";
import type { BrowserResult, PlayJudge, PlayView } from "../src/adapters/sql-dungeon/browser.js";

function view(mode = "explore"): PlayView {
  return {
    floor: 1, mode,
    hp: { current: 2, max: 2, armor: 0 },
    progress: { lessons: 0, rooms: 1, moves: 0, queries: 0, hintLevel: 0 },
    actions: [{ id: "objective", label: "前往目标" }],
    room: "入口", mission: { title: "SELECT * FROM hidden", body: "推进", lesson: "SELECT" },
    record: null,
    prompt: "E 调查", banner: "api_key=abcdefghijklmnop",
  };
}

class FakeBrowser implements PlayBrowser {
  calls = 0;
  maxSteps: number[] = [];
  complete = false;
  readonly stableFailure: boolean;
  constructor(stableFailure = false) { this.stableFailure = stableFailure; }
  openFloor(): Promise<PlayView> { return Promise.resolve(view()); }
  look(): Promise<PlayView> { return Promise.resolve(view()); }
  go(_target: "objective" | "frontier", maxSteps: number): Promise<BrowserResult> {
    this.calls += 1; this.maxSteps.push(maxSteps);
    if (this.stableFailure) return Promise.resolve({ ok: false, event: "no-discovered-path", steps: 0, view: view() });
    this.complete = true;
    return Promise.resolve({ ok: true, event: "floor", steps: 8, view: { ...view(), floor: 2 } });
  }
  use(actionId: string): Promise<BrowserResult> {
    void actionId;
    return Promise.reject(new Error("unexpected use"));
  }
  query(): Promise<BrowserResult> { return Promise.reject(new Error("unexpected query")); }
  judge(): Promise<PlayJudge> {
    return Promise.resolve({ floor: 1, mode: "explore", lessons: this.complete ? 1 : 0, requiredLessons: 1, bossDefeated: this.complete, migrationSteps: 0, migrationComplete: false, advanced: this.complete });
  }
  wait(): Promise<void> { return Promise.resolve(); }
  screenshot(): Promise<void> { return Promise.resolve(); }
}

void test("宏移动固定最多 64 步且由隐藏裁判确认通过", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "maintainer-player-"));
  context.after(async () => rm(output, { recursive: true, force: true }));
  const browser = new FakeBrowser();
  const steps: Parameters<typeof runFloor>[2] = [];
  const report = await runFloor(browser, 1, steps, output);
  assert.equal(report.status, "PASS");
  assert.deepEqual(browser.maxSteps, [64]);
  assert.equal(report.moves, 8);
  const firstStep = steps[0];
  assert.ok(firstStep);
  assert.deepEqual(firstStep.trace.actions, ["objective"]);
  assert.doesNotMatch(JSON.stringify(firstStep.trace), /SELECT \* FROM hidden|abcdefghijklmnop/iu);
});

void test("连续三次相同路线错误停止并分类为工具阻断", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "maintainer-player-stuck-"));
  context.after(async () => rm(output, { recursive: true, force: true }));
  const browser = new FakeBrowser(true);
  const report = await runFloor(browser, 1, [], output);
  assert.equal(report.status, "BLOCKED_TOOL");
  assert.equal(browser.calls, 3);
  assert.equal(report.stuck, 3);
});

void test("显式等待态不会误点其他覆盖层动作", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "maintainer-player-wait-"));
  context.after(async () => rm(output, { recursive: true, force: true }));
  class WaitingBrowser extends FakeBrowser {
    waits = 0;
    override look(): Promise<PlayView> {
      return Promise.resolve(this.complete
        ? { ...view(), floor: 2 }
        : { ...view("victory"), actions: [{ id: "wait", label: "等待结算" }] });
    }
    override wait(): Promise<void> { this.waits += 1; this.complete = true; return Promise.resolve(); }
    override go(): Promise<BrowserResult> { return Promise.reject(new Error("等待态不应移动")); }
  }
  const browser = new WaitingBrowser();
  const report = await runFloor(browser, 1, [], output);
  assert.equal(report.status, "PASS");
  assert.equal(browser.waits, 1);
});

void test("MIGRATE 每页公开记录变化都算作进展", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "maintainer-player-migrate-"));
  context.after(async () => rm(output, { recursive: true, force: true }));
  class MigrationBrowser extends FakeBrowser {
    page = 0;
    override look(): Promise<PlayView> {
      return Promise.resolve({
        ...view("victory"),
        actions: [{ id: "continue", label: "继续" }],
        record: { kicker: `MIGRATE ${String(this.page + 1)}/7`, title: `步骤 ${String(this.page + 1)}`, body: "公开终章记录" },
      });
    }
    override use(actionId: string): Promise<BrowserResult> {
      assert.equal(actionId, "continue");
      this.page += 1;
      if (this.page >= 7) this.complete = true;
      return this.look().then((current) => ({ ok: true, event: "action:continue", steps: 0, view: current }));
    }
    override go(): Promise<BrowserResult> { return Promise.reject(new Error("MIGRATE 不应移动")); }
    override judge(): Promise<PlayJudge> {
      return Promise.resolve({
        floor: 8, mode: "victory", lessons: 7, requiredLessons: 7,
        bossDefeated: true, migrationSteps: this.page,
        migrationComplete: this.complete, advanced: false,
      });
    }
  }
  const browser = new MigrationBrowser();
  const steps: Parameters<typeof runFloor>[2] = [];
  const report = await runFloor(browser, 8, steps, output);
  assert.equal(report.status, "PASS");
  assert.equal(browser.page, 7);
  assert.equal(steps.filter((step) => step.action === "use").length, 7);
});
