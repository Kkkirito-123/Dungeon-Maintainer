/**
 * 任务 worktree 中的 Vite 开发服务器生命周期。
 *
 * 服务器只监听 127.0.0.1，端口由系统临时分配；启动命令固定为目标游戏已经安装的
 * Vite JS 入口，模型不能提供命令、参数、cwd 或环境变量。session_shutdown 总会调用
 * close，未结束任务只保留源码 worktree，不保留后台服务。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

/** 已启动的本机游戏服务。 */
export interface GameServer {
  url: string;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本机端口"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 启动 worktree 内固定 Vite 服务。
 *
 * @param repoRoot detached worktree 根目录。
 * @param signal Pi 会话取消信号。
 * @returns 仅本机可访问的服务句柄。
 * @throws Vite 缺失、提前退出或 30 秒内未就绪时拒绝。
 */
export async function startGameServer(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<GameServer> {
  const port = await freePort();
  const url = "http://127.0.0.1:" + String(port);
  const gameRoot = join(repoRoot, "game");
  const viteEntry = join(
    gameRoot,
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );
  const child: ChildProcess = spawn(
    process.execPath,
    [
      viteEntry,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: gameRoot,
      env: {
        ...process.env,
        DUNGEON_MAINTAINER_VITE_CACHE_DIR: join(repoRoot, ".vite-cache"),
      },
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    },
  );
  const abort = (): void => {
    child.kill();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode !== null) {
      throw new Error("游戏 Vite 服务启动失败");
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return {
          url,
          close: async () => {
            signal?.removeEventListener("abort", abort);
            if (child.exitCode !== null) return;
            child.kill();
            await new Promise<void>((resolve) => {
              child.once("close", () => resolve());
              setTimeout(resolve, 5_000).unref();
            });
          },
        };
      }
    } catch {
      // Vite 初始化期间连接失败是正常状态，只要子进程仍存活就继续等待。
    }
    await wait(100);
  }
  child.kill();
  throw new Error("等待游戏 Vite 服务超时");
}
