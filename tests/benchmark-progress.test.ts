import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startBenchmarkProgressPage } from "../src/benchmark/progress.js";

describe("Benchmark 常驻进度页", () => {
  it("一个本地页面通过 SSE 展示六个工位且不暴露工具参数", async () => {
    const progress = await startBenchmarkProgressPage(false);
    try {
      const html = await (await fetch(progress.url)).text();
      assert.match(html, /SQL Dungeon 修复评测/u);
      assert.match(html, /new EventSource\('\/events'\)/u);
      assert.match(html, /Live benchmark · 6 workers/u);
      assert.match(html, /LLM 可见回复（仅内存）/u);
      assert.doesNotMatch(html, /prompt|secretInputs|inputSql/iu);

      progress.publish({
        phase: "run",
        fixtureId: "stale-query-plan-evidence",
        profile: "maintainer-current",
        repetition: 1,
        completed: 3,
        total: 7,
        status: "running",
        cumulativeTokens: 1200,
        cumulativeToolCalls: 8,
        startedAt: new Date(0).toISOString(),
        workerId: 3,
        workerCount: 6,
        liveKind: "assistant",
        toolName: "inspect",
        assistantText: "正在核对最终状态",
      });
      const response = await fetch(new URL("/events", progress.url), {
        signal: AbortSignal.timeout(2_000),
      });
      assert.ok(response.body);
      const reader = response.body.getReader();
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      assert.match(text, /stale-query-plan-evidence/u);
      assert.match(text, /"cumulativeTokens":1200/u);
      assert.match(text, /正在核对最终状态/u);
      await Promise.race([
        progress.close(),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("存在 SSE 客户端时进度页关闭超时")),
          1_000,
        )),
      ]);
      assert.equal((await reader.read()).done, true);
    } finally {
      await progress.close();
    }
  });
});
