/**
 * Playwright、临时浏览器上下文和本机 Vite 服务适配层。
 *
 * 每次试玩创建全新的 Chromium Context，不读取用户 Profile 或 IndexedDB。未提供 URL
 * 时仅监听 `127.0.0.1` 并在结束时回收子进程；外部 URL 也必须是 localhost。
 * 浏览器只调用协议 v2 的 `look/go/use/query/judge`，不执行任意页面脚本。控制台和
 * 截图在写盘前清除 SQL、Key、终端、管理员地图和答案区域；桥缺失或版本错误会明确
 * 分类为工具阻断。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { redactText } from "../../safety/redact.js";
import type { HarnessEvent } from "../../harness/events.js";

/** 浏览器、开发服务器或桥无法完成请求。 */
export class BrowserError extends Error {}

/** 玩家可见且经过游戏桥裁剪的状态。 */
export interface PlayView {
  floor: number;
  mode: string;
  hp: { current: number; max: number; armor: number };
  progress: { lessons: number; rooms: number; moves: number; queries: number; hintLevel: number };
  actions: Array<{ id: string; label: string }>;
  room: string;
  mission: { title: string; body: string; lesson: string };
  record: { kicker: string; title: string; body: string } | null;
  prompt: string;
  banner: string;
}

/** 一个真实浏览器动作的有限结果。 */
export interface BrowserResult { ok: boolean; event: string; steps: number; view: PlayView }

/** 隐藏裁判只向 Runner 返回通关断言，不进入模型上下文。 */
export interface PlayJudge {
  floor: number; mode: string; lessons: number; requiredLessons: number;
  bossDefeated: boolean; migrationSteps: number; migrationComplete: boolean; advanced: boolean;
}

/** Dashboard 命令是否被本地控制器接受。 */
export interface CommandAck {
  schemaVersion: 1;
  accepted: boolean;
  reason: "started" | "busy" | "closed" | "invalid_state";
}

/** 三个网页按钮绑定的无参数处理器。 */
export interface DashboardBindings {
  diagnose(): Promise<CommandAck>;
  fix(): Promise<CommandAck>;
  apply(): Promise<CommandAck>;
}

/** 隐藏健康裁判使用的有限运行状态，不含页面正文或游戏快照。 */
export interface BrowserHealth {
  bridge: boolean;
  runtime: boolean;
  errors: number;
  floor: number;
  mode: string;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("无法分配本机端口")); return; }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function localUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new BrowserError("试玩只允许本机 HTTP 游戏地址");
  }
  return url;
}

/** 只读本机游戏服务句柄。 */
export interface GameServer { url: string; close(): Promise<void> }

/**
 * 启动或复用本机开发服务器。
 * @param repoRoot SQL Dungeon 仓库根目录。
 * @param givenUrl 可选的已启动 localhost 地址。
 * @param signal 取消时终止自启服务。
 */
export async function startGame(repoRoot: string, givenUrl?: string, signal?: AbortSignal): Promise<GameServer> {
  if (givenUrl) return { url: localUrl(givenUrl).toString().replace(/\/$/u, ""), close: () => Promise.resolve() };
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  // Windows 下 Node 不保证以 shell:false 直接执行 pnpm.cmd。直接运行目标项目锁定的
  // Vite JS 入口既跨平台，也继续保持“固定文件 + 固定参数”，模型无法注入 Shell。
  const gameRoot = join(repoRoot, "game");
  const vite = join(gameRoot, "node_modules", "vite", "bin", "vite.js");
  const child: ChildProcess = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: gameRoot, stdio: "ignore", windowsHide: true, shell: false,
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode !== null) throw new BrowserError("游戏开发服务器启动失败");
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }); if (response.ok) break; } catch { /* 等待 Vite */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline) { child.kill(); throw new BrowserError("等待游戏开发服务器超时"); }
  return {
    url,
    close: async () => {
      signal?.removeEventListener("abort", abort);
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => { child.once("close", () => resolve()); setTimeout(resolve, 5_000).unref(); });
    },
  };
}

/**
 * 协议 v2 浏览器客户端。
 *
 * 所有方法只调用固定桥函数；返回值通过结构化克隆由 Playwright 序列化，不执行模型
 * 提供的脚本或选择器。`close` 总会销毁临时 Context。
 */
export class GameBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private floor: number | null = null;
  private checkpointView: PlayView | null = null;
  private readonly console: string[] = [];
  private errors = 0;

  constructor(private readonly baseUrl: string, private readonly headed: boolean, private readonly output: string) {}

  /** 启动临时 Chromium Context。 */
  async open(): Promise<void> {
    try { this.browser = await chromium.launch({ headless: !this.headed }); }
    catch (error) { throw new BrowserError("Chromium 未安装；运行 pnpm exec playwright install chromium", { cause: error }); }
    this.context = await this.browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15_000);
    this.page.on("console", (message) => {
      if (message.type() === "error") this.errors += 1;
      this.log(`CONSOLE ${message.type()}: ${message.text()}`);
    });
    this.page.on("pageerror", (error) => {
      this.errors += 1;
      this.log(`PAGE ERROR: ${error.name}`);
    });
  }

  /**
   * 在页面导航前注册三个无参数 Dashboard binding。
   * @param bindings 只闭包持有当前任务，不接受网页传入路径、Prompt、SQL 或命令。
   */
  async bindDashboard(bindings: DashboardBindings): Promise<void> {
    const page = this.needPage();
    await page.exposeBinding("__DUNGEON_QUICK_CHECK__", async () => await bindings.diagnose());
    await page.exposeBinding("__DUNGEON_QUICK_FIX__", async () => await bindings.fix());
    await page.exposeBinding("__DUNGEON_APPLY_FIX__", async () => await bindings.apply());
  }

  /** 关闭并写入脱敏控制台。 */
  async close(): Promise<void> {
    let writeError: unknown = null;
    try {
      await mkdir(this.output, { recursive: true });
      await writeFile(join(this.output, "console.log"), `${this.console.join("\n")}\n`, "utf8");
    } catch (error) {
      writeError = error;
    } finally {
      await this.context?.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
      this.page = null; this.context = null; this.browser = null;
    }
    if (writeError) throw new Error("写入脱敏浏览器日志失败", { cause: writeError });
  }

  /** 打开一个隔离楼层并等待正式 UI 与 v2 桥。 */
  async openFloor(floor: number): Promise<PlayView> {
    const page = this.needPage();
    this.floor = floor;
    await page.goto(`${this.baseUrl}/?playtest=agent&floor=${String(floor)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { __DUNGEON_PLAYTEST__?: { version: number } }).__DUNGEON_PLAYTEST__?.version === 2);
    await page.waitForFunction(() => document.querySelector("#app")?.getAttribute("data-runtime-state") === "active");
    return await this.look();
  }

  /**
   * 在源码写入前保存当前临时页面状态。
   * @throws 桥或 sessionStorage 无法建立检查点时抛出，调用方不得继续写补丁。
   */
  async checkpoint(): Promise<void> {
    const page = this.needPage();
    if (this.floor === null) throw new BrowserError("尚未打开试玩楼层");
    const before = await this.look();
    const saved = await page.evaluate(() => {
      const bridge = (window as unknown as {
        __DUNGEON_PLAYTEST__?: { checkpoint?: () => boolean };
      }).__DUNGEON_PLAYTEST__;
      return bridge?.checkpoint?.() ?? false;
    });
    if (!saved) throw new BrowserError("当前游戏状态无法建立刷新检查点");
    this.checkpointView = before;
  }

  /** 补丁后重新加载当前临时页面，使 Vite/浏览器使用最新 worktree 代码。 */
  async reload(preserve = false): Promise<PlayView> {
    const page = this.needPage();
    if (this.floor === null) throw new BrowserError("尚未打开试玩楼层");
    if (preserve && !this.checkpointView) await this.checkpoint();
    const before = preserve ? this.checkpointView : null;
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => (window as unknown as { __DUNGEON_PLAYTEST__?: { version: number } }).__DUNGEON_PLAYTEST__?.version === 2);
      await page.waitForFunction(() => document.querySelector("#app")?.getAttribute("data-runtime-state") === "active");
      const restored = await page.evaluate(() => (
        (window as unknown as {
          __DUNGEON_PLAYTEST__?: { checkpointRestored?: boolean };
        }).__DUNGEON_PLAYTEST__?.checkpointRestored === true
      ));
      if (preserve && !restored) {
        throw new BrowserError("刷新后未消费一次性游戏检查点");
      }
      const after = await this.look();
      if (before && (
        after.floor !== before.floor
        || after.mode !== before.mode
        || after.hp.current !== before.hp.current
        || after.hp.armor !== before.hp.armor
        || JSON.stringify(after.progress) !== JSON.stringify(before.progress)
      )) {
        throw new BrowserError("刷新后游戏检查点未完整恢复");
      }
      return after;
    } finally {
      if (preserve) this.checkpointView = null;
    }
  }

  /** 读取玩家投影。 */
  async look(): Promise<PlayView> { return await this.call<PlayView>("look", []); }
  /** 让桥内部 BFS 前往目标；objective 不可达时桥内部探索 frontier。 */
  async go(target: "objective" | "frontier", maxSteps: number): Promise<BrowserResult> { return await this.call<BrowserResult>("go", [target, Math.max(1, Math.min(64, maxSteps))]); }
  /** 执行游戏投影返回的稳定动作 ID。 */
  async use(actionId: string): Promise<BrowserResult> { return await this.call<BrowserResult>("use", [actionId]); }
  /** 提交桥内部预选答案；调用方无法传 SQL。 */
  async query(): Promise<BrowserResult> { return await this.call<BrowserResult>("query", []); }
  /** 读取隐藏裁判结果，仅供 Runner 断言。 */
  async judge(floor: number): Promise<PlayJudge> { return await this.call<PlayJudge>("judge", [floor]); }
  /** 读取当前楼层，不重置或推进游戏。 */
  async currentFloor(): Promise<number> { return (await this.look()).floor; }
  /** 返回供隐藏健康裁判使用的计数，不暴露控制台正文。 */
  async health(): Promise<BrowserHealth> {
    const page = this.needPage();
    const state = await page.evaluate(() => ({
      bridge: (window as unknown as { __DUNGEON_PLAYTEST__?: { version?: number } }).__DUNGEON_PLAYTEST__?.version === 2,
      runtime: document.querySelector("#app")?.getAttribute("data-runtime-state") === "active",
    }));
    const view = await this.look();
    return { ...state, errors: this.errors, floor: view.floor, mode: view.mode };
  }
  /** 等待用户关闭 Dashboard 页面；取消信号只结束等待，不执行页面脚本。 */
  async waitUntilClosed(signal?: AbortSignal): Promise<void> {
    const page = this.needPage();
    if (page.isClosed()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        resolve();
      };
      page.once("close", done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  /** 等待游戏自身的动画、死亡或换层计时器。 */
  async wait(ms = 150): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

  /** 将脱敏的模型回合事件推送到同一游戏窗口的左侧控制台。 */
  async emitAgent(event: HarnessEvent): Promise<void> {
    await this.needPage().evaluate((value) => {
      window.dispatchEvent(new CustomEvent("dungeon:agent-log", { detail: value }));
    }, event);
  }

  /** 保存隐藏 SQL 编辑器、管理员 UI 后的客观截图。 */
  async screenshot(path: string): Promise<void> {
    const page = this.needPage();
    await page.evaluate(() => {
      document.querySelectorAll("textarea").forEach((node) => { node.value = ""; });
      document.querySelectorAll<HTMLElement>("#admin-menu, #answer-review, #combat-terminal, #gate-terminal, .castle-map-card").forEach((node) => { node.dataset.playtestHidden = node.style.visibility; node.style.visibility = "hidden"; });
    });
    try { await page.screenshot({ path, fullPage: true }); }
    finally { await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-playtest-hidden]").forEach((node) => { node.style.visibility = node.dataset.playtestHidden ?? ""; delete node.dataset.playtestHidden; })); }
  }

  private needPage(): Page { if (!this.page) throw new BrowserError("浏览器尚未启动"); return this.page; }
  private async call<T>(method: "look" | "go" | "use" | "query" | "judge", args: unknown[]): Promise<T> {
    try {
      return await this.needPage().evaluate(async ({ name, values }) => {
        const bridge = (window as unknown as { __DUNGEON_PLAYTEST__?: Record<string, (...input: unknown[]) => unknown> }).__DUNGEON_PLAYTEST__;
        const fn = bridge?.[name];
        if (!fn) throw new Error("bridge missing");
        return await fn(...values);
      }, { name: method, values: args }) as T;
    } catch (error) { throw new BrowserError(`浏览器工具 ${method} 执行失败`, { cause: error }); }
  }
  private log(line: string): void {
    const safe = redactText(line).replace(/\s+/gu, " ").slice(0, 1_000);
    this.console.push(safe);
    if (this.console.length > 2_000) this.console.shift();
  }
}
