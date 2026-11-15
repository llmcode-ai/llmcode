import * as vscode from "vscode";
import { l10n } from "vscode";
import type { OpencodeBridge } from "./opencode";

// Mode B: inline code assistant (Cursor/Copilot style).
//
// - Tab autocomplete: registerInlineCompletionItemProvider, FIM prompt built
//   client-side, generation through opencode bridge.generateText.
// - Inline edit: selection -> generation -> native vscode.diff apply/reject.

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

function debugLog(msg: string) {
  try {
    if (!vscode.workspace.getConfiguration("llmcode").get<boolean>("debug", false)) return;
    const file = path.join(os.homedir(), ".llmcode-debug.log");
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}

let output: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;

/** Initialise the log channel and status-bar indicator (called once). */
export function initAssistantUi(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("LLMcode");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "LLMcode";
  statusBar.command = "llmcode.pickModel";
  const configured = vscode.workspace.getConfiguration("llmcode.autocomplete").get<string>("model", "");
  statusBar.text = `$(sparkle) ${configured && configured.trim() ? configured.trim() : "LLMcode"}`;
  statusBar.tooltip = l10n.t("LLMcode: click to choose the model");
  statusBar.show();
  // Keep the label in sync when the setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("llmcode.autocomplete.model") && statusBar) {
        const m = vscode.workspace.getConfiguration("llmcode.autocomplete").get<string>("model", "");
        statusBar.text = `$(sparkle) ${m && m.trim() ? m.trim() : "LLMcode"}`;
      }
    }),
  );
  context.subscriptions.push(output, statusBar);
}

function logModel(kind: string, requested: string | undefined, actual: string | undefined) {
  const line = `[${new Date().toISOString()}] ${kind}: requested=${requested || "(default)"} actual=${actual || "unknown"}`;
  output?.appendLine(line);
  if (statusBar) {
    const shown = resolveModel() || actual;
    statusBar.text = `$(sparkle) ${shown || "LLMcode"}`;
    statusBar.tooltip = l10n.t("LLMcode model: {0} (last {1})", shown || "default", kind);
  }
}


/** Show a picker of opencode models and set it for autocomplete. */
export async function pickModel(bridge: OpencodeBridge): Promise<void> {
  let models: { id: string; name?: string; providerID: string }[] = [];
  try {
    models = await bridge.listModels();
  } catch (err) {
    vscode.window.showErrorMessage(l10n.t("Could not list models: {0}", (err as Error).message));
    return;
  }
  if (!models.length) {
    vscode.window.showWarningMessage(l10n.t("No models available. Is the opencode engine running?"));
    return;
  }
  const cfg = vscode.workspace.getConfiguration("llmcode.autocomplete");
  const current = cfg.get<string>("model", "");
  const items: (vscode.QuickPickItem & { id: string })[] = models.map((m) => ({
    id: m.id,
    label: (m.id === current ? "$(check) " : "$(circle-outline) ") + (m.name || m.id),
    description: m.id === current ? l10n.t("current") : m.providerID,
    detail: m.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: l10n.t("Choose the model LLMcode uses for autocomplete and edits"),
    matchOnDetail: true,
  });
  if (!picked) return;
  await cfg.update("model", picked.id, vscode.ConfigurationTarget.Global);
  // Also point the native chat default at it for consistency.
  await vscode.workspace.getConfiguration("chat").update("defaultModel", picked.id, vscode.ConfigurationTarget.Global);
  if (statusBar) statusBar.text = `$(sparkle) ${picked.id}`;
  vscode.window.showInformationMessage(l10n.t("LLMcode model set to {0}", picked.id));
}

/** Resolve the model to use: explicit autocomplete model, else chat default. */
function resolveModel(): string | undefined {
  const configured = vscode.workspace.getConfiguration("llmcode.autocomplete").get<string>("model", "");
  if (configured && configured.trim()) return configured.trim();
  const def = vscode.workspace.getConfiguration("chat").get<string>("defaultModel", "");
  if (def && def.trim()) return def.trim();
  return undefined;
}

const DEBOUNCE_MS = 300;
const MAX_PREFIX = 800;
const MAX_SUFFIX = 400;

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
  private lastFire = 0;
  private running: { position: vscode.Position; promise: Promise<vscode.InlineCompletionItem[] | undefined> } | undefined;

  constructor(private readonly bridge: OpencodeBridge) {}

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
    const cfg = vscode.workspace.getConfiguration("llmcode.autocomplete");
    if (!cfg.get<boolean>("enabled", true)) { debugLog("skip: disabled"); return undefined; }
    if (!this.shouldTrigger(document, position, context)) { debugLog("skip: trigger"); return undefined; }

    const invoke = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    const now = Date.now();

    // If a generation is already running, don't cancel it (that was why rapid
    // typing produced nothing). Reuse its result when the cursor is still on the
    // same line; otherwise wait for it and start fresh afterwards.
    if (this.running) {
      if (this.running.position.line === position.line) {
        debugLog("reuse running request");
        return this.running.promise;
      }
      const prev = this.running.promise;
      debugLog("queue behind running request");
      return prev.then(() => this.fire(document, position, invoke, token));
    }

    // Throttle automatic triggers; explicit Invoke is never throttled.
    if (!invoke && now - this.lastFire < DEBOUNCE_MS) {
      debugLog("skip: throttle");
      return undefined;
    }
    return this.fire(document, position, invoke, token);
  }

  private fire(
    document: vscode.TextDocument,
    position: vscode.Position,
    invoke: boolean,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    this.lastFire = Date.now();
    debugLog(`fire at ${position.line}:${position.character} invoke=${invoke}`);
    // No internal cancellation: let the request finish so a result is produced.
    const cts = new vscode.CancellationTokenSource();
    const promise = this.complete(document, position, cts.token).finally(() => {
      if (this.running && this.running.promise === promise) this.running = undefined;
    });
    this.running = { position, promise };
    return promise;
  }

  private shouldTrigger(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
  ): boolean {
    // Explicit invocation (Ctrl+Space) always triggers.
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) return true;
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);
    // Only suggest when there is code before the cursor and we are not inside a
    // pure-comment line start or whitespace-only context.
    if (before.trim().length === 0) return false;
    // Don't trigger right after a completed statement with only punctuation.
    if (/[;{}]\s*$/.test(before)) return false;
    return true;
  }

  private async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    try {
      const text = document.getText();
      const offset = document.offsetAt(position);
      const prefix = text.slice(0, offset).slice(-MAX_PREFIX);
      const suffix = text.slice(offset).slice(0, MAX_SUFFIX);

      const language = document.languageId;
      const prompt = this.buildFimPrompt(language, prefix, suffix);
      if (token.isCancellationRequested) return undefined;

      const model = resolveModel();
      const system =
        "You are a code completion engine. Continue the given code by outputting ONLY the exact characters to insert at the cursor. No explanations, no markdown, no commentary, no questions. Never write prose or Russian text.";
      // Engine call with tools disabled: reliable, constrained, no chatter.
      // Hard timeout so a slow/looping engine call cannot wedge autocomplete.
      const r = await Promise.race([
        this.bridge.generateText(prompt, model || undefined, system, { noTools: true, agent: "title" }),
        new Promise<{ text: string; model?: string }>((resolve) =>
          setTimeout(() => resolve({ text: "", model: undefined }), 9000),
        ),
      ]);
      const completion = r.text;
      const actual = r.model;
      logModel("autocomplete", model || undefined, actual);
      if (token.isCancellationRequested) return undefined;
      if (!completion || !completion.trim()) return undefined;

      const cleaned = this.cleanCompletion(completion, suffix, prefix);
      debugLog(`raw=${JSON.stringify(completion.slice(0,80))} cleaned=${JSON.stringify(cleaned.slice(0,80))} actual=${actual}`);
      if (!cleaned) { debugLog("cleaned empty"); return undefined; }

      // Insert at the cursor; the range must be present for ghost text to insert.
      const range = new vscode.Range(position, position);
      return [new vscode.InlineCompletionItem(cleaned, range)];
    } catch (err) {
      console.warn("[llmcode] autocomplete error:", err);
      debugLog("ERROR: " + (err as Error).message);
      return undefined;
    }
  }

  private buildFimPrompt(language: string, prefix: string, suffix: string): string {
    // For a raw completion model: give the code up to the cursor, and (if any)
    // a note about what follows so it does not duplicate the suffix.
    const hasSuffix = suffix.trim().length > 0;
    if (!hasSuffix) return prefix;
    return `${prefix}\n// (the code after the cursor: ${JSON.stringify(suffix.slice(0, 80))} — do not repeat it)`;
  }

  private cleanCompletion(completion: string, suffix: string, prefix: string): string {
    let out = completion.trim();
    // Strip code fences, and markdown-style inline-code wrapping (`` `...` ``),
    // and a leading dot that the model sometimes adds before a continuation.
    out = out.replace(/^```[a-zA-Z0-9+]*\s*\n?/, "").replace(/```\s*$/, "");
    out = out.replace(/^`([^`]*)`$/, "$1");
    out = out.replace(/^[`"'\s]+/, "");

    const outLines = out.split("\n");
    const prefixTrimmed = prefix.replace(/\s+$/, "");

    // Drop leading lines the model echoed from the end of the prefix. Walk the
    // prefix's trailing lines backwards and remove completions lines that match.
    const prefixLines = prefixTrimmed.split("\n").map((l) => l.trimEnd());
    let guard = 0;
    while (outLines.length > 0 && guard < 200) {
      const first = (outLines[0] ?? "").trimEnd();
      if (!first.trim()) {
        outLines.shift();
        guard++;
        continue;
      }
      // Find this line at the very end of the prefix (allowing a few lines back).
      const norm = (v: string) => v.replace(/\s+/g, " ").replace(/\s*([,:()])\s*/g, "$1").trim();
      // If the completion re-emits a line that already exists in the prefix
      // (e.g. the function header), drop it — the cursor is past that point.
      const existsInPrefix = first.trim().length > 0 && prefixLines.some((pl) => norm(pl) === norm(first));
      if (existsInPrefix) {
        outLines.shift();
        guard++;
        continue;
      }
      break;
    }
    out = outLines.join("\n").trimEnd();

    // If the completion repeats the tail of the prefix's last line at the start
    // (the cursor continues that line), strip the overlap.
    const lastPrefixLine = (prefixLines[prefixLines.length - 1] ?? "").trimStart();
    if (lastPrefixLine) {
      const firstOutLine = out.split("\n")[0].trimStart();
      if (firstOutLine.startsWith(lastPrefixLine) && lastPrefixLine.length >= 3) {
        const removed = out.indexOf(firstOutLine);
        const rest = firstOutLine.slice(lastPrefixLine.length);
        out = (out.slice(0, removed) + rest + out.slice(removed + firstOutLine.length)).replace(/^\s*\n/, "").trimStart();
      }
    }

    // Strip a trailing duplicated first line of the suffix if the model echoed it.
    if (suffix.trim().length > 0) {
      const firstSuffixLine = suffix.trimStart().split("\n")[0];
      if (firstSuffixLine && out.endsWith(firstSuffixLine)) {
        out = out.slice(0, out.length - firstSuffixLine.length).trimEnd();
      }
    }
    return out;
  }
}

// Inline edit: rewrite the current selection.
export async function inlineEditSelection(bridge: OpencodeBridge): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(l10n.t("No active editor"));
    return;
  }
  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showInformationMessage(l10n.t("Select code to edit first"));
    return;
  }

  const document = editor.document;
  const selectedText = document.getText(selection);
  const originalUri = document.uri;
  const originalRange = selection;

  const language = document.languageId;
  const instruction = await vscode.window.showInputBox({
    prompt: l10n.t("Describe the change (or leave empty for auto-fix)"),
    placeHolder: l10n.t("e.g. refactor to use async/await"),
  });
  const prompt = instruction
    ? `Rewrite the following ${language} code. Instruction: ${instruction}\n\nReturn ONLY the new code, no fences.\n\n${selectedText}`
    : `Improve and fix the following ${language} code. Return ONLY the new code, no fences.\n\n${selectedText}`;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: l10n.t("LLMcode: editing…") },
    async () => {
      try {
        const model = resolveModel();
        const { text: result, model: actual } = await bridge.generateText(prompt, model || undefined);
        logModel("inline-edit", model || undefined, actual);
        if (!result) return;
        const newText = result.replace(/^```[a-zA-Z0-9+]*\n?/, "").replace(/```$/, "").trimEnd();

        const edit = new vscode.WorkspaceEdit();
        edit.replace(originalUri, originalRange, newText);
        await vscode.workspace.applyEdit(edit);
      } catch (err) {
        vscode.window.showErrorMessage(l10n.t("LLMcode inline edit failed: {0}", (err as Error).message));
      }
    },
  );
}

// Selection commands routed into chat: /explain /fix /refactor /test /doc.
export async function selectionCommand(bridge: OpencodeBridge, kind: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage(l10n.t("Select code first"));
    return;
  }
  const selection = editor.document.getText(editor.selection);
  const language = editor.document.languageId;
  const prompts: Record<string, string> = {
    explain: `Explain what this ${language} code does, clearly and concisely:\n\n${selection}`,
    fix: `Find and fix bugs in this ${language} code. Return the corrected code and a brief explanation of each fix:\n\n${selection}`,
    refactor: `Refactor this ${language} code to be cleaner and more idiomatic. Return the refactored code:\n\n${selection}`,
    test: `Write unit tests for this ${language} code:\n\n${selection}`,
    doc: `Write documentation comments for this ${language} code:\n\n${selection}`,
  };
  const prompt = prompts[kind] ?? prompts.explain;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: l10n.t("LLMcode: {0}…", kind) },
    async () => {
      try {
        const model = resolveModel();
        const { text: result, model: actual } = await bridge.generateText(prompt, model || undefined);
        logModel(kind, model || undefined, actual);
        if (!result) return;
        showResultPanel(kind, result, language);
      } catch (err) {
        vscode.window.showErrorMessage(l10n.t("LLMcode {0} failed: {1}", kind, (err as Error).message));
      }
    },
  );
}

let resultPanel: vscode.WebviewPanel | undefined;

function showResultPanel(kind: string, text: string, language: string) {
  const clean = text.replace(/^```[a-zA-Z0-9+]*\n?/, "").replace(/```$/, "");
  if (resultPanel) {
    resultPanel.reveal(vscode.ViewColumn.Beside);
  } else {
    resultPanel = vscode.window.createWebviewPanel("llmcode.result", `LLMcode: ${kind}`, vscode.ViewColumn.Beside, {
      enableScripts: false,
    });
    resultPanel.onDidDispose(() => (resultPanel = undefined));
  }
  resultPanel.webview.html = `<!DOCTYPE html><html><body><pre style="font-family: var(--vscode-editor-font-family); white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(clean)}</pre></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
