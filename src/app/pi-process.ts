/**
 * Pi CLI 进程与持久化会话边界。
 *
 * 本模块负责解析项目内固定版本 Pi CLI、构造不含密钥的参数、以任务 worktree 为 cwd
 * 启动子进程，并验证 resume 时唯一的 Pi session 文件。它不创建任务、不校验正式仓库、
 * 不启动游戏浏览器，也不决定任务状态；start/resume 只调用这里的明确接口。
 *
 * API Key 只在子进程环境变量中传递，永远不会进入参数、task.json 或日志。Pi 会话首行
 * 的 id/cwd 和文件名必须与任务一致；发现漂移时安全阻断，保留原任务供用户诊断。
 */

import { open, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireApiKey, type MaintainerConfig } from "../config.js";
import { PiRpcProcess, type PiRpcCommand } from "../pi/rpc-process.js";
import { startShellServer } from "../shell/server.js";
import { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { comparablePath } from "./path.js";
import { pathExists } from "../workspace/git.js";

const PROVIDER_ID = "dungeon-maintainer";

function extensionPath(): string {
  return fileURLToPath(new URL("../pi/extension.js", import.meta.url));
}

/**
 * 解析项目内固定版本 Pi CLI 的真实入口。
 *
 * @returns `@earendil-works/pi-coding-agent` 当前安装副本的 `dist/cli.js`。
 * @throws 依赖未安装、包导出损坏或入口文件不存在时由 Node 模块解析抛错。
 * @remarks 使用 ESM `import.meta.resolve`，避免 CommonJS `require.resolve` 违反该包的
 * 导出配置；从已解析入口定位 cli.js 也避免误用 PATH 中的全局 Pi。
 */
export function resolvePiCliPath(): string {
  const packageEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  return resolve(dirname(packageEntry), "cli.js");
}

/**
 * 构造唯一允许的 Pi CLI 参数。
 *
 * @param task 当前 schema v2 任务。
 * @param config 固定 Provider 和模型配置。
 * @param loadedExtensionPath 编译后的维护器 Extension 路径；测试可显式注入。
 * @returns 不含 API Key 的参数数组。
 */
export function buildPiArguments(
  task: TaskRecord,
  config: MaintainerConfig,
  loadedExtensionPath = extensionPath(),
): string[] {
  return [
    "--mode",
    "rpc",
    // 维护器只加载自己显式传入的 Extension，且 cwd 固定为隔离 worktree；自动批准
    // 这个受控目录可以跳过 Pi 首次启动的交互式信任提示，避免可见终端停在启动阶段。
    "--approve",
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "-e",
    loadedExtensionPath,
    "--provider",
    PROVIDER_ID,
    "--model",
    config.model,
    "--session-id",
    task.id,
    "--session-dir",
    task.piSessionDir,
  ];
}

/**
 * 在当前任务 worktree 中运行 Pi CLI。
 *
 * @param task 当前任务；cwd、session-id 和 session-dir 均由它固定。
 * @param config 维护器配置；API Key 只通过环境变量传递。
 * @returns Pi 子进程退出码。
 * @throws 子进程无法启动时抛出底层错误。
 */
export async function runPiProcess(
  task: TaskRecord,
  config: MaintainerConfig,
): Promise<number> {
  const apiKey = requireApiKey(config);
  const store = new TaskStore(config.dataDir);
  let rpc: PiRpcProcess | null = null;
  let stopping = false;
  const shell = await startShellServer({
    task,
    model: config.model,
    contextWindow: config.contextWindow,
    store,
    sendPiCommand: async (command: PiRpcCommand) => {
      if (!rpc) throw new Error("Pi RPC 尚未启动");
      if (command.type === "extension_ui_response") {
        rpc.respond(command);
        return { ok: true };
      }
      return await rpc.send(command);
    },
    onClose: async () => {
      if (stopping) return;
      stopping = true;
      await rpc?.stop();
    },
  });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MAINTAINER_API_KEY: apiKey,
    MAINTAINER_BASE_URL: config.baseUrl,
    MAINTAINER_MODEL: config.model,
    MAINTAINER_CONTEXT_WINDOW: String(config.contextWindow),
    MAINTAINER_MAX_TOKENS: String(config.maxOutputTokens),
    DUNGEON_MAINTAINER_TASK_ID: task.id,
    DUNGEON_MAINTAINER_DATA_DIR: config.dataDir,
    DUNGEON_MAINTAINER_WORKTREE: task.worktreeRoot,
    DUNGEON_MAINTAINER_SHELL_URL: shell.url,
  };
  rpc = new PiRpcProcess(
    resolvePiCliPath(),
    buildPiArguments(task, config),
    environment,
    (event) => {
      shell.handlePiEvent(event);
      if (event && typeof event === "object" && !Array.isArray(event)) {
        const record = event as Record<string, unknown>;
        if (record.type === "message_update" && record.usage) {
          shell.updateSessionStats({ tokens: record.usage });
        }
        if (record.type === "agent_end" || record.type === "agent_settled") {
          void rpc?.send({ id: "stats-" + String(Date.now()), type: "get_session_stats" })
            .then((stats) => shell.updateSessionStats(stats))
            .catch(() => undefined);
        }
        if (record.type === "pi_stderr" || record.type === "pi_protocol_error") {
          shell.publish({
            type: "notice",
            level: "error",
            text: record.type === "pi_protocol_error"
              ? "Pi RPC 输出协议异常"
              : "Pi RPC 进程报告错误输出",
          });
        }
      }
      void store.read(task.id)
        .then((updated) => shell.updateTask(updated))
        .catch(() => undefined);
    },
  );
  try {
    await rpc.start();
    console.log("统一 Chromium Shell：" + shell.url);
    console.log("左侧为 Pi 聊天，右侧为 worktree 游戏；正式仓库仍需显式 /apply");
    const exitCode = await rpc.waitForExit();
    shell.publish({ type: "closed", code: exitCode });
    return exitCode;
  } finally {
    await rpc.stop();
    await shell.close();
    rpc = null;
  }
}

async function readPiSessionHeader(path: string): Promise<{
  type: string;
  id: string;
  cwd: string;
}> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) throw new Error("Pi 会话文件缺少有限首行");
    const value: unknown = JSON.parse(text.slice(0, newline));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Pi 会话首行不是对象");
    }
    const header = value as Record<string, unknown>;
    if (
      header.type !== "session"
      || typeof header.id !== "string"
      || typeof header.cwd !== "string"
    ) {
      throw new Error("Pi 会话首行缺少任务绑定字段");
    }
    return { type: header.type, id: header.id, cwd: header.cwd };
  } finally {
    await handle.close();
  }
}

/**
 * 验证恢复任务只有一个匹配的 Pi 会话文件。
 *
 * @param task 要恢复的任务。
 * @returns 已验证会话文件绝对路径。
 * @throws 目录丢失、重复 ID、首行损坏或记录 cwd 不一致时拒绝。
 */
export async function verifyPiSession(task: TaskRecord): Promise<string> {
  if (!await pathExists(task.piSessionDir)) {
    throw new Error("Pi 会话目录已丢失，不能静默创建新会话");
  }
  const suffix = "_" + task.id + ".jsonl";
  const matches = (await readdir(task.piSessionDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (matches.length !== 1 || !matches[0]) {
    throw new Error("Pi 会话文件缺失或同一任务 ID 出现重复文件");
  }
  const path = join(task.piSessionDir, matches[0].name);
  const header = await readPiSessionHeader(path);
  if (header.id !== task.id) throw new Error("Pi 会话首行 ID 与任务不一致");
  if (comparablePath(header.cwd) !== comparablePath(task.worktreeRoot)) {
    throw new Error("Pi 会话首行 cwd 与任务 worktree 不一致");
  }
  return path;
}

/**
 * 判断任务目录是否仍处于“从未写入 Pi 会话”的首次启动窗口。
 *
 * @param task 已通过路径绑定校验的任务。
 * @returns 会话目录存在且没有任何匹配当前任务 ID 的会话文件时返回 `true`。
 * @remarks 该结果只允许 resume 对没有任何补丁、检查或复现证据的全新任务使用；
 * 一旦目录中出现过会话文件，调用方必须继续走严格的唯一文件校验。
 */
export async function hasNoPiSessionFile(task: TaskRecord): Promise<boolean> {
  if (!await pathExists(task.piSessionDir)) return false;
  const suffix = "_" + task.id + ".jsonl";
  const matches = (await readdir(task.piSessionDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
  return matches.length === 0;
}
