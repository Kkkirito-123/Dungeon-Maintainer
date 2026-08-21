/**
 * 维护任务的持久化契约。
 *
 * 这里定义 schema v3 的任务事实、状态机输入和验证记录，不执行文件、Git、浏览器
 * 或模型操作。字段刻意只保存路径、Hash、状态和有限摘要；Pi 原生会话正文单独位于
 * task/pi 目录，不复制到审计事件。修改 schema 必须同步 TaskStore 读取校验与测试。
 */

/** V1 允许的任务状态。 */
export type TaskState =
  | "created"
  | "active"
  | "awaiting_approval"
  | "verifying"
  | "ready_to_apply"
  | "applied"
  | "blocked"
  | "discarded";

/** start 创建任务后、第一次自然语言输入前使用的有限占位目标。 */
export const INITIAL_TASK_OBJECTIVE = "等待用户在 Pi CLI 中描述 SQL Dungeon 问题";

/** 固定检查的可审计记录。 */
export interface CheckRecord {
  id: string;
  worktreeHash: string;
  status: "passed" | "failed" | "blocked";
  durationMs: number;
  logPath: string;
  savedAt: string;
}

/** 一次核心路径审批，绑定精确补丁摘要并且只能消费一次。 */
export interface ApprovalRecord {
  paths: string[];
  digest: string;
  requestedAt: string;
  approvedAt: string | null;
  usedAt: string | null;
}

/** Pi 支持并允许 Shell 选择的思考等级。 */
export type TaskThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** 用户确认总方案后冻结的精确写入文件集合。 */
export interface WriteScopeRecord {
  state: "unapproved" | "approved" | "closed";
  allowedPaths: string[];
  digest: string | null;
  approvedAt: string | null;
  closedAt: string | null;
}

/** 复现记录的低敏索引；动作正文位于 reproductions 子目录。 */
export interface ReproductionIndex {
  id: string;
  actionCount: number;
  path: string;
  savedAt: string;
}

/** 完整验证结果，绑定当前 worktree Hash，代码变化后自动失效。 */
export interface VerificationRecord {
  worktreeHash: string;
  checkIds: string[];
  reproductionId: string | null;
  replayPassed: boolean;
  verifiedAt: string;
}

/** schema v3 的唯一任务记录。 */
export interface TaskRecord {
  schemaVersion: 3;
  id: string;
  /** 用户可读的任务名称；不影响 taskId、Git worktree 或 Pi session 绑定。 */
  displayName: string;
  objective: string;
  repoRoot: string;
  baseHead: string;
  /** 启动时来源工作树的分支；detached 状态使用 `(detached)`。 */
  sourceBranch: string;
  /** 启动快照包含的本地未提交文件数量，只保存数量而不记录敏感路径。 */
  sourceDirtyFiles: number;
  /** 来源工作树在启动瞬间的完整 Hash；旧版 schema v2 任务可能为 null。 */
  sourceSnapshotHash: string | null;
  worktreeRoot: string;
  piSessionDir: string;
  modelProfileId: string;
  thinkingLevel: TaskThinkingLevel;
  writeScope: WriteScopeRecord;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  changedPaths: string[];
  patchLines: number;
  baseHashes: Record<string, string>;
  checks: CheckRecord[];
  reproductions: ReproductionIndex[];
  activeReproductionId: string | null;
  verification: VerificationRecord | null;
  approval: ApprovalRecord | null;
  patchPath: string | null;
  reversePatchPath: string | null;
  appliedHashes: Record<string, string>;
  conclusion: string | null;
}

/** 追加到 events.jsonl 的低敏审计事件。 */
export interface TaskEvent {
  at: string;
  type: string;
  detail: Record<string, string | number | boolean | null>;
}
