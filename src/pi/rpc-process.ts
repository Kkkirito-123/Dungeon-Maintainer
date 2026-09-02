/**
 * Pi RPC/JSONL 子进程适配器。
 *
 * 本模块把固定版本 Pi CLI 的 stdin/stdout 协议转换成维护器可管理的 Promise 和事件。
 * 它只负责进程、JSONL 分帧、请求关联和 Extension UI 响应，不决定补丁权限、不解析
 * 模型正文，也不执行用户提供的命令。API Key 只通过环境变量传给子进程。
 *
 * 进程退出时所有未完成请求都会失败，调用方必须保留任务目录而不能静默创建新会话。
 * stdout 只允许 JSONL；stderr 只转换为低敏错误事件，避免把模型或凭据写入 Shell。
 */

import { createInterface, type Interface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentRpcCommand } from "../agent/rpc.js";

/**
 * 接收 Pi 主动事件的回调。
 *
 * @param event 已完成 JSON 解析、但仍保持 Pi 原始字段的事件对象。
 * @remarks 带请求 id 的 `response` 不会进入该回调，而是用于完成对应的 `send()`。
 */
export type PiRpcEventListener = (event: unknown) => void;

/**
 * Pi RPC 子进程运行句柄。
 *
 * 一个实例只允许启动一次，并通过换行分隔的 JSON 对象与一个 Pi CLI 通信。该类不是
 * Agent Loop：它只负责传输，模型与工具之间的连续调用仍由 Pi 子进程内部驱动。
 */
export class PiRpcProcess {
  /** 当前 Pi 子进程；非空表示实例已经进入启动或运行阶段。 */
  private child: ChildProcessWithoutNullStreams | null = null;
  /** stdout 与 stderr 的逐行读取器，分别承载协议消息和低敏运行提示。 */
  private lines: Interface | null = null;
  private errorLines: Interface | null = null;
  /**
   * 尚未收到 response 的命令。key 是发给 Pi 的请求 id，确保并发状态查询不会串线。
   */
  private readonly pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  /** 唯一的进程退出结果，供主动 stop 和自然退出观察者共同等待。 */
  private exitPromise: Promise<number> | null = null;

  /**
   * @param executable Pi CLI 的 Node 入口。
   * @param args 已通过维护器白名单构造的启动参数。
   * @param environment 子进程环境，不能包含浏览器可见密钥。
   * @param onEvent 收到非 response JSONL 时的事件回调。
   */
  constructor(
    private readonly executable: string,
    private readonly args: readonly string[],
    private readonly environment: NodeJS.ProcessEnv,
    private readonly onEvent: PiRpcEventListener,
  ) {}

  /**
   * 启动 Pi RPC 子进程并开始读取 stdout/stderr。
   *
   * @returns 子进程完成 spawn 后返回；此时不代表 Pi 已结束初始化。
   * @throws 实例重复启动、Node 无法创建子进程或入口文件不可执行时抛错。
   * @remarks cwd 只能取已验证任务 worktree；`shell: false` 保证参数不会经过命令行解释器。
   */
  async start(): Promise<void> {
    if (this.child) throw new Error("Pi RPC 进程已经启动");
    const child = spawn(process.execPath, [this.executable, ...this.args], {
      env: this.environment,
      cwd: this.environment.DUNGEON_MAINTAINER_WORKTREE,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.errorLines = createInterface({ input: child.stderr });
    this.errorLines.on("line", (line) => this.handleErrorLine(line));
    this.exitPromise = new Promise<number>((resolve) => {
      child.once("close", (code) => {
        // 进程关闭后不可能再收到 response。立即拒绝所有等待方，避免 Shell 请求永久悬挂。
        const error = new Error("Pi RPC 进程已退出");
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        resolve(code ?? 1);
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  }

  /**
   * 向 Pi 发送一条 JSONL 命令，并等待对应 response。
   *
   * @param command 由 Shell 白名单操作构造的 Pi RPC 命令。
   * @returns Pi response 的 data 字段。
   * @throws 进程未就绪、stdin 写入失败或 Pi 返回失败响应时抛错。
   * @remarks 请求 id 只用于传输关联，不代表新建模型回合；prompt 是否开启回合由 Pi 决定。
   */
  async send(command: AgentRpcCommand): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("Pi RPC 进程尚未就绪");
    const id = typeof command.id === "string" ? command.id : randomUUID();
    const payload = JSON.stringify({ ...command, id }) + "\n";
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(payload, "utf8", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /**
   * 向 Pi 回复 Extension UI 请求，不等待第二个 response。
   *
   * @param response Shell 对 Extension 确认框的原始响应，必须带 Pi 分配的请求 id。
   * @throws 进程尚未就绪时抛错。
   * @remarks 这是 Pi 发起请求后的反向应答；若再登记 pending，会形成双方互相等待。
   */
  respond(response: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("Pi RPC 进程尚未就绪");
    child.stdin.write(JSON.stringify({ type: "extension_ui_response", ...response }) + "\n", "utf8");
  }

  /**
   * 等待 Pi 进程结束。
   *
   * @returns 进程退出码；底层未提供退出码时按失败码 1 返回。
   * @throws `start()` 尚未调用时抛错。
   */
  async waitForExit(): Promise<number> {
    if (!this.exitPromise) throw new Error("Pi RPC 进程尚未启动");
    return await this.exitPromise;
  }

  /**
   * 停止 Pi，并释放逐行读取器。
   *
   * @returns 进程退出且本实例资源释放后返回；重复调用不产生副作用。
   * @remarks 先关闭 stdin，让 Pi 有十秒处理 session_shutdown 和持久化会话；只有超时才
   * 强制终止。任务切换依赖这个顺序，确保旧 Pi 不会在新任务启动后继续消耗模型请求。
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null && child.stdin.writable) {
      child.stdin.end();
      const graceful = await Promise.race([
        this.waitForExit().then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 10_000);
          timer.unref();
        }),
      ]);
      if (!graceful) child.kill();
    }
    await this.waitForExit().catch(() => undefined);
    this.lines?.close();
    this.errorLines?.close();
    this.lines = null;
    this.errorLines = null;
    this.child = null;
  }

  private handleErrorLine(line: string): void {
    const normalized = line.trim();
    if (!normalized) return;
    if (
      normalized.startsWith("Warning: No project session found with id '")
      && normalized.endsWith("creating a new session with that id.")
    ) {
      // Pi 在首次使用维护器固定的 taskId 时必然发出这条提示；这是创建预期会话，
      // 不是运行错误，也不应该在聊天区消耗用户注意力。
      this.onEvent({ type: "pi_first_session" });
      return;
    }
    this.onEvent({ type: normalized.startsWith("Warning:") ? "pi_warning" : "pi_stderr" });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.onEvent({ type: "pi_protocol_error" });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.onEvent({ type: "pi_protocol_error" });
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "response" && typeof record.id === "string") {
      // response 完成一个由 Shell 发起的命令；其余消息都是 Pi 主动事件，交给上层广播。
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      if (record.success === true) pending.resolve(record.data);
      else pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi RPC 请求失败"));
      return;
    }
    this.onEvent(value);
  }
}
