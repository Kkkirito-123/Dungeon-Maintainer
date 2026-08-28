/**
 * Playwright Chromium 与协议 v3 页面客户端。
 *
 * 浏览器使用全新临时 Context，不读取用户 Chrome Profile。所有页面调用都固定为
 * look/go/use/inputSql/query/judge/checkpoint，不接受模型 JavaScript、CSS 选择器或坐标；
 * inputSql 只接受文本并写入当前固定 textarea。
 * headed Chromium 只打开维护器 Shell 页面；游戏本身作为 Shell 内的 iframe 加载，
 * 因此用户只看到一个可拖拽分栏的窗口。没有 Shell 地址时仅用于单元测试兼容直开游戏。
 */

import {
  chromium,
  type BrowserContext,
  type Frame,
  type Page,
} from "playwright";
import type {
  PlayJudge,
  PlayResult,
  PlayView,
  PlaytestEvent,
} from "./protocol.js";

/** 浏览器、页面或开发桥无法完成固定请求。 */
export class GameBrowserError extends Error {}

/** 浏览器页面错误的低敏通知。 */
export type BrowserErrorListener = (kind: string) => void;

/** 试玩模式不把同源可选 Presence 服务缺席计为游戏故障。 */
export function isOptionalPresenceError(baseUrl: string, sourceUrl: string): boolean {
  try {
    const source = new URL(sourceUrl);
    return source.origin === new URL(baseUrl).origin && source.pathname === "/api/presence";
  } catch {
    return false;
  }
}

/**
 * 一个 Pi 任务持有的唯一 Chromium 会话。
 *
 * open 与 close 都是幂等边界之外的显式操作；调用方必须在 session_shutdown 中 close。
 */
export class GameBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private gameUrl = "";
  /** 已处理的恢复文档 timeOrigin；同一恢复页面不能在后续验证中重复冒充自动刷新。 */
  private lastRestoredTimeOrigin: number | null = null;

  /**
   * @param baseUrl 当前 worktree 的本机 Vite 地址。
   * @param onError 页面错误通知，只允许记录分类而非控制台正文。
   * @param shellUrl 统一 Chromium Shell 地址；正式 start/resume 必须提供。
   */
  constructor(
    private readonly baseUrl: string,
    private readonly onError: BrowserErrorListener,
    private readonly shellUrl: string | null = process.env.DUNGEON_MAINTAINER_SHELL_URL?.trim() || null,
  ) {}

  /**
   * 启动 Chromium 并打开开发桥页面。
   *
   * @param floor 初始管理员预览楼层。
   * @param headless 基准测试时使用无界面 Chromium；正式维护会话始终为 `false`。
   */
  async open(floor = 1, headless = false): Promise<void> {
    this.gameUrl = this.baseUrl + "/?playtest=agent&floor=" + String(floor);
    const initialUrl = this.shellUrl ?? this.gameUrl;
    try {
      this.context = await chromium.launchPersistentContext("", {
        headless,
        reducedMotion: "reduce",
        viewport: null,
        args: [
          `--app=${initialUrl}`,
          "--window-size=1500,1000",
        ],
      });
    } catch (error) {
      throw new GameBrowserError(
        "Chromium 未安装；请运行 pnpm exec playwright install chromium",
        { cause: error },
      );
    }
    // 空 userDataDir 会让 Playwright 创建并回收临时 Profile；--app 去掉浏览器工具栏，
    // viewport:null 则让网页视口始终跟随真实窗口。固定虚拟视口会在高 DPI 屏幕上把
    // 左侧输入框和底部状态栏裁到窗口之外，也会破坏用户拖动窗口后的响应式布局。
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(15_000);
    this.page.on("console", (message) => {
      if (
        message.type() === "error"
        && !isOptionalPresenceError(this.baseUrl, message.location().url)
      ) {
        this.onError("console-error");
      }
    });
    this.page.on("pageerror", () => {
      this.onError("page-error");
    });
    await this.page.goto(
      initialUrl,
      { waitUntil: "domcontentloaded" },
    );
    await this.waitForReady();
  }

  /** 关闭临时 Context 和浏览器进程。 */
  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.lastRestoredTimeOrigin = null;
  }

  /** 将 headed 游戏窗口带到前台。 */
  async focus(): Promise<void> {
    await this.needPage().bringToFront();
  }

  /**
   * 在首个复现检查点前应用一个内置管理员状态预设。
   *
   * 该入口只供零模型 Eval 准备确定性起点，不属于 Pi 的游戏工具面；
   * 预设 ID 由受校验的 fixture 提供，页面拒绝未知预设。
   */
  async prepare(presetId: string): Promise<void> {
    const prepared = await this.needGameFrame().then((frame) => frame.evaluate((id) => {
      const bridge = (window as unknown as {
        __DUNGEON_PLAYTEST__?: { prepare?: (value: string) => boolean };
      }).__DUNGEON_PLAYTEST__;
      return bridge?.prepare?.(id) ?? false;
    }, presetId));
    if (!prepared) throw new GameBrowserError("游戏无法应用 Eval 起点预设");
  }

  /**
   * 保存一次性页面检查点。
   *
   * @throws 桥未安装或 sessionStorage 写入失败时拒绝，调用方不得继续 patch。
   */
  async checkpoint(): Promise<void> {
    const saved = await this.needGameFrame().then((frame) => frame.evaluate(() => {
      const bridge = (window as unknown as {
        __DUNGEON_PLAYTEST__?: { checkpoint?: () => boolean };
      }).__DUNGEON_PLAYTEST__;
      return bridge?.checkpoint?.() ?? false;
    }));
    if (!saved) throw new GameBrowserError("游戏状态无法建立刷新检查点");
  }

  /**
   * 重新加载页面并确认一次性检查点被消费。
   *
   * @returns 恢复后的玩家投影。
   */
  async reloadFromCheckpoint(): Promise<PlayView> {
    const currentFrame = await this.needGameFrame();
    await this.waitForReady(currentFrame);
    // Vite 可能在源码写入后先于驱动器自动刷新 iframe，并已消费
    // 一次性 checkpoint。此时再 goto 会二次消费一个不存在的令牌。
    const currentRestoration = await this.restorationState(currentFrame);
    if (
      currentRestoration.restored
      && currentRestoration.timeOrigin !== this.lastRestoredTimeOrigin
    ) {
      this.lastRestoredTimeOrigin = currentRestoration.timeOrigin;
      return await this.look();
    }

    await currentFrame.goto(this.gameUrl, { waitUntil: "domcontentloaded" });
    const restoredFrame = await this.needGameFrame();
    await this.waitForReady(restoredFrame);
    const restored = await this.restorationState(restoredFrame);
    if (!restored.restored) {
      throw new GameBrowserError("刷新后未消费一次性游戏检查点");
    }
    this.lastRestoredTimeOrigin = restored.timeOrigin;
    return await this.look();
  }

  /** 读取玩家投影。 */
  async look(): Promise<PlayView> {
    return await this.call<PlayView>("look", []);
  }

  /** 让桥内部执行有限 BFS 移动。 */
  async go(
    target: "objective" | "frontier",
    maxSteps: number,
  ): Promise<PlayResult> {
    return await this.call<PlayResult>(
      "go",
      [target, Math.max(1, Math.min(64, maxSteps))],
    );
  }

  /** 执行 look 返回的稳定动作 ID。 */
  async use(actionId: string): Promise<PlayResult> {
    return await this.call<PlayResult>("use", [actionId]);
  }

  /** 向当前已打开的固定玩家 textarea 写入 SQL，不执行查询或接受选择器。 */
  async inputSql(sql: string): Promise<PlayResult> {
    return await this.call<PlayResult>("inputSql", [sql]);
  }

  /** 点击当前玩家终端执行 textarea 现值，调用方不能传 SQL 参数。 */
  async query(): Promise<PlayResult> {
    return await this.call<PlayResult>("query", []);
  }

  /** 读取隐藏验证摘要，不向模型工具暴露。 */
  async judge(floor: number): Promise<PlayJudge> {
    return await this.call<PlayJudge>("judge", [floor]);
  }

  /** 增量读取低敏桥事件。 */
  async events(afterSequence: number): Promise<readonly PlaytestEvent[]> {
    return await this.call<readonly PlaytestEvent[]>(
      "events",
      [afterSequence],
    );
  }

  /** 返回已通过门禁的当前桥协议版本。 */
  async protocolVersion(): Promise<3> {
    const version = await this.needGameFrame().then((frame) => frame.evaluate(() => (
      (window as unknown as {
        __DUNGEON_PLAYTEST__?: { version?: number };
      }).__DUNGEON_PLAYTEST__?.version
    )));
    if (version !== 3) throw new GameBrowserError("游戏桥协议版本不受支持");
    return version;
  }

  private async waitForReady(frame?: Frame): Promise<void> {
    const currentFrame = frame ?? await this.needGameFrame();
    await currentFrame.waitForFunction(() => {
      const version = (window as unknown as {
        __DUNGEON_PLAYTEST__?: { version?: number };
      }).__DUNGEON_PLAYTEST__?.version;
      return version === 3;
    });
    await currentFrame.waitForFunction(() => (
      document.querySelector("#app")?.getAttribute("data-runtime-state")
      === "active"
    ));
  }

  private async restorationState(
    frame: Frame,
  ): Promise<{ restored: boolean; timeOrigin: number }> {
    return await frame.evaluate(() => ({
      restored: (window as unknown as {
        __DUNGEON_PLAYTEST__?: { checkpointRestored?: boolean };
      }).__DUNGEON_PLAYTEST__?.checkpointRestored === true,
      timeOrigin: performance.timeOrigin,
    }));
  }

  private needPage(): Page {
    if (!this.page) throw new GameBrowserError("浏览器尚未启动");
    return this.page;
  }

  private async needGameFrame(): Promise<Frame> {
    const page = this.needPage();
    if (!this.shellUrl) return page.mainFrame();
    const expectedOrigin = new URL(this.baseUrl).origin;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const frame = page.frames().find((candidate) => (
        candidate !== page.mainFrame()
        && candidate.url().startsWith(expectedOrigin)
      ));
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new GameBrowserError("统一 Shell 中的游戏 iframe 未加载");
  }

  private async call<T>(
    method: "look" | "go" | "use" | "inputSql" | "query" | "judge" | "events",
    args: unknown[],
  ): Promise<T> {
    try {
      return await this.needGameFrame().then((frame) => frame.evaluate(
        async ({ name, values }) => {
          if (name === "go" || name === "use") {
            // 左侧输入框会让游戏 iframe 收到 blur，探索场景因此暂停外部移动和交互。
            // 在固定语义动作前重新聚焦游戏根节点，恢复真实页面输入状态；这里不接受
            // 模型选择器，也不伪造键盘或鼠标轨迹。
            document.querySelector<HTMLElement>("#game-root")?.focus({
              preventScroll: true,
            });
          }
          const bridge = (window as unknown as {
            __DUNGEON_PLAYTEST__?: Record<
              string,
              (...input: unknown[]) => unknown
            >;
          }).__DUNGEON_PLAYTEST__;
          const operation = bridge?.[name];
          if (!operation) throw new Error("bridge missing");
          return await operation(...values);
        },
        { name: method, values: args },
      ) as Promise<T>);
    } catch (error) {
      throw new GameBrowserError("浏览器工具 " + method + " 执行失败", {
        cause: error,
      });
    }
  }
}
