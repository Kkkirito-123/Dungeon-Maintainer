/**
 * 维护器的统一临时进度输出。
 *
 * 工具只报告阶段，Shell 负责展示；进度不会写入任务、Evidence 或事件日志。
 */

import { redactCredentials, redactText } from "../logging/redact.js";

export const PROGRESS_KEY = "maintainer-progress";
const MAX_LINES = 80;
const MAX_LINE_LENGTH = 500;
const ANSI = new RegExp(
  String.fromCharCode(27) + "\\[[0-?]*[ -/]*[@-~]",
  "gu",
);
const HIDDEN_KEYS = new Set([
  "apikey", "accesskey", "token", "secret", "password", "credential",
  "authorization", "bearer", "adminanswersql", "answersql", "referencesql",
  "expectedsql", "secretinputs", "mazefloor", "discoveredcells", "runseed",
  "runinstanceid", "profile", "inventory", "hiddenstate", "hiddenmap",
  "solution", "defaultsql", "lessontaskbrief", "judge", "hidden", "content",
  "oldtext", "newtext", "patch",
]);

/** Pi RPC 的两个临时 UI 方法。 */
export interface ProgressUi {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    lines: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

export type ProgressLine = (line: string) => void;

export interface ProgressReporter {
  start(input?: unknown): void;
  line(text: string): void;
  done(summary?: string): void;
  fail(error: unknown): void;
}

function clip(value: string, limit = MAX_LINE_LENGTH): string {
  return value.length <= limit ? value : value.slice(0, limit - 1) + "…";
}

function clean(value: string, showSql = false): string {
  const text = (showSql ? redactCredentials(value) : redactText(value))
    .replace(ANSI, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return clip(text);
}

function hidden(value: unknown): string {
  return typeof value === "string"
    ? "[已隐藏，长度 " + String(value.length) + "]"
    : "[已隐藏]";
}

function isHiddenKey(key: string): boolean {
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  return HIDDEN_KEYS.has(normalized) || /(?:key|token|secret|password|credential)/u.test(normalized);
}

function summary(value: unknown, key = "", depth = 0): unknown {
  if (isHiddenKey(key)) return hidden(value);
  if (typeof value === "string") return clean(value, key.toLowerCase() === "sql");
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[已截断]";
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => summary(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 16).map(([childKey, childValue]) => [
        childKey,
        summary(childValue, childKey, depth + 1),
      ]),
    );
  }
  return "[不可展示]";
}

function inputSummary(input: unknown): string {
  if (input === undefined) return "";
  try {
    const value = JSON.stringify(summary(input));
    return value ? clip(value) : "";
  } catch {
    return "[参数不可序列化]";
  }
}

function errorSummary(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error));
}

class Reporter implements ProgressReporter {
  private readonly log: string[] = [];
  private startedAt = 0;
  private finished = false;

  constructor(
    private readonly ui: ProgressUi,
    private readonly name: string,
  ) {}

  start(input?: unknown): void {
    this.startedAt = performance.now();
    this.finished = false;
    this.log.length = 0;
    const args = inputSummary(input);
    this.push("开始" + (args ? " 参数=" + args : ""));
  }

  line(text: string): void {
    const value = clean(text);
    if (value) this.push(value);
  }

  done(message?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.push("通过" + (message ? " " + clean(message) : "") + "（" + this.elapsed() + " 秒）");
  }

  fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.push("失败 " + errorSummary(error) + "（" + this.elapsed() + " 秒）");
  }

  private elapsed(): string {
    return ((performance.now() - this.startedAt) / 1_000).toFixed(1);
  }

  private push(text: string): void {
    const line = clip("[" + this.name + "] " + text);
    this.log.push(line);
    if (this.log.length > MAX_LINES) this.log.shift();
    try {
      this.ui.setStatus(PROGRESS_KEY, line);
      this.ui.setWidget(PROGRESS_KEY, [...this.log], { placement: "aboveEditor" });
    } catch {
      // UI 只是观察面；展示失败不能改变工具结果。
    }
  }
}

export async function withProgress<T>(
  ui: ProgressUi,
  name: string,
  input: unknown,
  run: (progress: ProgressReporter) => Promise<T>,
): Promise<T> {
  const progress = new Reporter(ui, name);
  progress.start(input);
  try {
    const result = await run(progress);
    progress.done();
    return result;
  } catch (error) {
    progress.fail(error);
    throw error;
  }
}
