/** 路径策略测试覆盖分类、父目录跳转和符号链接逃逸。 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TaskRecord } from "../src/runtime/task.js";
import {
  classifyPath,
  decidePatch,
  normalizeProjectPath,
  resolveProjectPath,
} from "../src/safety/policy.js";

function task(): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    mode: "fix",
    objective: "test",
    repoRoot: "C:\\repo",
    baseHead: "a".repeat(40),
    worktreeRoot: null,
    state: "editing",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    plan: [],
    approval: null,
    changedPaths: [],
    patchLines: 0,
    baseHashes: {},
    checks: [],
    plays: [],
    patchPath: null,
    reversePatchPath: null,
    appliedHashes: {},
    usage: { turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    conclusion: null,
  };
}

void test("路径分为自动、核心与永久禁止", () => {
  assert.equal(classifyPath("game/tests/view.test.ts", "write"), "auto");
  assert.equal(classifyPath("game/src/presentation/panel.ts", "write"), "auto");
  assert.equal(classifyPath("game/src/domain/rule.ts", "write"), "core");
  assert.equal(classifyPath("agent/.env", "read"), "denied");
  assert.equal(classifyPath("LICENSE", "write"), "denied");
  assert.throws(() => normalizeProjectPath("../secret"), /不得离开/);
});

void test("核心批准必须覆盖精确路径", () => {
  const value = task();
  assert.equal(decidePatch(value, ["game/src/domain/rule.ts"]).kind, "approval");
  value.approval = {
    paths: ["game/src/domain/rule.ts"],
    digest: "digest",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedAt: new Date().toISOString(),
    usedAt: new Date().toISOString(),
  };
  assert.equal(decidePatch(value, ["game/src/domain/rule.ts"]).kind, "allow");
  assert.equal(decidePatch(value, ["game/src/domain/other.ts"]).kind, "approval");
});

void test("真实路径解析阻止仓库内符号链接指向外部", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "maintainer-policy-root-"));
  const outside = await mkdtemp(join(tmpdir(), "maintainer-policy-outside-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(root, "game", "tests"), { recursive: true });
  await writeFile(join(outside, "outside.txt"), "outside", "utf8");
  await symlink(outside, join(root, "game", "tests", "escape"), "junction");
  await assert.rejects(
    resolveProjectPath(root, "game/tests/escape/outside.txt", "read"),
    /符号链接离开项目/,
  );
});
