import * as vscode from "vscode";
import { l10n } from "vscode";
import { OpencodeBridge } from "./opencode";
import { SettingsPanel } from "./settings";
import { AutocompleteProvider, inlineEditSelection, selectionCommand } from "./assistant";
import { importFromMachine } from "./import";
import { registerChatProvider } from "./lmProvider";
import { registerChatParticipant } from "./chatParticipant";

let bridge: OpencodeBridge;

export async function activate(context: vscode.ExtensionContext) {
  bridge = new OpencodeBridge();

  // Register opencode as a native language-model provider so VS Code's own chat
  // (Copilot Chat UI, inline chat, terminal chat) can use opencode models.
  const chatProvider = registerChatProvider(bridge, context);

  // A stable @llmcode participant so LLMcode also appears as an agent in chat.
  registerChatParticipant(bridge, context);

  // Mode B: autocomplete + inline edit
  const autocomplete = new AutocompleteProvider(bridge);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider([{ pattern: "**" }], autocomplete),
  );

  const openSettings = () => SettingsPanel.createOrShow(context.extensionUri, bridge);
  // Open VS Code's native chat (where LLMcode models are selectable).
  const openNativeChat = async () => {
    await vscode.commands.executeCommand("workbench.action.chat.open");
  };

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("llmcode.open", () => openNativeChat()),
    vscode.commands.registerCommand("llmcode.openSettings", () => openSettings()),
    vscode.commands.registerCommand("llmcode.selectChatModel", () => selectChatModel()),
    vscode.commands.registerCommand("llmcode.newSession", () => openNativeChat()),
    vscode.commands.registerCommand("llmcode.importFromMachine", () => runImport(context)),
    vscode.commands.registerCommand("llmcode.checkInstall", () => checkInstall()),
    vscode.commands.registerCommand("llmcode.installOpencode", () => installOpencode()),
    vscode.commands.registerCommand("llmcode.openTerminal", () => openTerminal()),
    vscode.commands.registerCommand("llmcode.toggleAutocomplete", () => toggleAutocomplete()),
    vscode.commands.registerCommand("llmcode.inlineEdit", () => inlineEditSelection(bridge)),
    vscode.commands.registerCommand("llmcode.explainSelection", () => selectionCommand(bridge, "explain")),
    vscode.commands.registerCommand("llmcode.fixSelection", () => selectionCommand(bridge, "fix")),
    vscode.commands.registerCommand("llmcode.refactorSelection", () => selectionCommand(bridge, "refactor")),
    vscode.commands.registerCommand("llmcode.addFileToChat", () => openNativeChat()),
  );

  // Start the engine and ensure opencode is present. Do NOT block activation —
  // the engine boots in the background and the chat surface updates when ready.
  bridge.on("status", () => chatProvider.refresh());
  void ensureOpencode();

  return bridge;
}


async function selectChatModel() {
  // Open VS Code's native chat model picker so the user can select an LLMcode
  // model right where they chat. The provider is registered on startup.
  const models = await vscode.lm.selectChatModels({ vendor: "llmcode" } as any);
  if (!models.length) {
    vscode.window.showWarningMessage(
      l10n.t("No LLMcode models available yet. Make sure the opencode engine is running (LLMcode: Check opencode Installation)."),
    );
    return;
  }
  // Focus the chat and open its model picker.
  await vscode.commands.executeCommand("workbench.action.chat.open");
  await vscode.commands.executeCommand("workbench.action.chat.changeModel");
  vscode.window.showInformationMessage(
    l10n.t("In the model picker, choose a model under \"LLMcode (opencode)\"."),
  );
}

async function ensureOpencode() {
  const cli = await OpencodeBridge.detectCli();
  if (!cli) {
    const install = l10n.t("Install");
    const action = await vscode.window.showWarningMessage(
      l10n.t("opencode is not installed. It is required for LLMcode. Install it now?"),
      install,
      l10n.t("Skip"),
    );
    if (action === install) {
      await installOpencode();
    }
    return;
  }
  try {
    await bridge.start();
  } catch (err) {
    vscode.window.showErrorMessage(l10n.t("LLMcode: failed to start opencode engine: {0}", (err as Error).message));
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
  vscode.window.showInformationMessage(l10n.t("opencode install started in the terminal. Reload the window when it finishes."));
}

async function checkInstall() {
  const cli = await OpencodeBridge.detectCli();
  if (cli) {
    vscode.window.showInformationMessage(l10n.t("opencode found at: {0}", cli));
  } else {
    const install = l10n.t("Install");
    const action = await vscode.window.showWarningMessage(l10n.t("opencode not found."), install);
    if (action === install) await installOpencode();
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
  vscode.window.showInformationMessage(next ? l10n.t("Autocomplete enabled") : l10n.t("Autocomplete disabled"));
}

async function runImport(context: vscode.ExtensionContext) {
  const report = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: l10n.t("Importing from machine…"), cancellable: false },
    () => importFromMachine(context),
  );
  const summary = [
    l10n.t("Skills: {0} added, {1} already present", String(report.skills.imported), String(report.skills.skipped)),
    l10n.t("MCP: {0} added, {1} already present", String(report.mcp.imported), String(report.mcp.skipped)),
    l10n.t("Plugins: {0} added, {1} already present", String(report.plugins.imported), String(report.plugins.skipped)),
  ].join("\n");
  if (report.errors.length) {
    await vscode.window.showWarningMessage(
      `${summary}\n\n${l10n.t("{0} error(s): {1}", String(report.errors.length), report.errors.slice(0, 3).join("; "))}`,
    );
  } else {
    vscode.window.showInformationMessage(l10n.t("Import complete.\n{0}", summary));
  }
}

export function deactivate() {
  bridge?.dispose();
}
