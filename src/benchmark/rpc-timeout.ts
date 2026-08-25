/**
 * Benchmark RPC 的有限等待边界。
 *
 * Pi 子进程在超时后可能已经停止响应；统计请求不能因此阻塞 finally 的进程清理。
 * 请求失败和超过 deadline 都返回调用方提供的低敏 fallback，未完成的 Promise 不再
 * 持有 Node 定时器或阻止当前 Benchmark 继续回收资源。
 */

/** `get_session_stats` 的独立等待上限，不改变 Agent/Oracle 的业务超时。 */
export const SESSION_STATS_TIMEOUT_MS = 5_000;

/** 在固定 deadline 内等待一次 RPC；失败或超时都返回低敏 fallback。 */
export async function requestWithDeadline<T>(
  request: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let pending: Promise<T>;
  try {
    // RPC 适配器可能在子进程已退出时同步抛错；该路径也必须折叠为低敏 fallback。
    pending = Promise.resolve(request()).catch(() => fallback);
  } catch {
    return fallback;
  }
  let resolveTimeout: ((value: T) => void) | null = null;
  const timeout = new Promise<T>((resolve) => {
    resolveTimeout = resolve;
  });
  const timer = setTimeout(() => resolveTimeout?.(fallback), timeoutMs);
  timer.unref();
  try {
    return await Promise.race([
      pending,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
