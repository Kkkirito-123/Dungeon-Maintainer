/**
 * Benchmark 六工位实时进度服务器。
 *
 * 一个 CLI 进程只打开一个本地页面和一个 SSE 通道。页面展示六个隔离 worker 的案例、
 * 阶段、工具名与模型可见回复；回复只驻留内存，不进入 Benchmark 归档。工具参数、工具
 * 结果、Prompt、内部思考、凭据与临时绝对路径均不经过本服务。
 */

import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";

export interface BenchmarkProgressEvent {
  readonly phase: "starting" | "preflight" | "run" | "complete";
  readonly fixtureId: string | null;
  readonly profile: string | null;
  readonly repetition: number | null;
  readonly completed: number;
  readonly total: number;
  readonly status: "running" | "passed" | "failed";
  readonly cumulativeTokens: number;
  readonly cumulativeToolCalls: number;
  readonly startedAt: string;
  /** 正式运行使用 1..workerCount；预检和总状态为 null。 */
  readonly workerId: number | null;
  readonly workerCount: number;
  readonly liveKind?: "start" | "tool" | "assistant" | "finish";
  readonly toolName?: string | null;
  readonly assistantText?: string;
}

export interface BenchmarkProgressPage {
  readonly url: string;
  publish(event: BenchmarkProgressEvent): void;
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dungeon Benchmark</title><style>
:root{color-scheme:dark;--bg:#07100d;--panel:#101b18;--line:#28433a;--text:#e8f5ef;--muted:#91aa9f;--accent:#62e6a7;--bad:#ff7b72;--busy:#f6c177}*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at 12% 0,#173b30 0,transparent 35%),var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
main{width:min(1480px,calc(100% - 32px));margin:32px auto}.eyebrow{color:var(--accent);letter-spacing:.16em;text-transform:uppercase}h1{font-size:clamp(28px,4vw,48px);margin:6px 0 22px;line-height:1.08}
.summary{display:grid;grid-template-columns:2fr repeat(3,1fr);gap:10px;margin-bottom:14px}.box,.worker{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:14px}.box{padding:14px 16px}.label{color:var(--muted);font-size:12px}.value{font-size:20px;margin-top:4px;overflow-wrap:anywhere}.bar{height:7px;background:#050b09;border-radius:999px;overflow:hidden;margin-top:10px}.fill{height:100%;width:0;background:linear-gradient(90deg,#2fa876,var(--accent));transition:width .25s}
.workers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.worker{min-height:290px;padding:15px;display:flex;flex-direction:column;min-width:0}.worker-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.worker-id{color:var(--accent);letter-spacing:.08em}.badge{border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:11px}.badge.running{color:var(--busy)}.badge.failed{color:var(--bad)}.case{font-size:15px;margin:11px 0 4px;min-height:44px;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:12px}.tool{margin:12px 0 8px;color:var(--accent)}.reply-label{color:var(--muted);font-size:11px;margin-bottom:5px}.reply{flex:1;margin:0;background:#070e0c;border-radius:9px;padding:10px;white-space:pre-wrap;overflow:auto;max-height:145px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:#d7e8e0}.failed-text{color:var(--bad)}
@media(max-width:980px){.workers{grid-template-columns:repeat(2,minmax(0,1fr))}.summary{grid-template-columns:1fr 1fr}}@media(max-width:620px){main{margin:18px auto}.workers,.summary{grid-template-columns:1fr}.worker{min-height:250px}}
</style></head><body><main><div class="eyebrow">Live benchmark · 6 workers</div><h1>SQL Dungeon 修复评测</h1>
<section class="summary" aria-live="polite"><div class="box"><div class="label">总体阶段</div><div class="value" id="overall">等待启动</div><div class="bar" role="progressbar" aria-label="总体进度"><div class="fill" id="fill"></div></div></div><div class="box"><div class="label">完成</div><div class="value" id="count">0 / 0</div></div><div class="box"><div class="label">累计 Tokens</div><div class="value" id="tokens">0</div></div><div class="box"><div class="label">工具调用</div><div class="value" id="tools">0</div></div></section>
<section class="workers" id="workers" aria-label="六个并发测试工位"></section></main><script>
const workerCount=6,states=new Map();const fmt=n=>new Intl.NumberFormat('zh-CN').format(n);const root=document.querySelector('#workers');for(let i=1;i<=workerCount;i++){const article=document.createElement('article');article.className='worker';article.dataset.worker=String(i);article.innerHTML='<div class="worker-head"><span class="worker-id">WORKER '+i+'</span><span class="badge" data-status>idle</span></div><div class="case" data-case>等待任务</div><div class="meta" data-meta>—</div><div class="tool" data-tool>工具：—</div><div class="reply-label">LLM 可见回复（仅内存）</div><pre class="reply" data-reply>尚无回复</pre>';root.append(article)}
function renderOverall(e){document.querySelector('#overall').textContent=[e.phase,e.status].join(' · ');document.querySelector('#overall').className='value '+(e.status==='failed'?'failed-text':'');document.querySelector('#count').textContent=e.completed+' / '+e.total;document.querySelector('#tokens').textContent=fmt(e.cumulativeTokens);document.querySelector('#tools').textContent=fmt(e.cumulativeToolCalls);document.querySelector('#fill').style.width=(e.total?Math.min(100,e.completed/e.total*100):0)+'%'}
function renderWorker(e){const prior=states.get(e.workerId)||{},state={...prior,...e};states.set(e.workerId,state);const card=document.querySelector('[data-worker="'+e.workerId+'"]');if(!card)return;const badge=card.querySelector('[data-status]');badge.textContent=state.status;badge.className='badge '+state.status;card.querySelector('[data-case]').textContent=state.fixtureId||'等待任务';card.querySelector('[data-meta]').textContent=[state.profile,state.repetition?'#'+state.repetition:null,'0s'].filter(Boolean).join(' · ');if(Object.prototype.hasOwnProperty.call(e,'toolName'))card.querySelector('[data-tool]').textContent='工具：'+(state.toolName||'—');if(Object.prototype.hasOwnProperty.call(e,'assistantText')){const reply=card.querySelector('[data-reply]');reply.textContent=state.assistantText||'尚无回复';reply.scrollTop=reply.scrollHeight}}
new EventSource('/events').onmessage=e=>{const value=JSON.parse(e.data);renderOverall(value);if(value.workerId)renderWorker(value)};
setInterval(()=>{for(const [id,state] of states){const card=document.querySelector('[data-worker="'+id+'"]');if(!card)continue;const seconds=Math.max(0,Math.round((Date.now()-Date.parse(state.startedAt))/1000));card.querySelector('[data-meta]').textContent=[state.profile,state.repetition?'#'+state.repetition:null,seconds+'s'].filter(Boolean).join(' · ')}},250);
</script></body></html>`;

function openLocalPage(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, { windowsHide: true }, () => undefined);
}

/** 启动只监听 loopback 的六工位进度服务器，并可选择只打开一次系统浏览器。 */
export async function startBenchmarkProgressPage(openBrowser = true): Promise<BenchmarkProgressPage> {
  const clients = new Set<ServerResponse>();
  let latestOverall: BenchmarkProgressEvent | null = null;
  let closed = false;
  const latestWorkers = new Map<number, BenchmarkProgressEvent>();
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
    response.end(PAGE);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark 进度页监听失败");
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
      // 再停止监听。反过来会让已经写完汇总的 Benchmark 永久不退出。
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}
