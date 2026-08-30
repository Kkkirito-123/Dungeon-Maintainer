/**
 * Eval 实时进度服务器。
 *
 * 一个 CLI 进程只打开一个本地页面和一个 SSE 通道。页面展示当前并行任务的
 * 阶段、工具名与模型可见回复；回复只驻留内存，不进入 Eval 归档。工具参数、工具
 * 结果、Prompt、内部思考、凭据与临时绝对路径均不经过本服务。
 */

import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import type { EvalProgressEvent } from "../execution/progress.js";
import { EVAL_PROGRESS_PAGE } from "./page.js";

export type { EvalProgressEvent } from "../execution/progress.js";

export interface EvalProgressPage {
  readonly url: string;
  publish(event: EvalProgressEvent): void;
  close(): Promise<void>;
}

function openLocalPage(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, { windowsHide: true }, () => undefined);
}

/** 启动只监听 loopback 的进度服务器，并可选择只打开一次系统浏览器。 */
export async function startEvalProgressPage(openBrowser = true): Promise<EvalProgressPage> {
  const clients = new Set<ServerResponse>();
  let latestOverall: EvalProgressEvent | null = null;
  let closed = false;
  const latestWorkers = new Map<number, EvalProgressEvent>();
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.flushHeaders();
      response.write(": connected\n\n");
      clients.add(response);
      if (latestOverall) response.write("data: " + JSON.stringify(latestOverall) + "\n\n");
      for (const event of latestWorkers.values()) response.write("data: " + JSON.stringify(event) + "\n\n");
      request.on("close", () => clients.delete(response));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(EVAL_PROGRESS_PAGE);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Eval 进度页监听失败");
  const url = `http://127.0.0.1:${String(address.port)}/`;
  if (openBrowser) openLocalPage(url);
  return {
    url,
    publish(event) {
      latestOverall = event;
      if (event.workerId !== null) {
        const previous = latestWorkers.get(event.workerId);
        latestWorkers.set(event.workerId, { ...previous, ...event });
      }
      const data = "data: " + JSON.stringify(event) + "\n\n";
      for (const client of clients) client.write(data);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // SSE keep-alive 连接会阻止 server.close() 的回调触发，因此先结束客户端，
      // 再停止监听。反过来会让已经写完汇总的 Eval 永久不退出。
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}
