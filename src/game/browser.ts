/**
 * Playwright Chromium 与协议 v2 页面客户端。
 *
 * 浏览器使用全新临时 Context，不读取用户 Chrome Profile。所有页面调用都固定为
 * look/go/use/query/judge/checkpoint，不接受模型 JavaScript、CSS 选择器或 SQL。
 * headed Chromium 默认移动到常见 1920 像素屏幕的右半侧；窗口管理器不接受定位参数
 * 时仍会正常打开，用户可手动调整，不影响任务安全。
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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

/**
 * 一个 Pi 任务持有的唯一 Chromium 会话。
 *
 * open 与 close 都是幂等边界之外的显式操作；调用方必须在 session_shutdown 中 close。
 */
export class GameBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  /**
   * @param baseUrl 当前 worktree 的本机 Vite 地址。
   * @param onError 页面错误通知，只允许记录分类而非控制台正文。
   */
  constructor(
    private readonly baseUrl: string,
    private readonly onError: BrowserErrorListener,
  ) {}

  /**
   * 启动 headed Chromium 并打开开发桥页面。
   *
   * @param floor 初始管理员预览楼层。
   */
  async open(floor = 1): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: false,
        args: [
          "--window-position=960,0",
          "--window-size=960,1000",
        ],
      });
    } catch (error) {
      throw new GameBrowserError(
        "Chromium 未安装；请运行 pnpm exec playwright install chromium",
        { cause: error },
      );
    }
    this.context = await this.browser.newContext({
      reducedMotion: "reduce",
      viewport: { width: 920, height: 900 },
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15_000);
    this.page.on("console", (message) => {
      if (message.type() === "error") this.onError("console-error");
    });
    this.page.on("pageerror", () => {
      this.onError("page-error");
    });
    await this.page.goto(
      this.baseUrl + "/?playtest=agent&floor=" + String(floor),
      { waitUntil: "domcontentloaded" },
    );
    await this.waitForReady();
  }

  /** 关闭临时 Context 和浏览器进程。 */
  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /** 将 headed 游戏窗口带到前台。 */
  async focus(): Promise<void> {
    await this.needPage().bringToFront();
  }

  /**
   * 保存一次性页面检查点。
   *
   * @throws 桥未安装或 sessionStorage 写入失败时拒绝，调用方不得继续 patch。
   */
  async checkpoint(): Promise<void> {
    const saved = await this.needPage().evaluate(() => {
      const bridge = (window as unknown as {
        __DUNGEON_PLAYTEST__?: { checkpoint?: () => boolean };
      }).__DUNGEON_PLAYTEST__;
      return bridge?.checkpoint?.() ?? false;
    });
    if (!saved) throw new GameBrowserError("游戏状态无法建立刷新检查点");
  }

  /**
   * 重新加载页面并确认一次性检查点被消费。
   *
   * @returns 恢复后的玩家投影。
   */
  async reloadFromCheckpoint(): Promise<PlayView> {
    const page = this.needPage();
    await page.reload({ waitUntil: "domcontentloaded" });
    await this.waitForReady();
    const restored = await page.evaluate(() => (
      (window as unknown as {
        __DUNGEON_PLAYTEST__?: { checkpointRestored?: boolean };
      }).__DUNGEON_PLAYTEST__?.checkpointRestored === true
    ));
    if (!restored) {
      throw new GameBrowserError("刷新后未消费一次性游戏检查点");
    }
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

  /** 提交桥内部管理员答案，调用方不能传 SQL。 */
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

  private async waitForReady(): Promise<void> {
    const page = this.needPage();
    await page.waitForFunction(() => (
      (window as unknown as {
        __DUNGEON_PLAYTEST__?: { version?: number };
      }).__DUNGEON_PLAYTEST__?.version === 2
    ));
    await page.waitForFunction(() => (
      document.querySelector("#app")?.getAttribute("data-runtime-state")
      === "active"
    ));
  }

  private needPage(): Page {
    if (!this.page) throw new GameBrowserError("浏览器尚未启动");
    return this.page;
  }

  private async call<T>(
    method: "look" | "go" | "use" | "query" | "judge" | "events",
    args: unknown[],
  ): Promise<T> {
    try {
      return await this.needPage().evaluate(
        async ({ name, values }) => {
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
      ) as T;
    } catch (error) {
      throw new GameBrowserError("浏览器工具 " + method + " 执行失败", {
        cause: error,
      });
    }
  }
}
