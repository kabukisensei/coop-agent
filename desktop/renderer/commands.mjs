// What the composer understands. The window's own lists are the product:
// BUILTINS (Pi's slash commands belong to its terminal UI and do nothing in
// RPC mode, so the window runs each one itself or hands it to the terminal),
// TERMINAL_ONLY (the few extension screens that exist only in a terminal) and
// KEYS (the window's shortcuts). Every other /command (coop's extensions,
// prompt templates, skills) goes to Pi as a prompt, exactly as typed, and
// anything else a terminal can show opens in the terminal on the same session.
// desktop/PARITY.md documents these lists; tests/desktop.test.mjs checks that
// the file matches them and that Pi's own surface (tests/fixtures/
// desktop-pi-surface.json) leaves no Pi slash command unaccounted for.

/** Pi 1.2.0 built-in slash commands (docs/slash-commands.md). */
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
  for (const [name, description] of Object.entries(TERMINAL_ONLY)) {
    if (seen.has(name)) continue;
    seen.add(name);
    all.push({ name, args: "", description: `${description} (opens the terminal)`, source: "terminal" });
  }
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(query));
  const contains = query ? all.filter((c) => !c.name.toLowerCase().startsWith(query) && c.name.toLowerCase().includes(query)) : [];
  return [...starts, ...contains].slice(0, limit);
}

function firstLine(text) {
  return String(text || "").replace(/^#+\s*/, "").split("\n")[0].slice(0, 160);
}

/**
 * The window's keyboard shortcuts, each keyed by the Pi keybinding action
 * (docs/keybindings.md) it stands for, so /hotkeys and desktop/PARITY.md list
 * the same table. Pi actions the window has no key for are not listed: the
 * text box, lists and scroll areas do most of them natively, and the rest are
 * terminal screens (scoped models, tree labels, session delete) reached with
 * Open in terminal.
 */
export const KEYS = Object.freeze({
  "app.interrupt": { keys: "Esc", does: "Stop the answer (or the running shell command, or a retry)" },
  "app.exit": { keys: "Ctrl+W", does: "Close this tab (the last tab closes the window)" },
  "app.editor.external": { keys: "Ctrl+G", does: "Open the prompt in a larger editor" },
  "app.clipboard.pasteImage": { keys: "Ctrl+V", does: "Paste an image or text into the prompt" },
  "app.session.new": { keys: "Ctrl+Shift+N", does: "New session" },
  "app.session.tree": { keys: "Ctrl+Shift+T", does: "Session tree" },
  "app.session.fork": { keys: "Ctrl+Shift+F", does: "Fork from an earlier prompt" },
  "app.session.resume": { keys: "Ctrl+Shift+R", does: "Sessions list" },
  "app.model.select": { keys: "Ctrl+L", does: "Model picker" },
  "app.model.cycleForward": { keys: "Ctrl+P", does: "Next model" },
  "app.thinking.cycle": { keys: "Shift+Tab", does: "Next thinking level" },
  "app.thinking.toggle": { keys: "Ctrl+T", does: "Show or hide thinking" },
  "app.tools.expand": { keys: "Ctrl+O", does: "Expand or collapse tool output" },
  "app.message.followUp": { keys: "Alt+Enter", does: "Queue a follow-up while coop works (Ctrl+Q too)" },
  "app.message.dequeue": { keys: "Alt+Up", does: "Put queued messages back in the prompt" },
  "tui.input.newLine": { keys: "Shift+Enter", does: "New line in the prompt (Ctrl+J too)" },
  "tui.input.submit": { keys: "Enter", does: "Send (steers while coop works)" },
  "tui.input.tab": { keys: "Tab", does: "Complete a /command, an @file mention or a path" },
  "tui.input.copy": { keys: "Ctrl+C", does: "Copy the selection" },
  "tui.editor.historyPrevious": { keys: "Up", does: "Earlier prompt when the box is empty" },
  "tui.editor.historyNext": { keys: "Down", does: "Later prompt while browsing history" },
  "tui.altScreen.pageUp": { keys: "PageUp", does: "Scroll the conversation up a page" },
  "tui.altScreen.pageDown": { keys: "PageDown", does: "Scroll the conversation down a page" },
  "tui.altScreen.previousPrompt": { keys: "Ctrl+Up", does: "Scroll to the previous prompt you sent" },
  "tui.altScreen.nextPrompt": { keys: "Ctrl+Down", does: "Scroll to the next prompt you sent" },
  "tui.altScreen.search": { keys: "Ctrl+F", does: "Search this conversation" },
  "tui.altScreen.searchNext": { keys: "Enter", does: "Earlier match while searching (Ctrl+G too)" },
  "tui.altScreen.searchPrevious": { keys: "Shift+Enter", does: "Later match while searching" },
  "tui.altScreen.searchClose": { keys: "Esc", does: "Close the search" },
});
