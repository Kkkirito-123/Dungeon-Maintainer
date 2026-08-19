/**
 * 可重放复现用例的持久化。
 *
 * 复现只保存从浏览器检查点之后产生的高层语义动作、用户描述的期望和实际结果以及
 * 有限证据引用。它不保存检查点正文、SQL、完整地图、正式存档、鼠标轨迹或帧画面。
 * 文件位于任务 reproductions 目录，task.json 只保留低敏索引。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import type {
  SemanticTrace,
  SemanticTraceEntry,
} from "../logging/trace.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";

/** 一个可重放的 schema v1 复现用例。 */
export interface ReproductionRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  expected: string;
  actual: string;
  evidence: string[];
  actions: SemanticTraceEntry[];
  createdAt: string;
}

function plain(value: string, limit: number): string {
  return redactText(value).replace(/\s+/gu, " ").trim().slice(0, limit);
}

/**
 * 保存当前 Trace 为活动复现。
 *
 * @param store 当前任务存储。
 * @param task 当前任务。
 * @param trace 从检查点开始记录的语义动作。
 * @param input 用户或 Agent 给出的复现描述。
 * @returns 已持久化的复现记录。
 * @throws 没有任何 go、use 或 query 动作时拒绝，纯 look 不能证明复现。
 */
export async function saveReproduction(
  store: TaskStore,
  task: TaskRecord,
  trace: SemanticTrace,
  input: {
    title: string;
    expected: string;
    actual: string;
    evidence: readonly string[];
  },
): Promise<ReproductionRecord> {
  const actions = trace.snapshot();
  if (!actions.some((entry) => entry.action !== "look")) {
    throw new Error("复现至少需要一个 go、use 或 query 语义动作");
  }
  const record: ReproductionRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    title: plain(input.title, 160),
    expected: plain(input.expected, 400),
    actual: plain(input.actual, 400),
    evidence: input.evidence.slice(0, 8).map((value) => plain(value, 200)),
    actions,
    createdAt: new Date().toISOString(),
  };
  if (!record.title || !record.expected || !record.actual) {
    throw new Error("复现标题、期望和实际结果不能为空");
  }
  const directory = join(store.taskDir(task.id), "reproductions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, record.id + ".json");
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  task.reproductions = task.reproductions.filter(
    (entry) => entry.id !== record.id,
  );
  task.reproductions.push({
    id: record.id,
    actionCount: record.actions.length,
    path,
    savedAt: record.createdAt,
  });
  task.activeReproductionId = record.id;
  task.verification = null;
  await store.save(task);
  await appendEvent(store, task.id, "reproduction.saved", {
    id: record.id,
    actionCount: record.actions.length,
  });
  return record;
}

/**
 * 读取任务当前活动复现。
 *
 * @param store 当前任务存储。
 * @param task 当前任务。
 * @returns 活动复现，未设置时返回 null。
 */
export async function readActiveReproduction(
  store: TaskStore,
  task: TaskRecord,
): Promise<ReproductionRecord | null> {
  if (!task.activeReproductionId) return null;
  const index = task.reproductions.find(
    (entry) => entry.id === task.activeReproductionId,
  );
  if (!index) throw new Error("活动复现索引已损坏");
  const expectedPath = join(
    store.taskDir(task.id),
    "reproductions",
    index.id + ".json",
  );
  // 不直接信任 task.json 中可被手工修改的绝对路径，避免恢复任务时越界读取其他文件。
  if (resolve(index.path) !== resolve(expectedPath)) {
    throw new Error("活动复现路径已脱离当前任务目录");
  }
  const value: unknown = JSON.parse(await readFile(expectedPath, "utf8"));
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (value as Record<string, unknown>).schemaVersion !== 1
    || (value as Record<string, unknown>).id !== index.id
  ) {
    throw new Error("复现记录版本或 ID 非法");
  }
  return value as ReproductionRecord;
}
