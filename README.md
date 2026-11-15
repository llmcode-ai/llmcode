# LLMcode

**Run [opencode](https://opencode.ai) inside VS Code — as the model behind Copilot's chat, as a `@llmcode` agent, and as a native code assistant.**

LLMcode does not ship its own chat UI. It plugs the opencode engine into VS Code's existing surfaces so everything runs on your opencode models, providers, agents, skills and MCP servers — with a 1M-token context window.

---

## What it does

LLMcode integrates with VS Code in three ways:

| Integration | How it shows up | What it powers |
|---|---|---|
| **Language-model provider** (`vendor: llmcode`) | Pick **LLMcode (opencode)** in the model picker of the native chat | Copilot Chat, inline chat, terminal chat, and the Agents window all run on opencode models |
| **Chat participant** (`@llmcode`) | Type `@llmcode …` in chat | An opencode-backed agent inside the chat, alongside the built-in participants |
| **Code assistant** | Ghost-text completions, `Ctrl+K` inline edit, editor context menu | Tab autocomplete, inline edits of a selection, and `/explain`, `/fix`, `/refactor`, `/test`, `/doc` commands |

All configuration — providers, models, agents, skills, MCP servers, plugins, general options — lives in one **LLMcode Settings** panel. There is no separate chat sidebar to learn: you work in VS Code's own chat.

The extension uses only native VS Code APIs: `vscode.l10n` for localization, VS Code color themes, `ThemeIcon`, `QuickPick`, `createTerminal`, `vscode.diff`, the `lm` language-model API, and `chat.createChatParticipant`.

---

## How it uses opencode

LLMcode talks to a managed `opencode serve` process through the official `@opencode-ai/sdk`:

- On activation it finds the `opencode` CLI, starts the engine, and (if the CLI is missing) offers to install it.
- It starts on the first free port (falling back from `4096` if a stale server occupies it), so it never fails with `ServeError`.
- Context and output limits are read from the engine, so a model that reports a 1,000,000-token context window is exposed to VS Code as such.
- Provider secrets stay in your opencode configuration — LLMcode never copies them.

---

## Requirements

- VS Code `^1.94.0` (stable APIs only — no proposed API needed)
- The `opencode` CLI. If it is not installed, run **LLMcode: Check opencode Installation** and the extension will offer to install it through the integrated terminal.

---

## Quick start

1. Install the extension (Marketplace: `llmcode.llmcode`, or `code --install-extension llmcode.llmcode`).
2. Reload the window so the extension activates on startup.
3. Open the chat and either:
   - open the **model picker** and choose a model under **LLMcode (opencode)**, or
   - type **`@llmcode`** followed by your question.
4. Ask anything — the response is streamed from the opencode engine.

See **[docs/USAGE.md](docs/USAGE.md)** for the full guide (configuration, all commands, settings, troubleshooting, verification).

---

## Verifying that LLMcode (not Copilot) is answering

1. Open the chat and its **model picker**.
2. Pick any model under **LLMcode (opencode)**.
3. Ask a question — the response comes from opencode.

Programmatically: `vscode.lm.selectChatModels({ vendor: 'llmcode' })` returns the opencode model list. This is asserted in the test suite (`streams a response from opencode through the provider`).

> **Note on "replacing Copilot":** VS Code's Agents window is driven by Copilot's own internal harnesses, which a third-party extension cannot replace. What LLMcode *can* do — and does — is register opencode as a model provider and as a `@llmcode` participant, and set `chat.defaultModel` to an opencode model so the native chat uses it by default. Once you pick an LLMcode model, the chat runs on opencode.

---

## Commands

| Command | Default key | Description |
|---|---|---|
| `LLMcode: Open Chat` | `Ctrl+Shift+L` | Opens VS Code's native chat |
| `LLMcode: Select Chat Model` | — | Opens the native model picker to choose an LLMcode model |
| `LLMcode: Show Model Log` | — | Opens the LLMcode output log (which model actually answered each completion) |
| `LLMcode: Use Local Agent by Default` | — | Makes the Agents window default to **Local** instead of Copilot |
| `LLMcode: Open Settings` | — | Opens the LLMcode Settings panel |
| `LLMcode: New Session` | — | Opens the chat to start a new session |
| `LLMcode: Import Skills/MCP/Plugins from Machine` | — | Imports from `~/.config/opencode`, project `.opencode`, and WSL |
| `LLMcode: Inline Edit Selection` | `Ctrl+K` | Rewrites the selected code via opencode |
| `LLMcode: Explain / Fix / Refactor Selection` | — | Selection commands (editor context menu) |
| `LLMcode: Toggle Autocomplete` | — | Enables/disables ghost-text completions |
| `LLMcode: Check opencode Installation` | — | Detects the CLI, offers to install |
| `LLMcode: Install opencode` | — | Runs the installer in the integrated terminal |
| `LLMcode: Open Terminal Session` | — | Opens a terminal running `opencode` |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `llmcode.autocomplete.enabled` | `true` | Enable tab autocomplete (ghost text) |
| `llmcode.autocomplete.model` | `""` | Model for autocomplete, e.g. `abliteration/opus-5.5`. Empty uses the default |
| `llmcode.mode` | `"auto"` | `chat`, `assistant`, or `auto` |
| `llmcode.opencode.command` | `"opencode"` | Path or name of the opencode executable |
| `llmcode.opencode.port` | `0` | Fixed port for `opencode serve` (`0` = pick a free port) |
| `llmcode.opencode.hostname` | `"127.0.0.1"` | Hostname for `opencode serve` |
| `llmcode.setDefaultChatModel` | `true` | Set `chat.defaultModel` to an LLMcode model when none is configured |

---

## Development

```bash
npm install
npm run compile        # esbuild bundle
npm run watch          # rebuild on change
npm run typecheck      # tsc --noEmit
npm test               # extension-host test suite (13 tests)
npm run package        # vsce package (.vsix)
```

Press `F5` to launch an Extension Development Host.

---

## License

MIT
