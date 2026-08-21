import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  parseAgentEvalPreflightArgs,
  parseBenchmarkArgs,
  parseGameRepairEvalArgs,
} from "../src/benchmark/main.js";
import { buildPiOriginalArguments } from "../src/benchmark/pi-original.js";
import { runShellBenchmark } from "../src/benchmark/shell.js";
import { analyzeTaskBenchmark } from "../src/benchmark/task.js";
import { metric, type BenchmarkScenario } from "../src/benchmark/types.js";
import { shapeModelContext } from "../src/pi/context-shaping.js";

function metricValue(
  result: BenchmarkScenario,
  name: string,
): number | boolean | undefined {
  return result.metrics.find((entry) => entry.name === name)?.value;
}

describe("Dungeon Maintainer Benchmark", () => {
  it("按方向判定机器指标并解析固定参数", () => {
    assert.equal(metric({
      name: "latency",
      value: 20,
      unit: "ms",
      direction: "lte",
      threshold: 250,
    }).passed, true);
    assert.deepEqual(parseBenchmarkArgs([
      "--repo", ".",
      "--context-window", "64000",
    ]), {
      repo: process.cwd(),
      taskDirectory: null,
      contextWindow: 64_000,
      outputPath: null,
    });
    assert.throws(
      () => parseBenchmarkArgs(["--context-window", "100"]),
      /不小于 8000/u,
    );
    assert.deepEqual(parseAgentEvalPreflightArgs([
      "--fixture", "terminal-action-bug",
      "--dependency-repo", ".",
      "--timeout-ms", "60000",
    ]), {
      fixtureId: "terminal-action-bug",
      fixtureRoot: null,
      dependencyRepoRoot: process.cwd(),
      archiveRoot: resolve(process.cwd(), "benchmark-results", "preflight"),
      timeoutMs: 60_000,
    });
    assert.throws(
      () => parseAgentEvalPreflightArgs(["--fixture", "../escape"]),
      /安全的案例 ID|缺少/u,
    );
    assert.deepEqual(parseGameRepairEvalArgs([
      "--profile", "pi-original",
      "--fixture", "terminal-action-bug",
      "--dependency-repo", ".",
      "--repetition", "2",
    ]), {
      fixtureId: "terminal-action-bug",
      fixtureRoot: null,
      dependencyRepoRoot: process.cwd(),
      archiveRoot: resolve(process.cwd(), "benchmark-results", "game-repair"),
      timeoutMs: null,
      profile: "pi-original",
      repetition: 2,
    });
    assert.throws(
      () => parseGameRepairEvalArgs([
        "--profile", "unknown",
        "--fixture", "terminal-action-bug",
        "--dependency-repo", ".",
      ]),
      /未知 game-repair Profile/u,
    );
    const originalArguments = buildPiOriginalArguments({
      runId: "benchmark-run",
      sessionDirectory: resolve("benchmark-session"),
      model: "benchmark-model",
    });
    assert.deepEqual(
      originalArguments.slice(originalArguments.indexOf("--tools"), originalArguments.indexOf("--tools") + 2),
      ["--tools", "read,bash,edit,write"],
    );
    assert.equal(originalArguments.includes("--no-context-files"), false);
    assert.equal(originalArguments.includes("--no-skills"), false);
    assert.equal(originalArguments.includes("../src/pi/extension.js"), false);
  });

  it("真实 HTTP/SSE 确定性场景满足即时反馈和空答复门槛", async () => {
    const result = await runShellBenchmark();
    assert.equal(result.passed, true);
    assert.equal(
      result.metrics.find((entry) => entry.name === "thinking_leak_count")?.value,
      0,
    );
    assert.equal(
      result.metrics.find((entry) => entry.name === "length_error_visible")?.value,
      true,
    );
    for (const width of [1_280, 900, 640]) {
      assert.equal(
        result.metrics.find((entry) => entry.name === "footer_" + String(width) + "_row_count")?.value,
        2,
      );
      assert.equal(
        result.metrics.find((entry) => entry.name === "footer_" + String(width) + "_vertical_overflow")?.value,
        0,
      );
    }
  });

  it("只用会话元数据生成 token 与自主闭环报告", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-benchmark-task-"));
    try {
      await mkdir(join(root, "pi"), { recursive: true });
      await writeFile(join(root, "task.json"), JSON.stringify({
        changedPaths: ["game/src/example.ts"],
        checks: [{ status: "passed" }],
        reproductions: [{ id: "reproduction" }],
        conclusion: "已完成",
        state: "ready_to_apply",
      }), "utf8");
      await writeFile(join(root, "events.jsonl"), [
        JSON.stringify({
          type: "task.state",
          detail: { next: "awaiting_approval" },
        }),
        JSON.stringify({
          type: "game.refresh",
          detail: { passed: true },
        }),
      ].join("\n") + "\n", "utf8");
      await writeFile(join(root, "pi", "session.jsonl"), [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: 1_000,
            content: [{ type: "text", text: "修复问题" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 2_000,
            stopReason: "toolUse",
            usage: { input: 200, output: 100, cacheRead: 3_000, cacheWrite: 0 },
            content: [{
              type: "toolCall",
              id: "call-1",
              name: "inspect",
              arguments: { action: "search" },
            }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            timestamp: 2_100,
            toolName: "finish",
            content: [{ type: "text", text: "结构化测试结果" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 3_000,
            stopReason: "stop",
            usage: { input: 100, output: 200, cacheRead: 3_000, cacheWrite: 0 },
            content: [{ type: "text", text: "完成" }],
          },
        }),
      ].join("\n") + "\n", "utf8");

      const result = await analyzeTaskBenchmark(root, 64_000);
      assert.equal(result.passed, true);
      assert.equal(
        result.metrics.find((entry) => entry.name === "cache_hit_ratio")?.passed,
        true,
      );
      assert.equal(
        result.metrics.find((entry) => entry.name === "autonomous_closure_recorded")?.value,
        true,
      );
      assert.ok(result.notes.every((note) => !note.includes("修复问题")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("内置 smoke fixture 能识别 result 后旧续跑和重复方案提交", async () => {
    const fixture = resolve(
      process.cwd(),
      "test-fixtures",
      "smoke-tasks",
      "stale-follow-up-after-result",
    );
    const result = await analyzeTaskBenchmark(fixture, 64_000);

    assert.equal(result.passed, false);
    assert.equal(metricValue(result, "automatic_continuations_created"), 1);
    assert.equal(metricValue(result, "automatic_continuations_admitted"), 1);
    assert.equal(metricValue(result, "post_terminal_model_turns"), 1);
    assert.equal(metricValue(result, "post_terminal_tool_calls"), 1);
    assert.equal(metricValue(result, "tokens_after_terminal"), 10_208);
    assert.equal(metricValue(result, "duplicate_finish_submissions"), 1);
    assert.equal(metricValue(result, "semantic_duplicate_results"), 0);
    assert.equal(metricValue(result, "inspect_attempts_to_proposal"), 1);
    assert.equal(metricValue(result, "diagnosis_ms"), 2_000);
  });

  it("continuation 事件按 ID 去重并识别重复语义结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-benchmark-continuation-"));
    try {
      await mkdir(join(root, "pi"), { recursive: true });
      await writeFile(join(root, "task.json"), JSON.stringify({
        changedPaths: [],
        checks: [],
        reproductions: [],
        conclusion: "合成审计任务",
        state: "active",
      }), "utf8");
      await writeFile(join(root, "events.jsonl"), [
        JSON.stringify({
          at: "1970-01-01T00:00:01.500Z",
          type: "continuation.queued",
          detail: { continuationId: "continuation-1" },
        }),
        JSON.stringify({
          at: "1970-01-01T00:00:01.600Z",
          type: "continuation.admitted",
          detail: { continuationId: "continuation-1" },
        }),
        JSON.stringify({
          at: "1970-01-01T00:00:02.800Z",
          type: "continuation.stale",
          detail: { continuationId: "continuation-1" },
        }),
      ].join("\n") + "\n", "utf8");
      await writeFile(join(root, "pi", "session.jsonl"), [
        JSON.stringify({
          type: "message",
          id: "user-1",
          timestamp: 1_000,
          message: {
            role: "user",
            content: [{ type: "text", text: "继续修复" }],
          },
        }),
        JSON.stringify({
          type: "custom_message",
          id: "custom-1",
          parentId: "user-1",
          timestamp: 1_700,
          customType: "dungeon-repair-follow-up",
          content: "不应进入 Benchmark 报告的续跑正文",
          details: {
            continuationId: "continuation-1",
            kind: "repair",
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "custom-1",
          timestamp: 2_000,
          message: {
            role: "assistant",
            stopReason: "toolUse",
            usage: { input: 10, output: 10, cacheRead: 100, cacheWrite: 0 },
            content: [
              {
                type: "toolCall",
                id: "inspect-1",
                name: "inspect",
                arguments: { action: "read" },
              },
              {
                type: "toolCall",
                id: "inspect-2",
                name: "inspect",
                arguments: { action: "read" },
              },
              {
                type: "toolCall",
                id: "finish-proposed-1",
                name: "finish",
                arguments: { status: "proposed" },
              },
              {
                type: "toolCall",
                id: "finish-proposed-2",
                name: "finish",
                arguments: { status: "proposed" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "inspect-result-1",
          parentId: "assistant-1",
          timestamp: 2_100,
          message: {
            role: "toolResult",
            toolName: "inspect",
            details: { evidenceId: "same-evidence" },
            content: [],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "inspect-result-2",
          parentId: "inspect-result-1",
          timestamp: 2_300,
          message: {
            role: "toolResult",
            toolName: "inspect",
            details: { evidenceId: "same-evidence" },
            content: [],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "proposed-result-1",
          parentId: "inspect-result-2",
          timestamp: 2_500,
          message: {
            role: "toolResult",
            toolName: "finish",
            details: { status: "proposed" },
            content: [{ type: "text", text: "第一次方案结果" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "proposed-result-2",
          parentId: "proposed-result-1",
          timestamp: 2_700,
          message: {
            role: "toolResult",
            toolName: "finish",
            details: { status: "proposed" },
            content: [{ type: "text", text: "第二次方案结果" }],
          },
        }),
      ].join("\n") + "\n", "utf8");

      const result = await analyzeTaskBenchmark(root, 64_000);
      assert.equal(metricValue(result, "automatic_continuations_created"), 1);
      assert.equal(metricValue(result, "automatic_continuations_admitted"), 1);
      assert.equal(metricValue(result, "stale_continuations_dropped"), 1);
      assert.equal(metricValue(result, "duplicate_finish_submissions"), 1);
      assert.equal(metricValue(result, "semantic_duplicate_results"), 2);
      assert.equal(metricValue(result, "inspect_attempts_to_proposal"), 2);
      assert.equal(metricValue(result, "diagnosis_ms"), 1_000);
      assert.ok(result.notes.every((note) => !note.includes("续跑正文")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("长旧工具结果之后仍保留最新游戏和源码证据", () => {
    const oldResult = "旧诊断正文".repeat(4_000);
    const messages = [
      { role: "user", content: [{ type: "text", text: "修复默认题答案" }] },
      {
        role: "toolResult",
        toolCallId: "old",
        toolName: "inspect",
        content: [{ type: "text", text: oldResult }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "latest-look",
        toolName: "look",
        content: [{ type: "text", text: "当前楼层=2；题面状态=错误；最新游戏证据" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "latest-source",
        toolName: "inspect",
        content: [{ type: "text", text: "答案定义源码：expectedSql；最新源码证据" }],
        isError: false,
      },
    ];
    const result = shapeModelContext(messages, {
      perTurnCharacters: 24_576,
      perResultCharacters: 4_096,
    });
    const texts = result.messages.map((message) => {
      if (message.role !== "toolResult" || !Array.isArray(message.content)) {
        return "";
      }
      return message.content
        .map((block) => block.type === "text" ? block.text : "")
        .join("");
    });
    assert.ok(texts.some((text) => text.includes("最新游戏证据")));
    assert.ok(texts.some((text) => text.includes("最新源码证据")));
    assert.ok(result.stats.omittedResults > 0 || result.stats.truncatedResults > 0);
  });
});
