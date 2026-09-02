# Git: History for Selection

WebStorm-style "Show History for Selection" for VS Code.

1. Select a line or range of lines (multi-cursor works too).
2. Press `Cmd+Alt+H` (`Ctrl+Alt+H` on Windows/Linux), or run **Git: Show History for Selection** from the Command Palette or editor context menu.
3. A **Selection History** panel opens at the bottom. The left side lists the commits that touched those lines (via `git log -L`), plus **Unstaged changes** and **Staged changes** entries when your working tree or index touches them. The right side shows a side-by-side diff of just those lines, highlighted with your editor's own grammar and colour theme, plus the commit message.

Keys inside the panel: Up/Down (also Home/End/PageUp/PageDown) move between entries, Enter opens the full-file diff in the native diff editor scrolled to the tracked lines, Escape returns focus to the editor. Double-click does the same as Enter. Drag the divider to resize the commit list.

Renames are followed. Selections are mapped working tree -> index -> HEAD, so uncommitted edits elsewhere in the file do not throw the history off.

Syntax highlighting loads the TextMate grammar and colour theme from your installed extensions, so it matches the editor. Themes shipped as legacy `.tmTheme` files fall back to plain text. The theme is read from `workbench.colorTheme`, so with `window.autoDetectColorScheme` enabled the panel may use a different theme from the editor.

Setting: `selectionHistory.maxCommits` (default 200).

## Development

Not published to the Marketplace. Build and install it locally:

```bash
npm install
npm run install-local
```

That type-checks, bundles with esbuild into `out/`, packages a `.vsix`, and installs it into VS Code using the CLI inside the app bundle (set `VSCODE_CLI` if yours lives elsewhere, or pass `-- --cursor` for Cursor). Reload the VS Code window afterwards. Bump `version` in `package.json` when you want VS Code to treat it as an update.

Other scripts:

- `npm test` bundles and runs the unit tests in `test/run.js` (git parsing, line mapping, the webview renderer, and the highlighter against the grammars and themes installed with VS Code).
- `npm run compile` type-checks and bundles only.
- `npm run package` builds the `.vsix` without installing it.
