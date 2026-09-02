/**
 * Dungeon Maintainer 固定模型工具的权限集合。
 *
 * 本文件只定义工具名称和诊断/执行两个阶段的可见集合，不注册或执行任何工具。
 * Pi 进程启动时只加载九个维护器工具。为保持同一任务的 Prompt 缓存前缀稳定，诊断和执行
 * 阶段使用同一个工具面；模型提交完整方案并由用户在 Shell 确认后，Extension 才
 * 放行 `edit` 写入门禁。其余工具始终由各自执行层校验前置条件，不会把“继续看看”
 * 之类普通回复误当成源码写入授权。
 *
 * 源码写入统一由维护器自有 edit 执行；Pi 原生工具和任意 bash 均不加载。
 */

/** 1.0 不加载任何 Pi 原生工具。 */
export const PI_BUILTIN_TOOLS = [] as const;

/** Dungeon Maintainer 注册给模型的全部领域工具；该数组也是 1.0 工具面的权威清单。 */
export const MAINTAINER_TOOLS = [
  "inspect",
  "edit",
  "check",
  "finish",
  "workspace",
  "look",
  "act",
  "query",
  "publish",
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
// publish 不属于诊断集合；它始终要求已验证任务和独立 UI 确认。

/** Pi 启动和每个模型回合使用的完整固定工具面；写权限不由数组可见性决定。 */
export const FULL_CODING_TOOLS = [
  ...PI_BUILTIN_TOOLS,
  ...MAINTAINER_TOOLS,
] as const;
