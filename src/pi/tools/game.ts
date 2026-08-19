/**
 * Pi 的 SQL Dungeon 语义游戏工具。
 *
 * 本文件只暴露 `look/go/use/query` 四种高层动作。模型不能提交 JavaScript、选择器、
 * 鼠标坐标、按键轨迹或 SQL；路径规划、交互映射和答案提交均在开发桥内部完成。
 * GameDriver 负责建立复现起点和 500 条环形 Trace，本层再把动作类型与有限状态写入
 * events.jsonl。浏览器不可用、桥版本不符或动作失败都会作为明确工具结果返回，
 * 不会改动正式仓库或用户浏览器 Profile。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GameDriver } from "../../game/driver.js";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";

const EmptyParameters = Type.Object({}, { additionalProperties: false });
const GoParameters = Type.Object({
  target: Type.Union([
    Type.Literal("objective"),
    Type.Literal("frontier"),
  ]),
  maxSteps: Type.Integer({ minimum: 1, maximum: 64 }),
}, { additionalProperties: false });
const UseParameters = Type.Object({
  actionId: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-zA-Z0-9:_-]+$",
  }),
}, { additionalProperties: false });

/** 注册游戏工具所需的单任务浏览器依赖。 */
export interface GameToolContext {
  task: TaskRecord;
  store: TaskStore;
  requireDriver(): GameDriver;
}

function text(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * 向单个 Pi 会话注册四个语义游戏工具。
 *
 * @param pi 当前 Extension API。
 * @param context 与当前 headed Chromium 绑定的依赖。
 */
export function registerGameTools(
  pi: ExtensionAPI,
  context: GameToolContext,
): void {
  pi.registerTool({
    name: "look",
    label: "查看游戏",
    description: "读取玩家可见的楼层、模式、生命、任务、进度、提示和稳定动作；不返回完整地图或答案。",
    promptSnippet: "用 look 读取右侧真实游戏的玩家投影",
    executionMode: "sequential",
    parameters: EmptyParameters,
    async execute() {
      const view = await context.requireDriver().look();
      await appendEvent(context.store, context.task.id, "game.look", {
        floor: view.floor,
        mode: view.mode,
      });
      return { content: [{ type: "text", text: text(view) }], details: view };
    },
  });

  pi.registerTool({
    name: "go",
    label: "移动探索",
    description: "让开发桥按真实地图规则前往当前主线目标或最近 frontier，最多执行 64 个真实移动步。",
    promptSnippet: "用 go 执行可重放的语义移动",
    executionMode: "sequential",
    parameters: GoParameters,
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      const result = await context.requireDriver().go(
        input.target,
        input.maxSteps,
      );
      await appendEvent(context.store, context.task.id, "game.go", {
        target: input.target,
        maxSteps: input.maxSteps,
        steps: result.steps,
        ok: result.ok,
        event: result.event,
      });
      return { content: [{ type: "text", text: text(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "use",
    label: "执行交互",
    description: "执行 look 返回的稳定 actionId，例如调查、关闭记录、休息或领取战利品。",
    promptSnippet: "用 use 执行玩家可见的稳定交互",
    executionMode: "sequential",
    parameters: UseParameters,
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      const result = await context.requireDriver().use(input.actionId);
      await appendEvent(context.store, context.task.id, "game.use", {
        actionId: input.actionId,
        ok: result.ok,
        event: result.event,
      });
      return { content: [{ type: "text", text: text(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "query",
    label: "提交游戏查询",
    description: "请求开发桥提交当前管理员预选答案并经过真实 SQL 引擎和战斗规则；不接受也不返回 SQL。",
    promptSnippet: "用 query 提交桥内部答案",
    executionMode: "sequential",
    parameters: EmptyParameters,
    async execute(_toolCallId, _input, signal) {
      signal?.throwIfAborted();
      const result = await context.requireDriver().query();
      await appendEvent(context.store, context.task.id, "game.query", {
        ok: result.ok,
        event: result.event,
      });
      return { content: [{ type: "text", text: text(result) }], details: result };
    },
  });
}
