import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

suite("LLMcode Extension Test Suite", () => {
  test("extension activates", async () => {
    const ext = vscode.extensions.getExtension("llmcode.llmcode");
    assert.ok(ext, "extension not found");
    await ext?.activate();
    assert.ok(ext?.isActive, "extension did not activate");
  });

  test("commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("llmcode.open"), "llmcode.open missing");
    assert.ok(commands.includes("llmcode.inlineEdit"), "llmcode.inlineEdit missing");
    assert.ok(commands.includes("llmcode.importFromMachine"), "llmcode.importFromMachine missing");
  });
});
