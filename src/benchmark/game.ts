/**
 * 真实 Vite + Chromium + 协议桥的无模型可见性与控制基准。
 *
 * 控制器只能看到玩家投影并调用固定 `look/go/use/input_sql/query` 语义动作；它拿不到坐标、隐藏
 * 答案或地图。场景导航到首个终端，确认题面、schema、textarea 和查询状态均可见，
 * 再提交一次当前空输入并要求得到玩家可见拒绝。零模型脚本不伪装成 SQL 求解器；真实
 * Agent 的源码定位、修复闭环和 Token 门槛由 task benchmark 单独验证。
 */

import { resolve } from "node:path";
import { GameBrowser } from "../game/browser.js";
import { GameDriver } from "../game/driver.js";
import type { PlayResult, PlayView } from "../game/protocol.js";
import { startGameServer } from "../game/server.js";
import { replayableTraceActions } from "../repair/reproduction.js";
import { metric, scenario, type BenchmarkScenario } from "./types.js";

const MAX_CONTROL_TURNS = 48;
const MAX_DURATION_MS = 60_000;
const FORBIDDEN_VIEW_KEYS = new Set([
  "adminAnswerSql",
  "answerSql",
  "roomGraph",
  "savedRun",
  "profile",
  "judge",
]);

function interactionSignature(view: PlayView): string {
  return [view.room, view.progress.lessons, view.progress.moves, view.prompt].join("|");
}

function hasAction(view: PlayView, id: string): boolean {
  return view.actions.some((action) => action.id === id);
}

function countForbiddenViewKeys(value: unknown): number {
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value as unknown[]) {
      total += countForbiddenViewKeys(entry);
    }
    return total;
  }
  if (!value || typeof value !== "object") return 0;
  let total = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_VIEW_KEYS.has(key)) total += 1;
    total += countForbiddenViewKeys(entry);
  }
  return total;
}

/**
 * 运行真实浏览器的玩家投影、有限控制、拒绝反馈和短检查点重放基准。
 *
 * @param repositoryRoot SQL Dungeon 仓库根目录；必须已安装 `game/node_modules`。
 * @returns 不含隐藏状态或 SQL 正文的指标报告。
 */
export async function runGameBridgeBenchmark(
  repositoryRoot: string,
): Promise<BenchmarkScenario> {
  const startedAt = performance.now();
  const browserErrors: string[] = [];
  const server = await startGameServer(resolve(repositoryRoot));
  const browser = new GameBrowser(server.url, (kind) => browserErrors.push(kind), null);
  let controlTurns = 0;
  let semanticActions = 0;
  let queryCalls = 0;
  let rejectedActions = 0;
  let maxConsecutiveIdenticalRejections = 0;
  let lastRejectionSignature = "";
  let consecutiveIdenticalRejections = 0;
  let bridgeReadyMs = 0;
  let finalFloor = 0;
  let replayPassed = false;
  let replayFinalFloor = 0;
  let replayActionCount = 0;
  let replayFailure: string | null = null;
  let terminalOpened = false;
  let terminalTaskVisible = false;
  let terminalSchemaVisible = false;
  let terminalInputVisible = false;
  let terminalQueryStatusVisible = false;
  let emptyQueryRejected = false;
  let controlledInputWritten = false;
  let controlledQueryRejected = false;
  let controlledInputReplayPassed = false;
  let controlledInputReplayActionCount = 0;
  let controlledInputReplayFailure: string | null = null;
  let forbiddenViewKeyCount = 0;

  const observe = (view: PlayView): void => {
    finalFloor = view.floor;
    forbiddenViewKeyCount += countForbiddenViewKeys(view);
    if (!view.terminal) return;
    terminalOpened = true;
    terminalTaskVisible ||= view.terminal.kind === "challenge"
      || Boolean(view.terminal.task?.goal && view.terminal.task.outputs.length > 0);
    terminalSchemaVisible ||= view.terminal.schema.length > 0;
    terminalInputVisible ||= typeof view.terminal.inputSql === "string";
    terminalQueryStatusVisible ||= view.terminal.status.text.trim().length > 0;
  };

  const recordResult = (selectedAction: string, signature: string, result: PlayResult): void => {
    observe(result.view);
    semanticActions += 1;
    if (!result.ok) {
      rejectedActions += 1;
      const rejectionSignature = selectedAction + "|" + signature + "|" + result.event;
      if (rejectionSignature === lastRejectionSignature) {
        consecutiveIdenticalRejections += 1;
      } else {
        consecutiveIdenticalRejections = 1;
        lastRejectionSignature = rejectionSignature;
      }
      maxConsecutiveIdenticalRejections = Math.max(
        maxConsecutiveIdenticalRejections,
        consecutiveIdenticalRejections,
      );
    } else {
      lastRejectionSignature = "";
      consecutiveIdenticalRejections = 0;
    }
  };

  try {
    await browser.open(1, true);
    bridgeReadyMs = performance.now() - startedAt;
    const driver = new GameDriver(browser);

    const replayStart = await driver.beginReproduction();
    observe(replayStart);
    const replayTarget = hasAction(replayStart, "objective")
      ? "objective" as const
      : "frontier" as const;
    const replaySeed = await driver.go(replayTarget, 64);
    observe(replaySeed.view);
    const replayActions = replayableTraceActions(driver.trace.snapshot());
    if (replaySeed.ok && replayActions.some((action) => action.action !== "look")) {
      const replay = await driver.reloadAndReplay(replayActions);
      replayPassed = replay.passed && replay.finalView.floor >= 1;
      replayFinalFloor = replay.finalView.floor;
      replayActionCount = replay.actionCount;
      replayFailure = replay.failure;
      observe(replay.finalView);
    } else {
      replayFailure = replaySeed.event;
    }

    const rejectedUseActions = new Set<string>();
    const rejectedMovements = new Set<string>();
    while (
      controlTurns < MAX_CONTROL_TURNS
      && performance.now() - startedAt < MAX_DURATION_MS
      && !controlledQueryRejected
    ) {
      controlTurns += 1;
      const view = await driver.peek();
      observe(view);
      const signature = interactionSignature(view);
      let selectedAction = "";
      let result: PlayResult | null = null;

      if (view.terminal) {
        if (!emptyQueryRejected) {
          selectedAction = "query";
          queryCalls += 1;
          result = await driver.query();
          emptyQueryRejected = !result.ok
            && result.event === "answer-not-ready"
            && result.view.terminal?.status.kind === "warning";
        } else if (!controlledInputWritten) {
          selectedAction = "input_sql";
          result = await driver.inputSql("SELECT 1");
          controlledInputWritten = result.ok;
        } else {
          selectedAction = "query";
          queryCalls += 1;
          result = await driver.query();
          controlledQueryRejected = !result.ok && result.event === "query-rejected";
        }
      } else if (
        hasAction(view, "continue")
        && !rejectedUseActions.has(signature + "|continue")
      ) {
        selectedAction = "use:continue";
        result = await driver.use("continue");
      } else if (
        hasAction(view, "terminal")
        && !rejectedUseActions.has(signature + "|terminal")
      ) {
        selectedAction = "use:terminal";
        result = await driver.use("terminal");
      } else if (
        hasAction(view, "interact")
        && !rejectedUseActions.has(signature + "|interact")
      ) {
        selectedAction = "use:interact";
        result = await driver.use("interact");
      } else if (
        hasAction(view, "take-all")
        && !rejectedUseActions.has(signature + "|take-all")
      ) {
        selectedAction = "use:take-all";
        result = await driver.use("take-all");
      } else if (
        hasAction(view, "leave-loot")
        && !rejectedUseActions.has(signature + "|leave-loot")
      ) {
        selectedAction = "use:leave-loot";
        result = await driver.use("leave-loot");
      } else if (
        hasAction(view, "leave")
        && !rejectedUseActions.has(signature + "|leave")
      ) {
        selectedAction = "use:leave";
        result = await driver.use("leave");
      } else if (
        hasAction(view, "close-review")
        && !rejectedUseActions.has(signature + "|close-review")
      ) {
        selectedAction = "use:close-review";
        result = await driver.use("close-review");
      } else if (view.actions.some((action) => (
        action.id !== "objective"
        && action.id !== "frontier"
        && !rejectedUseActions.has(signature + "|" + action.id)
      ))) {
        const action = view.actions.find((candidate) => (
          candidate.id !== "objective"
          && candidate.id !== "frontier"
          && !rejectedUseActions.has(signature + "|" + candidate.id)
        ));
        if (!action) break;
        selectedAction = "use:" + action.id;
        result = await driver.use(action.id);
      } else if (view.mode === "explore") {
        const preferredTarget = view.prompt.includes("锁住")
          || !hasAction(view, "objective") ? "frontier" : "objective";
        const alternateTarget = preferredTarget === "objective" ? "frontier" : "objective";
        const preferredKey = signature + "|" + preferredTarget;
        const alternateKey = signature + "|" + alternateTarget;
        const target = !rejectedMovements.has(preferredKey)
          ? preferredTarget
          : !rejectedMovements.has(alternateKey) ? alternateTarget : null;
        if (!target) break;
        selectedAction = "go:" + target;
        result = await driver.go(target, 64);
        if (!result.ok) rejectedMovements.add(signature + "|" + target);
      } else if (view.mode === "transition") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_700));
        continue;
      } else {
        break;
      }

      if (!result.ok && selectedAction.startsWith("use:")) {
        rejectedUseActions.add(signature + "|" + selectedAction.slice("use:".length));
      }
      recordResult(selectedAction, signature, result);
      if (!result.ok && selectedAction === "use:terminal") break;
    }
    observe(await driver.peek());
    if (controlledQueryRejected) {
      const controlledReplay = await driver.reloadAndReplay(
        replayableTraceActions(driver.trace.snapshot()),
      );
      controlledInputReplayPassed = controlledReplay.passed
        && controlledReplay.queryAccepted === false;
      controlledInputReplayActionCount = controlledReplay.actionCount;
      controlledInputReplayFailure = controlledReplay.failure;
      observe(controlledReplay.finalView);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const durationMs = performance.now() - startedAt;
  return scenario("game-bridge-visible-control", "deterministic", [
    metric({
      name: "bridge_ready_ms",
      value: Math.round(bridgeReadyMs),
      unit: "ms",
      direction: "lte",
      threshold: 30_000,
    }),
    metric({
      name: "browser_error_count",
      value: browserErrors.length,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "checkpoint_replay_passed",
      value: replayPassed,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "controlled_query_rejected",
      value: controlledQueryRejected,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "controlled_input_replay_passed",
      value: controlledInputReplayPassed,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "controlled_input_replay_actions",
      value: controlledInputReplayActionCount,
      unit: "count",
      direction: "gte",
      threshold: 2,
    }),
    metric({
      name: "checkpoint_replay_final_floor",
      value: replayFinalFloor,
      unit: "count",
      direction: "gte",
      threshold: 1,
    }),
    metric({
      name: "checkpoint_replay_actions",
      value: replayActionCount,
      unit: "count",
      direction: "lte",
      threshold: 4,
    }),
    metric({
      name: "player_terminal_opened",
      value: terminalOpened,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "player_task_brief_visible",
      value: terminalTaskVisible,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "player_schema_visible",
      value: terminalSchemaVisible,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "player_terminal_input_visible",
      value: terminalInputVisible,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "player_query_status_visible",
      value: terminalQueryStatusVisible,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "empty_query_rejected",
      value: emptyQueryRejected,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "controlled_input_written",
      value: controlledInputWritten,
      unit: "boolean",
      direction: "eq",
      threshold: true,
    }),
    metric({
      name: "forbidden_view_key_count",
      value: forbiddenViewKeyCount,
      unit: "count",
      direction: "eq",
      threshold: 0,
    }),
    metric({
      name: "rejected_action_count",
      value: rejectedActions,
      unit: "count",
      direction: "lte",
      threshold: 4,
    }),
    metric({
      name: "max_consecutive_identical_rejections",
      value: maxConsecutiveIdenticalRejections,
      unit: "count",
      direction: "lte",
      threshold: 1,
    }),
    metric({
      name: "duration_ms",
      value: Math.round(durationMs),
      unit: "ms",
      direction: "lte",
      threshold: MAX_DURATION_MS,
    }),
    metric({
      name: "control_turns",
      value: controlTurns,
      unit: "count",
      direction: "lte",
      threshold: MAX_CONTROL_TURNS,
    }),
    metric({
      name: "semantic_actions",
      value: semanticActions,
      unit: "count",
      direction: "lte",
      threshold: MAX_CONTROL_TURNS,
    }),
    metric({
      name: "query_calls",
      value: queryCalls,
      unit: "count",
      direction: "gte",
      threshold: 2,
    }),
    metric({
      name: "model_tokens",
      value: 0,
      unit: "tokens",
      direction: "eq",
      threshold: 0,
    }),
  ], [
    ...(replayPassed ? [] : [
      "checkpoint replay failure: " + (replayFailure ?? "not-run"),
      "final floor: " + String(finalFloor),
    ]),
    ...(controlledInputReplayPassed ? [] : [
      "controlled input replay failure: " + (controlledInputReplayFailure ?? "not-run"),
    ]),
  ]);
}
