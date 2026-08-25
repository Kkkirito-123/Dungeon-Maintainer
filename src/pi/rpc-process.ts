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

/** @deprecated 应用层使用中立名称；旧名称只保留类型兼容。 */
export type PiRpcCommand = AgentRpcCommand;

/** RPC 进程事件回调。 */
export type PiRpcEventListener = (event: unknown) => void;

/** Pi RPC 子进程运行句柄。 */
export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private errorLines: Interface | null = null;
  private readonly pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
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

  /** 启动 Pi RPC 子进程并开始读取 stdout。 */
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

  /** 向 Pi 发送 JSONL 命令，并等待对应 response。 */
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

  /** 向 Pi 回复 Extension UI 请求，不等待 response。 */
  respond(response: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("Pi RPC 进程尚未就绪");
    child.stdin.write(JSON.stringify({ type: "extension_ui_response", ...response }) + "\n", "utf8");
  }

  /** 等待 Pi 进程结束。 */
  async waitForExit(): Promise<number> {
    if (!this.exitPromise) throw new Error("Pi RPC 进程尚未启动");
    return await this.exitPromise;
  }

  /** 先关闭 stdin 触发 Pi 的 session_shutdown；超时后才强制终止子进程。 */
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
