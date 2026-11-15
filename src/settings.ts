import * as vscode from "vscode";
import { l10n } from "vscode";
import type { OpencodeBridge } from "./opencode";
import type { HostToWebview } from "./types";

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A dedicated settings editor panel with tabs for Providers/Models, Agents,
// Skills, MCP servers, Plugins and general settings. Everything the engine
// exposes is manageable from here.

type Tab = "general" | "providers" | "agents" | "skills" | "mcp" | "plugins";

const S = {
  general: l10n.t("General"),
  providers: l10n.t("Providers & Models"),
  agents: l10n.t("Agents"),
  skills: l10n.t("Skills"),
  mcp: l10n.t("MCP Servers"),
  plugins: l10n.t("Plugins"),
  import: l10n.t("Import from machine"),
  refresh: l10n.t("Refresh"),
  empty: l10n.t("Nothing here yet."),
  enable: l10n.t("Enable"),
  disable: l10n.t("Disable"),
  connect: l10n.t("Connect"),
  disconnect: l10n.t("Disconnect"),
  autocomplete: l10n.t("Enable tab autocomplete"),
  autocompleteModel: l10n.t("Autocomplete model"),
  chatModel: l10n.t("Default chat model"),
  saved: l10n.t("Saved"),
};

export class SettingsPanel {
  public static current: SettingsPanel | undefined;
  private static readonly viewType = "llmcode.settings";
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private data: any = {};

  static createOrShow(extensionUri: vscode.Uri, bridge: OpencodeBridge) {
    const column = vscode.ViewColumn.Active;
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal(column);
      void SettingsPanel.current.reload();
      return SettingsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      l10n.t("LLMcode Settings"),
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SettingsPanel.current = new SettingsPanel(panel, bridge);
    return SettingsPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, private readonly bridge: OpencodeBridge) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    void this.reload();
  }

  private post(msg: any) {
    this.panel.webview.postMessage(msg);
  }

  async reload() {
    this.post({ type: "loading" });
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch {
        return fallback;
      }
    };
    const [providers, models, agents, skills, mcp, plugins, config] = await Promise.all([
      safe(() => this.bridge.listProviders(), []),
      safe(() => this.bridge.listModels(), []),
      safe(() => this.bridge.listAgents(), []),
      safe(() => this.bridge.listSkills(), []),
      safe(() => this.bridge.listMcp(), []),
      safe(() => this.bridge.listPlugins(), []),
      safe(() => this.bridge.getConfig(), {} as any),
    ]);
    const cfg = vscode.workspace.getConfiguration("llmcode");
    this.data = { providers, models, agents, skills, mcp, plugins, config };
    this.post({
      type: "data",
      data: this.data,
      settings: {
        autocompleteEnabled: cfg.get<boolean>("autocomplete.enabled", true),
        autocompleteModel: cfg.get<string>("autocomplete.model", ""),
        chatModel: (config as any)?.model ?? "",
      },
    });
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case "ready":
      case "refresh":
        await this.reload();
        break;
      case "import":
        await vscode.commands.executeCommand("llmcode.importFromMachine");
        await this.reload();
        break;
      case "mcpConnect":
        await this.bridge.connectMcp(m.name);
        await this.reload();
        break;
      case "mcpDisconnect":
        await this.bridge.disconnectMcp(m.name);
        await this.reload();
        break;
      case "setSetting": {
        const cfg = vscode.workspace.getConfiguration("llmcode");
        await cfg.update(m.key, m.value, vscode.ConfigurationTarget.Global);
        this.post({ type: "saved" });
        break;
      }
    }
  }

  private html(): string {
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: var(--vscode-editor-background); --fg: var(--vscode-foreground);
    --border: var(--vscode-panel-border, var(--vscode-input-border));
    --input-bg: var(--vscode-input-background); --input-fg: var(--vscode-input-foreground);
    --muted: var(--vscode-descriptionForeground);
    --accent: var(--vscode-focusBorder, var(--vscode-button-background));
    --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground);
    --badge: var(--vscode-badge-background); --badge-fg: var(--vscode-badge-foreground);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; height: 100vh; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
  nav { width: 220px; border-right: 1px solid var(--border); padding: 8px; display: flex; flex-direction: column; gap: 2px; }
  nav button {
    text-align: left; background: transparent; color: var(--fg); border: none; padding: 8px 10px;
    border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px;
  }
  nav button:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
  nav button.active { background: var(--vscode-list-activeSelectionBackground, rgba(120,120,255,0.2)); color: var(--vscode-list-activeSelectionForeground, var(--fg)); }
  main { flex: 1; overflow-y: auto; padding: 20px 24px; }
  h2 { margin: 0 0 16px; font-size: 18px; font-weight: 600; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .row { display: flex; align-items: center; gap: 10px; }
  .row .grow { flex: 1; }
  .name { font-weight: 600; }
  .desc { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--badge); color: var(--badge-fg); }
  .badge.ok { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
  .badge.err { background: var(--vscode-errorForeground, #f14c4c); color: #fff; }
  .badge.off { opacity: 0.7; }
  button.action {
    background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 6px;
    padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: 12px;
  }
  button.action.ghost { background: transparent; border: 1px solid var(--border); color: var(--fg); }
  button.action:hover { opacity: 0.9; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; max-width: 520px; }
  .field label { font-weight: 600; }
  input[type=text], select {
    background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 7px 10px; font-family: inherit; font-size: 13px; outline: none;
  }
  input[type=text]:focus, select:focus { border-color: var(--accent); }
  .empty { color: var(--muted); font-style: italic; padding: 8px 0; }
  .muted { color: var(--muted); }
  #saved { color: var(--vscode-testing-iconPassed, #2ea043); font-size: 12px; margin-left: 8px; opacity: 0; transition: opacity 0.2s; }
  #saved.show { opacity: 1; }
</style>
</head>
<body>
<nav id="nav"></nav>
<main id="main"><div class="empty">Loading…</div></main>
<script>
const vscode = acquireVsCodeApi();
const S = ${JSON.stringify(S)};
const nav = document.getElementById('nav');
const main = document.getElementById('main');
let data = {}, settings = {}, active = 'general';
const TABS = [['general', S.general], ['providers', S.providers], ['agents', S.agents], ['skills', S.skills], ['mcp', S.mcp], ['plugins', S.plugins]];

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderNav(){
  nav.innerHTML = '';
  for (const [id, label] of TABS) {
    const b = document.createElement('button');
    b.textContent = label;
    if (id === active) b.className = 'active';
    b.onclick = () => { active = id; renderNav(); render(); };
    nav.appendChild(b);
  }
}

function toolbar(){
  return '<div class="toolbar"><button class="action" id="importBtn">' + esc(S.import) + '</button>' +
         '<button class="action ghost" id="refreshBtn">' + esc(S.refresh) + '</button><span id="saved">' + esc(S.saved) + '</span></div>';
}

function card(name, desc, right){ return '<div class="card"><div class="row"><div class="grow"><div class="name">' + esc(name) + '</div>' + (desc ? '<div class="desc">' + esc(desc) + '</div>' : '') + '</div>' + right + '</div></div>'; }

function render(){
  let html = toolbar();
  if (active === 'general') {
    html += '<h2>' + esc(S.general) + '</h2>';
    html += '<div class="field"><label>' + esc(S.autocomplete) + '</label><select id="acEnabled"><option value="true"' + (settings.autocompleteEnabled ? ' selected' : '') + '>On</option><option value="false"' + (!settings.autocompleteEnabled ? ' selected' : '') + '>Off</option></select></div>';
    html += '<div class="field"><label>' + esc(S.autocompleteModel) + '</label><input id="acModel" type="text" value="' + esc(settings.autocompleteModel) + '" placeholder="provider/model"></div>';
    html += '<div class="field"><label>' + esc(S.chatModel) + '</label><select id="chatModel">' + modelOptions(settings.chatModel) + '</select></div>';
    main.innerHTML = html;
    document.getElementById('acEnabled').onchange = (e) => send('setSetting', { key: 'autocomplete.enabled', value: e.target.value === 'true' });
    document.getElementById('acModel').onchange = (e) => send('setSetting', { key: 'autocomplete.model', value: e.target.value });
    document.getElementById('chatModel').onchange = (e) => send('setSetting', { key: 'chatModel', value: e.target.value });
  } else if (active === 'providers') {
    html += '<h2>' + esc(S.providers) + '</h2>';
    const models = data.models || [];
    if (!models.length) html += '<div class="empty">' + esc(S.empty) + '</div>';
    for (const m of models) html += card(m.name || m.id, m.providerID, '<span class="badge">' + esc(m.id) + '</span>');
    main.innerHTML = html;
  } else if (active === 'agents') {
    html += '<h2>' + esc(S.agents) + '</h2>';
    const agents = data.agents || [];
    if (!agents.length) html += '<div class="empty">' + esc(S.empty) + '</div>';
    for (const a of agents) html += card(a.name, a.description || '', '<span class="badge">' + esc(a.mode) + '</span>');
    main.innerHTML = html;
  } else if (active === 'skills') {
    html += '<h2>' + esc(S.skills) + '</h2>';
    const skills = data.skills || [];
    if (!skills.length) html += '<div class="empty">' + esc(S.empty) + '</div>';
    for (const s of skills) html += card(s.name, s.description || '', '');
    main.innerHTML = html;
  } else if (active === 'mcp') {
    html += '<h2>' + esc(S.mcp) + '</h2>';
    const mcp = data.mcp || [];
    if (!mcp.length) html += '<div class="empty">' + esc(S.empty) + '</div>';
    for (const s of mcp) {
      const cls = s.status === 'connected' ? 'ok' : (s.status === 'disabled' ? 'off' : '');
      const btn = s.status === 'connected'
        ? '<button class="action ghost" data-disc="' + esc(s.id) + '">' + esc(S.disconnect) + '</button>'
        : '<button class="action" data-conn="' + esc(s.id) + '">' + esc(S.connect) + '</button>';
      html += card(s.id, '', '<span class="badge ' + cls + '">' + esc(s.status || s.type) + '</span>' + btn);
    }
    main.innerHTML = html;
    main.querySelectorAll('[data-conn]').forEach(b => b.onclick = () => send('mcpConnect', { name: b.getAttribute('data-conn') }));
    main.querySelectorAll('[data-disc]').forEach(b => b.onclick = () => send('mcpDisconnect', { name: b.getAttribute('data-disc') }));
  } else if (active === 'plugins') {
    html += '<h2>' + esc(S.plugins) + '</h2>';
    const plugins = data.plugins || [];
    if (!plugins.length) html += '<div class="empty">' + esc(S.empty) + '</div>';
    for (const p of plugins) html += card(p.id || p.file || 'plugin', p.file || '', '');
    main.innerHTML = html;
  }
  const imp = document.getElementById('importBtn'); if (imp) imp.onclick = () => send('import');
  const ref = document.getElementById('refreshBtn'); if (ref) ref.onclick = () => send('refresh');
}

function modelOptions(activeId){
  const models = data.models || [];
  let out = '';
  for (const m of models) out += '<option value="' + esc(m.id) + '"' + (m.id === activeId ? ' selected' : '') + '>' + esc(m.name || m.id) + '</option>';
  if (!out) out = '<option value="">(no models)</option>';
  return out;
}

function send(type, extra){ vscode.postMessage(Object.assign({ type }, extra || {})); }

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'data') { data = msg.data; settings = msg.settings; render(); }
  if (msg.type === 'saved') { const s = document.getElementById('saved'); if (s) { s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 1200); } }
});

renderNav();
send('ready');
</script>
</body>
</html>`;
  }

  dispose() {
    SettingsPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
