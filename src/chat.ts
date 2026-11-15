import * as vscode from "vscode";
import type { OpencodeBridge } from "./opencode";
import type { ChatMessage, HostToWebview, WebviewToHost } from "./types";

// Mode A: chat sidebar. A webview renders the conversation; the extension host
// proxies it to the opencode engine and streams events back.

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "llmcode.chat";
  private view: vscode.WebviewView | undefined;
  private pending: ChatMessage[] = [];
  private streaming = false;

  constructor(private readonly bridge: OpencodeBridge) {
    bridge.on("event", (event: any) => this.onEngineEvent(event));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getChatHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private post(msg: HostToWebview) {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: WebviewToHost) {
    switch (msg.type) {
      case "init":
        await this.refreshAll();
        break;
      case "send":
        await this.send(msg.sessionId, msg.text, msg.agent, msg.model);
        break;
      case "newSession":
        await this.newSession();
        break;
      case "switchSession":
        await this.loadSession(msg.sessionId);
        break;
      case "deleteSession":
        await this.bridge.deleteSession(msg.sessionId);
        await this.refreshSessions();
        break;
      case "forkSession":
        await this.bridge.forkSession(msg.sessionId);
        await this.refreshSessions();
        break;
      case "compactSession":
        // v1 has no explicit compact; no-op for now.
        break;
      case "stop":
        if (msg.sessionId) await this.bridge.abort(msg.sessionId);
        break;
      case "import":
        await vscode.commands.executeCommand("llmcode.importFromMachine");
        break;
      case "refresh":
        await this.refreshAll();
        break;
    }
  }

  private async refreshAll() {
    await this.refreshSessions();
    await this.refreshProviders();
    await this.refreshAgents();
    await this.refreshSkills();
    await this.refreshMcp();
    await this.refreshConfig();
  }

  private async refreshSessions() {
    try {
      const sessions = await this.bridge.listSessions();
      this.post({ type: "sessions", sessions });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }
  private async refreshProviders() {
    try {
      this.post({ type: "providers", providers: await this.bridge.listProviders() });
      this.post({ type: "models", models: await this.bridge.listModels() });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }
  private async refreshAgents() {
    try {
      this.post({ type: "agents", agents: await this.bridge.listAgents() });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }
  private async refreshSkills() {
    try {
      this.post({ type: "skills", skills: await this.bridge.listSkills() });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }
  private async refreshMcp() {
    try {
      this.post({ type: "mcp", servers: await this.bridge.listMcp() });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }
  private async refreshConfig() {
    try {
      this.post({ type: "config", config: await this.bridge.getConfig() });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }

  private async newSession() {
    try {
      const s = await this.bridge.createSession();
      await this.refreshSessions();
      this.post({ type: "message", message: systemMessage(s.id, "New session created") });
      await this.loadSession(s.id);
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }

  private async loadSession(sessionId: string) {
    try {
      const messages = await this.bridge.listMessages(sessionId);
      const converted: ChatMessage[] = (messages as any[]).map((m, i) => ({
        id: String((m.info as any)?.id ?? i),
        sessionId,
        role: ((m.info as any)?.role ?? "assistant") as "user" | "assistant",
        text: (m.parts ?? [])
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(""),
        parts: (m.parts ?? []).map((p: any) =>
          p.type === "tool" ? { type: "tool" as const, tool: p.tool, status: "done" as const } : { type: "text" as const, text: p.text ?? "" },
        ),
        createdAt: (m.info as any)?.time?.created ?? Date.now(),
      }));
      this.pending = converted;
      this.view?.webview.postMessage({ type: "init" });
    } catch (err) {
      this.post({ type: "error", message: String((err as Error).message) });
    }
  }

  private async send(sessionId: string, text: string, agent?: string, model?: string) {
    if (this.streaming) {
      await this.bridge.abort(sessionId);
    }
    this.streaming = true;
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
      const res: any = await this.bridge.prompt(sessionId, text, { agent, model });
      const parts = res?.parts ?? [];
      const assistantText = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("");
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
        void this.refreshSessions();
        break;
      case "session.created":
      case "session.deleted":
        void this.refreshSessions();
        break;
    }
  }
}

function systemMessage(sessionId: string, text: string): ChatMessage {
  return {
    id: `s${Date.now()}`,
    sessionId,
    role: "assistant",
    text,
    parts: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}

function getChatHtml(webview: vscode.Webview): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLMcode</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --border: var(--vscode-input-border, var(--vscode-panel-border));
    --accent: var(--vscode-focusBorder, var(--vscode-button-background));
    --muted: var(--vscode-descriptionForeground);
    --bubble-user: var(--vscode-button-background);
    --bubble-user-fg: var(--vscode-button-foreground);
    --bubble-asst: var(--vscode-editor-background);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
  }
  #messages {
    flex: 1; overflow-y: auto; padding: 8px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .msg { max-width: 90%; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: var(--bubble-user); color: var(--bubble-user-fg); }
  .msg.assistant { align-self: flex-start; background: var(--bubble-asst); border: 1px solid var(--border); }
  .msg.tool { align-self: flex-start; color: var(--muted); font-style: italic; }
  #composer {
    display: flex; align-items: flex-end; gap: 6px; padding: 8px;
    border-top: 1px solid var(--border);
  }
  textarea {
    flex: 1; resize: none; min-height: 28px; max-height: 200px;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
    font-family: inherit; font-size: inherit; outline: none;
  }
  textarea:focus { border-color: var(--accent); }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer;
    font-family: inherit; font-size: inherit;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { padding: 2px 8px; color: var(--muted); font-size: 11px; min-height: 16px; }
</style>
</head>
<body>
<div id="messages"></div>
<div id="status"></div>
<div id="composer">
  <textarea id="input" placeholder="Ask LLMcode… (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
  <button id="send" title="Send">Send</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
let currentSessionId = null;
let currentStatus = 'idle';

function addMessage(msg) {
  const div = document.createElement('div');
  if (msg.role === 'user') div.className = 'msg user';
  else div.className = 'msg assistant';
  div.textContent = msg.text || msg.parts?.filter(p => p.type === 'text').map(p => p.text).join('') || '';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addDelta(delta) {
  const last = messagesEl.lastElementChild;
  if (last && last.classList.contains('assistant')) {
    last.textContent += delta;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (!currentSessionId) {
    vscode.postMessage({ type: 'newSession' });
    return;
  }
  vscode.postMessage({ type: 'send', sessionId: currentSessionId, text });
  addMessage({ role: 'user', text });
  inputEl.value = '';
  inputEl.style.height = 'auto';
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
});
sendBtn.addEventListener('click', send);

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      // initial state; engine will refresh sessions next
      break;
    case 'sessions':
      if (!currentSessionId && msg.sessions && msg.sessions.length) {
        currentSessionId = msg.sessions[0].id;
      }
      break;
    case 'message':
      addMessage(msg.message);
      break;
    case 'delta':
      addDelta(msg.text);
      break;
    case 'status':
      currentStatus = msg.status.state;
      statusEl.textContent = currentStatus === 'idle' ? '' : (msg.status.label || currentStatus);
      sendBtn.disabled = false;
      break;
    case 'error':
      statusEl.textContent = '⚠ ' + msg.message;
      break;
  }
});

vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
}
