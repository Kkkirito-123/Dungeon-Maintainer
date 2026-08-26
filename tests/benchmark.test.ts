import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  parseAgentEvalPreflightArgs,
  parseBenchmarkArgs,
  parseBenchmarkSuiteArgs,
  parseGameRepairEvalArgs,
  parseGameRepairMatrixArgs,
} from "../src/benchmark/main.js";
import {
  GAME_REPAIR_FIXTURE_IDS,
  gameRepairMatrixProfiles,
  summarizeGameRepairMatrixRuns,
} from "../src/benchmark/game-repair-matrix.js";
import { buildPiOriginalArguments } from "../src/benchmark/pi-original.js";
import {
  gameRepairExternalCorrectnessPassed,
  gameRepairFailureCode,
  gameRepairJudgeOutcome,
} from "../src/benchmark/agent-eval-runner.js";
import {
  benchmarkGameStartEnvironment,
  benchmarkSettledDecision,
  benchmarkShellEndpoint,
  buildMaintainerWorkflowClosure,
  isBenchmarkExecutionApproval,
  isBenchmarkUiRequest,
  readMaintainerTelemetry,
} from "../src/benchmark/pi-maintainer.js";
import {
  requestWithDeadline,
  SESSION_STATS_TIMEOUT_MS,
} from "../src/benchmark/rpc-timeout.js";
import { benchmarkModelFingerprint } from "../src/benchmark/provenance.js";
import { assertFlashBenchmarkModel } from "../src/benchmark/model-policy.js";
import { runShellBenchmark } from "../src/benchmark/shell.js";
import { analyzeTaskBenchmark } from "../src/benchmark/task.js";
import { metric, type BenchmarkScenario } from "../src/benchmark/types.js";
import { resolveGameRuntimeStart } from "../src/pi/game-runtime.js";
import { shapeModelContext } from "../src/pi/context-shaping.js";

function metricValue(
  result: BenchmarkScenario,
  name: string,
): number | boolean | undefined {
  return result.metrics.find((entry) => entry.name === name)?.value;
}

describe("Dungeon Maintainer Benchmark", () => {
  it("把模型启动前鉴权错误记录为稳定低敏原因码", () => {
    assert.equal(
      gameRepairFailureCode(new Error("BLOCKED_ENV: MAINTAINER_API_KEY 未配置")),
      "model-auth-unavailable",
    );
    assert.equal(
      gameRepairFailureCode(new Error("provider model registration failed")),
      "model-unavailable",
    );
    assert.equal(gameRepairFailureCode("opaque"), "unknown-error");
  });

  it("真实 mutation 与结束时保留变更分别记录", () => {
    const reverted = buildMaintainerWorkflowClosure({
      taskState: "active",
      proposed: true,
      writeAttempts: 2,
      writeMutations: 1,
      changedPathCount: 0,
      replayPassed: false,
      readyToApply: false,
      paused: false,
    });
    assert.equal(reverted.executed, true);
    assert.equal(reverted.retainedChanges, false);

    const retainedWithoutObservedMutation = buildMaintainerWorkflowClosure({
      taskState: "active",
      proposed: false,
      writeAttempts: 0,
      writeMutations: 0,
      changedPathCount: 1,
      replayPassed: false,
      readyToApply: false,
      paused: false,
    });
    assert.equal(retainedWithoutObservedMutation.executed, false);
    assert.equal(retainedWithoutObservedMutation.retainedChanges, true);
  });

  it("Inspect 与写入遥测逐行容错并满足分类闭合", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintainer-telemetry-v2-"));
    try {
      const path = join(root, "events.jsonl");
      await writeFile(path, [
        JSON.stringify({
          at: "2026-08-25T00:00:01.000Z",
          type: "tool.inspect",
          detail: {
            action: "bundle",
            outcome: "execution",
            bundleWindows: 3,
            expanded: false,
            floorRouteLevel: "current",
            floorScopeCount: 1,
          },
        }),
        ...(["adjacent", "shared", "fallback"] as const).map((floorRouteLevel, index) => (
          JSON.stringify({
            at: "2026-08-25T00:00:01." + String(index + 1).padStart(3, "0") + "Z",
            type: "tool.inspect",
            detail: {
              action: "search",
              outcome: "execution",
              bundleWindows: 0,
              expanded: true,
              floorRouteLevel,
              floorScopeCount: 3,
            },
          })
        )),
        "{broken",
        JSON.stringify({
          at: "2026-08-25T00:00:02.000Z",
          type: "tool.inspect",
          detail: { action: "bundle", outcome: "receipt", bundleWindows: 0, expanded: false },
        }),
        JSON.stringify({
          at: "2026-08-25T00:00:03.000Z",
          type: "tool.inspect",
          detail: { action: "read", outcome: "failure", bundleWindows: 0, expanded: false },
        }),
        JSON.stringify({
          at: "2026-08-25T00:00:04.000Z",
          type: "tool.write_outcome",
          detail: { toolName: "write", outcome: "rejected", reasonCode: "path-rejected" },
        }),
        JSON.stringify({
          at: "2026-08-25T00:00:05.000Z",
          type: "tool.write_outcome",
          detail: { toolName: "patch", outcome: "noop", reasonCode: "worktree-unchanged" },
        }),
        JSON.stringify({
          at: "2026-08-25T00:00:06.000Z",
          type: "tool.write_outcome",
          detail: { toolName: "patch", outcome: "mutated_replay_failed", reasonCode: "refresh-replay-failed" },
        }),
        JSON.stringify({
          at: "2026-08-25T00:00:07.000Z",
          type: "tool.loop_guard",
          detail: { toolName: "patch", outcome: "blocked", reasonCode: "block-exact_action_result" },
        }),
      ].join("\n") + "\n", "utf8");
      const telemetry = await readMaintainerTelemetry(path);
      assert.equal(telemetry.executions + telemetry.receiptHits + telemetry.inspectFailures, 6);
      assert.equal(telemetry.bundles, 1);
      assert.equal(telemetry.bundleWindows, 3);
      assert.equal(telemetry.floorRoutedInspectCalls, 4);
      assert.equal(telemetry.floorScopesVisited, 10);
      assert.equal(telemetry.floorRouteCurrentExecutions, 1);
      assert.equal(telemetry.floorRouteAdjacentExecutions, 1);
      assert.equal(telemetry.floorRouteSharedExecutions, 1);
      assert.equal(telemetry.floorRouteFallbackExecutions, 1);
      assert.equal(
        telemetry.floorRouteCurrentExecutions
          + telemetry.floorRouteAdjacentExecutions
          + telemetry.floorRouteSharedExecutions
          + telemetry.floorRouteFallbackExecutions,
        telemetry.floorRoutedInspectCalls,
      );
      assert.equal(
        telemetry.writeRejected
          + telemetry.writeFailures
          + telemetry.writeNoops
          + telemetry.writeMutations,
        3,
      );
      assert.equal(telemetry.writeReplayFailures, 1);
      assert.equal(telemetry.loopGuardBlocks, 1);
      assert.equal(telemetry.parseErrors, 1);
      assert.equal(telemetry.firstMutationAt, Date.parse("2026-08-25T00:00:06.000Z"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("真实修复评测拒绝误用 Pro，只接受 Flash modelId", () => {
    assert.doesNotThrow(() => assertFlashBenchmarkModel("deepseek-v4-flash"));
    assert.throws(() => assertFlashBenchmarkModel("deepseek-v4-pro"), /只允许 Flash/u);
  });

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
    assert.equal(parseGameRepairEvalArgs([
      "--profile", "maintainer-current",
      "--fixture", "terminal-action-bug",
      "--dependency-repo", ".",
    ])?.profile, "maintainer-current");
    assert.throws(
      () => parseGameRepairEvalArgs([
        "--profile", "unknown",
        "--fixture", "terminal-action-bug",
        "--dependency-repo", ".",
      ]),
      /未知 game-repair Profile/u,
    );
    assert.equal(parseGameRepairEvalArgs([
      "--profile", "maintainer-current",
      "--fixture", "terminal-action-bug",
      "--dependency-repo", ".",
      "--timeout-ms", "600000",
    ])?.timeoutMs, 600_000);
    assert.throws(
      () => parseGameRepairEvalArgs([
        "--profile", "maintainer-current",
        "--fixture", "terminal-action-bug",
        "--dependency-repo", ".",
        "--timeout-ms", "600001",
      ]),
      /60000 至 600000/u,
    );
    assert.equal(GAME_REPAIR_FIXTURE_IDS.length, 12);
    assert.deepEqual(parseBenchmarkSuiteArgs([
      "--suite", "four-regressions",
      "--dependency-repo", ".",
      "--ui", "none",
    ]), {
      fixtureRoot: null,
      dependencyRepoRoot: process.cwd(),
      archiveRoot: resolve(process.cwd(), "benchmark-results", "flash-current"),
      suite: "four-regressions",
      ui: "none",
      resumeDirectory: null,
    });
    assert.throws(
      () => parseBenchmarkSuiteArgs(["--suite", "custom", "--dependency-repo", "."]),
      /未知 benchmark suite/u,
    );
    assert.deepEqual(parseGameRepairMatrixArgs([
      "--dependency-repo", ".",
      "--archive-root", "benchmark-results/final",
      "--repetitions", "1",
    ]), {
      fixtureRoot: null,
      dependencyRepoRoot: process.cwd(),
      archiveRoot: resolve(process.cwd(), "benchmark-results", "final"),
      timeoutMs: null,
      repetitions: 1,
      profile: "both",
      resumeDirectory: null,
    });
    assert.equal(parseGameRepairMatrixArgs([
      "--dependency-repo", ".",
      "--resume", "benchmark-results/interrupted-matrix",
    ])?.resumeDirectory, resolve(process.cwd(), "benchmark-results", "interrupted-matrix"));
    assert.equal(parseBenchmarkSuiteArgs([
      "--suite", "full",
      "--dependency-repo", ".",
      "--resume", "benchmark-results/interrupted-suite",
    ])?.resumeDirectory, resolve(process.cwd(), "benchmark-results", "interrupted-suite"));
    assert.equal(parseGameRepairMatrixArgs([
      "--dependency-repo", ".",
      "--profile", "maintainer-current",
    ])?.profile, "maintainer-current");
    assert.equal(parseGameRepairMatrixArgs([
      "--dependency-repo", ".",
      "--profile", "pi-original",
    ])?.profile, "pi-original");
    assert.throws(
      () => parseGameRepairMatrixArgs([
        "--dependency-repo", ".",
        "--profile", "unknown",
      ]),
      /未知 game-repair-matrix Profile/u,
    );
    assert.throws(
      () => parseGameRepairMatrixArgs([
        "--dependency-repo", ".",
        "--timeout-ms", "600001",
      ]),
      /60000 至 600000/u,
    );
    assert.deepEqual(gameRepairMatrixProfiles("maintainer-current", 0), [
      "maintainer-current",
    ]);
    assert.deepEqual(gameRepairMatrixProfiles("pi-original", 1), ["pi-original"]);
    assert.deepEqual(gameRepairMatrixProfiles("both", 0), [
      "maintainer-current",
      "pi-original",
    ]);
    assert.deepEqual(gameRepairMatrixProfiles("both", 1), [
      "pi-original",
      "maintainer-current",
    ]);
    assert.throws(
      () => parseGameRepairMatrixArgs(["--dependency-repo", ".", "--repetitions", "0"]),
      /1 至 10/u,
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

  it("矩阵以外部结果为主评分，并把暂停和超时独立诊断", () => {
    const result = (
      profile: "pi-original" | "maintainer-current",
      status: "passed" | "failed" | "infra_error",
      agentStatus: "settled" | "timeout" | "infra_error",
      paused: boolean | null,
    ) => ({
      profile,
      status,
      agentOutcome: { status: agentStatus },
      workflowClosure: { paused },
    });
    const mixed = summarizeGameRepairMatrixRuns({
      preflightPassed: true,
      expectedRuns: 6,
      results: [
        result("pi-original", "infra_error", "timeout", true),
        result("pi-original", "failed", "timeout", true),
        result("maintainer-current", "failed", "settled", true),
        result("maintainer-current", "passed", "settled", false),
        result("maintainer-current", "failed", "settled", false),
      ],
      runFailures: [{ profile: "pi-original" }],
    });
    assert.equal(mixed.status, "failed");
    assert.deepEqual(mixed.byProfile, {
      "pi-original": { passed: 0, failed: 1, infraError: 2 },
      "maintainer-current": { passed: 1, failed: 2, infraError: 0 },
    });
    assert.deepEqual(mixed.runByProfile, {
      "pi-original": { settled: 0, paused: 0, timeout: 1, infraError: 2 },
      "maintainer-current": { settled: 2, paused: 1, timeout: 0, infraError: 0 },
    });

    const originalFailed = summarizeGameRepairMatrixRuns({
      preflightPassed: true,
      expectedRuns: 1,
      results: [result("pi-original", "failed", "settled", null)],
      runFailures: [],
    });
    assert.equal(originalFailed.status, "failed");

    const allPassed = summarizeGameRepairMatrixRuns({
      preflightPassed: true,
      expectedRuns: 1,
      results: [result("pi-original", "passed", "settled", null)],
      runFailures: [],
    });
    assert.equal(allPassed.status, "passed");

    const timeoutButFixed = summarizeGameRepairMatrixRuns({
      preflightPassed: true,
      expectedRuns: 1,
      results: [result("pi-original", "passed", "timeout", null)],
      runFailures: [],
    });
    assert.equal(timeoutButFixed.status, "passed");
    assert.equal(timeoutButFixed.byProfile["pi-original"].passed, 1);
    assert.equal(timeoutButFixed.runByProfile["pi-original"].timeout, 1);
  });

  it("游戏修复 Benchmark 只按任务 Oracle 和 Git 安全边界判定，不执行固定检查", () => {
    const base = {
      initialFailureMatched: true,
      afterOracleMatched: true,
      forbiddenPathsUntouched: true,
      headUnchanged: true,
    } as const;
    assert.equal(gameRepairExternalCorrectnessPassed(base), true);
    assert.equal(gameRepairExternalCorrectnessPassed({
      ...base,
      initialFailureMatched: false,
    }), false);
    assert.equal(gameRepairExternalCorrectnessPassed({
      ...base,
      afterOracleMatched: false,
    }), false);
    assert.equal(gameRepairExternalCorrectnessPassed({
      ...base,
      forbiddenPathsUntouched: false,
    }), false);
    assert.equal(gameRepairExternalCorrectnessPassed({
      ...base,
      headUnchanged: false,
    }), false);
    assert.deepEqual(gameRepairJudgeOutcome({
      infrastructureFailure: false,
      externalCorrectnessPassed: true,
      workflowClosurePassed: false,
    }), {
      status: "passed",
      externalCorrectnessPassed: true,
      workflowClosurePassed: false,
    });
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

  it("Maintainer Benchmark 只自动响应固定审批并保留 Shell 任务令牌", () => {
    const shellUrl = "http://127.0.0.1:43123/?taskId=benchmark-task&token=one-time-token";
    const endpoint = new URL(benchmarkShellEndpoint(shellUrl, "/api/input"));
    assert.equal(endpoint.pathname, "/api/input");
    assert.equal(endpoint.searchParams.get("taskId"), "benchmark-task");
    assert.equal(endpoint.searchParams.get("token"), "one-time-token");

    const approval = {
      type: "extension_ui_request",
      id: "approval-1",
      method: "confirm",
      title: "是否执行完整修复方案",
    };
    assert.equal(isBenchmarkUiRequest(approval), true);
    assert.equal(isBenchmarkExecutionApproval(approval), true);
    assert.equal(isBenchmarkExecutionApproval({ ...approval, title: "其它确认" }), false);
    assert.equal(isBenchmarkUiRequest({
      type: "extension_ui_request",
      id: "notice-1",
      method: "notify",
      message: "应继续转发到左侧 Shell",
    }), false);
    assert.equal(isBenchmarkUiRequest({ ...approval, id: null }), false);
  });

  it("Maintainer Benchmark 把 fixture 起点和无头模式严格传给游戏运行时", () => {
    const environment = benchmarkGameStartEnvironment({
      startFloor: 7,
      startPreset: "f7-admin-entry",
    });
    assert.equal(environment.DUNGEON_MAINTAINER_BENCHMARK_HEADLESS, "1");
    assert.deepEqual(resolveGameRuntimeStart(environment), {
      floor: 7,
      preset: "f7-admin-entry",
      headless: true,
    });
    assert.deepEqual(resolveGameRuntimeStart({
      DUNGEON_MAINTAINER_BENCHMARK_HEADLESS: "1",
      DUNGEON_MAINTAINER_BENCHMARK_START_FLOOR: "8",
      DUNGEON_MAINTAINER_BENCHMARK_START_PRESET: "f8-admin-entry",
    }), {
      floor: 1,
      preset: null,
      headless: false,
    });
    assert.deepEqual(resolveGameRuntimeStart({
      DUNGEON_MAINTAINER_BENCHMARK_MODE: "1",
      DUNGEON_MAINTAINER_BENCHMARK_HEADLESS: "0",
      DUNGEON_MAINTAINER_BENCHMARK_START_FLOOR: "8",
      DUNGEON_MAINTAINER_BENCHMARK_START_PRESET: "",
    }), {
      floor: 8,
      preset: null,
      headless: false,
    });
    assert.throws(
      () => benchmarkGameStartEnvironment({ startFloor: 0, startPreset: null }),
      /初始楼层/u,
    );
    assert.throws(
      () => resolveGameRuntimeStart({
        DUNGEON_MAINTAINER_BENCHMARK_MODE: "1",
        DUNGEON_MAINTAINER_BENCHMARK_START_FLOOR: "6",
        DUNGEON_MAINTAINER_BENCHMARK_START_PRESET: "../escape",
      }),
      /起点预设/u,
    );
    assert.throws(
      () => resolveGameRuntimeStart({
        DUNGEON_MAINTAINER_BENCHMARK_MODE: "1",
        DUNGEON_MAINTAINER_BENCHMARK_HEADLESS: "yes",
        DUNGEON_MAINTAINER_BENCHMARK_START_FLOOR: "6",
      }),
      /浏览器模式/u,
    );
  });

  it("Benchmark 结果明文记录非敏感 modelId，同时保留配置哈希", () => {
    const fingerprint = benchmarkModelFingerprint({
      apiKey: "not-for-reporting",
      baseUrl: "https://api.example.invalid/v1",
      model: "deepseek-v4-flash",
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      reasoning: true,
      dataDir: resolve("benchmark-data"),
    });
    assert.equal(fingerprint.modelId, "deepseek-v4-flash");
    assert.match(fingerprint.modelConfigHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(Object.keys(fingerprint).sort(), ["modelConfigHash", "modelId"]);
    assert.equal(JSON.stringify(fingerprint).includes("not-for-reporting"), false);
    assert.equal(JSON.stringify(fingerprint).includes("api.example.invalid"), false);
  });

  it("Maintainer Benchmark 在首个 settled 后立即交给外部 Oracle", () => {
    assert.deepEqual(benchmarkSettledDecision({
      taskState: "active",
      queueActive: 0,
    }), { failureCode: "maintainer-agent-incomplete" });
    assert.deepEqual(benchmarkSettledDecision({
      taskState: "verifying",
      queueActive: 0,
    }), { failureCode: "maintainer-agent-incomplete" });
    assert.deepEqual(benchmarkSettledDecision({
      taskState: "ready_to_apply",
      queueActive: 0,
    }), { failureCode: null });
    assert.deepEqual(benchmarkSettledDecision({
      taskState: "paused",
      queueActive: 0,
    }), { failureCode: "maintainer-paused" });
    assert.deepEqual(benchmarkSettledDecision({
      taskState: "blocked",
      queueActive: 0,
    }), { failureCode: "maintainer-blocked" });
  });

  it("统计 RPC 超时后返回低敏 fallback，不阻塞 Benchmark 清理", async () => {
    const startedAt = performance.now();
    const result = await requestWithDeadline(
      () => new Promise<string>(() => undefined),
      10,
      "stats-timeout",
    );
    assert.equal(result, "stats-timeout");
    assert.ok(performance.now() - startedAt < SESSION_STATS_TIMEOUT_MS);
    assert.equal(await requestWithDeadline(
      () => { throw new Error("rpc-closed"); },
      SESSION_STATS_TIMEOUT_MS,
      "sync-fallback",
    ), "sync-fallback");
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

  it("上下文整形稳定截断过长结果，并保留最新游戏和源码证据", () => {
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
    assert.match(texts[1] ?? "", /工具结果稳定截断；原始字符=/u);
    assert.equal(texts[1]?.length, 4_096);
    assert.deepEqual(shapeModelContext(messages, {
      perTurnCharacters: 24_576,
      perResultCharacters: 4_096,
    }).messages, result.messages);
    assert.deepEqual(result.stats, {
      omittedResults: 0,
      truncatedResults: 1,
      sentCharacters: 4_096
        + "当前楼层=2；题面状态=错误；最新游戏证据".length
        + "答案定义源码：expectedSql；最新源码证据".length,
    });
  });

  it("工具结果总预算优先保留最新证据，旧结果只发送稳定回执", () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: "toolResult",
      toolCallId: "tool-" + String(index),
      toolName: "inspect",
      content: [{ type: "text", text: "证据" + String(index) + ":" + "x".repeat(700) }],
    }));
    const result = shapeModelContext(messages, {
      perTurnCharacters: 1_500,
      perResultCharacters: 1_000,
    });
    assert.ok(result.stats.omittedResults > 0);
    assert.ok(result.stats.sentCharacters <= 1_500);
    const oldest = result.messages[0]?.content;
    assert.ok(Array.isArray(oldest));
    assert.match(oldest[0]?.text ?? "", /TOOL_RESULT_RECEIPT/u);
    const latest = result.messages.at(-1)?.content;
    assert.ok(Array.isArray(latest));
    assert.match(latest[0]?.text ?? "", /证据5/u);
    assert.deepEqual(shapeModelContext(messages, {
      perTurnCharacters: 1_500,
      perResultCharacters: 1_000,
    }).messages, result.messages);
  });
});
