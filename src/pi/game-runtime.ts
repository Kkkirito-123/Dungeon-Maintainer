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

/** 游戏运行时的确定性启动参数。生产会话固定为一层、没有预设且保留可见界面。 */
export interface GameRuntimeStart {
  floor: number;
  preset: string | null;
  headless: boolean;
}

/**
 * 读取 Eval 子进程注入的起点。
 *
 * 只有显式 eval mode 才接受楼层、预设和无头模式，避免用户正式 start/resume 被
 * 外部环境意外改变。fixture 在父进程已经校验一次，这里仍做第二道严格边界检查。
 */
export function resolveGameRuntimeStart(
  environment: NodeJS.ProcessEnv = process.env,
): GameRuntimeStart {
  if (environment.DUNGEON_MAINTAINER_BENCHMARK_MODE?.trim() !== "1") {
    return { floor: 1, preset: null, headless: false };
  }
  const floorText = environment.DUNGEON_MAINTAINER_BENCHMARK_START_FLOOR?.trim() ?? "";
  const floor = Number(floorText);
  if (!Number.isInteger(floor) || floor < 1 || floor > 8) {
    throw new Error("Eval 游戏起点楼层非法");
  }
  const presetText = environment.DUNGEON_MAINTAINER_BENCHMARK_START_PRESET?.trim() ?? "";
  if (presetText && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(presetText)) {
    throw new Error("Eval 游戏起点预设非法");
  }
  const headlessText = environment.DUNGEON_MAINTAINER_BENCHMARK_HEADLESS?.trim() ?? "1";
  if (headlessText !== "0" && headlessText !== "1") {
    throw new Error("Eval 浏览器模式非法");
  }
  return { floor, preset: presetText || null, headless: headlessText === "1" };
}

async function notifyShellRuntime(
  shellUrl: string | undefined,
  state: "starting" | "ready" | "error" | "stopped",
  gameUrl: string,
): Promise<void> {
  if (!shellUrl) return;
  const shell = new URL(shellUrl);
  const endpoint = new URL("/api/runtime", shell);
  endpoint.search = shell.search;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dungeon-token": shell.searchParams.get("token") ?? "",
    },
    body: JSON.stringify({ state, gameUrl }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("统一 Shell 未接受游戏运行时状态");
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
        const start = resolveGameRuntimeStart();
        server = await startGameServer(this.task.worktreeRoot);
        const gameUrl = server.url + "/?playtest=agent&floor=" + String(start.floor);
        const shellUrl = process.env.DUNGEON_MAINTAINER_SHELL_URL?.trim();
        await notifyShellRuntime(shellUrl, "starting", gameUrl);
        browser = new GameBrowser(server.url, (kind) => {
          void appendEvent(this.store, this.task.id, "browser.error", { kind }).catch(
            () => undefined,
          );
        }, shellUrl);
        await browser.open(start.floor, start.headless);
        const protocolVersion = await browser.protocolVersion();
        if (start.preset) await browser.prepare(start.preset);
        await notifyShellRuntime(shellUrl, "ready", gameUrl);
        const driver = new GameDriver(browser);
        this.active = { server, browser, driver };
        await appendEvent(this.store, this.task.id, "game.started", {
          protocolVersion,
          floor: start.floor,
          presetApplied: start.preset !== null,
        });
        return driver;
      } catch (error) {
        const shellUrl = process.env.DUNGEON_MAINTAINER_SHELL_URL?.trim();
        await notifyShellRuntime(shellUrl, "error", "").catch(() => undefined);
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
    await notifyShellRuntime(
      process.env.DUNGEON_MAINTAINER_SHELL_URL?.trim(),
      "stopped",
      "",
    ).catch(() => undefined);
    await appendEvent(this.store, this.task.id, "game.stopped");
  }
}
