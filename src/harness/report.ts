/**
 * 通用 Harness 报告写入。
 *
 * 本模块把 Runner 已经裁剪的场景、步骤、验证和用量写为 Markdown、JSON、NDJSON 与
 * 最小终态。它不读取浏览器、模型 transcript 或代码，也不接受 SQL、地图、完整快照、
 * prompt、completion 和凭据。写入失败会向上抛出，调用方不能把缺少证据的运行标为
 * 成功。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactText } from "../safety/redact.js";
import type { HarnessReport } from "./contract.js";

function cell(value: string): string {
  return redactText(value).replaceAll("|", "\\|").replace(/\r?\n/gu, " ").trim();
}

function metrics(value: Record<string, string | number | boolean>): string {
  return Object.entries(value).slice(0, 12)
    .map(([key, item]) => `${cell(key)}=${cell(String(item))}`)
    .join(" · ") || "无";
}

function markdown(report: HarnessReport): string {
  const lines = [
    `# ${cell(report.adapter.title)} 黑盒诊断报告`, "",
    `- Run：\`${report.runId}\``,
    `- 适配器：\`${report.adapter.id}@${String(report.adapter.version)}\``,
    `- 状态：\`${report.status}\``,
    `- 代码 Hash：\`${report.codeHash}\``,
    `- 模型新增 Token：\`${String(report.usage.input + report.usage.output + report.usage.cacheWrite)}\`（输入 ${String(report.usage.input)}，输出 ${String(report.usage.output)}，缓存写入 ${String(report.usage.cacheWrite)}）`,
    `- Provider Cache 读取：\`${String(report.usage.cacheRead)}\`；总处理量：\`${String(report.usage.total)}\``, "",
    "| 场景 | 状态 | 缓存 | 动作 | 工作量 | 失败 | 耗时 |",
    "|---|---|---|---:|---:|---:|---:|",
  ];
  for (const scenario of report.scenarios) {
    lines.push(`| ${cell(scenario.label)} | ${scenario.status} | ${scenario.cached ? "HIT" : "MISS"} | ${String(scenario.actions)} | ${String(scenario.units)} | ${String(scenario.failures)} | ${String(scenario.ms)} ms |`);
  }
  lines.push("", "## 场景结论", "");
  for (const scenario of report.scenarios) {
    lines.push(
      `### ${cell(scenario.label)}`, "",
      cell(scenario.summary),
      `验证事实：${scenario.verdict.facts.map(cell).join("；") || "无"}`,
      `指标：${metrics(scenario.verdict.metrics)}`,
      `证据步骤：${scenario.evidence.join(", ") || "无"}`, "",
    );
  }
  lines.push("## 总结", "", cell(report.summary), "");
  return `${lines.join("\n").trim()}\n`;
}

/**
 * 原子地写入一次运行的全部报告格式。
 * @param report 不带落盘路径的脱敏报告。
 * @param output 当前 Run 专用目录。
 * @returns 带 Markdown 绝对路径的报告副本。
 */
export async function writeHarnessReport(
  report: Omit<HarnessReport, "reportPath">,
  output: string,
): Promise<HarnessReport> {
  await mkdir(join(output, "screenshots"), { recursive: true });
  const complete: HarnessReport = { ...report, reportPath: join(output, "report.md") };
  const finalState = {
    runId: complete.runId,
    adapter: complete.adapter,
    status: complete.status,
    codeHash: complete.codeHash,
    scenarios: complete.scenarios.map((scenario) => ({
      id: scenario.id,
      status: scenario.status,
      cached: scenario.cached,
      passed: scenario.verdict.passed,
      metrics: scenario.verdict.metrics,
    })),
  };
  await Promise.all([
    writeFile(join(output, "report.json"), `${JSON.stringify(complete, null, 2)}\n`, "utf8"),
    writeFile(complete.reportPath, markdown(complete), "utf8"),
    writeFile(
      join(output, "steps.ndjson"),
      complete.steps.map((step) => JSON.stringify(step)).join("\n") + (complete.steps.length > 0 ? "\n" : ""),
      "utf8",
    ),
    writeFile(join(output, "final-state.json"), `${JSON.stringify(finalState, null, 2)}\n`, "utf8"),
  ]);
  return complete;
}
