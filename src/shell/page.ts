/**
 * 统一 Shell 的页面资源。
 *
 * 页面以内嵌 HTML、CSS 和 JavaScript 的方式随 TypeScript 编译，避免额外静态资源
 * 复制步骤和发布目录漂移。它只负责界面布局、SSE 展示、拖拽分栏和发送受限请求，
 * 不实现 Git、补丁、模型或游戏协议逻辑。
 *
 * 令牌只作为当前本机任务的短期 URL 参数使用；页面不会读取 API Key，也不会把隐藏
 * 游戏状态写入 localStorage。分栏宽度是唯一允许持久化到浏览器本地的 UI 偏好。
 */

/** 返回统一 Shell 页面。 */
export function renderShellPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Dungeon Maintainer</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: #111827; color: #e5e7eb; }
    #shell { height: 100%; display: grid; grid-template-rows: 42px minmax(0, 1fr) 34px; }
    header { display: flex; align-items: center; gap: 12px; padding: 0 14px; background: #0b1220; border-bottom: 1px solid #263247; }
    header strong { color: #93c5fd; }
    header small { color: #94a3b8; }
    header button { margin-left: auto; background: #1f2937; color: #e5e7eb; border: 1px solid #475569; border-radius: 4px; padding: 5px 10px; cursor: pointer; }
    main { min-height: 0; display: grid; grid-template-columns: minmax(320px, 42%) 6px minmax(420px, 1fr); }
    section { min-width: 0; min-height: 0; }
    #chat-panel { display: grid; grid-template-rows: minmax(0, 1fr) 52px; background: #111827; }
    #messages { overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 7px; padding: 9px 11px; line-height: 1.45; max-width: 96%; }
    .message.user { align-self: flex-end; background: #1d4ed8; }
    .message.assistant { align-self: flex-start; background: #1f2937; }
    .message.system { align-self: stretch; background: #172033; color: #cbd5e1; font-size: 12px; }
    .tool { color: #93c5fd; font-size: 12px; padding: 2px 4px; }
    #input-form { display: flex; gap: 8px; padding: 8px; border-top: 1px solid #263247; }
    #input { flex: 1; min-width: 0; border: 1px solid #475569; border-radius: 5px; background: #0f172a; color: #f8fafc; padding: 8px; outline: none; }
    #input:focus { border-color: #60a5fa; }
    #input-form button { width: 64px; border: 0; border-radius: 5px; background: #2563eb; color: white; cursor: pointer; }
    #splitter { cursor: col-resize; background: #334155; outline: none; }
    #splitter:focus, #splitter:hover { background: #60a5fa; }
    #game-panel { position: relative; background: #020617; display: grid; grid-template-rows: 30px minmax(0, 1fr); }
    #game-state { padding: 6px 10px; color: #94a3b8; font-size: 12px; border-bottom: 1px solid #263247; }
    #game-frame { width: 100%; height: 100%; border: 0; display: block; background: #000; }
    #game-empty { display: grid; place-items: center; height: 100%; color: #64748b; }
    footer { display: flex; align-items: center; gap: 12px; overflow: hidden; white-space: nowrap; padding: 0 10px; background: #0b1220; border-top: 1px solid #263247; color: #cbd5e1; font-size: 11px; }
    .status-item { color: #94a3b8; }
    .status-item strong { color: #e2e8f0; font-weight: 500; }
    dialog { color: #e5e7eb; background: #111827; border: 1px solid #475569; border-radius: 8px; width: min(620px, 90vw); }
    dialog::backdrop { background: rgba(0,0,0,.68); }
    dialog pre { white-space: pre-wrap; max-height: 45vh; overflow: auto; background: #0b1220; padding: 10px; border-radius: 5px; }
    dialog menu { display: flex; justify-content: flex-end; gap: 8px; padding: 0; }
    dialog button { padding: 7px 12px; border-radius: 4px; border: 1px solid #475569; background: #1f2937; color: #e5e7eb; cursor: pointer; }
    dialog button.primary { background: #2563eb; border-color: #3b82f6; }
    @media (max-width: 900px) { main { grid-template-columns: minmax(250px, 48%) 6px minmax(280px, 1fr); } footer { gap: 7px; font-size: 10px; } }
  </style>
</head>
<body>
  <div id="shell">
    <header><strong>Dungeon Maintainer</strong><small id="task-label">加载任务…</small><button id="close-button" type="button">结束会话</button></header>
    <main id="main-layout">
      <section id="chat-panel" aria-label="Pi CLI 聊天">
        <div id="messages" aria-live="polite"></div>
        <form id="input-form"><input id="input" autocomplete="off" placeholder="描述问题，或输入 /play、/verify…"><button type="submit">发送</button></form>
      </section>
      <div id="splitter" role="separator" aria-label="调整聊天和游戏宽度" aria-valuemin="25" aria-valuemax="70" aria-valuenow="42" tabindex="0"></div>
      <section id="game-panel" aria-label="游戏实机"><div id="game-state">等待游戏开发桥…</div><div id="game-empty">正在等待 worktree 中的游戏启动</div><iframe id="game-frame" title="SQL Dungeon 游戏实机" allow="autoplay" hidden></iframe></section>
    </main>
    <footer id="status-bar"></footer>
  </div>
  <dialog id="approval-dialog"><form method="dialog"><h3 id="approval-title"></h3><pre id="approval-message"></pre><menu><button value="cancel">取消</button><button id="approval-ok" class="primary" value="ok">确认</button></menu></form></dialog>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const taskId = params.get('taskId') || '';
      const token = params.get('token') || '';
      const endpoint = (path) => path + '?taskId=' + encodeURIComponent(taskId) + '&token=' + encodeURIComponent(token);
      const messages = document.getElementById('messages');
      const input = document.getElementById('input');
      const form = document.getElementById('input-form');
      const statusBar = document.getElementById('status-bar');
      const frame = document.getElementById('game-frame');
      const empty = document.getElementById('game-empty');
      const gameState = document.getElementById('game-state');
      const taskLabel = document.getElementById('task-label');
      const approval = document.getElementById('approval-dialog');
      let currentApproval = null;
      let assistantNode = null;

      const addMessage = (kind, text) => {
        if (!text) return;
        const node = document.createElement('div');
        node.className = 'message ' + kind;
        node.textContent = text;
        messages.appendChild(node);
        messages.scrollTop = messages.scrollHeight;
        return node;
      };
      const safeNumber = (value) => typeof value === 'number' ? value.toLocaleString('zh-CN') : '—';
      const renderStatus = (status) => {
        const items = [
          ['任务', status.taskState], ['阶段', status.phase], ['模型', status.model],
          ['上下文', safeNumber(status.contextUsed) + '/' + safeNumber(status.contextLimit)],
          ['本轮 I/O', safeNumber(status.turnInputTokens) + '/' + safeNumber(status.turnOutputTokens)],
          ['累计', safeNumber(status.totalTokens)], ['工具', safeNumber(status.toolCalls) + '/' + safeNumber(status.toolBudget)],
          ['Vite', status.viteState], ['浏览器', status.browserState], ['桥', status.bridgeState],
          ['Diff', safeNumber(status.diffFiles)], ['验证', status.verificationState]
        ];
        statusBar.replaceChildren(...items.map(([label, value]) => { const span = document.createElement('span'); span.className = 'status-item'; span.textContent = label + ': '; const strong = document.createElement('strong'); strong.textContent = String(value); span.appendChild(strong); return span; }));
        taskLabel.textContent = taskId ? '任务 ' + taskId.slice(0, 8) : '未绑定任务';
      };
      const send = async (path, body) => {
        const response = await fetch(endpoint(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        if (!response.ok) throw new Error('请求失败：' + response.status);
        return await response.json().catch(() => ({}));
      };
      const showNotice = (level, text) => addMessage('system', '[' + level + '] ' + text);
      const showApproval = (request) => {
        currentApproval = request;
        if (request.kind === 'input') {
          const value = window.prompt(request.title, '');
          void send('/api/ui-response', value === null ? { id: request.id, cancelled: true } : { id: request.id, value });
          currentApproval = null;
          return;
        }
        if (request.kind === 'select') {
          const options = Array.isArray(request.options) ? request.options.join(' / ') : '';
          const value = window.prompt(request.title + (options ? '（' + options + '）' : ''), '');
          void send('/api/ui-response', value === null ? { id: request.id, cancelled: true } : { id: request.id, value });
          currentApproval = null;
          return;
        }
        document.getElementById('approval-title').textContent = request.title;
        document.getElementById('approval-message').textContent = request.message;
        approval.showModal();
      };
      document.getElementById('approval-ok').addEventListener('click', () => { if (currentApproval) void send('/api/ui-response', { id: currentApproval.id, confirmed: true }); currentApproval = null; });
      approval.addEventListener('close', () => { if (currentApproval) void send('/api/ui-response', { id: currentApproval.id, confirmed: false }); currentApproval = null; });
      form.addEventListener('submit', (event) => {
        event.preventDefault(); const text = input.value.trim(); if (!text) return; input.value = '';
        addMessage('user', text);
        const path = text.startsWith('/') ? '/api/command' : '/api/input';
        void send(path, { text }).catch((error) => showNotice('error', error.message));
      });
      document.getElementById('close-button').addEventListener('click', () => { void send('/api/close', {}).finally(() => window.close()); });

      const splitter = document.getElementById('splitter');
      const saved = Number(localStorage.getItem('dungeon-shell-split') || '42');
      let percent = Number.isFinite(saved) ? Math.min(70, Math.max(25, saved)) : 42;
      const applySplit = () => { document.getElementById('main-layout').style.gridTemplateColumns = 'minmax(320px,' + percent + '%) 6px minmax(420px,1fr)'; splitter.setAttribute('aria-valuenow', String(Math.round(percent))); localStorage.setItem('dungeon-shell-split', String(percent)); };
      applySplit();
      let dragging = false;
      splitter.addEventListener('pointerdown', (event) => { dragging = true; splitter.setPointerCapture(event.pointerId); });
      splitter.addEventListener('pointermove', (event) => { if (!dragging) return; const rect = document.getElementById('main-layout').getBoundingClientRect(); percent = Math.min(70, Math.max(25, ((event.clientX - rect.left) / rect.width) * 100)); applySplit(); });
      splitter.addEventListener('pointerup', () => { dragging = false; });
      splitter.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft') percent -= 2; if (event.key === 'ArrowRight') percent += 2; percent = Math.min(70, Math.max(25, percent)); applySplit(); });

      const handle = (data) => {
        if (!data) return;
        if (data.type === 'state') { renderStatus(data.status); if (data.gameUrl && frame.src !== data.gameUrl) { frame.src = data.gameUrl; frame.hidden = false; empty.hidden = true; gameState.textContent = '游戏正在加载…'; } }
        else if (data.type === 'chat.user') addMessage('user', data.text);
        else if (data.type === 'chat.text') { if (!assistantNode) assistantNode = addMessage('assistant', ''); assistantNode.textContent += data.text; if (data.done) assistantNode = null; messages.scrollTop = messages.scrollHeight; }
        else if (data.type === 'chat.tool') addMessage('system', (data.phase === 'start' ? '▶ ' : '■ ') + data.name + (data.error ? '（失败）' : ''));
        else if (data.type === 'notice') showNotice(data.level, data.text);
        else if (data.type === 'approval') showApproval(data.request);
        else if (data.type === 'game') { gameState.textContent = data.state === 'ready' ? '游戏已就绪 · Playtest Bridge v2' : '游戏状态：' + data.state; if (data.gameUrl && frame.src !== data.gameUrl) { frame.src = data.gameUrl; frame.hidden = false; empty.hidden = true; } }
        else if (data.type === 'closed') showNotice('info', 'Pi 会话已结束，任务证据仍保留。');
      };
      const events = new EventSource(endpoint('/events'));
      events.onmessage = (event) => { try { handle(JSON.parse(event.data)); } catch { showNotice('error', '收到无法解析的 Shell 事件'); } };
      events.onerror = () => { gameState.textContent = 'Shell 连接断开，正在重连…'; };
      void fetch(endpoint('/api/state')).then((response) => response.json()).then((state) => handle({ type: 'state', ...state })).catch((error) => showNotice('error', error.message));
      input.focus();
    })();
  </script>
</body>
</html>`;
}
