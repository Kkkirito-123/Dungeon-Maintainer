/** Evidence Graph 的确定性上游选择。 */

import type { EvidenceRecord } from "./types.js";

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

/**
 * 为一次真实代码变化选择最小但可追溯的诊断上游。
 *
 * 输入必须是 EvidenceStore.active() 的时间正序结果。优先链接目标文件源码窗口、包含
 * 这些窗口的 bundle、最近复现和最近 proposed；若目标文件没有精确窗口，则保留最近
 * 一条 source，避免直接 edit 产生没有任何诊断父节点的孤儿 change。
 */
export function selectChangeUpstreamIds(
  active: readonly EvidenceRecord[],
  changedPaths: readonly string[],
): string[] {
  const targets = new Set(changedPaths.map(normalizedPath));
  const sources = active.filter((record) => record.kind === "source");
  const directSources = sources.filter((record) => (
    record.path !== null && targets.has(normalizedPath(record.path))
  )).slice(-8);
  const directIds = new Set(directSources.map((record) => record.id));
  const bundles = sources.filter((record) => (
    record.metadata.action === "bundle"
    && record.links.some((id) => directIds.has(id))
  )).slice(-4);
  const fallbackSource = directSources.length === 0 ? sources.at(-1) : null;
  const reproduction = active.filter((record) => record.kind === "reproduction").at(-1);
  const proposal = active.filter((record) => (
    record.kind === "claim" && record.metadata.finishStatus === "proposed"
  )).at(-1);
  return [...new Set([
    reproduction?.id,
    fallbackSource?.id,
    ...directSources.map((record) => record.id),
    ...bundles.map((record) => record.id),
    proposal?.id,
  ].filter((id): id is string => typeof id === "string"))];
}
