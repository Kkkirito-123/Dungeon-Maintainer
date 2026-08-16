/** Dashboard 控制器测试使用隔离任务存储和假浏览器验证按钮协议，不启动 Chromium。 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DashboardBindings } from "../src/adapters/sql-dungeon/browser.js";
import type { SqlDungeonDashboardSession } from "../src/adapters/sql-dungeon/adapter.js";
import { DashboardController, type DashboardServices } from "../src/dashboard/controller.js";
import type {
  HarnessScenario,
  HarnessVerdict,
} from "../src/harness/contract.js";
import { harnessEvent, type HarnessEvent } from "../src/harness/events.js";
import type { HarnessRunResult } from "../src/harness/runner.js";
import { loadConfig } from "../src/runtime/config.js";
import { TaskStore, type Diagnosis, type TaskRecord } from "../src/runtime/task.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("等待 Dashboard 测试状态超时");
}

class FakeSession implements SqlDungeonDashboardSession {
  readonly events: HarnessEvent[] = [];
  readonly bound = deferred();
  readonly pageClosed = deferred();
  bindings: DashboardBindings | null = null;
  closed = false;
  opened: HarnessScenario | null = null;
  floor = 4;

  bindDashboard(bindings: DashboardBindings): Promise<void> {
    this.bindings = bindings;
    this.bound.resolve();
    return Promise.resolve();
  }

  openScenario(scenario: HarnessScenario): Promise<void> {
    this.opened = scenario;
    return Promise.resolve();
  }

  tools(): AgentTool[] { return []; }

  verdict(): Promise<HarnessVerdict> {
    return Promise.resolve({ passed: true, summary: "通过", metrics: {}, facts: [] });
  }

  reload(): Promise<void> { return Promise.resolve(); }
  emit(event: HarnessEvent): Promise<void> { this.events.push(event); return Promise.resolve(); }
  screenshot(): Promise<void> { return Promise.resolve(); }
  currentFloor(): Promise<number> { return Promise.resolve(this.floor); }
  waitUntilClosed(): Promise<void> { return this.pageClosed.promise; }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
  closePage(): void { this.pageClosed.resolve(); }
}

function diagnosis(): Diagnosis {
  return {
    result: "fault",
    issue: "当前任务标题未刷新",
    cause: "展示订阅仍使用旧状态",
    evidence: ["步骤 3 后任务标题保持不变"],
    fix: "让展示层读取最新状态并增加回归测试",
    paths: ["game/src/presentation/dom/AppShell.ts"],
    risk: "low",
  };
}

function report(status: HarnessRunResult["status"] = "PASS"): HarnessRunResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId: "dashboard-test",
    adapter: { id: "sql-dungeon", version: 1, title: "SQL Dungeon" },
    status,
    codeHash: "hash",
    startedAt: now,
    finishedAt: now,
    scenarios: [],
    steps: [],
    summary: "Dashboard 测试报告",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    reportPath: "dashboard-report.md",
    approvalToken: null,
  };
}

async function fixture(context: TestContext): Promise<{
  data: string;
  repo: string;
  store: TaskStore;
  task: TaskRecord;
}> {
  const parent = await mkdtemp(join(tmpdir(), "maintainer-dashboard-"));
  const data = join(parent, "data");
  const repo = join(parent, "repo");
  await mkdir(repo, { recursive: true });
  const store = new TaskStore(data);
  const task = await store.create({
    mode: "fix",
    source: "dashboard",
    objective: "排查当前游戏状态",
    repoRoot: repo,
    baseHead: "base-head",
  });
  task.worktreeRoot = repo;
  await store.save(task);
  await store.transition(task, "diagnosing");
  context.after(async () => rm(parent, { recursive: true, force: true }));
  return { data, repo, store, task };
}

function services(
  session: FakeSession,
  run: DashboardServices["run"],
  apply: DashboardServices["apply"] = () => Promise.resolve({}),
): DashboardServices {
  return { open: () => Promise.resolve(session), run, apply };
}

void test("快速排查在任何异步读取前锁定 busy 并使用点击时当前楼层", async (context) => {
  const value = await fixture(context);
  const session = new FakeSession();
  const gate = deferred();
  const seenOptions: Array<Parameters<DashboardServices["run"]>[0]> = [];
  const run: DashboardServices["run"] = async (input) => {
    seenOptions.push(input);
    await gate.promise;
    input.task.diagnosis = diagnosis();
    await input.store.save(input.task);
    return report();
  };
  const controller = new DashboardController({
    task: value.task,
    store: value.store,
    config: { ...loadConfig({ MAINTAINER_API_KEY: "faux" }), dataDir: value.data },
    floor: 1,
    write: () => undefined,
    services: services(session, run),
  });
  const running = controller.run();
  await session.bound.promise;
  await waitFor(() => session.events.some((event) => event.type === "control" && event.state === "idle"));
  assert.ok(session.bindings);

  const [first, second] = await Promise.all([
    session.bindings.diagnose(),
    session.bindings.diagnose(),
  ]);
  assert.deepEqual(first, { schemaVersion: 1, accepted: true, reason: "started" });
  assert.deepEqual(second, { schemaVersion: 1, accepted: false, reason: "busy" });
  await waitFor(() => seenOptions.length === 1);
  const options = seenOptions[0];
  assert.ok(options);
  assert.deepEqual(options.scenarioIds, ["floor-4"]);
  assert.deepEqual(options.limits, { turns: 6, toolCalls: 6, tokens: 8_000 });
  assert.equal(options.stage, "probe");
  assert.equal(options.resume, true);
  assert.equal(options.fresh, true);

  gate.resolve();
  await waitFor(() => session.events.some((event) => event.type === "control" && event.state === "diagnosed"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await session.bindings.apply(), {
    schemaVersion: 1, accepted: false, reason: "invalid_state",
  });
  assert.ok(session.events.some((event) => event.type === "diagnosis"));

  session.closePage();
  await running;
  assert.equal(session.closed, true);
});

void test("核心批准后继续同一会话，验证通过后才允许页面应用", async (context) => {
  const value = await fixture(context);
  value.task.diagnosis = diagnosis();
  await value.store.save(value.task);
  await value.store.transition(value.task, "needs_approval");
  const session = new FakeSession();
  let runs = 0;
  const run: DashboardServices["run"] = async (input) => {
    runs += 1;
    assert.equal(input.stage, "repair");
    assert.deepEqual(input.limits, { turns: 20, toolCalls: 40, tokens: 64_000 });
    await input.onEvent?.(harnessEvent({
      type: "action", phase: "fix", action: "patch", state: "done", message: "补丁完成",
    }));
    await input.onEvent?.(harnessEvent({
      type: "action", phase: "check", action: "check", state: "start", message: "开始检查",
    }));
    input.task.state = "ready_to_apply";
    await input.store.save(input.task);
    return report();
  };
  let applied = 0;
  const apply: DashboardServices["apply"] = (task) => {
    assert.equal(task.state, "ready_to_apply");
    applied += 1;
    return Promise.resolve({ "game/src/presentation/dom/AppShell.ts": "after-hash" });
  };
  const controller = new DashboardController({
    task: value.task,
    store: value.store,
    config: { ...loadConfig({ MAINTAINER_API_KEY: "faux" }), dataDir: value.data },
    floor: 1,
    write: () => undefined,
    services: services(session, run, apply),
  });
  const running = controller.run();
  await session.bound.promise;
  await waitFor(() => session.events.some((event) => event.type === "control" && event.state === "idle"));
  assert.ok(session.bindings);

  assert.equal((await session.bindings.fix()).accepted, true);
  await waitFor(() => session.events.some((event) => event.type === "control" && event.state === "needs_approval"));
  assert.equal(runs, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await value.store.transition(value.task, "approved");
  assert.equal((await session.bindings.fix()).accepted, true);
  await waitFor(() => session.events.some((event) => event.type === "control" && event.state === "ready_to_apply"));
  assert.equal(runs, 1);
  assert.ok(session.events.some((event) => event.type === "diagnosis"));
  assert.ok(session.events.some((event) => event.type === "control" && event.state === "fixing"));
  assert.ok(session.events.some((event) => event.type === "control" && event.state === "verifying"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal((await session.bindings.apply()).accepted, true);
  await waitFor(() => session.events.some((event) => event.type === "control" && event.state === "applied"));
  assert.equal(applied, 1);
  assert.equal((await value.store.read(value.task.id)).state, "applied");

  session.closePage();
  await running;
});
