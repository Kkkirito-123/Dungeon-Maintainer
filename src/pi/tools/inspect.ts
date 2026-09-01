/** Pi `inspect` 工具的参数契约、动作分发、注册和遥测。 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EvidenceStore } from "../../evidence/store.js";
import { inspectBundle } from "../../inspection/bundle.js";
import { MAX_READ_LINES } from "../../inspection/output.js";
import {
  captureInspectionText,
  findCachedInspection,
  inspectReadMany,
  inspectReadRange,
  type InspectionContext,
} from "../../inspection/read.js";
import {
  listProjectFiles,
  planSearchScope,
  runScopedSearch,
  suggestReadRanges,
} from "../../inspection/search.js";
import type { InspectDetails, InspectInput } from "../../inspection/types.js";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import { hashWorktree, readRepo, worktreeDiff } from "../../workspace/git.js";
import { withProgress } from "../../progress/reporter.js";
import { executeEvidenceQuery, type EvidenceInput } from "./evidence.js";

/** `inspect` 的严格参数契约。 */
export const InspectParameters = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("files"),
    Type.Literal("bundle"),
    Type.Literal("search"),
    Type.Literal("read"),
    Type.Literal("read_many"),
    Type.Literal("diff"),
    Type.Literal("evidence_list"),
    Type.Literal("evidence_get"),
  ], {
    description: "定位源码默认选择 bundle；它会一次搜索并返回带 baseHash 的相关源码窗口。只有 bundle 上下文不足时才选择 search/read/read_many。",
  }),
  path: Type.Optional(Type.String({ maxLength: 300 })),
  query: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 160,
    description: "bundle/search 的搜索词；首次源码定位应与 action=bundle 一起使用。",
  })),
  startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
  ranges: Type.Optional(Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 300 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 4 })),
  status: Type.Optional(Type.Union([
    Type.Literal("active"),
    Type.Literal("stale"),
    Type.Literal("superseded"),
    Type.Literal("all"),
  ])),
  kind: Type.Optional(Type.Union([
    Type.Literal("source"),
    Type.Literal("game"),
    Type.Literal("check"),
    Type.Literal("reproduction"),
    Type.Literal("claim"),
    Type.Literal("change"),
    Type.Literal("verification"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  evidenceId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{16}$" })),
}, { additionalProperties: false });

/** 注册工具所需的单任务依赖。 */
export interface InspectToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
}

/** 执行一次受限只读检查。 */
export async function inspectTask(
  context: InspectToolContext,
  input: InspectInput,
  signal?: AbortSignal,
): Promise<{ text: string; details: InspectDetails }> {
  signal?.throwIfAborted();
  const inspectionContext: InspectionContext = {
    root: context.task.worktreeRoot,
    evidence: context.evidence,
  };
  if (input.action === "read") {
    if (!input.path) throw new Error("read 必须提供 path");
    return await inspectReadRange(inspectionContext, {
      path: input.path,
      ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
      ...(input.lineCount === undefined ? {} : { lineCount: input.lineCount }),
    }, signal);
  }
  if (input.action === "read_many") {
    return await inspectReadMany(inspectionContext, input, signal);
  }

  const worktreeHash = await hashWorktree(inspectionContext.root);
  const scopePlan = input.action === "search" || input.action === "bundle"
    ? planSearchScope(input)
    : { roots: [] };
  const plannedScope = input.action === "search" || input.action === "bundle"
    ? scopePlan.roots.length > 0 ? scopePlan.roots : ["."]
    : [];
  const cached = await findCachedInspection(
    inspectionContext,
    input,
    plannedScope,
    worktreeHash,
  );
  if (cached) return cached;

  let raw: string;
  let scope: string[] = [];
  let matchCount: number | undefined;
  let complete: boolean | undefined;
  if (input.action === "status") {
    const state = await readRepo(inspectionContext.root);
    raw = [
      "HEAD " + state.head,
      "CLEAN " + String(state.clean),
      state.status || "(clean)",
    ].join("\n");
  } else if (input.action === "files") {
    raw = await listProjectFiles(inspectionContext.root, input.path ?? ".");
  } else if (input.action === "search" || input.action === "bundle") {
    if (!input.query) throw new Error("search 必须提供 query");
    const search = await runScopedSearch(inspectionContext.root, input.query, scopePlan);
    scope = search.scope;
    matchCount = search.matchCount;
    complete = search.complete;
    if (input.action === "bundle") {
      return await inspectBundle(inspectionContext, input, search, worktreeHash, signal);
    }
    const suggestions = suggestReadRanges(search.text);
    raw = [
      "[SEARCH_RECEIPT scope=" + scope.join(",")
        + " matches=" + String(matchCount)
        + " complete=" + String(complete)
        + "]",
      suggestions.length > 0 ? "suggestedRanges=" + suggestions.join(",") : "suggestedRanges=(none)",
      search.text || "(no matches)",
    ].join("\n");
  } else {
    raw = await worktreeDiff(inspectionContext.root);
  }
  signal?.throwIfAborted();
  return await captureInspectionText(inspectionContext, input, raw, {
    baseHash: null,
    worktreeHash,
    scope,
    ...(matchCount === undefined ? {} : { matchCount }),
    ...(complete === undefined ? {} : { complete }),
  });
}

/** 向单个 Pi 会话注册 `inspect`。 */
export function registerInspectTool(
  pi: ExtensionAPI,
  context: InspectToolContext,
): void {
  pi.registerTool({
    name: "inspect",
    label: "检查代码",
    description: "查看 Git 状态、源码、当前 Diff，或列出/回读当前任务证据。",
    promptSnippet: "用 inspect 获取代码与 Git 证据",
    promptGuidelines: [
      "定位源码时默认先用 inspect bundle；只有上下文不足时再补 read/read_many。",
      "查看源码目录使用 inspect(action=files)；workspace 只管理 Git worktree。",
      "多个已知代码符号可用空格分隔；整串零命中时会按字面符号回退。",
      "修改前必须取得目标文件的 baseHash；bundle 窗口已包含可用于 edit 的 baseHash。",
      "search/bundle 默认搜索仓库；已知目录时传 path 限定范围。",
      "bundle 最多返回 4 个 48 行窗口且总计不超过 192 行；ALREADY_SEEN 不需要再次读取。",
      "bundle/read 已经显示能解释故障的实现时，立即使用 edit 做最小修改；首次写入会自动请求用户批准。",
      "已有 evidence ID 时用 evidence_get；需要按状态或类型定位时用 evidence_list。",
    ],
    executionMode: "sequential",
    parameters: InspectParameters,
    async execute(
      _toolCallId,
      input,
      signal,
      _onUpdate,
      extensionContext: ExtensionContext,
    ) {
      return await withProgress(
        extensionContext.ui,
        "inspect",
        input,
        async (progress) => {
          progress.line("处理 inspect：" + input.action);
          try {
            if (input.action === "evidence_list" || input.action === "evidence_get") {
              const evidenceInput: EvidenceInput = {
                action: input.action === "evidence_list" ? "list" : "get",
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.kind === undefined ? {} : { kind: input.kind }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
              };
              const evidenceOutput = await executeEvidenceQuery(context, evidenceInput, signal);
              await appendEvent(context.store, context.task.id, "tool.inspect", {
                action: input.action,
                outcome: "execution",
                evidenceRevision: Number(evidenceOutput.details.revision),
              });
              return {
                ...evidenceOutput,
                details: { ...evidenceOutput.details },
              };
            }

            const output = await inspectTask(context, input as InspectInput, signal);
            await appendEvent(context.store, context.task.id, "tool.inspect", {
              action: input.action,
              outcome: output.details.cacheKind === "exact" ? "receipt" : "execution",
              cacheKind: output.details.cacheKind,
              bundleWindows: output.details.bundleWindows ?? 0,
              candidateFiles: output.details.candidateFiles ?? 0,
              selectedFiles: output.details.selectedFiles ?? 0,
            });
            return {
              content: [{ type: "text", text: output.text }],
              details: { ...output.details },
            };
          } catch (error) {
            await appendEvent(context.store, context.task.id, "tool.inspect", {
              action: input.action,
              outcome: "failure",
              bundleWindows: 0,
              candidateFiles: 0,
              selectedFiles: 0,
            });
            throw error;
          }
        },
      );
    },
  });
}
