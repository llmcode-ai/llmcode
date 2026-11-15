import * as vscode from "vscode";
import { OpencodeBridge } from "./opencode";
import { ChatViewProvider } from "./chat";
import { AutocompleteProvider, inlineEditSelection, selectionCommand } from "./assistant";
import {
  SessionsTreeProvider,
  providersTree,
  agentsTree,
  skillsTree,
  mcpTree,
  pluginsTree,
} from "./trees";
import { importFromMachine } from "./import";

let bridge: OpencodeBridge;

export async function activate(context: vscode.ExtensionContext) {
  bridge = new OpencodeBridge();

  // Chat view (Mode A)
  const chatProvider = new ChatViewProvider(bridge);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Tree views
  const sessionsTree = new SessionsTreeProvider(bridge);
  const providers = providersTree(bridge);
  const agents = agentsTree(bridge);
  const skills = skillsTree(bridge);
  const mcp = mcpTree(bridge);
  const plugins = pluginsTree(bridge);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("llmcode.sessions", sessionsTree),
    vscode.window.registerTreeDataProvider("llmcode.providers", providers),
    vscode.window.registerTreeDataProvider("llmcode.agents", agents),
    vscode.window.registerTreeDataProvider("llmcode.skills", skills),
    vscode.window.registerTreeDataProvider("llmcode.mcp", mcp),
    vscode.window.registerTreeDataProvider("llmcode.plugins", plugins),
  );

  // Mode B: autocomplete + inline edit
  const autocomplete = new AutocompleteProvider(bridge);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider([{ pattern: "**" }], autocomplete),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("llmcode.open", () => openChat()),
    vscode.commands.registerCommand("llmcode.newSession", () => bridge.createSession().then(() => refreshAll(sessionsTree, providers, agents, skills, mcp, plugins))),
    vscode.commands.registerCommand("llmcode.deleteSession", async (node) => {
      const id = node?.sessionId ?? (await pickSession());
      if (id) {
        await bridge.deleteSession(id);
        refreshAll(sessionsTree, providers, agents, skills, mcp, plugins);
      }
    }),
    vscode.commands.registerCommand("llmcode.importFromMachine", () => runImport(context)),
    vscode.commands.registerCommand("llmcode.checkInstall", () => checkInstall()),
    vscode.commands.registerCommand("llmcode.installOpencode", () => installOpencode()),
    vscode.commands.registerCommand("llmcode.openTerminal", () => openTerminal()),
    vscode.commands.registerCommand("llmcode.toggleAutocomplete", () => toggleAutocomplete()),
    vscode.commands.registerCommand("llmcode.inlineEdit", () => inlineEditSelection(bridge)),
    vscode.commands.registerCommand("llmcode.explainSelection", () => selectionCommand(bridge, "explain")),
    vscode.commands.registerCommand("llmcode.fixSelection", () => selectionCommand(bridge, "fix")),
    vscode.commands.registerCommand("llmcode.refactorSelection", () => selectionCommand(bridge, "refactor")),
    vscode.commands.registerCommand("llmcode.addFileToChat", () => openChat()),
  );

  // Start the engine and ensure opencode is present.
  await ensureOpencode();
}

async function ensureOpencode() {
  const cli = await OpencodeBridge.detectCli();
  if (cli) {
    await bridge.start();
  } else {
    const action = await vscode.window.showWarningMessage(
      "opencode is not installed. It is required for LLMcode. Install it now?",
      "Install",
      "Skip",
    );
    if (action === "Install") {
      await installOpencode();
    }
  }
}

async function installOpencode() {
  const terminal = vscode.window.createTerminal({ name: "opencode", env: { OPENCODE_CALLER: "vscode" } });
  terminal.show();
  if (process.platform === "win32") {
    terminal.sendText('powershell -c "irm https://opencode.ai/install.ps1 | iex"');
  } else {
    terminal.sendText("curl -fsSL https://opencode.ai/install | bash");
  }
  vscode.window.showInformationMessage("opencode install started in the terminal. Reload the window when it finishes.");
}

async function checkInstall() {
  const cli = await OpencodeBridge.detectCli();
  if (cli) {
    vscode.window.showInformationMessage(`opencode found at: ${cli}`);
  } else {
    const action = await vscode.window.showWarningMessage("opencode not found.", "Install");
    if (action === "Install") await installOpencode();
  }
}

function openTerminal() {
  const name = "opencode";
  const existing = vscode.window.terminals.find((t) => t.name === name);
  if (existing) {
    existing.show();
    return;
  }
  const terminal = vscode.window.createTerminal({ name, location: vscode.TerminalLocation.Panel, env: { OPENCODE_CALLER: "vscode" } });
  terminal.show();
  terminal.sendText("opencode");
}

function toggleAutocomplete() {
  const cfg = vscode.workspace.getConfiguration("llmcode.autocomplete");
  const next = !cfg.get<boolean>("enabled", true);
  cfg.update("enabled", next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Autocomplete ${next ? "enabled" : "disabled"}`);
}

async function pickSession(): Promise<string | undefined> {
  const sessions = await bridge.listSessions();
  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({ label: s.title || s.id, id: s.id })),
    { placeHolder: "Select a session" },
  );
  return picked?.id;
}

function openChat() {
  vscode.commands.executeCommand("llmcode.chat.focus");
}

function refreshAll(...trees: Array<{ refresh(): void }>) {
  for (const t of trees) t.refresh();
}

async function runImport(context: vscode.ExtensionContext) {
  const report = await importFromMachine(context);
  const summary = [
    `Skills: ${report.skills.imported}/${report.skills.total} imported`,
    `MCP: ${report.mcp.imported}/${report.mcp.total} imported`,
    `Plugins: ${report.plugins.imported}/${report.plugins.total} imported`,
  ].join("\n");
  if (report.errors.length) {
    await vscode.window.showWarningMessage(`${summary}\n\n${report.errors.length} error(s): ${report.errors.slice(0, 3).join("; ")}`);
  } else {
    vscode.window.showInformationMessage(`Import complete.\n${summary}`);
  }
}

export function deactivate() {
  bridge?.dispose();
}
