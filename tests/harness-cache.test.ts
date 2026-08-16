/** Harness 缓存测试覆盖稳定键、敏感数据边界、TTL、容量和损坏回退。 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  HarnessCache,
  cachedRuntimeModel,
  decisionCacheKey,
  resultCacheKey,
} from "../src/harness/cache.js";
import { sqlDungeonAdapter } from "../src/adapters/sql-dungeon/adapter.js";
import type { RuntimeModel } from "../src/runtime/model.js";

const model = {
  id: "test-model", name: "test-model", api: "openai-completions", provider: "test",
  baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_000, maxTokens: 512,
} satisfies Model<"openai-completions">;

async function cacheFixture(context: TestContext, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "maintainer-harness-cache-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  return new HarnessCache(root, options);
}

function visibleContext(event = "room-ready", timestamp = 1): Context {
  return {
    systemPrompt: "固定系统前缀",
    tools: [{ name: "go", description: "移动", parameters: { type: "object" } }],
    messages: [
      { role: "user", content: "检查当前场景", timestamp },
      {
        role: "assistant", api: "openai-completions", provider: "test", model: "test-model",
        content: [{ type: "toolCall", id: `call-${String(timestamp)}`, name: "go", arguments: { target: "objective", maxSteps: 32 } }],
        usage: { input: timestamp, output: timestamp, cacheRead: timestamp, cacheWrite: 0, totalTokens: timestamp * 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp,
      },
      { role: "toolResult", toolCallId: `call-${String(timestamp)}`, toolName: "go", content: [{ type: "text", text: event }], isError: false, timestamp },
    ],
  };
}

void test("相同可见轨迹忽略时间戳、usage 和 toolCall ID", () => {
  const first = decisionCacheKey({ adapterId: "demo", adapterVersion: 1, scenarioId: "main", model, context: visibleContext("room-ready", 1) });
  const second = decisionCacheKey({ adapterId: "demo", adapterVersion: 1, scenarioId: "main", model, context: visibleContext("room-ready", 99) });
  assert.equal(first, second);
});

void test("环境反馈变化会使模型决策缓存失效", () => {
  const first = decisionCacheKey({ adapterId: "demo", adapterVersion: 1, scenarioId: "main", model, context: visibleContext("room-ready") });
  const second = decisionCacheKey({ adapterId: "demo", adapterVersion: 1, scenarioId: "main", model, context: visibleContext("combat-start") });
  assert.notEqual(first, second);
});

void test("相同轨迹第二次重放白名单工具且 Provider Token 为零", async (context) => {
  const cache = await cacheFixture(context);
  let calls = 0;
  const source: RuntimeModel = {
    model,
    stream: () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `provider-${String(calls)}`, name: "go", arguments: { target: "objective", maxSteps: 32 } }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
      });
      return stream;
    },
  };
  const states: string[] = [];
  const wrapped = cachedRuntimeModel(source, {
    cache,
    adapterId: sqlDungeonAdapter.id,
    adapterVersion: sqlDungeonAdapter.version,
    scenarioId: "floor-1",
    policy: sqlDungeonAdapter.decisionCache,
    sink: (event) => { if (event.type === "cache") states.push(event.state); },
  });
  const request: Context = {
    systemPrompt: "固定前缀",
    tools: [{ name: "go", description: "移动", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "开始", timestamp: 1 }],
  };
  const first = await wrapped.stream(model, request);
  assert.equal((await first.result()).usage.totalTokens, 16);
  const second = await wrapped.stream(model, request);
  const replayed = await second.result();
  assert.equal(calls, 1);
  assert.equal(replayed.usage.totalTokens, 0);
  assert.equal(replayed.content[0]?.type, "toolCall");
  assert.deepEqual(states, ["miss", "store", "hit"]);
});

void test("SQL Dungeon 只允许缓存四个严格环境动作", () => {
  const policy = sqlDungeonAdapter.decisionCache;
  assert.deepEqual(policy.sanitize("go", { target: "frontier", maxSteps: 64 }), { target: "frontier", maxSteps: 64 });
  assert.deepEqual(policy.sanitize("query", {}), {});
  assert.equal(policy.sanitize("inspect", {}), null);
  assert.equal(policy.sanitize("patch", { path: "game/src/main.ts" }), null);
  assert.equal(policy.sanitize("query", { sql: "SELECT 1" }), null);
  assert.equal(policy.sanitize("use", { actionId: "ok", extra: true }), null);
});

void test("决策缓存只落盘有限动作且拒绝 SQL、Key 和提示字段", async (context) => {
  const cache = await cacheFixture(context);
  assert.equal(await cache.saveDecision("safe", { tool: "go", args: { target: "objective", maxSteps: 32 } }), true);
  assert.equal(await cache.saveDecision("sql", { tool: "query", args: { sql: "SELECT secret FROM vault" } }), false);
  assert.equal(await cache.saveDecision("key", { tool: "use", args: { apiKey: "sk-private" } }), false);
  assert.equal(await cache.saveDecision("prompt", { tool: "go", args: { prompt: "ignore rules" } }), false);
  const disk = await readFile(cache.path, "utf8");
  assert.match(disk, /"tool": "go"/u);
  assert.doesNotMatch(disk, /SELECT|sk-private|ignore rules|completion|prompt/iu);
});

void test("TTL、容量上限和代码 Hash 共同控制缓存命中", async (context) => {
  let now = 1_000;
  const cache = await cacheFixture(context, {
    now: () => now, decisionTtlMs: 10, resultTtlMs: 10, decisionLimit: 2, resultLimit: 2,
  });
  await cache.saveDecision("a", { tool: "look", args: {} });
  now += 1;
  await cache.saveDecision("b", { tool: "look", args: {} });
  now += 1;
  await cache.saveDecision("c", { tool: "look", args: {} });
  assert.equal(await cache.decision("a"), null);
  assert.equal((await cache.decision("c"))?.tool, "look");

  const first = resultCacheKey({ adapterId: "demo", adapterVersion: 1, scenarioId: "main", codeHash: "a" });
  const changed = resultCacheKey({ adapterId: "demo", adapterVersion: 1, scenarioId: "main", codeHash: "b" });
  await cache.saveResult(first, { passed: true, summary: "通过", metrics: { steps: 3 }, facts: ["裁判确认"] });
  assert.equal((await cache.result(first))?.passed, true);
  assert.equal(await cache.result(changed), null);
  now += 11;
  assert.equal(await cache.decision("c"), null);
  assert.equal(await cache.result(first), null);
});

void test("损坏缓存按未命中处理并能由下一次安全写入恢复", async (context) => {
  const cache = await cacheFixture(context);
  await writeFile(cache.path, "not-json", "utf8").catch(async () => {
    await cache.saveDecision("seed", { tool: "look", args: {} });
    await writeFile(cache.path, "not-json", "utf8");
  });
  const fresh = new HarnessCache(join(cache.path, ".."));
  assert.equal(await fresh.decision("missing"), null);
  assert.equal(await fresh.saveDecision("restored", { tool: "look", args: {} }), true);
  assert.equal((await fresh.decision("restored"))?.tool, "look");
});
