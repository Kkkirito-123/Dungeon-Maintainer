/**
 * Dungeon Maintainer 固定 Pi 工具面的唯一装配入口。
 *
 * 本文件只注册固定的 `inspect/edit/check/finish/workspace/look/act/query/publish` 工具，
 * 不做业务执行。Extension 保持
 * 工具面稳定以复用 Prompt 缓存，并按“只读诊断 -> 用户批准总方案或首次精确写入 ->
 * 本轮受限执行”在执行层切换写入门禁。
 * 调用方必须传入同一个 TaskRecord、TaskStore 与单浏览器访问器，确保任务恢复后没有
 * 第二套内存状态。任一工具注册失败会阻止 Extension 完成加载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GameDriver } from "../../game/driver.js";
import type { EvidenceStore } from "../../evidence/store.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import type { VerificationResult } from "../../repair/verification.js";
import type { ProgressLine } from "../../progress/reporter.js";
import { registerCheckTool } from "./check.js";
import { registerFinishTool } from "./finish.js";
import { registerGameTools } from "./game.js";
import { registerInspectTool } from "./inspect.js";
import { registerEditTool } from "./patch.js";
import { registerPublishTool } from "./publish.js";
import { registerWorkspaceTool } from "./tree.js";

/**
 * 九个固定领域工具共享的单任务运行依赖。
 *
 * 调用方必须从同一次 Extension 安装中传入这些对象和闭包。工具不得自行构造 TaskStore、
 * GameDriver 或授权状态，否则 taskId、浏览器与 worktree 之间会出现不可审计的状态分叉。
 * `approveExecution` 只改变当前自然语言请求的临时能力，持久写入范围仍由 TaskStore 保存和校验。
 */
export interface MaintainerToolContext {
  task: TaskRecord;
  store: TaskStore;
  evidence: EvidenceStore;
  currentDriver(): GameDriver | null;
  requireDriver(): GameDriver;
  ensureGame(): Promise<GameDriver>;
  /** 总方案或首次精确写入获确认后，开放当前文件范围内的 edit。 */
  approveExecution(): void;
  /** 执行完成、拒绝或本轮结束时撤销当前请求的 edit 权限。 */
  completeExecution(): void;
  /** 当前 Agent 运行是否已经获得本次受限写入授权。 */
  isExecutionApproved(): boolean;
  /** 当前自然语言请求是否明确要求落地修复。 */
  repairRequested(): boolean;
  /** 对当前 worktree 运行直接改动检查、重放和隐藏断言。 */
  verifyTask(signal?: AbortSignal, onProgress?: ProgressLine): Promise<VerificationResult>;
}

/**
 * 注册 1.0 的全部模型工具。
 *
 * @param pi 当前 Extension API。
 * @param context 与一个 taskId/worktree 绑定的运行依赖。
 * @returns 无返回值；成功后工具名固定为产品协议规定的九项。
 * @throws 任一子工具注册失败时同步抛错并中止 Extension 加载，避免向模型暴露不完整工具面。
 * @remarks 本函数只装配依赖，不启动浏览器、不访问仓库，也不授予写权限。
 */
export function registerMaintainerTools(
  pi: ExtensionAPI,
  context: MaintainerToolContext,
): void {
  registerInspectTool(pi, context);
  registerEditTool(pi, context);
  registerCheckTool(pi, context);
  registerFinishTool(pi, context);
  registerGameTools(pi, context);
  registerWorkspaceTool(pi, context);
  registerPublishTool(pi, context);
}
