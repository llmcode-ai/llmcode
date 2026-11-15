import * as vscode from "vscode";
import { l10n } from "vscode";
import type { OpencodeBridge } from "./opencode";

// A stable chat participant (@llmcode) that routes prompts to the opencode
// engine. This lets LLMcode appear as an agent inside VS Code's chat surface,
// alongside the built-in Copilot participants, using only stable APIs.

export function registerChatParticipant(bridge: OpencodeBridge, context: vscode.ExtensionContext): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) => {
    // Build a transcript from the history so the engine has context.
    const history: string[] = [];
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        history.push(`User: ${turn.prompt}`);
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((p: any) => (typeof p === "string" ? p : p?.value ?? ""))
          .join("");
        if (text) history.push(`Assistant: ${text}`);
      }
    }
    const prompt = history.length
      ? `${l10n.t("Conversation so far:")}\n\n${history.join("\n")}\n\n${request.prompt}`
      : request.prompt;

    let sessionId: string | undefined;
    try {
      const started = Date.now();
      stream.progress(l10n.t("Asking opencode…"));
      // Heartbeat so the user sees ongoing work while the engine generates.
      const heartbeat = setInterval(() => {
        const secs = Math.round((Date.now() - started) / 1000);
        stream.progress(l10n.t("opencode is working… ({0}s)", String(secs)));
      }, 1000);
      try {
        sessionId = (await bridge.createSession("vscode-chat")).id;
        const opts = request.model ? { model: `${(request.model as any).vendor}/${request.model.id}` } : {};
        await bridge.promptStream(sessionId, prompt, {
          ...(opts as any),
          signal: token,
          onDelta: (text) => stream.markdown(text),
        });
      } finally {
        clearInterval(heartbeat);
      }
    } catch (err) {
      stream.markdown(`\n\n_${l10n.t("Error:")} ${(err as Error).message}_`);
    } finally {
      if (sessionId) void bridge.deleteSession(sessionId).catch(() => undefined);
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant("llmcode.agent", handler);
  participant.iconPath = new vscode.ThemeIcon("sparkle");
  context.subscriptions.push(participant);
  return participant;
}
