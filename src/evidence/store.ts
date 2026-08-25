/**
 * 任务级 Evidence Ledger 与项目级解决方案索引。
 *
 * EvidenceStore 是证据身份、缓存命中、失效和恢复的唯一事实源。TaskStore 只保存任务
 * 状态与写入权限；events.jsonl 只保存低敏审计事件。证据采用 JSONL 追加写入，进程
 * 重启时按最后一条同 ID 记录重建状态，因此中断不会依赖模型上下文恢复。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { redactText } from "../logging/redact.js";
import type { TaskRecord } from "../task/types.js";
import type {
  EvidenceCandidate,
  CheckRecord,
  EvidenceRecord,
  EvidenceStatus,
  SolutionIndexRecord,
  SolutionRecord,
  SolutionSearchResult,
} from "./types.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSummary(value: string): string {
  return redactText(value).replace(/\s+/gu, " ").trim().slice(0, 800);
}

/** 证据工件只保留可定位结构，不把答案、SQL 或隐藏裁判正文写入磁盘。 */
function safeArtifactText(value: string): { text: string; reusable: boolean } {
  const privateLine = /(?:answerSql|adminAnswerSql|referenceSql|expectedSql|judge|hidden|solution|defaultSql|lessonTaskBrief)/iu;
  const sqlLine = /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE)\b/iu;
  const redacted = redactText(value);
  let reusable = redacted === value;
  let sensitiveBlock = false;
  const text = redacted.split(/\r?\n/u).flatMap((line) => {
    const startsSensitive = privateLine.test(line) || sqlLine.test(line);
    if (startsSensitive) reusable = false;
    if (startsSensitive) sensitiveBlock = !/[;`][\s,)}\]]*$/u.test(line.trim());
    if (startsSensitive || sensitiveBlock) {
      if (sensitiveBlock && /[;`]\s*[,)}\]]?\s*$/u.test(line.trim())) {
        sensitiveBlock = false;
      }
      return [];
    }
    return [line];
  }).join("\n").slice(0, 8 * 1024);
  return { text, reusable };
}

function safeProjectKey(repoRoot: string): string {
  const normalized = process.platform === "win32"
    ? resolve(repoRoot).toLowerCase()
    : resolve(repoRoot);
  return digest(normalized).slice(0, 16);
}

function validRecord(value: unknown): value is EvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<EvidenceRecord>;
  return record.schemaVersion === 1
    && typeof record.id === "string"
    && typeof record.taskId === "string"
    && typeof record.kind === "string"
    && typeof record.fingerprint === "string"
    && typeof record.status === "string"
    && typeof record.summary === "string"
    && typeof record.validityKey === "string"
    && typeof record.createdAt === "string";
}

function validSolutionIndex(value: unknown): value is SolutionIndexRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SolutionIndexRecord>;
  return record.schemaVersion === 1
    && typeof record.id === "string"
    && typeof record.projectKey === "string"
    && typeof record.title === "string"
    && typeof record.description === "string"
    && typeof record.searchText === "string"
    && typeof record.detailRef === "string";
}

async function readJsonLines<T>(
  path: string,
  validate: (value: unknown) => value is T,
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const output: T[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!validate(value)) throw new Error("JSONL 记录结构非法");
      output.push(value);
    } catch (error) {
      // 追加写入中断只可能留下最后一条半行；中间损坏意味着账本不可安全恢复。
      if (index === lines.length - 1) {
        const complete = lines.slice(0, index).filter((item) => item.trim()).join("\n");
        await writeFile(path, complete ? complete + "\n" : "", "utf8");
        break;
      }
      throw new Error("证据 JSONL 在中间位置损坏", { cause: error });
    }
  }
  return output;
}

function normalizedTokens(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replaceAll("首领", " boss ")
    .replaceAll("下一关", " floor-advance ")
    .replaceAll("下一层", " floor-advance ")
    .replaceAll("卡死", " stuck ")
    .replaceAll("卡住", " stuck ")
    .replaceAll("卡在", " stuck ")
    .replaceAll("传送门", " portal ")
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
    .trim();
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  for (const token of [...tokens]) {
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 1) {
      for (let index = 0; index < token.length - 1; index += 1) {
        tokens.push(token.slice(index, index + 2));
      }
    }
  }
  return new Set(tokens);
}

function searchScore(query: string, entry: SolutionIndexRecord): number {
  const queryTokens = normalizedTokens(query);
  const targetTokens = normalizedTokens([
    entry.title,
    entry.description,
    entry.category,
    entry.searchText,
    ...entry.relatedPaths,
  ].join(" "));
  let score = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) score += token.length > 2 ? 12 : 6;
  }
  const normalizedQuery = [...queryTokens].join(" ");
  if (entry.searchText.toLowerCase().includes(normalizedQuery) && normalizedQuery) {
    score += 30;
  }
  return score;
}

/** 与一个任务和正式仓库绑定的证据存储。 */
export class EvidenceStore {
  readonly dataDir: string;
  readonly task: TaskRecord;
  readonly projectKey: string;
  private records = new Map<string, EvidenceRecord>();
  /** 同一 ID 最后一条 JSONL 快照对应的单调账本序号。 */
  private recordRevisions = new Map<string, number>();
  private actionIndex = new Map<string, string>();
  private solutions = new Map<string, SolutionIndexRecord>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private currentRevision = 0;
  /** 串行化“读取当前状态 → 追加快照 → 更新索引”的完整状态转换。 */
  private mutationBarrier: Promise<void> = Promise.resolve();

  constructor(dataDir: string, task: TaskRecord) {
    this.dataDir = resolve(dataDir);
    this.task = task;
    this.projectKey = safeProjectKey(task.repoRoot);
  }

  get revision(): number {
    return this.currentRevision;
  }

  get size(): number {
    return this.records.size;
  }

  private taskDirectory(): string {
    return join(this.dataDir, "tasks", this.task.id);
  }

  private evidencePath(): string {
    return join(this.taskDirectory(), "evidence.jsonl");
  }

  private projectDirectory(): string {
    return join(this.dataDir, "projects", this.projectKey);
  }

  private solutionIndexPath(): string {
    return join(this.projectDirectory(), "solution-index.jsonl");
  }

  private rebuildIndexes(): void {
    this.actionIndex.clear();
    for (const record of this.records.values()) {
      if (record.status === "active" && record.actionKey) {
        this.actionIndex.set(record.actionKey + "\0" + record.validityKey, record.id);
      }
    }
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationBarrier.then(operation);
    this.mutationBarrier = pending.then(() => undefined, () => undefined);
    return await pending;
  }

  /** 从磁盘重建任务证据和项目解决方案索引。 */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      const records = await readJsonLines(this.evidencePath(), validRecord);
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record) continue;
        if (record.taskId !== this.task.id) {
          throw new Error("证据记录 taskId 与任务目录不匹配");
        }
        this.records.set(record.id, record);
        this.recordRevisions.set(record.id, index + 1);
      }
      for (const solution of await readJsonLines(
        this.solutionIndexPath(),
        validSolutionIndex,
      )) {
        if (solution.projectKey !== this.projectKey) continue;
        this.solutions.set(solution.id, solution);
      }
      // revision 表示追加事件数，不是唯一证据 ID 数；状态失效也必须占一个序号。
      this.currentRevision = records.length;
      this.rebuildIndexes();
      this.loaded = true;
    })();
    try {
      await this.loadPromise;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  private async appendRecord(record: EvidenceRecord): Promise<void> {
    const path = this.evidencePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(record) + "\n", {
      encoding: "utf8",
      flag: "a",
    });
    this.records.set(record.id, record);
    this.currentRevision += 1;
    this.recordRevisions.set(record.id, this.currentRevision);
    this.rebuildIndexes();
  }

  private recordId(candidate: EvidenceCandidate): string {
    return digest([
      this.task.id,
      candidate.kind,
      candidate.fingerprint,
      candidate.validityKey,
    ].join("\0")).slice(0, 16);
  }

  /** 保存新证据；相同指纹和有效版本已存在时不重复追加。 */
  async capture(candidate: EvidenceCandidate): Promise<{
    record: EvidenceRecord;
    added: boolean;
  }> {
    return await this.serializeMutation(async () => {
      await this.load();
      const id = this.recordId(candidate);
      const existing = this.records.get(id);
      if (existing?.status === "active") return { record: existing, added: false };
      const record: EvidenceRecord = {
        ...candidate,
        schemaVersion: 1,
        id,
        taskId: this.task.id,
        summary: safeSummary(candidate.summary),
        links: [...new Set(candidate.links)].slice(0, 32),
        metadata: Object.fromEntries(Object.entries(candidate.metadata).map(([key, value]) => [
          key,
          typeof value === "string" ? safeSummary(value).slice(0, 300) : value,
        ])),
        createdAt: new Date().toISOString(),
      };
      await this.appendRecord(record);
      return { record, added: true };
    });
  }

  /** 保存一份有限脱敏工具结果，供后续 evidence.getEvidence 按需展开。 */
  async captureText(
    candidate: EvidenceCandidate,
    text: string,
  ): Promise<{ record: EvidenceRecord; added: boolean }> {
    await this.load();
    const id = this.recordId(candidate);
    const existing = this.records.get(id);
    if (existing?.status === "active") return { record: existing, added: false };
    const artifactPath = join(this.taskDirectory(), "evidence", id + ".txt");
    await mkdir(dirname(artifactPath), { recursive: true });
    const artifact = safeArtifactText(text);
    await writeFile(artifactPath, artifact.text, "utf8");
    return await this.capture({
      ...candidate,
      // 敏感读取必须允许下一次重新走真实 inspect；否则安全摘要会永久挡住当前源码。
      actionKey: artifact.reusable ? candidate.actionKey : null,
      artifactRef: relative(this.taskDirectory(), artifactPath).replaceAll("\\", "/"),
    });
  }

  /** 读取证据工件；路径只能落在当前任务 evidence 目录。 */
  async getEvidenceArtifact(id: string): Promise<string | null> {
    const record = await this.get(id);
    if (!record?.artifactRef) return null;
    const path = resolve(this.taskDirectory(), record.artifactRef);
    const escaped = relative(this.taskDirectory(), path);
    if (escaped.startsWith("..") || escaped === "..") {
      throw new Error("证据工件路径脱离当前任务目录");
    }
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** 查询相同动作在相同有效版本下的 active 证据。 */
  async findReusable(actionKey: string, validityKey: string): Promise<EvidenceRecord | null> {
    await this.load();
    const id = this.actionIndex.get(actionKey + "\0" + validityKey);
    return id ? this.records.get(id) ?? null : null;
  }

  async get(id: string): Promise<EvidenceRecord | null> {
    await this.load();
    return this.records.get(id) ?? null;
  }

  async active(kind?: EvidenceRecord["kind"]): Promise<EvidenceRecord[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => record.status === "active" && (!kind || record.kind === kind))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** 返回在给定账本 revision 之后新增或重新激活的当前证据。 */
  async activeSince(
    revision: number,
    kind?: EvidenceRecord["kind"],
  ): Promise<EvidenceRecord[]> {
    return (await this.active(kind)).filter(
      (record) => (this.recordRevisions.get(record.id) ?? 0) > revision,
    );
  }

  async latest(kind: EvidenceRecord["kind"]): Promise<EvidenceRecord | null> {
    return (await this.active(kind)).at(-1) ?? null;
  }

  private async updateStatus(record: EvidenceRecord, status: EvidenceStatus): Promise<void> {
    if (record.status === status) return;
    await this.appendRecord({ ...record, status, createdAt: new Date().toISOString() });
  }

  /** 文件修改后让相关源码证据和全部旧检查/验证失效。 */
  async invalidatePaths(paths: readonly string[]): Promise<void> {
    await this.serializeMutation(async () => {
      await this.load();
      const normalized = new Set(paths.map((path) => path.replaceAll("\\", "/")));
      for (const record of [...this.records.values()]) {
        if (record.status !== "active") continue;
        if (
          (record.kind === "source" && record.path && normalized.has(record.path))
          || record.kind === "check"
          || record.kind === "verification"
        ) {
          await this.updateStatus(record, "stale");
        }
      }
    });
  }

  /** 新复现成为当前检查点，旧复现保留但不再满足当前门禁。 */
  async supersedeReproductions(exceptId?: string): Promise<void> {
    await this.serializeMutation(async () => {
      await this.load();
      for (const record of [...this.records.values()]) {
        if (
          record.kind === "reproduction"
          && record.status === "active"
          && record.id !== exceptId
        ) await this.updateStatus(record, "superseded");
      }
    });
  }

  /**
   * 新修复目标开始时隔离上一目标的任务级事实。
   *
   * 项目级 Solution 索引不受影响；同一目标的“继续”也不会调用本方法。全部任务证据
   * 退出 active 后，新目标必须重新复现、读取当前源码、提出方案并按当前 Hash 验证，
   * 从而避免旧 verification 或旧 claim 直接关闭新 Bug Goal。
   */
  async supersedeGoalEvidence(): Promise<void> {
    await this.serializeMutation(async () => {
      await this.load();
      for (const record of [...this.records.values()]) {
        if (record.status === "active") {
          await this.updateStatus(record, "superseded");
        }
      }
    });
  }

  /** 返回检查记录；缓存和门禁默认只看 active，验证可显式读取 stale 的历史失败基线。 */
  async checks(options: { includeStale?: boolean } = {}): Promise<CheckRecord[]> {
    await this.load();
    const records = options.includeStale
      ? [...this.records.values()].filter((record) => (
          record.kind === "check" && record.status !== "superseded"
        ))
      : await this.active("check");
    return records.flatMap((record) => {
      const metadata = record.metadata;
      if (
        typeof metadata.id !== "string"
        || typeof metadata.status !== "string"
        || typeof metadata.durationMs !== "number"
        || typeof metadata.logPath !== "string"
        || typeof record.worktreeHash !== "string"
      ) return [];
      if (!new Set(["passed", "failed", "blocked"]).has(metadata.status)) return [];
      return [{
        id: metadata.id,
        worktreeHash: record.worktreeHash,
        status: metadata.status as "passed" | "failed" | "blocked",
        durationMs: metadata.durationMs,
        logPath: metadata.logPath,
        savedAt: record.createdAt,
      }];
    });
  }

  /** 写入验证成功后的跨任务解决方案和搜索索引。 */
  async saveSolution(solution: Omit<SolutionRecord, "schemaVersion" | "projectKey">): Promise<SolutionRecord> {
    await this.load();
    if (this.solutions.has(solution.id)) {
      const existing = await this.getSolution(solution.id);
      if (existing) return existing;
    }
    const record: SolutionRecord = {
      ...solution,
      schemaVersion: 1,
      projectKey: this.projectKey,
    };
    const directory = join(this.projectDirectory(), "solutions");
    await mkdir(directory, { recursive: true });
    const detailPath = join(directory, record.id + ".json");
    const temporary = detailPath + "." + String(process.pid) + ".tmp";
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temporary, detailPath);
    const index: SolutionIndexRecord = {
      schemaVersion: 1,
      id: record.id,
      projectKey: this.projectKey,
      title: safeSummary(record.title).slice(0, 160),
      description: safeSummary(record.rootCause).slice(0, 300),
      category: "game-repair",
      searchText: safeSummary([
        record.symptom,
        record.rootCause,
        record.planTitle,
        ...record.steps,
        ...record.relatedPaths,
      ].join(" ")),
      relatedPaths: [...new Set(record.relatedPaths)].slice(0, 20),
      detailRef: relative(this.projectDirectory(), detailPath).replaceAll("\\", "/"),
      createdAt: record.createdAt,
    };
    await mkdir(dirname(this.solutionIndexPath()), { recursive: true });
    await writeFile(this.solutionIndexPath(), JSON.stringify(index) + "\n", {
      encoding: "utf8",
      flag: "a",
    });
    this.solutions.set(index.id, index);
    return record;
  }

  async searchSolutions(query: string, limit = 3): Promise<SolutionSearchResult[]> {
    await this.load();
    return [...this.solutions.values()]
      .map((entry) => ({ entry, score: searchScore(query, entry) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
      .slice(0, Math.max(1, Math.min(limit, 5)))
      .map(({ entry, score }) => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        category: entry.category,
        relatedPaths: entry.relatedPaths,
        score,
      }));
  }

  async getSolution(id: string): Promise<SolutionRecord | null> {
    await this.load();
    const index = this.solutions.get(id);
    if (!index) return null;
    const path = resolve(this.projectDirectory(), index.detailRef);
    const fromRoot = relative(this.projectDirectory(), path);
    if (fromRoot.startsWith("..") || fromRoot === "..") {
      throw new Error("解决方案路径脱离项目数据目录");
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("解决方案文件不是有效对象");
    }
    const record = value as Partial<SolutionRecord>;
    if (record.schemaVersion !== 1 || record.id !== id || record.projectKey !== this.projectKey) {
      throw new Error("解决方案文件版本、ID 或项目绑定非法");
    }
    return value as SolutionRecord;
  }
}

/** 判断任务是否已经产生任何持久化证据，供首次会话恢复检查使用。 */
export async function hasTaskEvidence(dataDir: string, task: TaskRecord): Promise<boolean> {
  const evidence = new EvidenceStore(dataDir, task);
  await evidence.load();
  return evidence.size > 0;
}
