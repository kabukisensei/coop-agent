// What the composer understands. Pi's own slash commands belong to its
// terminal UI and do nothing in RPC mode, so the window runs each one itself
// (or hands it to the terminal); every other /command (coop's extensions,
// prompt templates, skills) goes to Pi as a prompt, exactly as typed.
// desktop/PARITY.md maps every entry here; tests/desktop.test.mjs checks it.

/** Pi 0.87.1 built-in slash commands (docs/slash-commands.md). */
export const BUILTINS = Object.freeze([
  { name: "settings", description: "Window and session settings", action: "settings" },
  { name: "model", args: "[provider/model]", description: "Pick a model", action: "model" },
  { name: "thinking", args: "[level]", description: "Set the thinking level", action: "thinking" },
  { name: "scoped-models", description: "Models used when cycling (opens the terminal)", action: "terminal" },
  { name: "login", args: "[provider]", description: "Sign in to a model provider (opens the terminal)", action: "terminal" },
  { name: "logout", description: "Sign out of a model provider (opens the terminal)", action: "terminal" },
  { name: "new", description: "Start a new session", action: "new" },
  { name: "resume", description: "Open another saved session", action: "resume" },
  { name: "name", args: "[name]", description: "Name this session, or show its name", action: "name" },
  { name: "session", description: "Session details and usage", action: "session" },
  { name: "tree", description: "The session's branches; fork from an earlier prompt", action: "tree" },
  { name: "fork", description: "Start a new session from an earlier prompt", action: "fork" },
  { name: "clone", description: "Duplicate this session where it is", action: "clone" },
  { name: "compact", args: "[instructions]", description: "Compact the conversation", action: "compact" },
  { name: "import", args: "<path>", description: "Import a session file (opens the terminal)", action: "terminal" },
  { name: "copy", description: "Copy the last answer", action: "copy" },
  { name: "export", description: "Export this session as a web page", action: "export" },
  { name: "share", description: "Upload this session (opens the terminal)", action: "terminal" },
  { name: "bug", args: "[description]", description: "Prepare a Pi bug report (opens the terminal)", action: "terminal" },
  { name: "trust", description: "Save a project trust decision (opens the terminal)", action: "terminal" },
  { name: "reload", description: "Restart coop in this window on this session", action: "reload" },
  { name: "hotkeys", description: "Keyboard shortcuts", action: "hotkeys" },
  { name: "changelog", description: "Pi's changelog (opens the terminal)", action: "terminal" },
  { name: "quit", description: "Close this window", action: "quit" },
]);

const BUILTIN_NAMES = new Map(BUILTINS.map((command) => [command.name, command]));

/**
 * Extension commands whose screen exists only in the terminal (a custom()
 * component or a terminal-only check), found by running every pinned
 * extension's commands in RPC mode (desktop/PARITY.md). The window hands
 * them to the terminal on the same session instead of sending them to Pi,
 * where they would show nothing or a "terminal only" note.
 */
export const TERMINAL_ONLY = Object.freeze({
  "mcp-auth": "the MCP sign-in panel (pi-mcp-adapter)",
  "memory-skills": "the memory skills manager (pi-hermes-memory)",
  "openai-settings": "the OpenAI settings picker (pi-better-openai)",
  "pets": "the footer pets (pi-better-openai)",
  "llama": "the llama.cpp model manager (Pi)",
});

/**
 * What a submitted composer text is: a shell command (`!cmd`, `!!cmd` keeps
 * the output out of the model's context), a built-in, or a prompt for Pi.
 */
export function parseInput(text) {
  const value = String(text || "");
  const trimmed = value.trim();
  if (trimmed.startsWith("!!")) return { kind: "bash", command: trimmed.slice(2).trim(), excluded: true };
  if (trimmed.startsWith("!") && trimmed.length > 1) return { kind: "bash", command: trimmed.slice(1).trim(), excluded: false };
  const slash = /^\/([A-Za-z0-9:._-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (slash && BUILTIN_NAMES.has(slash[1])) {
    return { kind: "builtin", command: BUILTIN_NAMES.get(slash[1]), arg: (slash[2] || "").trim() };
  }
  if (slash && Object.hasOwn(TERMINAL_ONLY, slash[1])) {
    return { kind: "builtin", command: { name: slash[1], action: "terminal", description: TERMINAL_ONLY[slash[1]] }, arg: (slash[2] || "").trim() };
  }
  return { kind: "prompt", text: value };
}

/**
 * Slash completions for the composer: built-ins first, then Pi's commands
 * (get_commands: extensions, prompt templates, skills), filtered by prefix.
 */
export function completions(text, piCommands = [], { limit = 60 } = {}) {
  const match = /^\/([A-Za-z0-9:._-]*)$/.exec(String(text || "").trimStart());
  if (!match) return [];
  const query = match[1].toLowerCase();
  const seen = new Set();
  const all = [];
  for (const command of BUILTINS) {
    seen.add(command.name);
    all.push({ name: command.name, args: command.args || "", description: command.description, source: "window" });
  }
  for (const command of Array.isArray(piCommands) ? piCommands : []) {
    if (!command || typeof command.name !== "string" || seen.has(command.name)) continue;
    seen.add(command.name);
    const terminal = Object.hasOwn(TERMINAL_ONLY, command.name);
    all.push({ name: command.name, args: "", description: `${firstLine(command.description)}${terminal ? " (opens the terminal)" : ""}`, source: String(command.source || "") });
  }
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(query));
  const contains = query ? all.filter((c) => !c.name.toLowerCase().startsWith(query) && c.name.toLowerCase().includes(query)) : [];
  return [...starts, ...contains].slice(0, limit);
}

function firstLine(text) {
  return String(text || "").replace(/^#+\s*/, "").split("\n")[0].slice(0, 160);
}

/**
 * Pi's keybinding actions (docs/keybindings.md) and what the window does for
 * each. `keys` is the window's shortcut; "" means a control in the window does
 * it (no key); "native" means the text box or list already behaves that way;
 * "terminal" means the action belongs to a terminal screen the window shows
 * differently.
 */
export const KEYS = Object.freeze({
  "app.interrupt": { keys: "Esc", does: "Stop the answer (or the running shell command, or a retry)" },
  "app.clear": { keys: "native", does: "Ctrl+C copies in a window; clear the box with Ctrl+A then Delete" },
  "app.exit": { keys: "Ctrl+W", does: "Close this tab (the last tab closes the window)" },
  "app.suspend": { keys: "terminal", does: "No job control in a window (none on Windows either)" },
  "app.editor.external": { keys: "Ctrl+G", does: "Open the prompt in a larger editor" },
  "app.clipboard.pasteImage": { keys: "Ctrl+V", does: "Paste an image or text into the prompt" },
  "app.session.new": { keys: "Ctrl+Shift+N", does: "New session" },
  "app.session.tree": { keys: "Ctrl+Shift+T", does: "Session tree" },
  "app.session.fork": { keys: "Ctrl+Shift+F", does: "Fork from an earlier prompt" },
  "app.session.resume": { keys: "Ctrl+Shift+R", does: "Sessions list" },
  "app.session.togglePath": { keys: "native", does: "The sessions list always shows the folder" },
  "app.session.toggleSort": { keys: "native", does: "The sessions list is newest first" },
  "app.session.toggleNamedFilter": { keys: "native", does: "Type in the sessions filter" },
  "app.session.rename": { keys: "", does: "Rename from the header's session name or /name" },
  "app.session.delete": { keys: "terminal", does: "Delete sessions from the terminal's /resume" },
  "app.session.deleteNoninvasive": { keys: "terminal", does: "Delete sessions from the terminal's /resume" },
  "app.model.select": { keys: "Ctrl+L", does: "Model picker" },
  "app.model.cycleForward": { keys: "Ctrl+P", does: "Next model" },
  "app.model.cycleBackward": { keys: "Ctrl+L", does: "Pick the model (Pi RPC cycles forward only)" },
  "app.models.save": { keys: "terminal", does: "Saving defaults is in the terminal's /model and /settings" },
  "app.thinking.cycle": { keys: "Shift+Tab", does: "Next thinking level" },
  "app.thinking.save": { keys: "terminal", does: "Saving defaults is in the terminal's /settings" },
  "app.thinking.toggle": { keys: "Ctrl+T", does: "Show or hide thinking" },
  "app.tools.expand": { keys: "Ctrl+O", does: "Expand or collapse tool output" },
  "app.message.copy": { keys: "", does: "Copy button on each answer, /copy for the last" },
  "app.message.followUp": { keys: "Alt+Enter", does: "Queue a follow-up while coop works (Ctrl+Q too)" },
  "app.message.dequeue": { keys: "Alt+Up", does: "Put queued messages back in the prompt" },
  "app.tree.foldOrUp": { keys: "", does: "Fold a branch in the tree view" },
  "app.tree.unfoldOrDown": { keys: "", does: "Unfold a branch in the tree view" },
  "app.tree.editLabel": { keys: "terminal", does: "Labels are edited in the terminal's /tree" },
  "app.tree.toggleLabelTimestamp": { keys: "terminal", does: "Labels are edited in the terminal's /tree" },
  "app.tree.filter.default": { keys: "", does: "Tree view: prompts and answers" },
  "app.tree.filter.noTools": { keys: "", does: "Tree view: everything but tool results" },
  "app.tree.filter.userOnly": { keys: "", does: "Tree view: prompts only" },
  "app.tree.filter.labeledOnly": { keys: "", does: "Tree view: labeled entries" },
  "app.tree.filter.all": { keys: "", does: "Tree view: everything" },
  "app.tree.filter.cycleForward": { keys: "Down", does: "Next filter in the tree view's Show list" },
  "app.tree.filter.cycleBackward": { keys: "Up", does: "Previous filter in the tree view's Show list" },
  "app.models.enableAll": { keys: "terminal", does: "Scoped models are set in the terminal" },
  "app.models.clearAll": { keys: "terminal", does: "Scoped models are set in the terminal" },
  "app.models.toggleProvider": { keys: "terminal", does: "Scoped models are set in the terminal" },
  "app.models.reorderUp": { keys: "terminal", does: "Scoped models are set in the terminal" },
  "app.models.reorderDown": { keys: "terminal", does: "Scoped models are set in the terminal" },
  "tui.input.newLine": { keys: "Shift+Enter", does: "New line in the prompt (Ctrl+J too)" },
  "tui.input.submit": { keys: "Enter", does: "Send (steers while coop works)" },
  "tui.input.tab": { keys: "Tab", does: "Complete a /command, an @file mention or a path" },
  "tui.input.copy": { keys: "Ctrl+C", does: "Copy the selection" },
  "tui.editor.historyPrevious": { keys: "Up", does: "Earlier prompt when the box is empty" },
  "tui.editor.historyNext": { keys: "Down", does: "Later prompt while browsing history" },
  "tui.editor.cursorUp": { keys: "native", does: "Arrow keys in the prompt" },
  "tui.editor.cursorDown": { keys: "native", does: "Arrow keys in the prompt" },
  "tui.editor.cursorLeft": { keys: "native", does: "Arrow keys in the prompt" },
  "tui.editor.cursorRight": { keys: "native", does: "Arrow keys in the prompt" },
  "tui.editor.cursorWordLeft": { keys: "native", does: "Ctrl+Left in the prompt" },
  "tui.editor.cursorWordRight": { keys: "native", does: "Ctrl+Right in the prompt" },
  "tui.editor.cursorLineStart": { keys: "native", does: "Home in the prompt" },
  "tui.editor.cursorLineEnd": { keys: "native", does: "End in the prompt" },
  "tui.editor.jumpForward": { keys: "native", does: "Word moves or the mouse in the prompt" },
  "tui.editor.jumpBackward": { keys: "native", does: "Word moves or the mouse in the prompt" },
  "tui.editor.pageUp": { keys: "native", does: "PageUp in a long prompt" },
  "tui.editor.pageDown": { keys: "native", does: "PageDown in a long prompt" },
  "tui.editor.deleteCharBackward": { keys: "native", does: "Backspace" },
  "tui.editor.deleteCharForward": { keys: "native", does: "Delete" },
  "tui.editor.deleteWordBackward": { keys: "native", does: "Ctrl+Backspace" },
  "tui.editor.deleteWordForward": { keys: "native", does: "Ctrl+Delete" },
  "tui.editor.deleteToLineStart": { keys: "native", does: "Shift+Home, then Delete" },
  "tui.editor.deleteToLineEnd": { keys: "native", does: "Shift+End, then Delete (Ctrl+K opens the command palette)" },
  "tui.editor.yank": { keys: "native", does: "Ctrl+X cuts and Ctrl+V pastes through the clipboard" },
  "tui.editor.yankPop": { keys: "native", does: "Ctrl+X cuts and Ctrl+V pastes through the clipboard" },
  "tui.editor.undo": { keys: "native", does: "Ctrl+Z in the prompt (Ctrl+Y redoes)" },
  "tui.select.up": { keys: "native", does: "Up in every list" },
  "tui.select.down": { keys: "native", does: "Down in every list" },
  "tui.select.pageUp": { keys: "native", does: "PageUp in every list" },
  "tui.select.pageDown": { keys: "native", does: "PageDown in every list" },
  "tui.select.confirm": { keys: "native", does: "Enter in every list" },
  "tui.select.cancel": { keys: "native", does: "Esc closes every list" },
  "tui.altScreen.pageUp": { keys: "PageUp", does: "Scroll the conversation up a page" },
  "tui.altScreen.pageDown": { keys: "PageDown", does: "Scroll the conversation down a page" },
  "tui.altScreen.halfPageUp": { keys: "native", does: "Mouse wheel or scroll bar" },
  "tui.altScreen.halfPageDown": { keys: "native", does: "Mouse wheel or scroll bar" },
  "tui.altScreen.lineUp": { keys: "native", does: "Arrow keys with the conversation focused" },
  "tui.altScreen.lineDown": { keys: "native", does: "Arrow keys with the conversation focused" },
  "tui.altScreen.top": { keys: "native", does: "Home with the conversation focused" },
  "tui.altScreen.bottom": { keys: "native", does: "End with the conversation focused; it follows new output" },
  "tui.altScreen.previousPrompt": { keys: "Ctrl+Up", does: "Scroll to the previous prompt you sent" },
  "tui.altScreen.nextPrompt": { keys: "Ctrl+Down", does: "Scroll to the next prompt you sent" },
  "tui.altScreen.search": { keys: "Ctrl+F", does: "Search this conversation" },
  "tui.altScreen.searchNext": { keys: "Enter", does: "Earlier match while searching (Ctrl+G too)" },
  "tui.altScreen.searchPrevious": { keys: "Shift+Enter", does: "Later match while searching" },
  "tui.altScreen.searchClose": { keys: "Esc", does: "Close the search" },
});
