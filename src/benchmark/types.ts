/**
 * Dungeon Maintainer 基准报告契约。
 *
 * 报告只保存数值、布尔结果和稳定场景名，不保存用户提示、模型正文、源码、SQL、
 * 游戏隐藏状态或凭据。确定性基准与真实任务分析共用该结构，方便连续比较版本。
 */

/** 单项指标的比较方向。 */
export type BenchmarkDirection = "eq" | "lte" | "gte";

/** 一个可机器判定的基准指标。 */
export interface BenchmarkMetric {
  name: string;
  value: number | boolean;
  unit: "boolean" | "count" | "ms" | "ratio" | "tokens";
  direction: BenchmarkDirection;
  threshold: number | boolean;
  passed: boolean;
}

/** 一组共享运行环境的基准结果。 */
export interface BenchmarkScenario {
  id: string;
  kind: "deterministic" | "live-task";
  passed: boolean;
  metrics: BenchmarkMetric[];
  notes: string[];
}

/** `dungeon-maintain benchmark` 输出的稳定 JSON 顶层。 */
export interface DungeonBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  passed: boolean;
  scenarios: BenchmarkScenario[];
}

/**
 * 构造并判定一项基准指标。
 *
 * @param input 指标名称、值、单位、比较方向和阈值。
 * @returns 带确定性 passed 结果的指标。
 */
export function metric(input: Omit<BenchmarkMetric, "passed">): BenchmarkMetric {
  let passed: boolean;
  if (input.direction === "eq") {
    passed = input.value === input.threshold;
  } else {
    const value = Number(input.value);
    const threshold = Number(input.threshold);
    passed = input.direction === "lte"
      ? value <= threshold
      : value >= threshold;
  }
  return { ...input, passed };
}

/** 根据全部指标生成场景结果。 */
export function scenario(
  id: string,
  kind: BenchmarkScenario["kind"],
  metrics: BenchmarkMetric[],
  notes: string[] = [],
): BenchmarkScenario {
  return {
    id,
    kind,
    passed: metrics.every((entry) => entry.passed),
    metrics,
    notes,
  };
}
