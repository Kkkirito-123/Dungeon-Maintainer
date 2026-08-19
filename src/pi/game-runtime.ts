/**
 * Pi Extension 侧的游戏开发运行时。
 *
 * `DungeonGameRuntime` 只拥有一个 Vite Server、一个临时 Chromium Context 和一个
 * `GameDriver`，负责惰性启动、并发启动去重、失败回收和退出清理。它不注册 Pi 工具或命令，
 * 不改变任务状态，也不直接读写游戏文件；浏览器动作仍由 `GameDriver` 与协议层执行。
 *
 * 启动失败时先关闭已创建的浏览器和服务器；正常退出只关闭运行时，未完成任务和 worktree
 * 由上层保留给 resume。每个错误事件只记录低敏 kind，避免把浏览器异常正文写入日志。
 */

import { appendEvent } from "../logging/events.js";
import { GameBrowser } from "../game/browser.js";
import { GameDriver } from "../game/driver.js";
import { startGameServer, type GameServer } from "../game/server.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";

interface ActiveGameRuntime {
  server: GameServer;
  browser: GameBrowser;
  driver: GameDriver;
}

/**
 * 管理单任务、单浏览器游戏运行时。
 *
 * @remarks 构造函数无外部副作用；第一次调用 `ensure` 才会启动 Vite 和 Chromium。
 */
export class DungeonGameRuntime {
  private active: ActiveGameRuntime | null = null;
  private opening: Promise<GameDriver> | null = null;

  /**
   * @param task 当前任务；游戏始终从该 detached worktree 启动。
   * @param store 低敏事件存储。
   */
  constructor(
    private readonly task: TaskRecord,
    private readonly store: TaskStore,
  ) {}

  /** @returns 已启动的 GameDriver；尚未启动时返回 `null`。 */
  currentDriver(): GameDriver | null {
    return this.active?.driver ?? null;
  }

  /**
   * 获取已启动的 GameDriver。
   *
   * @returns 当前单浏览器驱动。
   * @throws 尚未通过 `ensure` 启动游戏时拒绝调用。
   */
  requireDriver(): GameDriver {
    if (!this.active) throw new Error("游戏浏览器尚未就绪；请先执行 /play");
    return this.active.driver;
  }

  /**
   * 惰性启动 Vite、Chromium 和协议驱动。
   *
   * @returns 可供维护工具使用的 GameDriver；并发调用共享同一次启动。
   * @throws 任一启动步骤失败时回收已创建资源并抛出原错误。
   */
  async ensure(): Promise<GameDriver> {
    if (this.active) return this.active.driver;
    if (this.opening) return await this.opening;
    this.opening = (async () => {
      let server: GameServer | null = null;
      let browser: GameBrowser | null = null;
      try {
        server = await startGameServer(this.task.worktreeRoot);
        browser = new GameBrowser(server.url, (kind) => {
          void appendEvent(this.store, this.task.id, "browser.error", { kind }).catch(
            () => undefined,
          );
        });
        await browser.open();
        const driver = new GameDriver(browser);
        this.active = { server, browser, driver };
        await appendEvent(this.store, this.task.id, "game.started", {
          protocolVersion: 2,
        });
        return driver;
      } catch (error) {
        await browser?.close().catch(() => undefined);
        await server?.close().catch(() => undefined);
        throw error;
      } finally {
        this.opening = null;
      }
    })();
    return await this.opening;
  }

  /**
   * 关闭当前浏览器和 Vite。
   *
   * @returns 资源关闭完成；没有运行时则无操作。
   * @throws 底层关闭失败时抛出，调用方应保留任务证据。
   */
  async close(): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    const active = this.active;
    this.active = null;
    if (!active) return;
    await active.browser.close();
    await active.server.close();
    await appendEvent(this.store, this.task.id, "game.stopped");
  }
}
