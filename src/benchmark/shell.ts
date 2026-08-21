/**
 * 不调用模型的 Shell 响应基准。
 *
 * 本场景使用真实 HTTP/SSE Shell 和受控 Pi 事件，测量用户提交后的第一条本地反馈，
 * 并验证 thinking 不泄漏、length 空答复可见、agent_settled 后解锁及 token 字段映射。
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { startShellServer } from "../shell/server.js";
import { TaskStore } from "../task/store.js";
import { INITIAL_TASK_OBJECTIVE } from "../task/types.js";
import { metric, scenario, type BenchmarkScenario } from "./types.js";

interface ShellEvent {
  type?: string;
  state?: string;
  text?: string;
}

interface SseReader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  close(): Promise<void>;
  readUntil(predicate: (event: ShellEvent) => boolean, timeoutMs: number): Promise<{
    event: ShellEvent;
    raw: string;
  }>;
}

interface FooterLayoutSample {
  width: number;
  rowCount: number;
  verticalOverflow: number;
}

async function measureFooterLayouts(url: string): Promise<FooterLayoutSample[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#status-primary > *");
    const samples: FooterLayoutSample[] = [];
    for (const width of [1_280, 900, 640]) {
      await page.setViewportSize({ width, height: 720 });
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      samples.push(await page.evaluate((viewportWidth) => {
        const footer = document.querySelector("#status-bar");
        const rows = [...document.querySelectorAll<HTMLElement>("#status-bar > .status-row")];
        if (!(footer instanceof HTMLElement)) {
          return { width: viewportWidth, rowCount: 0, verticalOverflow: 1 };
        }
        const footerRect = footer.getBoundingClientRect();
        const rowTops = new Set(rows.map((row) => Math.round(row.getBoundingClientRect().top)));
        const verticalOverflow = rows.some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top < footerRect.top - 1
            || rect.bottom > footerRect.bottom + 1
            || row.scrollHeight > row.clientHeight + 1;
        }) || document.documentElement.scrollHeight > window.innerHeight + 1
          ? 1
          : 0;
        return {
          width: viewportWidth,
          rowCount: rowTops.size,
          verticalOverflow,
        };
      }, width));
    }
    return samples;
  } finally {
    await browser.close();
  }
}

async function openSse(url: string): Promise<SseReader> {
  const controller = new AbortController();
  const response = await fetch(url.replace("/?", "/events?"), {
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Shell benchmark 无法读取 SSE");
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
    readUntil: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let raw = "";
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("等待 Shell SSE 超时")),
              remaining,
            );
            timer.unref();
          }),
        ]);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/u);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          raw += frame + "\n\n";
          const line = frame.split(/\r?\n/u).find((entry) => entry.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as ShellEvent;
          if (predicate(event)) return { event, raw };
        }
      }
      throw new Error("Shell SSE 未出现目标事件");
    },
  };
}

/** 运行一次无模型、真实 HTTP/SSE 的 Shell 基准。 */
export async function runShellBenchmark(): Promise<BenchmarkScenario> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dungeon-maintainer-benchmark-"));
  const repositoryRoot = join(temporaryRoot, "repo");
  await mkdir(repositoryRoot, { recursive: true });
  const store = new TaskStore(join(temporaryRoot, "data"));
  const task = await store.create({
    id: "benchmark-shell",
    objective: INITIAL_TASK_OBJECTIVE,
    repoRoot: repositoryRoot,
    baseHead: "benchmark",
    worktreeRoot: repositoryRoot,
    piSessionDir: join(temporaryRoot, "pi"),
  });
  const shell = await startShellServer({
    task,
    model: "benchmark-model",
    contextWindow: 64_000,
    store,
    sendPiCommand: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    },
    onClose: () => Promise.resolve(),
  });
  let sse: SseReader | null = null;
  try {
    sse = await openSse(shell.url);
    const start = performance.now();
    const inputPromise = fetch(shell.url.replace("/?", "/api/input?"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "为什么没有进入第二层" }),
    });
    const firstFeedback = await sse.readUntil(
      (event) => event.type === "activity" && event.text?.includes("消息已收到") === true,
      2_000,
    );
    const firstFeedbackMs = performance.now() - start;
    const inputResponse = await inputPromise;
    const inputAckMs = performance.now() - start;

    shell.handlePiEvent({ type: "agent_start" });
    shell.updateTurnUsage({
      input: 9,
      output: 4_096,
      cacheRead: 39_936,
      cacheWrite: 0,
      totalTokens: 44_041,
    });
    shell.handlePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "BENCHMARK_PRIVATE_THINKING",
      },
    });
    shell.handlePiEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "BENCHMARK_PRIVATE_THINKING" }],
        stopReason: "length",
      },
    });
    shell.handlePiEvent({ type: "agent_end", willRetry: false });
    shell.handlePiEvent({ type: "agent_settled" });
    const terminal = await sse.readUntil(
      (event) => event.type === "activity" && event.state === "error",
      2_000,
    );

    shell.updateSessionStats({
      tokens: {
        input: 10_000,
        output: 1_234,
        cacheRead: 112_000,
        cacheWrite: 222,
        total: 123_456,
      },
      contextUsage: { tokens: 40_012 },
    });
    const stateResponse = await fetch(shell.url.replace("/?", "/api/state?"));
    const state = await stateResponse.json() as {
      status: {
        cacheReadTokens: number;
        sessionCacheReadTokens: number;
        totalTokens: number;
        contextUsed: number;
      };
    };
    const unlockedResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "settled 后继续" }),
    });
    shell.handlePiEvent({ type: "agent_settled" });
    const footerLayouts = await measureFooterLayouts(shell.url);

    const terminalText = terminal.event.text ?? "";
    const thinkingLeakCount = (firstFeedback.raw + terminal.raw).includes(
      "BENCHMARK_PRIVATE_THINKING",
    ) ? 1 : 0;
    const statsAccurate = state.status.cacheReadTokens === 39_936
      && state.status.sessionCacheReadTokens === 112_000
      && state.status.totalTokens === 123_456
      && state.status.contextUsed === 40_012;
    return scenario("shell-feedback-and-usage", "deterministic", [
      metric({
        name: "first_feedback_ms",
        value: Math.round(firstFeedbackMs * 100) / 100,
        unit: "ms",
        direction: "lte",
        threshold: 250,
      }),
      metric({
        name: "input_ack_ms",
        value: Math.round(inputAckMs * 100) / 100,
        unit: "ms",
        direction: "lte",
        threshold: 1_000,
      }),
      metric({
        name: "input_accepted",
        value: inputResponse.ok,
        unit: "boolean",
        direction: "eq",
        threshold: true,
      }),
      metric({
        name: "thinking_leak_count",
        value: thinkingLeakCount,
        unit: "count",
        direction: "eq",
        threshold: 0,
      }),
      metric({
        name: "length_error_visible",
        value: terminalText.includes("未生成可见答复"),
        unit: "boolean",
        direction: "eq",
        threshold: true,
      }),
      metric({
        name: "settled_unlocks_input",
        value: unlockedResponse.ok,
        unit: "boolean",
        direction: "eq",
        threshold: true,
      }),
      metric({
        name: "usage_mapping_accurate",
        value: statsAccurate,
        unit: "boolean",
        direction: "eq",
        threshold: true,
      }),
      ...footerLayouts.flatMap((layout) => [
        metric({
          name: "footer_" + String(layout.width) + "_row_count",
          value: layout.rowCount,
          unit: "count",
          direction: "eq",
          threshold: 2,
        }),
        metric({
          name: "footer_" + String(layout.width) + "_vertical_overflow",
          value: layout.verticalOverflow,
          unit: "count",
          direction: "eq",
          threshold: 0,
        }),
      ]),
    ]);
  } finally {
    await sse?.close();
    await shell.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
