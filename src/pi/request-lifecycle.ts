/**
 * 单个 Pi 请求与会话的状态生命周期。
 *
 * 本模块持有当前自然语言目标和“是否要求修复”这一请求级状态，负责会话恢复、请求
 * 切换、Prompt 追加、Agent 收敛和进程关闭。它不执行代码写入或刷新；请求结束时只
 * 通过注入的回调撤销授权并清理由写入协调器持有的临时归因。
 */

import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { gameEvidence } from "../evidence/projector.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { GameDriver } from "../game/driver.js";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import {
  readActiveReproduction,
  reproductionNeedsSqlRefresh,
} from "../repair/reproduction.js";
import type { TaskStore } from "../task/store.js";
import {
  INITIAL_TASK_OBJECTIVE,
  type TaskRecord,
} from "../task/types.js";
import { hasActiveWriteScope } from "../workspace/write-scope.js";
import { buildDungeonMaintainerPrompt } from "./prompt.js";
import { assertTaskSessionBinding } from "./session-policy.js";

const REPAIR_ACTION_PATTERN = /(?:修复|修好|解决|排查|诊断|定位|调查|纠正|改掉|处理|实现|增加|支持|fix|debug|diagnos)/iu;
const PROBLEM_PATTERN = /(?:问题|故障|错误|异常|bug|失败|不一致|不正确|不对|掉血|没法|无法|不能|看不见|卡住|崩溃|默认答案)/iu;
const STRONG_REPAIR_PATTERN = /(?:修复|修好|解决|改掉|fix)|(?:(?:默认\s*(?:答案|SQL|查询)|题目).{0,24}(?:错|错误|不对|不一致))/iu;
const GAME_FAILURE_EVIDENCE_TOOLS = new Set(["go", "use", "input_sql", "query"]);

interface RequestGameRuntime {
  ensure(): Promise<GameDriver>;
  close(): Promise<void>;
}

export interface RequestLifecycleOptions {
  pi: ExtensionAPI;
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  gameRuntime: RequestGameRuntime;
  isExecutionApproved: () => boolean;
  setExecutionApproved: (approved: boolean) => void;
  clearWriteAttributions: () => void;
}

/** 与一个 Pi session 绑定的请求和会话处理函数。 */
export interface RequestLifecycle {
  repairRequested(): boolean;
  onSessionStart(event: SessionStartEvent, context: ExtensionContext): Promise<void>;
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    context: ExtensionContext,
  ): BeforeAgentStartEventResult;
  onInput(event: InputEvent): Promise<InputEventResult>;
  onAgentEnd(event: AgentEndEvent): Promise<void>;
  onAgentSettled(event: AgentSettledEvent): Promise<void>;
  onToolResult(event: ToolResultEvent): Promise<void>;
  onSessionShutdown(event: SessionShutdownEvent): Promise<void>;
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

/** 创建单任务请求生命周期；返回值由 Extension 入口显式注册到 Pi hooks。 */
export function createRequestLifecycle(
  options: RequestLifecycleOptions,
): RequestLifecycle {
  const {
    pi,
    task,
    store,
    evidence,
    gameRuntime,
    isExecutionApproved,
    setExecutionApproved,
    clearWriteAttributions,
  } = options;
  let latestNaturalRequest = "";
  let repairRequested = false;

  const beginNaturalRequest = async (
    text: string,
    continuation = false,
  ): Promise<void> => {
    latestNaturalRequest = normalizedRequest(text);
    repairRequested = continuation || requiresRepair(latestNaturalRequest);
    await evidence.load();
    if (repairRequested && !continuation) {
      // 一个 taskId 可以承载多次用户输入，但新的修复目标不能继承上一 Bug 的
      // reproduction/claim/verification；明确“继续”时完整复用同一 Goal 的检查点。
      // 证据用于记忆与审计，不规定模型的调查顺序。
      await evidence.supersedeGoalEvidence();
      if (task.verification) {
        task.verification = null;
        await store.save(task);
      }
      if (task.state === "verifying") {
        await store.transition(task, "active");
      }
    }
  };

  const onSessionStart = async (
    event: SessionStartEvent,
    context: ExtensionContext,
  ): Promise<void> => {
    void event;
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
  };

  const onBeforeAgentStart = (
    event: BeforeAgentStartEvent,
    context: ExtensionContext,
  ): BeforeAgentStartEventResult => {
    // 每个模型回合都重新固定工具列表，防止 UI 设置或快捷键把内置能力重新激活。
    setExecutionApproved(isExecutionApproved());
    const usage = context.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= 60) {
      context.ui.notify("上下文已超过 60%，请停止低价值搜索并基于已有结果收敛。", "warning");
    }
    return {
      // 保留 Pi 已经根据项目 AGENTS/Skills 组装的基础 Prompt；只追加维护器固定规则。
      // 直接返回 buildDungeonMaintainerPrompt() 会覆盖项目上下文，导致 Eval 两个
      // Profile 的 Skills/Context 不一致。
      systemPrompt: event.systemPrompt + "\n\n" + buildDungeonMaintainerPrompt(),
    };
  };

  const onInput = async (event: InputEvent): Promise<InputEventResult> => {
    const text = event.text.trim();
    if (
      (event.source === "interactive" || event.source === "rpc")
      && text
      && !text.startsWith("/")
    ) {
      if (event.streamingBehavior !== undefined) {
        // steer/follow-up 沿用 Pi 当前回合，并更新本轮自然语言目标。
        latestNaturalRequest = normalizedRequest([
          latestNaturalRequest,
          "追加要求：",
          text,
        ].filter(Boolean).join(" "));
        repairRequested = repairRequested || requiresRepair(text);
        return { action: "continue" };
      }
      const inheritedWriteScope = hasActiveWriteScope(task);
      // 新请求先撤销上一请求的运行时授权，再执行任何可能失败的日志或证据 I/O。
      if (isExecutionApproved() || inheritedWriteScope) setExecutionApproved(false);
      if (inheritedWriteScope) await store.closeWriteScope(task);
      if (task.state === "ready_to_apply") {
        // ready_to_apply 只证明上一请求的 worktree 已验证；新请求必须回到 active，
        // 并让新目标重新通过当前 Hash 门禁。
        task.verification = null;
        await store.transition(task, "active");
      }
      const hasFailedCheck = (await evidence.checks()).some(
        (record) => record.status !== "passed",
      );
      if (task.state === "paused") {
        // 当前任务格式仍可能包含 paused 终态，但新 Agent Loop 不再自动写入它。
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
  };

  const onAgentEnd = async (): Promise<void> => {
    // 这里只记录 Pi 的原生运行事实；不在 settled 后生成隐藏消息或第二套模型循环。
    await appendEvent(store, task.id, "pi.agent_end", { state: task.state });
  };

  const onAgentSettled = async (): Promise<void> => {
    // 与 Pi 原生一致：没有下一次工具调用就结束当前回合。这里只回收本轮临时写权限，
    // 不自动刷新、运行测试或验证；模型若未提交 finish(result)，用户可稍后显式 /verify。
    const inheritedWriteScope = hasActiveWriteScope(task);
    // 收权是安全状态变化，必须早于日志和遥测 I/O。即使后续持久化失败，当前
    // Extension 也不能继续持有上一请求的原生 write/patch 执行授权。
    if (isExecutionApproved() || inheritedWriteScope) setExecutionApproved(false);
    clearWriteAttributions();
    if (inheritedWriteScope) await store.closeWriteScope(task);
  };

  const onToolResult = async (event: ToolResultEvent): Promise<void> => {
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
    } else if (event.toolName === "look" && details !== null) {
      // look 只保存楼层/模式这一类低敏玩家投影摘要，不把完整实时状态复制进证据账本。
      await evidence.capture(gameEvidence({
        toolName: event.toolName,
        ok: true,
        event: typeof details.mode === "string" ? details.mode : "look",
      }));
    }
  };

  const onSessionShutdown = async (event: SessionShutdownEvent): Promise<void> => {
    // 关闭 Pi 只结束临时浏览器/Vite，不隐式取消持久化任务或修改正式仓库。
    await gameRuntime.close();
    await appendEvent(store, task.id, "pi.session_shutdown", {
      reason: event.reason,
      state: task.state,
    });
  };

  return {
    repairRequested: () => repairRequested,
    onSessionStart,
    onBeforeAgentStart,
    onInput,
    onAgentEnd,
    onAgentSettled,
    onToolResult,
    onSessionShutdown,
  };
}
