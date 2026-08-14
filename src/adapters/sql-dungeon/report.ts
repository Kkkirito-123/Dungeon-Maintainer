/**
 * 确定性试玩报告契约与脱敏写入。
 *
 * 报告保存楼层、模式、动作、耗时、计数，以及玩家界面已经公开的有限状态尾迹；
 * 尾迹文本统一脱敏、限长，动作只保留稳定 ID。它不保存 SQL、参考答案、地图、完整
 * 快照、背包、身份或模型凭据。主维护 Agent 只读取 `summary`，完整 JSON/NDJSON 留在
 * 任务目录供人工复核。写入失败会使本次试玩失败，不会伪装成 PASS。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 试玩能够区分的客观结果。 */
export type PlayStatus = "PASS" | "FAIL_GAME" | "BLOCKED_TOOL" | "LIMIT_REACHED";

/** 一步动作后的公开界面尾迹；不得扩展为地图、答案或隐藏裁判状态。 */
export interface PlayTrace {
  mission: string;
  prompt: string;
  banner: string;
  actions: string[];
}

/** 单次语义动作证据；只含受限公开尾迹，不含 SQL 或完整页面正文。 */
export interface PlayStep {
  id: number;
  floor: number;
  action: "look" | "go" | "use" | "query" | "wait" | "judge";
  event: string;
  ok: boolean;
  ms: number;
  moves: number;
  mode: string;
  trace: PlayTrace;
}

/** 隐藏裁判对一个楼层的有限事实。 */
export interface FloorReport {
  floor: number;
  status: PlayStatus;
  ms: number;
  moves: number;
  battles: number;
  queries: number;
  deaths: number;
  stuck: number;
  lessons: number;
  requiredLessons: number;
  bossDefeated: boolean;
  advanced: boolean;
  migrationComplete: boolean;
  summary: string;
  evidence: number[];
}

/** 一次单层或八层试玩总报告。 */
export interface PlayReport {
  schemaVersion: 1;
  runId: string;
  status: PlayStatus;
  codeHash: string;
  startedAt: string;
  finishedAt: string;
  floors: FloorReport[];
  steps: PlayStep[];
  summary: string;
  reportPath: string;
}

function markdown(report: PlayReport): string {
  const lines = [
    "# SQL Dungeon 确定性实机试玩报告", "",
    `- Run：\`${report.runId}\``,
    `- 状态：\`${report.status}\``,
    `- 代码 Hash：\`${report.codeHash}\``,
    "- 模型 Token：`0`（路径规划与执行均为确定性工具）", "",
    "| 层 | 状态 | 移动 | 战斗 | 查询 | 死亡 | 卡住 | 课程 | Boss | 升层/MIGRATE |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const floor of report.floors) {
    lines.push(`| ${String(floor.floor)} | ${floor.status} | ${String(floor.moves)} | ${String(floor.battles)} | ${String(floor.queries)} | ${String(floor.deaths)} | ${String(floor.stuck)} | ${String(floor.lessons)}/${String(floor.requiredLessons)} | ${floor.bossDefeated ? "是" : "否"} | ${floor.floor === 8 ? (floor.migrationComplete ? "MIGRATE" : "未完成") : (floor.advanced ? "已升层" : "未升层")} |`);
  }
  lines.push("", "## 分层结论", "");
  for (const floor of report.floors) {
    lines.push(`### 第 ${String(floor.floor)} 层`, "", floor.summary, `证据步骤：${floor.evidence.join(", ") || "无"}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

/**
 * 写入 JSON、Markdown、NDJSON 和最小终态。
 * @param report 已脱敏的内存报告。
 * @param output 本次运行专用目录。
 * @returns 带最终 Markdown 路径的报告副本。
 */
export async function writePlayReport(report: Omit<PlayReport, "reportPath">, output: string): Promise<PlayReport> {
  await mkdir(join(output, "screenshots"), { recursive: true });
  const complete: PlayReport = { ...report, reportPath: join(output, "report.md") };
  await Promise.all([
    writeFile(join(output, "report.json"), `${JSON.stringify(complete, null, 2)}\n`, "utf8"),
    writeFile(join(output, "report.md"), markdown(complete), "utf8"),
    writeFile(join(output, "steps.ndjson"), complete.steps.map((step) => JSON.stringify(step)).join("\n") + (complete.steps.length ? "\n" : ""), "utf8"),
    writeFile(join(output, "final-state.json"), `${JSON.stringify({ runId: complete.runId, status: complete.status, floors: complete.floors.map(({ floor, status, lessons, requiredLessons, bossDefeated, advanced, migrationComplete }) => ({ floor, status, lessons, requiredLessons, bossDefeated, advanced, migrationComplete })) }, null, 2)}\n`, "utf8"),
  ]);
  return complete;
}

/**
 * 读取既有脱敏报告用于 Hash 缓存。
 * @param reportPath `report.json` 或同目录 `report.md` 路径。
 * @returns 解析后的报告。
 * @throws 缓存文件损坏时拒绝命中。
 */
export async function readPlayReport(reportPath: string): Promise<PlayReport> {
  const jsonPath = reportPath.endsWith(".json") ? reportPath : join(reportPath, "..", "report.json");
  const value: unknown = JSON.parse(await readFile(jsonPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("试玩缓存报告非法");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.floors)) throw new Error("试玩缓存报告版本非法");
  return record as unknown as PlayReport;
}
