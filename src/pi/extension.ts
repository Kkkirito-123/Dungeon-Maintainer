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
import type { ProgressLine } from "../progress/reporter.js";
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
  /** 返回已经启动的驱动；尚未启动时不产生副作用。 */
  currentDriver(): GameDriver | null;
  /** 返回已经启动的驱动；缺失时抛错，避免工具悄悄创建第二套运行时。 */
  requireDriver(): GameDriver;
  /** 按需启动并返回当前任务唯一的游戏驱动。 */
  ensure(): Promise<GameDriver>;
  /** 关闭当前任务持有的 Vite、Chromium Context 和驱动。 */
  close(): Promise<void>;
}

/** Extension 安装所需的已验证任务事实。 */
export interface DungeonExtensionOptions {
  /** Provider、模型和本地数据目录配置。 */
  config: MaintainerConfig;
  /** 当前任务状态的唯一持久化入口。 */
  store: TaskStore;
  /** 已由父进程绑定到 taskId、session 和 detached worktree 的任务记录。 */
  task: TaskRecord;
  /** 测试可注入不启动外部进程的同契约运行时；生产环境始终使用真实运行时。 */
  gameRuntime?: DungeonGameRuntimePort;
  /** 测试可注入确定性验证器；生产环境始终调用 repair/verification。 */
  verifyTask?: (signal?: AbortSignal, onProgress?: ProgressLine) => Promise<VerificationResult>;
  /** 测试或 Eval 可注入与同一数据目录绑定的证据存储；生产环境按 task 创建。 */
  evidenceStore?: EvidenceStore;
}

/**
 * 注册 `.env` 指定的唯一 OpenAI-compatible 模型。
 *
 * @param pi 当前 Extension API。
 * @param config 已完成 URL、模型和 Token 上限校验的维护器配置。
 * @remarks API Key 以环境变量引用注册，不把密钥正文放入模型定义或会话记录。
 */
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
 * 调用关系为：Pi 触发 hook -> 请求生命周期处理目标与收权 -> 写入协调器校验 edit ->
 * 九个固定工具访问同一份 task/store/gameRuntime。Extension 只连接这些能力，不在 hook
 * 中实现第二套模型调度。
 *
 * @param pi 当前唯一 Pi 进程提供的 Extension API。
 * @param options 已验证任务及其唯一运行依赖；测试替身也必须遵守相同边界。
 * @returns 注册完成后无返回值；长期资源由 session_start 按需启动。
 * @throws Provider、工具或 hook 同步注册失败时抛错。
 * @remarks 注册阶段不启动外部进程；游戏由 request lifecycle 在 session_start 时惰性
 * 启动。后续 session_start 若发现任务绑定漂移，会由对应 hook 抛错并阻止会话继续。
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
  const verifyCurrentTask = options.verifyTask ?? (async (
    signal?: AbortSignal,
    onProgress?: ProgressLine,
  ) => {
    return await runTaskVerification(
      store,
      evidence,
      task,
      gameRuntime.currentDriver(),
      signal,
      onProgress,
    );
  });

  // 这是当前 Extension 进程内的快速门禁，不是授权权威。精确 allowedPaths 仍由
  // TaskStore.writeScope 持久化，且 session_start、自然语言新请求和 agent_settled 都会收权。
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
  // 所有工具共享同一组闭包，避免任一工具自行创建 TaskStore 或 GameDriver 后形成状态分叉。
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

/**
 * Pi `-e` 参数加载的默认 Extension Factory。
 *
 * @param pi Pi CLI 为当前进程创建的 Extension API。
 * @returns 读取并验证任务后完成同步注册；游戏仍等待 session_start 才启动。
 * @throws 缺少 API Key、taskId，或任务记录不存在/损坏时阻止 Pi 会话启动。
 */
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
