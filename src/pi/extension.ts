/**
 * Dungeon Maintainer 的唯一 Pi Extension 装配入口。
 *
 * 本文件只负责把已验证的任务、Provider、固定工具/命令、系统提示和生命周期钩子装配
 * 到 Pi。会话安全策略由 `session-policy.ts` 负责，Vite/Chromium 生命周期由
 * `game-runtime.ts` 负责，补丁、检查、复现和 apply 仍属于各自 workspace/repair 模块。
 *
 * 输入是父进程已经校验并固定绑定的 TaskRecord、TaskStore、配置和可选测试运行时；输出是
 * 注册到 Pi 的十个领域工具、五个命令、系统提示和事件钩子，不返回可跨任务复用的运行时对象。
 * Pi 是唯一模型循环；Extension 只注入游戏上下文、记录低敏事实并执行确定性安全边界，
 * 不在 agent_settled 后创建隐藏请求，也不按证据数量替模型规划或自动暂停。
 *
 * 一个 Extension 实例始终绑定一个 taskId、一个 detached worktree、一个 Pi session 和
 * 一个游戏运行时。关闭时只停止浏览器与 Vite；未完成任务、日志和 worktree 继续保留供
 * `resume` 使用。所有写入仍受 detached worktree、realpath、一次性方案授权和刷新重放门禁；
 * API Key 只通过 Provider 的环境变量引用传递，不写入任务或事件文件。终态任务、过期授权
 * 或刷新恢复失败会拒绝危险操作，由当前 Agent 根据工具结果收敛或等待用户输入。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, requireApiKey, type MaintainerConfig } from "../config.js";
import { EvidenceStore } from "../evidence/store.js";
import { gameEvidence } from "../evidence/projector.js";
import {
  architectureRouteCard,
  loadArchitectureMap,
  routeArchitecture,
  type ArchitectureMap,
  type ArchitectureRoute,
} from "../inspection/architecture-map.js";
import type { GameDriver } from "../game/driver.js";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import type { SemanticTraceEntry } from "../logging/trace.js";
import {
  readActiveReproduction,
  reproductionNeedsSqlRefresh,
  type ReproductionRecord,
} from "../repair/reproduction.js";
import { replayReproduction } from "../repair/replay.js";
import {
  verifyTask as runTaskVerification,
  type VerificationResult,
} from "../repair/verification.js";
import { TaskStore } from "../task/store.js";
import {
  INITIAL_TASK_OBJECTIVE,
  type TaskRecord,
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
import { LoopGuard, stableDigest, type LoopAction } from "./loop-guard.js";
import { syncWorktreeChanges } from "../workspace/changes.js";
import { hashWorktree } from "../workspace/git.js";
import { resolveProjectPath } from "../workspace/policy.js";
import { assertWritePathAllowed, hasActiveWriteScope } from "../workspace/write-scope.js";

const NATIVE_WRITE_TOOLS = new Set(["write"]);
const WRITE_TOOLS = new Set(["write", "patch"]);
const LOOP_GUARD_TOOLS = new Set(["inspect", "patch", "write", "check", "finish"]);
const REPAIR_ACTION_PATTERN = /(?:修复|修好|解决|排查|诊断|定位|调查|纠正|改掉|处理|实现|增加|支持|fix|debug|diagnos)/iu;
const PROBLEM_PATTERN = /(?:问题|故障|错误|异常|bug|失败|不一致|不正确|不对|掉血|没法|无法|不能|看不见|卡住|崩溃|默认答案)/iu;
const STRONG_REPAIR_PATTERN = /(?:修复|修好|解决|改掉|fix)|(?:(?:默认\s*(?:答案|SQL|查询)|题目).{0,24}(?:错|错误|不对|不一致))/iu;
const GAME_FAILURE_EVIDENCE_TOOLS = new Set(["go", "use", "input_sql", "query"]);

interface DungeonGameRuntimePort {
  currentDriver(): GameDriver | null;
  requireDriver(): GameDriver;
  ensure(): Promise<GameDriver>;
  close(): Promise<void>;
}

interface NativeWritePreparation {
  baselineHash: string;
  driver: GameDriver | null;
  actions: readonly SemanticTraceEntry[];
  reproduction: ReproductionRecord | null;
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

/** Extension 安装所需的已验证任务事实。 */
export interface DungeonExtensionOptions {
  config: MaintainerConfig;
  store: TaskStore;
  task: TaskRecord;
  /** 测试可注入不启动外部进程的同契约运行时；生产环境始终使用真实运行时。 */
  gameRuntime?: DungeonGameRuntimePort;
  /** 测试可注入确定性验证器；生产环境始终调用 repair/verification。 */
  verifyTask?: (signal?: AbortSignal) => Promise<VerificationResult>;
  evidenceStore?: EvidenceStore;
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
  if (toolName !== "write") return null;
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

async function protectedWritePathFailure(
  task: TaskRecord,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (toolName === "write") return await nativeWritePathFailure(task, toolName, input);
  if (toolName !== "patch" || !Array.isArray(input.edits)) return null;
  for (const value of input.edits) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "patch 缺少合法 edits。";
    }
    const edit = value as Record<string, unknown>;
    if (typeof edit.path !== "string" || !edit.path.trim()) return "patch 缺少合法项目相对路径。";
    try {
      const scoped = assertWritePathAllowed(task, edit.path);
      await resolveProjectPath(task.worktreeRoot, scoped, "write");
    } catch (error) {
      return safeRefreshFailure(error);
    }
  }
  return null;
}

function loopActionFor(
  toolName: string,
  input: Record<string, unknown>,
  worktreeHash: string,
): LoopAction {
  return {
    toolName,
    input: {
      inputDigest: stableDigest(input),
      worktreeHash,
    },
    route: {
      toolName,
      worktreeHash,
      routeDigest: stableDigest(
        toolName === "inspect"
          ? { action: input.action, path: input.path, partitionId: input.partitionId }
          : { status: input.status, id: input.id },
      ),
    },
  };
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
  // TaskStore 已由入口绑定到权威任务目录；Evidence 必须跟随同一目录，否则隔离
  // Benchmark、测试注入或自定义数据目录会形成两套任务事实。
  const evidence = options.evidenceStore ?? new EvidenceStore(store.dataDir, task);
  const gameRuntime = options.gameRuntime ?? new DungeonGameRuntime(task, store);
  const verifyCurrentTask = options.verifyTask ?? (async (signal?: AbortSignal) => {
    return await runTaskVerification(
      store,
      evidence,
      task,
      gameRuntime.currentDriver(),
      signal,
    );
  });
  let executionApproved = false;
  let latestNaturalRequest = "";
  let repairRequested = false;
  let architectureMap: ArchitectureMap | null = null;
  let currentArchitectureRoute: ArchitectureRoute | null = null;
  const loopGuard = new LoopGuard();
  const pendingLoopActions = new Map<string, {
    action: LoopAction;
    actionDigest: string;
    preWorktreeHash: string;
  }>();
  const pendingLoopActionCounts = new Map<string, number>();
  const takePendingLoopAction = (toolCallId: string): {
    action: LoopAction;
    actionDigest: string;
    preWorktreeHash: string;
  } | null => {
    const pending = pendingLoopActions.get(toolCallId) ?? null;
    if (!pending) return null;
    pendingLoopActions.delete(toolCallId);
    const count = pendingLoopActionCounts.get(pending.actionDigest) ?? 0;
    if (count <= 1) pendingLoopActionCounts.delete(pending.actionDigest);
    else pendingLoopActionCounts.set(pending.actionDigest, count - 1);
    return pending;
  };
  const clearPendingLoopActions = (): void => {
    for (const toolCallId of [...pendingLoopActions.keys()]) {
      takePendingLoopAction(toolCallId);
    }
  };
  // inspect 执行阶段复用 tool_call 门禁已计算的 Hash，避免同一次外部调用再次
  // 扫描完整 worktree。结果事件或异常回合结束时会清理对应条目。
  const inspectWorktreeHashes = new Map<string, string>();

  const recordWriteOutcome = async (
    toolName: string,
    outcome: "rejected" | "failed" | "noop" | "mutated" | "mutated_replay_failed",
    worktreeHash: string,
    reasonCode: string,
  ): Promise<void> => {
    await appendEvent(store, task.id, "tool.write_outcome", {
      toolName,
      outcome,
      count: 1,
      worktreeHash: worktreeHash.slice(0, 16),
      reasonCode,
    });
  };

  const beginNaturalRequest = async (
    text: string,
    continuation = false,
  ): Promise<void> => {
    latestNaturalRequest = normalizedRequest(text);
    repairRequested = continuation || requiresRepair(latestNaturalRequest);
    await evidence.load();
    if (repairRequested && !continuation) {
      // 一个 taskId 可以承载多次用户输入，但新的修复目标不能继承上一 Bug 的
      // reproduction/claim/verification。项目级 Solution 仍保留；明确“继续”时则
      // 完整复用同一 Goal 的检查点。证据用于记忆与审计，不规定模型的调查顺序。
      await evidence.supersedeGoalEvidence();
      if (task.verification) {
        task.verification = null;
        await store.save(task);
      }
      if (task.state === "verifying") {
        await store.transition(task, "active");
      }
      loopGuard.resetForNewTask(evidence.revision);
    }
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
    evidence,
    architectureMap: () => architectureMap,
    architectureRoute: () => currentArchitectureRoute,
    inspectWorktreeHash: (toolCallId: string) => inspectWorktreeHashes.get(toolCallId),
    currentDriver: () => gameRuntime.currentDriver(),
    requireDriver: () => gameRuntime.requireDriver(),
    ensureGame: () => gameRuntime.ensure(),
    closeGame: () => gameRuntime.close(),
    approveExecution: () => setExecutionApproved(true),
    completeExecution: () => setExecutionApproved(false),
    isExecutionApproved: () => executionApproved,
    repairRequested: () => repairRequested,
    verifyTask: verifyCurrentTask,
  };
  registerMaintainerTools(pi, sharedContext);
  registerMaintainerCommands(pi, sharedContext);
  registerSessionPolicyHooks(pi, store, task);

  // 变换只发生在发给模型的临时上下文，不改原始 session/evidence store。
  pi.on("context", (event) => {
    return { messages: shapeModelContext(event.messages).messages };
  });

  let nativeWriteBatch: NativeWriteBatch | null = null;
  let lastRefreshFailure: string | null = null;

  const publishRefreshOutcome = (
    context: ExtensionContext,
    outcome: NativeRefreshOutcome,
  ): void => {
    context.ui.notify(outcome.text, outcome.passed ? "info" : "error");
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
        await syncWorktreeChanges(store, task, "native-tools", evidence);
        const replay = prepared.driver
          ? prepared.reproduction
            ? await replayReproduction(
              store,
              task,
              prepared.driver,
              prepared.reproduction,
              currentHash,
            )
            : await prepared.driver.reloadAndReplay([])
          : null;
        await appendEvent(store, task.id, "game.refresh", {
          replayed: replay !== null && prepared.actions.length > 0,
          passed: replay?.passed ?? true,
          actionCount: replay?.actionCount ?? 0,
        });
        refreshEventWritten = true;
        if (replay && !replay.passed) {
          throw new Error(replay.failure ?? "未知游戏错误");
        }
        lastRefreshFailure = null;
        return {
          changed: true,
          passed: true,
          text: replay
            ? "原生代码修改已同步；右侧游戏已刷新并重放 "
              + String(replay.actionCount)
              + " 个语义动作。"
            : "原生代码修改已同步；当前没有运行时复现，因此未启动浏览器。",
        };
      } catch (error) {
        if (prepared && !refreshEventWritten) {
          await appendEvent(store, task.id, "game.refresh", {
            replayed: prepared.driver !== null && prepared.actions.length > 0,
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

  pi.on("agent_end", async () => {
    // 这里只记录 Pi 的原生运行事实；不在 settled 后生成隐藏消息或第二套模型循环。
    await appendEvent(store, task.id, "pi.agent_end", { state: task.state });
  });
  pi.on("turn_end", async (_event, context) => {
    inspectWorktreeHashes.clear();
    // 正常写入在最后一个 native tool_result 中完成刷新；这里只处理取消或第三方
    // 扩展导致 tool_result 缺失的异常路径，不能再把正常刷新延迟到整轮结束。
    if (!nativeWriteBatch) {
      clearPendingLoopActions();
      return;
    }
    const pendingIds = [...nativeWriteBatch.pendingToolCallIds];
    nativeWriteBatch.pendingToolCallIds.clear();
    const outcome = await flushNativeWriteBatch();
    const finalHash = await hashWorktree(task.worktreeRoot);
    for (const toolCallId of pendingIds) {
      const pending = takePendingLoopAction(toolCallId);
      if (!pending) continue;
      const changed = finalHash !== pending.preWorktreeHash;
      await recordWriteOutcome(
        "write",
        changed
          ? outcome?.passed === false ? "mutated_replay_failed" : "mutated"
          : "failed",
        finalHash,
        changed
          ? outcome?.passed === false ? "refresh-replay-failed" : "worktree-mutated"
          : "tool-result-missing",
      );
      loopGuard.recordOutcome({
        action: pending.action,
        result: { toolResultMissing: true, worktreeHash: finalHash },
        evidenceRevision: evidence.revision,
        madeProgress: changed,
      });
    }
    clearPendingLoopActions();
    if (outcome?.changed) {
      publishRefreshOutcome(context, outcome);
    }
  });
  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown>;
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
    let preWorktreeHash: string | null = null;
    if (WRITE_TOOLS.has(event.toolName)) {
      preWorktreeHash = await hashWorktree(task.worktreeRoot);
      if (!executionApproved) {
        await recordWriteOutcome(
          event.toolName,
          "rejected",
          preWorktreeHash,
          "authorization-required",
        );
        return {
          block: true,
          terminate: false,
          reason: "完整修复方案尚未获用户确认，不能修改代码；请先提交 finish(status=proposed)，不要结束当前任务。",
        };
      }
      const pathFailure = await protectedWritePathFailure(task, event.toolName, input);
      if (pathFailure) {
        await recordWriteOutcome(event.toolName, "rejected", preWorktreeHash, "path-rejected");
        return {
          block: true,
          terminate: false,
          reason: pathFailure,
        };
      }
    }
    if (LOOP_GUARD_TOOLS.has(event.toolName)) {
      preWorktreeHash ??= await hashWorktree(task.worktreeRoot);
      const action = loopActionFor(event.toolName, input, preWorktreeHash);
      const actionDigest = stableDigest({ input: action.input, toolName: action.toolName });
      const pendingCount = pendingLoopActionCounts.get(actionDigest) ?? 0;
      const decision = pendingCount >= 2
        ? {
          kind: "block" as const,
          reason: "pending_action" as const,
          noProgressCount: pendingCount,
        }
        : loopGuard.evaluateAction(action);
      if (decision.kind !== "allow") {
        await appendEvent(store, task.id, "tool.loop_guard", {
          toolName: event.toolName,
          outcome: "blocked",
          count: decision.noProgressCount,
          worktreeHash: preWorktreeHash.slice(0, 16),
          reasonCode: decision.kind + "-" + decision.reason,
        });
        if (event.toolName === "inspect") {
          await appendEvent(store, task.id, "tool.inspect", {
            action: typeof input.action === "string" ? input.action : "unknown",
            outcome: "failure",
            expanded: false,
            bundleWindows: 0,
            floorRouteLevel: "none",
            floorScopeCount: 0,
          });
        }
        if (WRITE_TOOLS.has(event.toolName)) {
          await recordWriteOutcome(
            event.toolName,
            "rejected",
            preWorktreeHash,
            "loop-guard-" + decision.reason,
          );
        }
        return {
          block: true,
          terminate: decision.kind === "hard_stop",
          reason: decision.kind === "hard_stop"
            ? "循环门禁检测到持续无进展，已停止本轮工具执行。"
            : "循环门禁已阻止重复无进展动作；请使用现有证据更换路径或参数。",
        };
      }
      pendingLoopActions.set(event.toolCallId, { action, actionDigest, preWorktreeHash });
      pendingLoopActionCounts.set(actionDigest, pendingCount + 1);
      if (event.toolName === "inspect") {
        inspectWorktreeHashes.set(event.toolCallId, preWorktreeHash);
      }
    }
    if (NATIVE_WRITE_TOOLS.has(event.toolName)) {
      const batch = nativeWriteBatch ?? {
        preparation: (async () => {
          const [baselineHash, reproduction] = await Promise.all([
            hashWorktree(task.worktreeRoot),
            readActiveReproduction(store, evidence, task),
          ]);
          let driver = gameRuntime.currentDriver();
          if (reproduction && !driver) driver = await gameRuntime.ensure();
          await driver?.ensureReproductionCheckpoint();
          return {
            baselineHash,
            driver,
            actions: reproduction?.actions ?? [],
            reproduction,
          };
        })(),
        pendingToolCallIds: new Set<string>(),
        flushPromise: null,
      };
      nativeWriteBatch = batch;
      try {
        await batch.preparation;
      } catch (error) {
        takePendingLoopAction(event.toolCallId);
        if (nativeWriteBatch === batch && batch.pendingToolCallIds.size === 0) {
          nativeWriteBatch = null;
        }
        await recordWriteOutcome(
          event.toolName,
          "rejected",
          preWorktreeHash ?? await hashWorktree(task.worktreeRoot),
          "refresh-checkpoint-unavailable",
        );
        return {
          block: true,
          terminate: false,
          reason: "写入前无法建立安全刷新检查点："
            + safeRefreshFailure(error),
        };
      }
      batch.pendingToolCallIds.add(event.toolCallId);
    }
    return undefined;
  });

  pi.on("tool_result", async (event, context) => {
    const details = event.details && typeof event.details === "object"
      ? event.details as Record<string, unknown>
      : null;
    if (
      GAME_FAILURE_EVIDENCE_TOOLS.has(event.toolName)
      && typeof details?.ok === "boolean"
    ) {
      // 游戏事实只作任务内低敏遥测与恢复线索，不参与工具排序或继续/暂停决策。
      await evidence.capture(gameEvidence({
        toolName: event.toolName,
        actionId: event.input.actionId,
        target: event.input.target,
        ok: details.ok,
        event: details.event,
      }));
    }
    const pending = takePendingLoopAction(event.toolCallId);
    const postWorktreeHash = WRITE_TOOLS.has(event.toolName)
      ? await hashWorktree(task.worktreeRoot)
      : null;
    inspectWorktreeHashes.delete(event.toolCallId);
    const recordGuardResult = (madeProgress = false): void => {
      if (!pending) return;
      loopGuard.recordOutcome({
        action: pending.action,
        result: {
          isError: event.isError,
          ok: typeof details?.ok === "boolean" ? details.ok : null,
          status: typeof details?.status === "string" ? details.status : null,
          cacheHit: details?.cacheHit === true,
          receiptOnly: details?.receiptOnly === true,
          worktreeHash: postWorktreeHash ?? pending.preWorktreeHash,
        },
        evidenceRevision: evidence.revision,
        madeProgress,
      });
    };
    if (!NATIVE_WRITE_TOOLS.has(event.toolName)) {
      if (event.toolName === "patch" && pending && postWorktreeHash) {
        const changed = postWorktreeHash !== pending.preWorktreeHash;
        const replay = details?.replay && typeof details.replay === "object"
          ? details.replay as Record<string, unknown>
          : null;
        const refreshFailed = event.isError || replay?.passed === false;
        if (changed) {
          if (refreshFailed) {
            const failureText = event.content
              .map((item) => item.type === "text" ? item.text : "")
              .filter(Boolean)
              .join(" ");
            lastRefreshFailure = "精确补丁已写入，但右侧刷新重放未通过："
              + safeRefreshFailure(new Error(failureText || "未知补丁刷新错误"));
          } else if (replay?.passed === true) {
            // patch 自身的 afterPatch 已经完成刷新/重放；它与原生 write
            // 共享同一个门禁事实，因此成功修复必须清除上一轮刷新失败。
            lastRefreshFailure = null;
          }
        }
        const outcome = changed
          ? refreshFailed ? "mutated_replay_failed" : "mutated"
          : event.isError ? "failed" : "noop";
        await recordWriteOutcome(
          event.toolName,
          outcome,
          postWorktreeHash,
          changed
            ? refreshFailed ? "refresh-replay-failed" : "worktree-mutated"
            : event.isError ? "tool-execution-failed" : "worktree-unchanged",
        );
        recordGuardResult(changed);
      } else {
        recordGuardResult(false);
      }
      return undefined;
    }
    const batch = nativeWriteBatch;
    if (!batch || !batch.pendingToolCallIds.delete(event.toolCallId)) {
      if (pending && postWorktreeHash) {
        await recordWriteOutcome(event.toolName, "failed", postWorktreeHash, "write-batch-missing");
        recordGuardResult(false);
      }
      return undefined;
    }
    // Pi 的并行 native batch 会先触发全部 tool_call，再按完成顺序触发 tool_result；
    // 只有最后一个结果负责刷新，确保多个并行写入不会各自消费一次检查点。
    if (batch.pendingToolCallIds.size > 0) {
      if (pending && postWorktreeHash) {
        const changed = postWorktreeHash !== pending.preWorktreeHash;
        await recordWriteOutcome(
          event.toolName,
          changed ? "mutated" : event.isError ? "failed" : "noop",
          postWorktreeHash,
          changed ? "worktree-mutated" : event.isError
            ? "tool-execution-failed"
            : "worktree-unchanged",
        );
        recordGuardResult(changed);
      }
      return undefined;
    }
    const outcome = await flushNativeWriteBatch();
    if (pending && postWorktreeHash) {
      const classification = outcome?.changed
        ? outcome.passed ? "mutated" : "mutated_replay_failed"
        : event.isError ? "failed" : "noop";
      await recordWriteOutcome(
        event.toolName,
        classification,
        postWorktreeHash,
        outcome?.changed
          ? outcome.passed ? "worktree-mutated" : "refresh-replay-failed"
          : event.isError ? "tool-execution-failed" : "worktree-unchanged",
      );
      recordGuardResult(outcome?.changed ?? false);
    }
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
    } else if (
      task.state === "created"
      || task.state === "blocked"
      || task.state === "paused"
    ) {
      await store.transition(task, "active");
    }
    await evidence.load();
    loopGuard.resetForNewTask(evidence.revision);
    const architecture = await loadArchitectureMap(task.worktreeRoot);
    architectureMap = architecture.map;
    if (architecture.warning) context.ui.notify(architecture.warning, "warning");
    if (task.objective !== INITIAL_TASK_OBJECTIVE) {
      latestNaturalRequest = task.objective;
    }
    const restoredReproduction = await readActiveReproduction(store, evidence, task);
    if (restoredReproduction && reproductionNeedsSqlRefresh(restoredReproduction)) {
      // SQL 正文按隐私规则只存在旧 GameDriver 的内存中。新进程不能伪装能够重放，
      // 因此保留历史工件但移出 active 集合，下一次自然请求需要重新取得 SQL 复现。
      await evidence.supersedeReproductions();
      task.verification = null;
      await store.save(task);
      await appendEvent(store, task.id, "reproduction.refresh_required", {
        reason: "process-restart-sql-not-persisted",
      });
    }
    if (hasActiveWriteScope(task)) {
      // 方案授权只属于批准它的 Agent 运行；进程恢复不能静默继承写权限。
      await store.closeWriteScope(task);
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
      context.ui.notify("上下文已超过 60%，请停止低价值搜索并基于已有结果收敛。", "warning");
    }
    const view = await gameRuntime.currentDriver()?.peek().catch(() => null) ?? null;
    const eventPrompt = typeof event.prompt === "string"
      ? normalizedRequest(event.prompt)
      : "";
    const currentRequest = latestNaturalRequest || eventPrompt || task.objective;
    currentArchitectureRoute = routeArchitecture(architectureMap, currentRequest, view?.floor ?? null);
    const routeCard = architectureRouteCard(currentArchitectureRoute);
    const dynamicContext = [
      "本轮最高优先级请求：",
      currentRequest,
      "持久化任务目标只提供历史背景；若与本轮请求冲突，以本轮请求为准。",
      routeCard ? "" : null,
      routeCard,
      view ? "" : null,
      view ? "本轮开始时的右侧实时玩家投影（辅助上下文，不是新的用户请求）：" : null,
      view ? JSON.stringify(view) : null,
      task.changedPaths.length > 0 ? "当前 Agent 增量文件：" : null,
      task.changedPaths.length > 0 ? JSON.stringify(task.changedPaths) : null,
    ].filter((line): line is string => line !== null).join("\n");
    return {
      // 保留 Pi 已经根据项目 AGENTS/Skills 组装的基础 Prompt；只追加维护器固定规则。
      // 直接返回 buildDungeonMaintainerPrompt() 会覆盖项目上下文，导致 Benchmark 两个
      // Profile 的 Skills/Context 不一致。
      systemPrompt: event.systemPrompt + "\n\n" + buildDungeonMaintainerPrompt(),
      message: {
        customType: "dungeon-task-context",
        content: dynamicContext,
        display: false,
      },
    };
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
      if (task.state === "ready_to_apply") {
        // ready_to_apply 只证明上一请求的 worktree 已验证；新请求必须回到 active，
        // 并让新目标重新通过当前 Hash 门禁。
        task.verification = null;
        await store.transition(task, "active");
      }
      const hasFailedCheck = (await evidence.checks()).some((record) => record.status !== "passed");
      if (task.state === "paused") {
        // 兼容读取旧 schema v4 任务；新架构不会再自动写入 paused。
        await store.transition(task, "active");
      }
      const continuation = isContinuationRequest(text)
        && (
          repairRequested
          || task.state === "verifying"
          || task.changedPaths.length > 0
          || hasFailedCheck
        );
      await beginNaturalRequest(
        continuation ? task.objective : text,
        continuation,
      );
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
    // 关闭 Pi 只结束临时浏览器/Vite，不隐式取消持久化任务或修改正式仓库。
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
