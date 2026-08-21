/**
 * Pi 原生工具与 Dungeon Maintainer 工具的权限集合。
 *
 * 本文件只定义工具名称和诊断/执行两个阶段的可见集合，不注册或执行任何工具。
 * Pi 进程启动时加载全部工具。为保持同一任务的 Prompt 缓存前缀稳定，诊断和执行
 * 阶段使用同一个工具面；模型提交完整方案并由用户在 Shell 确认后，Extension 才
 * 放行写入门禁。这样既保留 Pi 原生 Coding 能力，又不会把“继续看看”之类普通
 * 回复误当成源码写入授权。
 *
 * 原生 edit/write 使用 Pi 进程的本机权限，Pi 本身没有沙箱，因此 Extension 还必须
 * 对目标 realpath 做 detached worktree 边界校验。任意 bash 无法可靠限定路径，本版不加载。
 */

/** 只加载可在方案批准后做路径门禁的原生写入工具。 */
export const PI_BUILTIN_TOOLS = [
  "edit",
  "write",
] as const;

/** Dungeon Maintainer 额外注册的领域工具。 */
export const MAINTAINER_TOOLS = [
  "inspect",
  "patch",
  "check",
  "finish",
  "look",
  "go",
  "use",
  "input_sql",
  "query",
  "tree",
] as const;

/** 诊断阶段逻辑上允许的只读、固定检查和游戏复现工具。 */
export const DIAGNOSIS_TOOLS = [
  "inspect",
  "check",
  "finish",
  "look",
  "go",
  "use",
  "input_sql",
  "query",
  "tree",
] as const;

/** 用户批准完整方案后允许的全部原生与领域工具。 */
export const FULL_CODING_TOOLS = [
  ...PI_BUILTIN_TOOLS,
  ...MAINTAINER_TOOLS,
] as const;
