/**
 * 黑盒诊断 Harness 的稳定领域契约。
 *
 * 本模块只描述环境适配器、场景、脱敏步骤、隐藏验证结果和最终报告，不创建模型、
 * 浏览器或任务 worktree。适配器可以暴露不同的确定性动作，但必须把模型可见信息
 * 收敛为有限轨迹，把隐藏裁判收敛为不含答案、地图和凭据的断言。任何新环境都要在
 * 维护器源码中静态注册，目标仓库配置不能注入工具、命令或权限。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { CheckCatalog } from "../tools/check.js";
import type { HarnessEvent } from "./events.js";

/** Harness 能区分的客观终态；游戏问题与 Agent 自身失败必须分开。 */
export type HarnessStatus =
  | "PASS"
  | "FAIL_ENV"
  | "FAIL_AGENT"
  | "BLOCKED_TOOL"
  | "BLOCKED_ENV"
  | "LIMIT_REACHED";

/** 左侧实时面板公开的工作阶段，不包含模型隐藏思维。 */
export type HarnessPhase = "observe" | "plan" | "act" | "verify" | "finding" | "fix" | "check";

/** 一个由适配器静态定义的诊断场景。 */
export interface HarnessScenario {
  /** 跨运行稳定的短 ID；修改场景语义时必须同时提升适配器版本。 */
  id: string;
  /** 面向人的场景名称，只用于 CLI 与报告。 */
  label: string;
  /** 模型收到的固定目标，不得包含隐藏裁判事实。 */
  goal: string;
}

/** 模型可见动作完成后的有限尾迹；不得扩展为完整页面或内部快照。 */
export interface HarnessTrace {
  objective: string;
  state: string;
  note: string;
  actions: string[];
}

/** 适配器在一个确定性动作后交给 Runner 的步骤草稿。 */
export interface HarnessStepDraft {
  action: string;
  event: string;
  ok: boolean;
  ms: number;
  /** 环境相关的有界工作量，例如真实移动步数。 */
  units: number;
  state: string;
  trace: HarnessTrace;
}

/** 报告中的单个可审计步骤。 */
export interface HarnessStep extends HarnessStepDraft {
  id: number;
  scenarioId: string;
}

/** 隐藏验证器返回的有限事实；这些事实用于判定，不作为下一步模型提示。 */
export interface HarnessVerdict {
  passed: boolean;
  summary: string;
  metrics: Record<string, string | number | boolean>;
  facts: string[];
}

/** 单场景的报告结果。 */
export interface HarnessScenarioReport {
  id: string;
  label: string;
  status: HarnessStatus;
  ms: number;
  cached: boolean;
  actions: number;
  units: number;
  failures: number;
  summary: string;
  evidence: number[];
  verdict: HarnessVerdict;
}

/** 一次 Harness 运行的模型用量。 */
export interface HarnessUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** 通用 JSON、Markdown 与 NDJSON 报告契约。 */
export interface HarnessReport {
  schemaVersion: 1;
  runId: string;
  adapter: { id: string; version: number; title: string };
  status: HarnessStatus;
  codeHash: string;
  startedAt: string;
  finishedAt: string;
  scenarios: HarnessScenarioReport[];
  steps: HarnessStep[];
  summary: string;
  usage: HarnessUsage;
  reportPath: string;
}

/** 决策缓存的适配器策略；只有通过净化器的确定性环境动作可以落盘。 */
export interface DecisionCachePolicy {
  readonly tools: readonly string[];
  /**
   * 校验并复制可缓存参数。
   * @param tool 模型选择的工具名。
   * @param args Provider 返回的未知参数。
   * @returns 仅含无敏感信息 JSON 的参数；不可缓存时返回 null。
   */
  sanitize(tool: string, args: unknown): Record<string, JsonValue> | null;
}

/** 实时事件接收器；事件只能包含阶段、动作、状态和用量。 */
export type HarnessEventSink = (event: HarnessEvent) => void | Promise<void>;

/** 适配器工具获得的唯一回调面。 */
export interface HarnessToolContext {
  emit: HarnessEventSink;
  record(step: HarnessStepDraft): void;
}

/** 一次隔离环境会话。 */
export interface HarnessSession {
  /** 打开一个独立场景；失败时不得留下用户浏览器数据。 */
  openScenario(scenario: HarnessScenario): Promise<void>;
  /** 为当前场景创建固定工具，模型不能动态增加工具。 */
  tools(context: HarnessToolContext): AgentTool[];
  /** 读取隐藏验证结果；返回值不会追加到模型 transcript。 */
  verdict(scenario: HarnessScenario, steps: readonly HarnessStep[]): Promise<HarnessVerdict>;
  /** Dashboard 对当前状态做健康复测，不要求完成整层；缺失时沿用完整场景裁判。 */
  probeVerdict?(scenario: HarnessScenario, steps: readonly HarnessStep[]): Promise<HarnessVerdict>;
  /** 在源码写入前建立只存在于临时浏览器上下文的一次性恢复点。 */
  checkpoint?(): Promise<void>;
  /** 补丁后重新载入当前环境。 */
  reload(): Promise<void>;
  /** 将脱敏事件送到环境自带的可视化面板。 */
  emit(event: HarnessEvent): Promise<void>;
  /** 保存已隐藏敏感区域的客观截图。 */
  screenshot(path: string): Promise<void>;
  /** 回收浏览器、服务和临时资源；必须可重复调用。 */
  close(): Promise<void>;
}

/** 创建隔离环境会话所需的通用参数。 */
export interface HarnessSessionOptions {
  repoRoot: string;
  output: string;
  headed: boolean;
  url?: string;
  signal?: AbortSignal;
}

/** 静态环境适配器；目标项目只能按 ID 选择，不能改变其实现。 */
export interface HarnessAdapter {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  /** 适配器源码静态登记的检查目录。 */
  readonly checks: CheckCatalog;
  readonly decisionCache: DecisionCachePolicy;
  /** 根据稳定场景 ID 返回有序场景，未知 ID 必须拒绝。 */
  scenarios(ids: readonly string[]): HarnessScenario[];
  /** 返回稳定系统提示；提示只说明角色边界，不携带运行时隐藏事实。 */
  systemPrompt(scenario: HarnessScenario): string;
  /** 创建临时会话；实现必须限制本机地址并隔离持久化。 */
  open(options: HarnessSessionOptions): Promise<HarnessSession>;
}
