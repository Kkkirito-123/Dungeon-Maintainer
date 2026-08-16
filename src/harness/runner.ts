/**
 * 环境无关的 Pi Agent 黑盒诊断闭环。
 *
 * Runner 按场景执行“观察、规划、行动、验证、发现、修复、检查”，并把 Pi 事件转换为
 * 不含隐藏思维的实时日志。适配器拥有环境工具和隐藏裁判，Runtime 拥有模型循环，
 * safety/tools 拥有代码权限；Runner 只负责装配，不能绕过 worktree、审批、baseHash、
 * 固定检查或 apply。结果缓存只复用同一代码 Hash 下的 PASS，决策缓存只复用适配器
 * 白名单动作。任何缓存异常都回退模型，任何环境失败都保留报告而不伪装为 PASS。
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { hashWorktree } from "../safety/worktree.js";
import { redactText } from "../safety/redact.js";
import { runAgent, type AgentRunOptions, type RunResult } from "../runtime/agent.js";
import type { RuntimeConfig } from "../runtime/config.js";
import { createRuntimeModel, type RuntimeModel } from "../runtime/model.js";
import type { TaskRecord, TaskStore } from "../runtime/task.js";
import { checkTool } from "../tools/check.js";
import type { ToolContext } from "../tools/context.js";
import { finalizeReady, finishTool } from "../tools/finish.js";
import { inspectTool } from "../tools/inspect.js";
import { patchTool } from "../tools/patch.js";
import {
  HarnessCache,
  cachedRuntimeModel,
  resultCacheKey,
} from "./cache.js";
import type {
  HarnessAdapter,
  HarnessEventSink,
  HarnessPhase,
  HarnessReport,
  HarnessScenario,
  HarnessScenarioReport,
  HarnessStatus,
  HarnessStep,
  HarnessUsage,
  HarnessVerdict,
} from "./contract.js";
import { harnessEvent, type HarnessEvent } from "./events.js";
import { writeHarnessReport } from "./report.js";

const HARNESS_MAX_TURNS = 64;
const HARNESS_MAX_TOOL_CALLS = 64;

/** 一次通用诊断运行的输入。 */
export interface HarnessRunOptions {
  task: TaskRecord;
  store: TaskStore;
  config: RuntimeConfig;
  adapter: HarnessAdapter;
  scenarioIds: string[];
  headed: boolean;
  url?: string;
  /** 跳过结果和决策缓存，强制重新调用模型与环境。 */
  fresh?: boolean;
  /** 复用 Dashboard 已打开的浏览器会话；调用方负责最终关闭。 */
  session?: NonNullable<Awaited<ReturnType<HarnessAdapter["open"]>>>;
  /** 保留当前游戏状态，不调用 openScenario 重置楼层。 */
  resume?: boolean;
  /** `probe` 禁止改代码，`repair` 强制检查并延迟到隐藏复测后封装补丁。 */
  stage?: "full" | "probe" | "repair";
  /** 单次 Dashboard 运行的增量限额；完整 Harness 沿用 64/64 与任务 Token 上限。 */
  limits?: { turns: number; toolCalls: number; tokens: number };
  /** Dashboard 可替换为当前状态诊断提示，但不能改变工具权限。 */
  systemPrompt?: string;
  signal?: AbortSignal;
  onEvent?: HarnessEventSink;
  model?: RuntimeModel;
}

/** 报告之外只额外返回一次性审批 token；token 不会落盘。 */
export interface HarnessRunResult extends HarnessReport {
  approvalToken: string | null;
}

function safe(value: string, limit = 180): string {
  return redactText(value).replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function toolPhase(tool: string): HarnessPhase {
  if (tool === "look") return "observe";
  if (tool === "inspect") return "finding";
  if (tool === "patch") return "fix";
  if (tool === "check") return "check";
  if (tool === "finish") return "verify";
  return "act";
}

function statusFor(result: RunResult, verdict: HarnessVerdict): HarnessStatus {
  if (result.text.startsWith("BLOCKED_ENV")) return "BLOCKED_ENV";
  if (/回合、工具调用或 token 上限/u.test(result.text)) return "LIMIT_REACHED";
  if (result.outcome === "failed") return "FAIL_AGENT";
  if (["blocked", "aborted", "needs_approval"].includes(result.outcome)) return "BLOCKED_TOOL";
  if (verdict.passed && ["diagnosed", "ready"].includes(result.outcome)) return "PASS";
  return "FAIL_ENV";
}

function totalUsage(task: TaskRecord): HarnessUsage {
  const { input, output, cacheRead, cacheWrite } = task.usage;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function usageDelta(before: HarnessUsage, after: HarnessUsage): HarnessUsage {
  const input = Math.max(0, after.input - before.input);
  const output = Math.max(0, after.output - before.output);
  const cacheRead = Math.max(0, after.cacheRead - before.cacheRead);
  const cacheWrite = Math.max(0, after.cacheWrite - before.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function emptyVerdict(message: string): HarnessVerdict {
  return { passed: false, summary: safe(message, 600), metrics: {}, facts: [] };
}

function reportFor(
  scenario: HarnessScenario,
  status: HarnessStatus,
  started: number,
  cached: boolean,
  verdict: HarnessVerdict,
  steps: readonly HarnessStep[],
): HarnessScenarioReport {
  const evidence = steps.slice(-12).map((step) => step.id);
  return {
    id: scenario.id,
    label: scenario.label,
    status,
    ms: cached ? 0 : Math.round(performance.now() - started),
    cached,
    actions: steps.length,
    units: steps.reduce((sum, step) => sum + step.units, 0),
    failures: steps.filter((step) => !step.ok).length,
    summary: verdict.summary,
    evidence,
    verdict,
  };
}

async function relayPiEvent(
  event: AgentEvent,
  emit: HarnessEventSink,
  turn: { value: number },
): Promise<void> {
  if (event.type === "turn_start") {
    turn.value += 1;
    await emit(harnessEvent({ type: "phase", phase: "plan", turn: turn.value, message: "根据最新反馈选择一个动作" }));
    return;
  }
  if (event.type === "tool_execution_start") {
    const phase = toolPhase(event.toolName);
    await emit(harnessEvent({ type: "action", phase, action: safe(event.toolName, 32), state: "start", message: "开始执行" }));
    return;
  }
  if (event.type === "tool_execution_end") {
    const phase = toolPhase(event.toolName);
    await emit(harnessEvent({
      type: "action", phase, action: safe(event.toolName, 32),
      state: event.isError ? "error" : "done", ok: !event.isError,
      message: event.isError ? "工具返回错误" : "工具执行完成",
    }));
    if (event.toolName === "inspect" && !event.isError) {
      await emit(harnessEvent({ type: "finding", level: "info", message: "代码证据已更新，等待 Agent 判断" }));
    }
    return;
  }
  if (event.type === "turn_end" && event.message.role === "assistant") {
    const usage = event.message.usage;
    await emit(harnessEvent({
      type: "usage",
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    }));
  }
}

async function runScenario(
  options: HarnessRunOptions,
  scenario: HarnessScenario,
  session: NonNullable<Awaited<ReturnType<HarnessAdapter["open"]>>>,
  cache: HarnessCache,
  emit: HarnessEventSink,
  allSteps: HarnessStep[],
): Promise<{ report: HarnessScenarioReport; approvalToken: string | null; codeHash: string }> {
  const started = performance.now();
  const firstStep = allSteps.length;
  const stage = options.stage ?? "full";
  if (!options.resume) await session.openScenario(scenario);
  await emit(harnessEvent({ type: "status", status: "RUNNING", message: safe(scenario.label, 80) }));
  await emit(harnessEvent({ type: "phase", phase: "observe", message: `进入 ${safe(scenario.label, 80)}，等待首次 look` }));
  const reload = async (): Promise<void> => {
    await emit(harnessEvent({ type: "phase", phase: "fix", message: "补丁已写入隔离 worktree，重新载入环境" }));
    await session.reload();
  };
  const context: ToolContext = {
    task: options.task,
    store: options.store,
    checks: options.adapter.checks,
    ...(stage !== "probe" ? { allowPatch: true } : {}),
    ...(stage === "probe" || stage === "repair" ? { stage } : {}),
    ...(stage !== "probe" ? { deferReady: true } : {}),
    ...(stage === "repair" ? {
      beforePatch: async () => {
        if (!session.checkpoint) throw new Error("Dashboard 会话不支持补丁前检查点");
        await session.checkpoint();
      },
    } : {}),
    onPatch: reload,
  };
  const environmentTools = session.tools({
    emit,
    record: (draft) => allSteps.push({ ...draft, id: allSteps.length + 1, scenarioId: scenario.id }),
  });
  const tools: AgentTool[] = [...environmentTools, inspectTool(context)];
  if (stage !== "probe") tools.push(patchTool(context), checkTool(context));
  tools.push(finishTool(context));
  const baseModel = options.model ?? createRuntimeModel(options.config);
  const model = options.fresh ? baseModel : cachedRuntimeModel(baseModel, {
    cache,
    adapterId: options.adapter.id,
    adapterVersion: options.adapter.version,
    scenarioId: scenario.id,
    policy: options.adapter.decisionCache,
    sink: emit,
  });
  const turn = { value: 0 };
  const runOptions: AgentRunOptions = {
    tools,
    model,
    systemPrompt: options.systemPrompt ?? options.adapter.systemPrompt(scenario),
    ...(stage !== "probe" ? { allowPatchInDiagnose: true } : {}),
    checks: options.adapter.checks,
    ...(stage === "probe" || stage === "repair" ? { stage } : {}),
    ...(stage !== "probe" ? { deferReady: true } : {}),
    onPatch: reload,
    onEvent: async (event) => relayPiEvent(event, emit, turn),
    limitBase: {
      turns: options.task.usage.turns,
      toolCalls: options.task.usage.toolCalls,
      ...(options.limits ? {
        tokens: options.task.usage.input + options.task.usage.output + options.task.usage.cacheWrite,
      } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  };
  let result: RunResult;
  try {
    result = await runAgent({
      ...options.config,
      maxTurns: options.limits?.turns ?? Math.max(options.config.maxTurns, HARNESS_MAX_TURNS),
      maxToolCalls: options.limits?.toolCalls ?? Math.max(options.config.maxToolCalls, HARNESS_MAX_TOOL_CALLS),
      maxTokens: options.limits?.tokens ?? options.config.maxTokens,
    }, options.store, options.task, runOptions);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("BLOCKED_ENV")
      ? error.message
      : "BLOCKED_ENV: 模型运行不可用";
    result = { outcome: "blocked", approvalToken: null, text: message };
  }
  await emit(harnessEvent({ type: "phase", phase: "verify", message: "隐藏验证器检查场景结果" }));
  const scenarioSteps = allSteps.slice(firstStep);
  const verdict = stage === "full" || !session.probeVerdict
    ? await session.verdict(scenario, scenarioSteps)
    : await session.probeVerdict(scenario, scenarioSteps);
  let status = statusFor(result, verdict);
  let finding = verdict.summary;
  if (status === "PASS" && result.outcome === "ready") {
    try {
      await finalizeReady(context);
    } catch (error) {
      status = "BLOCKED_TOOL";
      finding = error instanceof Error ? error.message : "补丁封装失败";
    }
  }
  await emit(harnessEvent({
    type: "finding",
    level: status === "PASS" ? "info" : status === "FAIL_ENV" ? "review" : "error",
    message: safe(finding, 120),
  }));
  await emit(harnessEvent({ type: "status", status, message: "当前场景已完成隐藏验证" }));
  const codeHash = await hashWorktree(options.task.worktreeRoot ?? options.task.repoRoot);
  if (!options.fresh && status === "PASS") {
    const key = resultCacheKey({
      adapterId: options.adapter.id,
      adapterVersion: options.adapter.version,
      scenarioId: scenario.id,
      codeHash,
    });
    await cache.saveResult(key, verdict).catch(() => false);
  }
  return {
    report: reportFor(scenario, status, started, false, verdict, scenarioSteps),
    approvalToken: result.approvalToken,
    codeHash,
  };
}

/**
 * 运行一个或多个静态场景，并生成同一格式的审计报告。
 * @param options 任务、适配器、场景、模型和可选本机浏览器地址。
 * @returns 通用报告与仅供当前 CLI 展示的一次性审批 token。
 */
export async function runHarness(options: HarnessRunOptions): Promise<HarnessRunResult> {
  const startedAt = new Date().toISOString();
  const beforeUsage = totalUsage(options.task);
  const scenarios = options.adapter.scenarios(options.scenarioIds);
  const runId = `${startedAt.replace(/[-:.]/gu, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const output = join(options.store.taskDir(options.task.id), "play", runId);
  await mkdir(output, { recursive: true });
  const cache = new HarnessCache(join(options.config.dataDir, "cache"));
  const reports: HarnessScenarioReport[] = [];
  const steps: HarnessStep[] = [];
  let session: Awaited<ReturnType<HarnessAdapter["open"]>> | null = options.session ?? null;
  const ownsSession = options.session === undefined;
  let approvalToken: string | null = null;
  let codeHash = await hashWorktree(options.task.worktreeRoot ?? options.task.repoRoot);
  const emit = async (event: HarnessEvent): Promise<void> => {
    await session?.emit(event).catch(() => undefined);
    await Promise.resolve(options.onEvent?.(event)).catch(() => undefined);
  };

  try {
    for (const [index, scenario] of scenarios.entries()) {
      options.signal?.throwIfAborted();
      const key = resultCacheKey({
        adapterId: options.adapter.id,
        adapterVersion: options.adapter.version,
        scenarioId: scenario.id,
        codeHash,
      });
      const cached = options.fresh ? null : await cache.result(key).catch(() => null);
      if (cached) {
        await emit(harnessEvent({ type: "cache", state: "hit", scope: "result", message: `${scenario.label} 已在同一代码 Hash 下通过 / 0 TOKENS` }));
        await emit(harnessEvent({ type: "status", status: "PASS", message: `${scenario.label} 使用已验证结果` }));
        reports.push(reportFor(scenario, "PASS", performance.now(), true, cached, []));
        continue;
      }
      await emit(harnessEvent({ type: "cache", state: "miss", scope: "result", message: `${scenario.label} 需要重新执行` }));
      if (!session) session = await options.adapter.open({
        repoRoot: options.task.worktreeRoot ?? options.task.repoRoot,
        output,
        headed: options.headed,
        ...(options.url ? { url: options.url } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      try {
        const result = await runScenario(options, scenario, session, cache, emit, steps);
        reports.push(result.report);
        approvalToken = result.approvalToken ?? approvalToken;
        codeHash = result.codeHash;
        const suffix = result.report.status === "PASS" ? "pass" : "fail";
        await session.screenshot(join(output, "screenshots", `${scenario.id}-${suffix}.png`)).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : "环境执行失败";
        const status: HarnessStatus = message.startsWith("BLOCKED_ENV") ? "BLOCKED_ENV" : "BLOCKED_TOOL";
        const verdict = emptyVerdict(message);
        const ownSteps = steps.filter((step) => step.scenarioId === scenario.id);
        reports.push(reportFor(scenario, status, performance.now(), false, verdict, ownSteps));
        await emit(harnessEvent({ type: "finding", level: "error", message: safe(message, 120) }));
        await emit(harnessEvent({ type: "status", status, message: "场景执行被阻断" }));
      }
      const hasNext = index < scenarios.length - 1;
      const newTokens = options.task.usage.input + options.task.usage.output + options.task.usage.cacheWrite;
      if (options.task.state === "blocked" && hasNext && newTokens < options.config.maxTokens) {
        await options.store.transition(options.task, "diagnosing");
      }
      if (["needs_approval", "aborted", "failed", "ready_to_apply"].includes(options.task.state)) break;
      if (options.task.state === "blocked") break;
    }
  } finally {
    if (ownsSession) await session?.close().catch(() => undefined);
  }

  const status: HarnessStatus = reports.length > 0 && reports.every((item) => item.status === "PASS")
    ? "PASS"
    : reports.find((item) => item.status !== "PASS")?.status ?? "BLOCKED_TOOL";
  const usage = usageDelta(beforeUsage, totalUsage(options.task));
  const cachedCount = reports.filter((item) => item.cached).length;
  const summary = [
    `${options.adapter.title} 诊断状态：${status}；已处理 ${String(reports.length)}/${String(scenarios.length)} 个场景。`,
    `环境动作 ${String(reports.reduce((sum, item) => sum + item.actions, 0))}，工作量 ${String(reports.reduce((sum, item) => sum + item.units, 0))}，结果缓存命中 ${String(cachedCount)}。`,
    `模型新增 Token ${String(usage.input + usage.output + usage.cacheWrite)}，Provider Cache ${String(usage.cacheRead)}，总处理 ${String(usage.total)}；缓存动作显示为 0 Token。`,
  ].join("\n");
  const report = await writeHarnessReport({
    schemaVersion: 1,
    runId,
    adapter: { id: options.adapter.id, version: options.adapter.version, title: options.adapter.title },
    status,
    codeHash,
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios: reports,
    steps,
    summary,
    usage,
  }, output);
  options.task.plays.push({
    key: `harness:${options.adapter.id}:${scenarios.map((scenario) => scenario.id).join(",")}`,
    hash: codeHash,
    status,
    reportPath: report.reportPath,
    savedAt: new Date().toISOString(),
  });
  options.task.conclusion = summary;
  await options.store.save(options.task);
  return { ...report, approvalToken };
}
