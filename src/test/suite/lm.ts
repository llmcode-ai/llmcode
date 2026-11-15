import * as assert from "assert";
import * as vscode from "vscode";
import { OpencodeChatProvider } from "../../lmProvider";
import type { OpencodeBridge } from "../../opencode";

// Verifies that LLMcode registers itself as a native language-model chat
// provider (the mechanism that lets VS Code's own chat/Copilot UI use opencode).

suite("LLMcode Language Model Provider", () => {
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

  test("advertises a languageModelChatProviders contribution", () => {
    const ext = vscode.extensions.getExtension("llmcode.llmcode");
    const providers = (ext!.packageJSON.contributes as any)?.languageModelChatProviders ?? [];
    assert.ok(
      providers.some((p: any) => p.vendor === "llmcode"),
      "languageModelChatProviders contribution with vendor=llmcode missing",
    );
  });

  test("activates on startup so the native chat unlocks", () => {
    const ext = vscode.extensions.getExtension("llmcode.llmcode");
    const events: string[] = (ext!.packageJSON.activationEvents as string[]) ?? [];
    assert.ok(events.includes("onStartupFinished"), "expected onStartupFinished activation event");
  });

  test("sets chat.defaultModel to an opencode model", async function () {
    this.timeout(30000);
    const models = await vscode.lm.selectChatModels({ vendor: "llmcode" } as any);
    assert.ok(models.length > 0, "no opencode models");
    const cfg = vscode.workspace.getConfiguration("chat");
    const deadline = Date.now() + 15000;
    let def = cfg.get<string>("defaultModel");
    while ((!def || !def.includes("/")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      def = cfg.get<string>("defaultModel");
    }
    assert.ok(def && def.includes("/"), `expected chat.defaultModel set to an opencode model, got ${def}`);
  });

  test("exposes opencode models through lm.selectChatModels", async function () {
    this.timeout(30000);
    let models: vscode.LanguageModelChat[] = [];
    const deadline = Date.now() + 20000;
    do {
      models = await vscode.lm.selectChatModels({ vendor: "llmcode" } as any);
      if (models.length > 0) break;
      await new Promise((r) => setTimeout(r, 400));
    } while (Date.now() < deadline);
    assert.ok(models.length > 0, "expected opencode models via lm.selectChatModels({ vendor: 'llmcode' })");
  });

  test("streams a response from opencode through the provider", async function () {
    this.timeout(60000);
    // Drive the provider directly (bypasses the one-time consent dialog that
    // sendRequest would trigger) to prove token streaming reaches the callback.
    const provider = new OpencodeChatProvider(bridge);
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
    assert.ok(infos.length > 0, "provider returned no model infos");
    const model = infos[0];

    const messages = [
      vscode.LanguageModelChatMessage.User("Reply with exactly one word: PONG"),
    ];
    let streamed = "";
    const progress = { report: (part: any) => { if (part?.value) streamed += part.value; } } as any;
    await provider.provideLanguageModelChatResponse(
      model,
      messages as any,
      {} as any,
      progress,
      new vscode.CancellationTokenSource().token,
    );
    assert.ok(streamed.length > 0, "expected streamed text from opencode via the LM provider");
  });
});

