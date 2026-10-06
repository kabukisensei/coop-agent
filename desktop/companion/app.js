// The phone companion page (master plan MC3, contract in desktop/COMPANION.md).
// It shows the coop window's live session: the conversation, whether coop is
// working, and the questions coop is waiting on, drawn with the window's own
// parsers. It sends four things: chat, stop, an answer, and pairing. Every text
// from the VM is placed with textContent or the window's Markdown renderer,
// which builds DOM nodes and never parses HTML.
import { parseConfirm, confirmLabels, parseQuestionSelect, parseQuestionMulti, multiAnswer } from "./shared/dialogs.mjs";
import { renderMarkdown } from "./shared/markdown.mjs";

const $ = (id) => document.getElementById(id);
const THEMES = ["modern-dark", "modern-light", "retro-dark", "retro-light", "site-dark", "site-light"];
const app = { incarnation: "", status: "disconnected", messages: new Map(), questions: new Map(), source: null, ready: false, retry: null };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

// ---- theme (the one thing kept on the phone) ----------------------------------

function storedTheme() {
  try { const t = localStorage.getItem("coop-theme"); if (THEMES.includes(t)) return t; } catch { /* private mode */ }
  return matchMedia("(prefers-color-scheme: light)").matches ? "modern-light" : "modern-dark";
}
function applyTheme(theme) {
  // The coop site themes are the retro palettes (the site's own colours) drawn
  // with the site's chrome: bevels, title-bar gradients and the pixel face.
  const site = theme.startsWith("site-");
  document.documentElement.dataset.theme = site ? `retro-${theme.slice(5)}` : theme;
  if (site) document.documentElement.dataset.look = "site";
  else delete document.documentElement.dataset.look;
  $("theme").value = theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]').setAttribute("content", bg);
}

// ---- requests ------------------------------------------------------------------

const REASONS = {
  "not-paired": ["Pair this phone", "Open coop on the VM and choose Session > Phone > Pair a phone. Enter the code it shows."],
  "revoked": ["This phone was removed", "Pair it again from the coop window: Session > Phone > Pair a phone."],
  "device-expired": ["Pairing expired", "Pair this phone again from the coop window: Session > Phone > Pair a phone."],
  "wrong-user": ["Different Windows user", "This phone was paired by another Windows user, or no coop window has phone access on. Allow the phone in the coop window: Session > Phone > Allow phone for this session."],
  "wrong-client": ["Different client", "This phone was paired for another client. Pair it for this client from the coop window."],
  "access-off": ["Phone access is off", "In the coop window on the VM, choose Session > Phone > Allow phone for this session. It turns off when the session changes."],
  "wrong-session": ["The session changed", "coop started a new session. Allow the phone again in the coop window."],
  "pi-not-running": ["coop is not running", "coop stopped in the window on the VM. Restart it there."],
  "rate-limited": ["Too many requests", "Wait a minute and try again."],
};

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Coop-Companion": "1" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json: json || { ok: false, code: "error" } };
}

/** A write with its submission id, retried with the same id when the network drops: it never runs twice. */
async function submit(path, body) {
  const payload = { submissionId: uuid(), ...body };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await api("POST", path, payload); } catch { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
  }
  return { status: 0, json: { ok: false, code: "offline" } };
}

function toast(text) {
  const note = el("li", { class: "notice warning", role: "status", text });
  $("timeline").append(note);
  note.scrollIntoView({ block: "end" });
}

function refusal(json) {
  const reason = REASONS[json.code];
  if (reason && ["not-paired", "revoked", "device-expired", "wrong-user", "wrong-client", "access-off", "wrong-session"].includes(json.code)) { showGate(json.code); return; }
  if (json.message && ["desktop-only", "unknown-command"].includes(json.code)) { toast(json.message); return; }
  toast(reason ? reason[1] : json.code === "desktop-only" ? "That runs on the desktop only." : json.code === "already-answered" ? "That question was already answered." : json.code === "offline" ? "No connection to the VM. Try again." : `Not sent (${json.code}).`);
}

// ---- screens -------------------------------------------------------------------

function showGate(code) {
  closeStream();
  app.ready = false;
  const [title, text] = REASONS[code] || ["Can't reach coop", "The VM did not answer. Check that Tailscale is on, then try again."];
  $("gate-title").textContent = title;
  $("gate-text").textContent = text;
  $("pair").hidden = !["not-paired", "revoked", "device-expired", "wrong-client"].includes(code);
  $("retry").hidden = !$("pair").hidden;
  $("gate").hidden = false;
  $("session").hidden = true;
  $("composer").hidden = true;
  setStatus("disconnected");
}

function setStatus(state) {
  app.status = state;
  const chip = $("status");
  chip.textContent = { idle: "ready", running: "working", exited: "stopped", disconnected: "offline" }[state] || state;
  chip.className = `chip ${state}`;
  const running = state === "running";
  $("stop").hidden = !running;
  // As in the window: while coop works, Send now steers and Queue waits its turn.
  $("queue-send").hidden = !running;
  $("send").textContent = running ? "Send now" : "Send";
  const off = !app.ready || state === "exited" || state === "disconnected";
  $("send").disabled = off;
  $("queue-send").disabled = off;
}

function renderQueue(queue) {
  const q = queue || { steering: [], followUp: [] };
  const items = [...(q.steering || []).map((t) => ["Steering", t]), ...(q.followUp || []).map((t) => ["Queued", t])];
  const box = $("queue");
  box.hidden = !items.length;
  box.replaceChildren(...items.map(([kind, text]) => el("div", { class: "queued" }, el("span", { class: "chip", text: kind }), el("span", { class: "queued-text", text }))));
  if (items.length) {
    const edit = el("button", { class: "link", type: "button", text: "Edit queued" });
    edit.addEventListener("click", dequeue);
    box.append(edit);
  }
}

async function dequeue() {
  const { json } = await submit("/api/dequeue", { incarnation: app.incarnation });
  if (!json.ok) { refusal(json); return; }
  const box = $("message");
  box.value = [...(json.texts || []), box.value].filter(Boolean).join("\n\n");
  box.focus();
}

// ---- / commands (MC6): Pi's own list, as the window's completion shows it ------

function renderCompletions() {
  const list = $("completions");
  const match = /^\/([A-Za-z0-9:._-]*)$/.exec($("message").value.trimStart());
  if (!match) { list.hidden = true; list.replaceChildren(); return; }
  const query = match[1].toLowerCase();
  const all = app.commands || [];
  const hits = [...all.filter((c) => c.name.toLowerCase().startsWith(query)), ...(query ? all.filter((c) => !c.name.toLowerCase().startsWith(query) && c.name.toLowerCase().includes(query)) : [])].slice(0, 40);
  list.hidden = !hits.length;
  list.replaceChildren(...hits.map((c) => {
    const item = el("li", { role: "option" });
    const pick = el("button", { type: "button", class: "completion" }, el("span", { class: "name", text: `/${c.name}` }), el("span", { class: "detail", text: c.description }));
    pick.addEventListener("click", () => { $("message").value = `/${c.name} `; renderCompletions(); $("message").focus(); });
    item.append(pick);
    return item;
  }));
}

function setIdentity(s) {
  app.incarnation = s.incarnation;
  $("identity").textContent = [s.windowsUser, s.client, s.sessionName || "this session", app.deviceName].filter(Boolean).join(" · ");
}

function renderMessage(m) {
  let node = app.messages.get(m.id);
  if (!node) {
    node = el("li", { class: `msg ${m.role}` });
    app.messages.set(m.id, node);
    $("timeline").append(node);
  }
  node.className = `msg ${m.role}${m.final ? "" : " partial"}`;
  node.replaceChildren();
  if (m.role === "assistant") renderMarkdown(document, m.text, node);
  else node.append(el("p", { text: m.text }));
}

function renderTool(t) {
  const id = `tool:${t.id}`;
  let node = app.messages.get(id);
  if (!node) { node = el("li", { class: "tool" }); app.messages.set(id, node); $("timeline").append(node); }
  const label = t.label ? ` ${t.label}` : "";
  if (t.state === "running" || !node.dataset.label) node.dataset.label = label;
  node.className = `tool ${t.state}`;
  node.textContent = `${t.state === "running" ? "Running" : t.state === "error" ? "Failed" : "Ran"} ${t.name}${node.dataset.label}`;
}

// ---- questions: the window's own parsers, the VM's own options --------------------

function questionCard(q) {
  const send = async (answer, buttons) => {
    buttons.forEach((b) => { b.disabled = true; });
    const { json } = await submit("/api/answer", { incarnation: app.incarnation, questionId: q.questionId, digest: q.digest, answer });
    if (!json.ok) { refusal(json); buttons.forEach((b) => { b.disabled = false; }); }
  };
  const card = el("section", { class: "card", "aria-label": "coop is asking" });
  const buttons = [];
  const button = (label, kind, answer) => { const b = el("button", { type: "button", class: `btn ${kind}`, text: label, onclick: () => send(answer, buttons) }); buttons.push(b); return b; };
  const desktopOnly = q.phone !== "answer";
  const title = q.title.split("\n")[0];

  if (q.method === "confirm") {
    const parsed = parseConfirm(q.message);
    const labels = confirmLabels({ title: q.title, question: parsed.question, message: q.message });
    if (labels.risky) card.classList.add("risky");
    card.append(el("h2", { text: title || "coop" }),
      ...parsed.blocks.map((b) => (b.kind === "code" ? el("pre", {}, el("code", { text: b.text })) : el("p", { text: b.text }))),
      parsed.question ? el("p", { class: "question", text: parsed.question }) : null);
    const row = el("div", { class: "buttons" });
    // No is first and primary: a stray tap never approves.
    row.append(button(labels.no, "primary", { confirmed: false }));
    if (!desktopOnly) row.append(button(labels.yes, labels.risky ? "danger" : "", { confirmed: true }));
    card.append(row);
  } else if (q.method === "select") {
    const parsed = parseQuestionSelect(q.title, q.options);
    const lines = q.title.split("\n");
    card.append(el("h2", { text: parsed ? (parsed.header ? `Question: ${parsed.header}` : "Question") : lines[0] || "coop" }),
      el("p", { text: parsed ? parsed.question : lines.slice(1).join("\n") }));
    const list = el("div", { class: "options", role: "group" });
    const items = parsed ? parsed.options : q.options.map((value) => ({ value, label: value, description: "" }));
    for (const item of items) {
      if (desktopOnly) break;
      const b = el("button", { type: "button", class: "btn", onclick: () => send({ value: item.value }, buttons) }, el("span", { text: item.label }), item.description ? el("span", { class: "detail", text: item.description }) : null);
      buttons.push(b);
      list.append(b);
    }
    card.append(list, el("div", { class: "buttons" }, button(desktopOnly ? "Decline" : "Cancel", "", { cancelled: true })));
    if (q.hidden > 0 && !desktopOnly) card.append(el("p", { class: "note", text: `${q.hidden} more ${q.hidden === 1 ? "option is" : "options are"} on the desktop only (they allow more than this one action).` }));
  } else if (q.method === "input" && parseQuestionMulti(q.title)) {
    const multi = parseQuestionMulti(q.title);
    const selected = new Set();
    const typed = el("input", { type: "text", placeholder: "Or type your own answer" });
    card.append(el("h2", { text: multi.header ? `Question: ${multi.header}` : "Question" }), el("p", { text: multi.question }),
      ...multi.options.map((o) => el("label", { class: "check-row" }, el("input", { type: "checkbox", onchange: (e) => { if (e.target.checked) selected.add(o.index); else selected.delete(o.index); } }), el("span", { text: o.description ? `${o.label} – ${o.description}` : o.label }))),
      typed);
    const answerBtn = el("button", { type: "button", class: "btn primary", text: "Answer", onclick: () => send({ value: multiAnswer(selected, typed.value) }, buttons) });
    buttons.push(answerBtn);
    card.append(el("div", { class: "buttons" }, answerBtn, button("Cancel", "", { cancelled: true })));
  } else {
    const editor = q.method === "editor";
    const field = editor ? el("textarea", { rows: "10", spellcheck: "false" }) : el("input", { type: "text", placeholder: q.placeholder });
    field.value = editor ? q.prefill : "";
    card.append(el("h2", { text: editor ? title || "Edit" : "coop" }), editor ? null : el("p", { text: q.title }), field);
    const ok = el("button", { type: "button", class: "btn primary", text: editor ? "Save" : "OK", onclick: () => send({ value: field.value }, buttons) });
    buttons.push(ok);
    card.append(el("div", { class: "buttons" }, ok, button("Cancel", "", { cancelled: true })));
  }
  if (desktopOnly) {
    card.classList.add("risky");
    card.append(el("p", { class: "note", text: q.reason === "production" ? "A production change: approve it on the desktop. You can decline it here." : "This needs the desktop. You can decline it here." }));
  }
  return card;
}

// Cards are kept by question, so text typed into one survives another arriving.
const cards = new Map();
function renderQuestions() {
  const box = $("questions");
  for (const id of cards.keys()) if (!app.questions.has(id)) cards.delete(id);
  for (const [id, q] of app.questions) if (!cards.has(id)) cards.set(id, questionCard(q));
  box.replaceChildren(...cards.values());
  if (cards.size) box.lastElementChild.scrollIntoView({ block: "nearest" });
}

// ---- the session ---------------------------------------------------------------

async function load() {
  clearTimeout(app.retry);
  let res;
  try { res = await api("GET", "/api/snapshot"); } catch { showGate("offline"); return; }
  if (!res.json.ok) { showGate(res.json.code); return; }
  const s = res.json.snapshot;
  app.deviceName = res.json.device ? res.json.device.name : "";
  app.messages.clear();
  app.questions.clear();
  cards.clear();
  $("timeline").replaceChildren();
  setIdentity(s);
  app.lastEventId = s.lastEventId;
  for (const m of s.messages) renderMessage(m);
  for (const q of s.questions) app.questions.set(q.questionId, q);
  renderQuestions();
  app.commands = Array.isArray(s.commands) ? s.commands : [];
  renderQueue(s.queue);
  $("gate").hidden = true;
  $("session").hidden = false;
  $("composer").hidden = false;
  app.ready = true;
  setStatus(s.status);
  openStream();
  const last = $("timeline").lastElementChild;
  if (last) last.scrollIntoView({ block: "end" });
}

function closeStream() {
  if (app.source) { app.source.close(); app.source = null; }
}

function openStream() {
  closeStream();
  // Start right after the snapshot's last event, so nothing between the two is lost.
  const source = new EventSource(`/api/events?after=${encodeURIComponent(app.lastEventId || "")}`);
  app.source = source;
  const on = (type, fn) => source.addEventListener(type, (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.incarnation !== app.incarnation) { load(); return; }
    app.lastEventId = ev.id;
    fn(ev.data, ev);
  });
  // A gap the window can no longer fill: reload the snapshot rather than guess.
  source.addEventListener("resync", () => load());
  on("status", (d) => { setStatus(d.state); if (d.queue) renderQueue(d.queue); });
  on("message", (d) => { renderMessage(d); app.messages.get(d.id).scrollIntoView({ block: "end" }); });
  // Keep the newest line in view, whatever kind it is.
  on("tool", (d) => { renderTool(d); app.messages.get(`tool:${d.id}`).scrollIntoView({ block: "end" }); });
  on("notice", (d) => { const note = el("li", { class: `notice ${d.level}`, text: d.text }); $("timeline").append(note); note.scrollIntoView({ block: "end" }); });
  on("session", (d) => setIdentity(d));
  on("question", (d) => { app.questions.set(d.questionId, d); renderQuestions(); });
  on("question_resolved", (d) => {
    if (!app.questions.delete(d.questionId)) return;
    renderQuestions();
    if (d.by === "desktop") toast("Answered on the desktop.");
    else if (d.outcome !== "answered") toast(d.outcome === "expired" ? "The question timed out." : "The question was cancelled.");
  });
  source.onerror = () => {
    // The stream ends when access goes off, the session changes or the VM is
    // out of reach; buttons wait for the reloaded snapshot, never guess.
    closeStream();
    app.ready = false;
    setStatus("disconnected");
    app.retry = setTimeout(load, 3000);
  };
}

// ---- wiring --------------------------------------------------------------------

async function sendMessage(mode = "steer") {
  const box = $("message");
  const text = box.value.trim();
  if (!text || !app.ready) return;
  if (/^!/.test(text)) { toast("A ! line runs a shell on the VM: use the coop window for that."); return; }
  $("send").disabled = true;
  $("queue-send").disabled = true;
  const { json } = await submit("/api/chat", { incarnation: app.incarnation, text, mode });
  if (json.ok) { box.value = ""; renderCompletions(); } else refusal(json);
  setStatus(app.status);
}

applyTheme(storedTheme());
$("theme").addEventListener("change", (e) => { applyTheme(e.target.value); try { localStorage.setItem("coop-theme", e.target.value); } catch { /* private mode */ } });
$("send").addEventListener("click", () => sendMessage("steer"));
$("queue-send").addEventListener("click", () => sendMessage("queue"));
$("message").addEventListener("input", renderCompletions);
$("message").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); } });
$("stop").addEventListener("click", async () => { const { json } = await submit("/api/stop", { incarnation: app.incarnation }); if (!json.ok) refusal(json); });
$("retry").addEventListener("click", load);
$("signout").addEventListener("click", async () => { await api("POST", "/api/logout", {}); showGate("not-paired"); });
$("pair").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { json } = await api("POST", "/api/pair", { code: $("code").value, deviceName: $("device").value.trim() });
  if (json.ok) { $("code").value = ""; load(); }
  else $("gate-text").textContent = json.code === "rate-limited" ? "Too many tries. Wait a while, then show a new code in the coop window." : "That code is wrong or has expired. Show a new one in the coop window: Session > Phone > Pair a phone.";
});
// The bar and the composer stay on screen, so "scroll into view" must stop
// short of them or the newest line lands underneath the composer.
function keepClear() {
  const root = document.documentElement.style;
  root.scrollPaddingTop = `${document.querySelector(".bar").offsetHeight + 8}px`;
  root.scrollPaddingBottom = `${$("composer").hidden ? 0 : $("composer").offsetHeight + 8}px`;
}
if ("ResizeObserver" in window) { const watch = new ResizeObserver(keepClear); watch.observe(document.querySelector(".bar")); watch.observe($("composer")); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !app.source) load(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
load();
