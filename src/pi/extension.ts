/**
 * Dungeon Maintainer 的唯一 Pi Extension 装配入口。
 *
 * 本文件只负责把已验证的任务、Provider、固定工具/命令、系统提示和生命周期钩子装配
 * 到 Pi。会话安全策略由 `session-policy.ts` 负责，Vite/Chromium 生命周期由
 * `game-runtime.ts` 负责，补丁、检查、复现和 apply 仍属于各自 workspace/repair 模块。
 *
 * 输入是父进程已经校验并固定绑定的 TaskRecord、TaskStore、配置和可选测试运行时；输出是
 * 注册到 Pi 的十个领域工具、五个命令、系统提示和事件钩子，不返回可跨任务复用的运行时对象。
 * 自动续跑由 ContinuationController 绑定请求/进展 revision，工具循环由 LoopGuard 使用低敏
 * 摘要阻断；两者都不替代 TaskStore 的权威状态，也不持久化 Prompt、源码、SQL 或工具正文。
 *
 * 一个 Extension 实例始终绑定一个 taskId、一个 detached worktree、一个 Pi session 和
 * 一个游戏运行时。关闭时只停止浏览器与 Vite；未完成任务、日志和 worktree 继续保留供
 * `resume` 使用。所有写入仍受 detached worktree、realpath、一次性方案授权和刷新重放门禁；
 * API Key 只通过 Provider 的环境变量引用传递，不写入任务或事件文件。权威任务读取失败、
 * 旧 requestRevision、终态任务或刷新恢复失败都会停止自动续跑，由用户输入或 resume 恢复。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, requireApiKey, type MaintainerConfig } from "../config.js";
import type { GameDriver } from "../game/driver.js";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import type { SemanticTraceEntry } from "../logging/trace.js";
import { readActiveReproduction } from "../repair/reproduction.js";
import {
  verifyTask as runTaskVerification,
  type VerificationResult,
} from "../repair/verification.js";
import { TaskStore } from "../task/store.js";
import {
  INITIAL_TASK_OBJECTIVE,
  type TaskRecord,
  type TaskState,
} from "../task/types.js";
import {
  defaultModelProfile,
  profileKeyEnvironmentName,
  profileProviderId,
  profilesFromEnvironment,
} from "../settings/profiles.js";
import { registerMaintainerCommands } from "./commands/index.js";
import { DungeonGameRuntime } from "./game-runtime.js";
import { buildDungeonMaintainerPrompt } from "./prompt.js";
import {
  FULL_CODING_TOOLS,
} from "./tool-policy.js";
import {
  assertTaskSessionBinding,
  registerSessionPolicyHooks,
} from "./session-policy.js";
import { registerMaintainerTools } from "./tools/index.js";
import { shapeModelContext } from "./context-shaping.js";
import {
  ContinuationController,
  type ContinuationKind,
  type ContinuationPhase,
  type ContinuationTicket,
} from "./continuation-controller.js";
import {
  LoopGuard,
  type LoopAction,
  type LoopGuardDecision,
} from "./loop-guard.js";
import { syncWorktreeChanges } from "../workspace/changes.js";
import { hashWorktree } from "../workspace/git.js";
import { resolveProjectPath } from "../workspace/policy.js";
import { assertWritePathAllowed, hasActiveWriteScope } from "../workspace/write-scope.js";

const NATIVE_WRITE_TOOLS = new Set(["edit", "write"]);
const MAX_REPAIR_FOLLOW_UPS = 4;
const MAX_REPAIR_TOOL_CALLS = 16;
const RESERVED_EXECUTION_TOOL_CALLS = 4;
const MAX_STATUS_TOOL_CALLS = 6;
const MAX_STATUS_INSPECT_CALLS = 3;
const REPAIR_ACTION_PATTERN = /(?:修复|修好|解决|排查|诊断|定位|调查|纠正|改掉|处理|实现|增加|支持|fix|debug|diagnos)/iu;
const PROBLEM_PATTERN = /(?:问题|故障|错误|异常|bug|失败|不一致|不正确|不对|掉血|没法|无法|不能|看不见|卡住|崩溃|默认答案)/iu;
const STRONG_REPAIR_PATTERN = /(?:修复|修好|解决|改掉|fix)|(?:(?:默认\s*(?:答案|SQL|查询)|题目).{0,24}(?:错|错误|不对|不一致))/iu;
const SOURCE_EVIDENCE_TOOLS = new Set(["inspect", "check"]);
const GAME_FAILURE_EVIDENCE_TOOLS = new Set(["go", "use", "query"]);
const DIAGNOSTIC_EVIDENCE_TOOLS = new Set([
  ...SOURCE_EVIDENCE_TOOLS,
  "look",
  ...GAME_FAILURE_EVIDENCE_TOOLS,
]);
const CONTINUATION_STOP_STATES = new Set<TaskState>([
  "awaiting_approval",
  "verifying",
  "ready_to_apply",
  "applied",
  "blocked",
  "discarded",
]);

type FinishStatus =
  | "reproduced"
  | "diagnosed"
  | "proposed"
  | "result"
  | "blocked";

interface DungeonGameRuntimePort {
  currentDriver(): GameDriver | null;
  requireDriver(): GameDriver;
  ensure(): Promise<GameDriver>;
  close(): Promise<void>;
}

interface NativeWritePreparation {
  baselineHash: string;
  driver: GameDriver;
  actions: readonly SemanticTraceEntry[];
}

interface NativeWriteBatch {
  preparation: Promise<NativeWritePreparation>;
  pendingToolCallIds: Set<string>;
  flushPromise: Promise<NativeRefreshOutcome> | null;
}

interface NativeRefreshOutcome {
  changed: boolean;
  passed: boolean;
  text: string;
}

function normalizedRequest(text: string): string {
  return redactText(text).replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

function requiresRepair(text: string): boolean {
  const request = normalizedRequest(text);
  if (!request) return false;
  return STRONG_REPAIR_PATTERN.test(request)
    || (REPAIR_ACTION_PATTERN.test(request) && PROBLEM_PATTERN.test(request));
}

function isContinuationRequest(text: string): boolean {
  return /^(?:继续|继续修复|继续处理|retry|resume)$/iu.test(normalizedRequest(text));
}

function finishStatus(value: unknown): FinishStatus | null {
  return value === "reproduced"
    || value === "diagnosed"
    || value === "proposed"
    || value === "result"
    || value === "blocked"
    ? value
    : null;
}

function toolSignature(toolName: string, input: unknown): string {
  return toolName + ":" + JSON.stringify(input);
}

/**
 * 把一次工具调用投影成循环门禁使用的稳定动作与较粗路线。
 *
 * @param toolName Pi 固定工具名。
 * @param input 已由工具 schema 校验的调用参数；正文只在本进程内生成摘要，不会写入日志。
 * @returns 完整动作用于精确重复判断，路线用于识别无进展的 A-B-A-B 切换。
 * @remarks 本函数不执行工具、不读取文件，也不改变诊断或写入权限。
 */
function loopAction(toolName: string, input: Record<string, unknown>): LoopAction {
  const route = toolName === "inspect"
    ? { action: input.action }
    : toolName === "finish"
      ? { status: input.status }
      : NATIVE_WRITE_TOOLS.has(toolName)
        ? { path: input.path }
        : toolName === "patch"
          ? { path: input.path }
          : GAME_FAILURE_EVIDENCE_TOOLS.has(toolName)
            ? {
                actionId: input.actionId,
                target: input.target,
                toolName,
              }
            : { toolName };
  return { toolName, input, route };
}

/**
 * 生成循环门禁的中文阻断说明。
 *
 * @param decision 非 allow 的确定性门禁决策。
 * @returns 不含源码、SQL 或模型正文的短说明，可安全显示给用户和模型。
 */
function loopGuardNotice(decision: Exclude<LoopGuardDecision, { kind: "allow" }>): string {
  if (decision.kind === "hard_stop") {
    return "连续 8 次工具结果没有产生新证据，自动诊断已硬停止；请检查现有证据或由用户调整任务方向。";
  }
  if (decision.kind === "strategy_reset") {
    return "连续 5 次工具结果没有产生新证据，当前路线已停止；下一回合必须更换诊断策略，不能继续扩散搜索。";
  }
  return decision.reason === "alternating_route"
    ? "检测到无进展的 A-B-A-B 工具路线，当前路线已停止；必须基于证据缺口更换策略。"
    : "相同工具动作已经得到两次相同结果，第三次执行已阻止；必须使用已有证据或更换策略。";
}

/** Extension 安装所需的已验证任务事实。 */
export interface DungeonExtensionOptions {
  config: MaintainerConfig;
  store: TaskStore;
  task: TaskRecord;
  /** 测试可注入不启动外部进程的同契约运行时；生产环境始终使用真实运行时。 */
  gameRuntime?: DungeonGameRuntimePort;
  /** 测试可注入确定性验证器；生产环境始终调用 repair/verification。 */
  verifyTask?: (signal?: AbortSignal) => Promise<VerificationResult>;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot !== ""
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(".." + sep)
    && !isAbsolute(pathFromRoot);
}

async function nativeWritePathFailure(
  task: TaskRecord,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (toolName !== "edit" && toolName !== "write") return null;
  if (typeof input.path !== "string" || !input.path.trim()) {
    return "原生写入缺少合法项目相对路径。";
  }
  const rawPath = input.path.trim();
  if (rawPath.replace(/\\/gu, "/").split("/").includes("..")) {
    return "原生写入路径不能包含 ..；只能修改当前 detached worktree。";
  }
  const candidate = resolve(task.worktreeRoot, rawPath);
  if (
    isAbsolute(rawPath)
    && (candidate === resolve(task.repoRoot) || isWithinRoot(task.repoRoot, candidate))
  ) {
    return "原生写入不能使用正式仓库绝对路径；只能修改当前 detached worktree。";
  }
  if (!isWithinRoot(task.worktreeRoot, candidate)) {
    return "原生写入路径已脱离当前 detached worktree。";
  }
  try {
    assertWritePathAllowed(task, rawPath);
  } catch (error) {
    return error instanceof Error ? error.message : "原生写入路径未通过批准范围";
  }
  try {
    await resolveProjectPath(task.worktreeRoot, rawPath, "write");
  } catch (error) {
    return "原生写入路径未通过 realpath 边界："
      + safeRefreshFailure(error);
  }
  return null;
}

function safeRefreshFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知刷新错误";
  return redactText(message).replace(/\s+/gu, " ").trim().slice(0, 400)
    || "未知刷新错误";
}

/**
 * 注册当前配置中的 OpenAI-compatible 模型档案。
 *
 * @param pi 当前 Pi Extension API。
 * @param config 固定 endpoint、模型和上下文预算。
 * @returns 无返回值；Provider 只保存环境变量引用，不保存密钥正文。
 */
function registerProviders(
  pi: ExtensionAPI,
  config: MaintainerConfig,
): void {
  const profiles = profilesFromEnvironment(
    process.env,
    defaultModelProfile(config),
  );
  for (const profile of profiles) {
    pi.registerProvider(profileProviderId(profile.id), {
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: "$" + profileKeyEnvironmentName(profile.id),
      api: "openai-completions",
      models: [{
        id: profile.modelId,
        name: profile.name,
        reasoning: profile.reasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: profile.contextWindow,
        maxTokens: profile.maxOutputTokens,
      }],
    });
  }
}

/**
 * 把固定任务安装到当前 Pi Extension API。
 *
 * @param pi 当前 Pi Extension API。
 * @param options 已由父进程创建并通过 schema 校验的任务、存储和模型配置。
 * @returns 无返回值；注册阶段不启动外部进程，游戏在 session_start 时惰性启动。
 * @throws session_start 时发现任务绑定或模型不一致会阻止会话继续。
 */
export function installDungeonMaintainerExtension(
  pi: ExtensionAPI,
  options: DungeonExtensionOptions,
): void {
  const { config, store, task } = options;
  const gameRuntime = options.gameRuntime ?? new DungeonGameRuntime(task, store);
  const verifyCurrentTask = options.verifyTask ?? (async (signal?: AbortSignal) => {
    return await runTaskVerification(
      store,
      task,
      gameRuntime.currentDriver(),
      signal,
    );
  });
  let executionApproved = false;
  let latestNaturalRequest = "";
  let repairRequested = false;
  let repairToolCalls = 0;
  let repairStopped = false;
  let budgetStopRequested = false;
  let budgetStopAttempts = 0;
  let approvedProposalInRun = false;
  let refreshRecoveryMessage: string | null = null;
  let strategyResetRequested: string | null = null;
  let currentRunContinuation: ContinuationTicket | null = null;
  const continuationController = new ContinuationController(
    task.id,
    MAX_REPAIR_FOLLOW_UPS,
  );
  const loopGuard = new LoopGuard();
  const pendingLoopActions = new Map<string, LoopAction>();
  const repairEvidenceTools = new Set<string>();
  const repairSourceEvidenceActions = new Set<"read" | "search">();
  let repairSourceReadCount = 0;
  let actionNotAvailableFailure = false;
  const actionNotAvailableActions = new Set<string>();
  let repairExecutionEvidence = false;
  let repairMappingEvidence = false;
  let repairDomEvidence = false;
  let failedCheckEvidence = false;
  let failedGameEvidence = false;
  const successfulFinishStatuses = new Set<FinishStatus>();
  const failedGameToolCalls = new Map<string, number>();
  const toolFamilyCalls = new Map<string, number>();

  const hasSufficientSourceEvidence = (): boolean => (
    actionNotAvailableFailure
      ? repairExecutionEvidence && repairMappingEvidence && repairDomEvidence
      : repairSourceEvidenceActions.has("read")
        && (
          repairSourceReadCount >= 2
          || (repairSourceReadCount >= 1 && failedCheckEvidence)
        )
  );

  const missingActionEvidence = (): string[] => {
    const missing: string[] = [];
    if (!repairExecutionEvidence) missing.push("use 执行分支");
    if (!repairMappingEvidence) {
      const actions = [...actionNotAvailableActions];
      missing.push(actions.length > 0
        ? actions.join("/") + " 的动作映射字面量"
        : "失败动作的映射字面量");
    }
    if (!repairDomEvidence) missing.push("真实 DOM 按钮定义");
    return missing;
  };

  const actionEvidenceInstruction = (): string => {
    const missing = missingActionEvidence();
    return missing.length > 0
      ? "action-not-available 仍缺少源码证据：" + missing.join("、")
        + "。请继续用 inspect(read) 精确读取这些定义，不能用 projection 中暴露动作的代码替代动作映射或 DOM 定义。"
      : "action-not-available 的执行分支、动作映射和真实 DOM 定义已经齐全。";
  };

  const inspectEvidenceText = (content: unknown): string => {
    if (!Array.isArray(content)) return "";
    return content
      .map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return "";
        const record = item as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string"
          ? record.text
          : "";
      })
      .filter(Boolean)
      .join("\n");
  };

  const escapedPattern = (value: string): string => (
    value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  );

  const updateActionSourceEvidence = (
    input: Record<string, unknown>,
    evidenceText: string,
  ): void => {
    const action = input.action;
    const projectPath = typeof input.path === "string"
      ? input.path.replaceAll("\\", "/").toLowerCase()
      : "";
    if (
      action === "read"
      && /(?:^|\/)bridge\.[cm]?[jt]sx?$/u.test(projectPath)
      && /DUNGEON_AGENT_ACTION_SELECTORS\s*\[\s*actionId\s*\]/u.test(evidenceText)
      && /action-not-available|clickDungeonAgentAction/u.test(evidenceText)
    ) {
      repairExecutionEvidence = true;
    }
    if (
      action === "read"
      && /(?:^|\/)actions\.[cm]?[jt]sx?$/u.test(projectPath)
      && /DUNGEON_AGENT_ACTION_SELECTORS/u.test(evidenceText)
      && [...actionNotAvailableActions].some((actionId) => (
        new RegExp(
          "(?:^|\\n)\\s*(?:\\d+\\s+)?[\"'`]?" + escapedPattern(actionId)
            + "[\"'`]?\\s*:\\s*[\"'`][^\"'`]+[\"'`]",
          "u",
        ).test(evidenceText)
      ))
    ) {
      repairMappingEvidence = true;
    }
    if (
      (
        (
          action === "read"
          && projectPath.includes("/presentation/dom/")
        )
        || (
          action === "search"
          && /(?:^|\n)[^\n]*\/presentation\/dom\/[^:\n]+:\d+:[^\n]*/u.test(evidenceText)
        )
      )
      && /(?:id\s*=\s*["'][^"']+["']|[A-Za-z_$][\w$]*\s*:\s*["']#[^"']+["'])/u.test(evidenceText)
      && /open-sql|sqlButton|terminal/iu.test(evidenceText)
    ) {
      repairDomEvidence = true;
    }
  };

  const beginNaturalRequest = (
    text: string,
    continuation = false,
  ): ContinuationTicket[] => {
    latestNaturalRequest = normalizedRequest(text);
    repairRequested = continuation || requiresRepair(latestNaturalRequest);
    repairToolCalls = 0;
    repairStopped = false;
    budgetStopRequested = false;
    budgetStopAttempts = 0;
    approvedProposalInRun = false;
    refreshRecoveryMessage = null;
    strategyResetRequested = null;
    pendingLoopActions.clear();
    const staleContinuations = continuationController.beginRequest(continuation);
    if (!continuation) {
      loopGuard.resetForNewTask();
      repairEvidenceTools.clear();
      repairSourceEvidenceActions.clear();
      repairSourceReadCount = 0;
      actionNotAvailableFailure = false;
      actionNotAvailableActions.clear();
      repairExecutionEvidence = false;
      repairMappingEvidence = false;
      repairDomEvidence = false;
      failedGameEvidence = false;
      successfulFinishStatuses.clear();
      failedGameToolCalls.clear();
      toolFamilyCalls.clear();
    }
    failedCheckEvidence = task.checks.some((record) => record.status !== "passed");
    // 恢复同一个任务并再次询问同一目标时，已有 active reproduction 是持久化的
    // 复现检查点，不应因为 Extension 重启而被当成不存在；不同目标仍从零开始。
    if (
      repairRequested
      && task.activeReproductionId !== null
      && (
        isContinuationRequest(latestNaturalRequest)
        || normalizedRequest(task.objective) === latestNaturalRequest
        || task.changedPaths.length === 0
      )
    ) {
      successfulFinishStatuses.add("reproduced");
    }
    return staleContinuations;
  };

  const recordContinuation = async (ticket: ContinuationTicket): Promise<void> => {
    await appendEvent(store, task.id, "continuation." + ticket.status, {
      continuationId: ticket.id,
      kind: ticket.kind,
      requestRevision: ticket.requestRevision,
      progressRevision: ticket.progressRevision,
      phase: ticket.phase,
      nextAction: ticket.nextAction,
      attempt: ticket.attempt,
      reason: ticket.reason,
    });
  };

  const recordContinuations = async (
    tickets: readonly ContinuationTicket[],
  ): Promise<void> => {
    for (const ticket of tickets) await recordContinuation(ticket);
  };

  const advanceProgress = async (reason: string): Promise<void> => {
    await recordContinuations(continuationController.advanceProgress(reason));
  };

  const markObjectiveProgress = async (
    reason: string,
    loopGuardAlreadyAdvanced: boolean,
  ): Promise<void> => {
    if (!loopGuardAlreadyAdvanced) loopGuard.noteProgress();
    await advanceProgress(reason);
  };

  const currentContinuationPhase = (): ContinuationPhase => {
    if (executionApproved || approvedProposalInRun) return "execute";
    if (
      successfulFinishStatuses.has("reproduced")
      && hasSufficientSourceEvidence()
    ) return "propose";
    if (successfulFinishStatuses.has("reproduced")) return "diagnose";
    return "reproduce";
  };

  const queueContinuation = async (input: {
    kind: ContinuationKind;
    phase: ContinuationPhase;
    nextAction: string;
    customType: string;
    content: string;
  }): Promise<boolean> => {
    const reservation = continuationController.reserve({
      kind: input.kind,
      phase: input.phase,
      nextAction: input.nextAction,
    });
    if (!reservation.ticket) return false;
    try {
      await recordContinuation(reservation.ticket);
    } catch (error) {
      await recordContinuations(continuationController.invalidate(
        "cancelled",
        "event-write-failed",
      )).catch(() => undefined);
      throw error;
    }
    try {
      pi.sendMessage({
        customType: input.customType,
        content: input.content,
        display: false,
        details: {
          continuationId: reservation.ticket.id,
          kind: reservation.ticket.kind,
          requestRevision: reservation.ticket.requestRevision,
          progressRevision: reservation.ticket.progressRevision,
          phase: reservation.ticket.phase,
          nextAction: reservation.ticket.nextAction,
          attempt: reservation.ticket.attempt,
        },
      }, {
        triggerTurn: true,
        deliverAs: "followUp",
      });
    } catch (error) {
      await recordContinuations(continuationController.invalidate(
        "cancelled",
        "pi-send-failed",
      )).catch(() => undefined);
      throw error;
    }
    return true;
  };

  const setExecutionApproved = (approved: boolean): void => {
    executionApproved = approved;
    // 工具定义在整个会话内保持稳定。Pi 会把活动工具集合写入系统提示并参与
    // Prompt 缓存键；在 proposed 确认后切换集合会让同一任务的缓存前缀失效，
    // 造成一次完整上下文重传。写入权限仍由下方 tool_call 门禁和 patch 工具
    // 的执行授权检查保证，诊断阶段即使模型误调用写入工具也不会写入任何字节。
    // 这里始终使用完整集合，只改变 executionApproved 这一运行时权限事实。
    pi.setActiveTools([...FULL_CODING_TOOLS]);
  };

  registerProviders(pi, config);
  const sharedContext = {
    task,
    store,
    currentDriver: () => gameRuntime.currentDriver(),
    requireDriver: () => gameRuntime.requireDriver(),
    ensureGame: () => gameRuntime.ensure(),
    closeGame: () => gameRuntime.close(),
    approveExecution: () => setExecutionApproved(true),
    completeExecution: () => setExecutionApproved(false),
    isExecutionApproved: () => executionApproved,
    verifyTask: verifyCurrentTask,
  };
  registerMaintainerTools(pi, sharedContext);
  registerMaintainerCommands(pi, sharedContext);
  registerSessionPolicyHooks(pi, store, task);

  // 变换只发生在发给模型的临时上下文，不改原始 session/evidence store。
  // 必须从最新结果向前花费预算，否则早期搜索会把最后的游戏、源码和验证证据挤掉。
  pi.on("context", (event) => {
    return { messages: shapeModelContext(event.messages).messages };
  });

  let turnToolCalls = 0;
  let nativeWriteBatch: NativeWriteBatch | null = null;
  let lastRefreshFailure: string | null = null;

  const publishRefreshOutcome = (
    context: ExtensionContext,
    outcome: NativeRefreshOutcome,
  ): void => {
    context.ui.notify(outcome.text, outcome.passed ? "info" : "error");
  };

  const scalarToolDetails = (details: unknown): Record<string, unknown> => {
    if (!details || typeof details !== "object" || Array.isArray(details)) return {};
    return Object.fromEntries(Object.entries(details).filter(([, value]) => (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || (
        Array.isArray(value)
        && value.every((item) => (
          item === null
          || typeof item === "string"
          || typeof item === "number"
          || typeof item === "boolean"
        ))
      )
    )));
  };

  const recordLoopToolResult = (event: ToolResultEvent): boolean => {
    const action = pendingLoopActions.get(event.toolCallId)
      ?? loopAction(event.toolName, event.input);
    pendingLoopActions.delete(event.toolCallId);
    const text = inspectEvidenceText(event.content);
    const details = scalarToolDetails(event.details);
    const result = {
      details,
      isError: event.isError,
      text,
    };
    const hasEvidence = text.length > 0 || Object.keys(details).length > 0;
    return loopGuard.recordOutcome({
      action,
      result,
      // “尝试了另一组参数”不是客观进展；只有结果本身出现新的领域事实才推进
      // revision，否则模型可用不断改 query/path 的方式规避 A-B-A-B 和无进展门禁。
      evidence: hasEvidence ? [{ toolName: event.toolName, result }] : [],
    });
  };

  const flushNativeWriteBatch = async (): Promise<NativeRefreshOutcome | null> => {
    const batch = nativeWriteBatch;
    if (!batch) return null;
    batch.flushPromise ??= (async () => {
      let prepared: NativeWritePreparation | null = null;
      let refreshEventWritten = false;
      try {
        prepared = await batch.preparation;
        const currentHash = await hashWorktree(task.worktreeRoot);
        if (currentHash === prepared.baselineHash) {
          return {
            changed: false,
            passed: true,
            text: "原生工具未产生代码变化，无需刷新右侧游戏。",
          };
        }
        await syncWorktreeChanges(store, task, "native-tools");
        const replay = await prepared.driver.reloadAndReplay(prepared.actions);
        await appendEvent(store, task.id, "game.refresh", {
          replayed: prepared.actions.length > 0,
          passed: replay.passed,
          actionCount: replay.actionCount,
        });
        refreshEventWritten = true;
        if (!replay.passed) {
          throw new Error(replay.failure ?? "未知游戏错误");
        }
        lastRefreshFailure = null;
        return {
          changed: true,
          passed: true,
          text: "原生代码修改已同步；右侧游戏已刷新并重放 "
            + String(replay.actionCount)
            + " 个语义动作。",
        };
      } catch (error) {
        if (prepared && !refreshEventWritten) {
          await appendEvent(store, task.id, "game.refresh", {
            replayed: prepared.actions.length > 0,
            passed: false,
            actionCount: 0,
          }).catch(() => undefined);
        }
        lastRefreshFailure = "原生代码已写入，但右侧刷新重放未通过："
          + safeRefreshFailure(error);
        return {
          changed: true,
          passed: false,
          text: lastRefreshFailure,
        };
      }
    })();
    const outcome = await batch.flushPromise;
    if (nativeWriteBatch === batch) nativeWriteBatch = null;
    return outcome;
  };

  const refreshGateFailure = async (): Promise<string | null> => {
    const batch = nativeWriteBatch;
    if (batch) {
      if (batch.pendingToolCallIds.size > 0 && !batch.flushPromise) {
        return "原生代码修改仍在执行，必须等待同步刷新完成后再检查或提交结果。";
      }
      const outcome = await flushNativeWriteBatch();
      if (outcome && !outcome.passed) return outcome.text;
    }
    return lastRefreshFailure;
  };

  // 工具预算在 Extension 层阻断，避免模型因为一次错误判断不断重复 inspect 或游戏动作；
  // 这不是提示词建议，而是运行时硬限制，因此不会因模型输出变长而失效。
  pi.on("agent_start", async () => {
    turnToolCalls = 0;
    const admitted = continuationController.admitQueued();
    currentRunContinuation = admitted;
    if (admitted) await recordContinuation(admitted);
    // 独立用户回合和普通 repair continuation 重新获得单回合预算；预算收尾
    // continuation 保留门禁，只允许 finish，防止“总结”回合再次开始扩散搜索。
    if (admitted?.kind !== "budget") {
      budgetStopRequested = false;
      budgetStopAttempts = 0;
    }
    strategyResetRequested = null;
  });
  pi.on("agent_settled", () => {
    // 方案授权只覆盖当前完整 Agent 运行；即使模型忘记提交 result，下一条用户消息也
    // 必须重新经过“病因 + 总方案 + 确认”，不能继承上一轮的 write/edit 权限。
    setExecutionApproved(hasActiveWriteScope(task));
    budgetStopRequested = false;
    budgetStopAttempts = 0;
    currentRunContinuation = null;
  });
  pi.on("agent_end", async (_event, context) => {
    const runWasCurrent = continuationController.activeRunIsCurrent();
    const completed = continuationController.completeActive();
    currentRunContinuation = null;
    if (completed) await recordContinuation(completed);
    // 新用户输入可能在旧回合仍流式执行时到达。旧回合可以完成收尾，但不能替新
    // requestRevision 生成自动消息，否则普通 Pi 消息队列又会被误当成任务队列。
    if (!runWasCurrent) return;

    let authoritativeTask: TaskRecord;
    try {
      authoritativeTask = await store.read(task.id);
    } catch (error) {
      await recordContinuations(continuationController.invalidate(
        "cancelled",
        "task-read-failed",
      )).catch(() => undefined);
      context.ui.notify(
        "无法重新读取权威任务状态，已停止自动续跑：" + safeRefreshFailure(error),
        "error",
      );
      return;
    }
    if (CONTINUATION_STOP_STATES.has(authoritativeTask.state)) {
      await recordContinuations(continuationController.invalidate(
        "cancelled",
        "task-state-" + authoritativeTask.state,
      ));
      return;
    }

    if (refreshRecoveryMessage) {
      const content = refreshRecoveryMessage;
      refreshRecoveryMessage = null;
      await queueContinuation({
        kind: "refresh-recovery",
        phase: executionApproved ? "execute" : currentContinuationPhase(),
        nextAction: "consume-refresh-outcome",
        customType: "dungeon-refresh-recovery",
        content: content
          + " 这是异常路径补发的唯一刷新结果；请据此继续当前步骤，不要重新执行已经完成的写入。",
      });
      return;
    }

    if (budgetStopRequested) {
      await queueContinuation({
        kind: "budget",
        phase: currentContinuationPhase(),
        nextAction: repairRequested
          ? "finish-proposed-or-blocked"
          : "answer-without-tools",
        customType: "dungeon-budget-follow-up",
        content: repairRequested
          ? "工具预算已达到本轮上限。禁止继续搜索；请立即根据已有证据调用 finish(status=proposed)，若证据确实不足则调用 finish(status=blocked)，不要再调用 inspect/look。"
          : "只读工具预算已达到本轮上限。禁止继续搜索；请根据已有证据直接用简短中文回答用户，不要再调用工具。",
      });
      return;
    }

    if (strategyResetRequested) {
      const nextAction = strategyResetRequested;
      strategyResetRequested = null;
      if (repairRequested && !repairStopped) {
        await queueContinuation({
          kind: "repair",
          phase: currentContinuationPhase(),
          nextAction,
          customType: "dungeon-strategy-reset",
          content: "当前诊断路线已被循环门禁停止。只允许选择一个由现有证据支持、但尚未验证的不同假设；禁止重复刚才的工具或 A-B-A-B 路线。若没有新的可验证假设，立即调用 finish(status=proposed) 或 finish(status=blocked)。",
        });
      }
      return;
    }

    if (
      !repairRequested
      || repairStopped
    ) return;
    const usage = context.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= 80) {
      context.ui.notify(
        "修复尚未完成，但上下文已接近上限；请发送“继续修复”以在压缩后继续。",
        "warning",
      );
      return;
    }
    const hasReproduction = successfulFinishStatuses.has("reproduced");
    const hasSourceEvidence = repairEvidenceTools.has("inspect");
    const sourceEvidenceReady = hasSufficientSourceEvidence();
    const hasGameEvidence = [...repairEvidenceTools].some(
      (toolName) => GAME_FAILURE_EVIDENCE_TOOLS.has(toolName),
    );
    const continuation = approvedProposalInRun || executionApproved
      ? {
          nextAction: "complete-approved-plan",
          content: "修复任务尚未完成。方案已经批准；不要总结或询问用户，立即完成剩余代码修改，并调用 finish(status=result) 运行固定验证。",
        }
      : hasReproduction && sourceEvidenceReady
        ? {
            nextAction: "finish-proposed",
            content: "修复任务尚未完成。复现和源码证据已经足够形成明确病因；下一步必须立即调用 finish(status=proposed) 一次提交完整修复步骤、验证方法、风险和 allowedPaths。不要再调用 inspect、look 或其他诊断工具，也不要用普通回复结束。",
          }
        : hasReproduction
          ? {
              nextAction: actionNotAvailableFailure
                ? "inspect-action-evidence"
                : "inspect-source",
              content: "修复任务尚未完成。复现已经保存；"
                + (actionNotAvailableFailure
                  ? actionEvidenceInstruction()
                  : "现在继续用 inspect(read) 读取候选源码并交叉确认明确病因。")
                + " 证据齐全后调用 finish(status=proposed)，不要反问用户是否继续。",
            }
          : hasGameEvidence
            ? {
                nextAction: "save-reproduction",
                content: "修复任务尚未完成。已经取得右侧游戏故障证据；先调用 finish(status=reproduced) 保存可重放复现，再继续定位源码，不要只解释现象。",
              }
            : hasSourceEvidence
              ? {
                  nextAction: "reproduce-or-propose",
                  content: "修复任务尚未完成。已有诊断证据；继续定位并形成可执行总方案。若属于运行时故障，先用右侧语义动作复现并保存 reproduced；不要用普通回复结束。",
                }
              : {
                  nextAction: "reproduce-visible-failure",
                  content: "用户要求的是解决问题，不是快速答复。直接读取系统提示中的右侧玩家可见状态，使用游戏语义工具复现；随后检查源码、形成方案并执行验证。不要索要右侧已经可见的题目、SQL 或状态。",
                };
    await queueContinuation({
      kind: "repair",
      phase: currentContinuationPhase(),
      nextAction: continuation.nextAction,
      customType: "dungeon-repair-follow-up",
      content: continuation.content,
    });
  });
  pi.on("turn_end", async (_event, context) => {
    // 正常写入在最后一个 native tool_result 中完成刷新；这里只处理取消或第三方
    // 扩展导致 tool_result 缺失的异常路径，不能再把正常刷新延迟到整轮结束。
    if (!nativeWriteBatch) return;
    nativeWriteBatch.pendingToolCallIds.clear();
    const outcome = await flushNativeWriteBatch();
    if (outcome?.changed) {
      refreshRecoveryMessage = outcome.text;
      publishRefreshOutcome(context, outcome);
    }
  });
  pi.on("tool_call", async (event, context) => {
    if (!continuationController.activeRunIsCurrent()) {
      const reason = "这次工具调用属于已经被新用户请求替代的旧回合，禁止继续执行。";
      context.ui.notify(reason, "warning");
      return { block: true, terminate: true, reason };
    }
    if (currentRunContinuation) {
      let authoritativeState: TaskState;
      try {
        authoritativeState = (await store.read(task.id)).state;
      } catch (error) {
        const reason = "无法确认自动续跑对应的权威任务状态，已拒绝工具调用："
          + safeRefreshFailure(error);
        context.ui.notify(reason, "error");
        return { block: true, terminate: true, reason };
      }
      if (CONTINUATION_STOP_STATES.has(authoritativeState)) {
        const reason = "自动续跑已经过期：任务当前处于 " + authoritativeState
          + "，旧 proposed/result 或诊断工具均不得继续执行。";
        await recordContinuations(continuationController.invalidate(
          "cancelled",
          "task-state-" + authoritativeState,
        ));
        context.ui.notify(reason, "warning");
        return { block: true, terminate: true, reason };
      }
    }
    if (budgetStopRequested && event.toolName !== "finish") {
      budgetStopAttempts += 1;
      const reason = repairRequested
        ? "工具预算已达到本轮上限；请立即调用 finish(status=proposed) 或 finish(status=blocked)，不要继续读取源码。"
        : "只读工具预算已达到本轮上限；请直接回答用户，不要继续调用工具。";
      return {
        block: true,
        terminate: budgetStopAttempts > 1,
        reason,
      };
    }
    const signature = toolSignature(event.toolName, event.input);
    if (
      GAME_FAILURE_EVIDENCE_TOOLS.has(event.toolName)
      && (failedGameToolCalls.get(signature) ?? 0) >= 2
    ) {
      return {
        block: true,
        terminate: false,
        reason: "同一游戏动作已在相同参数下失败两次，禁止继续重试；请改用玩家投影中的其他 action/target，或直接 inspect 相关源码定位故障。",
      };
    }
    const guardedAction = loopAction(event.toolName, event.input);
    const loopDecision = loopGuard.evaluateAction(guardedAction);
    if (loopDecision.kind !== "allow") {
      const notice = loopGuardNotice(loopDecision);
      context.ui.notify(notice, loopDecision.kind === "hard_stop" ? "error" : "warning");
      if (loopDecision.kind === "hard_stop") {
        repairStopped = true;
        budgetStopRequested = false;
        strategyResetRequested = null;
        await recordContinuations(continuationController.invalidate(
          "cancelled",
          "loop-hard-stop",
        ));
      } else {
        strategyResetRequested = loopDecision.kind === "strategy_reset"
          ? "change-strategy-no-progress"
          : loopDecision.reason === "alternating_route"
            ? "change-alternating-route"
            : "change-repeated-action";
      }
      return {
        block: true,
        terminate: true,
        reason: notice,
      };
    }
    if (repairRequested) {
      const sourceEvidenceReady = hasSufficientSourceEvidence();
      const hasReproduction = successfulFinishStatuses.has("reproduced");
      if (
        actionNotAvailableFailure
        && !hasReproduction
        && !(
          event.toolName === "finish"
          && finishStatus(event.input.status) === "reproduced"
        )
      ) {
        const notice = "右侧故障已经复现；必须先调用 finish(status=reproduced) 保存可重放断言，再读取源码或提交方案。";
        context.ui.notify(notice, "info");
        return {
          block: true,
          terminate: true,
          reason: notice,
        };
      }
      // 复现和足够的源码证据一旦同时存在，诊断已经完成。当前回合若继续发出
      // inspect/look 等调用，只会把模型留在搜索循环里；终止这一批后由 agent_end
      // 的固定 follow-up 直接要求 finish(proposed)。被门禁拒绝的调用不计入预算，
      // 因为它没有执行任何工具。
      if (
        !executionApproved
        && successfulFinishStatuses.has("reproduced")
        && sourceEvidenceReady
        && event.toolName !== "finish"
      ) {
        const notice = "复现和源码证据已经足够；当前诊断回合已停止，请立即调用 finish(status=proposed) 提交一次性修复方案，不要继续搜索。";
        context.ui.notify(notice, "info");
        return {
          block: true,
          terminate: true,
          reason: notice,
        };
      }
      // 方案、写入、最终 result 及一次必要重试必须始终有预算空间。若诊断已经
      // 消耗到保留区，只允许提交 proposed；其它调用在当前批次终止，避免模型把
      // 最后的执行预算浪费在继续搜索上。
      if (
        !executionApproved
        && successfulFinishStatuses.has("reproduced")
        && sourceEvidenceReady
        && event.toolName !== "finish"
        && repairToolCalls >= MAX_REPAIR_TOOL_CALLS - RESERVED_EXECUTION_TOOL_CALLS
      ) {
        const notice = "诊断预算已进入执行保留区；请立即调用 finish(status=proposed)，不要继续搜索。";
        context.ui.notify(notice, "info");
        return {
          block: true,
          terminate: true,
          reason: notice,
        };
      }
      repairToolCalls += 1;
      if (repairToolCalls > MAX_REPAIR_TOOL_CALLS) {
        budgetStopRequested = true;
        const notice = "本次修复请求已达到工具预算上限；正在要求 Agent 根据已有证据收尾。";
        context.ui.notify(notice, "warning");
        return {
          block: true,
          terminate: false,
          reason: notice,
        };
      }
    }
    turnToolCalls += 1;
    const toolFamily = event.toolName === "inspect"
      ? "inspect"
      : event.toolName === "tree" ? "tree"
        : ["look", "go", "use", "input_sql", "query"].includes(event.toolName) ? "game"
          : event.toolName === "patch" ? "patch"
            : ["check", "finish"].includes(event.toolName) ? "verify" : "other";
    const familyCalls = (toolFamilyCalls.get(toolFamily) ?? 0) + 1;
    toolFamilyCalls.set(toolFamily, familyCalls);
    const familyLimit = toolFamily === "inspect"
      ? repairRequested ? 10 : 8
      : toolFamily === "tree" ? 4
        : toolFamily === "game" ? 12
          : toolFamily === "patch" ? 4
            : toolFamily === "verify" ? 8 : 32;
    // 各阶段必须独立计数：定位阶段已经使用 inspect，不应吃掉后续第一个 look 的预算。
    // 仍保留单回合 32 次总上限，防止模型在多个工具族之间来回切换规避限制。
    const statusToolLimit = !repairRequested && turnToolCalls > MAX_STATUS_TOOL_CALLS;
    const statusInspectLimit = !repairRequested
      && toolFamily === "inspect"
      && familyCalls > MAX_STATUS_INSPECT_CALLS;
    if (
      statusToolLimit
      || statusInspectLimit
      || turnToolCalls > 32
      || familyCalls > familyLimit
    ) {
      const notice = "本轮读取预算已达到上限；正在根据已有证据自动收尾。";
      budgetStopRequested = true;
      context.ui.notify(notice, "warning");
      return {
        block: true,
        terminate: false,
        reason: notice,
      };
    }
    if (event.toolName === "finish" && repairRequested) {
      const status = finishStatus(event.input.status);
      if (status === "diagnosed") {
        return {
          block: true,
          terminate: false,
          reason: "用户要求解决问题，不能用 diagnosed 快速结束；请继续到 proposed、result，或在有客观证据时 blocked。",
        };
      }
      if (
        status === "proposed"
        && (
          !hasSufficientSourceEvidence()
          || (
            !successfulFinishStatuses.has("reproduced")
            && !failedCheckEvidence
          )
        )
      ) {
        return {
          block: true,
          terminate: false,
          reason: actionNotAvailableFailure
            && !successfulFinishStatuses.has("reproduced")
            && !failedCheckEvidence
            ? "源码诊断前必须先调用 finish(status=reproduced) 保存当前故障动作和修复后断言；不能直接跳到 proposed。"
            : actionNotAvailableFailure
              ? actionEvidenceInstruction()
              : "提交修复方案前必须有成功的 inspect(read) 源码读取证据，并由 search、第二次源码读取或 failed/blocked 检查交叉确认；同时必须保存 reproduced 或取得 failed/blocked 检查证据。",
        };
      }
      if (
        status === "blocked"
        && !failedGameEvidence
        && !failedCheckEvidence
      ) {
        return {
          block: true,
          terminate: false,
          reason: "没有失败的 go/use/input_sql/query 或 failed/blocked check 客观证据，不能把修复任务标为 blocked。",
        };
      }
    }
    if (
      event.toolName === "finish"
      && latestNaturalRequest.length > 0
      && !repairRequested
      && finishStatus(event.input.status) !== "diagnosed"
      && finishStatus(event.input.status) !== "blocked"
    ) {
      return {
        block: true,
        terminate: false,
        reason: "当前请求是状态/解释问题，不是修复请求；不能提交 proposed 或 result。请直接回答用户，或用 finish(status=diagnosed) 结束。",
      };
    }
    if (
      event.toolName === "check"
      || (event.toolName === "finish" && event.input.status === "result")
    ) {
      const failure = await refreshGateFailure();
      if (failure) {
        return {
          block: true,
          terminate: false,
          reason: "代码刷新门禁未通过：" + failure + " 请继续修复后重试。",
        };
      }
    }
    if (NATIVE_WRITE_TOOLS.has(event.toolName)) {
      if (!executionApproved) {
        return {
          block: true,
          terminate: true,
          reason: "完整修复方案尚未获用户确认，不能修改代码。",
        };
      }
      const pathFailure = await nativeWritePathFailure(task, event.toolName, event.input);
      if (pathFailure) {
        return {
          block: true,
          terminate: false,
          reason: pathFailure,
        };
      }
      const batch = nativeWriteBatch ?? {
        preparation: (async () => {
          const [baselineHash, reproduction, driver] = await Promise.all([
            hashWorktree(task.worktreeRoot),
            readActiveReproduction(store, task),
            gameRuntime.ensure(),
          ]);
          await driver.ensureReproductionCheckpoint();
          return {
            baselineHash,
            driver,
            actions: reproduction?.actions ?? [],
          };
        })(),
        pendingToolCallIds: new Set<string>(),
        flushPromise: null,
      };
      nativeWriteBatch = batch;
      try {
        await batch.preparation;
      } catch (error) {
        if (nativeWriteBatch === batch && batch.pendingToolCallIds.size === 0) {
          nativeWriteBatch = null;
        }
        return {
          block: true,
          terminate: false,
          reason: "写入前无法建立安全刷新检查点："
            + safeRefreshFailure(error),
        };
      }
      batch.pendingToolCallIds.add(event.toolCallId);
    }
    pendingLoopActions.set(event.toolCallId, guardedAction);
    return undefined;
  });

  pi.on("tool_result", async (event, context) => {
    const staleRun = !continuationController.activeRunIsCurrent();
    if (staleRun) pendingLoopActions.delete(event.toolCallId);
    const addedEvidence = staleRun ? false : recordLoopToolResult(event);
    if (addedEvidence) await markObjectiveProgress("tool-evidence-added", true);
    if (!staleRun && !event.isError) {
      const details = event.details && typeof event.details === "object"
        ? event.details as Record<string, unknown>
        : null;
      const evidenceText = inspectEvidenceText(event.content);
      if (event.toolName === "finish") {
        const status = finishStatus(details?.status);
        if (status) successfulFinishStatuses.add(status);
        if (status === "proposed") {
          approvedProposalInRun = details?.executionApproved === true;
          if (approvedProposalInRun) {
            budgetStopRequested = false;
            budgetStopAttempts = 0;
            repairToolCalls = Math.min(
              repairToolCalls,
              MAX_REPAIR_TOOL_CALLS - RESERVED_EXECUTION_TOOL_CALLS,
            );
          }
          if (details?.executionApproved === false) repairStopped = true;
        } else if (status === "result" || status === "blocked") {
          repairStopped = true;
          await recordContinuations(continuationController.invalidate(
            "cancelled",
            "finish-" + status,
          ));
        }
        if (
          !addedEvidence
          && (status === "reproduced" || status === "proposed")
        ) {
          await markObjectiveProgress("finish-" + status, false);
        }
      } else if (DIAGNOSTIC_EVIDENCE_TOOLS.has(event.toolName)) {
        if (
          event.toolName !== "inspect"
          || event.input.action === "read"
          || event.input.action === "search"
        ) repairEvidenceTools.add(event.toolName);
        if (
          event.toolName === "inspect"
          && (event.input.action === "read" || event.input.action === "search")
        ) {
          repairSourceEvidenceActions.add(event.input.action);
          if (event.input.action === "read") repairSourceReadCount += 1;
        }
        if (
          event.toolName === "check"
          && (details?.status === "failed" || details?.status === "blocked")
        ) failedCheckEvidence = true;
        if (
          GAME_FAILURE_EVIDENCE_TOOLS.has(event.toolName)
          && (
            details?.ok === false
            || /["']?ok["']?\s*:\s*false/u.test(evidenceText)
          )
        ) {
          if (
            details?.event === "action-not-available"
            || /action-not-available/u.test(evidenceText)
          ) {
            actionNotAvailableFailure = true;
            if (
              event.toolName === "use"
              && typeof event.input.actionId === "string"
              && event.input.actionId.trim()
            ) {
              actionNotAvailableActions.add(event.input.actionId.trim());
            }
          }
          failedGameEvidence = true;
          const signature = toolSignature(event.toolName, event.input);
          failedGameToolCalls.set(
            signature,
            (failedGameToolCalls.get(signature) ?? 0) + 1,
          );
        } else if (
          GAME_FAILURE_EVIDENCE_TOOLS.has(event.toolName)
          && details?.ok === true
        ) {
          failedGameToolCalls.delete(toolSignature(event.toolName, event.input));
        }
        if (
          event.toolName === "inspect"
          && (event.input.action === "read" || event.input.action === "search")
        ) {
          updateActionSourceEvidence(event.input, evidenceText);
        }
      }
    }
    if (!NATIVE_WRITE_TOOLS.has(event.toolName)) return undefined;
    const batch = nativeWriteBatch;
    if (!batch || !batch.pendingToolCallIds.delete(event.toolCallId)) {
      return undefined;
    }
    // Pi 的并行 native batch 会先触发全部 tool_call，再按完成顺序触发 tool_result；
    // 只有最后一个结果负责刷新，确保多个并行写入不会各自消费一次检查点。
    if (batch.pendingToolCallIds.size > 0) return undefined;
    const outcome = await flushNativeWriteBatch();
    if (!outcome?.changed) return undefined;
    publishRefreshOutcome(context, outcome);
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: outcome.text },
      ],
      ...(outcome.passed ? {} : { isError: true }),
    };
  });

  pi.on("session_start", async (_event, context) => {
    await assertTaskSessionBinding(context, task);
    if (task.state === "applied" || task.state === "discarded") {
      throw new Error("终态任务不能重新启动 Pi 会话");
    }
    if (task.state === "awaiting_approval") {
      // 进程中断时的确认框不能跨进程复用；恢复后清除摘要并回到 active，
      // 下一次 patch 会基于新正文重新申请一次性审批。
      task.approval = null;
      await store.transition(task, "active");
    } else if (task.state === "created" || task.state === "blocked") {
      await store.transition(task, "active");
    }
    setExecutionApproved(false);
    pi.setSessionName("SQL Dungeon · " + task.id.slice(0, 8));
    await gameRuntime.ensure();
    await appendEvent(store, task.id, "pi.session_start", {
      state: task.state,
    });
    context.ui.notify(
      "任务 " + task.id + " 已绑定；右侧游戏运行于 detached worktree",
      "info",
    );
  });

  pi.on("before_agent_start", async (event, context) => {
    // 每个模型回合都重新固定工具列表，防止 UI 设置或快捷键把内置能力重新激活。
    setExecutionApproved(executionApproved);
    const usage = context.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= 60) {
      context.ui.notify("上下文已超过 60%，请停止低价值搜索并使用已有证据摘要。", "warning");
    }
    const view = await gameRuntime.currentDriver()?.peek().catch(() => null) ?? null;
    const eventPrompt = typeof event.prompt === "string"
      ? normalizedRequest(event.prompt)
      : "";
    const currentRequest = latestNaturalRequest || eventPrompt || task.objective;
    const dynamicContext = [
      buildDungeonMaintainerPrompt(task),
      "",
      "本轮最高优先级请求：",
      currentRequest,
      "持久化任务目标只提供历史背景；若与本轮请求冲突，以本轮请求为准。",
      view ? "" : null,
      view ? "本轮开始时的右侧实时玩家投影（辅助上下文，不是新的用户请求）：" : null,
      view ? JSON.stringify(view) : null,
    ].filter((line): line is string => line !== null).join("\n");
    return { systemPrompt: dynamicContext };
  });

  pi.on("input", async (event) => {
    const text = event.text.trim();
    if (
      (event.source === "interactive" || event.source === "rpc")
      && text
      && !text.startsWith("/")
    ) {
      if (hasActiveWriteScope(task)) {
        setExecutionApproved(false);
        await store.closeWriteScope(task);
      }
      const continuation = isContinuationRequest(text)
        && (
          repairRequested
          || task.state === "verifying"
          || task.changedPaths.length > 0
          || task.checks.some((record) => record.status !== "passed")
        );
      await recordContinuations(beginNaturalRequest(
        continuation ? task.objective : text,
        continuation,
      ));
      if (
        task.objective === INITIAL_TASK_OBJECTIVE
        || (repairRequested && task.objective !== latestNaturalRequest)
      ) {
        task.objective = latestNaturalRequest;
        await store.save(task);
        await appendEvent(store, task.id, "task.objective_set", {
          length: task.objective.length,
          repairRequest: repairRequested,
        });
      }
    }
    return { action: "continue" };
  });

  pi.on("session_shutdown", async (event) => {
    await recordContinuations(continuationController.invalidate(
      "cancelled",
      "session-shutdown",
    )).catch(() => undefined);
    await gameRuntime.close();
    await appendEvent(store, task.id, "pi.session_shutdown", {
      reason: event.reason,
      state: task.state,
    });
  });
}

/**
 * 公开会话绑定断言，供安全测试和需要审计 Pi 上下文的调用方使用。
 *
 * @param context Pi Extension 上下文。
 * @param task 当前任务。
 * @returns 绑定成功时无返回值。
 */
export { assertTaskSessionBinding };

/** Pi `-e` 参数加载的默认 Extension Factory。 */
export default async function dungeonMaintainerExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const config = loadConfig();
  requireApiKey(config);
  const taskId = process.env.DUNGEON_MAINTAINER_TASK_ID?.trim();
  if (!taskId) throw new Error("缺少 DUNGEON_MAINTAINER_TASK_ID");
  const dataDir = process.env.DUNGEON_MAINTAINER_DATA_DIR?.trim()
    || config.dataDir;
  const store = new TaskStore(dataDir);
  const task = await store.read(taskId);
  installDungeonMaintainerExtension(pi, { config, store, task });
}
