/**
 * 维护器启动编排使用的路径身份比较。
 *
 * 本文件只负责把绝对路径规范化为可比较的字符串，不负责读取文件、解析 Git 或
 * 删除目录。仓库、任务生命周期和 Pi 进程模块共享这个规则，避免 Windows 大小写
 * 差异让同一个 worktree 被误判为两个路径。
 *
 * 输入来自维护器内部已经解析过的路径；函数没有文件系统副作用，也不改变真实路径。
 * 符号链接是否允许、路径是否存在仍由调用方通过 `realpath` 或 workspace 策略判断。
 * 失败时由 `resolve` 按 Node 的标准规则抛出，调用方应保留任务记录而不是静默修复。
 */

import { resolve } from "node:path";

/**
 * 返回适合进行路径身份比较的绝对路径。
 *
 * @param path 待比较的路径，可以是相对路径或绝对路径。
 * @returns Windows 下折叠大小写后的绝对路径，其他系统保留大小写。
 */
export function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
