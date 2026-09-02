/**
 * Pi CLI 进程与持久化会话边界。
 *
 * 本模块负责解析项目内固定版本 Pi CLI、构造不含密钥的参数、以任务 worktree 为 cwd
 * 启动子进程，并验证 resume 时唯一的 Pi session 文件。它不创建任务、不校验正式仓库、
 * 不启动游戏浏览器，也不决定任务状态；start/resume 只调用这里的明确接口。
 *
 * API Key 只在子进程环境变量中传递，永远不会进入参数、task.json 或日志。Pi 会话首行
 * 的 id/cwd 和文件名必须与任务一致；发现漂移时安全阻断，保留原任务供用户诊断。
 *
 * 运行时数据流：Shell 命令 -> AppController.send -> PiRpcProcess -> Pi Agent Loop；
 * Pi 事件 -> AppController.handlePiEvent -> Shell。任务切换始终先停止旧 Pi，再更新活动
 * Task，最后启动新 Pi，因此同一时刻不会存在两个可调用模型的进程。
 */

import { access, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireApiKey, type MaintainerConfig } from "../config.js";
import type { AgentRpcCommand } from "../agent/rpc.js";
import { PiRpcProcess } from "../pi/rpc-process.js";
import { FULL_CODING_TOOLS } from "../pi/tool-policy.js";
import { startShellServer, type ShellHandle } from "../shell/server.js";
import type { ShellTaskSwitchRequest } from "../shell/protocol.js";
import { TaskStore, createTaskId } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { EvidenceStore, hasTaskEvidence } from "../evidence/store.js";
import { buildEvidenceSnapshot } from "../evidence/view.js";
import { comparablePath } from "./path.js";
import { pathExists } from "../workspace/git.js";
import {
  createTaskWorktreeSnapshot,
  removeTaskWorktree,
  verifyTaskWorktree,
} from "../workspace/worktree.js";
import { resolveRepositoryWorktree } from "../workspace/catalog.js";
import { inspectDungeonRepository, verifyRuntimeDependencies } from "./repository.js";
import { assertTaskLocalPaths, cleanupFinishedWorktree } from "./task-lifecycle.js";

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
 * @param task 当前 schema v4 任务。
 * @param config `.env` 解析出的唯一 Provider 和模型配置。
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
    // 启动层显式固定九个维护器工具，避免用户全局设置改变能力边界；Pi 原生工具和
    // 任意 bash 均不加载。Extension 保持工具名稳定以复用 Prompt 缓存，实际 edit
    // 权限仍由执行层按本轮批准范围判断。
    "--tools",
    FULL_CODING_TOOLS.join(","),
    "--no-extensions",
    "--no-prompt-templates",
    "-e",
    loadedExtensionPath,
    "--provider",
    "dungeon-maintainer",
    "--model",
    config.model,
    // Thinking 以任务记录为唯一事实源。新任务默认 off；用户在 Shell 显式切换后，
    // resume 会恢复该选择，不继承 Pi 的全局或模型级隐式默认值。
    "--thinking",
    task.thinkingLevel,
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
  return await new AppController(task, config).run();
}

/**
 * 在一个固定 Shell 中串行管理唯一 Pi 进程、唯一游戏运行时和活动任务。
 *
 * 切换任务时先停止旧 Pi，再启动新 Pi；旧任务只保留在磁盘，不会在后台继续调用模型。
 * Shell 的授权令牌和浏览器窗口保持不变，活动 taskId、worktree 和右侧游戏由状态事件更新。
 * 构造实例不会启动进程；调用 `run()` 后会创建本地 Shell、启动 Pi，并只通过受限 RPC
 * 命令影响当前任务。启动失败或任务事实漂移时保留任务与 worktree，供后续诊断或恢复。
 */
export class AppController {
  /** 当前数据目录唯一的任务持久化入口。 */
  private readonly store: TaskStore;
  /** Shell 当前展示且唯一允许驱动 Pi 的任务。 */
  private activeTask: TaskRecord;
  /** 当前唯一 Pi 子进程；任务切换期间短暂为 null。 */
  private rpc: PiRpcProcess | null = null;
  /** 整个 AppController 生命周期复用的 Chromium Shell。 */
  private shell: ShellHandle | null = null;
  /** 防止两个切换请求交错执行。 */
  private switching = false;
  /** 保证关闭流程和 completion 只生效一次。 */
  private closed = false;
  /**
   * Pi 实例代次。旧进程的延迟事件必须同时匹配实例引用和代次，才能影响当前 Shell。
   */
  private generation = 0;
  /** 完成整个控制器生命周期的唯一出口，由 close 或当前 Pi 自然退出调用。 */
  private resolveCompletion: (code: number) => void = () => undefined;
  /** `run()` 持续等待的生命周期 Promise，不会因单次 Agent 回合结束而完成。 */
  private readonly completion = new Promise<number>((resolveCompletion) => {
    this.resolveCompletion = resolveCompletion;
  });
  /** 本次 Shell 生命周期访问过的任务，仅用于退出时检查终态 worktree 清理。 */
  private readonly visitedTaskIds = new Set<string>();

  /**
   * @param initialTask start 或 resume 已验证的首个任务。
   * @param config 当前维护器配置。
   */
  constructor(
    initialTask: TaskRecord,
    private readonly config: MaintainerConfig,
  ) {
    this.activeTask = initialTask;
    this.store = new TaskStore(config.dataDir);
    this.visitedTaskIds.add(initialTask.id);
  }

  /**
   * 启动固定 Shell 与首个 Pi，并等待用户关闭或当前 Pi 自然退出。
   *
   * @returns 用户关闭 Shell 或 Pi 自然退出时的进程码。
   * @throws Shell 创建失败时抛错；Pi 启动失败会显示在 Shell 中并保留界面供诊断。
   * @remarks finally 总会停止当前 Pi、关闭 Shell，并只清理已进入终态的 worktree。
   */
  async run(): Promise<number> {
    this.shell = await startShellServer({
      task: this.activeTask,
      model: this.config.model,
      contextWindow: this.config.contextWindow,
      maxOutputTokens: this.config.maxOutputTokens,
      store: this.store,
      readEvidenceSnapshot: async () => (
        await buildEvidenceSnapshot(new EvidenceStore(this.config.dataDir, this.activeTask))
      ),
      sendPiCommand: async (command: AgentRpcCommand) => {
        const result = await this.send(command);
        // 扩展命令在 Pi 内部等待 handler 完成后才返回 response；普通 prompt 仍等待 agent_settled。
        if (
          command.type === "prompt"
          && typeof command.message === "string"
          && command.message.trim().startsWith("/")
        ) {
          this.shell?.settleCommand();
          const updated = await this.store.read(this.activeTask.id);
          if (updated.state === "discarded") void this.close(0);
        }
        return result;
      },
      onSwitchTask: async (request) => await this.switchTask(request),
      onClose: async () => await this.close(0),
    });
    try {
      console.log("统一 Chromium Shell：" + this.shell.url);
      try {
        await this.startActivePi();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pi 启动失败";
        this.shell.publish({ type: "notice", level: "error", text: message });
        console.warn(message);
      }
      console.log("左侧为 Pi 聊天，右侧为 worktree 游戏；正式仓库仍需显式 /apply");
      return await this.completion;
    } finally {
      await this.stopActivePi();
      await this.shell.close();
      for (const taskId of this.visitedTaskIds) {
        await cleanupFinishedWorktree(this.store, taskId).catch(() => undefined);
      }
      this.shell = null;
    }
  }

  private environment(task: TaskRecord): NodeJS.ProcessEnv {
    if (!this.shell) throw new Error("统一 Shell 尚未启动");
    const apiKey = requireApiKey(this.config);
    // 任务身份和 worktree 只通过父进程注入，Extension 不从 cwd 或全局配置猜测归属。
    // API Key 也只存在于子进程环境，不能进入可见 CLI 参数和 Shell 事件。
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      MAINTAINER_API_KEY: apiKey,
      MAINTAINER_BASE_URL: this.config.baseUrl,
      MAINTAINER_MODEL: this.config.model,
      MAINTAINER_CONTEXT_WINDOW: String(this.config.contextWindow),
      MAINTAINER_MAX_TOKENS: String(this.config.maxOutputTokens),
      MAINTAINER_REASONING: String(this.config.reasoning),
      DUNGEON_MAINTAINER_TASK_ID: task.id,
      DUNGEON_MAINTAINER_DATA_DIR: this.config.dataDir,
      DUNGEON_MAINTAINER_WORKTREE: task.worktreeRoot,
      DUNGEON_MAINTAINER_SHELL_URL: this.shell.url,
      DUNGEON_MAINTAINER_ENTRY: fileURLToPath(new URL("../main.js", import.meta.url)),
    };
    return environment;
  }

  private async send(command: AgentRpcCommand): Promise<unknown> {
    const rpc = this.rpc;
    if (!rpc) throw new Error("Pi RPC 尚未启动");
    if (command.type === "extension_ui_response") {
      // Extension 确认框是 Pi 主动发起、Shell 反向应答的协议，不会再产生 response。
      rpc.respond(command);
      return { ok: true };
    }
    return await rpc.send(command);
  }

  private handlePiEvent(
    rpc: PiRpcProcess,
    generation: number,
    event: unknown,
  ): void {
    // stop 后仍可能到达旧进程缓冲区中的事件；实例和代次双重匹配可阻止它污染新任务。
    if (this.rpc !== rpc || generation !== this.generation || !this.shell) return;
    this.shell.handlePiEvent(event);
    if (event && typeof event === "object" && !Array.isArray(event)) {
      const type = (event as Record<string, unknown>).type;
      if (type === "tool_execution_end" || type === "agent_settled") {
        void this.shell.syncEvidence().catch(() => undefined);
      }
    }
    if (event && typeof event === "object" && !Array.isArray(event)) {
      const record = event as Record<string, unknown>;
      if (record.type === "message_update" && record.usage) {
        this.shell.updateTurnUsage(record.usage);
      }
      if (record.type === "agent_settled" || record.type === "compaction_end") {
        void this.shell.syncPiState().catch(() => undefined);
      }
      if (record.type === "pi_stderr" || record.type === "pi_protocol_error") {
        this.shell.publish({
          type: "notice",
          level: "error",
          text: record.type === "pi_protocol_error"
            ? "Pi RPC 输出协议异常"
            : "Pi RPC 进程报告错误输出",
        });
      }
    }
    const activeTaskId = this.activeTask.id;
    void this.store.read(activeTaskId)
      .then((updated) => {
        if (this.activeTask.id === updated.id) {
          this.activeTask = updated;
          this.shell?.updateTask(updated);
        }
      })
      .catch(() => undefined);
  }

  private async startActivePi(): Promise<void> {
    if (!this.shell) throw new Error("统一 Shell 尚未启动");
    if (this.rpc) throw new Error("已有活动 Pi 进程");
    // 先分配新代次，再把回调闭包绑定到该代次；后续任务切换可以识别迟到事件。
    const generation = ++this.generation;
    const rpc = new PiRpcProcess(
      resolvePiCliPath(),
      buildPiArguments(this.activeTask, this.config, extensionPath()),
      this.environment(this.activeTask),
      (event) => this.handlePiEvent(rpc, generation, event),
    );
    this.rpc = rpc;
    try {
      await rpc.start();
      await this.shell.syncPiState();
      await Promise.resolve();
      if (this.rpc !== rpc) throw new Error("Pi 启动后立即退出");
    } catch (error) {
      if (this.rpc === rpc) this.rpc = null;
      await rpc.stop().catch(() => undefined);
      throw error;
    }
    void rpc.waitForExit().then((code) => {
      // 被任务切换主动停止的旧进程不应关闭整个应用；只有当前代次自然退出才结束 Shell。
      if (
        this.rpc !== rpc
        || generation !== this.generation
      ) return;
      this.rpc = null;
      if (this.switching || this.closed) return;
      this.closed = true;
      this.shell?.publish({ type: "closed", code });
      this.resolveCompletion(code);
    });
  }

  private async stopActivePi(): Promise<void> {
    const rpc = this.rpc;
    // 先从控制器解绑，再等待关闭，确保关闭期间到达的事件不会再更新当前 Shell。
    this.rpc = null;
    if (rpc) await rpc.stop();
  }

  private async validateRecoverableTask(taskId: string): Promise<TaskRecord> {
    const task = await this.store.read(taskId);
    if (task.state === "applied" || task.state === "discarded") {
      throw new Error("终态任务不能恢复");
    }
    assertTaskLocalPaths(task, this.store);
    const state = await inspectDungeonRepository(task.repoRoot);
    if (
      comparablePath(state.root) !== comparablePath(task.repoRoot)
      || state.head !== task.baseHead
    ) {
      throw new Error("正式仓库根目录或 HEAD 已偏离任务 baseHead");
    }
    await verifyRuntimeDependencies(state.root);
    await verifyTaskWorktree(task);
    // 只有从未产生修复事实的任务可以处于“首次会话尚未落盘”窗口；其余任务必须找到
    // 唯一且 cwd 匹配的 Pi session，禁止以新会话冒充恢复。
    const untouched = (task.state === "created" || task.state === "active")
      && task.changedPaths.length === 0
      && task.patchLines === 0
      && !(await hasTaskEvidence(this.config.dataDir, task))
      && task.verification === null
      && task.approval === null
      && task.patchPath === null
      && task.reversePatchPath === null;
    if (!(untouched && await hasNoPiSessionFile(task))) {
      await verifyPiSession(task);
    }
    return task;
  }

  private async createTaskForWorktree(treeId: string): Promise<TaskRecord> {
    const sourceRoot = await resolveRepositoryWorktree(
      this.activeTask,
      this.store,
      treeId,
    );
    if (comparablePath(sourceRoot) === comparablePath(this.activeTask.repoRoot)) {
      throw new Error("目标已经是当前来源工作树");
    }
    const state = await inspectDungeonRepository(sourceRoot);
    await verifyRuntimeDependencies(state.root);
    const taskId = createTaskId();
    const worktreesDir = join(this.config.dataDir, "worktrees");
    // 用户选择的是来源 worktree；Agent 实际进入的仍是新建 detached 快照。
    const snapshot = await createTaskWorktreeSnapshot(
      taskId,
      state.root,
      state.head,
      worktreesDir,
    );
    const piSessionDir = join(this.store.taskDir(taskId), "pi");
    try {
      await mkdir(piSessionDir, { recursive: true });
      return await this.store.create({
        id: taskId,
        objective: "等待用户描述当前工作树中的 SQL Dungeon 问题",
        repoRoot: state.root,
        baseHead: state.head,
        sourceBranch: snapshot.sourceBranch,
        sourceDirtyFiles: snapshot.sourceDirtyFiles,
        sourceSnapshotHash: snapshot.sourceSnapshotHash,
        worktreeRoot: snapshot.root,
        piSessionDir,
      });
    } catch (error) {
      const taskFileExists = await access(join(this.store.taskDir(taskId), "task.json"))
        .then(() => true)
        .catch(() => false);
      if (!taskFileExists) {
        await removeTaskWorktree(
          state.root,
          snapshot.root,
          worktreesDir,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  private async switchTask(request: ShellTaskSwitchRequest): Promise<TaskRecord> {
    if (this.closed) throw new Error("AppController 已关闭");
    if (this.switching) throw new Error("正在切换另一个任务");
    if (request.kind === "task" && request.id === this.activeTask.id) {
      throw new Error("目标已经是当前活动任务");
    }
    const previousTask = this.activeTask;
    const nextTask = request.kind === "task"
      ? await this.validateRecoverableTask(request.id)
      : await this.createTaskForWorktree(request.id);
    // 先完成目标校验/创建，再停止旧 Pi。目标准备失败时，当前聊天不会被无谓中断。
    await this.store.save(previousTask);
    this.switching = true;
    try {
      // 此顺序是单 Agent 保证：旧 Pi 完全退出后才改变活动任务并启动新 Pi。
      await this.stopActivePi();
      await cleanupFinishedWorktree(this.store, previousTask.id).catch(() => undefined);
      this.activeTask = nextTask;
      this.visitedTaskIds.add(nextTask.id);
      this.shell?.updateRuntime({ state: "stopped", gameUrl: null });
      this.shell?.updateTask(nextTask);
      await this.startActivePi();
      return nextTask;
    } catch (error) {
      // 新任务启动失败时恢复上一任务和 Shell 投影；旧 Pi 已退出则尽力重启原会话。
      this.activeTask = previousTask;
      this.shell?.updateTask(previousTask);
      if (!this.rpc) await this.startActivePi().catch(() => undefined);
      throw error;
    } finally {
      this.switching = false;
    }
  }

  private async close(code: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopActivePi();
    this.resolveCompletion(code);
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
