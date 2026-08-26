/**
 * Dungeon Maintainer 固定 Pi 工具面的唯一装配入口。
 *
 * 本文件只注册固定的 `inspect/evidence/patch/check/finish/look/go/use/input_sql/query/tree` 工具，
 * 不做业务执行。Pi 原生 write 工具由启动层固定加载；Extension 保持
 * 工具面稳定以复用 Prompt 缓存，并按“只读诊断 -> 用户批准总方案 -> 本轮完整执行”
 * 在执行层切换写入门禁。
 * 调用方必须传入同一个 TaskRecord、TaskStore 与单浏览器访问器，确保任务恢复后没有
 * 第二套内存状态。任一工具注册失败会阻止 Extension 完成加载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GameDriver } from "../../game/driver.js";
import type {
  ArchitectureMap,
  ArchitectureRoute,
} from "../../inspection/architecture-map.js";
import type { EvidenceStore } from "../../evidence/store.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import type { VerificationResult } from "../../repair/verification.js";
import { registerCheckTool } from "./check.js";
import { registerEvidenceTool } from "./evidence.js";
import { registerFinishTool } from "./finish.js";
import { registerGameTools } from "./game.js";
import { registerInspectTool } from "./inspect.js";
import { registerPatchTool } from "./patch.js";
import { registerTreeTool } from "./tree.js";

/** 十一个固定领域工具共享的运行依赖。 */
export interface MaintainerToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  architectureMap?(): ArchitectureMap | null;
  architectureRoute?(): ArchitectureRoute | null;
  /** 由 Extension 的 tool_call 门禁提供同一次调用已计算的 worktree Hash。 */
  inspectWorktreeHash?(toolCallId: string): string | undefined;
  currentDriver(): GameDriver | null;
  requireDriver(): GameDriver;
  ensureGame(): Promise<GameDriver>;
  /** 用户确认具体完整方案后，开放本轮 Pi 原生写入和精确 patch。 */
  approveExecution(): void;
  /** 方案完成、拒绝或本轮结束时恢复只读诊断工具。 */
  completeExecution(): void;
  /** 当前 Agent 运行是否已经获得总方案执行授权。 */
  isExecutionApproved(): boolean;
  /** 当前自然语言请求是否明确要求落地修复。 */
  repairRequested(): boolean;
  /** 对当前 worktree 自动执行固定检查、重放和隐藏断言。 */
  verifyTask(signal?: AbortSignal): Promise<VerificationResult>;
}

/**
 * 注册 V1 的全部模型工具。
 *
 * @param pi 当前 Extension API。
 * @param context 与一个 taskId/worktree 绑定的运行依赖。
 */
export function registerMaintainerTools(
  pi: ExtensionAPI,
  context: MaintainerToolContext,
): void {
  registerInspectTool(pi, context);
  registerEvidenceTool(pi, context);
  registerPatchTool(pi, context);
  registerCheckTool(pi, context);
  registerFinishTool(pi, context);
  registerGameTools(pi, context);
  registerTreeTool(pi, context);
}
