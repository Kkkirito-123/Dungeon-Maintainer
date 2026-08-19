/**
 * Dungeon Maintainer 的唯一 Pi Extension 装配入口。
 *
 * 本文件只负责把已验证的任务、Provider、固定工具/命令、系统提示和生命周期钩子装配
 * 到 Pi。会话安全策略由 `session-policy.ts` 负责，Vite/Chromium 生命周期由
 * `game-runtime.ts` 负责，补丁、检查、复现和 apply 仍属于各自 workspace/repair 模块。
 *
 * 一个 Extension 实例始终绑定一个 taskId、一个 detached worktree、一个 Pi session 和
 * 一个游戏运行时。关闭时只停止浏览器与 Vite；未完成任务、日志和 worktree 继续保留供
 * `resume` 使用。API Key 只通过 Provider 的环境变量引用传递，不写入任务或事件文件。
 */

import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, requireApiKey, type MaintainerConfig } from "../config.js";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import { TaskStore } from "../task/store.js";
import {
  INITIAL_TASK_OBJECTIVE,
  type TaskRecord,
} from "../task/types.js";
import { registerMaintainerCommands } from "./commands/index.js";
import { DungeonGameRuntime } from "./game-runtime.js";
import { buildDungeonMaintainerPrompt } from "./prompt.js";
import {
  assertTaskSessionBinding,
  registerSessionPolicyHooks,
} from "./session-policy.js";
import { registerMaintainerTools } from "./tools/index.js";

const PROVIDER_ID = "dungeon-maintainer";
const ACTIVE_TOOLS = [
  "inspect",
  "patch",
  "check",
  "finish",
  "look",
  "go",
  "use",
  "query",
] as const;

/** Extension 安装所需的已验证任务事实。 */
export interface DungeonExtensionOptions {
  config: MaintainerConfig;
  store: TaskStore;
  task: TaskRecord;
}

/**
 * 注册唯一维护 Provider。
 *
 * @param pi 当前 Pi Extension API。
 * @param config 固定 endpoint、模型和上下文预算。
 * @returns 无返回值；Provider 只保存环境变量引用，不保存密钥正文。
 */
function registerProvider(
  pi: ExtensionAPI,
  config: MaintainerConfig,
): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Dungeon Maintainer",
    baseUrl: config.baseUrl,
    apiKey: "$MAINTAINER_API_KEY",
    api: "openai-completions",
    models: [{
      id: config.model,
      name: config.model + "（Dungeon Maintainer）",
      reasoning: false,
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
 * @param pi 当前 Pi Extension API。
 * @param options 已由父进程创建并通过 schema 校验的任务、存储和模型配置。
 * @returns 无返回值；注册阶段不启动外部进程，游戏在 session_start 时惰性启动。
 * @throws session_start 时发现任务绑定或模型不一致会阻止会话继续。
 */
export function installDungeonMaintainerExtension(
  pi: ExtensionAPI,
  options: DungeonExtensionOptions,
): void {
  const { config, store, task } = options;
  const gameRuntime = new DungeonGameRuntime(task, store);

  registerProvider(pi, config);
  const sharedContext = {
    task,
    store,
    currentDriver: () => gameRuntime.currentDriver(),
    requireDriver: () => gameRuntime.requireDriver(),
    ensureGame: () => gameRuntime.ensure(),
    closeGame: () => gameRuntime.close(),
  };
  registerMaintainerTools(pi, sharedContext);
  registerMaintainerCommands(pi, sharedContext);
  registerSessionPolicyHooks(pi, store, task, config);

  pi.on("session_start", async (_event, context) => {
    await assertTaskSessionBinding(context, task);
    if (task.state === "applied" || task.state === "discarded") {
      throw new Error("终态任务不能重新启动 Pi 会话");
    }
    if (task.state === "awaiting_approval") {
      // 进程中断时的确认框不能跨进程复用；恢复后清除摘要并回到 active，
      // 下一次 patch 会基于新正文重新申请一次性审批。
      task.approval = null;
      await store.transition(task, "active");
    } else if (task.state === "created" || task.state === "blocked") {
      await store.transition(task, "active");
    }
    pi.setActiveTools([...ACTIVE_TOOLS]);
    pi.setSessionName("SQL Dungeon · " + task.id.slice(0, 8));
    const expectedModel = context.modelRegistry.find(PROVIDER_ID, config.model);
    if (!expectedModel || !await pi.setModel(expectedModel)) {
      throw new Error("Dungeon Maintainer 模型未注册或 API Key 不可用");
    }
    await gameRuntime.ensure();
    await appendEvent(store, task.id, "pi.session_start", {
      state: task.state,
    });
    context.ui.notify(
      "任务 " + task.id + " 已绑定；右侧游戏运行于 detached worktree",
      "info",
    );
  });

  pi.on("before_agent_start", () => {
    // 每个模型回合都重新固定工具列表，防止 UI 设置或快捷键把内置能力重新激活。
    pi.setActiveTools([...ACTIVE_TOOLS]);
    return { systemPrompt: buildDungeonMaintainerPrompt(task) };
  });

  pi.on("input", async (event) => {
    const text = event.text.trim();
    if (
      event.source === "interactive"
      && task.objective === INITIAL_TASK_OBJECTIVE
      && text
      && !text.startsWith("/")
    ) {
      task.objective = redactText(text).replace(/\s+/gu, " ").slice(0, 2_000);
      await store.save(task);
      await appendEvent(store, task.id, "task.objective_set", {
        length: task.objective.length,
      });
    }
    return { action: "continue" };
  });

  pi.on("session_shutdown", async (event) => {
    await gameRuntime.close();
    await appendEvent(store, task.id, "pi.session_shutdown", {
      reason: event.reason,
      state: task.state,
    });
  });
}

/**
 * 公开会话绑定断言，供安全测试和需要审计 Pi 上下文的调用方使用。
 *
 * @param context Pi Extension 上下文。
 * @param task 当前任务。
 * @returns 绑定成功时无返回值。
 */
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
