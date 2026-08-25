/**
 * 可重放复现用例的持久化。
 *
 * 复现只保存从浏览器检查点之后产生的高层语义动作、用户描述和有限的
 * 结构化结果断言。它不保存检查点正文、SQL、完整地图、正式存档、鼠标轨迹或帧画面；
 * input-sql 只保存输入长度，正文留在当前进程；hidden judge 只保存预期条件，
 * 不保存浏览器返回的裁判摘要。
 * 文件位于任务 reproductions 目录，EvidenceStore 保存当前活动复现的低敏索引。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import { reproductionEvidence } from "../evidence/projector.js";
import type { EvidenceStore } from "../evidence/store.js";
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
  /** 修复后战斗终端的题目阶段索引至少达到该值；它不是楼层推进断言。 */
  minStageIndex?: number;
  advancedFromFloor?: number;
  bossDefeated?: boolean;
  queryAccepted?: boolean;
  /** 每次 query 的接受结果，必须与复现中的 query 数量和顺序完全一致。 */
  queryAcceptedSequence?: boolean[];
  /** 每次 query 后玩家可见执行计划的粗粒度类别。 */
  queryPlanSequence?: Array<"scan" | "search" | "none">;
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

/** 判断复现是否依赖仅存在当前进程内存中的 SQL 正文。 */
export function reproductionNeedsSqlRefresh(record: ReproductionRecord): boolean {
  return record.actions.some((entry) => entry.action === "input-sql");
}

/**
 * 把探测 Trace 规范化为可重放路径。
 *
 * 检查点不保存已打开的 DOM 覆盖层，因此 continue/close 类纯展示动作不能进入重放。
 * 中途失败后 Agent 若已用其他成功动作继续，该失败只是探测，重放时必须省略，
 * 否则它偶然成功会让后续路径偏移。但 action-not-available、terminal-not-open 和
 * query-not-available 会直接导致后续动作失败，属于故障因果链而不是普通探测；即使
 * 后面还有动作也必须保留。若最后一个语义动作本身失败，它同样是可能的故障触发点。
 */
function isCausalReplayFailure(entry: SemanticTraceEntry): boolean {
  if (entry.ok) return false;
  if (entry.action === "use") {
    return entry.summary.includes("action-not-available");
  }
  if (entry.action === "input-sql") {
    return entry.summary.includes("terminal-not-open");
  }
  if (entry.action === "query") {
    return entry.summary.includes("query-not-available");
  }
  return false;
}

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
    || isCausalReplayFailure(entry)
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

function minimumStageIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("复现断言 minStageIndex 必须是非负整数");
  }
  return value as number;
}

/** 从公开 expected 文本提取明确声明的 stageIndex 最低目标。 */
function expectedMinimumStageIndex(expected: string): number | null {
  const patterns = [
    /stageIndex\s*(?:=|>=|为)\s*(\d+)/giu,
    /stageIndex\s*至少\s*(?:前进|推进|达到)?\s*(?:到|至|为)?\s*(\d+)/giu,
    /stageIndex\s*(?:前进|推进|达到)\s*(?:到|至|为)?\s*(\d+)/giu,
  ];
  const values = patterns.flatMap((pattern) => [...expected.matchAll(pattern)].flatMap(
    (match) => match[1] === undefined ? [] : [Number(match[1])],
  )).filter(Number.isSafeInteger);
  return values.length > 0 ? Math.max(...values) : null;
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
    "minStageIndex",
    "advancedFromFloor",
    "bossDefeated",
    "queryAccepted",
    "queryAcceptedSequence",
    "queryPlanSequence",
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
  const minStageIndex = minimumStageIndex(input.minStageIndex);
  if (floor !== undefined) assertions.floor = floor;
  if (advancedFromFloor !== undefined) {
    assertions.advancedFromFloor = advancedFromFloor;
  }
  if (minLessons !== undefined) assertions.minLessons = minLessons;
  if (minStageIndex !== undefined) assertions.minStageIndex = minStageIndex;
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
  if (input.queryAcceptedSequence !== undefined) {
    if (
      !Array.isArray(input.queryAcceptedSequence)
      || input.queryAcceptedSequence.length < 1
      || input.queryAcceptedSequence.length > 8
      || input.queryAcceptedSequence.some((item) => typeof item !== "boolean")
    ) {
      throw new Error("复现断言 queryAcceptedSequence 必须是 1 至 8 项布尔序列");
    }
    assertions.queryAcceptedSequence = Array.from(
      input.queryAcceptedSequence,
      (item) => item as boolean,
    );
  }
  if (input.queryPlanSequence !== undefined) {
    const allowedPlans = new Set(["scan", "search", "none"]);
    if (
      !Array.isArray(input.queryPlanSequence)
      || input.queryPlanSequence.length < 1
      || input.queryPlanSequence.length > 8
      || input.queryPlanSequence.some((item) => !allowedPlans.has(String(item)))
    ) {
      throw new Error("复现断言 queryPlanSequence 只允许 scan、search 或 none");
    }
    assertions.queryPlanSequence = Array.from(
      input.queryPlanSequence,
      (item) => item as "scan" | "search" | "none",
    );
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
 * @param evidence 当前任务证据存储。
 * @param task 当前任务。
 * @param trace 从检查点开始记录的语义动作。
 * @param input 用户或 Agent 给出的复现描述。
 * @returns 已持久化的复现记录。
 * @throws 没有 go/use/input_sql/query 动作或结构化断言时拒绝。
 */
export async function saveReproduction(
  store: TaskStore,
  evidence: EvidenceStore,
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
  const expected = plain(input.expected, 400);
  const expectedStageIndex = expectedMinimumStageIndex(expected);
  if (
    expectedStageIndex !== null
    && (
      parsedAssertions.minStageIndex === undefined
      || parsedAssertions.minStageIndex < expectedStageIndex
    )
  ) {
    throw new Error(
      "复现 expected 明确要求 stageIndex 至少达到 " + String(expectedStageIndex)
      + "；minStageIndex 不能缺失或填写更小的当前故障值。",
    );
  }
  if (parsedAssertions.minStageIndex !== undefined) {
    if (
      parsedAssertions.minStageIndex > 0
      && !actions.some((entry) => entry.action === "query")
    ) {
      throw new Error(
        "复现包含 minStageIndex 阶段推进断言，但没有可重放的 query 动作；"
        + "请先保存打开终端后的查询提交，再声明阶段目标。",
      );
    }
    // 题目阶段达到目标后，战斗可能继续到下一题，也可能直接结束并关闭终端。
    // `mode=combat` 和 `terminalOpen=true` 只描述复现现场，不是阶段推进的稳定结果，
    // 保留它们会让正确修复因终态变化被误判；阶段目标仍由 minStageIndex 强制验证。
    if (parsedAssertions.mode === "combat") delete parsedAssertions.mode;
    if (parsedAssertions.terminalOpen === true) delete parsedAssertions.terminalOpen;
  }
  // queryAccepted 只有在重放确实提交 query 时才有可观测依据。模型有时会把
  // “之后可以查询”误写成当前复现断言；丢弃这个无证据字段比让验证阶段误报
  // queryAccepted 失败并触发额外一轮模型搜索更安全，也不会把未执行的查询当成通过。
  if (
    parsedAssertions.queryAccepted !== undefined
    && !actions.some((entry) => entry.action === "query")
  ) {
    delete parsedAssertions.queryAccepted;
  }
  const queryCount = actions.filter((entry) => entry.action === "query").length;
  if (
    parsedAssertions.queryAcceptedSequence !== undefined
    && parsedAssertions.queryAcceptedSequence.length !== queryCount
  ) {
    throw new Error("queryAcceptedSequence 必须与复现中的 query 数量完全一致");
  }
  if (
    parsedAssertions.queryPlanSequence !== undefined
    && parsedAssertions.queryPlanSequence.length !== queryCount
  ) {
    throw new Error("queryPlanSequence 必须与复现中的 query 数量完全一致");
  }
  if (Object.keys(parsedAssertions).length === 0) {
    throw new Error("复现至少需要一项与可重放动作对应的结构化断言");
  }
  const record: ReproductionRecord = {
    schemaVersion: 2,
    id: randomUUID(),
    title: plain(input.title, 160),
    expected,
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
  task.verification = null;
  await store.save(task);
  await evidence.supersedeReproductions();
  const gameLinks = (await evidence.active("game")).map((item) => item.id);
  await evidence.capture({ ...reproductionEvidence(record, path), links: gameLinks });
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
 * @param evidence 当前任务证据存储。
 * @param task 当前任务。
 * @returns 活动复现，未设置时返回 null。
 */
export async function readActiveReproduction(
  store: TaskStore,
  evidence: EvidenceStore,
  task: TaskRecord,
): Promise<ReproductionRecord | null> {
  const index = await evidence.latest("reproduction");
  if (!index) return null;
  const reproductionId = typeof index.metadata.reproductionId === "string"
    ? index.metadata.reproductionId
    : null;
  if (!reproductionId || !index.artifactRef) throw new Error("活动复现证据索引已损坏");
  const expectedPath = join(
    store.taskDir(task.id),
    "reproductions",
    reproductionId + ".json",
  );
  // 不直接信任 task.json 中可被手工修改的绝对路径，避免恢复任务时越界读取其他文件。
  if (resolve(index.artifactRef) !== resolve(expectedPath)) {
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
  if (candidate.schemaVersion !== 2 || candidate.id !== reproductionId) {
    throw new Error("复现记录版本或 ID 非法");
  }
  return {
    ...(value as ReproductionRecord),
    assertions: reproductionAssertions(candidate.assertions),
  };
}
