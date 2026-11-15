import * as vscode from "vscode";
import { l10n } from "vscode";
import type { OpencodeBridge } from "./opencode";

// Registers opencode as a native language-model chat provider. Once registered,
// VS Code's built-in chat surfaces (Copilot Chat, inline chat, terminal chat,
// "Ask about selection") can select "LLMcode" models, which are backed by the
// opencode engine. This effectively replaces Copilot's model with opencode
// while keeping VS Code's native UI, tools and context handling.

const VENDOR = "llmcode";

interface ModelInfo extends vscode.LanguageModelChatInformation {}

export class OpencodeChatProvider implements vscode.LanguageModelChatProvider<ModelInfo> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  private models: ModelInfo[] = [];

  constructor(private readonly bridge: OpencodeBridge) {
    bridge.on("status", () => this.changeEmitter.fire());
  }

  private async ensureModels(): Promise<ModelInfo[]> {
    try {
      const list = await this.bridge.listModels();
      const maxInput = 128000;
      const maxOutput = 16000;
      this.models = list.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        family: m.providerID,
        version: "1",
        detail: "opencode",
        tooltip: l10n.t("opencode model {0}", m.id),
        maxInputTokens: maxInput,
        maxOutputTokens: maxOutput,
        capabilities: { toolCalling: true, imageInput: false },
      }));
    } catch {
      this.models = [];
    }
    return this.models;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<ModelInfo[]> {
    const models = await this.ensureModels();
    if (options.silent) return models;
    return models;
  }

  async provideLanguageModelChatResponse(
    model: ModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // Flatten the conversation into a single prompt for the engine, preserving
    // roles. The final user turn drives the engine; earlier turns provide context.
    const transcript = messages
      .map((m) => {
        const role = m.role === vscode.LanguageModelChatMessageRole.User ? "User" : "Assistant";
        const text = (m.content as any[])
          .map((c) => (typeof c === "string" ? c : c?.value ?? ""))
          .join("");
        return { role, text };
      })
      .filter((m) => m.text.trim().length > 0);

    // Build a compact transcript as the prompt.
    const lastUser = [...transcript].reverse().find((m) => m.role === "User");
    const history = transcript.slice(0, -1).map((m) => `${m.role}: ${m.text}`).join("\n\n");
    const prompt = history
      ? `${l10n.t("Conversation so far:")}\n\n${history}\n\n${l10n.t("User:")} ${lastUser?.text ?? ""}`
      : lastUser?.text ?? "";

    let sessionId: string | undefined;
    try {
      sessionId = (await this.bridge.createSession("vscode-chat")).id;
      await this.bridge.promptStream(sessionId, prompt, {
        model: model.id,
        signal: token,
        onDelta: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
      });
    } catch (err) {
      progress.report(new vscode.LanguageModelTextPart(`\n\n_${l10n.t("Error:")} ${(err as Error).message}_`));
    } finally {
      if (sessionId) void this.bridge.deleteSession(sessionId).catch(() => undefined);
    }
  }

  async provideTokenCount(
    _model: ModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const s = typeof text === "string"
      ? text
      : (text.content as any[]).map((c) => (typeof c === "string" ? c : c?.value ?? "")).join("");
    // Rough estimate: ~4 chars per token.
    return Math.ceil(s.length / 4);
  }

  refresh() {
    this.changeEmitter.fire();
  }
}

export function registerChatProvider(bridge: OpencodeBridge, context: vscode.ExtensionContext): OpencodeChatProvider {
  const provider = new OpencodeChatProvider(bridge);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
  return provider;
}
