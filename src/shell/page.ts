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
    [hidden] { display: none !important; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body { background: #111827; color: #e5e7eb; }
    #shell { width: 100%; height: 100dvh; min-height: 0; overflow: hidden; display: grid; grid-template-rows: 42px minmax(0, 1fr) 62px; }
    header { display: flex; align-items: center; gap: 12px; padding: 0 14px; background: #0b1220; border-bottom: 1px solid #263247; }
    header strong { color: #93c5fd; }
    header small { color: #94a3b8; }
    header button { margin-left: 0; background: #1f2937; color: #e5e7eb; border: 1px solid #475569; border-radius: 4px; padding: 5px 10px; cursor: pointer; }
    #settings-button { margin-left: auto; }
    main { min-width: 0; min-height: 0; overflow: hidden; display: grid; grid-template-columns: minmax(320px, 42%) 6px minmax(420px, 1fr); }
    section { min-width: 0; min-height: 0; }
    #chat-panel { overflow: hidden; display: grid; grid-template-rows: minmax(0, 1fr) auto auto 52px; background: #111827; }
    #messages { min-height: 0; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 7px; padding: 9px 11px; line-height: 1.45; max-width: 96%; }
    .message.user { align-self: flex-end; background: #1d4ed8; }
    .message.assistant { align-self: flex-start; background: #1f2937; }
    .message.system { align-self: stretch; background: #172033; color: #cbd5e1; font-size: 12px; }
    .tool { align-self: stretch; color: #93c5fd; background: #0f172a; border-left: 3px solid #334155; border-radius: 4px; font-size: 12px; padding: 6px 9px; }
    #evidence-panel { margin: 0 10px 6px; border: 1px solid #334155; border-radius: 5px; background: #0b1220; max-height: 26vh; overflow: auto; }
    #evidence-panel summary { cursor: pointer; padding: 6px 8px; color: #93c5fd; font-size: 12px; }
    #evidence-list { padding: 0 8px 7px; }
    .evidence-group { margin-top: 5px; color: #94a3b8; font-size: 11px; }
    .evidence-row { padding: 4px 0; border-top: 1px solid #1e293b; white-space: pre-wrap; overflow-wrap: anywhere; color: #cbd5e1; font-size: 11px; }
    .evidence-row.stale, .evidence-row.superseded { color: #64748b; }
    #activity { min-height: 38px; display: flex; align-items: center; gap: 9px; padding: 8px 12px; border-top: 1px solid #263247; background: #0b1220; color: #bfdbfe; font-size: 12px; }
    #activity[hidden] { display: none; }
    #activity.error { color: #fca5a5; background: #1f151c; }
    #activity.approval { color: #fde68a; background: #1c1a12; }
    #activity.done { color: #86efac; }
    .activity-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 999px; background: currentColor; box-shadow: 0 0 0 0 currentColor; animation: activity-pulse 1.4s ease-out infinite; }
    #activity.done .activity-dot, #activity.error .activity-dot { animation: none; }
    #activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #activity-time { margin-left: auto; color: #94a3b8; font-variant-numeric: tabular-nums; }
    @keyframes activity-pulse { 0% { box-shadow: 0 0 0 0 currentColor; } 70%, 100% { box-shadow: 0 0 0 6px transparent; } }
    #input-form { display: flex; gap: 8px; padding: 8px; border-top: 1px solid #263247; }
    #input { flex: 1; min-width: 0; border: 1px solid #475569; border-radius: 5px; background: #0f172a; color: #f8fafc; padding: 8px; outline: none; }
    #input:focus { border-color: #60a5fa; }
    #input-form button { width: 64px; border: 0; border-radius: 5px; background: #2563eb; color: white; cursor: pointer; }
    #splitter { cursor: col-resize; background: #334155; outline: none; }
    #splitter:focus, #splitter:hover { background: #60a5fa; }
    #game-panel { position: relative; overflow: hidden; background: #020617; display: grid; grid-template-rows: 30px minmax(0, 1fr); }
    #game-state { padding: 6px 10px; color: #94a3b8; font-size: 12px; border-bottom: 1px solid #263247; }
    #game-frame { width: 100%; height: 100%; min-height: 0; border: 0; display: block; background: #000; }
    #game-empty { display: grid; place-items: center; height: 100%; color: #64748b; }
    footer { min-width: 0; min-height: 0; display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); overflow: hidden; white-space: nowrap; background: #0b1220; border-top: 1px solid #263247; color: #cbd5e1; font-size: 11px; }
    .status-row { min-width: 0; min-height: 0; display: flex; align-items: center; gap: 10px; overflow-x: auto; overflow-y: hidden; padding: 2px 10px; scrollbar-width: thin; scrollbar-color: #475569 transparent; }
    .status-row + .status-row { border-top: 1px solid #1e293b; }
    .status-item { color: #94a3b8; }
    .status-item strong { color: #e2e8f0; font-weight: 500; }
    .status-control { display: inline-flex; align-items: center; gap: 4px; color: #94a3b8; }
    .status-control select, .status-control button { max-width: 190px; height: 23px; border: 1px solid #334155; border-radius: 4px; background: #111827; color: #e2e8f0; font: inherit; }
    .status-control button { padding: 0 7px; cursor: pointer; }
    .status-control select:disabled, .status-control button:disabled { cursor: wait; opacity: .55; }
    #workspace-panel { position: fixed; z-index: 20; left: 0; right: 0; bottom: 62px; height: min(52vh, 480px); min-height: 240px; background: #0b1220; border-top: 1px solid #475569; box-shadow: 0 -14px 28px rgba(0,0,0,.35); display: grid; grid-template-rows: 38px minmax(0, 1fr); }
    #workspace-panel header { padding: 0 10px; border-bottom: 1px solid #263247; }
    #workspace-panel header button { margin-left: 0; }
    #workspace-panel header strong { margin-right: auto; }
    #workspace-content { min-height: 0; display: grid; grid-template-columns: minmax(240px, 34%) minmax(0, 1fr); }
    #workspace-sources, #workspace-files { min-height: 0; overflow: auto; padding: 10px; }
    #workspace-sources { border-right: 1px solid #263247; }
    .workspace-heading { margin: 7px 0 5px; color: #93c5fd; font-size: 12px; }
    .workspace-entry { width: 100%; margin: 0 0 5px; padding: 7px 8px; text-align: left; color: #e2e8f0; background: #111827; border: 1px solid #334155; border-radius: 5px; cursor: pointer; }
    .workspace-entry small { display: block; margin-top: 3px; color: #94a3b8; }
    .workspace-entry:disabled { cursor: default; opacity: .6; border-color: #1e3a5f; }
    .file-row { min-width: max-content; padding: 3px 5px; color: #cbd5e1; border-radius: 3px; font-family: Consolas, monospace; font-size: 11px; }
    .file-row:hover { background: #111827; }
    .file-badge { display: inline-block; margin-left: 5px; padding: 1px 4px; border-radius: 3px; color: #cbd5e1; background: #334155; font-family: "Segoe UI", sans-serif; font-size: 9px; }
    .file-badge.allowed, .file-badge.passed { color: #86efac; background: #163326; }
    .file-badge.modified { color: #fde68a; background: #3a2d11; }
    .file-badge.denied, .file-badge.failed { color: #fca5a5; background: #3b1720; }
    dialog { color: #e5e7eb; background: #111827; border: 1px solid #475569; border-radius: 8px; width: min(620px, 90vw); }
    dialog::backdrop { background: rgba(0,0,0,.68); }
    dialog pre { white-space: pre-wrap; max-height: 45vh; overflow: auto; background: #0b1220; padding: 10px; border-radius: 5px; }
    dialog menu { display: flex; justify-content: flex-end; gap: 8px; padding: 0; }
    dialog button { padding: 7px 12px; border-radius: 4px; border: 1px solid #475569; background: #1f2937; color: #e5e7eb; cursor: pointer; }
    dialog button.primary { background: #2563eb; border-color: #3b82f6; }
    .settings-grid { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 9px 10px; align-items: center; }
    .settings-grid label { color: #94a3b8; font-size: 12px; }
    .settings-grid input, .settings-grid select { width: 100%; min-width: 0; padding: 7px 8px; color: #f8fafc; background: #0f172a; border: 1px solid #475569; border-radius: 4px; }
    .settings-check { display: flex; align-items: center; gap: 7px; }
    .settings-check input { width: auto; }
    #input-form button:disabled, #input:disabled { cursor: wait; opacity: .58; }
    @media (prefers-reduced-motion: reduce) { .activity-dot { animation: none; } }
    @media (max-width: 900px) { main { grid-template-columns: minmax(250px, 48%) 6px minmax(280px, 1fr); } footer { font-size: 10px; } .status-row { gap: 7px; padding-inline: 7px; } }
  </style>
</head>
<body>
  <div id="shell">
    <header><strong>Dungeon Maintainer</strong><small id="task-label">加载任务…</small><button id="settings-button" type="button">模型配置</button><button id="close-button" type="button">结束会话</button></header>
    <main id="main-layout">
      <section id="chat-panel" aria-label="Pi CLI 聊天">
        <div id="messages" aria-live="polite"></div>
        <details id="evidence-panel" open><summary>证据链</summary><div id="evidence-list"><div class="evidence-group">等待证据…</div></div></details>
        <div id="activity" role="status" aria-live="polite" aria-atomic="true" hidden><span class="activity-dot" aria-hidden="true"></span><span id="activity-text"></span><span id="activity-time"></span></div>
        <form id="input-form"><input id="input" autocomplete="off" placeholder="描述问题，或输入 /play、/verify…"><button type="submit">发送</button></form>
      </section>
      <div id="splitter" role="separator" aria-label="调整聊天和游戏宽度" aria-valuemin="25" aria-valuemax="70" aria-valuenow="42" tabindex="0"></div>
      <section id="game-panel" aria-label="游戏实机"><div id="game-state">等待游戏开发桥…</div><div id="game-empty">正在等待 worktree 中的游戏启动</div><iframe id="game-frame" title="SQL Dungeon 游戏实机" allow="autoplay" hidden></iframe></section>
    </main>
    <footer id="status-bar"><div id="status-primary" class="status-row" aria-label="任务状态第一排"></div><div id="status-secondary" class="status-row" aria-label="运行状态第二排"></div></footer>
  </div>
  <aside id="workspace-panel" aria-label="工作树与沙箱" hidden><header><strong>工作树与任务沙箱</strong><button id="workspace-rename" type="button">重命名当前任务</button><button id="workspace-refresh" type="button">刷新</button><button id="workspace-close" type="button">关闭</button></header><div id="workspace-content"><div id="workspace-sources"></div><div id="workspace-files"></div></div></aside>
  <dialog id="approval-dialog"><form method="dialog"><h3 id="approval-title"></h3><pre id="approval-message"></pre><menu><button id="approval-cancel" value="cancel">取消</button><button id="approval-ok" class="primary" value="ok">确认</button></menu></form></dialog>
  <dialog id="settings-dialog"><form id="settings-form"><h3>OpenAI-compatible 模型档案</h3><div class="settings-grid"><label for="profile-existing">已有档案</label><select id="profile-existing"><option value="">新建档案</option></select><label for="profile-id">档案 ID</label><input id="profile-id" required pattern="[a-z0-9][a-z0-9_-]{0,31}"><label for="profile-name">显示名称</label><input id="profile-name" required maxlength="80"><label for="profile-url">接口地址</label><input id="profile-url" required placeholder="https://api.example.com/v1"><label for="profile-model">模型 ID</label><input id="profile-model" required maxlength="160"><label for="profile-context">上下文窗口</label><input id="profile-context" type="number" min="8000" max="2000000" required><label for="profile-output">输出上限</label><input id="profile-output" type="number" min="256" max="64000" required><label>能力</label><span class="settings-check"><input id="profile-reasoning" type="checkbox"><span>支持 Thinking</span></span><label for="profile-key">API Key</label><input id="profile-key" type="password" autocomplete="new-password" placeholder="留空则保留 Windows 凭据"><label>启用</label><span class="settings-check"><input id="profile-activate" type="checkbox" checked><span>保存后用于当前任务</span></span></div><menu><button id="settings-cancel" type="button">取消</button><button class="primary" type="submit">保存并重启单一 Pi</button></menu></form></dialog>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const taskId = params.get('taskId') || '';
      const token = params.get('token') || '';
      const endpoint = (path) => path + '?taskId=' + encodeURIComponent(taskId) + '&token=' + encodeURIComponent(token);
      const messages = document.getElementById('messages');
      const evidenceList = document.getElementById('evidence-list');
      const input = document.getElementById('input');
      const form = document.getElementById('input-form');
      const sendButton = form.querySelector('button[type="submit"]');
      const activity = document.getElementById('activity');
      const activityText = document.getElementById('activity-text');
      const activityTime = document.getElementById('activity-time');
      const statusPrimary = document.getElementById('status-primary');
      const statusSecondary = document.getElementById('status-secondary');
      const workspacePanel = document.getElementById('workspace-panel');
      const workspaceSources = document.getElementById('workspace-sources');
      const workspaceFiles = document.getElementById('workspace-files');
      const frame = document.getElementById('game-frame');
      const empty = document.getElementById('game-empty');
      const gameState = document.getElementById('game-state');
      const taskLabel = document.getElementById('task-label');
      const approval = document.getElementById('approval-dialog');
      const settingsDialog = document.getElementById('settings-dialog');
      const settingsForm = document.getElementById('settings-form');
      let currentApproval = null;
      let assistantNode = null;
      let activityHideTimer = null;
      let currentStatus = null;
      const toolGroups = new Map();

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
      const formatTime = (value) => {
        if (typeof value !== 'string') return '时间未知';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
      };
      const cacheHitRate = (input, cacheRead, cacheWrite) => {
        const promptTokens = input + cacheRead + cacheWrite;
        return promptTokens > 0 ? ((cacheRead / promptTokens) * 100).toFixed(2) + '%' : '—';
      };
      const statusItem = (label, value) => {
        const span = document.createElement('span');
        span.className = 'status-item';
        span.textContent = label + ': ';
        const strong = document.createElement('strong');
        strong.textContent = String(value);
        span.appendChild(strong);
        return span;
      };
      const controlBusy = (status) => status.phase !== 'idle';
      const renderStatus = (status) => {
        currentStatus = status;
        const turnCacheRate = cacheHitRate(status.turnInputTokens, status.cacheReadTokens, status.cacheWriteTokens);
        const sessionCacheRate = cacheHitRate(status.sessionInputTokens, status.sessionCacheReadTokens, status.sessionCacheWriteTokens);
        const sessionFreshTokens = status.sessionInputTokens + status.sessionCacheWriteTokens;
        const workspaceButton = document.createElement('button');
        workspaceButton.id = 'workspace-button';
        workspaceButton.type = 'button';
        workspaceButton.textContent = status.taskName + ' · ' + status.sourceBranch + ' · ' + formatTime(status.taskCreatedAt);
        workspaceButton.disabled = controlBusy(status);
        workspaceButton.addEventListener('click', () => { void toggleWorkspace(); });
        const workspaceControl = document.createElement('span');
        workspaceControl.className = 'status-control';
        workspaceControl.append('工作树: ', workspaceButton);

        const modelSelect = document.createElement('select');
        modelSelect.id = 'model-select';
        for (const model of status.availableModels || []) {
          const option = document.createElement('option');
          option.value = JSON.stringify([model.provider, model.id]);
          option.textContent = model.name + (model.reasoning ? ' · reasoning' : '');
          if (model.provider === status.modelProvider && model.id === status.model) option.selected = true;
          modelSelect.appendChild(option);
        }
        if (!modelSelect.options.length) {
          const option = document.createElement('option');
          option.value = JSON.stringify([status.modelProvider, status.model]);
          option.textContent = status.model;
          modelSelect.appendChild(option);
        }
        modelSelect.disabled = controlBusy(status);
        modelSelect.addEventListener('change', () => {
          const [provider, modelId] = JSON.parse(modelSelect.value);
          modelSelect.disabled = true;
          void send('/api/pi/model', { provider, modelId })
            .then((payload) => renderStatus(payload.status))
            .catch((error) => { showNotice('error', error.message); renderStatus(currentStatus); });
        });
        const modelControl = document.createElement('span');
        modelControl.className = 'status-control';
        modelControl.append('模型: ', modelSelect);

        const thinkingSelect = document.createElement('select');
        thinkingSelect.id = 'thinking-select';
        for (const level of status.availableThinkingLevels || ['off']) {
          const option = document.createElement('option');
          option.value = level;
          option.textContent = level;
          option.selected = level === status.thinkingLevel;
          thinkingSelect.appendChild(option);
        }
        thinkingSelect.disabled = controlBusy(status);
        thinkingSelect.addEventListener('change', () => {
          thinkingSelect.disabled = true;
          void send('/api/pi/thinking', { level: thinkingSelect.value })
            .then((payload) => renderStatus(payload.status))
            .catch((error) => { showNotice('error', error.message); renderStatus(currentStatus); });
        });
        const thinkingControl = document.createElement('span');
        thinkingControl.className = 'status-control';
        thinkingControl.append('Thinking: ', thinkingSelect);

        const compactButton = document.createElement('button');
        compactButton.id = 'compact-button';
        compactButton.type = 'button';
        compactButton.textContent = '压缩';
        compactButton.disabled = controlBusy(status);
        compactButton.addEventListener('click', () => {
          compactButton.disabled = true;
          void send('/api/pi/compact', {})
            .then((payload) => renderStatus(payload.status))
            .catch((error) => { showNotice('error', error.message); renderStatus(currentStatus); });
        });
        const contextControl = document.createElement('span');
        contextControl.className = 'status-control';
        const contextPercent = typeof status.contextPercent === 'number' ? status.contextPercent.toFixed(1) + '%' : '—';
        const contextValue = document.createElement('strong');
        contextValue.textContent = safeNumber(status.contextUsed) + '/' + safeNumber(status.contextLimit) + ' · ' + contextPercent + ' · 安全线 ' + safeNumber(status.promptTokenLimit) + (status.autoCompactionEnabled ? ' · 自动' : ' · 手动');
        contextControl.append(
          '上下文: ',
          contextValue,
          compactButton
        );

        statusPrimary.replaceChildren(
          workspaceControl,
          statusItem('任务', status.taskName + ' · ' + status.activeTaskId.slice(0, 8) + ' · ' + status.taskState),
          statusItem('阶段', status.phase + (status.pendingMessageCount ? ' · 待处理 ' + safeNumber(status.pendingMessageCount) : '')),
          modelControl,
          thinkingControl,
          contextControl
        );
        statusSecondary.replaceChildren(
          statusItem('本轮 Token', safeNumber(status.turnInputTokens) + '/' + safeNumber(status.turnOutputTokens) + ' · ' + safeNumber(status.turnTotalTokens)),
          statusItem('本轮缓存', safeNumber(status.cacheReadTokens) + ' · ' + turnCacheRate),
          statusItem('会话 新/缓/出', safeNumber(sessionFreshTokens) + '/' + safeNumber(status.sessionCacheReadTokens) + '/' + safeNumber(status.sessionOutputTokens)),
          statusItem('会话 Token', safeNumber(status.totalTokens) + ' · 缓存 ' + sessionCacheRate),
          statusItem('工具预算', safeNumber(status.toolCalls) + '/' + safeNumber(status.toolBudget)),
          statusItem('运行时', status.viteState + '/' + status.browserState + '/' + status.bridgeState),
          statusItem('Diff', safeNumber(status.diffFiles)),
          statusItem('验证', status.verificationState)
        );
        taskLabel.textContent = status.activeTaskId
          ? status.taskName + ' · ' + formatTime(status.taskCreatedAt)
          : '未绑定任务';
      };
      const send = async (path, body) => {
        const response = await fetch(endpoint(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(typeof payload.error === 'string' ? payload.error : '请求失败：' + response.status);
          error.status = response.status;
          throw error;
        }
        return payload;
      };
      const readJson = async (path) => {
        const response = await fetch(endpoint(path), { cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : '请求失败：' + response.status);
        return payload;
      };
      const workspaceHeading = (text) => {
        const heading = document.createElement('div');
        heading.className = 'workspace-heading';
        heading.textContent = text;
        return heading;
      };
      const switchEntry = (label, detail, request, current) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'workspace-entry';
        button.disabled = current || (currentStatus && controlBusy(currentStatus));
        button.textContent = label;
        const small = document.createElement('small');
        small.textContent = detail;
        button.appendChild(small);
        button.addEventListener('click', () => {
          button.disabled = true;
          void send('/api/tasks/switch', request)
            .then(() => {
              workspacePanel.hidden = true;
              showActivity({ state: 'waiting', text: '正在保存当前任务并切换工作树…', elapsedSeconds: 0 });
            })
            .catch((error) => { showNotice('error', error.message); button.disabled = false; });
        });
        return button;
      };
      const renderWorkspaceFiles = (payload) => {
        workspaceFiles.replaceChildren(workspaceHeading('detached worktree 文件树 · ' + String(payload.taskId || '').slice(0, 8)));
        for (const file of payload.files || []) {
          const row = document.createElement('div');
          row.className = 'file-row';
          row.style.paddingLeft = String(Math.min(48, Math.max(0, String(file.path).split('/').length - 1) * 8) + 5) + 'px';
          row.append(String(file.path));
          const badges = [];
          if (file.approved) badges.push(['允许修改', 'allowed']);
          if (file.modified) badges.push(['已修改', 'modified']);
          if (file.denied) badges.push(['禁止', 'denied']);
          if (file.validation === 'passed') badges.push(['验证通过', 'passed']);
          if (file.validation === 'failed') badges.push(['验证失败', 'failed']);
          for (const [text, kind] of badges) {
            const badge = document.createElement('span');
            badge.className = 'file-badge ' + kind;
            badge.textContent = text;
            row.appendChild(badge);
          }
          workspaceFiles.appendChild(row);
        }
      };
      const loadWorkspace = async () => {
        workspaceSources.replaceChildren(workspaceHeading('正在读取合法工作树与可恢复任务…'));
        workspaceFiles.replaceChildren(workspaceHeading('正在读取沙箱文件树…'));
        const [catalog, tree] = await Promise.all([
          readJson('/api/worktrees'),
          readJson('/api/workspace/tree')
        ]);
        const sourceNodes = [workspaceHeading('合法 Git 工作树')];
        for (const item of catalog.worktrees || []) {
          sourceNodes.push(switchEntry(
            item.branch,
            'ID ' + item.id + ' · 本地修改 ' + safeNumber(item.dirtyFiles),
            { kind: 'worktree', id: item.id },
            item.current
          ));
        }
        sourceNodes.push(workspaceHeading('可恢复任务'));
        for (const item of catalog.tasks || []) {
          sourceNodes.push(switchEntry(
            item.name + ' · ' + item.id.slice(0, 8),
            '分支 ' + item.branch + ' · 创建 ' + formatTime(item.createdAt) + ' · ' + item.state + ' · Diff ' + safeNumber(item.changedFiles),
            { kind: 'task', id: item.id },
            item.current
          ));
        }
        workspaceSources.replaceChildren(...sourceNodes);
        renderWorkspaceFiles(tree);
      };
      const toggleWorkspace = async () => {
        workspacePanel.hidden = !workspacePanel.hidden;
        if (!workspacePanel.hidden) {
          await loadWorkspace().catch((error) => {
            showNotice('error', error.message);
            workspaceSources.replaceChildren(workspaceHeading('工作树读取失败'));
          });
        }
      };
      document.getElementById('workspace-close').addEventListener('click', () => { workspacePanel.hidden = true; });
      document.getElementById('workspace-refresh').addEventListener('click', () => { void loadWorkspace().catch((error) => showNotice('error', error.message)); });
      document.getElementById('workspace-rename').addEventListener('click', () => {
        if (!currentStatus || controlBusy(currentStatus)) return;
        const nextName = window.prompt('请输入任务名称', currentStatus.taskName || '未命名修复');
        if (nextName === null) return;
        const button = document.getElementById('workspace-rename');
        button.disabled = true;
        void send('/api/tasks/rename', { name: nextName.trim() })
          .then((payload) => {
            if (payload.status) renderStatus(payload.status);
            return loadWorkspace();
          })
          .catch((error) => showNotice('error', error.message))
          .finally(() => { button.disabled = false; });
      });
      let modelProfiles = [];
      const fillProfileForm = (profile) => {
        document.getElementById('profile-id').value = profile?.id || '';
        document.getElementById('profile-name').value = profile?.name || '';
        document.getElementById('profile-url').value = profile?.baseUrl || '';
        document.getElementById('profile-model').value = profile?.modelId || '';
        document.getElementById('profile-context').value = profile?.contextWindow || 64000;
        document.getElementById('profile-output').value = profile?.maxOutputTokens || 4096;
        document.getElementById('profile-reasoning').checked = profile?.reasoning === true;
        document.getElementById('profile-key').value = '';
        document.getElementById('profile-key').placeholder = profile?.hasCredential ? '已保存在 Windows 凭据管理器；留空保持' : '请输入 API Key';
        document.getElementById('profile-activate').checked = profile?.active !== false;
      };
      const openSettings = async () => {
        const payload = await readJson('/api/settings/profiles');
        modelProfiles = payload.profiles || [];
        const select = document.getElementById('profile-existing');
        select.replaceChildren(new Option('新建档案', ''));
        for (const profile of modelProfiles) {
          const option = new Option(profile.name + (profile.hasCredential ? ' · Key 已配置' : ' · 缺少 Key'), profile.id);
          option.selected = profile.active === true;
          select.appendChild(option);
        }
        fillProfileForm(modelProfiles.find((profile) => profile.active) || modelProfiles[0]);
        settingsDialog.showModal();
      };
      document.getElementById('profile-existing').addEventListener('change', (event) => {
        fillProfileForm(modelProfiles.find((profile) => profile.id === event.target.value));
      });
      document.getElementById('settings-button').addEventListener('click', () => {
        void openSettings().catch((error) => showNotice('error', error.message));
      });
      document.getElementById('settings-cancel').addEventListener('click', () => settingsDialog.close());
      settingsForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const body = {
          id: document.getElementById('profile-id').value.trim(),
          name: document.getElementById('profile-name').value.trim(),
          baseUrl: document.getElementById('profile-url').value.trim(),
          modelId: document.getElementById('profile-model').value.trim(),
          contextWindow: Number(document.getElementById('profile-context').value),
          maxOutputTokens: Number(document.getElementById('profile-output').value),
          reasoning: document.getElementById('profile-reasoning').checked,
          apiKey: document.getElementById('profile-key').value,
          activate: document.getElementById('profile-activate').checked
        };
        void send('/api/settings/profiles', body)
          .then((payload) => {
            settingsDialog.close();
            if (payload.status) renderStatus(payload.status);
            showNotice(
              'info',
              payload.profile?.restarted
                ? '模型档案已安全保存，单一 Pi 已按新配置重启。'
                : '模型档案已安全保存；当前活动 Pi 未重启。'
            );
          })
          .catch((error) => showNotice('error', error.message));
      });
      const showNotice = (level, text) => addMessage('system', '[' + level + '] ' + text);
      const showActivity = (event) => {
        if (activityHideTimer) clearTimeout(activityHideTimer);
        activityHideTimer = null;
        activity.hidden = false;
        activity.className = event.state;
        activityText.textContent = event.text;
        activityTime.textContent = event.elapsedSeconds > 0 ? String(event.elapsedSeconds) + 's' : '';
        const busy = event.state === 'waiting' || event.state === 'working' || event.state === 'approval';
        input.disabled = busy;
        sendButton.disabled = busy;
        input.setAttribute('aria-busy', String(busy));
        if (event.state === 'done') {
          activityHideTimer = setTimeout(() => { activity.hidden = true; input.focus(); }, 1_500);
        }
        if (event.state === 'error') input.focus();
      };
      const showTool = (event) => {
        let group = toolGroups.get(event.name);
        if (!group) {
          const node = document.createElement('div');
          node.className = 'tool';
          messages.appendChild(node);
          group = { node, started: 0, completed: 0, failed: 0 };
          toolGroups.set(event.name, group);
        }
        if (event.phase === 'start') group.started += 1;
        else {
          group.completed += 1;
          if (event.error) group.failed += 1;
        }
        const succeeded = group.completed - group.failed;
        const running = group.started - group.completed;
        group.node.textContent = '工具 ' + event.name + ' ×' + String(group.started)
          + ' · 成功 ' + String(succeeded)
          + (group.failed ? ' · 失败 ' + String(group.failed) : '')
          + (running ? ' · 运行中 ' + String(running) : '');
        messages.scrollTop = messages.scrollHeight;
      };
      const evidenceLocation = (record) => record.path ? ' · ' + record.path + (record.startLine ? ':' + record.startLine : '') + (record.lineCount ? '+' + record.lineCount : '') : '';
      const renderEvidence = (data) => {
        const records = Array.isArray(data.records) ? data.records : [];
        const active = records.filter((record) => record.status === 'active');
        const historical = records.filter((record) => record.status !== 'active');
        const row = (record) => {
          const node = document.createElement('div');
          node.className = 'evidence-row ' + record.status;
          const hash = record.baseHash ? ' · hash ' + String(record.baseHash).slice(0, 12) : record.worktreeHash ? ' · worktree ' + String(record.worktreeHash).slice(0, 12) : '';
          const links = [];
          if (Array.isArray(record.upstreamIds) && record.upstreamIds.length) links.push('↑ ' + record.upstreamIds.join(','));
          if (Array.isArray(record.downstreamIds) && record.downstreamIds.length) links.push('↓ ' + record.downstreamIds.join(','));
          node.textContent = '[' + record.kind + '/' + record.status + '] ' + record.id + evidenceLocation(record) + hash + (links.length ? ' · ' + links.join(' ') : '') + '\\n' + record.summary;
          return node;
        };
        evidenceList.replaceChildren();
        const title = document.createElement('div');
        title.className = 'evidence-group';
        title.textContent = '当前任务 · revision ' + String(data.revision || 0) + ' · active ' + String(active.length);
        evidenceList.appendChild(title);
        active.forEach((record) => evidenceList.appendChild(row(record)));
        if (historical.length) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = '历史 stale/superseded · ' + String(historical.length);
          details.appendChild(summary);
          historical.forEach((record) => details.appendChild(row(record)));
          evidenceList.appendChild(details);
        }
      };
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
        const isExecutionPlan = request.title === '是否执行完整修复方案';
        const isWriteApproval = request.title === '是否允许本次代码修改';
        const isReadOnlyEditor = request.kind === 'editor';
        document.getElementById('approval-cancel').hidden = isReadOnlyEditor;
        document.getElementById('approval-cancel').textContent = isExecutionPlan || isWriteApproval ? '暂不执行' : '取消';
        document.getElementById('approval-ok').textContent = isReadOnlyEditor ? '关闭' : isExecutionPlan ? '执行完整方案' : isWriteApproval ? '允许修改' : '确认';
        approval.showModal();
      };
      document.getElementById('approval-ok').addEventListener('click', () => {
        if (currentApproval) {
          const response = currentApproval.kind === 'editor'
            ? { id: currentApproval.id, value: currentApproval.message }
            : { id: currentApproval.id, confirmed: true };
          void send('/api/ui-response', response);
        }
        currentApproval = null;
      });
      approval.addEventListener('close', () => {
        if (currentApproval) {
          const response = currentApproval.kind === 'editor'
            ? { id: currentApproval.id, cancelled: true }
            : { id: currentApproval.id, confirmed: false };
          void send('/api/ui-response', response);
        }
        currentApproval = null;
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // 用户消息以服务端 SSE 回显为唯一事实源，避免本地预显示与回显各追加一次。
        const path = text.startsWith('/') ? '/api/command' : '/api/input';
        // 本地先锁定输入并显示固定反馈，不等待 POST 往返或模型首个 Token；服务端
        // activity 随后接管权威阶段和 elapsed 更新。
        showActivity({
          state: 'waiting',
          text: text.startsWith('/') ? '命令已发送，正在等待 Pi 执行…' : '消息已发送，正在等待 Pi 接收…',
          elapsedSeconds: 0
        });
        void send(path, { text }).catch((error) => {
          const stillBusy = error.status === 409;
          showActivity({ state: stillBusy ? 'waiting' : 'error', text: error.message, elapsedSeconds: 0 });
          showNotice(stillBusy ? 'warning' : 'error', error.message);
        });
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
        else if (data.type === 'chat.user') { toolGroups.clear(); addMessage('user', data.text); }
        else if (data.type === 'chat.text') {
          if (!assistantNode) assistantNode = addMessage('assistant', data.text);
          else if (data.done) assistantNode.textContent = data.text;
          else assistantNode.textContent += data.text;
          // message_update 是增量，message_end 是权威全文；结束时用全文覆盖可以消除重复。
          if (data.done) assistantNode = null;
          messages.scrollTop = messages.scrollHeight;
        }
        else if (data.type === 'chat.tool') showTool(data);
        else if (data.type === 'evidence.snapshot') renderEvidence(data);
        else if (data.type === 'activity') showActivity(data);
        else if (data.type === 'notice') showNotice(data.level, data.text);
        else if (data.type === 'approval') showApproval(data.request);
        else if (data.type === 'game') { gameState.textContent = data.state === 'ready' ? '游戏已就绪 · Playtest Bridge' : '游戏状态：' + data.state; if (data.gameUrl && frame.src !== data.gameUrl) { frame.src = data.gameUrl; frame.hidden = false; empty.hidden = true; } }
        else if (data.type === 'closed') showNotice('info', 'Pi 会话已结束，任务证据仍保留。');
      };
      const events = new EventSource(endpoint('/events'));
      events.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          showNotice('error', '收到无法解析的 Shell 事件');
          return;
        }
        try {
          handle(data);
        } catch {
          showNotice('error', 'Shell 事件渲染失败');
        }
      };
      events.onerror = () => { gameState.textContent = 'Shell 连接断开，正在重连…'; };
      void fetch(endpoint('/api/state')).then((response) => response.json()).then((state) => handle({ type: 'state', ...state })).catch((error) => showNotice('error', error.message));
      input.focus();
    })();
  </script>
</body>
</html>`;
}
