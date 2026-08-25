/**
 * 任务证据与跨任务解决方案的持久化契约。
 *
 * 证据只保存低敏摘要、版本 Hash、原始工件路径和关系，不复制完整源码、SQL、隐藏
 * 裁判结果或模型正文。完整检查日志和复现动作继续保存在各自目录，通过 artifactRef
 * 回溯。所有记录采用追加写入，旧记录只改变状态，不物理删除。
 */

/** 一条证据的领域类型。 */
export type EvidenceKind =
  | "source"
  | "game"
  | "check"
  | "reproduction"
  | "claim"
  | "change"
  | "verification";

/** 证据在当前任务版本中的可用状态。 */
export type EvidenceStatus = "active" | "stale" | "superseded";

/** Evidence JSONL 允许保存的低敏标量元数据。 */
export type EvidenceScalar = string | number | boolean | null;

/** 追加到任务 evidence.jsonl 的不可变证据快照。 */
export interface EvidenceRecord {
  schemaVersion: 1;
  id: string;
  taskId: string;
  kind: EvidenceKind;
  /** 相同工具输入和相同有效版本下用于跳过真实执行的键。 */
  actionKey: string | null;
  /** 结果身份；不同动作得到相同事实时可以共享同一指纹。 */
  fingerprint: string;
  status: EvidenceStatus;
  summary: string;
  artifactRef: string | null;
  path: string | null;
  startLine: number | null;
  lineCount: number | null;
  baseHash: string | null;
  worktreeHash: string | null;
  /** 缓存命中必须完全相同的文件、worktree 或检查版本。 */
  validityKey: string;
  links: string[];
  metadata: Record<string, EvidenceScalar>;
  createdAt: string;
}

/** EvidenceStore.capture 的输入；ID、时间和 schema 由存储层统一生成。 */
export type EvidenceCandidate = Omit<
  EvidenceRecord,
  "schemaVersion" | "id" | "taskId" | "createdAt"
>;

/** 一次固定检查的可审计记录。 */
export interface CheckRecord {
  id: string;
  worktreeHash: string;
  status: "passed" | "failed" | "blocked";
  durationMs: number;
  logPath: string;
  savedAt: string;
}

/** 成功修复后可跨任务检索的确定性解决方案。 */
export interface SolutionRecord {
  schemaVersion: 1;
  id: string;
  projectKey: string;
  taskId: string;
  title: string;
  symptom: string;
  rootCause: string;
  planTitle: string;
  steps: string[];
  verification: string;
  relatedPaths: string[];
  evidenceRefs: string[];
  buggyHashes: Record<string, string>;
  fixedHashes: Record<string, string>;
  createdAt: string;
}

/** solution-index.jsonl 中用于本地搜索的有限目录项。 */
export interface SolutionIndexRecord {
  schemaVersion: 1;
  id: string;
  projectKey: string;
  title: string;
  description: string;
  category: string;
  searchText: string;
  relatedPaths: string[];
  detailRef: string;
  createdAt: string;
}

/** 本地确定性匹配后的候选方案。 */
export interface SolutionSearchResult {
  id: string;
  title: string;
  description: string;
  category: string;
  relatedPaths: string[];
  score: number;
}
