import * as vscode from "vscode";
import { l10n } from "vscode";
import { OpencodeBridge } from "./opencode";
import { SettingsPanel } from "./settings";
import { AutocompleteProvider, inlineEditSelection, selectionCommand, initAssistantUi, pickModel } from "./assistant";
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
  initAssistantUi(context);
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
    vscode.commands.registerCommand("llmcode.useLocalAgent", () => useLocalAgentByDefault()),
    vscode.commands.registerCommand("llmcode.pickModel", () => pickModel(bridge)),
    vscode.commands.registerCommand("llmcode.showLastModel", () => {
      vscode.commands.executeCommand("workbench.action.output.toggleOutput");
    }),
    vscode.commands.registerCommand("llmcode.newSession", () => openNativeChat()),
    vscode.commands.registerCommand("llmcode.importFromMachine", () => runImport(context)),
    vscode.commands.registerCommand("llmcode.checkInstall", () => checkInstall()),
    vscode.commands.registerCommand("llmcode.installOpencode", () => installOpencode()),
    vscode.commands.registerCommand("llmcode.openTerminal", () => openTerminal()),
    vscode.commands.registerCommand("llmcode.toggleAutocomplete", () => toggleAutocomplete()),
    vscode.commands.registerCommand("llmcode.takeoverInline", () => takeoverInlineSuggestions()),
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

  // Apply the recommended configuration once, automatically, on first install.
  void applyDefaultSettings(context);

  return bridge;
}

const SETTINGS_APPLIED_KEY = "llmcode.settingsApplied.v1";

/**
 * Apply the settings that make LLMcode work out of the box, once per install.
 * These are the switches that route VS Code's chat and inline suggestions
 * through opencode and stop Copilot from consuming credits.
 */
async function applyDefaultSettings(context: vscode.ExtensionContext) {
  if (context.globalState.get<boolean>(SETTINGS_APPLIED_KEY)) return;
  const g = vscode.ConfigurationTarget.Global;
  const chat = vscode.workspace.getConfiguration("chat");
  const copilot = vscode.workspace.getConfiguration("github.copilot");
  const editor = vscode.workspace.getConfiguration("editor");
  const llm = vscode.workspace.getConfiguration("llmcode");
  // Apply each setting independently so one unavailable section (e.g. Copilot
  // not installed) never blocks the rest.
  const set = async (section: vscode.WorkspaceConfiguration, key: string, value: unknown) => {
    try {
      await section.update(key, value, g);
    } catch (err) {
      console.warn(`[llmcode] could not set ${key}:`, err);
    }
  };
  // Turn off Copilot's inline suggestions so typing doesn't spend credits.
  await set(copilot, "enable", { "*": false });
  await set(copilot, "inlineEditsEnabled", false);
  await set(copilot, "nextEditSuggestions.enabled", false);
  // Ensure ghost text is enabled (LLMcode provides it).
  await set(editor, "inlineSuggest.enabled", true);
  await set(editor, "inlineSuggest.showToolbar", "always");
  // Default the Agents window to Local (not Copilot) and include BYOK models.
  await set(chat, "defaultToCopilotHarness", false);
  await set(chat, "editor.preferCopilotHarness", false);
  await set(chat, "editor.localAgent.enabled", true);
  await set(chat, "agentHost.byokModels.enabled", true);
  await set(chat, "copilot.modelRouter.enabled", false);
  // LLMcode autocomplete on by default.
  await set(llm, "autocomplete.enabled", true);
  await context.globalState.update(SETTINGS_APPLIED_KEY, true);
}


async function useLocalAgentByDefault() {
  // Make VS Code's Agents window default to the Local harness (not Copilot).
  const chat = vscode.workspace.getConfiguration("chat");
  await chat.update("defaultToCopilotHarness", false, vscode.ConfigurationTarget.Global);
  await chat.update("editor.preferCopilotHarness", false, vscode.ConfigurationTarget.Global);
  await chat.update("editor.localAgent.enabled", true, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    l10n.t("The Agents window now defaults to Local. Pick an LLMcode (opencode) model in the model picker."),
  );
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
    await autoPickFastModel();
  } catch (err) {
    vscode.window.showErrorMessage(l10n.t("LLMcode: failed to start opencode engine: {0}", (err as Error).message));
  }
}

/** If no autocomplete model is configured, pick a fast one automatically. */
async function autoPickFastModel() {
  const cfg = vscode.workspace.getConfiguration("llmcode.autocomplete");
  if ((cfg.get<string>("model", "") || "").trim()) return;
  try {
    const models = await bridge.listModels();
    if (!models.length) return;
    // Prefer a model whose name hints at being fast/cheap for autocomplete, but
    // work with whatever is available (any provider/model).
    // Prefer models that tend to be fast for completion (flash/mini/sonnet/haiku…).
    const looksFast = (id: string, name?: string) => /(flash|mini|small|fast|haiku|luna|instant|turbo|lite|nano|sonnet)/i.test(`${id} ${name ?? ""}`);
    const pick = (models.find((m) => looksFast(m.id, m.name)) ?? models[0]).id;
    await cfg.update("model", pick, vscode.ConfigurationTarget.Global);
  } catch {
    // best-effort
  }
}

async function installOpencode() {
  // On Windows, opencode may already exist inside WSL. Prefer that over
  // installing a separate Windows copy.
  if (process.platform === "win32") {
    const wslHas = await OpencodeBridge.detectWsl();
    const installedOnWindows = !!(await OpencodeBridge.detectCli());
    if (wslHas && !installedOnWindows) {
      const useWsl = l10n.t("Use WSL opencode");
      const installWindows = l10n.t("Install on Windows");
      const choice = await vscode.window.showInformationMessage(
        l10n.t("opencode is available inside WSL. Use that instead of installing on Windows?"),
        useWsl,
        installWindows,
      );
      if (choice === useWsl) {
        vscode.window.showInformationMessage(
          l10n.t("Using opencode from WSL. Reload the window. If the extension runs on Windows, enable the WSL remote or install opencode on Windows too."),
        );
        return;
      }
    }
  }
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


async function takeoverInlineSuggestions() {
  // Disable Copilot's inline (ghost-text) suggestions and next-edit suggestions,
  // and enable LLMcode's autocomplete, so typing in a file runs on opencode.
  const g = vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration("github.copilot").update("enable", { "*": false }, g);
  await vscode.workspace.getConfiguration("github.copilot").update("inlineEditsEnabled", false, g);
  await vscode.workspace.getConfiguration("github.copilot").update("nextEditSuggestions.enabled", false, g);
  await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", true, g);
  await vscode.workspace.getConfiguration("llmcode.autocomplete").update("enabled", true, g);
  vscode.window.showInformationMessage(
    l10n.t("Copilot inline suggestions are disabled. LLMcode now provides autocomplete — reload the window to apply."),
  );
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
