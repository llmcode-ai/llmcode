# LLMcode — detailed usage guide

This guide covers installation, every way of using LLMcode, configuration, the Settings panel, importing your existing setup, and troubleshooting.

---

## 1. What LLMcode is

LLMcode runs the [opencode](https://opencode.ai) engine inside VS Code. It does **not** add its own chat window. Instead it plugs opencode into three native VS Code surfaces:

1. **Model provider** — opencode models appear in VS Code's chat model picker under **LLMcode (opencode)**. Select one and Copilot Chat, inline chat and terminal chat all run on opencode.
2. **`@llmcode` participant** — an agent you can address in chat with `@llmcode`, backed by opencode, with conversation history.
3. **Code assistant** — tab autocomplete, `Ctrl+K` inline edits, and selection commands in the editor.

Only the **LLMcode Settings** panel is a custom UI (opened as an editor tab); everything else reuses VS Code's own interface, themes and localization.

---

## 2. Installation

### From the Marketplace

1. Open the Extensions view, search for **LLMcode**, install `llmcode.llmcode`.
   Or from a terminal: `code --install-extension llmcode.llmcode`.
2. **Reload the window** (`Ctrl+Shift+P` → *Developer: Reload Window*). LLMcode activates on startup, so a reload is required the first time.

### The opencode engine

LLMcode needs the `opencode` CLI.

- If it is already installed, nothing else is required.
- If it is missing, run **LLMcode: Check opencode Installation**. The extension offers to install it and runs the official installer in the integrated terminal:
  - Linux/macOS: `curl -fsSL https://opencode.ai/install | bash`
  - Windows: `irm https://opencode.ai/install.ps1 | iex`

After the installer finishes, reload the window.

---

## 3. Using opencode in VS Code's chat

### Option A — pick the model (recommended)

1. Open the chat.
2. Open the **model picker** (the model name at the bottom of the chat input).
3. Choose a model under **LLMcode (opencode)**, e.g. `abliteration/opus-5.5`.
4. Ask a question. VS Code remembers the choice per surface.

Shortcut: **LLMcode: Select Chat Model** opens the chat and its model picker for you.

### Option B — use the `@llmcode` agent

Type `@llmcode` followed by your message:

```
@llmcode explain what this project does
```

The `@llmcode` participant forwards the prompt (with the conversation history) to opencode and streams the answer back. This works alongside the built-in participants.

### Default model

On startup, if no `chat.defaultModel` is set, LLMcode sets it to an opencode model (governed by the `llmcode.setDefaultChatModel` setting). You can also set it yourself:

```json
"chat.defaultModel": "abliteration/opus-5.5"
```

To make the Agents window default to the **Local** harness instead of Copilot:

```json
"chat.defaultToCopilotHarness": false,
"chat.editor.preferCopilotHarness": false,
"chat.editor.localAgent.enabled": true
```

Or run **LLMcode: Use Local Agent by Default** (sets all three for you).

To stop Copilot's model router from auto-selecting a Copilot model over your choice:

```json
"chat.copilot.modelRouter.enabled": false
```

> **About "replacing Copilot":** the Agents window ("Build with Agent") is driven by Copilot's internal harnesses, which a third-party extension cannot replace. LLMcode registers itself as a model provider and a participant, and can set the default model — once an LLMcode model is selected, the chat runs on opencode.

---

## 4. Code assistant

### Tab autocomplete (ghost text)

- On by default. As you type, LLMcode builds a fill-in-the-middle prompt from the surrounding code and streams a completion.
- Accept with `Tab`, dismiss with `Esc`.
- Toggle with **LLMcode: Toggle Autocomplete** or `llmcode.autocomplete.enabled`.
- Choose a dedicated model via `llmcode.autocomplete.model`.

### Inline edit (`Ctrl+K`)

1. Select code.
2. Press `Ctrl+K` (or **LLMcode: Inline Edit Selection**).
3. Optionally describe the change; leave empty to auto-fix.
4. The selection is replaced with opencode's rewritten code.

### Selection commands

Right-click a selection → **LLMcode** submenu, or the Command Palette:

- **Explain Selection** — explains what the code does.
- **Fix Selection** — finds and fixes bugs.
- **Refactor Selection** — cleans up and modernizes the code.
- **Add File to Chat** — opens the chat with the file in context.

---

## 5. The LLMcode Settings panel

Open with **LLMcode: Open Settings**. It opens as an editor tab with a left navigation and these sections:

| Section | What you do there |
|---|---|
| **General** | Toggle autocomplete, set the autocomplete model, choose the default chat model |
| **Providers & Models** | View all providers and their models exposed by opencode |
| **Agents** | View primary/subagent definitions (e.g. `build`, `plan`, `general`, custom agents) |
| **Skills** | View skills/commands available to the engine |
| **MCP Servers** | See each MCP server's status; **Connect** / **Disconnect** with one click |
| **Plugins** | View loaded opencode plugins |

A toolbar at the top of the panel offers **Import from machine** and **Refresh**.

---

## 6. Importing skills, MCP servers and plugins

**LLMcode: Import Skills/MCP/Plugins from Machine** discovers and imports your existing setup. It scans:

- the global config `~/.config/opencode/` (skills, `plugins/*.ts`, and the `mcp` block of `opencode.json`),
- the current project's `.opencode/`,
- WSL distributions (on Windows).

What happens:

- **Skills** are copied into `~/.config/opencode/skills/`.
- **MCP servers** are merged into the `mcp` block of `opencode.json` (existing entries are left untouched).
- **Plugins** are copied into `~/.config/opencode/plugins/`.

A progress notification runs during import, and a summary reports what was **added** versus **already present**. Nothing is overwritten; secrets are not copied into logs.

---

## 7. Settings reference

| Setting | Default | Description |
|---|---|---|
| `llmcode.autocomplete.enabled` | `true` | Enable tab autocomplete |
| `llmcode.autocomplete.model` | `""` | Model for autocomplete (`provider/model`); empty uses the default |
| `llmcode.mode` | `"auto"` | `chat`, `assistant`, or `auto` |
| `llmcode.opencode.command` | `"opencode"` | Path/name of the opencode executable |
| `llmcode.opencode.port` | `0` | Fixed port for `opencode serve`; `0` picks a free port |
| `llmcode.opencode.hostname` | `"127.0.0.1"` | Hostname for `opencode serve` |
| `llmcode.setDefaultChatModel` | `true` | Set `chat.defaultModel` to an LLMcode model when unset |

---

## 8. How context and limits work

LLMcode reads each model's limits from the opencode engine and reports them to VS Code. For example, a model whose engine entry declares `limit.context = 1000000` is exposed to VS Code with a **1,000,000-token** input window and its real output limit. There is nothing to configure — the values come from your provider/model definition in opencode.

---

## 9. Verifying it's LLMcode answering

- In chat, open the model picker and confirm a model under **LLMcode (opencode)** is selected.
- Or ask `@llmcode …` — the response is produced by the opencode engine.
- Programmatically: `vscode.lm.selectChatModels({ vendor: 'llmcode' })` returns the opencode models, and `provider.provideLanguageModelChatResponse(...)` streams from opencode. Both are covered by the test suite.

---

## 10. Troubleshooting

**No "LLMcode (opencode)" in the model picker**
- Reload the window after installing (the extension activates on startup).
- Run **LLMcode: Check opencode Installation**; install the CLI if prompted, then reload.
- Confirm the engine is running: **LLMcode: Open Terminal Session** should start `opencode` without errors.

**`ServeError` / "Server exited with code 1"**
- Cause: another `opencode serve` is holding port `4096`.
- LLMcode automatically falls back to a free port. If you pinned `llmcode.opencode.port`, set it back to `0` (or kill the stale process) and reload.

**Chat still answers with Copilot**
- The Agents window may auto-select a Copilot model. Pick an **LLMcode (opencode)** model in the picker and/or set `chat.copilot.modelRouter.enabled` to `false`.

**Autocomplete does not appear**
- Ensure `llmcode.autocomplete.enabled` is `true` and the engine is running. Completion is debounced and requires some surrounding code to build context.

**Secrets / providers**
- Provider keys live in your opencode configuration, not in VS Code settings. Configure them the way you normally configure opencode.

---

## 11. Response timing & progress

The opencode engine generates a full assistant message before returning text, so responses may appear in one piece after a few seconds rather than token-by-token. While it works:

- The `@llmcode` participant shows an elapsed-time progress heartbeat ("opencode is working… (Ns)").
- The native chat shows its own working spinner until the answer completes.

If a request seems stuck for a long time, check **LLMcode: Open Terminal Session** — the engine may be waiting on a provider. Press the stop button in chat to cancel.

## 11. Privacy

LLMcode sends prompts to the providers you configured in opencode, through your opencode engine, over the local loopback interface. It does not add telemetry. API keys remain in your opencode config and are never copied into VS Code settings or logs.
