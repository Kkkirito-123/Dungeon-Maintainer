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
    ? "当前任务证据卡（最近 12 条 active；正文按需使用 evidence(get) 回读）：\n" + card
    : null;
}
