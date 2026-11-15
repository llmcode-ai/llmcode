import * as assert from "assert";
import * as vscode from "vscode";
import { AutocompleteProvider } from "../../assistant";
import type { OpencodeBridge } from "../../opencode";

// End-to-end test of the inline completion provider on a real document.

suite("LLMcode Autocomplete Provider", () => {
  let bridge: OpencodeBridge;

  suiteSetup(async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension("llmcode.llmcode");
    assert.ok(ext, "extension not found");
    bridge = (await ext!.activate()) as unknown as OpencodeBridge;
    const deadline = Date.now() + 30000;
    while (!bridge.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  test("returns an inline completion for code at the cursor", async function () {
    this.timeout(90000);
    // Real, unsaved document with an incomplete statement and cursor at the end.
    const doc = await vscode.workspace.openTextDocument({ language: "javascript", content: "function sum(a) {\n  return " });
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(1, "  return ".length);
    editor.selection = new vscode.Selection(pos, pos);

    const provider = new AutocompleteProvider(bridge);
    const cts = new vscode.CancellationTokenSource();
    const result: any = await provider.provideInlineCompletionItems(
      doc,
      pos,
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined } as any,
      cts.token,
    );
    const items = Array.isArray(result) ? result : result?.items ?? [];
    assert.ok(items.length > 0, "expected at least one inline completion");
    const text = items[0].insertText ?? items[0].text ?? "";
    // eslint-disable-next-line no-console
    console.log("[autocomplete test] suggestion:", JSON.stringify(text));
    assert.ok(typeof text === "string" && text.length > 0, "completion insert text should be non-empty");
  });
});
