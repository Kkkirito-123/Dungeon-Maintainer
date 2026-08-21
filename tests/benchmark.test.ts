import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseBenchmarkArgs } from "../src/benchmark/main.js";
import { runShellBenchmark } from "../src/benchmark/shell.js";
import { analyzeTaskBenchmark } from "../src/benchmark/task.js";
import { metric } from "../src/benchmark/types.js";
import { shapeModelContext } from "../src/pi/context-shaping.js";

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
