/** CLI 测试覆盖唯一入口和核心补丁从隔离、审批到应用、回滚的真实生命周期。 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall,
} from "@earendil-works/pi-ai";
import { runCommand, type CliDeps } from "../src/cli.js";
import { loadConfig } from "../src/runtime/config.js";
import type { RuntimeModel } from "../src/runtime/model.js";
import { TaskStore } from "../src/runtime/task.js";
import { hashFile } from "../src/safety/worktree.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, encoding: "utf8", windowsHide: true })).stdout.trim();
}

async function readText(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
}

async function fixture(context: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "maintainer-cli-"));
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
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  context.after(async () => rm(parent, { recursive: true, force: true }));
  return { repo, data };
}

function fauxRuntime(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
): RuntimeModel {
  const faux = fauxProvider({ models: [{ id: "maintainer-cli", input: ["text"], contextWindow: 64_000 }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { model: faux.getModel(), stream: models.streamSimple.bind(models) };
}

void test("直接执行编译脚本会进入 CLI 并输出帮助", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = await exec(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.match(result.stdout, /Dungeon Maintainer V1/u);
  assert.match(result.stdout, /dungeon-maintain play/u);
});

void test("CLI 核心修复在显式 apply 前不改变目标并支持安全回滚", async (context) => {
  const value = await fixture(context);
  const path = "game/src/domain/rule.ts";
  const baseHash = await hashFile(value.repo, path);
  const lines: string[] = [];
  const pausedModel = fauxRuntime([
    fauxAssistantMessage(fauxToolCall("patch", {
      edits: [{ path, baseHash, oldText: "export const hp = 2;", newText: "export const hp = 3;" }],
    }), { stopReason: "toolUse" }),
  ]);
  const deps: CliDeps = {
    config: { ...loadConfig({ MAINTAINER_API_KEY: "not-used-by-faux" }), dataDir: value.data },
    model: pausedModel,
    write: (line) => lines.push(line),
  };
  const signal = new AbortController().signal;

  assert.equal(await runCommand(["fix", "--repo", value.repo, "修复核心生命规则"], deps, signal), 0);
  const approval = lines.join("\n").match(/approve ([0-9a-f-]{36}) ([0-9a-f]{12})/u);
  assert.ok(approval);
  const taskId = approval[1];
  const token = approval[2];
  assert.ok(taskId && token);
  assert.equal(await readText(join(value.repo, path)), "export const hp = 2;\n");

  const store = new TaskStore(value.data);
  const pausedTask = await store.read(taskId);
  assert.ok(pausedTask.worktreeRoot);
  const worktreeHash = await hashFile(pausedTask.worktreeRoot, path);
  const resumedModel = fauxRuntime([
    fauxAssistantMessage(fauxToolCall("inspect", { action: "read", path, startLine: 1 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("patch", {
      edits: [{ path, baseHash: worktreeHash, oldText: "export const hp = 2;", newText: "export const hp = 3;" }],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("check", { id: "rules-test" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finish", {
      status: "ready", summary: "核心生命规则已修复。", risk: "单文件核心改动。", checks: ["rules-test"],
    }), { stopReason: "toolUse" }),
  ]);
  deps.model = resumedModel;
  const approveCode = await runCommand(["approve", taskId, token], deps, signal);
  assert.equal(approveCode, 0, lines.join("\n"));
  assert.equal((await store.read(taskId)).state, "ready_to_apply");
  assert.equal(await readText(join(value.repo, path)), "export const hp = 2;\n");

  assert.equal(await runCommand(["apply", taskId], deps, signal), 0);
  assert.equal(await readText(join(value.repo, path)), "export const hp = 3;\n");
  assert.equal((await store.read(taskId)).state, "applied");

  assert.equal(await runCommand(["revert", taskId], deps, signal), 0);
  assert.equal(await readText(join(value.repo, path)), "export const hp = 2;\n");
  assert.equal((await store.read(taskId)).state, "reverted");
  assert.equal(await git(value.repo, ["status", "--porcelain=v1"]), "");
});

void test("Dashboard 核心批准只更新任务并提示返回原页面", async (context) => {
  const value = await fixture(context);
  const lines: string[] = [];
  const store = new TaskStore(value.data);
  const head = await git(value.repo, ["rev-parse", "HEAD"]);
  const task = await store.create({
    mode: "fix",
    source: "dashboard",
    objective: "修复展示层状态",
    repoRoot: value.repo,
    baseHead: head,
  });
  await store.transition(task, "diagnosing");
  const token = await store.requestApproval(task, ["game/src/domain/rule.ts"]);
  const deps: CliDeps = {
    config: { ...loadConfig({ MAINTAINER_API_KEY: "not-used" }), dataDir: value.data },
    write: (line) => lines.push(line),
  };

  assert.equal(await runCommand(
    ["approve", task.id, token],
    deps,
    new AbortController().signal,
  ), 0);
  assert.equal((await store.read(task.id)).state, "approved");
  assert.match(lines.join("\n"), /返回 Dashboard，点击“继续修复”/u);
});
