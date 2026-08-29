/**
 * Pi 原生工具与 Dungeon Maintainer 工具的权限集合。
 *
 * 本文件只定义工具名称和诊断/执行两个阶段的可见集合，不注册或执行任何工具。
 * Pi 进程启动时加载全部工具。为保持同一任务的 Prompt 缓存前缀稳定，诊断和执行
 * 阶段使用同一个工具面；模型提交完整方案并由用户在 Shell 确认后，Extension 才
 * 放行写入门禁。这样既保留 Pi 原生 Coding 能力，又不会把“继续看看”之类普通
 * 回复误当成源码写入授权。
 *
 * 源码写入统一由维护器自有 edit 执行；Pi 原生工具和任意 bash 均不加载。
 */

/** 1.0 不加载任何 Pi 原生工具。 */
export const PI_BUILTIN_TOOLS = [] as const;

/** Dungeon Maintainer 额外注册的领域工具。 */
export const MAINTAINER_TOOLS = [
  "inspect",
  "edit",
  "check",
  "finish",
  "workspace",
  "look",
  "act",
  "query",
] as const;

/** 诊断阶段逻辑上允许的只读、固定检查和游戏复现工具。 */
export const DIAGNOSIS_TOOLS = [
  "inspect",
  "check",
  "finish",
  "workspace",
  "look",
  "act",
  "query",
] as const;

/** 用户批准完整方案后允许的全部原生与领域工具。 */
export const FULL_CODING_TOOLS = [
  ...PI_BUILTIN_TOOLS,
  ...MAINTAINER_TOOLS,
] as const;
