/** 与具体 Agent 工具框架无关的受限源码检查契约。 */
export type InspectAction = "status" | "tree" | "search" | "read" | "read_many" | "diff";

/** `read_many` 中一个受限源码范围。 */
export interface InspectReadRange {
  path: string;
  startLine?: number;
  lineCount?: number;
}

/** 应用层接受的检查请求；Pi Adapter 只负责用 TypeBox 校验同一结构。 */
export interface InspectInput {
  action: InspectAction;
  path?: string;
  query?: string;
  startLine?: number;
  lineCount?: number;
  partitionId?: string;
  ranges?: InspectReadRange[];
}

/** 批量读取中每个文件的独立 Hash 回执。 */
export interface InspectItemDetails {
  path: string;
  startLine: number;
  lineCount: number;
  evidenceId: string;
  baseHash: string;
  receiptOnly: boolean;
}

/** 一次检查产生的低敏结构化结果。 */
export interface InspectDetails {
  action: InspectAction;
  evidenceId: string;
  contentHash: string;
  baseHash: string | null;
  lines: number;
  truncated: boolean;
  actionKey: string;
  cacheHit: boolean;
  receiptOnly?: boolean;
  scope?: string[];
  matchCount?: number;
  complete?: boolean;
  expanded?: boolean;
  items?: InspectItemDetails[];
}
