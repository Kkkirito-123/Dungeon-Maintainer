/**
 * Pi 每轮使用的证据上下文适配器。
 *
 * 本模块只把 EvidenceStore 当前 active 记录交给中立证据卡投影，并添加固定标题；它
 * 不读取工件、不创建模型请求，也不把证据 revision 视为 Agent 进展。Extension 通过
 * 该适配器保持装配职责，不自行拼接证据记录或复制证据层的隐私规则。
 */

import { buildEvidenceCard } from "../evidence/card.js";
import type { EvidenceStore } from "../evidence/store.js";

/** 返回当前模型回合的有限证据卡；没有 active 证据时不注入任何文本。 */
export async function currentEvidenceContext(
  evidence: EvidenceStore,
): Promise<string | null> {
  const card = buildEvidenceCard(await evidence.active());
  return card
    ? "当前任务证据卡（最多 8 条关键 active、2 KiB；正文按需使用 evidence(get) 回读）：\n" + card
    : null;
}

/**
 * 搜索同一项目过去验证通过的方案，并构造有限只读线索。
 *
 * 历史方案不能替代当前版本的 inspect、复现和验证，因此不暴露详情工件、证据正文、
 * solution ID 或分数；模型只能看到标题、低敏根因摘要和少量相关路径。
 */
export async function currentSolutionContext(
  evidence: EvidenceStore,
  request: string,
): Promise<{
  /** 只包含低敏标题、根因摘要和相关路径；没有候选时为 null。 */
  text: string | null;
  /** 本次确定性搜索命中的候选数，供低敏遥测使用。 */
  matchCount: number;
}> {
  const matches = await evidence.searchSolutions(request, 3);
  if (matches.length === 0) return { text: null, matchCount: 0 };
  const rows = matches.map((match) => JSON.stringify({
    title: match.title.slice(0, 100),
    description: match.description.slice(0, 160),
    relatedPaths: match.relatedPaths.slice(0, 2).map((path) => path.slice(0, 80)),
  }));
  const heading = "同项目历史解决方案候选（仅作定位线索，不是当前版本证据；修改前仍须 inspect 当前源码并重新验证）：";
  const output = [heading];
  let bytes = Buffer.byteLength(heading, "utf8");
  for (const row of rows) {
    const rowBytes = Buffer.byteLength("\n" + row, "utf8");
    if (bytes + rowBytes > 2_048) continue;
    output.push(row);
    bytes += rowBytes;
  }
  return {
    text: output.length > 1 ? output.join("\n") : null,
    matchCount: matches.length,
  };
}
