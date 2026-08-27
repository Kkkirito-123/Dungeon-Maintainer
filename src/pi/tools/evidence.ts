/**
 * Pi `evidence` 固定证据回读工具。
 *
 * 本工具只查询当前任务 EvidenceStore 的低敏投影，不执行源码搜索、检查或写入，也不
 * 把回读旧事实作为无进展动作交给现有 LoopGuard。`list` 用于按状态和类型定位证据
 * ID；`get` 返回单节点关系和经目录白名单、realpath、二次脱敏及 4 KiB 限制处理后的
 * 工件尾部，不能读取其它任务数据。
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

export type EvidenceInput = Static<typeof EvidenceParameters>;

/** 注册证据工具所需的当前任务依赖。 */
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

/** 向单个 Pi 会话注册受限证据回读工具。 */
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
      "先用 evidence(list) 定位最近 active 证据；只有确实需要正文时才 evidence(get)。",
      "evidence 只回读现有事实，不代替 inspect、check、复现或 finish(result) 验证。",
      "inspect 返回 ALREADY_SEEN evidence ID 时优先 get，不要重复执行相同搜索或读取。",
      "不要遍历证据节点；列表摘要足以确认根因时直接调用 finish。",
    ],
    executionMode: "sequential",
    parameters: EvidenceParameters,
    async execute(_toolCallId, input: EvidenceInput, signal) {
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
        await appendEvent(context.store, context.task.id, "tool.evidence", {
          action: "list",
          count: output.records.length,
          revision: output.revision,
        });
        return {
          content: [{
            type: "text",
            text: [
              "[EVIDENCE_LIST revision=" + String(output.revision)
                + " count=" + String(output.records.length) + "]",
              ...output.records.map(nodeText),
            ].join("\n"),
          }],
          details: { action: "list", ...output },
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
      await appendEvent(context.store, context.task.id, "tool.evidence", {
        action: "get",
        artifactAvailable: detail.artifact.available,
        revision: detail.revision,
      });
      const artifact = detail.artifact.available
        ? [
            "[ARTIFACT kind=" + detail.artifact.kind
              + " truncated=" + String(detail.artifact.truncated) + "]",
            detail.artifact.text,
          ].join("\n")
        : "[ARTIFACT unavailable reason=" + detail.artifact.reason + "]";
      return {
        content: [{
          type: "text",
          text: nodeText(detail.record) + "\n" + artifact,
        }],
        details: { action: "get", ...detail, records: [] },
      };
    },
  });
}
