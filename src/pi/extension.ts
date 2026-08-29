/**
 * Dungeon Maintainer 的唯一 Pi Extension 装配入口。
 *
 * 本文件只创建单任务依赖，注册 Provider、固定工具与命令，并按 Pi 事件流连接安全策略、
 * 请求生命周期和写入协调器。具体请求状态在 `request-lifecycle.ts`，edit 的写后结果
 * 分类在 `native-write.ts`，游戏进程在 `game-runtime.ts`。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, requireApiKey, type MaintainerConfig } from "../config.js";
import { EvidenceStore } from "../evidence/store.js";
import type { GameDriver } from "../game/driver.js";
import {
  verifyTask as runTaskVerification,
  type VerificationResult,
} from "../repair/verification.js";
import { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { registerMaintainerCommands } from "./commands/index.js";
import { DungeonGameRuntime } from "./game-runtime.js";
import { createNativeWriteCoordinator } from "./native-write.js";
import { createRequestLifecycle } from "./request-lifecycle.js";
import {
  assertTaskSessionBinding,
  registerSessionPolicyHooks,
} from "./session-policy.js";
import { FULL_CODING_TOOLS } from "./tool-policy.js";
import { ToolSafetyGate } from "./tool-safety-gate.js";
import { registerMaintainerTools } from "./tools/index.js";

interface DungeonGameRuntimePort {
  currentDriver(): GameDriver | null;
  requireDriver(): GameDriver;
  ensure(): Promise<GameDriver>;
  close(): Promise<void>;
}

/** Extension 安装所需的已验证任务事实。 */
export interface DungeonExtensionOptions {
  config: MaintainerConfig;
  store: TaskStore;
  task: TaskRecord;
  /** 测试可注入不启动外部进程的同契约运行时；生产环境始终使用真实运行时。 */
  gameRuntime?: DungeonGameRuntimePort;
  /** 测试可注入确定性验证器；生产环境始终调用 repair/verification。 */
  verifyTask?: (signal?: AbortSignal) => Promise<VerificationResult>;
  evidenceStore?: EvidenceStore;
}

/** 注册 `.env` 指定的唯一 OpenAI-compatible 模型。 */
function registerProviders(
  pi: ExtensionAPI,
  config: MaintainerConfig,
): void {
  pi.registerProvider("dungeon-maintainer", {
    name: "Dungeon Maintainer",
    baseUrl: config.baseUrl,
    apiKey: "$MAINTAINER_API_KEY",
    api: "openai-completions",
    models: [{
      id: config.model,
      name: config.model,
      reasoning: config.reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.contextWindow,
      maxTokens: config.maxOutputTokens,
    }],
  });
}

/**
 * 把固定任务安装到当前 Pi Extension API。
 *
 * 注册阶段不启动外部进程；游戏由 request lifecycle 在 session_start 时惰性启动。
 */
export function installDungeonMaintainerExtension(
  pi: ExtensionAPI,
  options: DungeonExtensionOptions,
): void {
  const { config, store, task } = options;
  // TaskStore 已由入口绑定到权威任务目录；Evidence 必须跟随同一目录，否则隔离
  // Eval、测试注入或自定义数据目录会形成两套任务事实。
  const evidence = options.evidenceStore ?? new EvidenceStore(store.dataDir, task);
  const gameRuntime = options.gameRuntime ?? new DungeonGameRuntime(task, store);
  const verifyCurrentTask = options.verifyTask ?? (async (signal?: AbortSignal) => {
    return await runTaskVerification(
      store,
      evidence,
      task,
      gameRuntime.currentDriver(),
      signal,
    );
  });

  let executionApproved = false;
  const setExecutionApproved = (approved: boolean): void => {
    executionApproved = approved;
    // 工具集合保持稳定以复用 Prompt 缓存；真正的写权限由运行时授权与路径门禁决定。
    pi.setActiveTools([...FULL_CODING_TOOLS]);
  };
  const safetyGate = new ToolSafetyGate({
    task,
    store,
    isExecutionApproved: () => executionApproved,
    approveExecution: () => setExecutionApproved(true),
  });
  const nativeWrite = createNativeWriteCoordinator({
    task,
    store,
    safetyGate,
  });
  const requests = createRequestLifecycle({
    pi,
    task,
    store,
    evidence,
    gameRuntime,
    isExecutionApproved: () => executionApproved,
    setExecutionApproved,
    clearWriteAttributions: () => nativeWrite.clearRequestAttributions(),
  });
  const sharedContext = {
    task,
    store,
    evidence,
    currentDriver: () => gameRuntime.currentDriver(),
    requireDriver: () => gameRuntime.requireDriver(),
    ensureGame: () => gameRuntime.ensure(),
    closeGame: () => gameRuntime.close(),
    approveExecution: () => setExecutionApproved(true),
    completeExecution: () => setExecutionApproved(false),
    isExecutionApproved: () => executionApproved,
    repairRequested: () => requests.repairRequested(),
    verifyTask: verifyCurrentTask,
  };

  registerProviders(pi, config);
  registerMaintainerTools(pi, sharedContext);
  registerMaintainerCommands(pi, sharedContext);
  registerSessionPolicyHooks(pi, store, task);

  // Pi 主事件流：会话建立 -> 请求输入 -> 工具批次 -> Agent 收敛 -> 会话关闭。
  pi.on("session_start", async (event, context) => {
    await requests.onSessionStart(event, context);
  });
  pi.on("before_agent_start", (event, context) => {
    return requests.onBeforeAgentStart(event, context);
  });
  pi.on("input", async (event) => {
    return await requests.onInput(event);
  });
  pi.on("tool_call", async (event, context) => {
    return await nativeWrite.onToolCall(event, context);
  });
  pi.on("tool_result", async (event, context) => {
    await requests.onToolResult(event);
    return await nativeWrite.onToolResult(event, context);
  });
  pi.on("turn_end", async (_event, context) => {
    await nativeWrite.onTurnEnd(context);
  });
  pi.on("agent_end", async (event) => {
    await requests.onAgentEnd(event);
  });
  pi.on("agent_settled", async (event) => {
    await requests.onAgentSettled(event);
  });
  pi.on("session_shutdown", async (event) => {
    await requests.onSessionShutdown(event);
  });
}

/** 公开会话绑定断言，供安全测试和需要审计 Pi 上下文的调用方使用。 */
export { assertTaskSessionBinding };

/** Pi `-e` 参数加载的默认 Extension Factory。 */
export default async function dungeonMaintainerExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const config = loadConfig();
  requireApiKey(config);
  const taskId = process.env.DUNGEON_MAINTAINER_TASK_ID?.trim();
  if (!taskId) throw new Error("缺少 DUNGEON_MAINTAINER_TASK_ID");
  const dataDir = process.env.DUNGEON_MAINTAINER_DATA_DIR?.trim()
    || config.dataDir;
  const store = new TaskStore(dataDir);
  const task = await store.read(taskId);
  installDungeonMaintainerExtension(pi, { config, store, task });
}
