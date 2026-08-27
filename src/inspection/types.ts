/** 与具体 Agent 工具框架无关的受限源码检查契约。 */
export type InspectAction = "status" | "tree" | "search" | "bundle" | "read" | "read_many" | "diff";

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
  featureId?: string;
  floorId?: string;
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
  /** exact 未执行外部读取；semantic 已执行但结果与现有证据相同，只返回短回执。 */
  cacheKind: "none" | "exact" | "semantic";
  scope?: string[];
  matchCount?: number;
  complete?: boolean;
  expanded?: boolean;
  expansionLevel?: string;
  bundleWindows?: number;
  /** 本次搜索阶段实际产生候选命中的不同文件数。 */
  candidateFiles?: number;
  /** Bundle 最终展示源码窗口所覆盖的不同文件数。 */
  selectedFiles?: number;
  /** 功能三级路由首次命中的层级；没有功能路由时为 none。 */
  featureRouteLevel?: "primary" | "adjacent" | "shared" | "fallback" | "none";
  floorRouteLevel?: "current" | "adjacent" | "shared" | "fallback" | "none";
  floorScopeCount?: number;
  items?: InspectItemDetails[];
}
