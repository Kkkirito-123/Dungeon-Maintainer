/**
 * 可重放复现用例的持久化。
 *
 * 复现只保存从浏览器检查点之后产生的高层语义动作、用户描述和有限的
 * 结构化结果断言。它不保存检查点正文、SQL、完整地图、正式存档、鼠标轨迹或帧画面；
 * input-sql 只保存输入长度，正文留在当前进程；hidden judge 只保存预期条件，
 * 不保存浏览器返回的裁判摘要。
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

/** 复现结束后必须满足的有限结构化断言。 */
export interface ReproductionAssertions {
  floor?: number;
  mode?: string;
  minLessons?: number;
  advancedFromFloor?: number;
  bossDefeated?: boolean;
  queryAccepted?: boolean;
  terminalOpen?: boolean;
}

/** 一个可重放的 schema v2 复现用例；SQL 输入正文不写入该记录。 */
export interface ReproductionRecord {
  schemaVersion: 2;
  id: string;
  title: string;
  expected: string;
  actual: string;
  evidence: string[];
  actions: SemanticTraceEntry[];
  assertions: ReproductionAssertions;
  createdAt: string;
}

/**
 * 把探测 Trace 规范化为可重放路径。
 *
 * 检查点不保存已打开的 DOM 覆盖层，因此 continue/close 类纯展示动作不能进入重放。
 * 中途失败后 Agent 若已用其他成功动作继续，该失败只是探测，重放时必须省略，
 * 否则它偶然成功会让后续路径偏移。若最后一个语义动作本身失败，它就是可能的故障
 * 触发点，必须保留并由结构化断言判断修复结果。
 */
export function replayableTraceActions(
  entries: readonly SemanticTraceEntry[],
): SemanticTraceEntry[] {
  const restorableEntries = entries.filter((entry) => {
    if (entry.action === "input-sql") return true;
    if (entry.action !== "use") return true;
    const actionId = entry.arguments.actionId;
    return actionId !== "continue"
      && actionId !== "close-review"
      && actionId !== "close-inventory";
  });
  let lastSemanticIndex = -1;
  for (let index = restorableEntries.length - 1; index >= 0; index -= 1) {
    if (restorableEntries[index]?.action !== "look") {
      lastSemanticIndex = index;
      break;
    }
  }
  return restorableEntries.filter((entry, index) => (
    entry.action === "look"
    || entry.action === "input-sql"
    || entry.ok
    || index === lastSemanticIndex
  ));
}

function plain(value: string, limit: number): string {
  return redactText(value).replace(/\s+/gu, " ").trim().slice(0, limit);
}

function floorNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 8) {
    throw new Error(`复现断言 ${field} 必须是 1 至 8 的整数`);
  }
  return value as number;
}

function lessonCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("复现断言 minLessons 必须是非负整数");
  }
  return value as number;
}

function reproductionAssertions(value: unknown): ReproductionAssertions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("复现必须包含结构化断言");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "floor",
    "mode",
    "minLessons",
    "advancedFromFloor",
    "bossDefeated",
    "queryAccepted",
    "terminalOpen",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("复现包含未支持的结构化断言");
  }
  const assertions: ReproductionAssertions = {};
  const floor = floorNumber(input.floor, "floor");
  const advancedFromFloor = floorNumber(
    input.advancedFromFloor,
    "advancedFromFloor",
  );
  const minLessons = lessonCount(input.minLessons);
  if (floor !== undefined) assertions.floor = floor;
  if (advancedFromFloor !== undefined) {
    assertions.advancedFromFloor = advancedFromFloor;
  }
  if (minLessons !== undefined) assertions.minLessons = minLessons;
  if (input.mode !== undefined) {
    if (typeof input.mode !== "string" || !plain(input.mode, 40)) {
      throw new Error("复现断言 mode 必须是非空文本");
    }
    assertions.mode = plain(input.mode, 40);
  }
  if (input.bossDefeated !== undefined) {
    if (typeof input.bossDefeated !== "boolean") {
      throw new Error("复现断言 bossDefeated 必须是布尔值");
    }
    assertions.bossDefeated = input.bossDefeated;
  }
  if (input.queryAccepted !== undefined) {
    if (typeof input.queryAccepted !== "boolean") {
      throw new Error("复现断言 queryAccepted 必须是布尔值");
    }
    assertions.queryAccepted = input.queryAccepted;
  }
  if (input.terminalOpen !== undefined) {
    if (typeof input.terminalOpen !== "boolean") {
      throw new Error("复现断言 terminalOpen 必须是布尔值");
    }
    assertions.terminalOpen = input.terminalOpen;
  }
  if (Object.keys(assertions).length === 0) {
    throw new Error("复现至少需要一项结构化断言");
  }
  return assertions;
}

/**
 * 保存当前 Trace 为活动复现。
 *
 * @param store 当前任务存储。
 * @param task 当前任务。
 * @param trace 从检查点开始记录的语义动作。
 * @param input 用户或 Agent 给出的复现描述。
 * @returns 已持久化的复现记录。
 * @throws 没有 go/use/input_sql/query 动作或结构化断言时拒绝。
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
    assertions: ReproductionAssertions;
  },
): Promise<ReproductionRecord> {
  const actions = replayableTraceActions(trace.snapshot());
  if (!actions.some((entry) => entry.action !== "look")) {
    throw new Error("复现至少需要一个 go、use 或 query 语义动作");
  }
  const parsedAssertions = reproductionAssertions(input.assertions);
  // queryAccepted 只有在重放确实提交 query 时才有可观测依据。模型有时会把
  // “之后可以查询”误写成当前复现断言；丢弃这个无证据字段比让验证阶段误报
  // queryAccepted 失败并触发额外一轮模型搜索更安全，也不会把未执行的查询当成通过。
  if (
    parsedAssertions.queryAccepted !== undefined
    && !actions.some((entry) => entry.action === "query")
  ) {
    delete parsedAssertions.queryAccepted;
  }
  if (Object.keys(parsedAssertions).length === 0) {
    throw new Error("复现至少需要一项与可重放动作对应的结构化断言");
  }
  const record: ReproductionRecord = {
    schemaVersion: 2,
    id: randomUUID(),
    title: plain(input.title, 160),
    expected: plain(input.expected, 400),
    actual: plain(input.actual, 400),
    evidence: input.evidence.slice(0, 8).map((value) => plain(value, 200)),
    actions,
    assertions: parsedAssertions,
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("复现记录不是有效对象");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion === 1) {
    throw new Error("旧 schema v1 复现缺少结构化断言；请重新复现");
  }
  if (candidate.schemaVersion !== 2 || candidate.id !== index.id) {
    throw new Error("复现记录版本或 ID 非法");
  }
  return {
    ...(value as ReproductionRecord),
    assertions: reproductionAssertions(candidate.assertions),
  };
}
