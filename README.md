# LLMcode

**opencode remastered as a VS Code extension.** Two modes in one plugin:

- **Chat** — full opencode chat surface in a sidebar: sessions, providers, models, agents, skills, commands, MCP servers, plugins, permissions, config, terminal, usage.
- **Code assistant** — Cursor/Copilot-style inline autocomplete (ghost text), inline edits of a selection, and selection commands (`/explain`, `/fix`, `/refactor`, `/test`, `/doc`).

The entire engine is [opencode](https://opencode.ai) running under the hood via `opencode serve`. The extension uses only native VS Code APIs — `vscode.l10n` for localization, VS Code color themes, `ThemeIcon`, `QuickPick`/`TreeView`, `createTerminal`, and `vscode.diff`.

## Requirements

- VS Code `^1.94.0`
- opencode CLI (the extension will offer to install it if missing)

## Features

- **Chat mode** (default), driven by `opencode serve`:
  - Parallel, persistent sessions (stored in opencode's `opencode.db`).
  - Providers + models management, per-session/per-agent model selection.
  - Agents (primary/subagent, markdown definitions).
  - Skills, slash commands, plugins, instructions/rules.
  - MCP servers (local + remote), connect/disconnect.
  - Permissions, terminal, token/cost usage, full config surface.
- **Code assistant mode**:
  - Tab autocomplete via `registerInlineCompletionItemProvider`, FIM prompt built in the extension, generation through opencode's `generate.text`.
  - Inline edit of a selection (`Ctrl+K`) rendered through native `vscode.diff`.
  - Selection commands in the editor context menu.
- **Import from machine**: discover and import skills, MCP servers, and plugins from `~/.config/opencode/`, WSL distros, and project `.opencode/` directories, with conflict handling and secret protection.

## Development

```bash
npm install
npm run compile        # esbuild bundle
npm run watch
npm run typecheck
npm run package        # vsce package (.vsix)
```

Press `F5` to launch an Extension Development Host.

## License

MIT
