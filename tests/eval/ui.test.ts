import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startEvalProgressPage } from "../../src/eval/ui/server.js";

describe("Eval 常驻进度页", () => {
  it("一个本地页面通过 SSE 展示并行进度且不暴露工具参数", async () => {
    const progress = await startEvalProgressPage(false);
    try {
      const html = await (await fetch(progress.url)).text();
      assert.match(html, /SQL Dungeon Eval/u);
      assert.match(html, /new EventSource\('\/events'\)/u);
      assert.match(html, /故障预检/u);
      assert.match(html, /Oracle 判卷/u);
      assert.match(html, /function ensureWorkers/u);
      assert.doesNotMatch(html, /gradient|const workerCount=/u);
      assert.doesNotMatch(html, /prompt|secretInputs|inputSql/iu);

      progress.publish({
        phase: "run",
        scenarioId: "stale-query-plan-evidence",
        profile: "maintainer",
        repetition: 1,
        completed: 3,
        total: 7,
        status: "running",
        cumulativeTokens: 1200,
        cumulativeToolCalls: 8,
        startedAt: new Date(0).toISOString(),
        workerId: 1,
        workerCount: 1,
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
