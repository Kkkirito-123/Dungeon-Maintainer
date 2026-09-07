/**
 * Dungeon Maintainer 本地 Shell 服务入口。
 *
 * server 只负责监听端口和释放连接；会话状态、Pi 事件和 HTTP 路由各自在独立模块。
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { EvidenceStore } from "../evidence/store.js";
import type { EvidenceSnapshot } from "../evidence/view.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { writeJson } from "./codec.js";
import type {
  ShellCoreCommand,
  ShellCoreEvent,
  ShellEvent,
  ShellStatusConfig,
  ShellTaskSwitchRequest,
} from "./protocol.js";
import { createShellRouter } from "./routes.js";
import { createShellSession } from "./session.js";

type RpcSender = (command: ShellCoreCommand) => Promise<unknown>;

/** Shell 启动后返回的本机访问地址。 */
export interface ShellHandle {
  url: string;
  token: string;
  close(): Promise<void>;
  publish(event: ShellEvent): void;
  settleCommand(): void;
  updateTask(task: TaskRecord): void;
  updateTurnUsage(usage: unknown): void;
  updateSessionStats(stats: unknown): void;
  syncPiState(): Promise<void>;
  updateRuntime(update: {
    state: "starting" | "ready" | "error" | "stopped";
    gameUrl?: string | null;
  }): void;
  syncEvidence(): Promise<void>;
  handlePiEvent(event: ShellCoreEvent): void;
}

/** Shell 需要的外部行为，由 Pi 进程编排层提供。 */
export interface ShellServerOptions extends ShellStatusConfig {
  store: TaskStore;
  evidence?: EvidenceStore;
  readEvidenceSnapshot?: () => Promise<EvidenceSnapshot>;
  sendPiCommand: RpcSender;
  onSwitchTask?: (request: ShellTaskSwitchRequest) => Promise<TaskRecord>;
  onClose: () => Promise<void>;
}

/** 创建只监听本机的左右分栏 Shell。 */
export async function startShellServer(options: ShellServerOptions): Promise<ShellHandle> {
  const token = randomUUID();
  const session = createShellSession(options, token);
  const handleRequest = createShellRouter(options, session);
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeJson(response, {
        error: error instanceof Error ? error.message : "Shell 请求失败",
      }, 500);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配 Shell 本机端口");

  session.start();
  const baseUrl = "http://127.0.0.1:" + String(address.port);
  return {
    url: baseUrl + "/?taskId=" + encodeURIComponent(options.task.id)
      + "&token=" + encodeURIComponent(token),
    token,
    close: async () => {
      session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    publish: (event) => session.publish(event),
    settleCommand: () => session.settleCommand(),
    updateTask: (task) => session.updateTask(task),
    updateTurnUsage: (usage) => session.updateTurnUsage(usage),
    updateSessionStats: (stats) => session.updateSessionStats(stats),
    syncPiState: async () => await session.syncPiState(),
    updateRuntime: (update) => session.updateRuntime(update),
    syncEvidence: async () => await session.syncEvidence(),
    handlePiEvent: (event) => session.handlePiEvent(event),
  };
}
