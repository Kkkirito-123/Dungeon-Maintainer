/**
 * Pi Core 与 Dungeon Maintainer 自有安全层的运行边界。
 *
 * Pi `Agent` 只负责流式模型回合、工具协议、取消和 transcript；文件权限、核心审批、
 * Hash、worktree、固定检查与试玩均由自有模块强制执行。Runtime 不使用 Pi 高层 AgentHarness、
 * Shell、数据库或动态工具。`beforeToolCall` 强制单工具回合、资源限额和核心审批，
 * `afterToolCall` 记录低敏结果，`transformContext` 在约 75% 窗口时保留任务事实并裁剪
 * 旧对话。任务恢复会创建新 Agent，让模型重新 inspect，避免持久化代码正文。
 *
 * 会话文件只包含事件类型、工具名、状态和 token；提示词、completion、工具正文、
 * SQL、地图、快照与 Key 均不落盘。供应商或模型失败不会放宽任何工具权限。
 */

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { decidePatch } from "../safety/policy.js";
import { createTools } from "../tools/index.js";
import type { ToolContext } from "../tools/context.js";
import type { CheckCatalog } from "../tools/check.js";
import type { RuntimeConfig } from "./config.js";
import { compactContext } from "./context.js";
import { createRuntimeModel, type RuntimeModel } from "./model.js";
import type { TaskRecord, TaskStore } from "./task.js";

const SYSTEM_PROMPT = `你是 SQL Dungeon 的受限代码维护 Agent。
目标是用最少改动诊断或修复用户给出的具体问题。你只能调用 inspect、patch、check、finish。
每个模型回合最多选择一个工具。先检查证据；修改必须使用 inspect 返回的完整 baseHash 与唯一 oldText。
禁止请求 Shell、删除、移动、任意覆盖、凭据、SQL 正文、管理员答案、地图、存档、背包或身份。
check 只能选择固定 ID；黑盒诊断通过单独的 review 命令启动，并使用适配器固定工具集。
核心文件会在工具执行前暂停并等待用户批准；不要绕过、扩展或猜测批准范围。
结束时必须调用 finish；不得把未真实运行的检查声明为通过。所有总结使用简洁中文。`;

/** 一次运行的业务结果。 */
export interface RunResult {
  outcome: "diagnosed" | "needs_approval" | "ready" | "blocked" | "failed" | "aborted";
  approvalToken: string | null;
  text: string;
}

/** Runtime 的可注入选项，Faux 模型测试不需要真实 Key。 */
export interface AgentRunOptions {
  model?: RuntimeModel;
  signal?: AbortSignal;
  /** 覆盖默认维护工具；试玩时注入真实游戏工具。 */
  tools?: AgentTool[];
  /** 覆盖默认系统提示；仍由 Runtime 强制工具和权限边界。 */
  systemPrompt?: string;
  /** 允许诊断任务在临时 worktree 中修改代码。 */
  allowPatchInDiagnose?: boolean;
  /** 由项目组合入口登记的固定检查目录。 */
  checks?: CheckCatalog;
  /** Dashboard 当前运行阶段，用于限制只读排查与延迟补丁收口。 */
  stage?: "normal" | "probe" | "repair";
  /** 隐藏复测完成前不生成可应用补丁。 */
  deferReady?: boolean;
  /** 补丁成功后刷新试玩页面，继续验证最新 worktree 代码。 */
  onPatch?: () => Promise<void>;
  /** 只接收脱敏事件，不接收提示词、回复正文或工具参数。 */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** 当前会话开始前的累计计数；Harness 用它让每个场景获得独立回合和工具预算。 */
  limitBase?: { turns: number; toolCalls: number; tokens?: number };
}

function toolPaths(args: unknown): string[] {
  if (!args || typeof args !== "object" || !("edits" in args) || !Array.isArray(args.edits)) return [];
  const paths: string[] = [];
  for (const edit of args.edits as unknown[]) {
    if (edit && typeof edit === "object" && "path" in edit) {
      const path: unknown = edit.path;
      if (typeof path === "string") paths.push(path);
    }
  }
  return paths;
}

function budgetTokens(task: TaskRecord): number {
  // Provider Cache Read 仍会进入报告的总处理量，但它不是本次新增上下文；若把它重复计入
  // 硬预算，稳定前缀越容易命中缓存，任务反而越早被终止。缓存写入仍计入新增预算。
  return task.usage.input + task.usage.output + task.usage.cacheWrite;
}

function limitReached(
  config: RuntimeConfig,
  task: TaskRecord,
  base: NonNullable<AgentRunOptions["limitBase"]>,
): boolean {
  return task.usage.turns - base.turns >= config.maxTurns
    || task.usage.toolCalls - base.toolCalls >= config.maxToolCalls
    || budgetTokens(task) - (base.tokens ?? 0) >= config.maxTokens;
}

function outcome(task: TaskRecord, finishStatus: string | null): RunResult["outcome"] {
  if (task.state === "needs_approval") return "needs_approval";
  if (task.state === "ready_to_apply") return "ready";
  if (task.state === "aborted") return "aborted";
  if (task.state === "failed") return "failed";
  if (task.state === "blocked") return "blocked";
  if (finishStatus === "ready") return "ready";
  return finishStatus === "diagnosed" ? "diagnosed" : "blocked";
}

/**
 * 一个任务的一次 Pi Agent 运行。
 *
 * @param config 独立 MAINTAINER 配置与硬限额。
 * @param store 任务事实存储。
 * @param task 已进入 diagnosing 或 approved 的任务。
 * @param options 测试模型、取消信号和流式文本回调。
 * @returns 诊断、审批、待应用或异常结果；核心 token 只返回本地调用方。
 */
export async function runAgent(
  config: RuntimeConfig,
  store: TaskStore,
  task: TaskRecord,
  options: AgentRunOptions = {},
): Promise<RunResult> {
  const limitBase = options.limitBase ?? { turns: 0, toolCalls: 0 };
  if (options.signal?.aborted) {
    if (task.state !== "aborted") await store.transition(task, "aborted");
    return { outcome: "aborted", approvalToken: null, text: "任务已取消。" };
  }
  // 限额必须在供应商请求之前检查；否则“最多 20 回合”会实际发送第 21 次请求。
  if (limitReached(config, task, limitBase)) {
    task.conclusion = "达到模型回合、工具调用或 token 上限。";
    if (task.state !== "blocked") await store.transition(task, "blocked");
    else await store.save(task);
    return { outcome: "blocked", approvalToken: null, text: task.conclusion };
  }
  const runtimeModel = options.model ?? createRuntimeModel(config);
  const context: ToolContext = {
    task,
    store,
    ...(options.checks ? { checks: options.checks } : {}),
    ...(options.allowPatchInDiagnose ? { allowPatch: true } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.deferReady ? { deferReady: true } : {}),
    ...(options.onPatch ? { onPatch: options.onPatch } : {}),
  };
  let approvalToken: string | null = null;
  // 回调会在 Agent 内部异步修改这些值；对象属性可让 TypeScript 正确保留可变性。
  const control: { finishStatus: string | null; limitStop: boolean } = {
    finishStatus: null,
    limitStop: false,
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? SYSTEM_PROMPT,
      model: runtimeModel.model,
      thinkingLevel: "off",
      tools: options.tools ?? createTools(context),
      messages: [],
    },
    streamFn: runtimeModel.stream,
    sessionId: task.id,
    toolExecution: "sequential",
    transformContext: (messages) => {
      try { return Promise.resolve(compactContext(messages, task, config.contextWindow)); }
      catch { return Promise.resolve(messages); }
    },
    beforeToolCall: async ({ assistantMessage, toolCall, args }) => {
      const calls = assistantMessage.content.filter((item) => item.type === "toolCall");
      if (calls.length !== 1) return { block: true, reason: "每个回合必须且只能调用一个工具", terminate: true };
      if (task.state === "needs_approval") return { block: true, reason: "任务正在等待用户批准", terminate: true };
      // tool_execution_start 已先计数，因此第 40 次允许，第 41 次才阻断。
      if (
        task.usage.toolCalls - limitBase.toolCalls > config.maxToolCalls
        || budgetTokens(task) - (limitBase.tokens ?? 0) >= config.maxTokens
      ) {
        control.limitStop = true;
        return { block: true, reason: "任务资源限额已达到", terminate: true };
      }
      if (toolCall.name === "patch") {
        if (task.mode !== "fix" && !options.allowPatchInDiagnose) {
          return { block: true, reason: "diagnose 任务禁止修改", terminate: true };
        }
        const paths = toolPaths(args);
        if (paths.length === 0) return { block: true, reason: "patch 缺少精确文件清单", terminate: true };
        const decision = decidePatch(task, paths);
        if (decision.kind === "deny") return { block: true, reason: "补丁包含永久禁止路径", terminate: true };
        if (decision.kind === "approval") {
          if (task.state === "approved") await store.transition(task, "editing");
          task.plan = decision.paths.map((path) => `修改核心文件 ${path}`);
          approvalToken = await store.requestApproval(task, decision.paths);
          return { block: true, reason: "核心文件计划已暂停，等待本地用户批准", terminate: true };
        }
      }
      return undefined;
    },
    afterToolCall: ({ toolCall, args, result, isError }) => {
      if (toolCall.name === "finish" && !isError) {
        const finishArgs = args as { status?: string };
        const details = result.details as { state?: string } | undefined;
        control.finishStatus = details?.state === "ready_to_apply" ? "ready" : finishArgs.status ?? null;
      }
      return Promise.resolve(toolCall.name === "finish" ? { terminate: true } : undefined);
    },
    shouldStopAfterTurn: () => {
      const stop = task.state === "needs_approval" || control.finishStatus !== null || control.limitStop
        || task.usage.turns - limitBase.turns >= config.maxTurns
        || budgetTokens(task) - (limitBase.tokens ?? 0) >= config.maxTokens;
      return Promise.resolve(stop);
    },
  });

  const unsubscribe = agent.subscribe(async (event) => {
    await recordEvent(event, store, task);
    await options.onEvent?.(event);
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const scope = task.approval?.approvedAt
      ? `\n用户已批准的核心路径：${task.approval.paths.join(", ")}。必须重新 inspect 后再修改。`
      : "";
    await agent.prompt(`任务模式：${task.mode}\n任务目标：${task.objective}${scope}`);
  } catch (error) {
    if (options.signal?.aborted) {
      if (task.state !== "aborted") await store.transition(task, "aborted");
    } else {
      task.conclusion = `模型运行失败：${error instanceof Error ? error.name : "UnknownError"}`;
      if (task.state !== "failed" && task.state !== "needs_approval") await store.transition(task, "failed");
    }
  } finally {
    unsubscribe();
    options.signal?.removeEventListener("abort", abort);
  }

  // Pi 将流式取消表示为正常收口的 aborted assistant message，不保证抛异常；因此
  // 必须在“未调用 finish”判定前读取外部信号，避免把用户取消误记为业务阻断。
  if (options.signal?.aborted && control.finishStatus === null && task.state !== "aborted") {
    await store.transition(task, "aborted");
  } else if (
    (control.limitStop || (control.finishStatus === null && limitReached(config, task, limitBase)))
    && task.state !== "blocked" && task.state !== "needs_approval"
  ) {
    task.conclusion = "达到模型回合、工具调用或 token 上限。";
    await store.transition(task, "blocked");
  } else if (
    control.finishStatus === null &&
    !["needs_approval", "blocked", "failed", "aborted", "ready_to_apply"].includes(task.state)
  ) {
    task.conclusion = "模型结束时未调用 finish。";
    await store.transition(task, "blocked");
  }
  await store.save(task);
  return {
    outcome: outcome(task, control.finishStatus),
    approvalToken,
    text: task.conclusion ?? (task.state === "needs_approval" ? "核心修改等待批准。" : "任务已结束。"),
  };
}

async function recordEvent(event: AgentEvent, store: TaskStore, task: TaskRecord): Promise<void> {
  if (event.type === "turn_start") {
    task.usage.turns += 1;
    await store.appendSession(task.id, { type: event.type, turn: task.usage.turns });
    return;
  }
  if (event.type === "tool_execution_start") {
    task.usage.toolCalls += 1;
    await store.appendSession(task.id, { type: event.type, tool: event.toolName, call: task.usage.toolCalls });
    return;
  }
  if (event.type === "tool_execution_end") {
    await store.appendSession(task.id, { type: event.type, tool: event.toolName, error: event.isError });
    return;
  }
  if (event.type === "turn_end" && event.message.role === "assistant") {
    const usage = event.message.usage;
    task.usage.input += usage.input;
    task.usage.output += usage.output;
    task.usage.cacheRead += usage.cacheRead;
    task.usage.cacheWrite += usage.cacheWrite;
    await store.appendSession(task.id, {
      type: event.type, input: usage.input, output: usage.output,
      cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    });
    await store.save(task);
  }
}

/** 仅供测试和文档确认 Runtime 使用的工具与安全提示。 */
export function runtimePrompt(): string { return SYSTEM_PROMPT; }
