import * as vscode from "vscode";
import { l10n } from "vscode";
import type { OpencodeBridge } from "./opencode";

// Mode B: inline code assistant (Cursor/Copilot style).
//
// - Tab autocomplete: registerInlineCompletionItemProvider, FIM prompt built
//   client-side, generation through opencode bridge.generateText.
// - Inline edit: selection -> generation -> native vscode.diff apply/reject.

let output: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;

/** Initialise the log channel and status-bar indicator (called once). */
export function initAssistantUi(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("LLMcode");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "LLMcode";
  statusBar.command = "llmcode.showLastModel";
  statusBar.text = "$(sparkle) LLMcode";
  statusBar.tooltip = l10n.t("LLMcode: last model used (click to view log)");
  statusBar.show();
  context.subscriptions.push(output, statusBar);
}

function logModel(kind: string, requested: string | undefined, actual: string | undefined) {
  const line = `[${new Date().toISOString()}] ${kind}: requested=${requested || "(default)"} actual=${actual || "unknown"}`;
  output?.appendLine(line);
  if (statusBar) {
    statusBar.text = `$(sparkle) ${actual || "LLMcode"}`;
    statusBar.tooltip = l10n.t("Last {0} model: {1}", kind, actual || "unknown");
  }
}

/** Resolve the model to use: explicit autocomplete model, else chat default. */
function resolveModel(): string | undefined {
  const configured = vscode.workspace.getConfiguration("llmcode.autocomplete").get<string>("model", "");
  if (configured && configured.trim()) return configured.trim();
  const def = vscode.workspace.getConfiguration("chat").get<string>("defaultModel", "");
  if (def && def.trim()) return def.trim();
  return undefined;
}

const DEBOUNCE_MS = 200;
const MAX_PREFIX = 4000;
const MAX_SUFFIX = 2000;

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly bridge: OpencodeBridge) {}

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
    const cfg = vscode.workspace.getConfiguration("llmcode.autocomplete");
    if (!cfg.get<boolean>("enabled", true)) return undefined;
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && !this.shouldTrigger(document, position)) {
      return undefined;
    }

    return new Promise((resolve) => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        if (token.isCancellationRequested) return resolve(undefined);
        const items = await this.complete(document, position, token);
        resolve(items);
      }, DEBOUNCE_MS);
    });
  }

  private shouldTrigger(document: vscode.TextDocument, position: vscode.Position): boolean {
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);
    // Require at least some content and no trailing whitespace mid-word.
    return before.trim().length > 0;
  }

  private async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    try {
      const text = document.getText();
      const offset = document.offsetAt(position);
      const prefix = text.slice(0, offset).slice(-MAX_PREFIX);
      const suffix = text.slice(offset).slice(0, MAX_SUFFIX);

      const language = document.languageId;
      const prompt = this.buildFimPrompt(language, prefix, suffix);
      if (token.isCancellationRequested) return undefined;

      const model = resolveModel();
      const { text: completion, model: actual } = await this.bridge.generateText(prompt, model || undefined);
      logModel("autocomplete", model || undefined, actual);
      if (token.isCancellationRequested) return undefined;
      if (!completion || !completion.trim()) return undefined;

      const cleaned = this.cleanCompletion(completion, suffix);
      if (!cleaned) return undefined;

      return [new vscode.InlineCompletionItem(cleaned, undefined)];
    } catch (err) {
      console.warn("[llmcode] autocomplete error:", err);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  private buildFimPrompt(language: string, prefix: string, suffix: string): string {
    // Fill-in-the-middle prompt. The engine model sees the surrounding code.
    return [
      `Complete the code in the middle. Return ONLY the completed code, no explanation, no markdown fences.`,
      ``,
      `<|file|> (language: ${language})`,
      prefix,
      `<|cursor|>`,
      `...`,
      suffix,
      `<|end|>`,
      ``,
      `Completion:`,
    ].join("\n");
  }

  private cleanCompletion(completion: string, suffix: string): string {
    let out = completion.replace(/^```[a-zA-Z0-9+]*\n?/, "").replace(/```$/, "").trim();
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
