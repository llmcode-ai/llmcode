import * as vscode from "vscode";
import { l10n } from "vscode";
import type { OpencodeBridge } from "./opencode";
import type { ChatMessage, HostToWebview, WebviewToHost } from "./types";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Chat surface: a dedicated editor panel opened beside the editor (Copilot-style),
// with a header holding the session picker, model picker and actions, and a
// clean composer at the bottom. Uses only VS Code theme variables.

export class ChatPanel {
  public static current: ChatPanel | undefined;
  private static readonly viewType = "llmcode.chatPanel";
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private streaming = false;
  private currentSessionId: string | undefined;
  private currentModel: string | undefined;

  static createOrShow(extensionUri: vscode.Uri, bridge: OpencodeBridge) {
    const column = vscode.ViewColumn.Beside;
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(column);
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      l10n.t("LLMcode Chat"),
      column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    ChatPanel.current = new ChatPanel(panel, bridge);
    return ChatPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, private readonly bridge: OpencodeBridge) {
    this.panel = panel;
    this.panel.webview.html = getChatHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg), null, this.disposables);
    this.bridge.on("event", (event: any) => this.onEngineEvent(event));
  }

  private post(msg: HostToWebview) {
    this.panel.webview.postMessage(msg);
  }

  focus() {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  private async onMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "init":
        await this.init();
        break;
      case "send":
        await this.send(msg.sessionId, msg.text, msg.agent, msg.model, msg.reasoning);
        break;
      case "newSession":
        await this.newSession();
        break;
      case "switchSession":
        this.currentSessionId = msg.sessionId;
        await this.loadSession(msg.sessionId);
        break;
      case "deleteSession":
        await this.bridge.deleteSession(msg.sessionId);
        if (this.currentSessionId === msg.sessionId) this.currentSessionId = undefined;
        await this.refreshSessions();
        break;
      case "forkSession":
        await this.bridge.forkSession(msg.sessionId);
        await this.refreshSessions();
        break;
      case "renameSession":
        await this.bridge.updateSession(msg.sessionId, msg.title);
        await this.refreshSessions();
        break;
      case "stop":
        if (msg.sessionId) await this.bridge.abort(msg.sessionId);
        break;
      case "openSettings":
        await vscode.commands.executeCommand("llmcode.openSettings");
        break;
      case "import":
        await vscode.commands.executeCommand("llmcode.importFromMachine");
        break;
      case "refresh":
        await this.init();
        break;
    }
  }

  private async init() {
    this.post({ type: "status", status: { state: this.bridge.isConnected() ? "idle" : "connecting" } });
    await this.refreshSessions();
    await this.refreshModels();
    await this.refreshAgents();
    // Auto-select the first session if none is selected.
    if (!this.currentSessionId) {
      try {
        const sessions = await this.bridge.listSessions();
        if (sessions.length > 0) {
          this.currentSessionId = sessions[0].id;
          await this.loadSession(this.currentSessionId);
        }
      } catch {
        // engine not ready yet; the ready event will re-init
      }
    }
  }

  private async refreshSessions() {
    try {
      const sessions = await this.bridge.listSessions();
      this.post({ type: "sessions", sessions, activeId: this.currentSessionId });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }

  private async refreshModels() {
    try {
      const models = await this.bridge.listModels();
      this.post({ type: "models", models, activeModel: this.currentModel });
      const agents = await this.bridge.listAgents();
      this.post({ type: "agents", agents });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }

  private async refreshAgents() {
    try {
      this.post({ type: "agents", agents: await this.bridge.listAgents() });
    } catch {
      /* ignore */
    }
  }

  async newSession() {
    try {
      const s = await this.bridge.createSession();
      this.currentSessionId = s.id;
      await this.refreshSessions();
      this.post({ type: "callSessions", id: s.id });
      await this.loadSession(s.id);
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }

  private async loadSession(sessionId: string) {
    this.currentSessionId = sessionId;
    try {
      const messages = await this.bridge.listMessages(sessionId);
      const converted: ChatMessage[] = (messages as any[]).map((m, i) => {
        const parts = (m.parts ?? []);
        return {
          id: String((m.info as any)?.id ?? i),
          sessionId,
          role: ((m.info as any)?.role ?? "assistant") as "user" | "assistant",
          text: parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join(""),
          parts: parts.map((p: any) =>
            p.type === "tool"
              ? { type: "tool" as const, tool: p.tool, status: p.state?.status === "error" ? ("error" as const) : ("done" as const) }
              : { type: "text" as const, text: p.text ?? "" },
          ),
          createdAt: (m.info as any)?.time?.created ?? Date.now(),
        };
      });
      this.post({ type: "conversation", sessionId, messages: converted });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }

  private async send(sessionId: string, text: string, agent?: string, model?: string, reasoning?: boolean) {
    if (this.streaming) await this.bridge.abort(sessionId);
    this.streaming = true;
    this.currentSessionId = sessionId;
    this.post({ type: "status", status: { state: "streaming", sessionId } });

    const userMsg: ChatMessage = {
      id: `u${Date.now()}`,
      sessionId,
      role: "user",
      text,
      parts: [{ type: "text", text }],
      createdAt: Date.now(),
    };
    this.post({ type: "message", message: userMsg });

    try {
      const system = reasoning
        ? "Think step by step, reason carefully before answering, then give the final answer."
        : undefined;
      const res: any = await this.bridge.prompt(sessionId, text, { agent, model, system });
      const parts = res?.parts ?? [];
      const assistantText = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
      const assistantMsg: ChatMessage = {
        id: `a${Date.now()}`,
        sessionId,
        role: "assistant",
        text: assistantText,
        parts: parts.map((p: any) =>
          p.type === "tool" ? { type: "tool" as const, tool: p.tool, status: "done" as const } : { type: "text" as const, text: p.text ?? "" },
        ),
        createdAt: Date.now(),
      };
      this.post({ type: "message", message: assistantMsg });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    } finally {
      this.streaming = false;
      this.post({ type: "status", status: { state: "idle" } });
      await this.refreshSessions();
    }
  }

  private onEngineEvent(event: any) {
    if (!event) return;
    const data = event.data ?? event;
    switch (data?.type) {
      case "message.part.updated": {
        if (data.properties?.delta && data.properties.part?.type === "text") {
          this.post({ type: "delta", sessionId: data.properties.part.sessionID, text: data.properties.delta });
        }
        break;
      }
      case "session.updated":
      case "session.created":
      case "session.deleted":
        void this.refreshSessions();
        break;
    }
  }

  dispose() {
    ChatPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

function getChatHtml(webview: vscode.Webview): string {
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --border: var(--vscode-panel-border, var(--vscode-input-border));
    --accent: var(--vscode-focusBorder, var(--vscode-button-background));
    --muted: var(--vscode-descriptionForeground);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --bubble-user: var(--vscode-input-background);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; height: 100vh;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
  }
  /* Header */
  #header {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    border-bottom: 1px solid var(--border); background: var(--vscode-sideBar-background, var(--bg));
    flex-wrap: wrap;
  }
  #header select {
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px;
    font-family: inherit; font-size: 12px; max-width: 220px; outline: none;
  }
  #header button {
    background: transparent; color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 8px; cursor: pointer; font-family: inherit; font-size: 12px;
    display: inline-flex; align-items: center; gap: 4px;
  }
  #header button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  #header .spacer { flex: 1; }
  #status { color: var(--muted); font-size: 11px; padding: 0 12px; min-height: 15px; display: flex; align-items: center; gap: 6px; }
  #status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  #status.busy .dot { background: var(--vscode-progressBar-background, #0a84ff); animation: pulse 1s infinite; }
  #status.error .dot { background: var(--vscode-errorForeground, #f14c4c); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  /* Messages */
  #messages {
    flex: 1; overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .row { display: flex; flex-direction: column; max-width: 100%; }
  .row.user { align-items: flex-end; }
  .row.assistant { align-items: flex-start; }
  .role { font-size: 11px; color: var(--muted); margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.04em; }
  .bubble {
    padding: 10px 13px; border-radius: 10px; white-space: pre-wrap; word-wrap: break-word;
    line-height: 1.55; max-width: 760px;
  }
  .row.user .bubble { background: var(--bubble-user); border: 1px solid var(--border); }
  .row.assistant .bubble { background: var(--vscode-editorWidget-background, transparent); border: 1px solid var(--border); }
  .tool { align-self: flex-start; color: var(--muted); font-style: italic; font-size: 12px; padding: 2px 4px; }
  /* Composer */
  #composer {
    display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); align-items: flex-end;
  }
  #input {
    flex: 1; resize: none; min-height: 38px; max-height: 220px;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px;
    font-family: var(--vscode-editor-font-family, inherit); font-size: 13px; outline: none; line-height: 1.4;
  }
  #input:focus { border-color: var(--accent); }
  #send {
    background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 10px;
    padding: 0 16px; height: 38px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 600;
  }
  #send:hover { background: var(--btn-hover); }
  #send:disabled { opacity: 0.5; cursor: default; }
  #stop { display: none; background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--fg); border: none; border-radius: 10px; padding: 0 16px; height: 38px; cursor: pointer; font-family: inherit; font-size: 13px; }
  #header button.toggle.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .msg-actions { display: flex; gap: 6px; margin-top: 4px; opacity: 0; transition: opacity 0.15s; }
  .row:hover .msg-actions { opacity: 1; }
  .msg-action { background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 8px; font-size: 11px; cursor: pointer; font-family: inherit; }
  .msg-action:hover { color: var(--fg); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
</style>
</head>
<body>
<div id="header">
  <select id="sessionSelect" title="${escapeHtml(l10n.t("Select session"))}"></select>
  <button id="newSession" title="${escapeHtml(l10n.t("New Session"))}">+ ${escapeHtml(l10n.t("New"))}</button>
  <select id="modelSelect" title="${escapeHtml(l10n.t("Model"))}"></select>
  <button id="reasonBtn" class="toggle" title="${escapeHtml(l10n.t("Reasoning"))}">${escapeHtml(l10n.t("Reason"))}</button>
  <span class="spacer"></span>
  <button id="refresh" title="${escapeHtml(l10n.t("Refresh"))}">⟳</button>
  <button id="settings" title="${escapeHtml(l10n.t("Settings"))}">${escapeHtml(l10n.t("Settings"))}</button>
</div>
<div id="status"><span class="dot"></span><span id="statusText"></span></div>
<div id="messages"></div>
<div id="composer">
  <textarea id="input" placeholder="${escapeHtml(l10n.t("Ask LLMcode… (Enter to send, Shift+Enter for newline)"))}" rows="1"></textarea>
  <button id="stop">${escapeHtml(l10n.t("Stop"))}</button>
  <button id="send">${escapeHtml(l10n.t("Send"))}</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const sessionSelect = document.getElementById('sessionSelect');
const newBtn = document.getElementById('newSession');
const settingsBtn = document.getElementById('settings');
const refreshBtn = document.getElementById('refresh');
const modelSelect = document.getElementById('modelSelect');
const reasonBtn = document.getElementById('reasonBtn');
let currentSessionId = null, models = [], activeModel = null, busy = false, reasoning = false;

function atBottom() { return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60; }
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function clearMessages() { messagesEl.innerHTML = ''; }

function addRow(role, text) {
  const stick = atBottom();
  const row = document.createElement('div');
  row.className = 'row ' + role;
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.textContent = role === 'user' ? 'You' : 'LLMcode';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text || '';
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = () => { navigator.clipboard.writeText(bubble.textContent || ''); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); };
  actions.appendChild(copyBtn);
  if (role === 'user') {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      inputEl.value = bubble.textContent || '';
      inputEl.focus();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
    };
    actions.appendChild(editBtn);
  }
  row.appendChild(roleEl);
  row.appendChild(bubble);
  row.appendChild(actions);
  messagesEl.appendChild(row);
  if (stick) scrollDown();
  return bubble;
}

function addTool(name) {
  const stick = atBottom();
  const el = document.createElement('div');
  el.className = 'tool';
  el.textContent = '· ' + name;
  messagesEl.appendChild(el);
  if (stick) scrollDown();
}

function lastAssistantBubble() {
  const rows = messagesEl.querySelectorAll('.row.assistant');
  return rows.length ? rows[rows.length - 1].querySelector('.bubble') : null;
}

function setBusy(b) {
  busy = b;
  sendBtn.style.display = b ? 'none' : 'block';
  stopBtn.style.display = b ? 'block' : 'none';
  statusEl.className = b ? 'busy' : '';
  statusText.textContent = b ? 'Working…' : '';
}

function renderModels() {
  modelSelect.innerHTML = '';
  if (!models.length) { const o = document.createElement('option'); o.textContent = '(no models)'; o.value = ''; modelSelect.appendChild(o); return; }
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name || m.id;
    if (m.id === activeModel) o.selected = true;
    modelSelect.appendChild(o);
  }
}

function renderSessions(sessions, activeId) {
  sessionSelect.innerHTML = '';
  if (!sessions.length) {
    const o = document.createElement('option');
    o.textContent = '(no sessions)';
    o.value = '';
    sessionSelect.appendChild(o);
    return;
  }
  for (const s of sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.title || s.id.slice(0, 12);
    if (s.id === activeId) o.selected = true;
    sessionSelect.appendChild(o);
  }
}

function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  if (!currentSessionId) { vscode.postMessage({ type: 'newSession' }); return; }
  addRow('user', text);
  vscode.postMessage({ type: 'send', sessionId: currentSessionId, text, model: activeModel, reasoning });
  inputEl.value = '';
  inputEl.style.height = 'auto';
  setBusy(true);
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
});
sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', () => { if (currentSessionId) vscode.postMessage({ type: 'stop', sessionId: currentSessionId }); });
newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
sessionSelect.addEventListener('change', () => {
  if (sessionSelect.value) { currentSessionId = sessionSelect.value; clearMessages(); vscode.postMessage({ type: 'switchSession', sessionId: sessionSelect.value }); }
});
reasonBtn.addEventListener('click', () => { reasoning = !reasoning; reasonBtn.classList.toggle('active', reasoning); });
modelSelect.addEventListener('change', () => { activeModel = modelSelect.value || null; });

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'sessions':
      currentSessionId = msg.activeId || currentSessionId;
      renderSessions(msg.sessions, currentSessionId);
      break;
    case 'callSessions':
      sessionSelect.value = msg.id;
      break;
    case 'conversation':
      clearMessages();
      for (const m of msg.messages) {
        if (m.role === 'user') addRow('user', m.text);
        else {
          const hasText = (m.parts || []).some(p => p.type === 'text' && p.text);
          if (hasText) addRow('assistant', m.text);
          for (const p of (m.parts || [])) if (p.type === 'tool') addTool(p.tool);
        }
      }
      scrollDown();
      break;
    case 'models':
      models = msg.models || [];
      if (msg.activeModel) activeModel = msg.activeModel;
      if (!activeModel && models.length) activeModel = models[0].id;
      renderModels();
      break;
    case 'message':
      if (msg.message.role === 'assistant') {
        addRow('assistant', msg.message.text);
        setBusy(false);
      }
      break;
    case 'delta': {
      const b = lastAssistantBubble();
      if (b) { b.textContent += msg.text; if (atBottom()) scrollDown(); }
      break;
    }
    case 'status':
      if (msg.status.state === 'idle') setBusy(false);
      else if (msg.status.state === 'connecting') { statusEl.className = 'busy'; statusText.textContent = 'Connecting to opencode…'; }
      break;
    case 'error':
      statusEl.className = 'error';
      statusText.textContent = msg.message;
      setBusy(false);
      break;
  }
});

renderSessions([], null);
vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
}
