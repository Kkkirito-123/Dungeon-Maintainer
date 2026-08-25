/** 真实游戏修复评测的固定模型策略。 */

/** 当前评测只接受显式包含 `flash` 的模型 ID，避免误用高成本 Pro。 */
export function assertFlashBenchmarkModel(modelId: string): void {
  if (!/flash/iu.test(modelId)) {
    throw new Error("Benchmark 当前只允许 Flash 模型；实际 modelId=" + modelId.slice(0, 160));
  }
}
