/** 上下文测试验证压缩触发点、保留事实和最近消息边界。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactContext } from "../src/runtime/context.js";
import type { TaskRecord } from "../src/runtime/task.js";

function task(): TaskRecord {
  return {
    schemaVersion: 1,
    id: "context-task",
    mode: "fix",
    source: "cli",
    objective: "修复第一层路线阻断",
    repoRoot: "C:\\repo",
    baseHead: "a".repeat(40),
    worktreeRoot: "C:\\worktree",
    state: "verifying",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    plan: ["修改核心路线文件"],
    approval: {
      paths: ["game/src/domain/route.ts"],
      digest: "digest",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      approvedAt: new Date().toISOString(),
      usedAt: new Date().toISOString(),
    },
    changedPaths: ["game/src/domain/route.ts"],
    patchLines: 4,
    baseHashes: {},
    checks: [{
      id: "game-test", hash: "hash", status: "failed", ms: 10,
      logPath: "C:\\checks\\game-test.log", savedAt: new Date().toISOString(),
    }],
    plays: [],
    patchPath: null,
    reversePatchPath: null,
    appliedHashes: {},
    usage: { turns: 1, toolCalls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    conclusion: null,
    diagnosis: null,
  };
}

void test("上下文达到阈值后保留任务、批准、改动和失败检查", () => {
  const messages: AgentMessage[] = Array.from({ length: 16 }, (_, index) => ({
    role: "user" as const,
    content: `旧消息-${String(index)}-${"x".repeat(3_000)}`,
    timestamp: index,
  }));

  const compacted = compactContext(messages, task(), 8_000);
  assert.ok(compacted.length < messages.length);
  const fact = compacted[0];
  assert.ok(fact);
  assert.equal(fact.role, "user");
  const content = typeof fact.content === "string" ? fact.content : "";
  assert.match(content, /修复第一层路线阻断/u);
  assert.match(content, /game\/src\/domain\/route\.ts/u);
  assert.match(content, /game-test:failed/u);
  assert.equal(compacted.at(-1), messages.at(-1));
});
