/**
 * EvalScenario 契约与严格读取。
 *
 * 本模块只读取 `case.json`、`reproduction.json` 和 `expected.json`，把可发送给
 * 被测 Agent 的公开任务与只允许判卷器使用的隐藏 Oracle/输入彻底分开。它不物化
 * Git 仓库、不启动浏览器或模型，也不执行 fixture 提供的任意命令。
 *
 * 所有 JSON 都按精确 schema 校验；动作只允许固定游戏语义操作，隐藏 SQL 只能由
 * `inputRef` 间接引用。调用方不得把 `expected` 或解析后的 `secretInputs` 拼入 Prompt、
 * 事件、公开报告或模型工具结果。
 */

import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_EVAL_DATASET_ID, defaultEvalDatasetsRoot } from "./dataset.js";
import {
  parseEvalOracleAfter,
  parseEvalOracleBefore,
  type EvalOracleAfter,
  type EvalOracleBefore,
} from "./oracle.js";

/** 正式游戏修复案例的五类固定分类。 */
export type EvalScenarioCategory =
  | "terminal-answer-consistency"
  | "combat-sql-state"
  | "reward-map-gating"
  | "transition-death-persistence"
  | "advanced-sql-endgame";

/** 真实模型游戏修复单案例允许等待的硬上限。 */
export const EVAL_TIMEOUT_MAX_MS = 600_000;

/** 可由零模型复现器执行的固定语义动作。 */
export type EvalScenarioStep =
  | { readonly op: "go"; readonly target: "objective" | "frontier"; readonly maxSteps: number }
  | { readonly op: "use"; readonly actionId: string }
  | { readonly op: "input-sql"; readonly inputRef: string }
  | { readonly op: "query" }
  | { readonly op: "reload" }
  | { readonly op: "wait"; readonly milliseconds: number };

/** 允许进入被测 Agent 首条自然语言消息的公开案例信息。 */
export interface EvalScenarioPublicCase {
  readonly schemaVersion: 1;
  readonly scenarioId: string;
  readonly category: EvalScenarioCategory;
  readonly prompt: string;
  readonly evidenceSummary: string;
  readonly startFloor: number;
  readonly startPreset: string | null;
  readonly timeoutMs: number;
}

/** 零模型预检和修复后重放使用的动作配方。 */
export interface EvalScenarioReproduction {
  readonly schemaVersion: 1;
  readonly scenarioId: string;
  readonly steps: readonly EvalScenarioStep[];
}

/** 只允许判卷器读取的隐藏条件。 */
export interface EvalScenarioExpected {
  readonly schemaVersion: 3;
  readonly scenarioId: string;
  readonly secretInputs: Readonly<Record<string, string>>;
  readonly beforeOracle: EvalOracleBefore;
  readonly afterOracle: EvalOracleAfter;
  readonly requiredChecks: readonly string[];
  readonly forbiddenPaths: readonly string[];
}

/** 一个完整案例；`expected` 永远不能进入 Agent 上下文。 */
export interface EvalScenario {
  readonly directory: string;
  readonly publicCase: EvalScenarioPublicCase;
  readonly reproduction: EvalScenarioReproduction;
  readonly expected: EvalScenarioExpected;
}

/** 案例读取参数。 */
export interface EvalScenarioReadOptions {
  /** 不含路径分隔符的 Scenario ID。 */
  readonly scenarioId: string;
  /** 完整 Dataset 根；省略时定位内置 `eval-v1`。 */
  readonly datasetRoot?: string;
}

const CATEGORIES = new Set<EvalScenarioCategory>([
  "terminal-answer-consistency",
  "combat-sql-state",
  "reward-map-gating",
  "transition-death-persistence",
  "advanced-sql-endgame",
]);
const CHECK_IDS = new Set([
  "rules-test",
  "rules-validate",
  "agent-test",
  "game-test",
  "game-architecture",
  "game-build",
]);

function defaultDatasetRoot(): string {
  return join(defaultEvalDatasetsRoot(), DEFAULT_EVAL_DATASET_ID);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " 必须是对象");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new Error(label + " 字段与 schema 不一致");
  }
}

function scenarioId(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    || value === "."
    || value === ".."
  ) {
    throw new Error("Eval Scenario ID 不是安全的单一目录名");
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(label + " 必须是文本");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\u0000")) {
    throw new Error(label + " 为空或超过长度限制");
  }
  return normalized;
}

function projectPath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || isAbsolute(value)
    || value.includes("\\")
    || /[:*?"<>|]/u.test(value)
  ) {
    throw new Error(label + " 不是安全的项目相对路径");
  }
  const segments = value.split("/");
  if (segments.some((entry) => !entry || entry === "." || entry === "..")) {
    throw new Error(label + " 包含路径穿越");
  }
  return segments.join("/");
}

function uniqueStrings(
  value: unknown,
  label: string,
  parser: (entry: unknown) => string,
): string[] {
  if (!Array.isArray(value)) throw new Error(label + " 必须是数组");
  const parsed = value.map(parser);
  if (new Set(parsed).size !== parsed.length) throw new Error(label + " 不允许重复");
  return parsed;
}

function parsePublicCase(value: unknown, requestedId: string): EvalScenarioPublicCase {
  const input = record(value, "case.json");
  exactKeys(input, [
    "category",
    "evidenceSummary",
    "fixtureId",
    "prompt",
    "schemaVersion",
    "startFloor",
    "startPreset",
    "timeoutMs",
  ], "case.json");
  if (input.schemaVersion !== 1 || input.fixtureId !== requestedId) {
    throw new Error("case.json 版本或 fixtureId 不一致");
  }
  if (typeof input.category !== "string" || !CATEGORIES.has(input.category as EvalScenarioCategory)) {
    throw new Error("case.json category 不受支持");
  }
  if (!Number.isInteger(input.startFloor) || Number(input.startFloor) < 1 || Number(input.startFloor) > 8) {
    throw new Error("case.json startFloor 必须是 1 至 8");
  }
  if (
    !Number.isInteger(input.timeoutMs)
    || Number(input.timeoutMs) < 60_000
    || Number(input.timeoutMs) > EVAL_TIMEOUT_MAX_MS
  ) {
    throw new Error("case.json timeoutMs 必须在 1 至 10 分钟之间");
  }
  const startPreset = input.startPreset === null
    ? null
    : boundedText(input.startPreset, "case.json startPreset", 80);
  if (startPreset && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(startPreset)) {
    throw new Error("case.json startPreset 不是安全的预设 ID");
  }
  return {
    schemaVersion: 1,
    scenarioId: requestedId,
    category: input.category as EvalScenarioCategory,
    prompt: boundedText(input.prompt, "case.json prompt", 2_000),
    evidenceSummary: boundedText(input.evidenceSummary, "case.json evidenceSummary", 500),
    startFloor: Number(input.startFloor),
    startPreset,
    timeoutMs: Number(input.timeoutMs),
  };
}

function parseStep(value: unknown, index: number): EvalScenarioStep {
  const input = record(value, `reproduction.json steps[${String(index)}]`);
  if (input.op === "go") {
    exactKeys(input, ["maxSteps", "op", "target"], "reproduction go");
    if (
      (input.target !== "objective" && input.target !== "frontier")
      || !Number.isInteger(input.maxSteps)
      || Number(input.maxSteps) < 1
      || Number(input.maxSteps) > 64
    ) throw new Error("reproduction go 参数非法");
    return { op: "go", target: input.target, maxSteps: Number(input.maxSteps) };
  }
  if (input.op === "use") {
    exactKeys(input, ["actionId", "op"], "reproduction use");
    return { op: "use", actionId: boundedText(input.actionId, "actionId", 80) };
  }
  if (input.op === "input-sql") {
    exactKeys(input, ["inputRef", "op"], "reproduction input-sql");
    return { op: "input-sql", inputRef: boundedText(input.inputRef, "inputRef", 80) };
  }
  if (input.op === "query" || input.op === "reload") {
    exactKeys(input, ["op"], "reproduction " + input.op);
    return { op: input.op };
  }
  if (input.op === "wait") {
    exactKeys(input, ["milliseconds", "op"], "reproduction wait");
    if (
      !Number.isInteger(input.milliseconds)
      || Number(input.milliseconds) < 10
      || Number(input.milliseconds) > 5_000
    ) throw new Error("reproduction wait 必须在 10 至 5000ms");
    return { op: "wait", milliseconds: Number(input.milliseconds) };
  }
  throw new Error("reproduction.json 包含不受支持的动作");
}

function parseReproduction(value: unknown, requestedId: string): EvalScenarioReproduction {
  const input = record(value, "reproduction.json");
  exactKeys(input, ["fixtureId", "schemaVersion", "steps"], "reproduction.json");
  if (input.schemaVersion !== 1 || input.fixtureId !== requestedId || !Array.isArray(input.steps)) {
    throw new Error("reproduction.json 版本、fixtureId 或 steps 非法");
  }
  if (input.steps.length < 1 || input.steps.length > 100) {
    throw new Error("reproduction.json 必须包含 1 至 100 个动作");
  }
  return {
    schemaVersion: 1,
    scenarioId: requestedId,
    steps: input.steps.map(parseStep),
  };
}

function parseExpected(value: unknown, requestedId: string): EvalScenarioExpected {
  const input = record(value, "expected.json");
  exactKeys(input, [
    "afterOracle",
    "beforeOracle",
    "expectedRouteFeatures",
    "fixtureId",
    "forbiddenPaths",
    "requiredChecks",
    "schemaVersion",
    "secretInputs",
  ], "expected.json");
  if (input.schemaVersion !== 3 || input.fixtureId !== requestedId) {
    throw new Error("expected.json 版本或 fixtureId 不一致");
  }
  const rawSecrets = record(input.secretInputs, "expected.json secretInputs");
  const secretInputs: Record<string, string> = {};
  for (const [key, valueEntry] of Object.entries(rawSecrets)) {
    const safeKey = boundedText(key, "secretInputs key", 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(safeKey)) {
      throw new Error("secretInputs key 非法");
    }
    secretInputs[safeKey] = boundedText(valueEntry, "secretInputs value", 16 * 1024);
  }
  const requiredChecks = uniqueStrings(input.requiredChecks, "requiredChecks", (entry) => {
    const check = boundedText(entry, "requiredChecks entry", 80);
    if (!CHECK_IDS.has(check)) throw new Error("expected.json 包含未知检查 ID");
    return check;
  });
  const forbiddenPaths = uniqueStrings(
    input.forbiddenPaths,
    "forbiddenPaths",
    (entry) => projectPath(entry, "forbiddenPaths entry"),
  );
  return {
    schemaVersion: 3,
    scenarioId: requestedId,
    secretInputs,
    beforeOracle: parseEvalOracleBefore(input.beforeOracle),
    afterOracle: parseEvalOracleAfter(input.afterOracle),
    requiredChecks,
    forbiddenPaths,
  };
}

async function readJson(path: string, label: string): Promise<unknown> {
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(label + " 必须是普通文件");
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(label + " 不是有效 UTF-8 JSON", { cause: error });
  }
}

/**
 * 严格读取一个内置 EvalScenario。
 *
 * @param options fixture ID 和可选测试根目录。
 * @returns 公开任务、确定性复现和隐藏判卷条件；调用方必须保持三者边界。
 * @throws 路径逃逸、链接、缺失文件、未知字段、任意动作或非法隐藏输入时拒绝。
 */
export async function readEvalScenario(
  options: EvalScenarioReadOptions,
): Promise<EvalScenario> {
  const id = scenarioId(options.scenarioId);
  const datasetRoot = resolve(options.datasetRoot ?? defaultDatasetRoot());
  const root = resolve(datasetRoot, "scenarios");
  const rootInformation = await lstat(root);
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    throw new Error("Agent Eval fixture 根必须是真实目录");
  }
  const realRoot = await realpath(root);
  const requestedDirectory = resolve(realRoot, id);
  const directoryInformation = await lstat(requestedDirectory);
  if (directoryInformation.isSymbolicLink() || !directoryInformation.isDirectory()) {
    throw new Error("Agent Eval 案例必须是真实目录");
  }
  const directory = await realpath(requestedDirectory);
  const escaped = relative(realRoot, directory);
  if (!escaped || escaped.startsWith("..") || escaped.includes("/") || escaped.includes("\\")) {
    throw new Error("Agent Eval 案例逃逸 fixture 根目录");
  }
  const [publicCase, reproduction, expected] = await Promise.all([
    readJson(join(directory, "case.json"), "case.json").then((value) => parsePublicCase(value, id)),
    readJson(join(directory, "reproduction.json"), "reproduction.json")
      .then((value) => parseReproduction(value, id)),
    readJson(join(directory, "expected.json"), "expected.json").then((value) => parseExpected(value, id)),
  ]);
  for (const step of reproduction.steps) {
    if (step.op === "input-sql" && !(step.inputRef in expected.secretInputs)) {
      throw new Error("reproduction.json 引用了不存在的隐藏输入");
    }
  }
  return { directory, publicCase, reproduction, expected };
}
