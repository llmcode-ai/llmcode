import * as vscode from "vscode";
import { l10n } from "vscode";

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A small, clean sidebar launcher. The chat and settings open as editor panels
// on the right, so the sidebar stays uncluttered.

export class WelcomeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "llmcode.welcome";
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: any) => {
      if (msg?.type === "open") vscode.commands.executeCommand("llmcode.open");
      else if (msg?.type === "settings") vscode.commands.executeCommand("llmcode.openSettings");
      else if (msg?.type === "import") vscode.commands.executeCommand("llmcode.importFromMachine");
    });
  }

  private html(): string {
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, var(--vscode-input-border));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
  }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--fg); padding: 12px; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 16px; font-size: 12px; line-height: 1.5; }
  button {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 10px 12px; margin-bottom: 8px; cursor: pointer;
    border-radius: 6px; font-family: inherit; font-size: 13px; border: none;
  }
  button.primary { background: var(--btn-bg); color: var(--btn-fg); font-weight: 600; }
  button.primary:hover { background: var(--btn-hover); }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  button.secondary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .sep { height: 1px; background: var(--border); margin: 14px 0; }
</style>
</head>
<body>
  <h2>LLMcode</h2>
  <p class="sub">${escapeHtml(l10n.t("opencode-powered chat and code assistant."))}</p>
  <button class="primary" id="open">${escapeHtml(l10n.t("Open Chat"))}</button>
  <button class="secondary" id="settings">${escapeHtml(l10n.t("Settings"))}</button>
  <div class="sep"></div>
  <button class="secondary" id="import">${escapeHtml(l10n.t("Import from machine"))}</button>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('open').onclick = () => vscode.postMessage({ type: 'open' });
    document.getElementById('settings').onclick = () => vscode.postMessage({ type: 'settings' });
    document.getElementById('import').onclick = () => vscode.postMessage({ type: 'import' });
  </script>
</body>
</html>`;
  }
}
