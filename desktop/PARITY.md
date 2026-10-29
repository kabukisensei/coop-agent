# coop window: what it does, and what opens in the terminal

Master plan row D1b, section 11.1: the window is one way to run the same coop
session the terminal runs, and this file is the window's own contract. The
window's lists in `desktop/renderer/commands.mjs` are the product:

- **`BUILTINS`**: Pi's slash commands. Pi implements them in its terminal UI,
  so they do nothing in RPC mode and the window runs each one itself, or opens
  the terminal for it.
- **`KEYS`**: the window's keyboard shortcuts (`/hotkeys` shows the same table).
- **`TERMINAL_ONLY`**: the few extension commands whose screen exists only in
  a terminal; the window opens the terminal for them instead of sending them
  to Pi, where they would show nothing.

Everything else goes to Pi as typed: coop's extension commands, prompt
templates and skills (listed in completion from `get_commands`), and their
dialogs and notices show as cards, lists, toasts and conversation entries
(see Extension UI). Anything only a terminal can show, now or after a Pi or
extension upgrade, opens coop in a terminal on the same session (Windows), the
way "Open in terminal" does for every session; that is the default, so a new
terminal feature needs no row here and fails no test. A row is added when the
window takes a feature on, never because the terminal gained one.

Each row maps one capability to what the window does:

- **rpc**: the window sends Pi's RPC command for it.
- **window**: a control in the window does it (named in the row).
- **Pi**: the window sends the text to Pi as typed.
- **terminal**: the window opens coop in a terminal on the same session.

`tests/desktop.test.mjs` checks this file against the window's lists, and the
lists against Pi's own surface read from the docs in Pi's package when the
fixture was recorded (`tests/fixtures/desktop-pi-surface.json`, re-recorded
with `node desktop/scripts/record-fixture.mjs`): every Pi slash command is a
built-in or terminal-only (so a Pi upgrade that adds one is a one-line
decision in `commands.mjs`), every window shortcut stands for a Pi keybinding
action, and no built-in shadows an extension command in the recorded session
(`tests/fixtures/desktop-rpc.jsonl`, coop's release extensions loaded).

The window adds nothing to Pi's launch: `coop desktop` builds the same
arguments as `coop` (`Build-CoopPiArgs`) and the window runs them with
`--mode rpc`, never `--approve`, so project trust, guardrails, approvals,
standards and skills behave as in the terminal.

## Pi built-in commands

`BUILTINS`, one row each: Pi's `docs/slash-commands.md` (Pi 1.2.0). Pi
implements these in its terminal UI only, so the window runs each one itself.

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
| `/tree` | rpc | Tree view from `get_tree`: Pi's five filters, folding branches, labels, and Fork here (`fork`). Ctrl+Shift+T. Moving to another point in the same session and editing labels have no RPC command in Pi 1.2.0, so the view's Open in terminal button runs `/tree` there. |
| `/fork` | rpc | Pick an earlier prompt from `get_fork_messages`, then `fork`; the prompt comes back to the composer. Ctrl+Shift+F. |
| `/clone` | rpc | `clone`. |
| `/compact` | rpc | `compact` with the optional instructions after the command. |
| `/import` | terminal | Importing a session file is a terminal command. |
| `/copy` | window | Copies the last answer; every answer and code block also has a copy button. |
| `/export` | rpc | Save dialog, then `export_html` to the chosen file. Pi 1.2.0 has no RPC command for its JSONL export of the current branch (`/export <file>.jsonl`), so that form runs in Open in terminal. |
| `/share` | terminal | Uploading a session is a terminal command. |
| `/bug` | terminal | Pi's bug report flow is a terminal command. |
| `/trust` | terminal | Saving a project trust decision is a terminal screen; without one, the window loads no project-local Pi files, as `--mode rpc` does. |
| `/reload` | window | Restarts coop in the window on the same session (`--session`), which reloads extensions, skills and prompts. |
| `/hotkeys` | window | Keyboard shortcuts table (from `KEYS`). |
| `/changelog` | terminal | Pi's changelog viewer is a terminal screen. |
| `/quit` | window | Closes this tab, which stops its Pi and its children (the last tab closes the window). Ctrl+W. |

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

## Keyboard shortcuts

`KEYS`, one row each: the window's shortcuts, keyed by the Pi keybinding
action (`docs/keybindings.md`) each one stands for. Pi's other actions need
no key: the text box, lists and scroll areas do them natively (arrows, Home,
End, PageUp, Ctrl+Backspace, Ctrl+Z, Ctrl+C, the mouse), the tree view's
folds and Show list are its own controls, and the rest are terminal screens
(scoped models, tree labels, session delete, saving defaults) reached with
Open in terminal. The side pane's keys (Ctrl+\, Ctrl+Shift+D, Ctrl+Shift+S),
tabs (Ctrl+N, Ctrl+Tab, Ctrl+1 to 9), zoom and Ctrl+K are the window's own.

| Action | Maps to | In the window |
| --- | --- | --- |
| `app.interrupt` | rpc | Esc: `abort` (or `abort_bash`, `abort_retry`); queued messages come back to the prompt first (`clear_queue`). |
| `app.exit` | window | Ctrl+W closes the tab (the last tab closes the window). |
| `app.editor.external` | window | Ctrl+G opens a larger editor for the prompt. |
| `app.clipboard.pasteImage` | window | Ctrl+V, drag and drop or the paperclip attaches files (up to ten a message): images go with the prompt when the model reads them (five, 4 MB each); text files are referenced by path; Word, Excel, PowerPoint and PDF are read to Markdown (pdf.js in its own time-limited process) and referenced by path, so coop reads them through its guarded read tool. |
| `app.session.new` | rpc | Ctrl+Shift+N. |
| `app.session.tree` | rpc | Ctrl+Shift+T. |
| `app.session.fork` | rpc | Ctrl+Shift+F. |
| `app.session.resume` | window | Ctrl+Shift+R. |
| `app.model.select` | rpc | Ctrl+L. Pi's RPC cycles forward only, so the picker stands in for the backward cycle too. |
| `app.model.cycleForward` | rpc | Ctrl+P (`cycle_model`). A model picked here is remembered for new sessions (coop-router, `coop-model.json`); scoped model lists are the terminal's `/scoped-models`. |
| `app.thinking.cycle` | rpc | Shift+Tab. Saving the default level is the terminal's `/settings`. |
| `app.thinking.toggle` | window | Ctrl+T shows or hides thinking. |
| `app.tools.expand` | window | Ctrl+O expands or collapses tool output. |
| `app.message.followUp` | rpc | Alt+Enter or Ctrl+Q. |
| `app.message.dequeue` | rpc | Alt+Up (`clear_queue`, texts back in the prompt). |
| `tui.input.newLine` | window | Shift+Enter or Ctrl+J. |
| `tui.input.submit` | rpc | Enter (`prompt`, or `steer` while coop works). |
| `tui.input.tab` | window | Tab completes a `/command`, an `@file` or a path. |
| `tui.input.copy` | window | Ctrl+C copies the selection (Ctrl+C never interrupts in a window; Esc does). |
| `tui.editor.historyPrevious` | window | Up in an empty prompt. |
| `tui.editor.historyNext` | window | Down while browsing history. |
| `tui.altScreen.pageUp` | window | PageUp from the prompt scrolls the conversation. |
| `tui.altScreen.pageDown` | window | PageDown from the prompt scrolls the conversation. |
| `tui.altScreen.previousPrompt` | window | Ctrl+Up scrolls to the previous prompt you sent. |
| `tui.altScreen.nextPrompt` | window | Ctrl+Down scrolls to the next prompt you sent. |
| `tui.altScreen.search` | window | Ctrl+F searches the conversation. |
| `tui.altScreen.searchNext` | window | Enter (or Ctrl+G) in the search box: the earlier match. |
| `tui.altScreen.searchPrevious` | window | Shift+Enter in the search box: the later match. |
| `tui.altScreen.searchClose` | window | Esc (or the close button) closes the search. |

## Extension commands

Every extension command (`get_commands`, source `extension`: coop-tools,
coop-guardrails, coop-powerline, pi-mcp-adapter, pi-hermes-memory,
pi-better-openai, pi-web-access, pi-lovely-rename, rpiv-todo) maps to **Pi**:
the window sends it as typed and the answer shows as in the terminal, one-line
notices as toasts, longer reports in the conversation, dialogs as cards and
lists. They need no row each; a built-in never takes an extension command's
name (the test checks the recorded session). The exceptions are the commands
whose screen exists only in a terminal, listed in `TERMINAL_ONLY`, one row
each:

| Command | Extension | Maps to | In the window |
| --- | --- | --- | --- |
| `/mcp-auth` | pi-mcp-adapter | terminal | The OAuth panel is terminal only (the extension says so). `/mcp` itself answers in the conversation; its server panel (enable, disable, reconnect) is reached with Open in terminal. |
| `/memory-skills` | pi-hermes-memory | terminal | The skills manager is a terminal component; in RPC it shows nothing. |
| `/openai-settings` | pi-better-openai | terminal | The settings picker is terminal only (the extension says so). |
| `/pets` | pi-better-openai | terminal | Pets draw in the terminal footer. |
| `/llama` | Pi | terminal | The llama.cpp manager is interactive-mode only (Pi says so). |

Two extension screens the window draws itself: the Start Here menu (`/start`,
offered by the empty window and opened once on a profile's first launch,
`COOP_FIRST_RUN`, as the terminal does) and the todo panel (`rpiv-todo`, see
`setWidget` under Extension UI). The Standards pane (Ctrl+Shift+S) shows what
`/standards-status` reports, plus the team knowledge clones one note at a
time.

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
| `select` | window | A list card with filtering; Esc cancels. An `ask_user_question` (its RPC form numbers the options) shows as a question card: header, question, each option with its description; the value sent back is the option text as offered. |
| `confirm` | window | An approval card: the message's indented lines (the command or SQL) as a code block, the closing question last, the Yes button labelled with its verb ("Run it", "Allow"), No as the default with the focus. The answer is the same confirmed true or false. |
| `input` | window | A card with a text field. An `ask_user_question` multi-select (asked in RPC as "enter the numbers") shows as checkboxes plus a free-text field; the value sent back is the same comma-separated numbers or the typed text. |
| `editor` | window | A card with a multi-line editor. |
| `notify` | window | One-line notices are toasts; longer reports join the conversation. |
| `setStatus` | window | The status bar. |
| `setWidget` | window | Lines above or below the prompt. Alt+T collapses the ones above the prompt to their first line and a count. The todo panel (`rpiv-todo`) is the one exception: it uses the factory form, which Pi drops in RPC (only its removal arrives), so the window draws that panel itself from the session's `todo` tool results, on load from `get_messages` and then from every `todo` result, with the overlay's glyphs, row budget and "completed rows leave at the next turn" rule; after a compaction the same session keeps its panel, and a reload after one starts it at the next `todo` call. Alt+T collapses it to the heading, the key `coop sync` seeds for the terminal panel (`~/.config/rpiv-todo/config.json`; the extension's default, Ctrl+Shift+T, is Pi's tree key). |
| `setTitle` | window | The window title. |
| `set_editor_text` | window | Fills the prompt. |
| `custom()`, `setFooter`, `setHeader`, `setEditorComponent`, `onTerminalInput` | terminal | Terminal-only drawing. Pi makes them no-ops in RPC; each pinned extension's use is listed under Extension commands, and those screens open in the terminal. |

## Model sign-in

The window never handles provider credentials. When no stored login exists the
set-up card on the empty screen (and a banner once the conversation has
content) lists it with the other launch notices (`coop onboard`, `az login`),
each with a button that opens the terminal on the same session, where `/login`
runs; Restart then picks the login up.

## Menu bar and notifications

The window's own additions, no terminal counterpart: a File, Edit, View,
Session and Help menu bar (`desktop/lib/menu.mjs`; every entry runs one of the
window's actions above; View > Menu bar hides it, Alt shows it again) and a
Windows notification plus taskbar flash when a turn ends (`agent_end`) or an
extension asks a question while the window is in the background (Settings >
Notify in the background).

## Tabs (several sessions at once)

The window's own addition, matching how the terminal runs one coop per
console: each tab is one session with its own Pi process
(`desktop/lib/tabs.mjs`, `addTab` in `desktop/main.mjs`), so its approvals,
guardrails and questions are its own (phone access is one switch for the app;
a paired phone picks among the tabs, see Phone companion). Tabs share the window's
folder, launch spec and Warehouse target. Ctrl+N (or the strip's +) opens a
tab on a new session; New session or a click on another saved session while
coop works opens it in a new tab instead of refusing. Ctrl+W closes a tab,
Ctrl+Tab and Ctrl+Shift+Tab move between them, Ctrl+1 to Ctrl+9 jump. A tab
shows a dot while coop works and a mark while it waits on a question; a
background tab's finished turn or question gets the notification. A saved
session is open in one tab at most (`desktop/lib/session-owners.mjs`): picking
one that another tab or window holds brings that tab forward, and the phone's
session list leaves it out. File > New window opens another window on the same
folder.

## Phone companion

Master plan rows MC1–MC11 (section 12.4): what a paired phone can do with the
same live session, measured against the window's rows above. Aaron asked on
2026-10-06 for the phone to reach terminal parity over time. Each line is one
terminal capability with its phone status:

- **phone**: the phone does it today.
- **MCn**: a gap, closed by that plan row.
- **desk only**: deliberately not on the phone (the MC1 contract,
  `desktop/COMPANION.md`); not a gap.
- **not on a phone**: the window itself hands it to the terminal, or it ends
  the phone's own access; the reason is given.

### What the phone does today (MC2, MC3)

| Capability | Status | On the phone |
| --- | --- | --- |
| Read the session | phone | The conversation's prompts and answers (Markdown), tool lines, notices and coop's status, live, with resume after a dropped connection. |
| Send a message | phone | `prompt` when idle; while coop works Send now steers and Queue waits (`streamingBehavior`), as the window's Enter and Alt+Enter (MC6). |
| Stop a turn | phone | `abort` (the terminal's Esc). |
| Answer coop's questions | phone | `select`, `confirm`, `input`, `editor` and `ask_user_question` cards, first answer wins against the desk. |
| Theme | phone | Modern or Retro, dark or light, from the phone's menu; on the phone Retro is the coop website's look (MC5). Kept on the phone. |

### Gaps, in build order

| Capability | Status | What closes it |
| --- | --- | --- |
| Extension commands, prompt templates and skills (`/start`, `/standards-status`, `/todos`, `/memory-*`, `/rename`, `/websearch`, `/search`, `/approvals`, prompt templates such as `/spec-first`, `/skill:name`) | phone (MC6) | Typing `/` lists the commands Pi returned (`get_commands`) and sends the ones the window maps to **Pi** as typed; their dialogs and notices reach the phone. `/approvals` only shows or revokes, so it narrows access. |
| Steer while coop works (Enter) and pull back queued messages (`clear_queue`, Alt+Up) | phone (MC6) | Send now and Queue while coop works; the queued messages show above the text box, and Edit queued brings them back into it. |
| `/model`, `/thinking` (and Ctrl+P, Shift+Tab) | phone (MC7) | The menu's Model and Thinking sheets (`get_available_models`, `set_model`, `set_thinking_level`); a model must be one Pi lists. Typing `/model` or `/thinking` points to the menu. |
| `/compact`, `/session`, `/name`, `/copy` | phone (MC7) | The menu's Compact (with optional instructions, when coop is idle), Session details (`get_state`, `get_session_stats`, without file paths) and Name this session sheets, and Copy under every answer. |
| Thinking and tool detail (Ctrl+T, Ctrl+O) | phone (MC8) | A tool line opens its arguments and output on tap, and an answer's Thinking link opens its thinking; fetched only on tap (`GET /api/detail`). |
| Status bar, widgets and the todo panel (`setStatus`, `setWidget`, `rpiv-todo`) | phone (MC8) | Above the text box: the status line, the widgets and the todo panel rebuilt from `todo` results as the window does; a tap folds it to the status line. |
| Search the conversation, jump between prompts (Ctrl+F, Ctrl+Up/Down) and prompt history (Up) | phone (MC8) | The menu's Find: a search over the conversation, and with no search your prompts, newest first, each to jump to or Reuse. |
| `/new`, `/resume`, `/fork`, `/clone` and the sessions list (`coop -c`, `-r`, `--session`) | phone (MC9) | The menu's Sessions sheet: New session, the folder's saved sessions, Fork from a prompt and Clone. Phone access is one switch for the app (pair once), so a session started at either screen keeps it. |
| Tabs (several sessions at once) | phone (pair once) | Switch session in the menu lists every tab open on the phone's client, in every coop window, and moves the phone between them. |
| `/tree` (view) | phone (MC9) | Tree in the Sessions sheet: the window's default view, one line per prompt and answer, indented where the session branches; a tap on a prompt forks from it. Moving within the session and labels stay in the terminal's `/tree`, as in the window. |
| `/export` (HTML) | phone (MC9) | Export HTML in the Sessions sheet writes the page beside the session file on the VM (not in the project folder); the file stays on the VM. |
| `/reload` | phone (MC9) | Restart coop in the Sessions sheet: the window restarts coop on the same session as its own `/reload` does, and the phone keeps its access. |
| Attach images and files (`app.clipboard.pasteImage`) | phone (MC10) | Attach in the text box: photos (made JPEG, 2048 pixels on the long side, so a phone's camera photo fits the 4 MB image limit) and files, with the window's limits and readers. Each file is saved under the window's data folder on the VM, not in the project, and sent as the window sends attachments. |
| `@path` file mentions and Tab completion | phone (MC10) | Typing `@` lists the folder's files as the window's composer does (`listFiles`, `rankFiles`); a tap puts the path in the text box. |
| Know when coop needs you (the window's background notification) | phone (MC11) | Notices in the menu: when a question arrives or a turn ends while the page is closed, the phone shows "coop is waiting for you". Web push goes through Apple's or Google's push service, so the push carries nothing at all (Aaron said yes, 2026-10-06 03:34). On an iPhone, coop must be on the Home Screen. |

### Desk only (intentional)

| Capability | Status | Why |
| --- | --- | --- |
| Approving a production action (`PRODUCTION` confirms, the G1 production-write unlock) | desk only | MC1 contract: production stays at the desk; the phone can decline. |
| Options that allow more than the one action ("Allow … for this session", "always", "don't ask again") and `/trust` | desk only | MC1 contract: the phone answers for the exact action in front of it. Grants only ever come from those options; `/approvals` shows or revokes and works on the phone (MC6). |
| `!command` and `!!command` (a shell on the VM) | desk only | MC1 contract, confirmed by Aaron 2026-10-06 03:34: the phone is not a remote shell; coop's own tools still run commands under the guardrails when asked in chat. |

### Not on a phone

| Capability | Status | Why |
| --- | --- | --- |
| `/login`, `/logout`, `/mcp-auth`, `/google-account` sign-in | not on a phone | Credentials are entered on the VM; the window also hands them to the terminal. |
| `/scoped-models`, `/import`, `/share`, `/bug`, `/changelog`, `/memory-skills`, `/openai-settings`, `/pets`, `/llama`, tree label edits, session delete, saving the default thinking level | not on a phone | Terminal screens; the window opens them in a terminal on the VM too. `/share` and `/bug` upload a session, which the client-data rule keeps off client VMs anyway. |
| `/quit`, `app.exit`, `app.suspend`, `coop -p` | not on a phone | Closing the window ends the phone's access with no way back from the phone; suspend and print mode are not sessions. |
| Keyboard-only actions (cursor, selection, scrolling keys) | not on a phone | Touch does them natively; the gaps above cover every action that has an effect. |
