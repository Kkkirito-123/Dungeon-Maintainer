/**
 * 任务状态、审批记录和本地持久化。
 *
 * 本模块是任务事实的唯一来源：状态迁移、基线提交、授权文件、检查结果和补丁位置
 * 都写入一个任务目录。会话正文采用 JSONL 追加，任务摘要采用原子 JSON 替换。
 * 这里不执行 Git、模型或工具，也绝不保存 API Key、SQL 正文和游戏完整快照。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { redactText } from "../safety/redact.js";

/** 维护任务的正常与异常状态。 */
export type TaskState =
  | "created"
  | "diagnosing"
  | "needs_approval"
  | "approved"
  | "editing"
  | "verifying"
  | "ready_to_apply"
  | "applied"
  | "blocked"
  | "aborted"
  | "failed"
  | "reverted";

/** 任务是否允许产生代码补丁。 */
export type TaskMode = "diagnose" | "fix";

/** 一次固定检查的可审计结果。 */
export interface CheckRecord {
  id: string;
  hash: string;
  status: "passed" | "failed" | "blocked";
  ms: number;
  logPath: string;
  savedAt: string;
}

/** 一次试玩的压缩索引；完整证据留在任务目录而不进入模型上下文。 */
export interface PlayRecord {
  key: string;
  hash: string;
  status: string;
  reportPath: string;
  savedAt: string;
}

/** 绑定任务、Git 基线和精确路径列表的一次性核心授权。 */
export interface ApprovalRecord {
  paths: string[];
  digest: string;
  expiresAt: string;
  approvedAt: string | null;
  usedAt: string | null;
}

/** 持久化任务记录。任务文件不得包含模型密钥或游戏敏感正文。 */
export interface TaskRecord {
  schemaVersion: 1;
  id: string;
  mode: TaskMode;
  objective: string;
  repoRoot: string;
  baseHead: string;
  worktreeRoot: string | null;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  plan: string[];
  approval: ApprovalRecord | null;
  changedPaths: string[];
  /** 多次 patch 调用累计消耗的删改行数，防止通过拆分调用绕过任务预算。 */
  patchLines: number;
  baseHashes: Record<string, string>;
  checks: CheckRecord[];
  plays: PlayRecord[];
  patchPath: string | null;
  reversePatchPath: string | null;
  appliedHashes: Record<string, string>;
  usage: { turns: number; toolCalls: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  conclusion: string | null;
}

/** 追加到 `events.ndjson` 的低敏审计事件。 */
export interface TaskEvent {
  at: string;
  type: string;
  detail: Record<string, string | number | boolean | null>;
}

const transitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ["diagnosing", "aborted", "failed"],
  diagnosing: ["needs_approval", "editing", "verifying", "blocked", "aborted", "failed"],
  needs_approval: ["approved", "aborted", "failed"],
  approved: ["editing", "blocked", "aborted", "failed"],
  editing: ["needs_approval", "verifying", "blocked", "aborted", "failed"],
  verifying: ["editing", "needs_approval", "ready_to_apply", "blocked", "aborted", "failed"],
  ready_to_apply: ["applied", "aborted", "failed"],
  applied: ["reverted"],
  blocked: ["diagnosing", "aborted"],
  aborted: [],
  failed: [],
  reverted: [],
};

function approvalDigest(task: TaskRecord, paths: readonly string[], token: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ taskId: task.id, baseHead: task.baseHead, paths, token }))
    .digest("hex");
}

/**
 * 任务目录访问器。
 *
 * 所有写入限定在构造时给出的数据根目录；`taskId` 必须符合 UUID/短标识字符集，
 * 因而不能通过路径穿越访问其他目录。写任务摘要时先写临时文件再原子替换。
 */
export class TaskStore {
  readonly dataDir: string;

  /** @param dataDir 统一数据根目录，通常来自 `%LOCALAPPDATA%`。 */
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  /**
   * 返回任务目录。
   * @param taskId 仅含字母、数字、点、下划线或连字符的任务标识。
   * @throws 当标识可能形成路径穿越时抛出错误。
   */
  taskDir(taskId: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) throw new Error("非法任务 ID");
    return join(this.dataDir, "tasks", taskId);
  }

  /**
   * 创建任务记录。
   * @param input 已验证的模式、目标仓库、目标和 Git 基线。
   * @returns 已持久化的新任务。
   */
  async create(input: Pick<TaskRecord, "mode" | "objective" | "repoRoot" | "baseHead">): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      ...input,
      objective: redactText(input.objective).slice(0, 2_000),
      worktreeRoot: null,
      state: "created",
      createdAt: now,
      updatedAt: now,
      plan: [],
      approval: null,
      changedPaths: [],
      patchLines: 0,
      baseHashes: {},
      checks: [],
      plays: [],
      patchPath: null,
      reversePatchPath: null,
      appliedHashes: {},
      usage: { turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      conclusion: null,
    };
    await this.save(task);
    await this.append(task.id, { at: now, type: "task.created", detail: { mode: task.mode } });
    return task;
  }

  /**
   * 读取任务并做最小版本校验。
   * @param taskId 任务标识。
   * @returns 持久化任务。
   * @throws 当任务不存在、JSON 非法或版本不受支持时抛出错误。
   */
  async read(taskId: string): Promise<TaskRecord> {
    const value: unknown = JSON.parse(await readFile(join(this.taskDir(taskId), "task.json"), "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("id" in value) ||
      value.id !== taskId
    ) {
      throw new Error("任务记录版本或 ID 非法");
    }
    const task = value as TaskRecord;
    // V1 开发期已经生成过少量本地任务。旧记录没有累计预算字段时按零恢复；之后的
    // 每次 patch 都会重新持久化该字段，避免要求用户删除已有诊断和试玩证据。
    if (typeof (value as { patchLines?: unknown }).patchLines !== "number") task.patchLines = 0;
    return task;
  }

  /**
   * 原子保存任务摘要。
   * @param task 不含凭据和敏感游戏正文的任务记录。
   */
  async save(task: TaskRecord): Promise<void> {
    const directory = this.taskDir(task.id);
    await mkdir(directory, { recursive: true });
    task.updatedAt = new Date().toISOString();
    const target = join(directory, "task.json");
    const temporary = `${target}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  /**
   * 追加一条低敏事件。
   * @param taskId 目标任务。
   * @param event 不含提示词、代码正文、SQL 或密钥的事件。
   */
  async append(taskId: string, event: TaskEvent): Promise<void> {
    const path = join(this.taskDir(taskId), "events.ndjson");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  /**
   * 追加一条会话元数据，不保存提示词、工具正文或凭据。
   * @param taskId 目标任务。
   * @param value 仅由 Runtime 生成的事件类型、工具名、状态和用量。
   */
  async appendSession(taskId: string, value: Record<string, string | number | boolean | null>): Promise<void> {
    const path = join(this.taskDir(taskId), "session.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, {
      encoding: "utf8", flag: "a",
    });
  }

  /**
   * 按状态机迁移任务。
   * @param task 当前任务对象。
   * @param next 目标状态。
   * @throws 当迁移不在固定状态图中时抛出错误。
   */
  async transition(task: TaskRecord, next: TaskState): Promise<void> {
    if (!transitions[task.state].includes(next)) {
      throw new Error(`非法任务状态迁移：${task.state} -> ${next}`);
    }
    const previous = task.state;
    task.state = next;
    await this.save(task);
    await this.append(task.id, {
      at: task.updatedAt,
      type: "task.state",
      detail: { previous, next },
    });
  }

  /**
   * 为核心文件生成十分钟有效的一次性批准挑战。
   *
   * @param task 正处于诊断或编辑状态的任务。
   * @param paths 规范化、排序且去重后的核心文件列表。
   * @returns 只向本地 CLI 用户展示一次的 token；任务文件只保存摘要。
   */
  async requestApproval(task: TaskRecord, paths: readonly string[]): Promise<string> {
    const normalized = [...new Set(paths)].sort();
    if (normalized.length === 0) throw new Error("核心批准必须绑定至少一个文件");
    const token = randomBytes(6).toString("hex");
    task.approval = {
      paths: normalized,
      digest: approvalDigest(task, normalized, token),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      approvedAt: null,
      usedAt: null,
    };
    if (task.state !== "needs_approval") await this.transition(task, "needs_approval");
    else await this.save(task);
    return token;
  }

  /**
   * 验证用户输入的批准 token。
   * @param task 待批准任务。
   * @param token 用户从本地 CLI 获得并重新输入的挑战值。
   * @throws 当 token 错误、过期、重复使用或任务状态不符时抛出错误。
   */
  async approve(task: TaskRecord, token: string): Promise<void> {
    const approval = task.approval;
    if (task.state !== "needs_approval" || !approval) throw new Error("任务当前不等待批准");
    if (approval.usedAt || approval.approvedAt) throw new Error("批准 token 已使用");
    if (Date.parse(approval.expiresAt) <= Date.now()) throw new Error("批准 token 已过期");
    if (approvalDigest(task, approval.paths, token) !== approval.digest) throw new Error("批准 token 不匹配");
    approval.approvedAt = new Date().toISOString();
    approval.usedAt = approval.approvedAt;
    await this.transition(task, "approved");
  }
}
