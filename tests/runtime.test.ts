/** Pi Runtime 测试用真实 Agent/Faux Provider 验证工具循环、审批暂停与批准恢复。 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall,
} from "@earendil-works/pi-ai";
import { runAgent } from "../src/runtime/agent.js";
import { loadConfig } from "../src/runtime/config.js";
import type { RuntimeModel } from "../src/runtime/model.js";
import { TaskStore } from "../src/runtime/task.js";
import { createTaskWorktree, hashFile } from "../src/safety/worktree.js";
import { sqlDungeonChecks } from "../src/adapters/sql-dungeon/adapter.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, encoding: "utf8", windowsHide: true })).stdout.trim();
}

async function repoFixture(context: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "maintainer-runtime-"));
  const repo = join(parent, "repo");
  const data = join(parent, "data");
  await mkdir(join(repo, ".maintainer"), { recursive: true });
  await mkdir(join(repo, "game", "src", "domain"), { recursive: true });
  await mkdir(join(repo, "scripts"), { recursive: true });
  await writeFile(join(repo, ".maintainer", "project.json"), '{"schemaVersion":1,"adapter":"sql-dungeon"}\n', "utf8");
  await writeFile(join(repo, "game", "src", "domain", "rule.ts"), "export const hp = 2;\n", "utf8");
  await writeFile(join(repo, "scripts", "test_validate_rules.py"), "print('ok')\n", "utf8");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "Maintainer Test"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  context.after(async () => rm(parent, { recursive: true, force: true }));
  return { repo, data, head: await git(repo, ["rev-parse", "HEAD"]) };
}

function fauxRuntime(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  tokensPerSecond?: number,
): RuntimeModel {
  const faux = fauxProvider({
    models: [{ id: "maintainer-test", input: ["text"], contextWindow: 64_000 }],
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { model: faux.getModel(), stream: models.streamSimple.bind(models) };
}

function config(dataDir: string) {
  return { ...loadConfig({ LOCALAPPDATA: dataDir, MAINTAINER_API_KEY: "not-used-by-faux" }), dataDir };
}

void test("Pi Agent 通过 inspect 和 finish 完成只读诊断", async (context) => {
  const value = await repoFixture(context);
  const store = new TaskStore(value.data);
  const task = await store.create({ mode: "diagnose", objective: "检查规则文件", repoRoot: value.repo, baseHead: value.head });
  await store.transition(task, "diagnosing");
  const model = fauxRuntime([
    fauxAssistantMessage(fauxToolCall("inspect", { action: "read", path: "game/src/domain/rule.ts", startLine: 1 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finish", { status: "diagnosed", summary: "规则文件结构清楚。", risk: "未修改代码。", checks: [] }), { stopReason: "toolUse" }),
  ]);
  const result = await runAgent(config(value.data), store, task, { model });
  assert.equal(result.outcome, "diagnosed");
  assert.equal(task.usage.toolCalls, 2);
  assert.match(task.conclusion ?? "", /规则文件结构清楚/);
});

void test("核心 patch 在执行前暂停并返回绑定路径的批准 token", async (context) => {
  const value = await repoFixture(context);
  const store = new TaskStore(value.data);
  const task = await store.create({ mode: "fix", objective: "调整生命规则", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await store.save(task);
  await store.transition(task, "diagnosing");
  const baseHash = await hashFile(task.worktreeRoot, "game/src/domain/rule.ts");
  const model = fauxRuntime([
    fauxAssistantMessage(fauxToolCall("patch", { edits: [{ path: "game/src/domain/rule.ts", baseHash, oldText: "export const hp = 2;", newText: "export const hp = 3;" }] }), { stopReason: "toolUse" }),
  ]);
  const result = await runAgent(config(value.data), store, task, { model });
  assert.equal(result.outcome, "needs_approval");
  assert.match(result.approvalToken ?? "", /^[0-9a-f]{12}$/u);
  assert.deepEqual(task.approval?.paths, ["game/src/domain/rule.ts"]);
  assert.equal((await readFile(join(task.worktreeRoot, "game/src/domain/rule.ts"), "utf8")).replaceAll("\r\n", "\n"), "export const hp = 2;\n");
});

void test("批准后重新检查、修改、验证并生成待应用补丁", async (context) => {
  const value = await repoFixture(context);
  const store = new TaskStore(value.data);
  const task = await store.create({ mode: "fix", objective: "调整生命规则", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await store.save(task);
  await store.transition(task, "diagnosing");
  const path = "game/src/domain/rule.ts";
  const baseHash = await hashFile(task.worktreeRoot, path);
  const first = fauxRuntime([
    fauxAssistantMessage(fauxToolCall("patch", { edits: [{ path, baseHash, oldText: "export const hp = 2;", newText: "export const hp = 3;" }] }), { stopReason: "toolUse" }),
  ]);
  const paused = await runAgent(config(value.data), store, task, { model: first });
  await store.approve(task, paused.approvalToken ?? "");
  const resumed = fauxRuntime([
    fauxAssistantMessage(fauxToolCall("inspect", { action: "read", path, startLine: 1 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("patch", { edits: [{ path, baseHash, oldText: "export const hp = 2;", newText: "export const hp = 3;" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("check", { id: "rules-test" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finish", { status: "ready", summary: "生命规则已调整。", risk: "单文件改动。", checks: ["rules-test"] }), { stopReason: "toolUse" }),
  ]);
  const result = await runAgent(config(value.data), store, task, {
    model: resumed,
    checks: sqlDungeonChecks,
  });
  assert.equal(result.outcome, "ready");
  assert.equal(task.state, "ready_to_apply");
  assert.ok(task.patchPath);
  assert.equal((await readFile(join(value.repo, path), "utf8")).replaceAll("\r\n", "\n"), "export const hp = 2;\n");
});

void test("Pi Agent 在工具执行前拒绝额外字段", async (context) => {
  const value = await repoFixture(context);
  const store = new TaskStore(value.data);
  const task = await store.create({ mode: "diagnose", objective: "验证严格工具契约", repoRoot: value.repo, baseHead: value.head });
  await store.transition(task, "diagnosing");
  const model = fauxRuntime([
    fauxAssistantMessage(fauxToolCall("inspect", {
      action: "read", path: "game/src/domain/rule.ts", startLine: 1, unexpected: true,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finish", {
      status: "diagnosed", summary: "额外字段已被拒绝。", risk: "未读取目标文件。", checks: [],
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runAgent(config(value.data), store, task, { model });
  assert.equal(result.outcome, "diagnosed");
  const events = await readFile(join(store.taskDir(task.id), "events.ndjson"), "utf8");
  assert.doesNotMatch(events, /"type":"tool\.inspect"/u);
  assert.match(events, /"type":"tool\.finish"/u);
});

void test("外部取消会终止流式模型并把任务标为 aborted", async (context) => {
  const value = await repoFixture(context);
  const store = new TaskStore(value.data);
  const task = await store.create({ mode: "diagnose", objective: "取消运行", repoRoot: value.repo, baseHead: value.head });
  await store.transition(task, "diagnosing");
  const model = fauxRuntime([fauxAssistantMessage("x".repeat(2_000))], 50);
  const controller = new AbortController();
  const running = runAgent(config(value.data), store, task, { model, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);

  const result = await running;
  assert.equal(result.outcome, "aborted");
  assert.equal(task.state, "aborted");
});

void test("达到模型回合上限后不再调用供应商或工具", async (context) => {
  const value = await repoFixture(context);
  const store = new TaskStore(value.data);
  const task = await store.create({ mode: "diagnose", objective: "验证回合上限", repoRoot: value.repo, baseHead: value.head });
  await store.transition(task, "diagnosing");
  task.usage.turns = 20;
  await store.save(task);
  let called = false;
  const model = fauxRuntime([() => {
    called = true;
    return fauxAssistantMessage(fauxToolCall("inspect", { action: "status" }), { stopReason: "toolUse" });
  }]);

  const result = await runAgent(config(value.data), store, task, { model });
  assert.equal(result.outcome, "blocked");
  assert.equal(task.state, "blocked");
  assert.equal(called, false);
  assert.equal(task.usage.toolCalls, 0);
});
