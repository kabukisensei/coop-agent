// The coop window: timeline, composer, dialogs and the actions that stand in
// for Pi's terminal commands. Talks to coop only through window.coop
// (preload.cjs); the main process checks every call again.
import { el, icon, openModal, pickFrom, toast, modalOpen, relativeTime } from "./ui.mjs";
import { createTimeline, applyEvent, loadMessages, startBash, finishBash, formatTokens, textOf, notice } from "./timeline.mjs";
import { createFinder } from "./find.mjs";
import { renderItem, codeBlock } from "./view.mjs";
import { parseInput, completions, BUILTINS, KEYS } from "./commands.mjs";
import { registerPane, openPane, togglePane, closePane, currentPane, refreshPane, initPanes } from "./panes.mjs";
import { mountChanges } from "./pane-changes.mjs";
import { mountStandards } from "./pane-standards.mjs";
import { mountProject } from "./pane-project.mjs";
import { mountDocs } from "./pane-docs.mjs";

const coop = window.coop;
const $ = (id) => document.getElementById(id);
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (text) => String(text === undefined || text === null ? "" : text).replace(ANSI, "");
const THEME_LABELS = { auto: "Match Windows", "modern-dark": "Modern dark", "modern-light": "Modern light", "retro-dark": "Retro dark", "retro-light": "Retro light" };
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const app = {
  info: null,
  tl: createTimeline(),
  nodes: new Map(),
  dirty: new Set(),
  frame: 0,
  state: null,
  stats: null,
  commands: [],
  sessions: [],
  statuses: new Map(),
  widgets: new Map(),
  attachments: [],
  history: [],
  historyIndex: -1,
  draft: "",
  running: true,
  bashItem: null,
  completion: { items: [], active: 0 },
  prefs: {
    showThinking: false,
    expandTools: false,
    toolOpen: new Map(),
    thinkingOpen: new Map(),
    outputs: new Map(),
    outputState(key) {
      if (!this.outputs.has(key)) this.outputs.set(key, { all: false, redraw: () => {} });
      return this.outputs.get(key);
    },
    redrawOwner(toolCallId) { const owner = app.tl.toolOwner.get(toolCallId); if (owner) redraw(owner); },
    // The timeline's links into the side pane (a tool card's file, the standards).
    openPane: (id, options) => openPane(id, options),
  },
};

// --- Talking to Pi ------------------------------------------------------------

async function cmd(input) {
  try {
    const result = await coop.command(input);
    return result || { success: false, error: "no answer" };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function cmdOrToast(input, failure) {
  const result = await cmd(input);
  if (!result.success) toast(`${failure}: ${result.error || "unknown error"}`, "error");
  return result;
}

async function refreshState() {
  const result = await cmd({ type: "get_state" });
  if (result.success && result.data) {
    app.state = result.data;
    if (app.tl.sessionName === undefined && result.data.sessionName) app.tl.sessionName = result.data.sessionName;
    app.tl.thinkingLevel = result.data.thinkingLevel;
    renderHeader();
    renderBusy();
  }
}

async function refreshStats() {
  const result = await cmd({ type: "get_session_stats" });
  if (result.success && result.data) { app.stats = result.data; renderStatus(); }
}

async function refreshCommands() {
  const result = await cmd({ type: "get_commands" });
  if (result.success && result.data && Array.isArray(result.data.commands)) app.commands = result.data.commands;
}

/** Reload everything from Pi: after start, a session switch, new, fork. */
async function refreshAll() {
  const [state, messages] = await Promise.all([cmd({ type: "get_state" }), cmd({ type: "get_messages" })]);
  if (state.success && state.data) {
    app.state = state.data;
    app.tl.sessionName = state.data.sessionName;
    app.tl.thinkingLevel = state.data.thinkingLevel;
  }
  if (messages.success && messages.data) {
    loadMessages(app.tl, messages.data.messages);
    app.tl.busy = Boolean(app.state && app.state.isStreaming);
    app.tl.sessionName = app.state ? app.state.sessionName : undefined;
    app.tl.thinkingLevel = app.state ? app.state.thinkingLevel : undefined;
    renderTimeline();
  }
  renderHeader();
  renderBusy();
  refreshStats();
  refreshCommands();
  loadSessions();
}

// --- Events -------------------------------------------------------------------

function onEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "extension_ui_request") { onUiRequest(event); return; }
  const { changed, status } = applyEvent(app.tl, event);
  for (const id of changed) redraw(id);
  if (status) { renderBusy(); renderHeader(); }
  if (event.type === "agent_settled") {
    refreshState(); refreshStats(); loadSessions();
    // The changes pane follows coop's edits.
    if (currentPane() === "changes") refreshPane();
  }
  else if (event.type === "message_end" && event.message && event.message.role === "assistant") refreshStats();
}

function onExit({ code, reason, stderr }) {
  app.running = false;
  app.tl.busy = false;
  renderBusy();
  const detail = clean(stderr).trim();
  showBanner("error", `coop stopped${code !== null && code !== undefined ? ` (exit code ${code})` : ""}${reason ? `: ${reason}` : ""}.`, [
    { label: "Restart", kind: "primary", onClick: restart },
  ], detail);
}

function onUiRequest(request) {
  switch (request.method) {
    case "select": case "confirm": case "input": case "editor":
      showDialog(request);
      break;
    case "notify": {
      const level = ["info", "warning", "error"].includes(request.notifyType) ? request.notifyType : "info";
      const text = clean(request.message).trim();
      if (!text) break;
      // Reports (several lines, like /mcp or /ctx-stats) go in the conversation,
      // where the terminal prints them too; one-liners are toasts.
      if (text.includes("\n") || text.length > 200) redraw(notice(app.tl, level, text, { markdown: true }));
      else toast(text, level);
      break;
    }
    case "setStatus": {
      const key = String(request.statusKey || "");
      if (request.statusText) app.statuses.set(key, clean(request.statusText)); else app.statuses.delete(key);
      renderStatus();
      break;
    }
    case "setWidget": {
      const key = String(request.widgetKey || "");
      if (Array.isArray(request.widgetLines)) app.widgets.set(key, { lines: request.widgetLines.map(clean), placement: request.widgetPlacement === "belowEditor" ? "below" : "above" });
      else app.widgets.delete(key);
      renderWidgets();
      break;
    }
    case "set_editor_text":
      setPrompt(String(request.text || ""));
      break;
    default:
      break;
  }
}

// --- Extension dialogs (approvals, /start, wizards) ---------------------------

function answer(request, value) {
  coop.answer(request.id, value).then((result) => {
    if (result && result.success === false && result.error) toast(result.error, "warning");
  });
}

function showDialog(request) {
  let answered = false;
  const reply = (value) => { if (!answered) { answered = true; answer(request, value); } };
  const title = clean(request.title);
  let modal;
  if (request.method === "select") {
    const options = Array.isArray(request.options) ? request.options.map(String) : [];
    pickFrom({
      title: "coop",
      message: title,
      items: options.map((option) => ({ label: clean(option), value: option })),
      filter: options.length > 12,
    }).then((value) => reply(value === undefined ? { cancelled: true } : { value }));
  } else if (request.method === "confirm") {
    const body = el("div", { class: "dialog-text" }, el("p", { class: "dialog-message", text: clean(request.message) }));
    modal = openModal({
      title: title || "coop",
      body,
      className: "confirm",
      onCancel: () => reply({ cancelled: true }),
      buttons: [
        { label: "Yes", kind: "primary", onClick: () => reply({ confirmed: true }) },
        { label: "No", onClick: () => reply({ confirmed: false }) },
      ],
    });
    // The safe answer has the focus: Enter alone never approves.
    requestAnimationFrame(() => { const no = modal.root.querySelectorAll(".modal-buttons .btn")[1]; if (no) no.focus(); });
  } else {
    const multi = request.method === "editor";
    const field = multi
      ? el("textarea", { class: "field editor", rows: "14", autofocus: true, spellcheck: false })
      : el("input", { class: "field", type: "text", autofocus: true, placeholder: clean(request.placeholder) });
    field.value = String(multi ? request.prefill || "" : "");
    const submit = () => reply({ value: field.value });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (!multi || event.ctrlKey)) { event.preventDefault(); submit(); modal.close(); }
    });
    modal = openModal({
      title: multi ? title || "Edit" : "coop",
      body: el("div", { class: "dialog-text" }, multi ? null : el("p", { class: "dialog-message", text: title }), field, multi ? el("p", { class: "hint", text: "Ctrl+Enter saves" }) : null),
      wide: multi,
      onCancel: () => reply({ cancelled: true }),
      buttons: [{ label: multi ? "Save" : "OK", kind: "primary", onClick: submit }, { label: "Cancel", onClick: () => reply({ cancelled: true }) }],
    });
  }
  if (Number(request.timeout) > 0 && modal) {
    // Pi answers for the user when the question times out.
    setTimeout(() => { if (!answered) { answered = true; modal.close(); } }, Number(request.timeout));
  }
}

// --- Timeline -----------------------------------------------------------------

function redraw(id) {
  if (!id) return;
  app.dirty.add(id);
  if (!app.frame) app.frame = requestAnimationFrame(flush);
}

function nearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function flush() {
  app.frame = 0;
  const box = $("timeline");
  const stick = nearBottom(box);
  for (const id of app.dirty) {
    const item = app.tl.byId.get(id);
    if (!item) continue;
    const node = renderItem(item, app.tl, app.prefs);
    const old = app.nodes.get(id);
    if (old && old.isConnected) old.replaceWith(node); else box.append(node);
    app.nodes.set(id, node);
  }
  app.dirty.clear();
  renderEmpty();
  if (stick) box.scrollTop = box.scrollHeight;
  if (app.finder) app.finder.refresh();
}

function renderTimeline() {
  const box = $("timeline");
  app.nodes.clear();
  app.dirty.clear();
  box.replaceChildren(...app.tl.items.map((item) => {
    const node = renderItem(item, app.tl, app.prefs);
    app.nodes.set(item.id, node);
    return node;
  }));
  renderEmpty();
  box.scrollTop = box.scrollHeight;
  if (app.finder) app.finder.refresh();
}

/** Scroll to the previous or next prompt you sent (Ctrl+Up / Ctrl+Down). */
function jumpPrompt(direction) {
  const box = $("timeline");
  const users = [...box.querySelectorAll(".msg.user")];
  const top = box.getBoundingClientRect().top;
  const offset = (node) => node.getBoundingClientRect().top - top;
  const target = direction < 0 ? users.reverse().find((node) => offset(node) < -4) : users.find((node) => offset(node) > 4);
  if (target) target.scrollIntoView({ block: "start" });
  else if (direction > 0) box.scrollTop = box.scrollHeight;
}

function renderEmpty() {
  const box = $("timeline");
  const empty = box.querySelector(".empty");
  if (app.tl.items.length) { if (empty) empty.remove(); return; }
  if (empty) return;
  const start = el("button", { type: "button", class: "btn primary", text: "Open the Start menu", onclick: () => sendPrompt("/start") });
  const link = (id, label, glyph) => el("button", { type: "button", class: "btn ghost", onclick: () => openPane(id) }, icon(glyph), el("span", { text: label }));
  box.append(el("div", { class: "empty" },
    el("div", { class: "empty-mark" }, icon("spark")),
    el("h1", { text: "What are we working on?" }),
    el("p", { text: `coop is ready in ${app.info ? app.info.folder : "this folder"}. Ask a question, type / for commands, or start from a common task.` }),
    start,
    el("div", { class: "empty-links" },
      link("changes", "Changes", "diff"),
      link("standards", "Standards", "shield"),
      link("project", "Project settings", "form"),
      link("docs", "Lineage docs", "graph"))));
}

function rerenderAll() {
  for (const item of app.tl.items) redraw(item.id);
}

// --- Composer -----------------------------------------------------------------

function prompt() { return $("prompt"); }

function setPrompt(text) {
  const box = prompt();
  box.value = text;
  autosize();
  box.focus();
  box.setSelectionRange(text.length, text.length);
  updateCompletions();
}

function autosize() {
  const box = prompt();
  const max = Math.round(window.innerHeight * 0.4);
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, max)}px`;
  box.style.overflowY = box.scrollHeight > max ? "auto" : "hidden";
}

function clearPrompt() {
  prompt().value = "";
  app.attachments = [];
  renderAttachments();
  autosize();
  hideCompletions();
}

function pushHistory(text) {
  if (text.trim() && app.history[app.history.length - 1] !== text) app.history.push(text);
  if (app.history.length > 200) app.history.shift();
  app.historyIndex = -1;
}

async function sendPrompt(text, { followUp = false } = {}) {
  const images = app.attachments.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
  const input = { type: "prompt", message: text };
  if (images.length) input.images = images;
  if (app.tl.busy) input.streamingBehavior = followUp ? "followUp" : "steer";
  pushHistory(text);
  clearPrompt();
  const result = await cmd(input);
  if (!result.success) {
    toast(`coop did not take that message: ${result.error || "unknown error"}`, "error");
    if (!prompt().value) setPrompt(text);
  }
}

async function submit({ followUp = false } = {}) {
  const text = prompt().value;
  if (!text.trim() && !app.attachments.length) return;
  if (!app.running) { toast("coop is not running in this window. Restart it first.", "warning"); return; }
  const parsed = parseInput(text);
  if (parsed.kind === "builtin") {
    pushHistory(text);
    clearPrompt();
    await runAction(parsed.command.action, parsed.arg, parsed.command.name);
    return;
  }
  if (parsed.kind === "bash") {
    if (!parsed.command) return;
    pushHistory(text);
    clearPrompt();
    await runBash(parsed.command, parsed.excluded);
    return;
  }
  await sendPrompt(text, { followUp });
}

async function runBash(command, excluded) {
  if (app.bashItem) { toast("A shell command is still running. Press Esc to stop it.", "warning"); return; }
  const id = startBash(app.tl, command, excluded);
  app.bashItem = id;
  redraw(id);
  renderBusy();
  const result = await cmd({ type: "bash", command, excludeFromContext: excluded });
  finishBash(app.tl, id, result.success ? result.data : { output: result.error || "", exitCode: undefined });
  app.bashItem = null;
  redraw(id);
  renderBusy();
}

async function interrupt() {
  if (app.bashItem) { await cmd({ type: "abort_bash" }); return; }
  if (app.tl.retryNotice) { await cmd({ type: "abort_retry" }); }
  if (!app.tl.busy) return;
  // As in the terminal: queued messages come back to the prompt, then stop.
  const cleared = await cmd({ type: "clear_queue" });
  restoreQueued(cleared);
  await cmd({ type: "abort" });
}

function restoreQueued(result) {
  if (!result || !result.success || !result.data) return;
  const texts = [...(result.data.steering || []), ...(result.data.followUp || [])].map(String).filter(Boolean);
  if (!texts.length) return;
  const current = prompt().value;
  setPrompt([...texts, current].filter(Boolean).join("\n\n"));
}

async function dequeue() {
  restoreQueued(await cmd({ type: "clear_queue" }));
}

function historyStep(direction) {
  const box = prompt();
  if (!app.history.length) return false;
  if (app.historyIndex === -1) {
    if (direction > 0) return false;
    app.draft = box.value;
    app.historyIndex = app.history.length - 1;
  } else {
    app.historyIndex += direction;
  }
  if (app.historyIndex >= app.history.length) { app.historyIndex = -1; setPrompt(app.draft); return true; }
  app.historyIndex = Math.max(0, app.historyIndex);
  setPrompt(app.history[app.historyIndex]);
  return true;
}

function updateCompletions() {
  const mention = mentionAt();
  if (mention) { requestFiles(mention); return; }
  const items = completions(prompt().value, app.commands);
  app.completion = { items, active: 0, kind: "command" };
  renderCompletions();
}

/** The @ mention the cursor is in: Pi's "type @ to search for a file". */
function mentionAt() {
  const box = prompt();
  const before = box.value.slice(0, box.selectionStart);
  const match = /(^|\s)@("?[^\s"]*)$/.exec(before);
  return match ? { start: before.length - match[2].length - 1, end: box.selectionStart, query: match[2] } : null;
}

/** The path-like word before the cursor, for Tab completion (Pi's Tab). */
function pathTokenAt() {
  const box = prompt();
  const before = box.value.slice(0, box.selectionStart);
  const match = /(^|\s)([^\s@]+)$/.exec(before);
  if (!match || (match[2].startsWith("/") && match.index === 0 && !match[1])) return null;
  return { start: before.length - match[2].length, end: box.selectionStart, query: match[2], plain: true };
}

let fileRequest = 0;
function requestFiles(mention, locate = mentionAt) {
  const seq = ++fileRequest;
  setTimeout(async () => {
    if (seq !== fileRequest) return;
    const result = await coop.files(mention.query);
    const current = locate();
    if (seq !== fileRequest || !current || current.start !== mention.start) return;
    const paths = result && result.success && Array.isArray(result.data) ? result.data : [];
    app.completion = { items: paths.map((path) => ({ name: path, source: path.endsWith("/") ? "folder" : "file" })), active: 0, kind: "file", mention: current };
    renderCompletions();
  }, 80);
}

function hideCompletions() {
  fileRequest++;
  app.completion = { items: [], active: 0 };
  renderCompletions();
}

function renderCompletions() {
  const list = $("completions");
  const { items, active } = app.completion;
  list.hidden = !items.length;
  list.replaceChildren(...items.map((item, index) => el("li", {
    class: `completion ${index === active ? "active" : ""}`,
    role: "option",
    onmousedown: (event) => { event.preventDefault(); acceptCompletion(index); },
  }, el("span", { class: "completion-name", text: app.completion.kind !== "file" ? `/${item.name}` : app.completion.mention.plain ? item.name : `@${item.name}` }), el("span", { class: "completion-args", text: item.args || "" }), el("span", { class: "completion-desc", text: item.description || "" }), el("span", { class: "completion-source", text: sourceLabel(item.source) }))));
  const node = list.children[active];
  if (node) node.scrollIntoView({ block: "nearest" });
}

function sourceLabel(source) {
  return { window: "window", extension: "coop", prompt: "prompt", skill: "skill", file: "file", folder: "folder" }[source] || source;
}

function acceptCompletion(index) {
  const item = app.completion.items[index];
  if (!item) return;
  if (app.completion.kind === "file") {
    // Pi's form: @path, quoted when it has a space; a folder keeps the search open.
    const { start, end } = app.completion.mention;
    const box = prompt();
    const folder = item.name.endsWith("/");
    const at = app.completion.mention.plain ? "" : "@";
    const mention = /\s/.test(item.name) ? `${at}"${item.name}"` : `${at}${item.name}`;
    const insert = folder ? mention.replace(/"$/, "") : `${mention} `;
    box.value = `${box.value.slice(0, start)}${insert}${box.value.slice(end)}`;
    box.setSelectionRange(start + insert.length, start + insert.length);
    autosize();
    if (folder && !app.completion.mention.plain) updateCompletions();
    else if (folder) requestFiles(pathTokenAt(), pathTokenAt);
    else hideCompletions();
    return;
  }
  setPrompt(`/${item.name} `);
  hideCompletions();
}

function readImage(file) {
  return new Promise((resolve) => {
    if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { resolve(null); return; }
    if (file.size > 4 * 1024 * 1024) { toast("That image is over 4 MB.", "warning"); resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      const comma = url.indexOf(",");
      resolve(comma > 0 ? { mimeType: file.type, data: url.slice(comma + 1), url, name: file.name || "image" } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  const model = app.state && app.state.model;
  if (model && Array.isArray(model.input) && !model.input.includes("image")) {
    toast(`${model.name || model.id} does not read images. Pick another model to attach one.`, "warning");
    return;
  }
  for (const file of files) {
    if (app.attachments.length >= 5) { toast("Five images at most per message.", "warning"); break; }
    const image = await readImage(file);
    if (image) app.attachments.push(image);
  }
  renderAttachments();
}

function renderAttachments() {
  const box = $("attachments");
  box.hidden = !app.attachments.length;
  box.replaceChildren(...app.attachments.map((image, index) => el("div", { class: "attachment" },
    el("img", { src: image.url, alt: image.name }),
    el("button", { type: "button", class: "btn icon", title: "Remove", onclick: () => { app.attachments.splice(index, 1); renderAttachments(); } }, icon("close", "Remove")))));
}

function biggerEditor() {
  const field = el("textarea", { class: "field editor", rows: "18", autofocus: true });
  field.value = prompt().value;
  const done = () => setPrompt(field.value);
  field.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); done(); modal.close(); } });
  const modal = openModal({ title: "Write your message", body: el("div", {}, field, el("p", { class: "hint", text: "Ctrl+Enter puts it back in the prompt" })), wide: true, buttons: [{ label: "Done", kind: "primary", onClick: done }, { label: "Cancel" }] });
}

// --- Header, status bar, banners ---------------------------------------------

function modelLabel() {
  const model = app.state && app.state.model;
  return model ? model.name || model.id : "No model";
}

function renderHeader() {
  const info = app.info || {};
  $("folderName").textContent = info.folder || "";
  $("folderName").title = info.cwd || "";
  $("branchName").textContent = info.branch || "";
  $("branchName").hidden = !info.branch;
  const name = app.tl.sessionName || (app.state && app.state.sessionName) || "";
  const file = app.state && app.state.sessionFile;
  const saved = file ? app.sessions.find((session) => session.path === file) : null;
  $("sessionName").textContent = name || (saved && saved.title) || "New session";
  $("modelButton").replaceChildren(el("span", { class: "pill-label", text: modelLabel() }));
  const level = app.tl.thinkingLevel || (app.state && app.state.thinkingLevel) || "";
  const reasoning = app.state && app.state.model && app.state.model.reasoning;
  $("thinkingButton").hidden = !reasoning;
  $("thinkingButton").textContent = `Thinking: ${level || "off"}`;
  $("terminalButton").hidden = !info.canOpenTerminal;
}

function renderBusy() {
  const busy = app.tl.busy;
  document.body.classList.toggle("busy", busy);
  $("stopButton").hidden = !(busy || app.bashItem);
  $("queueButton").hidden = !busy;
  $("sendButton").replaceChildren(icon("send"), el("span", { text: busy ? "Steer" : "Send" }));
  $("sendButton").title = busy ? "Send now and steer coop (Enter)" : "Send (Enter)";
  $("composerHint").textContent = busy
    ? "Enter steers now, Alt+Enter queues it for when coop finishes, Esc stops"
    : app.bashItem ? "A shell command is running; Esc stops it" : "Enter to send, Shift+Enter for a new line, / for commands, ! runs a shell command";
  prompt().disabled = !app.running;
  const queue = app.tl.queue;
  const queued = [...queue.steering.map((text) => ["Steering", text]), ...queue.followUp.map((text) => ["Queued", text])];
  const box = $("queue");
  box.hidden = !queued.length;
  box.replaceChildren(...queued.map(([kind, text]) => el("div", { class: "queued" }, el("span", { class: "chip", text: kind }), el("span", { class: "queued-text", text }))),
    el("button", { type: "button", class: "btn link", text: "Edit queued (Alt+Up)", onclick: dequeue }));
}

function renderStatus() {
  const bar = $("statusbar");
  const parts = [];
  const stats = app.stats;
  if (stats && stats.contextUsage && stats.contextUsage.contextWindow) {
    const pct = Math.max(0, Math.min(100, Math.round(stats.contextUsage.percent || 0)));
    const fill = el("span", { class: "meter-fill" });
    fill.style.width = `${pct}%`; // CSSOM: the page's CSP allows no inline style attributes
    parts.push(el("span", { class: `status-item context ${pct >= 80 ? "high" : ""}`, title: `${formatTokens(stats.contextUsage.tokens)} of ${formatTokens(stats.contextUsage.contextWindow)} tokens in context` },
      el("span", { class: "meter" }, fill), el("span", { text: `${pct}% context` })));
  }
  if (stats && stats.tokens) parts.push(el("span", { class: "status-item", title: "Tokens this session: in / out", text: `${formatTokens(stats.tokens.input)} in, ${formatTokens(stats.tokens.output)} out` }));
  if (stats && Number(stats.cost) > 0) parts.push(el("span", { class: "status-item", text: `$${Number(stats.cost).toFixed(2)}` }));
  for (const [key, text] of app.statuses) parts.push(el("span", { class: "status-item ext", title: key, text }));
  const left = el("span", { class: "status-left" }, el("span", { class: "status-item status-brand", text: `coop${app.info && app.info.version ? ` v${app.info.version}` : ""}` }), el("span", { class: "status-item", text: app.running ? (app.tl.busy ? "Working" : "Ready") : "Stopped" }));
  bar.replaceChildren(left, el("span", { class: "status-right" }, parts));
}

function renderWidgets() {
  for (const placement of ["above", "below"]) {
    const box = $(placement === "above" ? "widgetsAbove" : "widgetsBelow");
    const widgets = [...app.widgets.entries()].filter(([, widget]) => widget.placement === placement);
    box.hidden = !widgets.length;
    box.replaceChildren(...widgets.map(([key, widget]) => el("pre", { class: "widget", title: key }, el("code", { text: widget.lines.join("\n") }))));
  }
}

function showBanner(level, text, actions = [], detail = "") {
  const banner = $("banner");
  banner.hidden = false;
  banner.className = `banner ${level}`;
  banner.replaceChildren(...[icon("warn"), el("span", { class: "banner-text", text }),
    ...actions.map((action) => el("button", { type: "button", class: `btn ${action.kind || ""}`, text: action.label, onclick: action.onClick })),
    el("button", { type: "button", class: "btn icon", title: "Dismiss", onclick: () => { banner.hidden = true; } }, icon("close", "Dismiss")),
    detail ? el("details", { class: "banner-detail" }, el("summary", { text: "Details" }), el("pre", {}, el("code", { text: detail }))) : null].filter(Boolean));
}

// --- Theme --------------------------------------------------------------------

function applyTheme({ theme, systemDark }) {
  if (app.info) { app.info.theme = theme; app.info.systemDark = systemDark; }
  const resolved = theme === "auto" ? (systemDark ? "modern-dark" : "modern-light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.style = resolved.startsWith("retro") ? "retro" : "modern";
}

async function chooseTheme() {
  const current = app.info ? app.info.theme : "auto";
  const value = await pickFrom({ title: "Theme", items: Object.entries(THEME_LABELS).map(([id, label]) => ({ label, value: id })), filter: false, current });
  if (value) await coop.setTheme(value);
}

// --- Sessions -----------------------------------------------------------------

async function loadSessions() {
  const result = await coop.sessions();
  if (result && result.success) { app.sessions = result.data || []; renderSessions(); renderHeader(); }
}

function sessionLabel(session) {
  return session.name || session.title || "Untitled session";
}

function renderSessions() {
  const filter = $("sessionFilter").value.trim().toLowerCase();
  const current = app.state && app.state.sessionFile;
  const shown = app.sessions.filter((session) => !filter || `${session.name} ${session.title}`.toLowerCase().includes(filter));
  $("sessionList").replaceChildren(...shown.map((session) => el("li", {},
    el("button", {
      type: "button",
      class: `session ${session.path === current ? "current" : ""}`,
      title: session.title || session.name || "",
      onclick: () => switchSession(session.path),
    }, el("span", { class: "session-title", text: sessionLabel(session) }), el("span", { class: "session-meta", text: `${relativeTime(session.modified)} · ${session.messages} ${session.messages === 1 ? "prompt" : "prompts"}` })))));
  if (!shown.length) $("sessionList").append(el("li", { class: "session-empty", text: filter ? "No session matches." : "No saved sessions in this folder yet." }));
}

async function switchSession(path) {
  if (app.state && path === app.state.sessionFile) return;
  if (app.tl.busy) { toast("coop is working. Stop it (Esc) before switching sessions.", "warning"); return; }
  const result = await cmdOrToastSwitch(path);
  if (result.success && !(result.data && result.data.cancelled)) await refreshAll();
}

async function cmdOrToastSwitch(path) {
  const result = await coop.switchSession(path);
  if (!result.success) toast(`Could not open that session: ${result.error || "unknown error"}`, "error");
  return result;
}

// --- Actions (Pi's terminal commands, done the window's way) -------------------

async function openTerminal(hint) {
  const result = await coop.openTerminal();
  if (result.success) toast(hint ? `coop opened in a terminal on this session. ${hint}` : "coop opened in a terminal on this session.", "info");
  else toast(result.error || "Could not open a terminal.", "warning");
}

async function restart() {
  $("banner").hidden = true;
  app.running = true;
  app.statuses.clear();
  app.widgets.clear();
  renderWidgets();
  const result = await coop.restart();
  if (!result.success) { toast(result.error || "Could not restart coop.", "error"); return; }
  await refreshAll();
  toast("coop restarted on this session.", "info");
}

async function pickModel(arg) {
  const result = await cmdOrToast({ type: "get_available_models" }, "Could not list models");
  if (!result.success) return;
  const models = (result.data && result.data.models) || [];
  if (arg) {
    const [provider, ...rest] = arg.split("/");
    const id = rest.join("/");
    const match = models.find((m) => (id ? m.provider === provider && m.id === id : m.id === arg || m.name === arg));
    if (!match) { toast(`No model called ${arg}.`, "warning"); return; }
    await setModel(match);
    return;
  }
  const current = app.state && app.state.model ? `${app.state.model.provider}/${app.state.model.id}` : "";
  const value = await pickFrom({
    title: "Model",
    items: models.map((m) => ({ label: m.name || m.id, detail: `${m.provider}/${m.id}`, hint: m.contextWindow ? `${formatTokens(m.contextWindow)} context` : "", value: `${m.provider}/${m.id}` })),
    placeholder: "Filter models",
    current,
  });
  if (!value) return;
  const model = models.find((m) => `${m.provider}/${m.id}` === value);
  if (model) await setModel(model);
}

async function setModel(model) {
  const result = await cmdOrToast({ type: "set_model", provider: model.provider, modelId: model.id }, "Could not switch the model");
  if (result.success) { await refreshState(); refreshStats(); }
}

async function pickThinking(arg) {
  if (arg) {
    if (!THINKING.includes(arg)) { toast(`Thinking levels: ${THINKING.join(", ")}.`, "warning"); return; }
    await cmdOrToast({ type: "set_thinking_level", level: arg }, "Could not set the thinking level");
    await refreshState();
    return;
  }
  const result = await cmd({ type: "get_available_thinking_levels" });
  const levels = result.success && result.data && Array.isArray(result.data.levels) ? result.data.levels : THINKING;
  const value = await pickFrom({ title: "Thinking level", items: levels.map((level) => ({ label: level, value: level })), filter: false, current: app.tl.thinkingLevel });
  if (value) { await cmdOrToast({ type: "set_thinking_level", level: value }, "Could not set the thinking level"); await refreshState(); }
}

async function renameSession(arg) {
  if (arg) {
    const result = await cmdOrToast({ type: "set_session_name", name: arg }, "Could not rename the session");
    if (result.success) { app.tl.sessionName = arg.trim(); renderHeader(); loadSessions(); }
    return;
  }
  const field = el("input", { class: "field", type: "text", autofocus: true });
  field.value = app.tl.sessionName || "";
  const save = async () => { if (field.value.trim()) await renameSession(field.value.trim()); };
  field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); save(); modal.close(); } });
  const modal = openModal({ title: "Name this session", body: field, buttons: [{ label: "Save", kind: "primary", onClick: () => { save(); } }, { label: "Cancel" }] });
}

async function sessionInfo() {
  const [state, stats] = await Promise.all([cmd({ type: "get_state" }), cmd({ type: "get_session_stats" })]);
  const s = state.success ? state.data : {};
  const t = stats.success ? stats.data : {};
  const rows = [
    ["Name", app.tl.sessionName || "Not named"],
    ["Folder", app.info.cwd],
    ["Session file", s.sessionFile || "Not saved"],
    ["Model", s.model ? `${s.model.name || s.model.id} (${s.model.provider})` : "None"],
    ["Thinking", s.thinkingLevel || "off"],
    ["Prompts", t.userMessages],
    ["Answers", t.assistantMessages],
    ["Tool calls", t.toolCalls],
    ["Tokens", t.tokens ? `${formatTokens(t.tokens.input)} in, ${formatTokens(t.tokens.output)} out, ${formatTokens(t.tokens.cacheRead)} cached` : ""],
    ["Cost", t.cost !== undefined ? `$${Number(t.cost).toFixed(4)}` : ""],
    ["Context", t.contextUsage ? `${formatTokens(t.contextUsage.tokens)} of ${formatTokens(t.contextUsage.contextWindow)} (${Math.round(t.contextUsage.percent || 0)}%)` : ""],
    ["Auto-compact", s.autoCompactionEnabled ? "On" : "Off"],
    ["Steering", s.steeringMode || ""],
    ["Follow-ups", s.followUpMode || ""],
  ].filter(([, value]) => value !== undefined && value !== "");
  openModal({
    title: "This session",
    wide: true,
    body: el("dl", { class: "facts" }, rows.flatMap(([key, value]) => [el("dt", { text: key }), el("dd", { text: String(value) })])),
    buttons: [{ label: "Copy file path", onClick: () => { if (s.sessionFile) coop.copy(s.sessionFile); return false; } }, { label: "Close", kind: "primary" }],
  });
}

async function forkSession() {
  const result = await cmdOrToast({ type: "get_fork_messages" }, "Could not list earlier prompts");
  if (!result.success) return;
  const messages = (result.data && result.data.messages) || [];
  if (!messages.length) { toast("There is no earlier prompt to fork from yet.", "info"); return; }
  const entryId = await pickFrom({ title: "Fork from an earlier prompt", message: "coop starts a new session from just before that prompt and puts the prompt back in the box.", items: messages.map((m) => ({ label: String(m.text || "").split("\n")[0].slice(0, 200), value: m.entryId })).reverse(), placeholder: "Filter prompts" });
  if (entryId) await doFork(entryId);
}

async function doFork(entryId) {
  const fork = await cmdOrToast({ type: "fork", entryId }, "Could not fork");
  if (!fork.success || (fork.data && fork.data.cancelled)) return;
  await refreshAll();
  if (fork.data && typeof fork.data.text === "string") setPrompt(fork.data.text);
  toast("Forked into a new session.", "info");
}

const TREE_FILTERS = [
  ["default", "Prompts and answers"],
  ["noTools", "Everything but tool results"],
  ["userOnly", "Prompts only"],
  ["labeledOnly", "Labeled entries"],
  ["all", "Everything"],
];

function treeEntryText(entry) {
  const message = entry.message || {};
  if (message.role === "assistant") {
    const text = textOf(message.content);
    if (text) return text;
    const tools = (Array.isArray(message.content) ? message.content : []).filter((c) => c && c.type === "toolCall").map((c) => c.name);
    return tools.length ? `Runs ${tools.join(", ")}` : "";
  }
  if (message.role === "toolResult") return `${message.toolName || "tool"}: ${textOf(message.content)}`;
  return textOf(message.content) || message.summary || entry.summary || entry.customType || entry.type || "";
}

async function showTree() {
  const result = await cmdOrToast({ type: "get_tree" }, "Could not read the session tree");
  if (!result.success) return;
  const tree = (result.data && result.data.tree) || [];
  const leaf = result.data && result.data.leafId;
  let filter = "default";
  const list = el("div", { class: "tree" });
  const draw = () => list.replaceChildren(...tree.map(drawChain));
  const shown = (node, role) => {
    if (filter === "userOnly") return role === "user";
    if (filter === "labeledOnly") return Boolean(node.label);
    if (filter === "noTools") return role !== "toolResult";
    if (filter === "default") return ["user", "assistant", "compactionSummary", "branchSummary", "compaction", "branch_summary"].includes(role);
    return true;
  };
  const rowFor = (node) => {
    const entry = node.entry || {};
    const message = entry.message || {};
    const role = message.role || entry.type;
    if (role === "system" || !shown(node, role)) return null;
    const text = clean(treeEntryText(entry)).split("\n")[0].slice(0, 160);
    if (!text && !node.label) return null;
    return el("div", { class: `tree-row ${role} ${entry.id === leaf ? "leaf" : ""}` },
      el("span", { class: "tree-role", text: role === "user" ? "You" : role === "assistant" ? "coop" : role === "toolResult" ? "tool" : role }),
      node.label ? el("span", { class: "chip", text: node.label }) : null,
      el("span", { class: "tree-text", text }),
      role === "user" ? el("button", { type: "button", class: "btn link", text: "Fork here", onclick: () => { modal.close(); doFork(entry.id); } }) : null);
  };
  // A session is one long chain; indent (and fold) only where it branches.
  const drawChain = (start) => {
    const box = el("div", { class: "tree-chain" });
    let node = start;
    while (node) {
      const row = rowFor(node);
      if (row) box.append(row);
      const kids = node.children || [];
      if (kids.length === 1) { node = kids[0]; continue; }
      if (kids.length > 1) box.append(el("details", { class: "tree-children", open: true }, el("summary", { text: `${kids.length} branches` }), ...kids.map(drawChain)));
      node = null;
    }
    return box;
  };
  const picker = el("select", { class: "field", "aria-label": "Show", onchange: (event) => { filter = event.target.value; draw(); } },
    TREE_FILTERS.map(([value, label]) => el("option", { value, text: label, selected: value === filter })));
  const modal = openModal({ title: "Session tree", wide: true, body: el("div", {}, el("div", { class: "tree-tools" }, picker, el("span", { class: "hint", text: "Fork here starts a new session from that prompt. Moving within this session and labels are in the terminal's /tree." })), list), buttons: [{ label: "Open in terminal", onClick: () => { openTerminal("Run /tree there."); } }, { label: "Close", kind: "primary" }] });
  draw();
}

async function compact(arg) {
  toast("Compacting the conversation...", "info");
  const result = await cmdOrToast(arg ? { type: "compact", customInstructions: arg } : { type: "compact" }, "Could not compact");
  if (result.success) { await refreshAll(); }
}

async function copyLast() {
  const result = await cmdOrToast({ type: "get_last_assistant_text" }, "Could not read the last answer");
  if (!result.success) return;
  const text = result.data && result.data.text;
  if (!text) { toast("There is no answer to copy yet.", "info"); return; }
  await coop.copy(text);
  toast("Copied the last answer.", "info");
}

async function exportSession(arg = "") {
  // Pi's JSONL export of the current branch has no RPC command (desktop/PARITY.md).
  if (/\.jsonl"?$/i.test(arg.trim())) { await openTerminal(`Run /export ${arg.trim()} there.`); return; }
  const result = await coop.exportHtml();
  if (result.cancelled) return;
  if (result.success) toast(`Exported${result.data && result.data.path ? ` to ${result.data.path}` : ""}.`, "info");
  else toast(`Could not export: ${result.error || "unknown error"}`, "error");
}

async function newSession() {
  if (app.tl.busy) { toast("coop is working. Stop it (Esc) before starting a new session.", "warning"); return; }
  const result = await cmdOrToast({ type: "new_session" }, "Could not start a new session");
  if (result.success && !(result.data && result.data.cancelled)) { await refreshAll(); prompt().focus(); }
}

async function cloneSession() {
  const result = await cmdOrToast({ type: "clone" }, "Could not clone the session");
  if (result.success && !(result.data && result.data.cancelled)) { await refreshAll(); toast("Cloned into a new session.", "info"); }
}

function settingsPanel() {
  const s = app.state || {};
  const row = (label, control, help) => el("div", { class: "setting" }, el("div", { class: "setting-label" }, el("span", { text: label }), help ? el("span", { class: "hint", text: help }) : null), control);
  const select = (options, value, onChange) => {
    const node = el("select", { class: "field", onchange: (event) => onChange(event.target.value) }, options.map(([v, l]) => el("option", { value: v, text: l, selected: v === value })));
    return node;
  };
  const toggle = (checked, onChange) => el("input", { type: "checkbox", class: "switch", checked, onchange: (event) => onChange(event.target.checked) });
  const body = el("div", { class: "settings" },
    row("Theme", select(Object.entries(THEME_LABELS), app.info.theme, (v) => coop.setTheme(v))),
    row("Auto-compact", toggle(Boolean(s.autoCompactionEnabled), async (v) => { await cmdOrToast({ type: "set_auto_compaction", enabled: v }, "Could not change auto-compact"); refreshState(); }), "Compact the conversation when the context is nearly full"),
    row("Auto-retry", toggle(true, (v) => cmdOrToast({ type: "set_auto_retry", enabled: v }, "Could not change auto-retry")), "Retry a failed model call"),
    row("Steering", select([["one-at-a-time", "One message at a time"], ["all", "All at once"]], s.steeringMode, async (v) => { await cmdOrToast({ type: "set_steering_mode", mode: v }, "Could not change steering"); refreshState(); }), "How messages you send while coop works are delivered"),
    row("Follow-ups", select([["one-at-a-time", "One message at a time"], ["all", "All at once"]], s.followUpMode, async (v) => { await cmdOrToast({ type: "set_follow_up_mode", mode: v }, "Could not change follow-ups"); refreshState(); })),
    row("Show thinking", toggle(app.prefs.showThinking, (v) => { app.prefs.showThinking = v; app.prefs.thinkingOpen.clear(); rerenderAll(); }), "Ctrl+T"),
    row("Expand tool output", toggle(app.prefs.expandTools, (v) => { app.prefs.expandTools = v; app.prefs.toolOpen.clear(); rerenderAll(); }), "Ctrl+O"),
    el("p", { class: "hint", text: "Pi's other settings (default model, scoped models, terminal display) are in the terminal's /settings." }));
  openModal({ title: "Settings", body, wide: true, buttons: [{ label: "Open in terminal", onClick: () => { openTerminal("Run /settings there."); } }, { label: "Done", kind: "primary" }] });
}

function hotkeys() {
  const rows = [
    ["Ctrl+K", "Command palette: every action and /command"],
    // The tree view's own controls are listed in that view, not here.
    ...Object.entries(KEYS).filter(([id, k]) => !id.startsWith("app.tree.") && k.keys && k.keys !== "native" && k.keys !== "terminal").map(([, k]) => [k.keys, k.does]),
    ["Ctrl+= / Ctrl+-", "Zoom in or out (Ctrl+0 resets)"],
    // The side pane is the window's own; it has no terminal key to map.
    ...Object.values(ACTIONS).filter((action) => action.pane && action.keys).map((action) => [action.keys, action.label]),
  ];
  const seen = new Set();
  const unique = rows.filter(([keys, does]) => { const key = `${keys}|${does}`; if (seen.has(key)) return false; seen.add(key); return true; });
  openModal({ title: "Keyboard shortcuts", wide: true, body: el("table", { class: "keys" }, el("tbody", {}, unique.map(([keys, does]) => el("tr", {}, el("td", {}, el("kbd", { text: keys })), el("td", { text: does }))))), buttons: [{ label: "Close", kind: "primary" }] });
}

async function openFolder() {
  const result = await coop.openFolder();
  if (result.success) toast("Opening that folder in a new coop window. Its sign-in checks run in a console first.", "info");
  else if (!result.cancelled) toast(result.error || "Could not open the folder.", "warning");
}

const ACTIONS = {
  settings: { label: "Settings", run: () => settingsPanel() },
  model: { label: "Pick a model", keys: "Ctrl+L", run: (arg) => pickModel(arg) },
  thinking: { label: "Thinking level", keys: "Shift+Tab", run: (arg) => pickThinking(arg) },
  new: { label: "New session", keys: "Ctrl+Shift+N", run: () => newSession() },
  resume: { label: "Sessions", keys: "Ctrl+Shift+R", run: () => pickSession() },
  name: { label: "Name this session", run: (arg) => renameSession(arg) },
  session: { label: "Session details", run: () => sessionInfo() },
  tree: { label: "Session tree", keys: "Ctrl+Shift+T", run: () => showTree() },
  fork: { label: "Fork from an earlier prompt", keys: "Ctrl+Shift+F", run: () => forkSession() },
  clone: { label: "Clone this session", run: () => cloneSession() },
  compact: { label: "Compact the conversation", run: (arg) => compact(arg) },
  copy: { label: "Copy the last answer", run: () => copyLast() },
  export: { label: "Export as a web page", run: (arg) => exportSession(arg) },
  reload: { label: "Restart coop on this session", run: () => restart() },
  hotkeys: { label: "Keyboard shortcuts", run: () => hotkeys() },
  quit: { label: "Close this window", keys: "Ctrl+W", run: () => window.close() },
  terminal: { label: "Open in terminal", run: (arg, name) => openTerminal(name ? `Run /${name}${arg ? ` ${arg}` : ""} there.` : "") },
  theme: { label: "Theme", run: () => chooseTheme() },
  folder: { label: "Open a folder in a new window", run: () => openFolder() },
  start: { label: "Start menu: common tasks", run: () => sendPrompt("/start") },
  changes: { label: "Changes since the last commit", keys: "Ctrl+Shift+D", pane: true, run: () => openPane("changes") },
  standards: { label: "Standards coop applies here", keys: "Ctrl+Shift+S", pane: true, run: () => openPane("standards") },
  project: { label: "Project settings (.coop/project.yml)", pane: true, run: () => openPane("project") },
  docs: { label: "Lineage docs: set up, build, read", pane: true, run: () => openPane("docs") },
  pane: { label: "Show or hide the side pane", keys: "Ctrl+\\", pane: true, run: () => togglePane(app.lastPane) },
};

async function runAction(id, arg = "", name = "") {
  const action = ACTIONS[id];
  if (!action) return;
  try { await action.run(arg, name); } catch (error) { toast(error.message, "error"); }
}

async function pickSession() {
  await loadSessions();
  const value = await pickFrom({
    title: "Sessions in this folder",
    items: app.sessions.map((session) => ({ label: sessionLabel(session), detail: session.title && session.name ? session.title : "", hint: relativeTime(session.modified), value: session.path })),
    placeholder: "Filter sessions",
    current: app.state && app.state.sessionFile,
  });
  if (value) await switchSession(value);
}

async function palette() {
  const items = [
    ...Object.entries(ACTIONS).filter(([id]) => id !== "terminal").map(([id, action]) => ({ label: action.label, hint: action.keys || "", value: { action: id } })),
    { label: "Open in terminal", hint: "", value: { action: "terminal" } },
    ...BUILTINS.filter((c) => c.action === "terminal").map((c) => ({ label: `/${c.name}`, detail: c.description, value: { action: "terminal", name: c.name } })),
    ...app.commands.map((c) => ({ label: `/${c.name}`, detail: String(c.description || "").replace(/^#+\s*/, "").split("\n")[0], hint: sourceLabel(c.source), value: { insert: `/${c.name} ` } })),
  ];
  const value = await pickFrom({ title: "Commands", items, placeholder: "What do you want to do?" });
  if (!value) return;
  if (value.insert) setPrompt(value.insert);
  else runAction(value.action, "", value.name || "");
}

// --- Keyboard and wiring ------------------------------------------------------

function onPromptKey(event) {
  const list = app.completion.items;
  if (list.length) {
    if (event.key === "ArrowDown") { event.preventDefault(); app.completion.active = (app.completion.active + 1) % list.length; renderCompletions(); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); app.completion.active = (app.completion.active - 1 + list.length) % list.length; renderCompletions(); return; }
    if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); acceptCompletion(app.completion.active); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideCompletions(); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      const item = list[app.completion.active];
      const typed = prompt().value.trim();
      if (item && (app.completion.kind === "file" || typed !== `/${item.name}`)) { event.preventDefault(); acceptCompletion(app.completion.active); return; }
    }
  }
  if (event.key === "Tab" && !event.shiftKey && !list.length) {
    const token = pathTokenAt();
    if (token) { event.preventDefault(); requestFiles(token, pathTokenAt); return; }
  }
  if (event.key === "Tab" && event.shiftKey) { event.preventDefault(); cycleThinking(); return; }
  if ((event.key === "Enter" && event.altKey) || (event.key.toLowerCase() === "q" && event.ctrlKey && !event.shiftKey)) { event.preventDefault(); submit({ followUp: true }); return; }
  if (event.key === "j" && event.ctrlKey) { event.preventDefault(); insertNewline(); return; }
  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.isComposing) { event.preventDefault(); submit(); return; }
  if (event.key === "ArrowUp" && event.altKey) { event.preventDefault(); dequeue(); return; }
  const box = prompt();
  if (event.key === "ArrowUp" && !event.shiftKey && (!box.value || app.historyIndex !== -1) && box.selectionStart === 0) { if (historyStep(-1)) event.preventDefault(); return; }
  if (event.key === "ArrowDown" && !event.shiftKey && app.historyIndex !== -1) { if (historyStep(1)) event.preventDefault(); }
}

function insertNewline() {
  const box = prompt();
  const { selectionStart: start, selectionEnd: end, value } = box;
  box.value = `${value.slice(0, start)}\n${value.slice(end)}`;
  box.setSelectionRange(start + 1, start + 1);
  autosize();
}

async function cycleThinking() {
  const result = await cmd({ type: "cycle_thinking_level" });
  if (result.success && result.data && result.data.level) { app.tl.thinkingLevel = result.data.level; renderHeader(); }
  else if (result.success) toast("This model does not think step by step.", "info");
}

async function cycleModel() {
  const result = await cmd({ type: "cycle_model" });
  if (result.success && result.data) { await refreshState(); toast(`Model: ${modelLabel()}`, "info", { timeout: 2500 }); }
  else if (result.success) toast("Only one model is available.", "info");
}

function onGlobalKey(event) {
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const inPane = event.target instanceof Element && event.target.closest("#pane");
  if (event.key === "Escape" && !modalOpen()) {
    // Esc in the side pane leaves it (a field keeps its own Esc); it never stops coop.
    if (inPane) { if (!event.target.matches("input, select, textarea")) { closePane(); prompt().focus(); } return; }
    interrupt();
    return;
  }
  if (modalOpen()) return;
  if (ctrl && !event.shiftKey && !event.altKey && (event.key === "\\" || event.code === "Backslash")) { event.preventDefault(); togglePane(app.lastPane); return; }
  if (ctrl && !event.shiftKey && key === "f") { event.preventDefault(); app.finder.open(); return; }
  if (ctrl && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); jumpPrompt(event.key === "ArrowUp" ? -1 : 1); return; }
  // Page keys scroll the conversation from the prompt, as in the terminal,
  // unless the prompt itself is long enough to need them.
  if ((event.key === "PageUp" || event.key === "PageDown") && event.target === prompt() && prompt().scrollHeight <= prompt().clientHeight) {
    event.preventDefault();
    const box = $("timeline");
    box.scrollBy({ top: (event.key === "PageUp" ? -1 : 1) * box.clientHeight * 0.85 });
    return;
  }
  if (ctrl && (key === "k" || (event.shiftKey && key === "p"))) { event.preventDefault(); palette(); return; }
  if (ctrl && event.shiftKey) {
    const map = { n: "new", t: "tree", f: "fork", r: "resume", d: "changes", s: "standards" };
    if (map[key]) { event.preventDefault(); runAction(map[key]); return; }
  }
  if (ctrl && !event.shiftKey) {
    if (key === "l") { event.preventDefault(); runAction("model"); return; }
    if (key === "p") { event.preventDefault(); cycleModel(); return; }
    if (key === "t") { event.preventDefault(); app.prefs.showThinking = !app.prefs.showThinking; app.prefs.thinkingOpen.clear(); rerenderAll(); return; }
    if (key === "o") { event.preventDefault(); app.prefs.expandTools = !app.prefs.expandTools; app.prefs.toolOpen.clear(); rerenderAll(); return; }
    if (key === "g") { event.preventDefault(); biggerEditor(); return; }
    if (key === "w") { event.preventDefault(); window.close(); return; }
    if (key === "=" || key === "+") { event.preventDefault(); coop.zoom(1); return; }
    if (key === "-") { event.preventDefault(); coop.zoom(-1); return; }
    if (key === "0") { event.preventDefault(); coop.zoom(0); return; }
  }
}

function wire() {
  const box = prompt();
  box.addEventListener("input", () => { autosize(); updateCompletions(); app.historyIndex = -1; });
  box.addEventListener("keydown", onPromptKey);
  box.addEventListener("blur", () => setTimeout(hideCompletions, 120));
  box.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter((file) => file.type.startsWith("image/"));
    if (files.length) { event.preventDefault(); addImages(files); }
  });
  const composer = $("composer");
  composer.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
  composer.addEventListener("dragover", (event) => { event.preventDefault(); composer.classList.add("drop"); });
  composer.addEventListener("dragleave", () => composer.classList.remove("drop"));
  composer.addEventListener("drop", (event) => {
    event.preventDefault();
    composer.classList.remove("drop");
    const files = [...(event.dataTransfer ? event.dataTransfer.files : [])].filter((file) => file.type.startsWith("image/"));
    if (files.length) addImages(files);
  });
  // Nothing dropped outside the composer may navigate the window.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
  $("stopButton").addEventListener("click", interrupt);
  $("queueButton").addEventListener("click", () => submit({ followUp: true }));
  $("newSession").addEventListener("click", () => runAction("new"));
  $("openFolder").addEventListener("click", () => runAction("folder"));
  $("sessionFilter").addEventListener("input", renderSessions);
  $("toggleSidebar").addEventListener("click", () => document.body.classList.toggle("no-sidebar"));
  $("modelButton").addEventListener("click", () => runAction("model"));
  $("thinkingButton").addEventListener("click", () => runAction("thinking"));
  $("terminalButton").addEventListener("click", () => runAction("terminal"));
  $("menuButton").addEventListener("click", palette);
  $("paneButton").addEventListener("click", () => togglePane(app.lastPane));
  initPanes({ onOpen: (id) => { app.lastPane = id; } });
  $("sessionName").addEventListener("click", () => runAction("name"));
  $("timeline").addEventListener("click", (event) => {
    const link = event.target.closest("a.md-link");
    if (link) { event.preventDefault(); coop.openExternal(link.dataset.href); }
  });
  document.addEventListener("keydown", onGlobalKey);
  app.finder = createFinder({
    root: $("timeline"), bar: $("findBar"), input: $("findInput"), count: $("findCount"),
    prev: $("findPrev"), next: $("findNext"), close: $("findClose"), onClose: () => prompt().focus(),
  });
  // Typing while the conversation has focus goes to the prompt.
  $("timeline").addEventListener("keydown", (event) => {
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) prompt().focus();
  });
  window.addEventListener("resize", autosize);
}

function registerPanes() {
  const deps = { coop, codeBlock };
  registerPane({ id: "changes", label: "Changes", icon: "diff", mount: (box, options) => mountChanges(box, options, { ...deps, cwd: () => (app.info ? app.info.cwd : "") }) });
  registerPane({ id: "standards", label: "Standards", icon: "shield", mount: (box, options) => mountStandards(box, options, deps) });
  registerPane({ id: "project", label: "Project", icon: "form", mount: (box, options) => mountProject(box, options, { ...deps, newSession: () => runAction("new") }) });
  registerPane({ id: "docs", label: "Docs", icon: "graph", mount: (box, options) => mountDocs(box, options, deps) });
}

async function boot() {
  registerPanes();
  wire();
  coop.onEvent(onEvent);
  coop.onExit(onExit);
  coop.onNotice((notice) => toast(clean(notice.message), notice.level || "info"));
  coop.onTheme((theme) => applyTheme(theme));
  app.info = await coop.ready();
  applyTheme(app.info);
  renderHeader();
  renderBusy();
  renderStatus();
  renderEmpty();
  if (app.info.loginPresent === false) {
    showBanner("warning", "No model sign-in yet. Open coop in a terminal and run /login once; then restart this window.", app.info.canOpenTerminal ? [
      { label: "Open in terminal", kind: "primary", onClick: () => openTerminal("Run /login there.") },
      { label: "Restart", onClick: restart },
    ] : [{ label: "Restart", onClick: restart }]);
  }
  for (const text of app.info.notices || []) toast(clean(text), "warning", { timeout: 0 });
  await refreshAll();
  prompt().focus();
}

boot().catch((error) => toast(`The window failed to start: ${error.message}`, "error"));
