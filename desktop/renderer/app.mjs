// The coop window: timeline, composer, dialogs and the actions that stand in
// for Pi's terminal commands. Talks to coop only through window.coop
// (preload.cjs); the main process checks every call again.
import { el, icon, openModal, pickFrom, toast, modalOpen, relativeTime } from "./ui.mjs";
import { createTimeline, applyEvent, loadMessages, startBash, finishBash, formatTokens, textOf, notice, turnOf, turns } from "./timeline.mjs";
import { createFinder } from "./find.mjs";
import { renderItem, renderTurn, codeBlock } from "./view.mjs";
import { parseInput, completions, BUILTINS, KEYS } from "./commands.mjs";
import { registerPane, openPane, togglePane, closePane, currentPane, refreshPane, initPanes } from "./panes.mjs";
import { mountChanges } from "./pane-changes.mjs";
import { mountStandards } from "./pane-standards.mjs";
import { mountProject } from "./pane-project.mjs";
import { mountDocs } from "./pane-docs.mjs";
import { makeResizer, sidebarMaxWidth } from "./resize.mjs";
import { attachmentNote } from "./attach-note.mjs";
import { widgetView } from "./widgets.mjs";
import { COLLAPSE_KEY, TODO_TOOL, applyTodoResult, createTodos, startTurn, todoLines, todosFromMessages } from "./todos.mjs";
import { setupItems, setupItem, setupSummary, EXAMPLES } from "./welcome.mjs";
import { parseConfirm, confirmLabels, parseQuestionSelect, parseQuestionMulti, multiAnswer } from "./dialogs.mjs";
import { imageBudgetProblem, restoreDraft } from "./draft.mjs";

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
  widgetsCollapsed: false, // Alt+T: the widgets above the prompt show only their first line
  todos: createTodos(), // the todo panel, rebuilt from the session's `todo` tool results (todos.mjs)
  attachments: [], // { kind: image | text | office | pdf | pending, ... } from lib/attachments.mjs
  vibe: "", // the tip under the splash and on the working line; a fresh one each turn
  setup: [], // what this machine still owes before coop works fully (welcome.mjs)
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
    // Tool calls fold into one activity line per reply (Aaron: concise while
    // working, expandable); activityOpen remembers each line the user opened.
    activityFold: true,
    activityOpen: new Map(),
    // Pi's auto-retry default is on; get_state does not report it, so the
    // window remembers what it last set here.
    autoRetry: true,
    outputs: new Map(),
    outputState(key) {
      if (!this.outputs.has(key)) this.outputs.set(key, { all: false, redraw: () => {} });
      return this.outputs.get(key);
    },
    redrawOwner(toolCallId) { const owner = app.tl.toolOwner.get(toolCallId); if (owner) redraw(owner); },
    // The timeline's links into the side pane (a tool card's file, the standards).
    openPane: (id, options) => openPane(id, options),
    // The working line carries the vibe, as the terminal's does.
    workingText: () => app.vibe || "Working",
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
  const previousSession = app.state ? app.state.sessionId : undefined;
  if (state.success && state.data) {
    app.state = state.data;
    app.tl.sessionName = state.data.sessionName;
    app.tl.thinkingLevel = state.data.thinkingLevel;
  }
  if (messages.success && messages.data) {
    loadMessages(app.tl, messages.data.messages);
    // The todo panel follows the session: a compaction leaves the list in the
    // session branch but out of get_messages, so the same session keeps its panel.
    const todos = todosFromMessages(messages.data.messages);
    if (todos.found || !app.state || app.state.sessionId !== previousSession) app.todos = todos;
    renderWidgets();
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
  // A first prompt names a new session's tab right away.
  if (status || (event.type === "message_start" && event.message && event.message.role === "user")) { renderBusy(); renderHeader(); }
  if (event.type === "agent_start") { freshVibe(); startTurn(app.todos); renderWidgets(); }
  if (event.type === "tool_execution_end" && event.toolName === TODO_TOOL && applyTodoResult(app.todos, event.result)) renderWidgets();
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
      // Before the conversation starts, a notice that names a set-up step
      // (the MCP adapter reporting the Warehouse endpoint's 401, for one) joins
      // the set-up card with its command instead of landing as a raw report.
      if (conversationEmpty()) {
        const item = setupItem(text);
        if (item && item.command) {
          if (!app.setup.some((known) => known.id === item.id)) { app.setup.push(item); renderSetup(); }
          break;
        }
      }
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

// Cards Pi is waiting on, by dialog id, so an answer given on the phone (MC2)
// closes the same card here.
const openCards = new Map();

/** The phone answered this question, or it expired: close its card without answering. */
function closeDialog(id) {
  const card = openCards.get(id);
  if (!card) return;
  openCards.delete(id);
  card.answered();
  card.modal.close();
}

function showDialog(request) {
  let answered = false;
  const reply = (value) => { if (!answered) { answered = true; openCards.delete(request.id); answer(request, value); } };
  const title = clean(request.title);
  let modal;
  const track = (m) => { modal = m; openCards.set(request.id, { modal: m, answered: () => { answered = true; } }); };
  if (request.method === "select") {
    const options = Array.isArray(request.options) ? request.options.map(String) : [];
    // An ask_user_question (its RPC form numbers the options): a card with the
    // label and description on two lines, the header as a chip.
    const question = parseQuestionSelect(title, options);
    pickFrom({
      title: question ? (question.header ? `Question: ${clean(question.header)}` : "Question") : "coop",
      message: question ? clean(question.question) : title,
      detail: question && question.previews.length ? question.previews.map(clean).join("\n\n") : "",
      items: question
        ? question.options.map((option) => ({ label: clean(option.label), detail: clean(option.description), value: option.value, className: option.other ? "other" : "" }))
        : options.map((option) => ({ label: clean(option), value: option })),
      filter: !question && options.length > 12,
      onOpen: track,
    }).then((value) => reply(value === undefined ? { cancelled: true } : { value }));
  } else if (request.method === "confirm") {
    // An approval card: what is being approved stands apart as code, the
    // question is the last line, and No is the default. The decision stays
    // with the extension (coop-guardrails); only the drawing is the window's.
    const message = clean(request.message);
    const parsed = parseConfirm(message);
    const labels = confirmLabels({ title, question: parsed.question, message });
    const body = el("div", { class: "dialog-text" },
      parsed.blocks.map((block) => (block.kind === "code"
        ? el("pre", { class: "dialog-code" }, el("code", { text: block.text }))
        : el("p", { class: "dialog-message", text: block.text }))),
      parsed.question ? el("p", { class: "dialog-question", text: parsed.question }) : null);
    track(openModal({
      title: title || "coop",
      titleIcon: /guardrail/i.test(title) ? "shield" : "",
      body,
      className: `confirm ${labels.risky ? "risky" : ""}`,
      onCancel: () => reply({ cancelled: true }),
      buttons: [
        { label: labels.yes, kind: labels.risky ? "danger" : "", onClick: () => reply({ confirmed: true }) },
        { label: labels.no, kind: "primary", onClick: () => reply({ confirmed: false }) },
      ],
    }));
    // The safe answer has the focus and the primary style: Enter alone never approves.
    requestAnimationFrame(() => { const no = modal.root.querySelectorAll(".modal-buttons .btn")[1]; if (no) no.focus(); });
  } else if (request.method === "input" && parseQuestionMulti(title)) {
    // An ask_user_question multi-select, which the RPC form asks as a text of
    // numbers: checkboxes instead, plus the "type something" field. The answer
    // sent is the same comma-separated numbers (or the typed text).
    const question = parseQuestionMulti(title);
    const selected = new Set();
    const typed = el("input", { class: "field", type: "text", placeholder: "Or type your own answer" });
    const rows = question.options.map((option) => el("label", { class: "check-row" },
      el("input", { type: "checkbox", onchange: (event) => { if (event.target.checked) selected.add(option.index); else selected.delete(option.index); } }),
      el("span", { class: "check-text" }, el("span", { class: "option-label", text: clean(option.label) }), option.description ? el("span", { class: "option-detail", text: clean(option.description) }) : null)));
    const submit = () => reply({ value: multiAnswer(selected, typed.value) });
    typed.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); modal.close(); } });
    track(openModal({
      title: question.header ? `Question: ${clean(question.header)}` : "Question",
      body: el("div", { class: "dialog-text" }, el("p", { class: "dialog-message", text: clean(question.question) }), el("div", { class: "check-list" }, rows), typed, el("p", { class: "hint", text: "Tick all that apply, or type an answer." })),
      wide: true,
      onCancel: () => reply({ cancelled: true }),
      buttons: [{ label: "Answer", kind: "primary", onClick: submit }, { label: "Cancel", onClick: () => reply({ cancelled: true }) }],
    }));
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
    track(openModal({
      title: multi ? title || "Edit" : "coop",
      body: el("div", { class: "dialog-text" }, multi ? null : el("p", { class: "dialog-message", text: title }), field, multi ? el("p", { class: "hint", text: "Ctrl+Enter saves" }) : null),
      wide: multi,
      onCancel: () => reply({ cancelled: true }),
      buttons: [{ label: multi ? "Save" : "OK", kind: "primary", onClick: submit }, { label: "Cancel", onClick: () => reply({ cancelled: true }) }],
    }));
  }
  if (Number(request.timeout) > 0 && modal) {
    // Pi answers for the user when the question times out.
    setTimeout(() => { if (!answered) { answered = true; openCards.delete(request.id); modal.close(); } }, Number(request.timeout));
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
  const drawn = new Set();
  for (const id of app.dirty) {
    if (drawn.has(id)) continue;
    // A run of assistant messages is one turn and one node; a change to any
    // message in it redraws the turn (timeline.mjs turnOf).
    const turn = turnOf(app.tl.items, id);
    if (!turn.length) continue;
    const node = turn[0].kind === "assistant" ? renderTurn(turn, app.tl, app.prefs) : renderItem(turn[0], app.tl, app.prefs);
    const old = turn.map((item) => app.nodes.get(item.id)).find((known) => known && known.isConnected);
    if (old) old.replaceWith(node); else box.append(node);
    for (const item of turn) { app.nodes.set(item.id, node); drawn.add(item.id); }
  }
  app.dirty.clear();
  renderEmpty();
  if (app.setup.length && !conversationEmpty() && !app.setupBannerShown) renderSetup();
  if (stick) box.scrollTop = box.scrollHeight;
  if (app.finder) app.finder.refresh();
}

function renderTimeline() {
  const box = $("timeline");
  app.nodes.clear();
  app.dirty.clear();
  box.replaceChildren(...turns(app.tl.items).map((turn) => {
    const node = turn[0].kind === "assistant" ? renderTurn(turn, app.tl, app.prefs) : renderItem(turn[0], app.tl, app.prefs);
    for (const item of turn) app.nodes.set(item.id, node);
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

// The brand gradient of the terminal's wordmark (coop-powerline), one colour per letter.
const WORDMARK = "COOPTIMIZE";
const GRADIENT = ["navy", "forest", "olive", "lime"];

// The terminal's block-art logo as crisp rectangles: one <rect> per run of
// one colour, so it scales to any window and zoom level without blur.
function splashArt(art) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${art.width} ${art.height}`);
  svg.setAttribute("class", "splash");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Cooptimize");
  for (const [y, x, length, colour] of art.runs) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", x); rect.setAttribute("y", y); rect.setAttribute("width", length); rect.setAttribute("height", 1); rect.setAttribute("fill", colour);
    svg.append(rect);
  }
  return svg;
}

function wordmark() {
  return el("div", { class: "wordmark", "aria-label": "Cooptimize" }, [...WORDMARK].map((letter, i) =>
    el("span", { class: `brand-${GRADIENT[Math.min(GRADIENT.length - 1, Math.round((i / (WORDMARK.length - 1)) * (GRADIENT.length - 1)))]}`, text: letter })));
}

function vibeLine() {
  return el("div", { class: "vibe" }, el("span", { class: "vibe-mark", "aria-hidden": "true", text: "\u2b21" }), el("span", { text: app.vibe }));
}

/**
 * Whether the conversation has no content yet: no prompt sent, no answer. A
 * notice Pi posted on its own (an MCP connection report at start) is not
 * content, so it never takes the welcome, the set-up card or the first-run
 * Start menu away.
 */
function conversationEmpty() {
  return !app.tl.items.some((item) => item.kind !== "notice");
}

/** The splash on an empty conversation: the logo, wordmark, tagline and a vibe, as the terminal opens. */
function renderEmpty({ fresh = false } = {}) {
  const box = $("timeline");
  const empty = box.querySelector(".empty");
  if (!conversationEmpty()) { if (empty) empty.remove(); return; }
  // The welcome stays below any notice already drawn.
  if (empty && !fresh) { box.append(empty); return; }
  if (empty) empty.remove();
  const art = app.info && app.info.splash && app.info.splash.width ? splashArt(app.info.splash) : null;
  const start = el("button", { type: "button", class: "btn primary", text: "Open the Start menu", onclick: () => sendPrompt("/start") });
  const link = (id, label, glyph) => el("button", { type: "button", class: "btn ghost", onclick: () => openPane(id) }, icon(glyph), el("span", { text: label }));
  const ready = !app.setup.some((item) => item.id === "login");
  box.append(el("div", { class: "empty" },
    art,
    wordmark(),
    el("p", { class: "tagline", text: "worker-owned analytics engineering" }),
    el("p", { class: "tagline dim", text: "Microsoft Fabric \u00b7 Power BI \u00b7 D365 \u00b7 SQL \u00b7 DAX" }),
    app.vibe ? vibeLine() : null,
    app.setup.length ? setupCard() : null,
    el("p", { class: "lead", text: ready
      ? `coop is ready in ${app.info ? app.info.folder : "this folder"}. Try one of these, ask your own question, or pick a task from the Start menu.`
      : "Finish the set-up above, then ask coop anything about this folder." }),
    el("div", { class: "examples" }, EXAMPLES.map((example) => el("button", { type: "button", class: "btn example", title: example.prompt, onclick: () => setPrompt(example.prompt) }, icon("spark"), el("span", { text: example.label })))),
    start,
    el("div", { class: "empty-links" },
      link("changes", "Changes", "diff"),
      link("standards", "Standards", "shield"),
      link("project", "Project settings", "form"),
      link("docs", "Lineage docs", "graph"))));
}

/**
 * What this machine still owes (welcome.mjs): sign-in, the COOP profile, Azure.
 * Each line has the command and a button that opens the terminal on this
 * session to run it; Restart picks the result up. Shown as a card on the empty
 * screen and as one banner line once the conversation has content.
 */
function setupCard() {
  const rows = app.setup.map((item) => el("li", { class: "setup-item" },
    icon(item.command ? "warn" : "more"),
    el("div", { class: "setup-text" },
      el("span", { text: item.text }),
      item.command ? el("code", { class: "setup-command", text: item.command }) : null,
      item.detail && item.detail !== item.text ? el("span", { class: "hint", text: item.detail }) : null),
    item.command && app.info && app.info.canOpenTerminal
      ? el("button", { type: "button", class: "btn", text: "Open in terminal", onclick: () => openTerminal(`Run ${item.command} there, then click Restart here.`) })
      : null));
  return el("section", { class: "setup", "aria-label": "Set-up" },
    el("div", { class: "setup-head" }, icon("shield"), el("span", { text: "Before coop can do everything here" })),
    el("ul", { class: "setup-list" }, rows),
    el("div", { class: "setup-actions" },
      el("button", { type: "button", class: "btn primary", onclick: restart }, icon("restart"), el("span", { text: "Restart coop" })),
      el("button", { type: "button", class: "btn ghost", text: "Dismiss", onclick: () => { app.setup = []; renderSetup(); } }),
      el("span", { class: "hint", text: "Each item runs once in the terminal; Restart picks it up here." })));
}

function renderSetup() {
  const banner = $("banner");
  if (!app.setup.length) { if (banner.className.includes("setup")) banner.hidden = true; renderEmpty({ fresh: true }); return; }
  renderEmpty({ fresh: true });
  if (conversationEmpty()) { banner.hidden = true; return; }
  app.setupBannerShown = true;
  showBanner("warning setup", setupSummary(app.setup), [
    { label: "Show set-up", kind: "primary", onClick: () => openModal({ title: "Set-up", body: setupCard(), wide: true, buttons: [{ label: "Close", kind: "primary" }] }) },
    { label: "Restart", onClick: restart },
  ]);
}

/** A new vibe for this turn (or set, after /coop-vibe <set>); the splash and the working line follow. */
async function freshVibe(set = "") {
  const result = await coop.vibe(set);
  if (!result || !result.success) { if (set && result && result.error) toast(result.error, "warning"); return; }
  app.vibe = String(result.data || "");
  renderStatus();
  renderEmpty({ fresh: true });
  if (app.tl.current) redraw(app.tl.current);
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
  const attachments = app.attachments;
  const images = attachments.filter((file) => file.kind === "image").map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
  const input = { type: "prompt", message: text + attachmentNote(attachments) };
  if (images.length) input.images = images;
  if (app.tl.busy) input.streamingBehavior = followUp ? "followUp" : "steer";
  pushHistory(text);
  clearPrompt();
  const result = await cmd(input);
  if (!result.success) {
    // The draft comes back whole (#281): the text unless something new was typed,
    // and every attachment ahead of anything attached meanwhile.
    toast(`coop did not take that message: ${result.error || "unknown error"}`, "error");
    const draft = restoreDraft({ text: prompt().value, attachments: app.attachments }, { text, attachments });
    if (draft.text !== prompt().value) setPrompt(draft.text);
    app.attachments = draft.attachments;
    renderAttachments();
  }
}

async function submit({ followUp = false } = {}) {
  const text = prompt().value;
  if (!text.trim() && !app.attachments.length) return;
  if (!app.running) { toast("coop is not running in this window. Restart it first.", "warning"); return; }
  if (app.attachments.some((file) => file.kind === "pending")) { toast("Still reading an attached file; one moment.", "info"); return; }
  // The same image limits the RPC boundary enforces, checked before the draft
  // is cleared (#281); the boundary still enforces them.
  const budget = imageBudgetProblem(app.attachments, attachLimits());
  if (budget) { toast(budget, "warning"); return; }
  const parsed = parseInput(text);
  // /coop-vibe <set> changes Pi's pool in the terminal; the window's own pool follows.
  const vibe = /^\/coop-vibe(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (vibe) freshVibe(vibe[1] || "");
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
  return { window: "", extension: "coop", prompt: "prompt", skill: "skill", file: "file", folder: "folder" }[source] ?? source;
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

function attachLimits() {
  return (app.info && app.info.attachLimits) || { perMessage: 10, images: 5, imageBytes: 4 * 1024 * 1024, imageTotalBytes: 8 * 1024 * 1024 };
}

/** Add an image to the draft when it fits the image budget; otherwise say why. */
function addImage(image) {
  const problem = imageBudgetProblem([...app.attachments, image], attachLimits());
  if (problem) { toast(problem, "warning"); return false; }
  app.attachments.push(image);
  return true;
}

function modelReadsImages() {
  const model = app.state && app.state.model;
  if (model && Array.isArray(model.input) && !model.input.includes("image")) {
    toast(`${model.name || model.id} does not read images. Pick another model to attach one.`, "warning");
    return false;
  }
  return true;
}

function roomFor(kind) {
  const limits = attachLimits();
  if (app.attachments.length >= limits.perMessage) { toast(`${limits.perMessage} files at most per message.`, "warning"); return false; }
  if (kind === "image" && app.attachments.filter((file) => file.kind === "image").length >= limits.images) { toast(`${limits.images} images at most per message.`, "warning"); return false; }
  return true;
}

/** Images pasted from the clipboard (a screenshot: no path), read here. */
async function addImages(files) {
  if (!files.length || !modelReadsImages()) return;
  for (const file of files) {
    if (!roomFor("image")) break;
    const image = await readImage(file);
    if (image && !addImage({ kind: "image", name: file.name, ...image })) break;
  }
  renderAttachments();
}

/** Files on disk (dropped, pasted from Explorer, or picked): the main process reads each one. */
async function addPaths(paths) {
  for (const path of paths) {
    if (!path) continue;
    if (!roomFor(/\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "file")) break;
    if (/\.(png|jpe?g|gif|webp)$/i.test(path) && !modelReadsImages()) continue;
    const pending = { kind: "pending", name: path.split(/[\\/]/).pop() };
    app.attachments.push(pending);
    renderAttachments();
    const result = await coop.attachFile(path);
    const index = app.attachments.indexOf(pending);
    if (index < 0) { if (result.success && result.data.id) coop.forgetAttachment(result.data.id); continue; }
    if (result.success) {
      const file = result.data;
      if (file.kind === "image") file.url = `data:${file.mimeType};base64,${file.data}`;
      app.attachments.splice(index, 1);
      if (file.kind === "image") {
        if (!addImage(file)) { if (file.id) coop.forgetAttachment(file.id); }
      } else {
        app.attachments.push(file);
      }
    } else {
      app.attachments.splice(index, 1);
      toast(result.error || `${pending.name} could not be attached.`, "warning");
    }
    renderAttachments();
  }
}

/** Dropped or pasted File objects: by path when they have one, else as image data. */
function addFiles(files) {
  const paths = [];
  const blobs = [];
  for (const file of files) {
    const path = coop.pathForFile(file);
    if (path) paths.push(path);
    else if (file.type.startsWith("image/")) blobs.push(file);
    else toast(`${file.name || "That"} has no file on disk to read; save it first.`, "warning");
  }
  if (blobs.length) addImages(blobs);
  if (paths.length) addPaths(paths);
}

async function pickFiles() {
  const result = await coop.pickFiles();
  if (result && result.success && result.data.length) addPaths(result.data);
}

function removeAttachment(index) {
  const [file] = app.attachments.splice(index, 1);
  if (file && file.id) coop.forgetAttachment(file.id);
  renderAttachments();
}

function attachmentDetail(file) {
  if (file.kind === "pending") return "reading";
  if (file.kind === "text") return `${file.ref}`;
  return `${file.label}, ${file.detail}${file.truncated ? ", cut at the limit" : ""}`;
}

function renderAttachments() {
  const box = $("attachments");
  box.hidden = !app.attachments.length;
  box.replaceChildren(...app.attachments.map((file, index) => {
    const remove = el("button", { type: "button", class: "btn icon", title: "Remove", onclick: () => removeAttachment(index) }, icon("close", "Remove"));
    if (file.kind === "image") return el("div", { class: "attachment", title: file.name }, el("img", { src: file.url, alt: file.name }), remove);
    return el("div", { class: `attachment file ${file.kind}`, title: file.path || file.name },
      file.kind === "pending" ? el("span", { class: "spinner" }) : icon("file"),
      el("span", { class: "attachment-text" }, el("span", { class: "attachment-name", text: file.name }), el("span", { class: "attachment-detail", text: attachmentDetail(file) })),
      remove);
  }));
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
  // The client the project file names, then the folder (D1m).
  $("folderName").textContent = info.client ? `${info.client} · ${info.folder}` : (info.folder || "");
  $("folderName").title = info.contract ? `${info.cwd}\n${info.contract}` : (info.cwd || "");
  $("branchName").textContent = info.branch || "";
  $("branchName").hidden = !info.branch;
  const name = app.tl.sessionName || (app.state && app.state.sessionName) || "";
  const file = app.state && app.state.sessionFile;
  const saved = file ? app.sessions.find((session) => session.path === file) : null;
  $("sessionName").textContent = name || (saved && saved.title) || "New session";
  // The tab strip shows the same name.
  const first = app.tl.items.find((item) => item.kind === "user" && item.text);
  coop.tabLabel(name || (saved && saved.title) || (first ? first.text.split("\n")[0] : ""));
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
  $("sendButton").replaceChildren(icon("send"), el("span", { text: busy ? "Send now" : "Send" }));
  $("sendButton").title = busy ? "Send now, while coop works (Enter)" : "Send (Enter)";
  $("queueButton").title = "Wait until coop finishes (Alt+Enter)";
  $("composerHint").textContent = busy
    ? "Enter sends it to coop mid-task, Alt+Enter waits until coop finishes, Esc stops"
    : app.bashItem ? "A shell command is running. Esc stops it" : "Shift+Enter adds a line";
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
  const left = el("span", { class: "status-left" }, el("span", { class: "status-item status-brand", text: `coop${app.info && app.info.version ? ` v${app.info.version}` : ""}` }), el("span", { class: "status-item", text: app.running ? (app.tl.busy ? "Working" : "Ready") : "Stopped" }),
    app.running && app.tl.busy && app.vibe ? el("span", { class: "status-item vibe", title: app.vibe }, el("span", { class: "vibe-mark", "aria-hidden": "true", text: "\u2b21" }), el("span", { text: app.vibe })) : null);
  bar.replaceChildren(left, el("span", { class: "status-right" }, parts));
}

function renderWidgets() {
  for (const placement of ["above", "below"]) {
    const box = $(placement === "above" ? "widgetsAbove" : "widgetsBelow");
    const widgets = [...app.widgets.entries()].filter(([, widget]) => widget.placement === placement);
    const collapsed = placement === "above" && app.widgetsCollapsed;
    // The todo panel first, as the extension's overlay sits right above the prompt.
    const todo = placement === "above" ? todoLines(app.todos, { collapsed, rows: app.prefs.expandTools ? Infinity : undefined }) : [];
    if (todo.length) widgets.unshift(["coop-todos", { lines: todo, placement, rendered: true }]);
    box.hidden = !widgets.length;
    box.replaceChildren(...widgets.map(([key, widget]) => el("pre", { class: `widget${collapsed ? " collapsed" : ""}${key === "coop-todos" ? " todos" : ""}`, title: key }, el("code", { text: (widget.rendered ? widget.lines : widgetView(widget, collapsed)).join("\n") }))));
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
      class: `session ${session.path === current ? "current" : ""} ${session.openElsewhere ? "elsewhere" : ""}`,
      title: session.openElsewhere ? "Open in another tab: click to go there" : session.title || session.name || "",
      onclick: () => switchSession(session.path),
    }, el("span", { class: "session-title", text: sessionLabel(session) }), el("span", { class: "session-meta", text: `${session.openElsewhere ? "open in another tab · " : ""}${relativeTime(session.modified)} · ${session.messages} ${session.messages === 1 ? "prompt" : "prompts"}` })))));
  if (!shown.length) $("sessionList").append(el("li", { class: "session-empty", text: filter ? "No session matches." : "No saved sessions in this folder yet." }));
}

async function switchSession(path) {
  if (app.state && path === app.state.sessionFile) return;
  // coop keeps working here; the other session opens in its own tab.
  if (app.tl.busy) { await newTab(path); return; }
  const result = await cmdOrToastSwitch(path);
  if (result.success && !(result.data && result.data.cancelled)) await refreshAll();
}

async function cmdOrToastSwitch(path) {
  const result = await coop.switchSession(path);
  if (result.openElsewhere) toast(result.error, "info");
  else if (!result.success) toast(`Could not open that session: ${result.error || "unknown error"}`, "error");
  return result;
}

// --- Actions (Pi's terminal commands, done the window's way) -------------------

async function openTerminal(hint) {
  const result = await coop.openTerminal();
  if (result.success) toast(hint ? `coop opened in a terminal on this session. ${hint}` : "coop opened in a terminal on this session.", "info");
  else toast(result.error || "Could not open a terminal.", "warning");
}

async function restart() {
  // One restart at a time (#286): the main process coalesces overlapping
  // requests; the window just does not reset its view twice.
  if (app.restarting) { toast("coop is already restarting.", "info"); return; }
  app.restarting = true;
  try { await restartNow(); } finally { app.restarting = false; }
}

async function restartNow() {
  $("banner").hidden = true;
  app.setup = [];
  renderEmpty({ fresh: true });
  app.running = true;
  app.statuses.clear();
  app.widgets.clear();
  app.todos = createTodos();
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
  // coop keeps working here; the new session gets its own tab and its own coop.
  if (app.tl.busy) { await newTab(); return; }
  const result = await cmdOrToast({ type: "new_session" }, "Could not start a new session");
  if (result.success && !(result.data && result.data.cancelled)) { await refreshAll(); prompt().focus(); }
}

async function newTab(path = "") {
  const result = await coop.newTab(path);
  if (!result.success && !result.openElsewhere) toast(result.error || "Could not open a new tab.", "warning");
  else if (!result.success) toast(result.error, "info");
  return result;
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
    row("Auto-retry", toggle(app.prefs.autoRetry, async (v) => { const r = await cmdOrToast({ type: "set_auto_retry", enabled: v }, "Could not change auto-retry"); if (r.success) app.prefs.autoRetry = v; }), "Retry a failed model call (on when the window opens)"),
    row("Steering", select([["one-at-a-time", "One message at a time"], ["all", "All at once"]], s.steeringMode, async (v) => { await cmdOrToast({ type: "set_steering_mode", mode: v }, "Could not change steering"); refreshState(); }), "How messages you send while coop works are delivered"),
    row("Follow-ups", select([["one-at-a-time", "One message at a time"], ["all", "All at once"]], s.followUpMode, async (v) => { await cmdOrToast({ type: "set_follow_up_mode", mode: v }, "Could not change follow-ups"); refreshState(); })),
    row("Show thinking", toggle(app.prefs.showThinking, (v) => { app.prefs.showThinking = v; app.prefs.thinkingOpen.clear(); rerenderAll(); }), "Ctrl+T"),
    row("Expand tool output", toggle(app.prefs.expandTools, (v) => { app.prefs.expandTools = v; app.prefs.toolOpen.clear(); rerenderAll(); }), "Ctrl+O"),
    row("Notify in the background", toggle(app.info.notify !== false, async (v) => { const r = await coop.setPref("notify", v); if (r && r.success) app.info.notify = v; }), "A Windows notification and a taskbar flash when coop finishes or asks while you are elsewhere"),
    row("Menu bar", toggle(app.info.menuBar !== false, async (v) => { const r = await coop.setPref("menuBar", v); if (r && r.success) app.info.menuBar = v; }), "File, Edit, View, Session and Help above the window (Alt shows it when hidden)"),
    el("p", { class: "hint", text: "Pi's other settings (default model, scoped models, terminal display) are in the terminal's /settings." }));
  openModal({ title: "Settings", body, wide: true, buttons: [{ label: "Open in terminal", onClick: () => { openTerminal("Run /settings there."); } }, { label: "Done", kind: "primary" }] });
}

function hotkeys() {
  const rows = [
    ["Ctrl+K", "Command palette: every action and /command"],
    // The tree view's own controls are listed in that view, not here.
    ...Object.entries(KEYS).filter(([id, k]) => !id.startsWith("app.tree.") && k.keys && k.keys !== "native" && k.keys !== "terminal").map(([, k]) => [k.keys, k.does]),
    ["Ctrl+N", "New tab: another session alongside, with its own coop"],
    ["Ctrl+Tab / Ctrl+Shift+Tab", "Next or previous tab (Ctrl+1 to Ctrl+9 jump to one)"],
    ["Ctrl+= / Ctrl+-", "Zoom in or out (Ctrl+0 resets)"],
    // The same key collapses the todo panel in the terminal (coop sync seeds it).
    [COLLAPSE_KEY, "Collapse or expand the panels above the prompt (the todo list)"],
    // The side pane is the window's own; it has no terminal key to map.
    ...Object.values(ACTIONS).filter((action) => action.pane && action.keys).map((action) => [action.keys, action.label]),
  ];
  const seen = new Set();
  const unique = rows.filter(([keys, does]) => { const key = `${keys}|${does}`; if (seen.has(key)) return false; seen.add(key); return true; });
  openModal({ title: "Keyboard shortcuts", wide: true, body: el("table", { class: "keys" }, el("tbody", {}, unique.map(([keys, does]) => el("tr", {}, el("td", {}, el("kbd", { text: keys })), el("td", { text: does }))))), buttons: [{ label: "Close", kind: "primary" }] });
}

async function switchProject() {
  const result = await coop.switchProject();
  if (result.success) toast("Opening that project in a new coop window. A console shows coop's launch checks first, then the window opens.", "info");
  else if (!result.cancelled) toast(result.error || "Could not open the project.", "warning");
}

async function openFolder() {
  const result = await coop.openFolder();
  if (result.success) toast("Opening that folder in a new coop window. A console shows coop's launch checks first, then the window opens.", "info");
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
  quit: { label: "Close this tab", keys: "Ctrl+W", run: () => coop.closeTab() },
  tab: { label: "New tab: another session alongside this one", keys: "Ctrl+N", run: () => newTab() },
  window: { label: "New window on this folder", run: () => coop.newWindow() },
  terminal: { label: "Open in terminal", run: (arg, name) => openTerminal(name ? `Run /${name}${arg ? ` ${arg}` : ""} there.` : "") },
  theme: { label: "Theme", run: () => chooseTheme() },
  switch: { label: "Switch project", run: () => switchProject() },
  folder: { label: "Open a folder in a new window", run: () => openFolder() },
  start: { label: "Start menu: common tasks", run: () => sendPrompt("/start") },
  changes: { label: "Changes since the last commit", keys: "Ctrl+Shift+D", pane: true, run: () => openPane("changes") },
  standards: { label: "Standards coop applies here", keys: "Ctrl+Shift+S", pane: true, run: () => openPane("standards") },
  project: { label: "Project settings (.coop/project.yml)", pane: true, run: () => openPane("project") },
  docs: { label: "Lineage docs: set up, build, read", pane: true, run: () => openPane("docs") },
  pane: { label: "Show or hide the side pane", keys: "Ctrl+\\", pane: true, run: () => togglePane(app.lastPane) },
  // Menu bar entries with no slash command of their own.
  find: { label: "Find in the conversation", keys: "Ctrl+F", menu: true, run: () => app.finder.open() },
  sidebar: { label: "Show or hide the sessions list", menu: true, run: () => document.body.classList.toggle("no-sidebar") },
  palette: { label: "Commands", keys: "Ctrl+K", menu: true, run: () => palette() },
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
    ...Object.entries(ACTIONS).filter(([id]) => id !== "terminal" && id !== "palette").map(([id, action]) => ({ label: action.label, hint: action.keys || "", value: { action: id } })),
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
  if (event.altKey && !ctrl && !event.shiftKey && key === "t") { event.preventDefault(); app.widgetsCollapsed = !app.widgetsCollapsed; renderWidgets(); return; }
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
    if (key === "o") { event.preventDefault(); app.prefs.expandTools = !app.prefs.expandTools; app.prefs.toolOpen.clear(); app.prefs.activityOpen.clear(); rerenderAll(); return; }
    if (key === "g") { event.preventDefault(); biggerEditor(); return; }
    if (key === "w") { event.preventDefault(); coop.closeTab(); return; }
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
    const files = [...(event.clipboardData ? event.clipboardData.files : [])];
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  const composer = $("composer");
  composer.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
  composer.addEventListener("dragover", (event) => { event.preventDefault(); composer.classList.add("drop"); });
  composer.addEventListener("dragleave", () => composer.classList.remove("drop"));
  composer.addEventListener("drop", (event) => {
    event.preventDefault();
    composer.classList.remove("drop");
    const files = [...(event.dataTransfer ? event.dataTransfer.files : [])];
    if (files.length) addFiles(files);
  });
  $("attachButton").addEventListener("click", pickFiles);
  // Nothing dropped outside the composer may navigate the window.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
  $("stopButton").addEventListener("click", interrupt);
  $("queueButton").addEventListener("click", () => submit({ followUp: true }));
  $("newSession").addEventListener("click", () => runAction("new"));
  $("openFolder").addEventListener("click", () => runAction("folder"));
  $("sessionFilter").addEventListener("input", renderSessions);
  $("toggleSidebar").addEventListener("click", () => document.body.classList.toggle("no-sidebar"));
  const sidebar = makeResizer({
    handle: $("sidebarResize"),
    key: "coop.sidebarWidth",
    cssVar: "--sidebar-width",
    min: 200,
    max: () => sidebarMaxWidth(window.innerWidth, $("pane").hidden ? 0 : $("pane").getBoundingClientRect().width),
    measure: () => document.querySelector(".sidebar").getBoundingClientRect().width,
    fromPointer: (event, start) => start.size + (event.clientX - start.x),
  });
  window.addEventListener("resize", () => sidebar.apply());
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
  registerPane({ id: "changes", label: "Changes", icon: "diff", description: "Files changed since the last commit", mount: (box, options) => mountChanges(box, options, { ...deps, cwd: () => (app.info ? app.info.cwd : "") }) });
  registerPane({ id: "standards", label: "Standards", icon: "shield", description: "The standards coop applies in this folder", mount: (box, options) => mountStandards(box, options, deps) });
  registerPane({ id: "project", label: "Project", icon: "form", description: "Project settings (.coop/project.yml)", mount: (box, options) => mountProject(box, options, { ...deps, newSession: () => runAction("new") }) });
  registerPane({ id: "docs", label: "Docs", icon: "graph", description: "Lineage docs for this folder (coop-data-doc)", mount: (box, options) => mountDocs(box, options, deps) });
}

async function boot() {
  registerPanes();
  wire();
  coop.onEvent(onEvent);
  coop.onDialogClosed((closed) => { if (closed && typeof closed.id === "string") closeDialog(closed.id); });
  coop.onExit(onExit);
  coop.onNotice((notice) => toast(clean(notice.message), notice.level || "info"));
  coop.onTheme((theme) => applyTheme(theme));
  coop.onMenu((menu) => { if (menu && typeof menu.action === "string") runAction(menu.action); });
  coop.onRefresh(async (change) => {
    if (change && change.action === "reload") {
      await restart();
      toast("The phone restarted coop on this session.", "info");
      return;
    }
    await refreshAll();
    const what = { new: "started a new session", resume: "opened a saved session", fork: "forked the session", clone: "cloned the session" }[change && change.action];
    if (what) toast(`The phone ${what}.`, "info");
  });
  app.info = await coop.ready();
  app.vibe = String(app.info.vibe || "");
  applyTheme(app.info);
  renderHeader();
  renderBusy();
  renderStatus();
  // Sign-in, the COOP profile and Azure, each with its command, in one place
  // instead of a toast per launch notice (welcome.mjs).
  app.setup = setupItems({ loginPresent: app.info.loginPresent, notices: (app.info.notices || []).map(clean) });
  renderEmpty();
  await refreshAll();
  renderSetup();
  // The first launch on this profile opens the Start menu, as the terminal does.
  if (app.info.firstRun && app.running && conversationEmpty() && app.info.loginPresent !== false) sendPrompt("/start");
  prompt().focus();
}

boot().catch((error) => toast(`The window failed to start: ${error.message}`, "error"));
