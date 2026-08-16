/**
 * SQL Dungeon 玩家投影与隐藏裁判到 Harness 契约的映射。
 *
 * 本模块只做确定性数据收敛：玩家投影变成有限尾迹，隐藏裁判变成课程、Boss 与升层
 * 断言。它不调用浏览器、模型或工具，也不把管理员答案、SQL、地图、存档、背包和
 * 身份复制到报告。若桥字段异常，调用方会得到未通过断言，而不是猜测成功。
 */

import { redactText } from "../../safety/redact.js";
import type {
  HarnessScenario,
  HarnessStep,
  HarnessTrace,
  HarnessVerdict,
} from "../../harness/contract.js";
import type { PlayJudge, PlayView } from "./browser.js";

function safe(value: string, limit = 180): string {
  return redactText(value).replace(/\s+/gu, " ").trim().slice(0, limit);
}

/**
 * 从稳定场景 ID 取得楼层。
 * @param scenario 由 SQL Dungeon 适配器静态创建的场景。
 * @returns 1 至 8 的楼层号。
 * @throws 场景 ID 不符合 `floor-N` 时拒绝，避免错误裁判关联。
 */
export function scenarioFloor(scenario: HarnessScenario): number {
  const match = /^floor-([1-8])$/u.exec(scenario.id);
  if (!match?.[1]) throw new Error(`未知 SQL Dungeon 场景：${scenario.id}`);
  return Number(match[1]);
}

/** 将玩家可见状态裁剪为通用步骤尾迹。 */
export function dungeonTrace(view: PlayView): HarnessTrace {
  return {
    objective: safe(view.mission.title),
    state: safe(view.mode, 32),
    note: safe([view.room, view.prompt, view.banner].filter(Boolean).join(" / ")),
    actions: view.actions.map((item) => safe(item.id, 48)).slice(0, 12),
  };
}

/**
 * 将隐藏裁判事实转成不泄露答案的场景断言。
 * @param scenario 当前静态楼层场景。
 * @param judge 桥只向 Node Runner 暴露的有限裁判字段。
 * @param steps 当前场景已经记录的公开动作证据。
 * @returns 可写入通用报告、但不会送回模型的断言。
 */
export function dungeonVerdict(
  scenario: HarnessScenario,
  judge: PlayJudge,
  steps: readonly HarnessStep[],
): HarnessVerdict {
  const floor = scenarioFloor(scenario);
  const complete = judge.bossDefeated
    && judge.lessons >= judge.requiredLessons
    && (floor === 8 ? judge.migrationComplete : judge.advanced);
  const moves = steps.reduce((sum, step) => sum + step.units, 0);
  const queries = steps.filter((step) => step.action === "query").length;
  const battles = steps.filter((step) => step.state === "combat").length;
  const deaths = steps.filter((step) => step.state === "death-review").length;
  const failures = steps.filter((step) => !step.ok).length;
  const summary = complete
    ? `隐藏裁判确认第 ${String(floor)} 层主流程通过：课程 ${String(judge.lessons)}/${String(judge.requiredLessons)}，Boss 与楼层终态成立。`
    : `第 ${String(floor)} 层尚未完成：课程 ${String(judge.lessons)}/${String(judge.requiredLessons)}，Boss=${String(judge.bossDefeated)}，动作失败=${String(failures)}。`;
  return {
    passed: complete,
    summary,
    metrics: {
      floor,
      moves,
      queries,
      battles,
      deaths,
      failures,
      lessons: judge.lessons,
      requiredLessons: judge.requiredLessons,
      bossDefeated: judge.bossDefeated,
      advanced: judge.advanced,
      migrationComplete: judge.migrationComplete,
    },
    facts: [
      `课程 ${String(judge.lessons)}/${String(judge.requiredLessons)}`,
      `Boss ${judge.bossDefeated ? "已击败" : "未击败"}`,
      floor === 8
        ? `MIGRATE ${judge.migrationComplete ? "已完成" : `进度 ${String(judge.migrationSteps)}`}`
        : `升层 ${judge.advanced ? "已完成" : "未完成"}`,
    ],
  };
}
