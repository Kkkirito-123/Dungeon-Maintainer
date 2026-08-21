import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendEvent } from "../src/logging/events.js";
import {
  containsPrivateText,
  redactText,
} from "../src/logging/redact.js";
import { SemanticTrace } from "../src/logging/trace.js";
import {
  readActiveReproduction,
  saveReproduction,
} from "../src/repair/reproduction.js";
import { TaskStore } from "../src/task/store.js";
import { createTemporaryGitRepository } from "./testSupport.js";

describe("schema v3 任务状态、迁移与审批", () => {
  it("原子持久化任务、拒绝非法迁移并只消费一次精确审批", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      const task = await store.create({
        id: "task-state",
        objective: "修复问题 api_key=abcdefghijklmnop",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: join(repository.temporaryRoot, "worktree"),
        piSessionDir: join(repository.temporaryRoot, "data", "tasks", "task-state", "pi"),
      });

      assert.equal(task.schemaVersion, 3);
      assert.equal(task.modelProfileId, "default");
      assert.equal(task.thinkingLevel, "off");
      assert.equal(task.writeScope.state, "unapproved");
      assert.ok(!task.objective.includes("abcdefghijklmnop"));
      await store.transition(task, "active");
      await assert.rejects(store.transition(task, "applied"), /非法任务状态迁移/u);

      await store.requestApproval(task, ["game/src/domain/demo.ts"], "digest-1");
      assert.equal(task.state, "awaiting_approval");
      await store.resolveApproval(task, true);
      await store.consumeApproval(task, "digest-1");
      assert.ok(task.approval?.usedAt);
      await assert.rejects(
        store.consumeApproval(task, "digest-1"),
        /不匹配/u,
      );
      assert.equal((await store.read(task.id)).state, "active");
    } finally {
      await repository.dispose();
    }
  });

  it("schema v2 自动迁移并要求重新确认修改范围", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      const task = await store.create({
        id: "legacy-v2-task",
        objective: "恢复旧任务",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: join(repository.temporaryRoot, "worktree"),
        piSessionDir: join(repository.temporaryRoot, "data", "tasks", "legacy-v2-task", "pi"),
      });
      const taskPath = join(store.taskDir(task.id), "task.json");
      const legacy = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
      legacy.schemaVersion = 2;
      delete legacy.modelProfileId;
      delete legacy.thinkingLevel;
      delete legacy.writeScope;
      await writeFile(taskPath, JSON.stringify(legacy, null, 2) + "\n", "utf8");

      const migrated = await store.read(task.id);

      assert.equal(migrated.schemaVersion, 3);
      assert.equal(migrated.modelProfileId, "default");
      assert.equal(migrated.thinkingLevel, "off");
      assert.deepEqual(migrated.writeScope, {
        state: "unapproved",
        allowedPaths: [],
        digest: null,
        approvedAt: null,
        closedAt: null,
      });
      assert.match(
        await readFile(join(store.taskDir(task.id), "events.jsonl"), "utf8"),
        /task\.migrated/u,
      );
    } finally {
      await repository.dispose();
    }
  });

  it("旧 schema v1 明确拒绝恢复", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      const directory = store.taskDir("legacy-task");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "task.json"),
        JSON.stringify({ schemaVersion: 1, id: "legacy-task", state: "active" }),
        "utf8",
      );
      await assert.rejects(store.read("legacy-task"), /旧 schema v1/u);
    } finally {
      await repository.dispose();
    }
  });
});

describe("低敏日志与可重放语义 Trace", () => {
  it("凭据、SQL 和完整游戏状态字段不会写入事件日志", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      await store.create({
        id: "task-events",
        objective: "测试事件脱敏",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: join(repository.temporaryRoot, "worktree"),
        piSessionDir: join(repository.temporaryRoot, "data", "tasks", "task-events", "pi"),
      });
      await appendEvent(store, "task-events", "test.private", {
        credential: "Bearer abcdefghijklmnopqrstuvwxyz",
        query: "SELECT * FROM monsters;",
        state: "mazeFloor contains hidden cells",
      });
      const log = await readFile(
        join(store.taskDir("task-events"), "events.jsonl"),
        "utf8",
      );

      assert.ok(!log.includes("abcdefghijklmnopqrstuvwxyz"));
      assert.ok(!log.includes("SELECT *"));
      assert.ok(!log.includes("hidden cells"));
      assert.match(log, /REDACTED/u);
    } finally {
      await repository.dispose();
    }
  });

  it("Trace 保持单调序号、固定容量且复现只保存高层动作", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      const task = await store.create({
        id: "task-reproduction",
        objective: "保存复现",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: join(repository.temporaryRoot, "worktree"),
        piSessionDir: join(repository.temporaryRoot, "data", "tasks", "task-reproduction", "pi"),
      });
      const trace = new SemanticTrace(2);
      trace.push({ action: "look", arguments: {}, ok: true, summary: "floor 1" });
      trace.push({
        action: "query",
        arguments: {},
        ok: true,
        summary: "SELECT * FROM monsters;",
      });
      trace.push({
        action: "go",
        arguments: { target: "objective", maxSteps: 4 },
        ok: true,
        summary: "mode changed",
      });
      assert.deepEqual(trace.snapshot().map((entry) => entry.sequence), [2, 3]);
      assert.ok(!trace.snapshot()[0]?.summary.includes("SELECT"));

      const reproduction = await saveReproduction(store, task, trace, {
        title: "首层移动后异常",
        expected: "进入战斗",
        actual: "api_key=abcdefghijklmnop",
        evidence: ["右侧页面状态"],
        assertions: {
          floor: 2,
          mode: "explore",
          minLessons: 5,
          advancedFromFloor: 1,
          bossDefeated: true,
        },
      });
      assert.equal(reproduction.actions.length, 2);
      assert.ok(!reproduction.actual.includes("abcdefghijklmnop"));
      assert.deepEqual(
        (await readActiveReproduction(store, task))?.assertions,
        reproduction.assertions,
      );

      const index = task.reproductions[0];
      assert.ok(index);
      const currentRecord = await readFile(index.path, "utf8");
      await writeFile(
        index.path,
        currentRecord.replace('"schemaVersion": 2', '"schemaVersion": 1'),
        "utf8",
      );
      await assert.rejects(
        readActiveReproduction(store, task),
        /旧 schema v1 复现缺少结构化断言/u,
      );
      await writeFile(index.path, currentRecord, "utf8");
      index.path = join(repository.temporaryRoot, "outside.json");
      await assert.rejects(
        readActiveReproduction(store, task),
        /脱离当前任务目录/u,
      );
    } finally {
      await repository.dispose();
    }
  });

  it("补丁隐私检测与日志脱敏采用拒绝和改写两种不同策略", () => {
    assert.equal(containsPrivateText("SELECT id FROM monsters"), true);
    assert.equal(containsPrivateText("const value = 1;"), false);
    assert.ok(!redactText("token=abcdefghijklmnop").includes("abcdefghijklmnop"));
    assert.equal(redactText("SELECT id FROM monsters"), "[SQL REDACTED]");
    assert.equal(
      redactText("进入 SELECT 战斗后终端不出现，请直接定位并修复。"),
      "进入 SELECT 战斗后终端不出现，请直接定位并修复。",
    );
  });
});
