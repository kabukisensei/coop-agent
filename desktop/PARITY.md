# coop window: terminal parity

Master plan row D1b, section 11.1: the window keeps every capability of a
terminal coop session. Each row below maps one way of acting in the terminal to
what the window does:

- **rpc**: the window sends Pi's RPC command for it.
- **window**: a control in the window does it (named in the row).
- **Pi**: the window sends the text to Pi as typed, and Pi's answer shows the
  same way it does in the terminal (dialogs, notices, the conversation).
- **terminal**: the screen exists only in the terminal, so the window opens
  coop in a terminal on the same session (Windows), the way "Open in terminal"
  does for every session.

A row without a mapping fails D1b. `tests/desktop.test.mjs` checks this file
against the window's own lists (`desktop/renderer/commands.mjs`: `BUILTINS`,
`KEYS`, `TERMINAL_ONLY`) and against the command list Pi returned in the
recorded fixture (`tests/fixtures/desktop-rpc.jsonl`, coop's release extensions
loaded). A Pi or extension upgrade that adds a command or a keybinding fails
that test until it has a row here; re-record the fixture with
`node desktop/scripts/record-fixture.mjs` (row U2 does this for Pi 1.0).

The window adds nothing to Pi's launch: `coop desktop` builds the same
arguments as `coop` (`Build-CoopPiArgs`) and the window runs them with
`--mode rpc`, never `--approve`, so project trust, guardrails, approvals,
standards and skills behave as in the terminal.

## Pi built-in commands

Pi 0.87.1, `docs/slash-commands.md`. Pi implements these in its terminal UI
only, so the window runs each one itself.

| Command | Maps to | In the window |
| --- | --- | --- |
| `/settings` | window | Settings: theme, auto-compaction (`set_auto_compaction`), auto-retry (`set_auto_retry`), steering and follow-up modes (`set_steering_mode`, `set_follow_up_mode`), show thinking, expand tools. Pi's other settings stay in the terminal's `/settings`. |
| `/model` | rpc | Model picker over `get_available_models`, then `set_model`; `/model provider/id` sets it directly. Ctrl+L. |
| `/thinking` | rpc | Thinking picker, then `set_thinking_level`; `/thinking high` sets it directly. Shift+Tab cycles (`cycle_thinking_level`). |
| `/scoped-models` | terminal | Choosing the models Ctrl+P cycles is a terminal screen. |
| `/login` | terminal | Model sign-in is interactive; the window also shows a sign-in banner when no login is stored. |
| `/logout` | terminal | Same screen as `/login`. |
| `/new` | rpc | `new_session`. Ctrl+Shift+N or the sidebar's New session. |
| `/resume` | rpc | Sessions list (sidebar and picker), then `switch_session` with a session file coop saved. Ctrl+Shift+R. |
| `/name` | rpc | `set_session_name`; without a name it asks for one. The header's session name opens it too. |
| `/session` | rpc | Session details from `get_state` and `get_session_stats`: file, id, messages, tokens, cost, context. |
| `/tree` | rpc | Tree view from `get_tree`: Pi's five filters, folding branches, labels, and Fork here (`fork`). Ctrl+Shift+T. Moving to another point in the same session and editing labels have no RPC command in Pi 0.87.1, so the view's Open in terminal button runs `/tree` there. |
| `/fork` | rpc | Pick an earlier prompt from `get_fork_messages`, then `fork`; the prompt comes back to the composer. Ctrl+Shift+F. |
| `/clone` | rpc | `clone`. |
| `/compact` | rpc | `compact` with the optional instructions after the command. |
| `/import` | terminal | Importing a session file is a terminal command. |
| `/copy` | window | Copies the last answer; every answer and code block also has a copy button. |
| `/export` | rpc | Save dialog, then `export_html` to the chosen file. Pi 0.87.1 has no RPC command for its JSONL export of the current branch (`/export <file>.jsonl`), so that form runs in Open in terminal. |
| `/share` | terminal | Uploading a session is a terminal command. |
| `/bug` | terminal | Pi's bug report flow is a terminal command. |
| `/trust` | terminal | Saving a project trust decision is a terminal screen; without one, the window loads no project-local Pi files, as `--mode rpc` does. |
| `/reload` | window | Restarts coop in the window on the same session (`--session`), which reloads extensions, skills and prompts. |
| `/hotkeys` | window | Keyboard shortcuts table (from `KEYS`). |
| `/changelog` | terminal | Pi's changelog viewer is a terminal screen. |
| `/quit` | window | Closes the window, which stops Pi and its children. Ctrl+W. |

## Composer prefixes

| Typed | Maps to | In the window |
| --- | --- | --- |
| `!command` | rpc | `bash`; the output joins the conversation and the model's context. |
| `!!command` | rpc | `bash` with `excludeFromContext`; the output shows but stays out of the model's context. |
| `@path` | window | File search over the folder (git's file list, else a walk), inserted as `@path` exactly as the terminal does. |
| Enter while coop works | rpc | `steer`. |
| Alt+Enter while coop works | rpc | `follow_up` (Ctrl+Q too, since Windows Terminal reserves Alt+Enter). |

## Launch flags

What a terminal user passes on the command line, and where it lives in the
window, which `coop desktop` opens on a folder.

| Flag | Maps to | In the window |
| --- | --- | --- |
| `coop -c` | window | The sessions list is newest first; the top one is the last session. |
| `coop -r` | window | Sessions list (Ctrl+Shift+R). |
| `coop --session <file>` | rpc | Sessions list, then `switch_session`. |
| `coop --model <id>` | rpc | `/model <id>`. |
| `coop --thinking <level>` | rpc | `/thinking <level>`. |
| `coop @file "message"` | window | Type `@` to mention the file, then the message. |
| `coop "message"` | rpc | Type the message (`prompt`). |
| `coop -p` | terminal | Print mode is not a session; run it in a terminal. |

## Keybinding actions

Pi 0.87.1, `docs/keybindings.md`: every action id, with the window's key.
"native" means the text box, list or scroll area already does it.

| Action | Maps to | In the window |
| --- | --- | --- |
| `app.interrupt` | rpc | Esc: `abort` (or `abort_bash`, `abort_retry`); queued messages come back to the prompt first (`clear_queue`). |
| `app.clear` | native | Ctrl+C copies in a window; clear the prompt with Ctrl+A, Delete. |
| `app.exit` | window | Ctrl+W closes the window. |
| `app.suspend` | terminal | Job control has no window form (and none on Windows). |
| `app.editor.external` | window | Ctrl+G opens a larger editor for the prompt. |
| `app.clipboard.pasteImage` | window | Ctrl+V or drag and drop attaches up to five images when the model reads images. |
| `app.session.new` | rpc | Ctrl+Shift+N. |
| `app.session.tree` | rpc | Ctrl+Shift+T. |
| `app.session.fork` | rpc | Ctrl+Shift+F. |
| `app.session.resume` | window | Ctrl+Shift+R. |
| `app.session.togglePath` | native | The sessions list is per folder. |
| `app.session.toggleSort` | native | The sessions list is newest first. |
| `app.session.toggleNamedFilter` | native | Type in the sessions filter. |
| `app.session.rename` | rpc | Session name in the header, or `/name`. |
| `app.session.delete` | terminal | Deleting saved sessions is in the terminal's `/resume`. |
| `app.session.deleteNoninvasive` | terminal | Deleting saved sessions is in the terminal's `/resume`. |
| `app.model.select` | rpc | Ctrl+L. |
| `app.model.cycleForward` | rpc | Ctrl+P (`cycle_model`). |
| `app.model.cycleBackward` | rpc | Ctrl+L picks any model; Pi's RPC cycles forward only. |
| `app.models.save` | terminal | Saving default models is in the terminal's `/model` and `/settings`. |
| `app.thinking.cycle` | rpc | Shift+Tab. |
| `app.thinking.save` | terminal | Saving the default level is in the terminal's `/settings`. |
| `app.thinking.toggle` | window | Ctrl+T shows or hides thinking. |
| `app.tools.expand` | window | Ctrl+O expands or collapses tool output. |
| `app.message.copy` | window | Copy button on every answer; `/copy` for the last. |
| `app.message.followUp` | rpc | Alt+Enter or Ctrl+Q. |
| `app.message.dequeue` | rpc | Alt+Up (`clear_queue`, texts back in the prompt). |
| `app.tree.foldOrUp` | window | Click a branch fold (or Enter on it) in the tree view. |
| `app.tree.unfoldOrDown` | window | Click a branch fold (or Enter on it) in the tree view. |
| `app.tree.editLabel` | terminal | Tree labels are edited in the terminal's `/tree`. |
| `app.tree.toggleLabelTimestamp` | terminal | Tree labels are edited in the terminal's `/tree`. |
| `app.tree.filter.default` | window | Tree view Show list: Prompts and answers (the default). |
| `app.tree.filter.noTools` | window | Tree view Show list: Everything but tool results. |
| `app.tree.filter.userOnly` | window | Tree view Show list: Prompts only. |
| `app.tree.filter.labeledOnly` | window | Tree view Show list: Labeled entries. |
| `app.tree.filter.all` | window | Tree view Show list: Everything. |
| `app.tree.filter.cycleForward` | window | Down on the tree view's Show list. |
| `app.tree.filter.cycleBackward` | window | Up on the tree view's Show list. |
| `app.models.enableAll` | terminal | Scoped models are set in the terminal. |
| `app.models.clearAll` | terminal | Scoped models are set in the terminal. |
| `app.models.toggleProvider` | terminal | Scoped models are set in the terminal. |
| `app.models.reorderUp` | terminal | Scoped models are set in the terminal. |
| `app.models.reorderDown` | terminal | Scoped models are set in the terminal. |
| `tui.input.newLine` | window | Shift+Enter or Ctrl+J. |
| `tui.input.submit` | rpc | Enter (`prompt`, or `steer` while coop works). |
| `tui.input.tab` | window | Tab completes a `/command`, an `@file` or a path. |
| `tui.input.copy` | native | Ctrl+C copies the selection. |
| `tui.editor.historyPrevious` | window | Up in an empty prompt. |
| `tui.editor.historyNext` | window | Down while browsing history. |
| `tui.editor.cursorUp` | native | Arrow keys. |
| `tui.editor.cursorDown` | native | Arrow keys. |
| `tui.editor.cursorLeft` | native | Arrow keys. |
| `tui.editor.cursorRight` | native | Arrow keys. |
| `tui.editor.cursorWordLeft` | native | Ctrl+Left. |
| `tui.editor.cursorWordRight` | native | Ctrl+Right. |
| `tui.editor.cursorLineStart` | native | Home. |
| `tui.editor.cursorLineEnd` | native | End. |
| `tui.editor.jumpForward` | native | Word moves or the mouse. |
| `tui.editor.jumpBackward` | native | Word moves or the mouse. |
| `tui.editor.pageUp` | native | PageUp in a long prompt. |
| `tui.editor.pageDown` | native | PageDown in a long prompt. |
| `tui.editor.deleteCharBackward` | native | Backspace. |
| `tui.editor.deleteCharForward` | native | Delete. |
| `tui.editor.deleteWordBackward` | native | Ctrl+Backspace. |
| `tui.editor.deleteWordForward` | native | Ctrl+Delete. |
| `tui.editor.deleteToLineStart` | native | Shift+Home, then Delete. |
| `tui.editor.deleteToLineEnd` | native | Shift+End, then Delete (Ctrl+K opens the command palette). |
| `tui.editor.yank` | native | Ctrl+X and Ctrl+V through the clipboard. |
| `tui.editor.yankPop` | native | Ctrl+X and Ctrl+V through the clipboard. |
| `tui.editor.undo` | native | Ctrl+Z (Ctrl+Y redoes). |
| `tui.select.up` | native | Up in every list. |
| `tui.select.down` | native | Down in every list. |
| `tui.select.pageUp` | native | PageUp in every list. |
| `tui.select.pageDown` | native | PageDown in every list. |
| `tui.select.confirm` | native | Enter in every list. |
| `tui.select.cancel` | native | Esc closes every list. |
| `tui.altScreen.pageUp` | window | PageUp from the prompt scrolls the conversation. |
| `tui.altScreen.pageDown` | window | PageDown from the prompt scrolls the conversation. |
| `tui.altScreen.halfPageUp` | native | Mouse wheel or scroll bar. |
| `tui.altScreen.halfPageDown` | native | Mouse wheel or scroll bar. |
| `tui.altScreen.lineUp` | native | Arrow keys with the conversation focused. |
| `tui.altScreen.lineDown` | native | Arrow keys with the conversation focused. |
| `tui.altScreen.top` | native | Home with the conversation focused. |
| `tui.altScreen.bottom` | native | End with the conversation focused; the window follows new output while at the bottom. |
| `tui.altScreen.previousPrompt` | window | Ctrl+Up scrolls to the previous prompt you sent. |
| `tui.altScreen.nextPrompt` | window | Ctrl+Down scrolls to the next prompt you sent. |
| `tui.altScreen.search` | window | Ctrl+F searches the conversation. |
| `tui.altScreen.searchNext` | window | Enter (or Ctrl+G) in the search box: the earlier match. |
| `tui.altScreen.searchPrevious` | window | Shift+Enter in the search box: the later match. |
| `tui.altScreen.searchClose` | window | Esc (or the close button) closes the search. |

## Extension commands

The commands Pi listed in the fixture with coop's release extensions loaded
(`get_commands`, source `extension`). Each was run in RPC mode to see what it
shows. "Pi" means the window sends it as typed and the answer shows as in the
terminal: one-line notices as toasts, longer reports in the conversation,
dialogs as cards and lists.

| Command | Extension | Maps to | In the window |
| --- | --- | --- | --- |
| `/start` | coop-tools | Pi | The Start Here menu, as a list. The empty window offers it too. |
| `/setup-project` | coop-tools | Pi | The project wizard's questions, one dialog each. |
| `/setup-docs` | coop-tools | Pi | The docs wizard's questions, or a notice when coop-data-doc lacks the native wizard. |
| `/standards-status` | coop-tools | Pi | A notice and the JSON status in the conversation. |
| `/coop-live-read` | coop-tools | Pi | The live-read grant, or its revocation (`/coop-live-read revoke`). |
| `/coop-approvals` | coop-tools | Pi | Edit approvals (`status`, `revoke`). |
| `/coop-guardrails` | coop-guardrails | Pi | What the guardrails enforce. |
| `/coop-vibe` | coop-powerline | Pi | A vibe tip, as a notice. |
| `/coop-splash` | coop-powerline | Pi | A notice; the window's own header and empty state stand in for the terminal splash. |
| `/mcp` | pi-mcp-adapter | Pi | The MCP status report in the conversation. The server panel (enable, disable, reconnect) is a terminal screen: use Open in terminal. |
| `/mcp-adapter` | pi-mcp-adapter | Pi | Same as `/mcp`. |
| `/mcp-auth` | pi-mcp-adapter | terminal | The OAuth panel is terminal only (the extension says so). |
| `/memory-consolidate` | pi-hermes-memory | Pi | Progress notices and the result. |
| `/memory-insights` | pi-hermes-memory | Pi | The memory report in the conversation. |
| `/memory-skills` | pi-hermes-memory | terminal | The skills manager is a terminal component; in RPC it shows nothing. |
| `/memory-interview` | pi-hermes-memory | Pi | The interview runs as a conversation. |
| `/memory-switch-project` | pi-hermes-memory | Pi | A notice with the active project. |
| `/learn-memory-tool` | pi-hermes-memory | Pi | The guide, as a list. |
| `/memory-sync-markdown` | pi-hermes-memory | Pi | Progress notices and the result. |
| `/memory-preview-context` | pi-hermes-memory | Pi | The preview in the conversation. |
| `/memory-pin` | pi-hermes-memory | Pi | A notice; `/memory-pin <text>` pins. |
| `/memory-index-sessions` | pi-hermes-memory | Pi | Progress notices and the result. |
| `/fast` | pi-better-openai | Pi | A notice (fast mode needs an OpenAI subscription model). |
| `/openai-usage` | pi-better-openai | Pi | A notice; the usage text also shows in the status bar. |
| `/openai-settings` | pi-better-openai | terminal | The settings picker is terminal only (the extension says so). |
| `/openai-image` | pi-better-openai | Pi | `/openai-image <prompt>`. |
| `/pets` | pi-better-openai | terminal | Pets draw in the terminal footer. |
| `/websearch` | pi-web-access | Pi | Opens the search curator in the browser, as in the terminal. |
| `/curator` | pi-web-access | Pi | Toggles the curator workflow. |
| `/google-account` | pi-web-access | Pi | Answers in the conversation. |
| `/search` | pi-web-access | Pi | Stored results, as a list or a notice. |
| `/rename` | pi-lovely-rename | Pi | Names the session from the conversation. |
| `/ctx-stats` | context-mode | Pi | The statistics report in the conversation. |
| `/ctx-doctor` | context-mode | Pi | The diagnostics report in the conversation. |
| `/llama` | Pi | terminal | The llama.cpp manager is interactive-mode only (Pi says so). |

## Prompt templates and skills

Every `/name` prompt template and every `/skill:name` skill (coop's own, the
extensions', the Microsoft catalog's and team knowledge's) maps to **Pi**: the
window sends it as typed and completion lists it from `get_commands`, exactly
as the terminal's `/` menu does. They need no row each, because the window
never handles one itself.

## Extension UI

Pi's `docs/rpc-extension-ui.md`: what an extension can ask the window to show.

| Request | Maps to | In the window |
| --- | --- | --- |
| `select` | window | A list card with filtering; Esc cancels. |
| `confirm` | window | A card with Yes and No; No has the focus. |
| `input` | window | A card with a text field. |
| `editor` | window | A card with a multi-line editor. |
| `notify` | window | One-line notices are toasts; longer reports join the conversation. |
| `setStatus` | window | The status bar. |
| `setWidget` | window | Lines above or below the prompt. |
| `setTitle` | window | The window title. |
| `set_editor_text` | window | Fills the prompt. |
| `custom()`, `setFooter`, `setHeader`, `setEditorComponent`, `onTerminalInput` | terminal | Terminal-only drawing. Pi makes them no-ops in RPC; each pinned extension's use is listed under Extension commands, and those screens open in the terminal. |

## Model sign-in

The window never handles provider credentials. When no stored login exists it
shows a banner whose button opens the terminal on the same session, where
`/login` runs; Restart then picks the login up.
