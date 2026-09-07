/**
 * schema v5 任务状态和本地持久化。
 *
 * TaskStore 是任务事实的唯一写入口：task.json 使用临时文件加原子替换，
 * events.jsonl 只追加低敏元数据。它不执行 Git、浏览器或 Pi，也不读取目标仓库。
 * 只读取当前 schema v5；不保留双写或旧数据迁移分支。
 * 产品能力统一按 1.0 提供，schema 数字仅表示数据格式。
 *
 * 重要失败模式：非法任务 ID、非法状态迁移、非当前格式或损坏 JSON 都会在产生
 * 副作用前抛错。task.json 使用唯一临时文件原子替换。批准记录只保存摘要，不保存
 * 补丁正文或用户确认内容。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { redactText } from "../logging/redact.js";
import type {
  ApprovalRecord,
  TaskEvent,
  TaskRecord,
  TaskState,
} from "./types.js";

function defaultTaskDisplayName(sourceBranch: unknown): string {
  const branch = typeof sourceBranch === "string" && sourceBranch.trim()
    ? sourceBranch.trim()
    : "unknown";
  return redactText("修复 · " + branch).slice(0, 80);
}

function normalizeTaskDisplayName(value: unknown): string {
  const name = redactText(typeof value === "string" ? value : "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  if (!name) throw new Error("任务名称不能为空");
  return name;
}

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ["active", "blocked", "discarded"],
  active: ["awaiting_approval", "verifying", "paused", "blocked", "discarded"],
  awaiting_approval: ["active", "blocked", "discarded"],
  verifying: ["active", "paused", "ready_to_apply", "blocked", "discarded"],
  paused: ["active", "blocked", "discarded"],
  ready_to_apply: ["active", "applied", "blocked", "discarded"],
  applied: [],
  blocked: ["active", "discarded"],
  discarded: [],
};

const NullableString = Type.Union([Type.String(), Type.Null()]);
const StringMap = Type.Record(Type.String(), Type.String());

/** 当前唯一支持的任务持久化结构。 */
export const TaskRecordSchema = Type.Object({
  schemaVersion: Type.Literal(5),
  id: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  objective: Type.String(),
  repoRoot: Type.String(),
  baseHead: Type.String(),
  sourceBranch: Type.String(),
  sourceDirtyFiles: Type.Integer({ minimum: 0 }),
  sourceSnapshotHash: NullableString,
  worktreeRoot: Type.String(),
  piSessionDir: Type.String(),
  modelProfileId: Type.String(),
  thinkingLevel: Type.Union([
    Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
    Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ]),
  writeScope: Type.Object({
    state: Type.Union([
      Type.Literal("unapproved"), Type.Literal("approved"), Type.Literal("closed"),
    ]),
    allowedPaths: Type.Array(Type.String()),
    digest: NullableString,
    approvedAt: NullableString,
    closedAt: NullableString,
  }, { additionalProperties: false }),
  state: Type.Union(Object.keys(TRANSITIONS).map((state) => Type.Literal(state))),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  changedPaths: Type.Array(Type.String()),
  patchLines: Type.Integer({ minimum: 0 }),
  baseHashes: StringMap,
  verification: Type.Union([Type.Object({
    worktreeHash: Type.String(),
    checkIds: Type.Array(Type.String()),
    reproductionId: NullableString,
    replayPassed: Type.Boolean(),
    verifiedAt: Type.String(),
  }, { additionalProperties: false }), Type.Null()]),
  approval: Type.Union([Type.Object({
    paths: Type.Array(Type.String()),
    digest: Type.String(),
    requestedAt: Type.String(),
    approvedAt: NullableString,
    usedAt: NullableString,
  }, { additionalProperties: false }), Type.Null()]),
  patchPath: NullableString,
  reversePatchPath: NullableString,
  appliedHashes: StringMap,
}, { additionalProperties: false });

/** 判断未知值是否为字段完整且 ID 匹配的当前任务记录。 */
export function taskRecordIsCurrent(value: unknown, taskId: string): value is TaskRecord {
  return Value.Check(TaskRecordSchema, value)
    && (value as TaskRecord).id === taskId;
}

async function replaceTaskFile(temporary: string, target: string): Promise<void> {
  const waits = [0, 10, 25, 50, 100, 200, 400, 800];
  for (let index = 0; index < waits.length; index += 1) {
    if (waits[index]) await delay(waits[index]);
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (index === waits.length - 1 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        throw error;
      }
    }
  }
}

/** 创建不可预测且可作为 Pi session-id 的任务 ID。 */
export function createTaskId(): string {
  return randomUUID();
}

/**
 * 任务目录访问器和状态机。
 *
 * 调用方必须把 dataDir 指向维护器专用数据目录；本类不会接受任务相对路径以外的
 * 自定义文件名，因此 taskId 不能借路径穿越访问其他任务或用户文件。
 */
export class TaskStore {
  readonly dataDir: string;

  /** @param dataDir 维护器专用数据根目录。 */
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  /**
   * 返回任务目录。
   *
   * @param taskId UUID 或测试使用的安全短标识。
   * @returns 任务目录绝对路径。
   * @throws 标识可能形成路径穿越时拒绝。
   */
  taskDir(taskId: string): string {
    if (!/^[a-zA-Z0-9._-]+$/u.test(taskId)) {
      throw new Error("非法任务 ID");
    }
    return join(this.dataDir, "tasks", taskId);
  }

  /**
   * 创建并持久化 schema v5 任务。
   *
   * @param input 已经创建好 detached worktree 的任务基础信息。
   * @returns 状态为 created 的完整任务。
   */
  async create(
    input: Pick<
      TaskRecord,
      "id" | "objective" | "repoRoot" | "baseHead" | "worktreeRoot" | "piSessionDir"
    > & Partial<Pick<
      TaskRecord,
      "displayName" | "sourceBranch" | "sourceDirtyFiles" | "sourceSnapshotHash"
    >>,
  ): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      schemaVersion: 5,
      id: input.id,
      displayName: input.displayName
        ? normalizeTaskDisplayName(input.displayName)
        : defaultTaskDisplayName(input.sourceBranch),
      objective: redactText(input.objective).slice(0, 2_000),
      repoRoot: resolve(input.repoRoot),
      baseHead: input.baseHead,
      sourceBranch: input.sourceBranch ?? "(unknown)",
      sourceDirtyFiles: input.sourceDirtyFiles ?? 0,
      sourceSnapshotHash: input.sourceSnapshotHash ?? null,
      worktreeRoot: resolve(input.worktreeRoot),
      piSessionDir: resolve(input.piSessionDir),
      modelProfileId: "default",
      thinkingLevel: "off",
      writeScope: {
        state: "unapproved",
        allowedPaths: [],
        digest: null,
        approvedAt: null,
        closedAt: null,
      },
      state: "created",
      createdAt: now,
      updatedAt: now,
      changedPaths: [],
      patchLines: 0,
      baseHashes: {},
      verification: null,
      approval: null,
      patchPath: null,
      reversePatchPath: null,
      appliedHashes: {},
    };
    await this.save(task);
    await this.append(task.id, {
      at: now,
      type: "task.created",
      detail: { baseHead: task.baseHead.slice(0, 12) },
    });
    return task;
  }

  /**
   * 读取并验证任务。
   *
   * @param taskId 要恢复的任务 ID。
   * @returns schema v5 任务记录。
   * @throws 格式、ID 或状态非法时拒绝。
   */
  async read(taskId: string): Promise<TaskRecord> {
    const path = join(this.taskDir(taskId), "task.json");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && "schemaVersion" in value
      && value.schemaVersion !== 5
    ) {
      throw new Error("任务 schema 版本不支持；请使用 start 创建 schema v5 新任务");
    }
    if (!taskRecordIsCurrent(value, taskId)) {
      throw new Error("任务记录格式、ID 或状态非法；请使用 start 创建当前格式任务");
    }
    return value;
  }

  /** 修改任务展示名称；名称只影响 UI 和任务目录，不改变任何执行绑定。 */
  async rename(task: TaskRecord, displayName: string): Promise<void> {
    const nextName = normalizeTaskDisplayName(displayName);
    if (task.displayName === nextName) return;
    task.displayName = nextName;
    await this.save(task);
    await this.append(task.id, {
      at: task.updatedAt,
      type: "task.renamed",
      detail: { name: nextName },
    });
  }

  /**
   * 枚举任务目录中的安全任务 ID。
   *
   * @returns 稳定排序后的目录名；具体 task.json 仍必须逐个通过 read 校验。
   */
  async listIds(): Promise<string[]> {
    const root = join(this.dataDir, "tasks");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9._-]+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /** 保存用户确认后的精确写入白名单。 */
  async approveWriteScope(
    task: TaskRecord,
    allowedPaths: readonly string[],
    digest: string,
  ): Promise<void> {
    task.writeScope = {
      state: "approved",
      allowedPaths: [...allowedPaths],
      digest,
      approvedAt: new Date().toISOString(),
      closedAt: null,
    };
    await this.save(task);
  }

  /** 关闭当前写入白名单；保留路径供 Shell 展示和审计。 */
  async closeWriteScope(task: TaskRecord): Promise<void> {
    if (task.writeScope.state === "unapproved") return;
    task.writeScope.state = "closed";
    task.writeScope.closedAt = new Date().toISOString();
    await this.save(task);
  }

  /**
   * 原子保存任务摘要。
   *
   * @param task 不含密钥、SQL、模型正文和完整游戏状态的任务。
   */
  async save(task: TaskRecord): Promise<void> {
    const directory = this.taskDir(task.id);
    await mkdir(directory, { recursive: true });
    task.updatedAt = new Date().toISOString();
    const target = join(directory, "task.json");
    const temporary = target
      + "."
      + String(process.pid)
      + "."
      + randomUUID()
      + ".tmp";
    try {
      await writeFile(
        temporary,
        JSON.stringify(task, null, 2) + "\n",
        "utf8",
      );
      await replaceTaskFile(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * 追加低敏事件。
   *
   * @param taskId 目标任务。
   * @param event 已经过调用方字段裁剪的事件。
   */
  async append(taskId: string, event: TaskEvent): Promise<void> {
    const path = join(this.taskDir(taskId), "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(event) + "\n", {
      encoding: "utf8",
      flag: "a",
    });
  }

  /**
   * 执行固定状态迁移。
   *
   * @param task 当前内存任务引用。
   * @param next 目标状态。
   * @throws 非法迁移时拒绝，且不会写入 task.json。
   */
  async transition(task: TaskRecord, next: TaskState): Promise<void> {
    if (task.state === next) {
      await this.save(task);
      return;
    }
    if (!TRANSITIONS[task.state].includes(next)) {
      throw new Error("非法任务状态迁移：" + task.state + " -> " + next);
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
   * 保存等待用户确认的核心补丁摘要。
   *
   * @param task 当前活动任务。
   * @param paths 规范化并排序的精确核心路径。
   * @param digest 绑定 taskId、baseHead、路径、Hash 和修改正文摘要的 SHA-256。
   */
  async requestApproval(
    task: TaskRecord,
    paths: readonly string[],
    digest: string,
  ): Promise<void> {
    const requestedAt = new Date().toISOString();
    const approval: ApprovalRecord = {
      paths: [...paths],
      digest,
      requestedAt,
      approvedAt: null,
      usedAt: null,
    };
    task.approval = approval;
    await this.transition(task, "awaiting_approval");
  }

  /**
   * 记录用户对当前精确补丁的确认结果。
   *
   * @param task 正在等待审批的任务。
   * @param approved 用户是否在 Pi 确认框中同意。
   */
  async resolveApproval(task: TaskRecord, approved: boolean): Promise<void> {
    if (task.state !== "awaiting_approval" || !task.approval) {
      throw new Error("任务当前没有待处理的核心审批");
    }
    task.approval.approvedAt = approved ? new Date().toISOString() : null;
    await this.transition(task, "active");
  }

  /**
   * 消费一次已批准的精确补丁。
   *
   * @param task 当前任务。
   * @param digest 即将写入补丁的重新计算摘要。
   * @throws 摘要变化、未批准或重复使用时拒绝。
   */
  async consumeApproval(task: TaskRecord, digest: string): Promise<void> {
    const approval = task.approval;
    if (
      !approval
      || approval.digest !== digest
      || !approval.approvedAt
      || approval.usedAt
    ) {
      throw new Error("核心补丁审批与当前修改不匹配");
    }
    approval.usedAt = new Date().toISOString();
    await this.save(task);
  }
}
