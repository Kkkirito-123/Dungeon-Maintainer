/**
 * 当前任务 Evidence 的受限查询适配层。
 *
 * 正式九工具协议通过 `inspect(evidence_list/evidence_get)` 复用本文件的执行器，不会额外
 * 注册第十个模型工具；独立注册函数只为需要相同契约的内部调用保留。本层只查询当前任务
 * EvidenceStore 的低敏投影，不执行源码搜索、检查或写入。
 * `list` 用于按状态和类型定位证据 ID；`get` 返回单节点关系和经目录白名单、realpath、
 * 二次脱敏及 4 KiB 限制处理后的工件尾部，不能读取其它任务数据。输入是模型提供的
 * 查询条件，输出是可展示文本和结构化详情；唯一副作用是追加不含工件正文的审计事件。
 * Evidence 目录缺失、ID 越界或取消会显式失败，调用方可重新 list 后定向读取。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  getEvidenceDetail,
  listEvidenceNodes,
  type EvidenceNode,
} from "../../evidence/view.js";
import type { EvidenceStore } from "../../evidence/store.js";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";

const EvidenceKindParameter = Type.Union([
  Type.Literal("source"),
  Type.Literal("game"),
  Type.Literal("check"),
  Type.Literal("reproduction"),
  Type.Literal("claim"),
  Type.Literal("change"),
  Type.Literal("verification"),
]);

const EvidenceStatusParameter = Type.Union([
  Type.Literal("active"),
  Type.Literal("stale"),
  Type.Literal("superseded"),
  Type.Literal("all"),
]);

/**
 * `evidence` 工具参数必须以 object 为根节点。
 *
 * DeepSeek 的 OpenAI-compatible 函数接口拒绝顶层 `anyOf`/`oneOf`（Type.Union 会生成
 * 这种 Schema），因此这里使用一个兼容根对象，再在执行层按 action 严格校验 list/get
 * 的参数集合。这样既保留运行时边界，也不会让整个模型回合在工具注册阶段被 400 拒绝。
 */
export const EvidenceParameters = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("get")]),
  status: Type.Optional(EvidenceStatusParameter),
  kind: Type.Optional(EvidenceKindParameter),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  evidenceId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{16}$" })),
}, { additionalProperties: false });

/** `EvidenceParameters` 对应的已校验 TypeScript 输入；执行前仍会校验 action 专属字段。 */
export type EvidenceInput = Static<typeof EvidenceParameters>;

/**
 * 证据查询所需的当前任务依赖。
 *
 * `task` 提供唯一任务身份，`store` 只记录低敏调用事件，`evidence` 只允许访问该任务的
 * 证据目录。三者必须由同一个 Extension 生命周期创建。
 */
export interface EvidenceToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
}

function nodeText(node: EvidenceNode): string {
  const location = node.path
    ? " path=" + node.path
      + (node.startLine ? ":" + String(node.startLine) : "")
      + (node.lineCount ? "+" + String(node.lineCount) : "")
    : "";
  const version = node.baseHash
    ? " baseHash=" + node.baseHash
    : node.worktreeHash ? " worktreeHash=" + node.worktreeHash : "";
  return "[" + node.kind + "/" + node.status + "] id=" + node.id
    + location
    + version
    + (node.upstreamIds.length > 0 ? " upstream=" + node.upstreamIds.join(",") : "")
    + (node.downstreamIds.length > 0 ? " downstream=" + node.downstreamIds.join(",") : "")
    + "\n" + node.summary;
}

/**
 * 查询当前任务的证据列表或单条安全详情。
 *
 * @param context 与当前 taskId 绑定的 EvidenceStore 及任务依赖。
 * @param input 已通过根对象 Schema 校验的 list/get 请求。
 * @param signal 可选取消信号；开始访问存储前立即检查。
 * @returns Pi 工具响应形状；正文是低敏投影，details 供 inspect 复用和事件统计。
 * @throws action 专属字段组合无效、证据 ID 不属于当前任务、工件读取失败或请求已取消时抛错。
 * @remarks 本函数不创建或更新 Evidence 节点，也不会读取白名单以外的工件路径。
 */
export async function executeEvidenceQuery(
  context: EvidenceToolContext,
  input: EvidenceInput,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (input.action === "list") {
    if (input.evidenceId !== undefined) {
      throw new Error("evidence(list) 不接受 evidenceId");
    }
    const output = await listEvidenceNodes(context.evidence, {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return {
      content: [{
        type: "text" as const,
        text: [
          "[EVIDENCE_LIST revision=" + String(output.revision)
            + " count=" + String(output.records.length) + "]",
          ...output.records.map(nodeText),
        ].join("\n"),
      }],
      details: { action: "list", ...output } as Record<string, unknown>,
    };
  }
  if (input.status !== undefined || input.kind !== undefined || input.limit !== undefined) {
    throw new Error("evidence(get) 只接受 evidenceId");
  }
  if (input.evidenceId === undefined) {
    throw new Error("evidence(get) 缺少 evidenceId");
  }
  const detail = await getEvidenceDetail(context.evidence, input.evidenceId);
  if (!detail) throw new Error("evidenceId 不属于当前任务");
  const artifact = detail.artifact.available
    ? [
        "[ARTIFACT kind=" + detail.artifact.kind
          + " truncated=" + String(detail.artifact.truncated) + "]",
        detail.artifact.text,
      ].join("\n")
    : "[ARTIFACT unavailable reason=" + detail.artifact.reason + "]";
  return {
    content: [{
      type: "text" as const,
      text: nodeText(detail.record) + "\n" + artifact,
    }],
    details: { action: "get", ...detail, records: [] } as Record<string, unknown>,
  };
}

/**
 * 向单个 Pi 会话独立注册受限证据回读工具。
 *
 * @param pi 当前 Extension API。
 * @param context 与单个 taskId 绑定的只读证据依赖。
 * @returns 无返回值；注册后执行结果由 `executeEvidenceQuery` 生成。
 * @throws 工具名冲突时同步抛错；查询错误和取消在具体工具调用中向 Pi 返回失败。
 * @remarks 正式 Maintainer 装配不会调用本函数，而由 `inspect` 直接复用执行器；成功查询后
 * 只记录 action、数量和 revision，不把证据正文复制进事件日志。
 */
export function registerEvidenceTool(
  pi: ExtensionAPI,
  context: EvidenceToolContext,
): void {
  pi.registerTool({
    name: "evidence",
    label: "查看证据链",
    description: "列出当前任务证据，或按 evidence ID 回读关系和安全工件尾部。",
    promptSnippet: "用 evidence 复用当前任务已经取得的证据",
    promptGuidelines: [
      "当前上下文已有 evidence ID 时直接 evidence(get)；只有不知道 ID 或需要按类型筛选时才 list。",
      "evidence 只回读现有事实，不代替 inspect、check、复现或 finish(result) 验证。",
      "inspect 返回 ALREADY_SEEN evidence ID 时优先 get，不要重复执行相同搜索或读取。",
      "不要遍历证据节点；列表摘要足以确认根因时直接调用 finish。",
    ],
    executionMode: "sequential",
    parameters: EvidenceParameters,
    async execute(_toolCallId, input: EvidenceInput, signal) {
      const output = await executeEvidenceQuery(context, input, signal);
      // 事件只保留可聚合的标量。证据摘要和工件正文已经受各自存储边界管理，不能在
      // events.jsonl 中再次持久化，以免日志绕过脱敏和 4 KiB 读取限制。
      await appendEvent(context.store, context.task.id, "tool.evidence", {
        action: input.action,
        count: Array.isArray(output.details.records) ? output.details.records.length : 0,
        revision: Number(output.details.revision),
      });
      return output;
    },
  });
}
