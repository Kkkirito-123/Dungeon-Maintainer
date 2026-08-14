/** 任务测试覆盖固定状态图和绑定 Git 基线的单次批准。 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskStore } from "../src/runtime/task.js";

void test("非法状态迁移被拒绝", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "maintainer-task-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  const task = await store.create({
    mode: "fix",
    objective: "修复显示问题",
    repoRoot: "C:\\repo",
    baseHead: "a".repeat(40),
  });
  await assert.rejects(store.transition(task, "ready_to_apply"), /非法任务状态迁移/);
});

void test("核心批准绑定任务、基线和精确文件且只能使用一次", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "maintainer-approval-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  const task = await store.create({
    mode: "fix",
    objective: "修复领域规则",
    repoRoot: "C:\\repo",
    baseHead: "b".repeat(40),
  });
  await store.transition(task, "diagnosing");
  const token = await store.requestApproval(task, ["game/src/domain/rule.ts"]);
  assert.equal(task.state, "needs_approval");
  await assert.rejects(store.approve(task, "wrong-token"), /不匹配/);
  await store.approve(task, token);
  assert.equal(task.state, "approved");
  await assert.rejects(store.approve(task, token), /不等待批准/);
  assert.deepEqual(task.approval?.paths, ["game/src/domain/rule.ts"]);
});

void test("过期的核心批准 token 被拒绝", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "maintainer-expired-approval-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  const task = await store.create({
    mode: "fix",
    objective: "验证过期批准",
    repoRoot: "C:\\repo",
    baseHead: "c".repeat(40),
  });
  await store.transition(task, "diagnosing");
  const token = await store.requestApproval(task, ["game/src/domain/rule.ts"]);
  if (!task.approval) throw new Error("测试审批未创建");
  task.approval.expiresAt = new Date(0).toISOString();

  await assert.rejects(store.approve(task, token), /已过期/u);
  assert.equal(task.state, "needs_approval");
});
