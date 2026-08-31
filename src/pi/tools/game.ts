/**
 * Pi 的 SQL Dungeon 语义游戏工具。
 *
 * 本文件只暴露 `look/act/query` 三种高层动作。模型不能提交 JavaScript、选择器、
 * 鼠标坐标或按键轨迹；query 只向当前固定 textarea 写入文本并点击真实提交控件。
 * GameDriver 负责建立复现起点和 500 条环形 Trace，本层再把动作类型与有限状态写入
 * events.jsonl。浏览器不可用、桥版本不符或动作失败都会作为明确工具结果返回，
 * 不会改动正式仓库或用户浏览器 Profile。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GameDriver } from "../../game/driver.js";
import type { PlayResult, PlayTerminalView, PlayView } from "../../game/protocol.js";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";

const EmptyParameters = Type.Object({}, { additionalProperties: false });
const ActParameters = Type.Object({
  revision: Type.String({ pattern: "^[a-f0-9]{8}$" }),
  actionId: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-zA-Z0-9:_-]+$",
  }),
  maxSteps: Type.Integer({ minimum: 1, maximum: 64 }),
}, { additionalProperties: false });
const QueryParameters = Type.Object({
  revision: Type.String({ pattern: "^[a-f0-9]{8}$" }),
  sql: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
}, { additionalProperties: false });
const MODEL_TEXT_LIMIT = 1_200;

function modelText(value: string, limit = MODEL_TEXT_LIMIT): string {
  return value.length <= limit
    ? value
    : value.slice(0, limit) + "…[内容已截断]";
}

/** 注册游戏工具所需的单任务浏览器依赖。 */
export interface GameToolContext {
  task: TaskRecord;
  store: TaskStore;
  requireDriver(): GameDriver;
}

function terminalForModel(terminal: PlayTerminalView | null): unknown {
  if (!terminal) return null;
  return {
    kind: terminal.kind,
    title: terminal.title,
    status: terminal.status,
    result: modelText(terminal.result),
    plan: terminal.plan.slice(0, 12).map((line) => modelText(line, 240)),
    inputSql: modelText(terminal.inputSql),
    objective: modelText(terminal.objective),
    lessonId: terminal.lessonId,
    stageId: terminal.stageId,
    stageIndex: terminal.stageIndex,
    task: terminal.task
      ? {
        ...terminal.task,
        situation: modelText(terminal.task.situation),
        goal: modelText(terminal.task.goal),
        outputs: terminal.task.outputs.slice(0, 16).map((item) => modelText(item, 160)),
        fields: terminal.task.fields.slice(0, 16).map((field) => ({
          expression: modelText(field.expression, 160),
          meaning: modelText(field.meaning, 240),
        })),
        relations: terminal.task.relations.slice(0, 16).map((item) => modelText(item, 200)),
        constraints: terminal.task.constraints.slice(0, 16).map((item) => modelText(item, 200)),
        success: modelText(terminal.task.success),
      }
      : null,
    schema: terminal.schema.slice(0, 24).map((item) => modelText(item, 200)),
    locks: terminal.locks.slice(0, 24).map((item) => modelText(item, 200)),
    hints: terminal.hints.slice(0, 8).map((item) => modelText(item, 240)),
  };
}

function viewForModel(view: PlayView): unknown {
  return {
    revision: view.revision,
    floor: view.floor,
    mode: view.mode,
    terminal: terminalForModel(view.terminal),
    mission: view.mission,
    prompt: view.prompt,
    banner: view.banner,
    hp: view.hp,
    progress: view.progress,
    actions: view.actions,
    target: view.target,
    room: view.room,
    record: view.record,
  };
}

function modelPayload(value: PlayView | PlayResult): unknown {
  if ("view" in value) {
    return {
      ok: value.ok,
      event: value.event,
      steps: value.steps,
      view: viewForModel(value.view),
    };
  }
  return viewForModel(value);
}

/** 把终端证据放在截断预算前部，避免长任务说明挤掉当前 SQL 与失败状态。 */
export function serializeGameToolResult(value: PlayView | PlayResult): string {
  const serialized = JSON.stringify(modelPayload(value));
  return serialized.length <= 4 * 1024
    ? serialized
    : serialized.slice(0, 4 * 1024) + "\n[游戏结果已按 4 KiB 截断]";
}

/**
 * 向单个 Pi 会话注册三个语义游戏工具。
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
    description: "读取玩家可见的楼层、模式、生命、任务、进度和稳定动作；终端打开时还返回题面、schema、当前 textarea SQL、状态、结果与计划，不返回隐藏答案。",
    promptSnippet: "用 look 读取右侧真实游戏的玩家投影",
    executionMode: "sequential",
    parameters: EmptyParameters,
    async execute() {
      const view = await context.requireDriver().look();
      await appendEvent(context.store, context.task.id, "game.look", {
        floor: view.floor,
        mode: view.mode,
      });
      return { content: [{ type: "text", text: serializeGameToolResult(view) }], details: view };
    },
  });

  pi.registerTool({
    name: "act",
    label: "执行游戏动作",
    description: "执行最新 look 返回的 actionId；移动最多 64 个真实步，可跨过无需决策的中途 action/task 边界，并保留最终 E 交互停点；其它动作只点击固定可见控件。",
    promptSnippet: "用 act 消费最新 look 的修订和动作",
    executionMode: "sequential",
    parameters: ActParameters,
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      const result = await context.requireDriver().act(
        input.revision,
        input.actionId,
        input.maxSteps,
      );
      await appendEvent(context.store, context.task.id, "game.act", {
        actionId: input.actionId,
        maxSteps: input.maxSteps,
        steps: result.steps,
        ok: result.ok,
        event: result.event,
      });
      return { content: [{ type: "text", text: serializeGameToolResult(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "query",
    label: "提交游戏查询",
    description: "把 SQL 写入当前玩家可见的固定 textarea，再点击真实执行按钮并经过 AppShell、SQL 引擎和游戏规则。",
    promptSnippet: "用 query 一次完成可见 SQL 输入和真实提交",
    executionMode: "sequential",
    parameters: QueryParameters,
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      const result = await context.requireDriver().query(input.sql, input.revision);
      await appendEvent(context.store, context.task.id, "game.query", {
        inputLength: input.sql.length,
        ok: result.ok,
        event: result.event,
      });
      return { content: [{ type: "text", text: serializeGameToolResult(result) }], details: result };
    },
  });
}
