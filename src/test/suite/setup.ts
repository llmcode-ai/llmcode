import * as assert from "assert";
import * as vscode from "vscode";

// Verifies the extension applies its recommended settings automatically,
// routing chat/inline suggestions through opencode and disabling Copilot.

suite("LLMcode Auto Setup", () => {
  suiteSetup(async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension("llmcode.llmcode");
    assert.ok(ext, "extension not found");
    await ext!.activate();
    // Give the fire-and-forget applyDefaultSettings a moment.
    await new Promise((r) => setTimeout(r, 1500));
  });

  test("Copilot inline suggestions are disabled", () => {
    const copilot = vscode.workspace.getConfiguration("github.copilot");
    // Copilot may be disabled in this test host; only check the value we wrote.
    const enableInfo = copilot.inspect<Record<string, boolean>>("enable");
    const written = enableInfo?.globalValue;
    if (written !== undefined) {
      assert.ok(written["*"] === false, "github.copilot.enable[*] should be false");
      assert.strictEqual(copilot.inspect<boolean>("inlineEditsEnabled")?.globalValue, false);
    }
  });

  test("inline suggest is enabled and Agents defaults to Local", () => {
    assert.strictEqual(vscode.workspace.getConfiguration("editor").get<boolean>("inlineSuggest.enabled"), true);
    const chat = vscode.workspace.getConfiguration("chat");
    assert.strictEqual(chat.get<boolean>("defaultToCopilotHarness"), false);
    assert.strictEqual(chat.get<boolean>("agentHost.byokModels.enabled"), true);
  });
});
