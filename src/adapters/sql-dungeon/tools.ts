/**
 * SQL Dungeon 的四个 Pi 环境工具。
 *
 * 工具只包装协议 v2 浏览器桥：模型可以观察、选择目标、执行公开交互或请求桥内部
 * 提交预选答案。路径、BFS、frontier 回退和 SQL 正文都留在游戏进程；本模块不能
 * 接受选择器、Shell、JavaScript 或 SQL。每次完成后只记录有限玩家尾迹并广播验证
 * 阶段，不读取隐藏裁判。
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HarnessStepDraft, HarnessToolContext } from "../../harness/contract.js";
import { harnessEvent } from "../../harness/events.js";
import type { BrowserResult, GameBrowser, PlayView } from "./browser.js";
import { dungeonTrace } from "./evidence.js";

const EmptyParams = Type.Object({}, { additionalProperties: false });
const GoParams = Type.Object({
  target: Type.Union([Type.Literal("objective"), Type.Literal("frontier")]),
  maxSteps: Type.Integer({ minimum: 1, maximum: 64 }),
}, { additionalProperties: false });
const UseParams = Type.Object({
  actionId: Type.String({ minLength: 1, maxLength: 48 }),
}, { additionalProperties: false });

function output<T>(value: T): { content: [{ type: "text"; text: string }]; details: T } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function draft(action: string, result: BrowserResult, started: number): HarnessStepDraft {
  return {
    action,
    event: result.event.replace(/[^a-zA-Z0-9:_-]/gu, "-").slice(0, 80),
    ok: result.ok,
    ms: Math.max(0, Math.round(performance.now() - started)),
    units: Math.max(0, Math.min(64, result.steps)),
    state: result.view.mode.slice(0, 32),
    trace: dungeonTrace(result.view),
  };
}

async function complete(
  context: HarnessToolContext,
  action: "look" | "go" | "use" | "query",
  result: BrowserResult,
  started: number,
): Promise<void> {
  context.record(draft(action, result, started));
  await context.emit(harnessEvent({
    type: "action",
    phase: "verify",
    action,
    state: result.ok ? "done" : "error",
    ok: result.ok,
    message: `${result.event} / ${String(result.steps)} steps`,
  }));
}

/**
 * 创建当前临时浏览器会话的固定动作工具。
 * @param browser 只连接本机协议 v2 桥的临时 Chromium 客户端。
 * @param context Runner 提供的脱敏事件和步骤回调。
 * @returns 串行 `look/go/use/query`；工具参数均为严格 TypeBox 契约。
 */
export function createDungeonTools(browser: GameBrowser, context: HarnessToolContext): AgentTool[] {
  const look: AgentTool<typeof EmptyParams, PlayView> = {
    name: "look",
    label: "查看环境",
    executionMode: "sequential",
    description: "读取玩家可见的当前楼层、模式、任务、生命、进度和可选动作；每个场景先调用它。",
    parameters: EmptyParams,
    execute: async () => {
      const started = performance.now();
      const view = await browser.look();
      await complete(context, "look", { ok: true, event: "look", steps: 0, view }, started);
      return output(view);
    },
  };
  const go: AgentTool<typeof GoParams, BrowserResult> = {
    name: "go",
    label: "移动探索",
    executionMode: "sequential",
    description: "选择主线目标或 frontier；桥内 BFS 连续执行最多 64 个真实步并在语义事件后停止。",
    parameters: GoParams,
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted();
      const started = performance.now();
      const result = await browser.go(input.target, input.maxSteps);
      await complete(context, "go", result, started);
      return output(result);
    },
  };
  const use: AgentTool<typeof UseParams, BrowserResult> = {
    name: "use",
    label: "执行交互",
    executionMode: "sequential",
    description: "执行当前玩家投影列出的稳定动作 ID，例如关闭记录、交互、领取奖励或离开菜单。",
    parameters: UseParams,
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted();
      const started = performance.now();
      const result = await browser.use(input.actionId);
      await complete(context, "use", result, started);
      return output(result);
    },
  };
  const query: AgentTool<typeof EmptyParams, BrowserResult> = {
    name: "query",
    label: "请求提交答案",
    executionMode: "sequential",
    description: "请求游戏桥提交当前挑战的预选答案；模型不能读取、生成或传入 SQL。",
    parameters: EmptyParams,
    execute: async (_id, _input, signal) => {
      signal?.throwIfAborted();
      const started = performance.now();
      const result = await browser.query();
      await complete(context, "query", result, started);
      return output(result);
    },
  };
  return [look, go, use, query];
}
