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

import { spawn } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireApiKey, type MaintainerConfig } from "../config.js";
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
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MAINTAINER_API_KEY: apiKey,
    MAINTAINER_BASE_URL: config.baseUrl,
    MAINTAINER_MODEL: config.model,
    MAINTAINER_CONTEXT_WINDOW: String(config.contextWindow),
    MAINTAINER_MAX_TOKENS: String(config.maxOutputTokens),
    DUNGEON_MAINTAINER_TASK_ID: task.id,
    DUNGEON_MAINTAINER_DATA_DIR: config.dataDir,
  };
  const child = spawn(
    process.execPath,
    [resolvePiCliPath(), ...buildPiArguments(task, config)],
    {
      cwd: task.worktreeRoot,
      env: environment,
      stdio: "inherit",
      shell: false,
      windowsHide: false,
    },
  );
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
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
