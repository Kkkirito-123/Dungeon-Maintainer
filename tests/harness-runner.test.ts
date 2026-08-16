/** 通用 Runner 集成测试使用真实 Pi 循环和临时 Git 仓库验证报告、事件与结果缓存。 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  HarnessAdapter,
  HarnessEventSink,
  HarnessSession,
  HarnessToolContext,
} from "../src/harness/contract.js";
import { runHarness } from "../src/harness/runner.js";
import { loadConfig } from "../src/runtime/config.js";
import type { RuntimeModel } from "../src/runtime/model.js";
import { TaskStore } from "../src/runtime/task.js";

const exec = promisify(execFile);
const Empty = Type.Object({}, { additionalProperties: false });

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, encoding: "utf8", windowsHide: true })).stdout.trim();
}

async function fixture(context: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "maintainer-harness-runner-"));
  const repo = join(parent, "repo");
  const data = join(parent, "data");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "Harness Test"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  context.after(async () => rm(parent, { recursive: true, force: true }));
  return { repo, data, head: await git(repo, ["rev-parse", "HEAD"]) };
}

function fauxRuntime(called: { value: number }, scenarios = 1): RuntimeModel {
  const faux = fauxProvider({ models: [{ id: "harness-test", input: ["text"], contextWindow: 64_000 }] });
  faux.setResponses(Array.from({ length: scenarios }, () => [
      () => {
        called.value += 1;
        return fauxAssistantMessage(fauxToolCall("look", {}), { stopReason: "toolUse" });
      },
      () => {
        called.value += 1;
        return fauxAssistantMessage(fauxToolCall("finish", {
          status: "diagnosed",
          summary: "场景公开流程正常。",
          risk: "仅验证假环境。",
          checks: [],
        }), { stopReason: "toolUse" });
      },
    ]).flat());
  const models = createModels();
  models.setProvider(faux.provider);
  return { model: faux.getModel(), stream: models.streamSimple.bind(models) };
}

function unfinishedRuntime(): RuntimeModel {
  const faux = fauxProvider({ models: [{ id: "unfinished", input: ["text"], contextWindow: 64_000 }] });
  faux.setResponses([fauxAssistantMessage("观察结束，但没有调用 finish。")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { model: faux.getModel(), stream: models.streamSimple.bind(models) };
}

function probeRuntime(toolSets: string[][]): RuntimeModel {
  const faux = fauxProvider({ models: [{ id: "probe", input: ["text"], contextWindow: 64_000 }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("look", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finish", {
      status: "diagnosed",
      summary: "当前公开流程正常。",
      risk: "未修改代码。",
      checks: [],
      diagnosis: {
        result: "healthy",
        issue: "未发现可复现故障",
        cause: "当前有限动作和运行状态均正常",
        evidence: ["开发态桥返回有效可见状态"],
        fix: "无需现场修复",
        paths: [],
        risk: "low",
      },
    }), { stopReason: "toolUse" }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const stream: RuntimeModel["stream"] = (model, context, options) => {
    toolSets.push(context.tools?.map((tool) => tool.name) ?? []);
    return models.streamSimple(model, context, options);
  };
  return { model: faux.getModel(), stream };
}

function adapter(opened: { value: number }, events: Parameters<HarnessEventSink>[0][]): HarnessAdapter {
  return {
    id: "fixture",
    version: 1,
    title: "Fixture",
    checks: {
      spec: (id) => ({ id, file: process.execPath, args: ["--version"] }),
      required: () => [],
    },
    decisionCache: {
      tools: ["look"],
      sanitize: (tool, args) => tool === "look" && args && typeof args === "object"
        && !Array.isArray(args) && Object.keys(args).length === 0 ? {} : null,
    },
    scenarios: (ids) => ids.map((id) => ({ id, label: "基础场景", goal: "观察并确认状态" })),
    systemPrompt: () => "先调用 look，再调用 finish。每回合只调用一个工具。",
    open: () => {
      opened.value += 1;
      let toolsContext: HarnessToolContext | null = null;
      const session: HarnessSession = {
        openScenario: () => Promise.resolve(),
        tools(context): AgentTool[] {
          toolsContext = context;
          return [{
            name: "look",
            label: "观察",
            description: "读取有限环境状态。",
            executionMode: "sequential",
            parameters: Empty,
            execute: () => {
              toolsContext?.record({
                action: "look", event: "ready", ok: true, ms: 1, units: 0, state: "ready",
                trace: { objective: "确认", state: "ready", note: "公开状态", actions: ["finish"] },
              });
              return Promise.resolve({ content: [{ type: "text" as const, text: "ready" }], details: { state: "ready" } });
            },
          }];
        },
        verdict: () => Promise.resolve({ passed: true, summary: "隐藏验证通过。", metrics: { checks: 1 }, facts: ["状态成立"] }),
        reload: () => Promise.resolve(),
        emit: (event) => { events.push(event); return Promise.resolve(); },
        screenshot: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      return Promise.resolve(session);
    },
  };
}

void test("通用 Runner 完成 Pi 闭环并在同代码场景复用 PASS", async (context) => {
  const value = await fixture(context);
  const store = new TaskStore(value.data);
  const config = { ...loadConfig({ LOCALAPPDATA: value.data, MAINTAINER_API_KEY: "faux" }), dataDir: value.data };
  const opened = { value: 0 };
  const called = { value: 0 };
  const events: Parameters<HarnessEventSink>[0][] = [];
  const environment = adapter(opened, events);
  const firstTask = await store.create({ mode: "diagnose", objective: "验证 Harness", repoRoot: value.repo, baseHead: value.head });
  await store.transition(firstTask, "diagnosing");
  const first = await runHarness({
    task: firstTask, store, config, adapter: environment, scenarioIds: ["basic"], headed: false,
    model: fauxRuntime(called),
  });
  assert.equal(first.status, "PASS");
  assert.equal(first.scenarios[0]?.cached, false);
  assert.equal(first.steps[0]?.action, "look");
  assert.equal(opened.value, 1);
  assert.equal(called.value, 2);
  assert.ok(events.some((event) => event.type === "phase" && event.phase === "plan"));
  assert.ok(events.some((event) => event.type === "finding"));
  assert.ok(events.some((event) => event.type === "status" && event.status === "RUNNING"));
  assert.ok(events.some((event) => event.type === "status" && event.status === "PASS"));

  const secondTask = await store.create({ mode: "diagnose", objective: "重复验证 Harness", repoRoot: value.repo, baseHead: value.head });
  await store.transition(secondTask, "diagnosing");
  const second = await runHarness({
    task: secondTask, store, config, adapter: environment, scenarioIds: ["basic"], headed: false,
    model: fauxRuntime(called),
  });
  assert.equal(second.status, "PASS");
  assert.equal(second.scenarios[0]?.cached, true);
  assert.equal(second.usage.total, 0);
  assert.equal(opened.value, 1);
  assert.equal(called.value, 2);
});

void test("隐藏裁判通过但 Agent 未调用 finish 时不得报告 PASS", async (context) => {
  const value = await fixture(context);
  const store = new TaskStore(value.data);
  const config = { ...loadConfig({ LOCALAPPDATA: value.data, MAINTAINER_API_KEY: "faux" }), dataDir: value.data };
  const task = await store.create({ mode: "diagnose", objective: "验证完成声明", repoRoot: value.repo, baseHead: value.head });
  await store.transition(task, "diagnosing");

  const report = await runHarness({
    task,
    store,
    config,
    adapter: adapter({ value: 0 }, []),
    scenarioIds: ["basic"],
    headed: false,
    fresh: true,
    model: unfinishedRuntime(),
  });

  assert.equal(report.status, "BLOCKED_TOOL");
  assert.equal(report.scenarios[0]?.status, "BLOCKED_TOOL");
});

void test("Dashboard probe 只暴露观察、代码检查和结束工具", async (context) => {
  const value = await fixture(context);
  const store = new TaskStore(value.data);
  const config = { ...loadConfig({ LOCALAPPDATA: value.data, MAINTAINER_API_KEY: "faux" }), dataDir: value.data };
  const task = await store.create({
    mode: "fix",
    source: "dashboard",
    objective: "快速排查当前状态",
    repoRoot: value.repo,
    baseHead: value.head,
  });
  task.worktreeRoot = value.repo;
  await store.save(task);
  await store.transition(task, "diagnosing");
  const toolSets: string[][] = [];

  const result = await runHarness({
    task,
    store,
    config,
    adapter: adapter({ value: 0 }, []),
    scenarioIds: ["basic"],
    headed: false,
    fresh: true,
    stage: "probe",
    limits: { turns: 6, toolCalls: 6, tokens: 8_000 },
    model: probeRuntime(toolSets),
  });

  assert.equal(result.status, "PASS");
  assert.deepEqual([...new Set(toolSets.flat())].sort(), ["finish", "inspect", "look"]);
  assert.deepEqual(task.changedPaths, []);
  assert.deepEqual(task.checks, []);
});

void test("Dashboard 增量限额会在未 finish 时分类为 LIMIT_REACHED", async (context) => {
  const value = await fixture(context);
  const store = new TaskStore(value.data);
  const config = { ...loadConfig({ LOCALAPPDATA: value.data, MAINTAINER_API_KEY: "faux" }), dataDir: value.data };
  const task = await store.create({
    mode: "fix",
    source: "dashboard",
    objective: "验证快速排查限额",
    repoRoot: value.repo,
    baseHead: value.head,
  });
  task.worktreeRoot = value.repo;
  await store.save(task);
  await store.transition(task, "diagnosing");

  const result = await runHarness({
    task,
    store,
    config,
    adapter: adapter({ value: 0 }, []),
    scenarioIds: ["basic"],
    headed: false,
    fresh: true,
    stage: "probe",
    limits: { turns: 1, toolCalls: 1, tokens: 8_000 },
    model: fauxRuntime({ value: 0 }),
  });

  assert.equal(result.status, "LIMIT_REACHED");
  assert.equal(task.usage.turns, 1);
  assert.equal(task.usage.toolCalls, 1);
});

void test("多场景分别计算回合与工具预算但共享任务 Token 上限", async (context) => {
  const value = await fixture(context);
  const store = new TaskStore(value.data);
  const config = {
    ...loadConfig({ LOCALAPPDATA: value.data, MAINTAINER_API_KEY: "faux" }),
    dataDir: value.data,
    maxTurns: 2,
    maxToolCalls: 2,
  };
  const opened = { value: 0 };
  const called = { value: 0 };
  const task = await store.create({ mode: "diagnose", objective: "验证多场景", repoRoot: value.repo, baseHead: value.head });
  await store.transition(task, "diagnosing");
  const report = await runHarness({
    task,
    store,
    config,
    adapter: adapter(opened, []),
    scenarioIds: ["first", "second"],
    headed: false,
    fresh: true,
    model: fauxRuntime(called, 2),
  });

  assert.equal(report.status, "PASS");
  assert.deepEqual(report.scenarios.map((scenario) => scenario.status), ["PASS", "PASS"]);
  assert.equal(task.usage.turns, 4);
  assert.equal(task.usage.toolCalls, 4);
  assert.equal(called.value, 4);
});
