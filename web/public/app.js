// coop web SPA — renders the governed Pi RPC event stream as a friendly chat.
// Served with a strict CSP (no inline script/style). No dependencies.
"use strict";

// The landing token has already become the HttpOnly cookie by the time this script runs
// (the GET / response set both in one response), so drop it from the address bar / history
// — it shouldn't be shoulder-surfed or copied out of the URL. history API only (no
// navigation, CSP-clean); the cookie remains the real gate.
if (location.search.includes("token=")) {
  try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
}

const $ = (s) => document.querySelector(s);
const transcript = $("#transcript"), scroll = $("#scroll");
const dot = $("#dot"), statusText = $("#statusText");
let agentReadySid = null;
const idleStatus = () => agentReadySid === activeSid && activeSid ? "ready" : "connecting to agent…";
statusText.textContent = "connecting to agent…";
const stopBtn = $("#stop");
const abortRetryBtn = $("#abortRetry");
const sendBtn = $("#send"), steerBtn = $("#steer"), followUpBtn = $("#followUp");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
const stick = (was) => { if (was) scroll.scrollTop = scroll.scrollHeight; };

// The same navigation remains available when the sidebar is collapsed.
$("#sidebarToggle").onclick = () => {
  const sidebar = $("#sessionSidebar");
  sidebar.hidden = !sidebar.hidden;
  document.body.classList.toggle("sidebar-collapsed", sidebar.hidden);
  $("#sidebarToggle").setAttribute("aria-expanded", String(!sidebar.hidden));
};

// One utility view at a time, independent of transcript and approval cards.
let utilityOpener = null;
function closeUtilityPanel(card = null, restoreFocus = true) {
  const panel = $("#utilityPanel"), body = $("#utilityBody");
  if (card && !body.contains(card)) return;
  panel.hidden = true;
  body.replaceChildren();
  if (restoreFocus && utilityOpener?.isConnected) utilityOpener.focus();
  utilityOpener = null;
}
function createUtilityCard(title, existingCard = null) {
  const panel = $("#utilityPanel"), body = $("#utilityBody");
  // Late async callbacks must never resurrect a closed or replaced view.
  if (existingCard && !body.contains(existingCard)) return null;
  if (panel.hidden || !panel.contains(document.activeElement)) utilityOpener = document.activeElement;
  const card = document.createElement("div");
  body.replaceChildren(card);
  $("#utilityTitle").textContent = title;
  panel.hidden = false;
  body.scrollTop = 0;
  $("#utilityTitle").focus();
  return card;
}
$("#utilityClose").onclick = () => closeUtilityPanel();
$("#utilityPanel").addEventListener("keydown", event => {
  if (event.key === "Escape" && !event.defaultPrevented) {
    event.preventDefault(); closeUtilityPanel();
  }
});

// --- markdown-lite (escape FIRST, then a few safe transforms) -----------------
// Supports: fenced code blocks, headings, bullet + ordered lists, blockquotes,
// GFM tables (rows must start with |), horizontal rules, inline code, **bold**,
// *italic*, and bare http(s) links. Everything else stays literal text — no raw
// HTML ever.
function renderMarkdown(raw) {
  const lines = String(raw).split("\n");
  const out = [];
  let inCode = false, code = [], inUl = false, inOl = false, quote = [], table = [];
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  // Tokenize code spans FIRST, then apply bold/italic/link transforms only to the
  // non-code segments — so ** or URLs inside `code` stay literal and spans
  // can't misnest across each other.
  const inline = (s) => {
    const escaped = esc(s);
    const parts = escaped.split(/(`[^`\n]+`)/);
    return parts
      .map((part) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return `<code>${part.slice(1, -1)}</code>`;
        }
        return part
          .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
          .replace(/(^|[^*])\*([^*\s][^*\n]*)\*(?!\*)/g, "$1<i>$2</i>")
          .replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`);
      })
      .join("");
  };
  const flushQuote = () => {
    if (quote.length) { out.push(`<blockquote>${quote.join("<br>")}</blockquote>`); quote = []; }
  };
  const codeBlock = (value) => `<div class="portable-code"><button type="button" class="copy-plain" data-copy-kind="code">Copy code</button><pre><code>${esc(value)}</code></pre></div>`;
  // A buffered run of |-prefixed lines becomes a table if line 2 is a separator
  // row (|---|:---:|…); otherwise the run renders as plain paragraphs.
  const flushTable = () => {
    if (!table.length) return;
    const rows = table; table = [];
    const cells = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inline(c.trim()));
    if (rows.length >= 2 && /^\s*\|[\s:|-]+\|?\s*$/.test(rows[1]) && rows[1].includes("-")) {
      const html = ['<div class="portable-table"><div class="portable-copybar"><button type="button" class="copy-plain" data-copy-kind="table">Copy table</button></div><table><thead><tr>'];
      for (const c of cells(rows[0])) html.push(`<th>${c}</th>`);
      html.push("</tr></thead><tbody>");
      for (const row of rows.slice(2)) {
        html.push("<tr>");
        for (const c of cells(row)) html.push(`<td>${c}</td>`);
        html.push("</tr>");
      }
      html.push("</tbody></table></div>");
      out.push(html.join(""));
    } else {
      for (const row of rows) out.push(`<p>${inline(row)}</p>`);
    }
  };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) { out.push(codeBlock(code.join("\n"))); code = []; }
      else { closeLists(); flushQuote(); flushTable(); }
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (/^\s*\|/.test(line)) { closeLists(); flushQuote(); table.push(line); continue; }
    flushTable();
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { closeLists(); quote.push(inline(q[1])); continue; }
    flushQuote();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeLists(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeLists(); out.push("<hr>"); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (inOl) closeLists(); if (!inUl) { out.push("<ul>"); inUl = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) { if (inUl) closeLists(); if (!inOl) { out.push("<ol>"); inOl = true; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeLists();
    if (line.trim() === "") out.push("<p></p>");
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && code.length) out.push(codeBlock(code.join("\n")));
  closeLists(); flushQuote(); flushTable();
  return out.join("");
}
// Shared with viewer.js (Files panel) so markdown files render like chat markdown.
window.renderMarkdown = renderMarkdown;

// --- transcript primitives -----------------------------------------------------
function bubble(role, text = "") {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  const b = document.createElement("div");
  b.className = "bubble";
  if (role === "assistant") { b.dataset.raw = text; b.innerHTML = renderMarkdown(text); }
  else b.textContent = text;
  wrap.appendChild(b);
  if (role === "assistant") {
    const actions = document.createElement("div"); actions.className = "message-copybar";
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "copy-plain"; copy.dataset.copyKind = "message"; copy.title = "Copy response"; copy.setAttribute("aria-label", "Copy response as plain text");
    copy.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
    actions.appendChild(copy); wrap.appendChild(actions);
  }
  transcript.appendChild(wrap);
  scroll.scrollTop = scroll.scrollHeight;
  return b;
}

function sanitizeErrorMessage(raw, fallback = "Model request failed.") {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  return raw
    .replace(/(sk-[A-Za-z0-9_-]{8,})/gi, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)[=:]\s*['"]?)[A-Za-z0-9._~+/-]{8,}(['"]?)/gi, "$1[REDACTED]$2")
    .replace(/((?:[?&]key=))[A-Za-z0-9._~+/-]{8,}/gi, "$1[REDACTED]");
}

function renderAssistantError(text, targetBubble = null) {
  const sanitized = sanitizeErrorMessage(text);
  const errDiv = document.createElement("div");
  errDiv.className = "error-callout";
  errDiv.style.marginTop = targetBubble ? "8px" : "0px";
  errDiv.style.padding = "6px 10px";
  errDiv.style.borderRadius = "4px";
  errDiv.style.backgroundColor = "rgba(239, 68, 68, 0.12)";
  errDiv.style.border = "1px solid rgba(239, 68, 68, 0.35)";
  errDiv.style.color = "var(--bad, #f87171)";
  errDiv.style.wordBreak = "break-word";
  const icon = document.createElement("span");
  icon.textContent = "⚠️ ";
  const msg = document.createElement("span");
  msg.textContent = sanitized;
  errDiv.append(icon, msg);

  if (targetBubble) {
    targetBubble.appendChild(errDiv);
    return targetBubble;
  }
  const wrap = document.createElement("div");
  wrap.className = "msg assistant error";
  const b = document.createElement("div");
  b.className = "bubble";
  b.appendChild(errDiv);
  wrap.appendChild(b);
  transcript.appendChild(wrap);
  scroll.scrollTop = scroll.scrollHeight;
  return b;
}

let current = null; // current streaming assistant bubble
let tools = new Map(); // toolCallId -> { sum, outp, hint }
let thinkingEl = null; // current streaming thinking <details> (open while streaming)
let assistantT0 = 0; // when the current assistant message started (for tok/s)

// Streaming renders are BATCHED to one paint per animation frame. A long answer arrives
// as hundreds of text_delta events; re-running renderMarkdown() over the WHOLE message
// on every delta is O(n²) string work + O(n) DOM churn — janky on modest VMs, and it
// thrashes during switchChat() replay and /events-poll catch-up bursts. We append to
// dataset.raw immediately (the source of truth) and coalesce the actual render into a
// single requestAnimationFrame; flushStreaming() forces it synchronously at turn
// boundaries so the final bubble is never left mid-render.
let rafId = 0;
let streamWas = false;   // were we at the bottom when this frame's first delta landed?
let thinkingRaw = "";    // accumulated reasoning text for the current thinking block
function scheduleStreamRender() {
  if (rafId) return; // a render is already queued for this frame — deltas just accumulate
  streamWas = atBottom(); // capture stickiness before this frame's content lands
  rafId = requestAnimationFrame(() => { rafId = 0; renderStreaming(); });
}
function renderStreaming() {
  if (current) current.innerHTML = renderMarkdown(current.dataset.raw || "");
  if (thinkingEl) thinkingEl.lastElementChild.textContent = thinkingRaw;
  stick(streamWas);
}
// Synchronous flush: render any pending deltas NOW (cancelling the queued frame) so a
// turn boundary — text/message/agent end, or folding the thinking block — never leaves
// the last deltas unrendered. Safe to call when nothing is pending.
function flushStreaming() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  renderStreaming();
}

function appendAssistant(delta) {
  if (!current) current = bubble("assistant", "");
  current.dataset.raw = (current.dataset.raw || "") + delta;
  scheduleStreamRender();
}

// Reasoning stream: a collapsible block that stays open while the model thinks,
// then folds shut when the visible answer starts (the TUI shows the same stream).
function appendThinking(delta) {
  if (!thinkingEl) {
    const det = document.createElement("details");
    det.className = "thinking";
    det.open = true;
    const sum = document.createElement("summary");
    sum.textContent = "✦ thinking";
    const content = document.createElement("div");
    content.className = "content";
    det.append(sum, content);
    transcript.appendChild(det);
    thinkingEl = det;
    thinkingRaw = "";
  }
  thinkingRaw += delta;
  scheduleStreamRender();
}
function endThinking() {
  if (thinkingEl) { flushStreaming(); thinkingEl.open = false; } // render final reasoning before folding
  thinkingEl = null;
}

// Status line: what coop is doing right now + for how long ("running sql_review… 34s").
let busySince = 0, curTool = "", statusPhase = "", statusTimer = null;
function renderStatus() {
  if (!dot.classList.contains("busy")) return;
  const secs = Math.floor((Date.now() - busySince) / 1000);
  const t = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const doing = statusPhase || (curTool ? `running ${curTool}` : "thinking");
  statusText.textContent = `${doing}… ${t}`;
}
function setBusy(b) {
  dot.classList.toggle("busy", b);
  stopBtn.hidden = !b;
  sendBtn.hidden = b;
  steerBtn.hidden = !b;
  followUpBtn.hidden = !b;
  if (b) {
    if (!busySince) busySince = Date.now(); // replayed agent_starts keep the original clock
    if (!statusTimer) statusTimer = setInterval(renderStatus, 1000);
    renderStatus();
  } else {
    busySince = 0; curTool = "";
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (!statusPhase) statusText.textContent = idleStatus();
  }
}

let retryActive = false;
function setRetryActive(active, detail = "") {
  retryActive = Boolean(active);
  abortRetryBtn.hidden = !retryActive;
  abortRetryBtn.title = retryActive ? (detail || "Stop Pi's active automatic retry sequence") : "";
}

const queuesBySid = new Map();
function queueFor(sid = activeSid) {
  if (!queuesBySid.has(sid)) queuesBySid.set(sid, { steering: [], followUp: [], pendingUnknown: 0 });
  return queuesBySid.get(sid);
}
function renderQueue() {
  const lane = $("#queueLane");
  const queue = queueFor();
  lane.textContent = "";
  const add = (kind, message) => {
    const item = document.createElement("span");
    item.className = `queue-item ${kind}`;
    item.textContent = `${kind === "steer" ? "Steer" : "Next"}: ${message}`;
    item.title = message;
    lane.appendChild(item);
  };
  for (const message of queue.steering) add("steer", message);
  for (const message of queue.followUp) add("follow", message);
  if (!queue.steering.length && !queue.followUp.length && queue.pendingUnknown > 0) {
    add("follow", `${queue.pendingUnknown} queued message${queue.pendingUnknown === 1 ? "" : "s"}`);
  }
  lane.hidden = lane.children.length === 0;
}

// --- tool activity helpers ------------------------------------------------------
function toolHint(args) {
  const a = args || {};
  const s = typeof a.command === "string" ? a.command
    : typeof a.path === "string" ? a.path
    : typeof a.file === "string" ? a.file
    : typeof a.object === "string" ? a.object : "";
  if (!s) return "";
  const short = s.length > 64 ? s.slice(0, 63) + "…" : s;
  return ` <span class="hint">${esc(short)}</span>`;
}
function formatToolArgs(args) {
  if (args && typeof args === "object" && typeof args.command === "string") return args.command;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}
function resultText(result) {
  const c = result && Array.isArray(result.content) ? result.content : [];
  return c.filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
}
function fmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

// --- "viewing this file" context (Files panel) ----------------------------------
// When a file is open in the Files panel with attach enabled, the outgoing prompt
// is wrapped with a directive naming that file, so "this file" / "here" resolve
// without typing a path. The wrapped form is what the agent sees and what the
// session persists — so EVERY user-bubble render path strips it back out and
// shows a 📎 chip instead (the round-trip must match wrapViewingContext exactly).
const VIEW_TAG = "coop-viewing-context";
function wrapViewingContext(text, filePath) {
  const directive =
    `The user is currently viewing this file in the coop web Files panel:\n${filePath}\n` +
    `If they refer to "this file", "this", "here", or mention a section, object, ` +
    `measure, query, or name without specifying a file, assume they mean this file ` +
    `and read it with your tools as needed.`;
  return `<${VIEW_TAG} file="${filePath}">\n${directive}\n</${VIEW_TAG}>\n\n${text}`;
}
// Lazy capture up to the first `">` so a filename containing a `"` (legal on
// macOS/Linux) still round-trips instead of leaking the raw wrapper into the bubble.
const VIEW_RE = new RegExp(`^<${VIEW_TAG} file="([\\s\\S]*?)">[\\s\\S]*?</${VIEW_TAG}>\\n*`);
function stripViewingContext(raw) {
  const m = VIEW_RE.exec(String(raw));
  if (!m) return { file: "", text: String(raw) };
  return { file: m[1], text: String(raw).slice(m[0].length) };
}

function stripTextAttachments(raw) {
  return window.CoopPortability.unwrapTextAttachments(raw);
}

// The one way a user turn becomes a bubble (live sends, replays, backfills).
function userBubble(raw) {
  const attached = stripTextAttachments(raw);
  const { file, text } = stripViewingContext(attached.text);
  if (!text.trim() && !file && !attached.files.length) return;
  const b = bubble("user", text);
  if (file) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.textContent = "📎 " + (file.split(/[\\/]/).pop() || file);
    chip.title = file;
    b.appendChild(chip);
  }
  for (const name of attached.files) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.textContent = `📄 ${name}`;
    chip.title = `${name} was attached as bounded plain text`;
    b.appendChild(chip);
  }
}

function toast(message, kind = "info") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = message;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 6000);
}
window.toast = toast; // shared with viewer.js / diffview.js panels for error messaging

function tableMatrix(table) {
  return [...(table?.rows || [])].map((row) => [...row.cells].map((cell) => cell.textContent || ""));
}

// Explicit copy controls write one plain-text payload. Native selection/copy is
// deliberately untouched, so selected text remains exactly the user's selection.
document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("button.copy-plain") : null;
  if (!button) return;
  let value = typeof button._coopCopyText === "string" ? button._coopCopyText : null;
  if (value === null && button.dataset.copyKind === "message") value = button.closest(".msg")?.querySelector(".bubble")?.dataset.raw ?? "";
  if (value === null && button.dataset.copyKind === "code") value = button.closest(".portable-code")?.querySelector("pre code, pre")?.textContent ?? "";
  if (value === null && button.dataset.copyKind === "table") value = window.CoopPortability.tableToTsv(tableMatrix(button.closest(".portable-table")?.querySelector("table")));
  if (value === null) return;
  button.disabled = true;
  try {
    await window.CoopPortability.writePlainText(value);
    toast(button.dataset.copyKind === "table"
      ? "Table copied."
      : button.dataset.copyKind === "message"
        ? "Response copied."
        : "Code copied.");
  } catch (error) {
    toast(error?.message || "Plain-text copy failed.", "error");
  } finally {
    button.disabled = false;
  }
});

// --- extension UI requests (Start Here menu, approvals, prompts) ---------------
async function respond(id, payload) {
  try {
    await post("/ui-response", { id, ...payload });
  } catch {
    toast("Couldn't deliver your answer — is coop web still running?", "error");
  }
}

function uiCard(req) {
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = req.title || "coop";
  card.appendChild(title);
  if (req.message) { const p = document.createElement("p"); p.textContent = req.message; card.appendChild(p); }

  const done = (payload) => { card.querySelectorAll("button,input,textarea").forEach((e) => (e.disabled = true)); respond(req.id, payload); };

  if (req.method === "select") {
    const row = document.createElement("div"); row.className = "row";
    (req.options || []).forEach((opt) => {
      const btn = document.createElement("button"); btn.textContent = opt;
      btn.onclick = () => done({ value: opt });
      row.appendChild(btn);
    });
    // Match the TUI's Esc: selects are cancellable per the RPC protocol.
    const dismiss = document.createElement("button");
    dismiss.className = "ghost"; dismiss.textContent = "Dismiss";
    dismiss.onclick = () => done({ cancelled: true });
    row.appendChild(dismiss);
    card.appendChild(row);
  } else if (req.method === "confirm") {
    const row = document.createElement("div"); row.className = "row";
    const yes = document.createElement("button"); yes.textContent = "Yes"; yes.onclick = () => done({ confirmed: true });
    const no = document.createElement("button"); no.className = "ghost"; no.textContent = "No"; no.onclick = () => done({ confirmed: false });
    row.append(yes, no); card.appendChild(row);
  } else if (req.method === "input" || req.method === "editor") {
    const field = document.createElement(req.method === "editor" ? "textarea" : "input");
    if (req.method === "editor") field.rows = 5;
    field.value = req.prefill || "";
    field.placeholder = req.placeholder || "";
    const row = document.createElement("div"); row.className = "row"; row.style.marginTop = "8px";
    const ok = document.createElement("button"); ok.textContent = "OK"; ok.onclick = () => done({ value: field.value });
    const skip = document.createElement("button"); skip.className = "ghost"; skip.textContent = "Cancel"; skip.onclick = () => done({ cancelled: true });
    row.append(ok, skip);
    card.append(field, row);
    if (req.method === "input") field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done({ value: field.value }); } });
  } else { return; }

  transcript.appendChild(card);
  stick(was);
}

// --- structured capability results + generic findings workbench ----------------
const SEV_ORDER = ["error", "warning", "info"];

const structuredReviewBaselines = new Map();
const STRUCTURED_REVIEW_NAMES = Object.freeze({ "coop.review.sql": "SQL review", "coop.review.dax": "DAX review", "coop.review.bpa": "BPA review" });

async function loadRawArtifact(envelope) {
  const artifact = envelope.artifacts?.find((item) => item.kind === "raw-tool-output");
  if (!artifact) return null;
  const response = await fetch(`/runtime-artifact?sid=${encodeURIComponent(activeSid)}&id=${encodeURIComponent(artifact.id)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Raw tool output is unavailable.");
  return body.artifact;
}

function appendRawArtifact(card, envelope, open = false) {
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = "Raw structured output";
  const pre = document.createElement("pre");
  pre.textContent = "Open to load the original tool artifact.";
  let loaded = false;
  details.ontoggle = async () => {
    if (!details.open || loaded) return;
    loaded = true;
    try { pre.textContent = JSON.stringify(await loadRawArtifact(envelope), null, 2); }
    catch (error) { pre.textContent = error.message || "Raw tool output is unavailable."; }
  };
  details.append(summary, pre);
  card.appendChild(details);
  if (open) details.ontoggle();
}

function genericExecutionCard(evt, view) {
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card review";
  const title = document.createElement("h3");
  title.textContent = `${evt.envelope.capabilityId} result`;
  const state = document.createElement("p");
  state.textContent = `Execution: ${evt.envelope.executionStatus} · evidence: ${evt.envelope.evidenceStatus} · verdict: ${evt.envelope.verdict}`;
  card.append(title, state);
  if (view.actions.includes("show-raw")) appendRawArtifact(card, evt.envelope, true);
  transcript.appendChild(card);
  stick(was);
}

function composerAction(label, text) {
  const button = document.createElement("button");
  button.className = "ghost";
  button.textContent = label;
  button.onclick = () => putCommandInComposer(text);
  return button;
}

function structuredReviewCard(evt, view) {
  const model = window.CoopFindings?.build(evt.envelope, { toolName: evt.toolName });
  if (!model) { genericExecutionCard(evt, { actions: ["show-raw"] }); return; }
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card review findings-workbench";
  const title = document.createElement("h3");
  const name = STRUCTURED_REVIEW_NAMES[model.capabilityId] || model.capabilityId;
  title.textContent = `${name} — ${model.counts.total} finding${model.counts.total === 1 ? "" : "s"}`;
  const state = document.createElement("div");
  state.className = `evidence-state evidence-${model.evidenceStatus}`;
  state.textContent = `Evidence: ${model.evidenceStatus} · ${model.counts.error} error · ${model.counts.warning} warning · ${model.counts.info} info`;
  card.append(title, state);
  if (!model.complete) {
    const warning = document.createElement("div");
    warning.className = "evidence-warning";
    warning.textContent = model.evidenceStatus === "partial"
      ? "Evidence is partial. Findings are usable, but absence of another finding is not a clean pass."
      : `Evidence is ${model.evidenceStatus}; this result is not a clean pass.`;
    const coverage = document.createElement("pre");
    coverage.textContent = JSON.stringify(model.coverage, null, 2);
    warning.appendChild(coverage);
    card.appendChild(warning);
  } else if (!model.counts.total) {
    const clean = document.createElement("p");
    clean.textContent = "No deterministic findings at this threshold. Evidence is complete.";
    card.appendChild(clean);
  }

  const previous = structuredReviewBaselines.get(model.capabilityId) || null;
  const delta = window.CoopFindings.compare(model, previous);
  structuredReviewBaselines.set(model.capabilityId, model);
  const deltaLine = document.createElement("p");
  deltaLine.className = "review-delta";
  deltaLine.textContent = previous
    ? `Prior run: ${delta.new.length} new · ${delta.persisting.length} persisting · ${delta.fixed.length} fixed.`
    : "This run is now the in-session comparison baseline.";
  card.appendChild(deltaLine);

  const criteria = { severity: "", ruleId: "", file: "", object: "", groupBy: "severity", changedOnly: false, changedFiles: null };
  const filters = document.createElement("div");
  filters.className = "finding-filters";
  const list = document.createElement("div");
  const newIds = new Set(delta.new.map((item) => item.id));
  const render = () => {
    list.textContent = "";
    const visible = window.CoopFindings.filter(model, criteria).visibleFindings;
    if (!visible.length) { const empty = document.createElement("p"); empty.textContent = "No findings match these filters."; list.appendChild(empty); }
    const groupField = criteria.groupBy;
    const groupKeys = groupField === "severity"
      ? SEV_ORDER
      : [...new Set(visible.map((item) => item[groupField] || "Unspecified"))].sort((a, b) => a.localeCompare(b));
    for (const group of groupKeys) {
      const items = visible.filter((item) => (item[groupField] || "Unspecified") === group);
      if (!items.length) continue;
      const heading = document.createElement("div"); heading.className = `sev${groupField === "severity" ? ` ${group}` : ""}`; heading.textContent = `${String(group).toUpperCase()} (${items.length})`; list.appendChild(heading);
      for (const finding of items) {
        const row = document.createElement("article"); row.className = "finding";
        const line = document.createElement("div");
        const rule = document.createElement("span"); rule.className = "rule"; rule.textContent = finding.ruleId || "Unclassified";
        const marker = document.createElement("span"); marker.className = "finding-delta"; marker.textContent = newIds.has(finding.id) ? "new" : previous ? "persisting" : "baseline";
        line.append(rule, document.createTextNode(` ${finding.message}`), marker); row.appendChild(line);
        const location = [finding.file, finding.line].filter((value) => value !== null && value !== "").join(":");
        if (location || finding.object) { const loc = document.createElement("div"); loc.className = "loc"; loc.textContent = [location, finding.object].filter(Boolean).join(" — "); row.appendChild(loc); }
        const context = Object.entries(finding.context || {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
        if (context) { const contextLine = document.createElement("div"); contextLine.className = "finding-context"; contextLine.textContent = context; row.appendChild(contextLine); }
        if (finding.code) { const code = document.createElement("pre"); code.className = "finding-code"; code.textContent = finding.code; row.appendChild(code); }
        if (finding.remediation) { const fix = document.createElement("p"); fix.className = "finding-remediation"; fix.textContent = `Remediation: ${finding.remediation}`; row.appendChild(fix); }
        if (finding.fingerprint || finding.standardRef || finding.suppressed) { const metadata = document.createElement("div"); metadata.className = "finding-meta"; metadata.textContent = [finding.standardRef && `standard ${finding.standardRef}`, finding.fingerprint && `fingerprint ${finding.fingerprint}`, finding.suppressed && "suppressed"].filter(Boolean).join(" · "); row.appendChild(metadata); }
        const actions = document.createElement("div"); actions.className = "row finding-actions";
        const reference = [finding.ruleId, location, finding.object].filter(Boolean).join(" at ");
        if (view.actions.includes("ask-agent")) actions.appendChild(composerAction("Ask Coop", `Explain and prioritize ${reference || "this finding"}: ${finding.message}`));
        if (view.actions.includes("add-change-plan")) actions.appendChild(composerAction("Add to change plan", `Add this deterministic finding to the change plan: ${reference || finding.message}`));
        if (finding.file && view.actions.includes("open-source")) { const open = document.createElement("button"); open.className = "ghost"; open.textContent = "Open source"; open.onclick = () => window.coopFiles?.openPath?.(finding.file, finding.line); actions.appendChild(open); }
        if (finding.file && finding.line && view.actions.includes("open-source")) {
          const contextButton = document.createElement("button"); contextButton.className = "ghost"; contextButton.textContent = "Show context";
          contextButton.onclick = async () => {
            contextButton.disabled = true;
            let source = row.querySelector(".finding-source-context");
            if (!source) { source = document.createElement("pre"); source.className = "finding-source-context"; row.insertBefore(source, actions); }
            source.textContent = "Loading source context…";
            try {
              const response = await fetch(`/file?sid=${encodeURIComponent(activeSid)}&p=${encodeURIComponent(finding.file)}`);
              const body = await response.json();
              if (!response.ok || typeof body.content !== "string") throw new Error(body.error || "Source context is unavailable.");
              const lines = body.content.split(/\r?\n/); const start = Math.max(0, finding.line - 3); const end = Math.min(lines.length, finding.line + 2);
              source.textContent = lines.slice(start, end).map((text, index) => `${String(start + index + 1).padStart(5)}  ${text}`).join("\n");
            } catch (error) { source.textContent = error.message || "Source context is unavailable."; }
            contextButton.disabled = false;
          };
          actions.appendChild(contextButton);
        }
        if (actions.childElementCount) row.appendChild(actions);
        list.appendChild(row);
      }
    }
    if (model.agentReview.length) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Agent review prompts (${model.agentReview.length}) — judgment, not deterministic findings`; const pre = document.createElement("pre"); pre.textContent = model.agentReview.map((item) => `${item.ruleId ? `${item.ruleId}: ` : ""}${item.message}`).join("\n"); details.append(summary, pre); list.appendChild(details); }
  };
  const addSelect = (label, field, values) => {
    const select = document.createElement("select"); select.setAttribute("aria-label", label);
    const all = document.createElement("option"); all.value = ""; all.textContent = label; select.appendChild(all);
    for (const value of values) { const option = document.createElement("option"); option.value = value; option.textContent = value; select.appendChild(option); }
    select.onchange = () => { criteria[field] = select.value; render(); }; filters.appendChild(select);
  };
  addSelect("All severities", "severity", model.filters.severities);
  addSelect("All rules", "ruleId", model.filters.rules);
  addSelect("All files", "file", model.filters.files);
  addSelect("All objects", "object", model.filters.objects);
  const grouping = document.createElement("select"); grouping.setAttribute("aria-label", "Group findings");
  for (const [value, label] of [["severity", "Group by severity"], ["file", "Group by file"], ["ruleId", "Group by rule"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; grouping.appendChild(option); }
  grouping.onchange = () => { criteria.groupBy = grouping.value; render(); }; filters.appendChild(grouping);
  const changedLabel = document.createElement("label"); const changed = document.createElement("input"); changed.type = "checkbox";
  changed.onchange = async () => {
    criteria.changedOnly = changed.checked;
    if (changed.checked && !criteria.changedFiles) {
      changed.disabled = true;
      try { const response = await fetch(`/git/changes?sid=${encodeURIComponent(activeSid)}`); const body = await response.json(); if (!response.ok || body.ok === false) throw new Error(body.error || "Changed files could not be loaded."); criteria.changedFiles = new Set((body.files || []).map((item) => item.path)); }
      catch { criteria.changedFiles = new Set(); toast("Changed files could not be loaded.", "warning"); }
      changed.disabled = false;
    }
    render();
  };
  changedLabel.append(changed, document.createTextNode(" changed files only")); filters.appendChild(changedLabel);
  card.append(filters, list); render();
  if (delta.fixed.length) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Fixed since prior run (${delta.fixed.length})`; const pre = document.createElement("pre"); pre.textContent = delta.fixed.map((item) => `${item.ruleId}: ${item.message}`).join("\n"); details.append(summary, pre); card.appendChild(details); }
  if (model.diagnostics.length) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Diagnostics (${model.diagnostics.length})`; const pre = document.createElement("pre"); pre.textContent = JSON.stringify(model.diagnostics, null, 2); details.append(summary, pre); card.appendChild(details); }
  if (view.actions.includes("show-raw")) appendRawArtifact(card, model.raw);
  transcript.appendChild(card);
  stick(was);
}

function lineageExecutionCard(evt, view) {
  const model = window.CoopLineage?.build(evt.envelope);
  if (!model) { genericExecutionCard(evt, { actions: ["show-raw"] }); return; }
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card lineage-workbench";
  const title = document.createElement("h3");
  title.textContent = model.ambiguous ? `Lineage — “${model.query}” is ambiguous` : `Lineage — ${model.focus.name}`;
  const state = document.createElement("div");
  state.className = `evidence-state evidence-${model.evidenceStatus}`;
  state.textContent = `Evidence: ${model.evidenceStatus}`;
  card.append(title, state);

  if (model.ambiguous) {
    const explanation = document.createElement("p");
    explanation.textContent = "Data Doc returned multiple candidates and did not guess. Choose an exact object to run a focused query.";
    const candidates = document.createElement("div");
    candidates.className = "lineage-candidates";
    for (const node of model.matches) {
      const button = composerAction(`${node.name} · ${node.type}`, `Use data_doc lineage for the exact object id ${node.id}.`);
      button.title = [node.sourceFile, node.id].filter(Boolean).join(" · ");
      candidates.appendChild(button);
    }
    card.append(explanation, candidates);
    if (view.actions.includes("show-raw")) appendRawArtifact(card, model.raw);
    transcript.appendChild(card);
    stick(was);
    return;
  }

  if (!model.complete) {
    const warning = document.createElement("div");
    warning.className = "evidence-warning";
    warning.textContent = "This focused slice contains incomplete evidence. Treat missing dependencies as unknown, not absent.";
    if (Object.keys(model.coverage || {}).length) { const coverage = document.createElement("pre"); coverage.textContent = JSON.stringify(model.coverage, null, 2); warning.appendChild(coverage); }
    card.appendChild(warning);
  }

  const search = document.createElement("input");
  search.className = "lineage-search";
  search.placeholder = `Filter ${model.nodes.length} focused objects by name, type, layer, or source…`;
  const columns = document.createElement("div");
  columns.className = "lineage-columns";
  const sections = new Map();
  for (const [key, label] of [["upstream", `Upstream (${model.upstream.length})`], ["focus", "Selected object"], ["downstream", `Downstream (${model.downstream.length})`]]) {
    const section = document.createElement("section");
    section.className = `lineage-column lineage-${key}`;
    const heading = document.createElement("h4"); heading.textContent = label;
    const list = document.createElement("div"); section.append(heading, list); columns.appendChild(section); sections.set(key, list);
  }
  const nodeElements = new Map();
  const nodeCard = (node) => {
    const item = document.createElement("article"); item.className = "lineage-node";
    const name = document.createElement("b"); name.textContent = node.name;
    const badges = document.createElement("div"); badges.className = "lineage-node-badges";
    for (const value of [node.type, node.layer]) { if (!value) continue; const badge = document.createElement("span"); badge.textContent = value; badges.appendChild(badge); }
    const id = document.createElement("code"); id.textContent = node.id;
    item.append(name, badges, id);
    if (node.sourceFile) { const source = document.createElement("div"); source.className = "loc"; source.textContent = node.sourceFile; item.appendChild(source); }
    const trustEntries = Object.entries(node.trust || {}).filter(([, value]) => value !== false && value !== "" && value !== null && value !== undefined && (!Array.isArray(value) || value.length));
    if (trustEntries.length) { const trust = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Trust markers (${trustEntries.length})`; const pre = document.createElement("pre"); pre.textContent = JSON.stringify(Object.fromEntries(trustEntries), null, 2); trust.append(summary, pre); item.appendChild(trust); }
    const actions = document.createElement("div"); actions.className = "row lineage-actions";
    if (view.actions.includes("ask-agent")) actions.appendChild(composerAction("Ask Coop", `Explain the role and impact of Data Doc object ${node.id}.`));
    if (view.actions.includes("open-source") && node.sourcePath) { const open = document.createElement("button"); open.className = "ghost"; open.textContent = "Open source"; open.onclick = () => window.coopFiles?.openPath?.(node.sourcePath); actions.appendChild(open); }
    if (view.actions.includes("open-source") && node.docPath) { const openDoc = document.createElement("button"); openDoc.className = "ghost"; openDoc.textContent = "Open docs"; openDoc.onclick = () => window.coopFiles?.openPath?.(node.docPath); actions.appendChild(openDoc); }
    if (actions.childElementCount) item.appendChild(actions);
    nodeElements.set(node.id, item);
    return item;
  };
  for (const node of model.upstream) sections.get("upstream").appendChild(nodeCard(node));
  sections.get("focus").appendChild(nodeCard(model.focus));
  for (const node of model.downstream) sections.get("downstream").appendChild(nodeCard(node));
  search.oninput = () => {
    const visible = new Set(window.CoopLineage.search(model, search.value).map((node) => node.id));
    for (const [id, element] of nodeElements) element.hidden = !visible.has(id);
  };
  card.append(search, columns);

  const edgeDetails = document.createElement("details"); edgeDetails.open = true;
  const edgeSummary = document.createElement("summary"); edgeSummary.textContent = `Evidence paths (${model.edges.length})`;
  const edgeList = document.createElement("div"); edgeList.className = "lineage-edges";
  for (const edge of model.edges) {
    const item = document.createElement("div"); item.className = "lineage-edge";
    const path = document.createElement("code"); path.textContent = `${edge.upstreamId || edge.sourceId} → ${edge.downstreamId || edge.targetId}`;
    const kind = document.createElement("span"); kind.className = "rule"; kind.textContent = edge.type || "relationship";
    const evidence = document.createElement("span"); evidence.textContent = edge.evidence || "No edge evidence recorded.";
    item.append(path, kind, evidence); edgeList.appendChild(item);
  }
  if (!model.edges.length) { const empty = document.createElement("p"); empty.textContent = "This Data Doc response did not include edge evidence. Use the raw output or refresh Data Doc before relying on absence."; edgeList.appendChild(empty); }
  edgeDetails.append(edgeSummary, edgeList); card.appendChild(edgeDetails);
  if (model.relationships.length) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Semantic-model relationships (${model.relationships.length})`; const pre = document.createElement("pre"); pre.textContent = JSON.stringify(model.relationships, null, 2); details.append(summary, pre); card.appendChild(details); }
  if (model.diagnostics.length) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Diagnostics (${model.diagnostics.length})`; const pre = document.createElement("pre"); pre.textContent = JSON.stringify(model.diagnostics, null, 2); details.append(summary, pre); card.appendChild(details); }
  if (view.actions.includes("show-raw")) appendRawArtifact(card, model.raw);
  transcript.appendChild(card);
  stick(was);
}

function impactExecutionCard(evt, view) {
  const model = window.CoopImpact?.build(evt.envelope);
  if (!model) { genericExecutionCard(evt, { actions: ["show-raw"] }); return; }
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card impact-workbench";
  const title = document.createElement("h3");
  title.textContent = `Impact — ${model.target.name || model.target.id}`;
  const state = document.createElement("div");
  state.className = `evidence-state evidence-${model.evidenceStatus}`;
  state.textContent = `Evidence: ${model.evidenceStatus} · risk: ${model.risk.level || "unknown"}`;
  card.append(title, state);
  if (!model.complete) {
    const warning = document.createElement("div");
    warning.className = "evidence-warning";
    warning.textContent = "Impact evidence is incomplete. Missing consumers or paths are unknown, not absent.";
    card.appendChild(warning);
  }

  const section = (heading, items, renderItem) => {
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `${heading} (${items.length})`;
    const body = document.createElement("div");
    body.className = "impact-section";
    if (!items.length) { const empty = document.createElement("p"); empty.textContent = "None observed in the available evidence."; body.appendChild(empty); }
    for (const item of items) body.appendChild(renderItem(item));
    details.append(summary, body);
    card.appendChild(details);
  };
  const evidenceText = (sources) => sources.length
    ? sources.map((source) => `${source.kind}: ${source.label} [${source.status}]`).join(" · ")
    : "No evidence source attached";
  const objectRow = (item) => {
    const row = document.createElement("article"); row.className = "impact-item";
    const name = document.createElement("b"); name.textContent = item.name || item.id;
    const meta = document.createElement("span"); meta.className = "prov"; meta.textContent = `${item.type || "object"} · ${item.classification}`;
    const evidence = document.createElement("span"); evidence.className = "impact-evidence"; evidence.textContent = evidenceText(item.evidence);
    row.append(name, meta, evidence);
    if (item.path && view.actions.includes("open-source")) { const open = document.createElement("button"); open.className = "ghost"; open.textContent = "Open source"; open.onclick = () => window.coopFiles?.openPath?.(item.path); row.appendChild(open); }
    return row;
  };

  const target = document.createElement("section"); target.className = "impact-target";
  const targetTitle = document.createElement("h4"); targetTitle.textContent = "Target and change intent";
  const targetText = document.createElement("p");
  targetText.textContent = `${model.target.type || "object"} ${model.target.id} · ${model.target.changeIntent}. ${model.target.intendedOutcome || ""}`.trim();
  const targetScope = document.createElement("p"); targetScope.className = "prov"; targetScope.textContent = [model.target.environment, model.target.deploymentScope].filter(Boolean).join(" · ") || "Environment/scope not specified.";
  target.append(targetTitle, targetText, targetScope); card.appendChild(target);

  section("Upstream dependencies", model.impacts.upstream, objectRow);
  section("Downstream dependents", model.impacts.downstream, objectRow);
  section("Cross-artifact paths", model.paths, (path) => {
    const row = document.createElement("article"); row.className = "impact-path";
    const chain = document.createElement("code"); chain.textContent = path.nodes.map((node) => node.name || node.id).join(" → ") || "No path nodes returned";
    const meta = document.createElement("span"); meta.className = "prov"; meta.textContent = `${path.direction} · confidence ${path.confidence} · ${evidenceText(path.evidence)}`;
    const explanation = document.createElement("span"); explanation.textContent = path.explanation || "";
    row.append(chain, meta, explanation); return row;
  });

  for (const [key, label] of [["reports", "Reports"], ["apps", "Apps"], ["rls", "RLS"], ["refresh", "Refresh"], ["consumers", "Other consumers"]]) {
    section(label, model.impacts[key], objectRow);
  }
  section("Evidence gaps", model.evidenceGaps, (gap) => {
    const row = document.createElement("article"); row.className = `impact-item gap-${gap.severity}`;
    const name = document.createElement("b"); name.textContent = `${gap.severity}: ${gap.message}`;
    const affects = document.createElement("span"); affects.className = "prov"; affects.textContent = gap.affects?.length ? `Affects ${gap.affects.join(", ")}` : "Scope not specified";
    row.append(name, affects); return row;
  });

  const risk = document.createElement("section"); risk.className = `impact-risk risk-${model.risk.level}`;
  const riskTitle = document.createElement("h4"); riskTitle.textContent = `Risk: ${(model.risk.level || "unknown").toUpperCase()}`;
  const rationale = document.createElement("p"); rationale.textContent = model.risk.rationale || "No rationale returned.";
  const drivers = document.createElement("p"); drivers.className = "prov"; drivers.textContent = model.risk.drivers?.length ? `Drivers: ${model.risk.drivers.join(" · ")}` : "No risk drivers returned.";
  risk.append(riskTitle, rationale, drivers); card.appendChild(risk);

  section("Safer alternatives", model.saferAlternatives, (alternative) => {
    const row = document.createElement("article"); row.className = "impact-item";
    const name = document.createElement("b"); name.textContent = alternative.title;
    const rationale = document.createElement("span"); rationale.textContent = alternative.rationale;
    row.append(name, rationale); return row;
  });
  section("Proposed implementation plan", model.plan.steps, (step) => {
    const row = document.createElement("article"); row.className = "impact-item";
    const name = document.createElement("b"); name.textContent = step.title;
    const description = document.createElement("span"); description.textContent = step.description;
    const meta = document.createElement("span"); meta.className = "prov"; meta.textContent = `${step.approvalRequired ? "Approval required" : "Read-only/no separate approval"}${step.affectedObjects?.length ? ` · ${step.affectedObjects.join(", ")}` : ""}`;
    row.append(name, description, meta); return row;
  });
  const approval = document.createElement("div"); approval.className = "impact-approval";
  approval.textContent = `Implementation approval: ${model.approval.status}${model.approval.required ? " (required before edits)" : ""}. This analysis artifact does not authorize source changes.`;
  card.appendChild(approval);

  const actions = document.createElement("div"); actions.className = "row impact-actions";
  if (view.actions.includes("ask-agent")) actions.appendChild(composerAction("Ask about impact", `Explain the evidence and open questions in impact analysis ${model.analysisId}.`));
  if (view.actions.includes("add-change-plan")) actions.appendChild(composerAction("Review proposed plan", `Review the proposed plan in impact analysis ${model.analysisId}. Do not edit until I explicitly approve a slice.`));
  if (actions.childElementCount) card.appendChild(actions);
  if (view.actions.includes("show-raw")) appendRawArtifact(card, evt.envelope);
  transcript.appendChild(card);
  stick(was);
}

// --- extension dock + unknown-method fallback ----------------------------------
// Extension-UI methods beyond the four dialogs: setStatus/setWidget render in a slim
// dock above the composer (keyed, order-reconstructed from replay); setTitle sets the
// tab title; set_editor_text prefills the composer; anything unknown renders a deduped
// fallback card. Nothing an extension sends is ever silently dropped.
const extStatus = new Map();  // statusKey -> statusText
const extWidgets = new Map(); // widgetKey -> widgetLines[]
const extUnknown = new Map(); // method -> { card, pre, count, countEl }
const extDock = $("#extDock");

// Extensions format for a terminal; we render plain text (no ANSI colorizer in v1):
// CSI sequences incl. SGR colors, OSC sequences with BEL/ST, single-char escapes.
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, "");

// Rebuild #extDock from scratch each call — the dock is tiny, so an O(n) idempotent
// rebuild is the simple-correct choice for replay bursts. CSP-clean (textContent).
function renderExtDock() {
  clearUsage();
  for (const value of extStatus.values()) {
    const text = stripAnsi(String(value));
    const offset = text.indexOf("Usage:");
    if (offset >= 0) maybeUsage(text.slice(offset));
  }
  if (!extDock) return;
  if (!extStatus.size && !extWidgets.size) { extDock.hidden = true; extDock.textContent = ""; return; }
  extDock.hidden = false;
  extDock.textContent = "";
  const addSeg = (cls, key, lines) => {
    const seg = document.createElement("div");
    seg.className = cls;
    seg.title = key;
    for (const line of lines) {
      const el = document.createElement("div");
      el.className = "ext-line";
      el.textContent = stripAnsi(String(line));
      seg.appendChild(el);
    }
    extDock.appendChild(seg);
  };
  for (const key of [...extStatus.keys()].sort()) addSeg("ext-status", key, String(extStatus.get(key)).split("\n"));
  for (const key of [...extWidgets.keys()].sort()) addSeg("ext-widget", key, extWidgets.get(key));
}

// A generic fallback for an unknown extension-UI method, deduped per method so a
// chatty fire-and-forget method updates one card instead of spamming the transcript.
function extFallbackCard(req) {
  const method = String(req.method);
  const existing = extUnknown.get(method);
  if (existing) {
    existing.pre.textContent = JSON.stringify(req, null, 2);
    existing.count++;
    existing.countEl.textContent = `seen ${existing.count}×`;
    return;
  }
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card ext-unknown";
  const h = document.createElement("h3");
  h.textContent = `Extension UI: ${method}`;
  card.appendChild(h);
  if (req.title || req.message) {
    const p = document.createElement("p");
    p.textContent = String(req.title || req.message);
    card.appendChild(p);
  }
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = "Raw request";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(req, null, 2);
  det.append(sum, pre);
  card.appendChild(det);
  const row = document.createElement("div");
  row.className = "row";
  const countEl = document.createElement("span");
  countEl.className = "prov";
  countEl.textContent = "seen 1×";
  const dismiss = document.createElement("button");
  dismiss.className = "ghost";
  dismiss.textContent = "Dismiss";
  dismiss.onclick = () => {
    card.querySelectorAll("button,input,textarea").forEach((e) => (e.disabled = true));
    respond(req.id, { cancelled: true }); // safe: pi ignores responses to non-pending ids; unblocks a dialog-like method
    card.remove();
    extUnknown.delete(method);
  };
  row.append(countEl, dismiss);
  card.appendChild(row);
  transcript.appendChild(card);
  stick(was);
  extUnknown.set(method, { card, pre, count: 1, countEl });
}

// --- event stream ---------------------------------------------------------------
function resetTranscript() {
  transcript.textContent = "";
  current = null;
  tools = new Map();
  thinkingEl = null;
  statusPhase = "";
  extStatus.clear();
  extWidgets.clear();
  extUnknown.clear();
  renderExtDock();
  document.title = "coop"; // new session / chdir / resume starts clean; replay rebuilds state
  setBusy(false);
  setRetryActive(false);
}

function handle(evt) {
  const was = atBottom();
  switch (evt.type) {
    // __hello / __reset are handled by route() (global vs per-chat) — not here.
    case "agent_start": setBusy(true); break;
    case "agent_end":
      setBusy(false);
      flushStreaming(); // render any deltas still batched for this frame before we drop `current`
      endThinking();
      current = null;
      // During a ring replay (tab switch), the ONLY thing agent_end should do is the
      // rendering above — the per-turn side effects below would otherwise fire once per
      // replayed turn (N× get_session_stats RPCs + N× /files scans). switchChat runs
      // them ONCE after the loop.
      if (replaying) break;
      refreshCtx(); // context gauge: cheap read-only stats after each turn (debounced)
      if (window.coopFiles) window.coopFiles.onAgentEnd(); // the agent may have written files
      if (window.coopDiff) window.coopDiff.onAgentEnd(); // ...and changed the git working tree
      break;
    case "queue_update":
      queuesBySid.set(activeSid, window.CoopInteraction.updateQueue(queueFor(), evt));
      renderQueue();
      break;
    case "auto_retry_start": {
      const attempt = Number.isFinite(evt.attempt) ? evt.attempt : "?";
      const maximum = Number.isFinite(evt.maxAttempts) ? evt.maxAttempts : "?";
      setRetryActive(true, `Retry attempt ${attempt} of ${maximum}`);
      statusPhase = `waiting to retry (${attempt}/${maximum})`;
      if (dot.classList.contains("busy")) renderStatus();
      else statusText.textContent = `${statusPhase}…`;
      toast(`The model request failed. Pi will retry (${attempt}/${maximum}); you can stop the retry without aborting the session.`, "warning");
      break;
    }
    case "auto_retry_end":
      setRetryActive(false);
      statusPhase = "";
      if (!dot.classList.contains("busy")) statusText.textContent = evt.success ? "ready" : "retry ended";
      if (!evt.success && evt.finalError) toast(`Automatic retry ended: ${evt.finalError}`, "error");
      break;
    case "__fatal": {
      // This CHAT's agent died (not the whole bridge — other tabs keep running).
      setBusy(false);
      statusPhase = "";
      statusText.textContent = "this chat's agent stopped — close the tab or start a new chat";
      const card = document.createElement("div");
      card.className = "card";
      const h = document.createElement("h3");
      h.textContent = "This chat's agent stopped unexpectedly";
      const p = document.createElement("p");
      p.textContent = evt.code != null ? `The agent process exited (code ${evt.code}).` : "The agent process exited.";
      card.append(h, p);
      if (evt.stderrTail) {
        const pre = document.createElement("pre");
        pre.className = "fatal";
        pre.textContent = evt.stderrTail;
        card.appendChild(pre);
      }
      transcript.appendChild(card);
      stick(true);
      break;
    }
    case "__drift":
      // The bridge saw an event that doesn't match the checked-in protocol
      // contract (protocol.mjs) — usually a Pi upgrade renamed/reshaped something.
      // Deduped server-side (at most one toast per drifting event type per pi
      // child); chat keeps working because the bridge still forwards it verbatim.
      toast(`Unexpected data from the agent (${evt.eventType || "?"}) — a Pi update may have changed the protocol. Chat keeps working; check the coop web console.`, "warning");
      break;
    case "compaction_start":
      statusPhase = "compacting";
      if (evt.reason && evt.reason !== "manual") toast("Context is getting full — compacting the conversation automatically…");
      if (dot.classList.contains("busy")) renderStatus();
      else statusText.textContent = "compacting…";
      break;
    case "compaction_end":
      statusPhase = "";
      if (!dot.classList.contains("busy")) statusText.textContent = "ready";
      refreshCtx();
      break;
    case "__message": {
      // Backfilled turn from a resumed conversation (bridge-synthesized).
      if (evt.role === "user") userBubble(evt.text || "");
      else {
        if (evt.text) bubble("assistant", evt.text);
        for (const name of evt.tools || []) {
          const el = document.createElement("div");
          el.className = "tool";
          el.innerHTML = '<span title="No recorded result">?</span> ' + esc(name);
          transcript.appendChild(el);
        }
      }
      stick(was);
      break;
    }
    case "__replay": {
      // High-fidelity backfill from Pi messages or the session file: dividers,
      // user bubbles, and assistant turns with thinking / tool calls (args + output).
      if (evt.kind === "info" || evt.kind === "compaction") {
        const div = document.createElement("div");
        div.className = "divider";
        div.textContent = evt.kind === "compaction" ? `♻ compacted — ${evt.summary || ""}` : (evt.text || "");
        transcript.appendChild(div);
      } else if (evt.role === "user") {
        userBubble(evt.text || "");
      } else if (evt.role === "assistant") {
        let lastBubble = null;
        for (const part of evt.parts || []) {
          if (part.kind === "thinking") {
            const det = document.createElement("details");
            det.className = "thinking";
            const sum = document.createElement("summary");
            sum.textContent = "✦ thinking";
            const content = document.createElement("div");
            content.className = "content";
            content.textContent = part.text || "";
            det.append(sum, content);
            transcript.appendChild(det);
          } else if (part.kind === "text") {
            lastBubble = bubble("assistant", part.text || "");
          } else if (part.kind === "error") {
            lastBubble = renderAssistantError(part.text || "Model request failed.", lastBubble);
          } else if (part.kind === "tool") {
            const det = document.createElement("details");
            det.className = "toolblock";
            const sum = document.createElement("summary");
            // Same escaped-summary idiom as tool_execution_end: esc() the name,
            // toolHint() escapes its own hint — no unescaped input reaches innerHTML.
            sum.innerHTML = (part.incomplete ? '<span title="No recorded result">?</span> ' : part.isError ? '<span class="bad">✗</span> ' : '<span class="ok">✓</span> ') + esc(part.name || "tool") + toolHint(part.args);
            const body = document.createElement("div");
            body.className = "tool-body";
            const args = document.createElement("pre");
            args.className = "tool-args";
            args.textContent = formatToolArgs(part.args);
            const outp = document.createElement("pre");
            outp.className = "tool-out";
            if (part.output) outp.textContent = part.output; else outp.hidden = true;
            body.append(args, outp);
            det.append(sum, body);
            transcript.appendChild(det);
          }
        }
      }
      stick(was);
      break;
    }
    case "message_start":
      if (evt.message && evt.message.role === "user") {
        // Sole renderer of user bubbles (live sends, replays, steered deliveries).
        const c = Array.isArray(evt.message.content) ? evt.message.content : [];
        const text = c.filter((p) => p.type === "text").map((p) => p.text).join("\n") || (typeof evt.message.content === "string" ? evt.message.content : "");
        if (text.trim()) userBubble(text);
      }
      if (evt.message && evt.message.role === "assistant") { current = null; assistantT0 = Date.now(); }
      break;
    case "message_update": {
      const d = evt.assistantMessageEvent || {};
      if (d.type === "thinking_delta") appendThinking(d.delta || "");
      else if (d.type === "thinking_end") endThinking();
      else if (d.type === "text_start") { endThinking(); current = bubble("assistant", ""); }
      else if (d.type === "text_delta") appendAssistant(d.delta || "");
      break;
    }
    case "message_end": {
      flushStreaming(); // finalize the bubble's markdown before stats read `current` / it's cleared
      endThinking();
      // Compact per-response stats under the bubble (Hephaestus-style): output
      // tokens, throughput, cache reads, model. Only when the turn produced a
      // visible bubble and the message actually carries usage.
      const m = evt.message || {};
      if (m.role === "assistant") {
        if (m.stopReason === "error" || (typeof m.errorMessage === "string" && m.errorMessage.trim().length > 0)) {
          const fallback = m.stopReason ? `Request stopped with error (${m.stopReason}).` : "Model request failed.";
          const errMsg = sanitizeErrorMessage(m.errorMessage, fallback);
          toast(errMsg, "error");
          renderAssistantError(errMsg, current);
        }
        if (current) {
          const parts = [];
          const u = m.usage || {};
          const secs = assistantT0 ? (Date.now() - assistantT0) / 1000 : 0;
          if (u.output) {
            parts.push(`${fmtTok(u.output)} out`);
            // Live timing only: replayed events arrive in a burst, so the >1s
            // guard naturally excludes nonsense tok/s on reconnect.
            if (secs > 1) {
              const tps = u.output / secs;
              parts.push(`${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`);
            }
          }
          if (u.cacheRead) parts.push(`${fmtTok(u.cacheRead)} cached`);
          const model = m.responseModel || m.model;
          if (typeof model === "string" && model) parts.push(model);
          if (parts.length) {
            const el = document.createElement("div");
            el.className = "msg-stats";
            el.textContent = parts.join("  ·  ");
            transcript.appendChild(el);
          }
        }
      }
      current = null;
      break;
    }
    case "tool_execution_start": {
      // Expandable activity row: the pill summary shows tool + a hint (e.g. the
      // bash command); opening it reveals the full args and, while running, the
      // live output stream.
      const det = document.createElement("details");
      det.className = "toolblock";
      const hint = toolHint(evt.args);
      const sum = document.createElement("summary");
      sum.innerHTML = "⚙ " + esc(evt.toolName || "tool") + hint + " …";
      const body = document.createElement("div");
      body.className = "tool-body";
      const args = document.createElement("pre");
      args.className = "tool-args";
      args.textContent = formatToolArgs(evt.args);
      const outp = document.createElement("pre");
      outp.className = "tool-out";
      outp.hidden = true;
      body.append(args, outp);
      det.append(sum, body);
      transcript.appendChild(det);
      tools.set(evt.toolCallId, { sum, outp, hint, name: evt.toolName || "tool" });
      curTool = evt.toolName || "";
      renderStatus();
      stick(was);
      break;
    }
    case "tool_execution_update": {
      // partialResult carries the ACCUMULATED output so far — replace, don't append.
      const t = tools.get(evt.toolCallId);
      if (t) {
        const text = resultText(evt.partialResult);
        if (text) {
          t.outp.hidden = false;
          t.outp.textContent = text.length > 4000 ? "…" + text.slice(-4000) : text;
        }
      }
      break;
    }
    case "tool_execution_end": {
      const t = tools.get(evt.toolCallId);
      if (t) {
        t.sum.innerHTML = (evt.isError ? '<span class="bad">✗</span> ' : '<span class="ok">✓</span> ') + esc(evt.toolName || t.name) + t.hint;
        const text = resultText(evt.result);
        if (text) {
          t.outp.hidden = false;
          t.outp.textContent = text.length > 6000 ? text.slice(0, 6000) + `\n… (${text.length - 6000} more chars)` : text;
        }
      }
      curTool = "";
      break;
    }
    case "__execution_envelope": {
      const view = window.CoopCapabilityViews?.resolve(evt.envelope?.capabilityId) || { rendererId: "generic-result", actions: ["show-raw"] };
      if (view.rendererId === "findings") structuredReviewCard(evt, view);
      else if (view.rendererId === "lineage") lineageExecutionCard(evt, view);
      else if (view.rendererId === "impact") impactExecutionCard(evt, view);
      else genericExecutionCard(evt, view);
      break;
    }
    case "extension_ui_request":
      if (evt.method === "notify") {
        // Usage snapshots (pi-better-openai's /openai-usage) render as the header
        // meter instead of a toast; everything else stays a toast.
        if (!maybeUsage(evt.message || "")) toast(evt.message || "", evt.notifyType || "info");
      } else if (["select", "confirm", "input", "editor"].includes(evt.method)) {
        uiCard(evt);
      } else if (evt.method === "setStatus") {
        // Absent statusText = clear the segment (JSON omits undefined) — key off the
        // TYPE, never "statusText" in evt.
        if (typeof evt.statusText === "string") extStatus.set(String(evt.statusKey), evt.statusText);
        else extStatus.delete(String(evt.statusKey));
        renderExtDock();
      } else if (evt.method === "setWidget") {
        if (Array.isArray(evt.widgetLines)) extWidgets.set(String(evt.widgetKey), evt.widgetLines.map(String));
        else extWidgets.delete(String(evt.widgetKey));
        renderExtDock();
      } else if (evt.method === "setTitle") {
        document.title = evt.title ? `${evt.title} — coop` : "coop";
      } else if (evt.method === "set_editor_text") {
        input.value = String(evt.text ?? ""); // live-only: the bridge never replays this
        input.dispatchEvent(new Event("input")); // reuse the auto-grow listener
      } else {
        extFallbackCard(evt); // unknown method — never drop silently
      }
      break;
    case "response":
      // Surface command rejections (e.g. a prompt refused mid-stream) instead of
      // failing silently.
      if (evt.success === false) toast(`coop rejected a command${evt.error ? `: ${evt.error}` : ""}.`, "error");
      break;
  }
}

// --- multi-session: tabs, active chat, envelope routing -------------------------
// One SSE stream carries every chat as {sid,n,ev} envelopes. The SPA renders only the
// ACTIVE chat (background transcripts are rebuilt from the bridge's per-chat ring on
// switch); the tab strip shows the others with busy/unread/crashed indicators.
const chatsState = new Map(); // sid -> { cwd, busy, status, unread }
let activeSid = null;
let desktopNavigationRestoring = false;
let desktopNavigationStarted = false;
let switchSeq = 0;
let switching = false;
let desktopMissionControlOpened = false;
let replaying = false; // true while replaying a chat's ring: agent_end's per-turn side
                       // effects (get_session_stats RPC, Files/Changes refetch) are
                       // coalesced into a single refresh after the loop (see switchChat).
let pendingLive = []; // live frames buffered during a switch's replay fetch
const tabsEl = $("#tabs");

// Merge server chat fields into chatsState WITHOUT wiping the client-only `unread`
// flag; create entries for new sids; delete only sids absent from the list.
function applyChats(list) {
  const seen = new Set();
  for (const c of list || []) {
    seen.add(c.sid);
    const cur = chatsState.get(c.sid);
    if (cur) { cur.cwd = c.cwd; cur.busy = c.busy; cur.status = c.status; cur.workspaceAccess = c.workspaceAccess; cur.managedWorktreeId = c.managedWorktreeId; }
    else chatsState.set(c.sid, { cwd: c.cwd, busy: c.busy, status: c.status, workspaceAccess: c.workspaceAccess, managedWorktreeId: c.managedWorktreeId, unread: false });
  }
  for (const sid of [...chatsState.keys()]) if (!seen.has(sid)) chatsState.delete(sid);
}

function renderTabs() {
  if (!tabsEl) return;
  tabsEl.textContent = "";
  for (const [sid, c] of chatsState) {
    const row = document.createElement("div"); row.className = "session-row";
    const tab = document.createElement("button");
    tab.className = "tab" + (sid === activeSid ? " on" : "") + (c.status === "exited" ? " crashed" : "");
    if (sid === activeSid) tab.setAttribute("aria-current", "true");
    const accessMode = c.workspaceAccess?.mode || "write";
    tab.title = `${c.cwd || ""}\nWorkspace access: ${accessMode}`;
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = (c.cwd || "").split(/[\\/]/).filter(Boolean).pop() || c.cwd || "chat";
    tab.appendChild(label);
    if (accessMode !== "write" || c.managedWorktreeId) {
      const access = document.createElement("span");
      access.className = `tab-access access-${accessMode}`;
      access.textContent = c.managedWorktreeId ? "⎇" : accessMode === "read-only" ? "👁" : "!";
      access.title = c.managedWorktreeId ? "Isolated managed worktree" : accessMode === "read-only" ? "Read-only attachment" : "Concurrent-write override";
      tab.appendChild(access);
    }
    if (c.busy) { const d = document.createElement("span"); d.className = "tab-dot"; tab.appendChild(d); }
    if (c.unread && sid !== activeSid) { const u = document.createElement("span"); u.className = "tab-unread"; tab.appendChild(u); }
    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "✕";
    close.title = "Close this chat";
    close.setAttribute("aria-label", `Close ${label.textContent}`);
    // Pass the CLICKED tab's sid explicitly — usually not the active tab; the
    // fill-if-absent rule in post() must not overwrite it.
    close.onclick = async (e) => {
      e.stopPropagation();
      try {
        await post("/chat-close", { sid });
        if (c.managedWorktreeId) managedWorktreeCleanupCard(c.managedWorktreeId, c.cwd);
      } catch { toast("Couldn't close that chat.", "error"); }
    };
    row.append(tab, close);
    tab.onclick = () => { if (sid !== activeSid) switchChat(sid); };
    tabsEl.appendChild(row);
  }
  const add = document.createElement("button");
  add.className = "tab-new";
  add.textContent = "＋ New chat";
  add.title = "New chat";
  add.onclick = async () => {
    const active = chatsState.get(activeSid);
    await openParallelChat(active ? active.cwd : undefined);
  };
  tabsEl.prepend(add);
}

async function openParallelChat(cwd, workspaceAccess = "write", approved = false) {
  try {
    const r = await post("/chat-new", { cwd, workspaceAccess, approved });
    const data = await r.json();
    if (data?.ok && data.sid) switchChat(data.sid);
    else toast(data?.error || "Couldn't open a new chat.", "error");
  } catch (error) {
    if (error?.data?.code === "workspace-write-conflict") {
      workspaceConflictCard(cwd, error.data);
      return;
    }
    toast(error?.data?.error || "Couldn't open a new chat.", "error");
  }
}

function workspaceConflictCard(cwd, conflict) {
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card workspace-conflict";
  const title = document.createElement("h3"); title.textContent = "This checkout already has a writer";
  const message = document.createElement("p");
  message.textContent = `${conflict.error || "Another Coop client owns workspace writes."} Choose how this new session should attach.`;
  const warning = document.createElement("p"); warning.className = "prov";
  warning.textContent = "Worktree creates an isolated checkout. Read-only blocks edit/write/shell tools. Override permits simultaneous writes to the same files and is the highest-risk choice.";
  const row = document.createElement("div"); row.className = "row";
  const labels = { worktree: "Create isolated worktree", "read-only": "Attach read-only", override: "Approve concurrent writes" };
  for (const choice of conflict.choices || []) {
    const button = document.createElement("button");
    button.textContent = labels[choice.mode] || choice.mode;
    button.className = choice.mode === "override" ? "danger" : choice.mode === "read-only" ? "ghost" : "";
    button.disabled = choice.available !== true;
    button.title = choice.description || "";
    button.onclick = async () => {
      card.querySelectorAll("button").forEach((item) => { item.disabled = true; });
      await openParallelChat(cwd, choice.mode, choice.approvalOperation !== null);
      card.remove();
    };
    row.appendChild(button);
  }
  const cancel = document.createElement("button"); cancel.className = "ghost"; cancel.textContent = "Cancel"; cancel.onclick = () => card.remove(); row.appendChild(cancel);
  card.append(title, message, warning, row);
  transcript.appendChild(card);
  stick(was);
}

function managedWorktreeCleanupCard(id, cwd) {
  const was = atBottom();
  const card = document.createElement("div"); card.className = "card";
  const title = document.createElement("h3"); title.textContent = "Isolated worktree session closed";
  const message = document.createElement("p"); message.textContent = `Coop preserved ${cwd}. Cleanup is optional and will be refused if the worktree contains any changes.`;
  const row = document.createElement("div"); row.className = "row";
  const remove = document.createElement("button"); remove.textContent = "Remove clean worktree";
  remove.onclick = async () => {
    remove.disabled = true;
    try {
      await post("/worktree/remove", { id, approved: true });
      toast("Removed the clean managed worktree.");
      card.remove();
    } catch (error) {
      remove.disabled = false;
      toast(error?.data?.error || "Coop preserved the worktree because cleanup was not safe.", "error");
    }
  };
  const keep = document.createElement("button"); keep.className = "ghost"; keep.textContent = "Keep it"; keep.onclick = () => card.remove();
  row.append(remove, keep); card.append(title, message, row); transcript.appendChild(card); stick(was);
}

// Never leave the UI a dead end: if the active sid vanished, switch to the first
// remaining chat; if none remain, auto-create one.
function ensureActiveExists() {
  if (desktopNavigationRestoring) return;
  if (activeSid && chatsState.has(activeSid)) return;
  const first = chatsState.keys().next().value;
  if (first) { switchChat(first); return; }
  openParallelChat(undefined);
}

function maybeOpenDesktopMissionControl() {
  if (!window.coopDesktop || desktopMissionControlOpened) return;
  desktopMissionControlOpened = true;
  void openMissionControl();
}

// Switch the active tab. Under SSE: reset the transcript, replay the target chat's ring
// via /events-poll?sid&since=0, then apply live frames buffered during the fetch
// (n-deduped). Under polling: just set the active sid — the poll tick reloads it.
async function switchChat(sid, { force = false } = {}) {
  const c = chatsState.get(sid);
  if (!c) return;
  if (sid === activeSid && !switching && !force) return;
  activeSid = sid;
  clearUsage();
  window.coopDesktop?.setActiveChat?.(sid).catch(() => {});
  window.coopSid = sid; // set before any Files/diff fetch can carry a sid
  c.unread = false;
  renderTabs();
  renderQueue();
  if (mode === "poll") { setCwd(c.cwd); return; } // the poll tick resets since=0, replays, then opens Desktop Mission Control
  const my = ++switchSeq;
  switching = true;
  pendingLive = [];
  resetTranscript();
  setCwd(c.cwd);
  let data = null;
  try {
    const r = await fetch(`/events-poll?sid=${encodeURIComponent(sid)}&since=0`);
    if (r.ok) data = await r.json();
  } catch { /* fall through — an empty transcript beats a throw */ }
  if (my !== switchSeq) return; // a newer switch superseded this one
  if (data) {
    replaying = true; // coalesce per-turn side effects across the whole ring (see agent_end)
    for (const line of data.events) { try { handle(JSON.parse(line)); } catch { /* skip bad line */ } }
    replaying = false; // buffered live frames below apply as LIVE (their side effects run)
    // Buffered live frames: replay already covered anything below `next`; recorded
    // frames always carry n (structural), so nothing recorded can double. A buffered
    // __reset (unrecorded, n-less — a chdir/resume/new_session that raced this switch)
    // must still reset the transcript/cwd; handle() has no __reset case, so apply it
    // the same way route() does (mirrors route's per-chat __reset tail).
    for (const { n, ev } of pendingLive) {
      if (n !== undefined && n < data.next) continue; // already covered by the replay
      try {
        if (ev.type === "__reset") { resetTranscript(); setCwd(ev.cwd); resetPanels(); }
        else handle(ev);
      } catch { /* skip a bad frame */ }
    }
  }
  pendingLive = [];
  switching = false;
  c.unread = false;
  renderTabs();
  refreshState();
  resetPanels(); // new cwd — drop stale Files selection/tree and the stale Changes repo
  maybeOpenDesktopMissionControl();
}

// A working-folder change (tab switch, chdir/resume __reset, polling epoch reset)
// invalidates BOTH side panels: the Files selection/tree belongs to the old folder
// (a stale selectedPath would make attachTarget() name a nonexistent file) and the
// Changes panel would show a stale repo. Clear both from every such site.
function resetPanels() {
  closeUtilityPanel(null, false);
  if (window.coopFiles) window.coopFiles.onReset();
  if (window.coopDiff) window.coopDiff.onReset();
}

// The first __hello picks the initial active tab (the first chat), stamping
// window.coopSid before any panel fetch can carry a sid.
async function pickInitialTab() {
  let selected = chatsState.keys().next().value;
  let failures = [];
  if (selected && window.coopDesktop?.restoreNavigation && !desktopNavigationStarted) {
    desktopNavigationStarted = true;
    desktopNavigationRestoring = true;
    const overlay = document.createElement("div");
    overlay.className = "navigation-restore";
    overlay.setAttribute("role", "status");
    overlay.textContent = "Restoring your chats…";
    const previous = [...document.body.children].map(node => [node, node.inert]);
    for (const [node] of previous) node.inert = true;
    document.body.appendChild(overlay);
    try {
      const result = await window.coopDesktop.restoreNavigation(selected);
      applyChats(result.chats);
      selected = result.activeSid;
      failures = result.failures || [];
    } catch (error) {
      toast(error?.message || "Chats could not be restored. Your saved recovery references were kept.", "error");
      selected = chatsState.keys().next().value;
    } finally {
      for (const [node, inert] of previous) node.inert = inert;
      overlay.remove();
      desktopNavigationRestoring = false;
    }
  }
  if (selected && chatsState.has(selected)) await switchChat(selected, { force: true });
  else ensureActiveExists();
  if (failures.length) {
    const card = createUtilityCard("Chat recovery");
    const note = document.createElement("p");
    note.textContent = "Some chats could not reopen. Their saved references are retained for your next restart. You can also try History.";
    card.appendChild(note);
    for (const failure of failures) {
      const row = document.createElement("p");
      row.textContent = `${failure.cwd}: ${failure.error}`;
      card.appendChild(row);
    }
  }
}

// Envelope router: global frames (no sid) manage tabs; per-chat frames update tab
// indicators and, for the ACTIVE chat, drive the existing handle() dispatcher.
let helloSeen = false;
function route(frame) {
  const { sid, n, ev } = frame || {};
  if (!ev) return;
  if (!sid) { // global frames
    if (ev.type === "__hello") {
      applyChats(ev.chats);
      renderTabs();
      // Bootstrap the initial tab ONCE. A reconnect (sleep/wake, heartbeat gap) re-sends
      // __hello; re-picking the first tab would silently yank the user off their active
      // chat (and misroute the next prompt). Reconnect also replays the active chat:
      // events sent while disconnected may include tools and pending approvals.
      if (!helloSeen) { helloSeen = true; pickInitialTab(); }
      else { ensureActiveExists(); if (!desktopNavigationRestoring && activeSid) switchChat(activeSid, { force: true }); }
    } else if (ev.type === "__chats") { applyChats(ev.chats); renderTabs(); ensureActiveExists(); }
    return;
  }
  const c = chatsState.get(sid);
  if (ev.type === "agent_start" && c) { c.busy = true; renderTabs(); }
  if (ev.type === "agent_end" && c) {
    c.busy = false;
    if (sid !== activeSid) c.unread = true;
    renderTabs();
    if (document.hidden && window.coopDesktop?.notify) {
      window.coopDesktop.notify("Coop finished", `Agent work completed in ${c.cwd || "your workspace"}.`).catch(() => {});
    }
  }
  if (ev.type === "__fatal" && c) { c.status = "exited"; renderTabs(); }
  if (sid !== activeSid) return; // background chats: indicators only, no DOM
  if (switching) { pendingLive.push({ n, ev }); return; } // buffered during a switch fetch
  if (ev.type === "__reset") { resetTranscript(); setCwd(ev.cwd); resetPanels(); return; }
  handle(ev); // the existing dispatcher, unchanged cases
}

// --- transport --------------------------------------------------------------------
// post()/rpc() FILL the active sid only when the caller didn't supply one — a
// caller-supplied sid (e.g. the tab-close ✕) always wins (never clobber it).
async function post(path, body) {
  const b = body || {};
  b.sid ??= activeSid;
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify(b),
  });
  if (!res.ok) {
    const error = new Error(`${path} -> ${res.status}`);
    try { error.data = await res.json(); } catch { error.data = null; }
    throw error;
  }
  return res;
}
let currentCwd = "";
function setCwd(cwd) {
  currentCwd = cwd;
  window.coopCwd = cwd; // viewer.js prefixes relative file paths with this for attach
  const el = document.querySelector("#cwd");
  if (el) { el.textContent = cwd; el.title = `coop is working in ${cwd} — click to change`; }
}

// Change the working folder: the bridge restarts the governed agent IN that
// folder, so tools, lineage docs, and the header all agree. (Asking the agent to
// `cd` in chat only moves its shell — not where coop's tools operate.)
document.querySelector("#cwd").addEventListener("click", async () => {
  // Desktop owns the native picker. Browser/Web clients retain the existing
  // recent-folder and paste-path card below; no Web behavior depends on IPC.
  if (window.coopDesktop?.chooseWorkspace) {
    try {
      const dir = await window.coopDesktop.chooseWorkspace(activeSid);
      if (!dir) return;
      toast(`Now working in ${dir}`);
      setTimeout(refreshState, 1500);
    } catch (error) {
      toast(error?.message || "Couldn't open that workspace.", "error");
    }
    return;
  }
  // Folders you've used coop in before (from pi's session store) come first —
  // one click instead of hunting down a path. Pasting a path still works.
  let folders = [];
  try {
    const r = await fetch("/folders");
    if (r.ok) folders = (await r.json()).folders || [];
  } catch { /* recents are a convenience — the paste field below always works */ }

  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Change working folder";
  card.appendChild(title);

  const doChdir = async (dir, busyEl) => {
    if (!dir) return;
    if (busyEl) busyEl.disabled = true;
    try {
      const r = await fetch("/chdir", {
        method: "POST",
        headers: { "content-type": "application/json", "x-coop-csrf": "1" },
        body: JSON.stringify({ dir, sid: activeSid }), // moves only THIS tab
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(data.error || "Couldn't switch to that folder.", "error");
        if (busyEl) busyEl.disabled = false;
        return;
      }
      toast(`Now working in ${data.cwd}`);
      card.remove(); // the transcript resets via this tab's __reset broadcast
      setTimeout(refreshState, 1500); // repopulate model/thinking chips for the new session
    } catch {
      toast("Couldn't reach coop web.", "error");
      if (busyEl) busyEl.disabled = false;
    }
  };

  const recents = folders.filter((f) => f.dir !== currentCwd);
  if (recents.length) {
    const p0 = document.createElement("p");
    p0.textContent = "Folders you've worked in before:";
    const list = document.createElement("div");
    list.className = "row list";
    for (const f of recents.slice(0, 8)) {
      const btn = document.createElement("button");
      btn.textContent = f.dir;
      btn.title = `Switch coop to ${f.dir}`;
      btn.onclick = () => doChdir(f.dir, btn);
      list.appendChild(btn);
    }
    card.append(p0, list);
  }

  const p = document.createElement("p");
  p.textContent = (recents.length ? "Or paste" : "Paste") + " the full path of the folder coop should work in (tip: copy it from the File Explorer address bar). This moves THIS tab to a fresh conversation there.";
  const field = document.createElement("input");
  field.value = currentCwd;
  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "8px";
  const ok = document.createElement("button");
  ok.textContent = "Switch folder";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = () => card.remove();
  ok.onclick = () => doChdir(field.value.trim(), ok);
  field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
  row.append(ok, cancel);
  card.append(p, field, row);
  transcript.appendChild(card);
  field.focus();
  stick(was);
});

let currentTheme = window.CoopThemes.loadLocal();
function updateThemeButton() {
  const button = $("#themeBtn");
  if (!button) return;
  const theme = window.CoopThemes.descriptor(currentTheme);
  button.textContent = `Theme: ${theme.name.replace(/^Modern /, "")}`;
  button.title = `Current theme: ${theme.name}. Choose a visual theme.`;
}

async function setThemePreference(themeId) {
  const previous = currentTheme;
  currentTheme = window.CoopThemes.apply(themeId);
  window.CoopThemes.saveLocal(currentTheme);
  updateThemeButton();
  if (!window.coopDesktop?.setTheme) return currentTheme;
  try {
    const result = await window.coopDesktop.setTheme(currentTheme);
    currentTheme = window.CoopThemes.apply(result?.theme);
    updateThemeButton();
    return currentTheme;
  } catch (error) {
    currentTheme = window.CoopThemes.apply(previous);
    window.CoopThemes.saveLocal(currentTheme);
    updateThemeButton();
    toast(error?.message || "The Desktop theme preference could not be saved.", "error");
    return currentTheme;
  }
}

async function initializeTheme() {
  if (window.coopDesktop?.getShellInfo) {
    try {
      const shellInfo = await window.coopDesktop.getShellInfo();
      currentTheme = window.CoopThemes.apply(shellInfo?.theme);
    } catch { currentTheme = window.CoopThemes.apply(currentTheme); }
  } else {
    currentTheme = window.CoopThemes.apply(currentTheme);
  }
  updateThemeButton();
}

function openThemePicker(existingCard = null) {
  const card = createUtilityCard("Appearance", existingCard);
  if (!card) return;
  card.className = "card theme-picker";
  card.textContent = "";
  const title = document.createElement("h3"); title.textContent = "Choose your Coop theme";
  const help = document.createElement("p");
  help.textContent = "Themes change visual treatment only. Every capability, workflow, evidence state, and approval remains identical.";
  const choices = document.createElement("div"); choices.className = "theme-choices";
  for (const theme of window.CoopThemes.themes) {
    const button = document.createElement("button");
    button.className = `theme-choice preview-${theme.id}${theme.id === currentTheme ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(theme.id === currentTheme));
    const swatch = document.createElement("span"); swatch.className = "theme-swatch"; swatch.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span"); copy.className = "theme-choice-copy";
    const name = document.createElement("b"); name.textContent = theme.name;
    const description = document.createElement("span"); description.textContent = theme.description;
    copy.append(name, description); button.append(swatch, copy);
    button.onclick = async () => { await setThemePreference(theme.id); openThemePicker(card); };
    choices.appendChild(button);
  }
  const close = document.createElement("button"); close.className = "ghost"; close.textContent = "Close"; close.onclick = () => closeUtilityPanel(card);
  card.append(title, help, choices, close);
}

async function runDesktopAction(action) {
    if (action === "choose-theme") {
      openThemePicker();
      return;
    }
    if (typeof action === "string" && action.startsWith("theme-")) {
      await setThemePreference(action.slice("theme-".length));
      const picker = $("#utilityBody .theme-picker");
      if (picker) openThemePicker(picker);
      return;
    }
    if (action === "open-workspace") {
      document.querySelector("#cwd").click();
      return;
    }
    if (action === "session-export") {
      await exportCurrentSession();
      return;
    }
    const mode = ({ "terminal-open": "open", "terminal-clone": "clone", "terminal-move": "move" })[action];
    if (!mode) return;
    try {
      const result = await window.coopDesktop.terminalHandoff(mode, activeSid);
      if (!result?.ok) throw new Error("The terminal did not open.");
      const label = mode === "open" ? "Opened a new workspace terminal." : mode === "clone" ? "Cloned this session to a terminal." : "Moved this session to a terminal.";
      toast(label);
    } catch (error) {
      toast(error?.message || "Couldn't open the terminal.", "error");
    }
}

if (window.coopDesktop?.onMenuAction) {
  window.coopDesktop.onMenuAction(runDesktopAction);
}

// Connection strategy: try SSE (instant streaming). If the stream NEVER opens —
// some corporate proxies/endpoint protection buffer or block streaming responses,
// even on loopback — fall back to polling /events-poll, which is plain finite
// GETs and works anywhere the page itself loads.
let mode = "sse";
function connect() {
  let opened = false;
  const es = new EventSource("/events");
  const giveUp = setTimeout(() => { if (!opened) { es.close(); switchToPolling(); } }, 4000);
  es.onopen = () => { opened = true; clearTimeout(giveUp); };
  es.onmessage = (e) => { try { route(JSON.parse(e.data)); } catch { /* skip bad frame */ } };
  es.onerror = () => {
    if (!opened) { clearTimeout(giveUp); es.close(); switchToPolling(); return; }
    // CLOSED means the browser gave up (server gone / auth lost) — reconnects
    // have stopped, so say so plainly instead of pretending.
    statusText.textContent = es.readyState === EventSource.CLOSED
      ? "disconnected — close this window and start coop again"
      : "reconnecting…";
  };
}

function switchToPolling() {
  if (mode === "poll") return;
  mode = "poll";
  let since = 0, fails = 0, epoch = null, polledSid = null;
  statusText.textContent = "connecting…";
  const tick = async () => {
    try {
      // When the active tab changes (a switch or auto-create), reload it from scratch.
      if (activeSid !== polledSid) { polledSid = activeSid; since = 0; epoch = null; resetTranscript(); resetPanels(); }
      const q = activeSid ? `?sid=${encodeURIComponent(activeSid)}&since=${since}` : `?since=${since}`;
      const r = await fetch("/events-poll" + q);
      if (r.status === 401) {
        statusText.textContent = "session expired — close this window and start coop again";
        return; // stop polling: the cookie belongs to a previous coop web run
      }
      if (r.status === 400) {
        // Stale/closed sid — NOT a connectivity failure (the bridge answered). Recover
        // via the chats list in the 400 body; never trip the terminal failure counter.
        const body = await r.json().catch(() => ({}));
        if (body.chats) applyChats(body.chats);
        renderTabs();
        ensureActiveExists();
        fails = 0;
        setTimeout(tick, 1500);
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      fails = 0;
      if (data.chats) applyChats(data.chats);
      // Bootstrap the active sid on the single-chat fallback (SSE never opened, so no
      // global __hello arrived to pick the initial tab).
      if (!activeSid && data.chats && data.chats.length && window.coopDesktop?.restoreNavigation && !desktopNavigationStarted) {
        await pickInitialTab();
        setTimeout(tick, 0);
        return;
      }
      if (desktopNavigationRestoring) { setTimeout(tick, 500); return; }
      if (!activeSid && data.chats && data.chats.length) {
        activeSid = data.chats[0].sid; window.coopSid = activeSid; polledSid = activeSid;
      }
      renderTabs();
      // The __reset frame is broadcast-only, so on this polling path we detect a
      // server-side reset (new_session/chdir/resume) via the epoch instead.
      if (epoch !== null && data.epoch !== epoch) { resetTranscript(); resetPanels(); }
      epoch = data.epoch;
      if (data.cwd) setCwd(data.cwd); // every poll, so a chdir updates the header here too
      since = data.next;
      for (const line of data.events) { try { handle(JSON.parse(line)); } catch { /* skip */ } }
      maybeOpenDesktopMissionControl();
      if (/connecting|reconnecting/.test(statusText.textContent)) setBusy(dot.classList.contains("busy"));
      setTimeout(tick, 1500);
    } catch {
      // On loopback a poll can only fail because the bridge (and its pi children) is
      // gone — there's no flaky network to 127.0.0.1. After a few failures mirror the
      // terminal state instead of looping "reconnecting…" forever.
      if (++fails >= 4) {
        setBusy(false);
        statusText.textContent = "coop stopped — close this window and start coop again";
        return;
      }
      statusText.textContent = "reconnecting…";
      setTimeout(tick, 2500);
    }
  };
  tick();
}

// --- toolbar: new chat, model picker, thinking level, compact ------------------
async function rpc(body) {
  const b = body || {};
  b.sid ??= activeSid; // fill-if-absent — a caller-supplied sid always wins
  const res = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify(b),
  });
  if (!res.ok) {
    const error = new Error(`/rpc ${b.type} -> ${res.status}`);
    error.status = res.status;
    try { error.data = await res.json(); } catch { error.data = null; }
    if (error.data?.code === "chat-unavailable") error.message = error.data.error;
    throw error;
  }
  return res.json();
}

async function navigateTree(entryId, summarize = false) {
  const res = await fetch("/tree-navigate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify({ sid: activeSid, entryId, summarize }),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok || result.success !== true) {
    const error = new Error(result.error || `tree navigation failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return result;
}

const modelChip = $("#modelChip"), thinkChip = $("#thinkChip");
let currentThink = "medium";
let availableThinkLevels = [];
let steeringMode = "all";
let followUpMode = "one-at-a-time";
let autoCompactionEnabled = null;
let autoRetryPreference = null; // Pi 0.84.3 does not expose this value through get_state.

function shortModel(m) {
  const label = [m?.name, m?.id].find(value => typeof value === "string" && value.trim() && value !== "unknown") || "Choose model";
  return label.length > 26 ? label.slice(0, 25) + "…" : label;
}
function setModelChip(m) {
  modelChip.textContent = shortModel(m);
  modelChip.title = m?.id && m.id !== "unknown"
    ? `Model: ${m.id}${m.provider && m.provider !== "unknown" ? ` (${m.provider})` : ""} — click to change`
    : "Choose a model or set up model access";
}
function setThinkChip(level) {
  if (level) currentThink = level;
  thinkChip.textContent = `🧠 ${currentThink}`;
}

let stateRefreshSeq = 0;
let stateRefreshTimer = null;
async function refreshState() {
  clearTimeout(stateRefreshTimer);
  stateRefreshTimer = null;
  const sid = activeSid;
  const sequence = ++stateRefreshSeq;
  const isCurrent = () => sid === activeSid && sequence === stateRefreshSeq;
  try {
    const [st, levels] = await Promise.all([
      rpc({ type: "get_state", sid }),
      rpc({ type: "get_available_thinking_levels", sid }),
    ]);
    if (!isCurrent()) return;
    if (st?.success !== true) throw new Error("Agent state is unavailable.");
    agentReadySid = sid;
    if (!dot.classList.contains("busy") && !statusPhase) statusText.textContent = idleStatus();
    const d = (st && st.data) || {};
    setModelChip(d.model);
    setThinkChip(d.thinkingLevel);
    availableThinkLevels = Array.isArray(levels?.data?.levels) ? levels.data.levels.filter((level) => typeof level === "string") : [];
    steeringMode = d.steeringMode || steeringMode;
    followUpMode = d.followUpMode || followUpMode;
    autoCompactionEnabled = typeof d.autoCompactionEnabled === "boolean" ? d.autoCompactionEnabled : null;
    const queue = queueFor();
    queue.pendingUnknown = Number.isSafeInteger(d.pendingMessageCount) ? d.pendingMessageCount : 0;
    renderQueue();
  } catch (error) {
    if (!isCurrent()) return;
    agentReadySid = null;
    if (!dot.classList.contains("busy") && !statusPhase) {
      statusText.textContent = error.status === 504 ? "agent starting — retrying…" : "agent connection unavailable";
    }
    // Only repeat these read-only state requests. A tab switch invalidates the
    // callback, and a successful refresh restores the model and thinking chips.
    if (error.status === 504) stateRefreshTimer = setTimeout(() => {
      if (isCurrent()) void refreshState();
    }, 2000);
    return;
  }
  if (!isCurrent()) return;
  refreshCtx();
  if (window.coopFiles) window.coopFiles.onAgentEnd(); // refresh the Files tree for the (possibly new) folder
  if (window.coopDiff) window.coopDiff.onAgentEnd(); // repopulate the ± Changes badge for the new session/folder
}

// --- context gauge (get_session_stats) ------------------------------------------
// How full the conversation's context window is, refreshed after every turn and
// after compaction — the web twin of the TUI footer's context readout.
const ctxEl = $("#ctx"), ctxBar = $("#ctxBar"), ctxText = $("#ctxText");
// Debounced (trailing 300 ms): a polling catch-up burst — or several agent_end frames in
// quick succession — collapses to ONE get_session_stats RPC instead of one per turn. The
// tab-switch replay is already skipped via the `replaying` flag; this catches the polling
// path, which has no such flag. A single live turn still refreshes (just ≤300 ms later).
let ctxTimer = null;
function refreshCtx() {
  if (ctxTimer) clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => { ctxTimer = null; doRefreshCtx(); }, 300);
}
let contextRefreshSeq = 0;
async function doRefreshCtx() {
  const sid = activeSid;
  const sequence = ++contextRefreshSeq;
  try {
    const r = await rpc({ type: "get_session_stats", sid });
    if (sid !== activeSid || sequence !== contextRefreshSeq) return;
    const d = (r && r.data) || {};
    const cu = d.contextUsage;
    if (!cu || cu.percent == null) { ctxEl.hidden = true; return; }
    const pct = Math.max(0, Math.min(100, cu.percent));
    ctxEl.hidden = false;
    ctxBar.style.width = pct + "%";
    ctxBar.className = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
    ctxText.textContent = `ctx ${Math.round(pct)}%`;
    const tot = d.tokens && d.tokens.total;
    const cost = typeof d.cost === "number" && d.cost > 0 ? ` · ~$${d.cost.toFixed(2)}` : "";
    ctxEl.title =
      `Context: ${fmtTok(cu.tokens || 0)} of ${fmtTok(cu.contextWindow || 0)} tokens (${Math.round(pct)}%)` +
      (tot ? ` · session total ${fmtTok(tot)} tok${cost}` : "") +
      " — ♻ Compact frees space";
  } catch {
    /* the gauge is best-effort; never block the chat on it */
  }
}

$("#newChat").onclick = async () => {
  try {
    const r = await rpc({ type: "new_session" });
    if (r && r.data && r.data.cancelled) toast("New chat was cancelled.");
    // On success the server resets this chat's history and broadcasts its __reset,
    // which clears this transcript.
  } catch {
    toast("Couldn't start a new chat — is coop web still running?", "error");
  }
};

function relTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

$("#historyBtn").onclick = async () => {
  const card = createUtilityCard("History");
  card.textContent = "Loading…";
  let groups = [];
  try {
    // sid so /history marks the ACTIVE tab's folder as current (guarded — un-sid'd
    // works via the single-chat fallback before the first __hello).
    const sq = (typeof window.coopSid === "string" && window.coopSid) ? "?sid=" + encodeURIComponent(window.coopSid) : "";
    const r = await fetch("/history" + sq);
    if (!r.ok) throw new Error(String(r.status));
    groups = (await r.json()).groups || [];
  } catch {
    card.textContent = "Couldn't list previous conversations.";
    return;
  }
  if (!groups.length) {
    card.textContent = "No previous conversations yet.";
    return;
  }
  if (!card.isConnected) return;
  card.textContent = "";
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Resume a conversation";
  const p = document.createElement("p");
  p.textContent = "Conversations grouped by folder — this folder first.";
  const done = () => closeUtilityPanel(card);

  // One resume button. `workspace` is undefined for the current group (resume in
  // place) or the group's folder for a cross-workspace resume; disabled when the
  // folder no longer exists on disk.
  let resuming = false;
  const resumeButtons = [];
  const resumeBtn = (sess, workspace, disabled) => {
    const btn = document.createElement("button");
    btn.textContent = sess.name || sess.preview || "(untitled)";
    const when = document.createElement("span");
    when.className = "prov";
    when.textContent = relTime(sess.mtime);
    btn.appendChild(when);
    if (sess.name && sess.preview) btn.title = sess.preview;
    if (disabled) {
      btn.disabled = true;
      btn.title = "This folder no longer exists on disk.";
      return btn;
    }
    resumeButtons.push(btn);
    btn.onclick = async () => {
      if (resuming || !card.isConnected) return;
      resuming = true;
      for (const button of resumeButtons) button.disabled = true;
      card.setAttribute("aria-busy", "true");
      const label = btn.innerHTML;
      btn.textContent = "Resuming…";
      try {
        const body = workspace ? { file: sess.file, workspace, sid: activeSid } : { file: sess.file, sid: activeSid };
        const r = await fetch("/resume", {
          method: "POST",
          headers: { "content-type": "application/json", "x-coop-csrf": "1" },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { toast(data.error || "Couldn't resume that conversation.", "error"); return; }
        // On success the transcript resets via this tab's __reset (which carries the
        // new cwd -> setCwd), plus refreshState repopulates the chips.
        toast("Resuming — one moment while the conversation loads…");
        setTimeout(refreshState, 1500);
        done();
      } catch {
        toast("Couldn't reach coop web.", "error");
      } finally {
        resuming = false;
        card.removeAttribute("aria-busy");
        btn.innerHTML = label;
        for (const button of resumeButtons) button.disabled = false;
      }
    };
    return btn;
  };

  card.append(title, p);
  // The SERVER decides which group is current (never a client dir === cwd compare).
  const current = groups.find((g) => g.current);
  if (current) {
    const row = document.createElement("div");
    row.className = "row list";
    for (const sess of current.sessions) row.appendChild(resumeBtn(sess, undefined, false));
    card.appendChild(row);
  }
  for (const g of groups) {
    if (g.current) continue;
    const grp = document.createElement("details");
    grp.className = "hist-group";
    const sum = document.createElement("summary");
    sum.textContent = `${g.dir}  (${g.sessions.length})`;
    grp.appendChild(sum);
    const row = document.createElement("div");
    row.className = "row list";
    for (const sess of g.sessions) row.appendChild(resumeBtn(sess, g.dir, !g.exists));
    grp.appendChild(row);
    card.appendChild(grp);
  }

  const closeRow = document.createElement("div");
  closeRow.className = "row";
  const nameBtn = document.createElement("button");
  nameBtn.className = "ghost";
  nameBtn.textContent = "✎ Name current chat";
  nameBtn.title = "Give this conversation a name so it's easy to find here later";
  nameBtn.onclick = () => { done(); nameChatCard(); };
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = done;
  closeRow.append(nameBtn, cancel);
  card.appendChild(closeRow);


};

$("#sessionTreeBtn").onclick = async () => {
  const card = createUtilityCard("Session tree");
  card.textContent = "Loading…";
  let treeData, forkData;
  try {
    [treeData, forkData] = await Promise.all([
      rpc({ type: "get_tree" }),
      rpc({ type: "get_fork_messages" }),
    ]);
  } catch {
    card.textContent = "Couldn't read the session tree.";
    return;
  }
  const tree = treeData?.data?.tree || [];
  const leafId = treeData?.data?.leafId || null;
  const rows = window.CoopSessionTree.buildRows(tree, {
    leafId,
    forkMessages: forkData?.data?.messages || [],
  });
  if (!card.isConnected) return;
  card.textContent = "";
  card.className = "card session-tree";
  const title = document.createElement("h3");
  title.textContent = "Session tree";
  const help = document.createElement("p");
  help.textContent = "The current leaf is marked. Switch selects an existing point through Pi's supported session API; Summarize + switch preserves a summary of the branch being left. Fork starts a new session from a prior user message, while Clone copies the current branch.";
  const list = document.createElement("div");
  list.className = "session-tree-list";

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "This session has no entries yet.";
    list.appendChild(empty);
  }
  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "session-tree-row" + (item.isCurrent ? " current" : "");
    row.style.setProperty("--tree-depth", String(item.depth));
    const branch = document.createElement("span");
    branch.className = "session-tree-branch";
    branch.textContent = item.depth ? "└" : "●";
    const summary = document.createElement("span");
    summary.className = "session-tree-summary";
    summary.textContent = item.summary;
    summary.title = item.node.label ? `${item.node.label} · ${item.entry.id}` : item.entry.id;
    row.append(branch, summary);
    if (item.node.label) {
      const label = document.createElement("span");
      label.className = "session-tree-label";
      label.textContent = item.node.label;
      row.appendChild(label);
    }
    if (item.isCurrent) {
      const current = document.createElement("span");
      current.className = "session-tree-current";
      current.textContent = "current";
      row.appendChild(current);
    }
    if (!item.isCurrent) {
      const runNavigation = async (summarize, buttons) => {
        for (const button of buttons) button.disabled = true;
        try {
          const result = await navigateTree(item.entry.id, summarize);
          if (result?.data?.cancelled) {
            toast("Branch navigation was cancelled.");
            for (const button of buttons) button.disabled = false;
            return;
          }
          if (typeof result?.data?.editorText === "string" && result.data.editorText) {
            input.value = result.data.editorText;
            input.dispatchEvent(new Event("input"));
            input.focus();
          }
          toast(summarize ? "Branch summarized and selected." : "Existing branch selected.");
          setTimeout(refreshState, 200);
        } catch (error) {
          toast(error?.message || "Couldn't select this branch.", "error");
          for (const button of buttons) button.disabled = false;
        }
      };
      const select = document.createElement("button");
      select.className = "ghost session-tree-action";
      select.textContent = "Switch";
      select.title = "Select this existing session point without summarizing the branch being left";
      const summarize = document.createElement("button");
      summarize.className = "ghost session-tree-action";
      summarize.textContent = "Summarize + switch";
      summarize.title = "Summarize the branch being left, then select this session point";
      const buttons = [select, summarize];
      select.onclick = () => runNavigation(false, buttons);
      summarize.onclick = () => runNavigation(true, buttons);
      row.append(select, summarize);
    }
    if (item.forkable) {
      const fork = document.createElement("button");
      fork.className = "ghost session-tree-action";
      fork.textContent = "Fork";
      fork.title = "Create a new branch from this user message";
      fork.onclick = async () => {
        fork.disabled = true;
        try {
          const result = await rpc({ type: "fork", entryId: item.entry.id });
          if (result?.data?.cancelled) {
            toast("Fork was cancelled.");
            fork.disabled = false;
            return;
          }
          if (typeof result?.data?.text === "string" && result.data.text) {
            input.value = result.data.text;
            input.dispatchEvent(new Event("input"));
            input.focus();
          }
          toast("Fork created. Edit the restored prompt, then send when ready.");
          setTimeout(refreshState, 200);
        } catch {
          toast("Couldn't fork this message.", "error");
          fork.disabled = false;
        }
      };
      row.appendChild(fork);
    }
    list.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "row session-tree-buttons";
  const clone = document.createElement("button");
  clone.textContent = "Clone current branch";
  clone.disabled = !leafId;
  clone.onclick = async () => {
    clone.disabled = true;
    try {
      const result = await rpc({ type: "clone" });
      if (result?.data?.cancelled) {
        toast("Clone was cancelled.");
        clone.disabled = false;
        return;
      }
      toast("Current branch cloned into an independent session.");
      setTimeout(refreshState, 200);
    } catch {
      toast("Couldn't clone this branch.", "error");
      clone.disabled = false;
    }
  };
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "Close";
  close.onclick = () => closeUtilityPanel(card);
  actions.append(clone, close);
  card.append(title, help, list, actions);


};

// Name the current conversation (pi's set_session_name) so the History list shows
// a real title instead of the first message.
function nameChatCard() {
  const card = createUtilityCard("Name session");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Name this chat";
  const field = document.createElement("input");
  field.placeholder = "e.g. Q3 revenue measure review";
  field.maxLength = 200;
  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "8px";
  const ok = document.createElement("button");
  ok.textContent = "Save name";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = () => closeUtilityPanel(card);
  ok.onclick = async () => {
    const name = field.value.trim();
    if (!name) return;
    ok.disabled = true;
    try {
      await rpc({ type: "set_session_name", name });
      toast(`Chat named “${name}”.`);
      closeUtilityPanel(card);
    } catch {
      toast("Couldn't name the chat.", "error");
      ok.disabled = false;
    }
  };
  field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
  row.append(ok, cancel);
  card.append(title, field, row);

  field.focus();

}

async function exportCurrentSession() {
  try {
    if (window.coopDesktop?.exportSession) {
      const result = await window.coopDesktop.exportSession(activeSid);
      if (result?.cancelled) return;
      if (!result?.ok) throw new Error("The session was not exported.");
      toast(`Exported ${result.fileName}.`);
      return;
    }
    const result = await rpc({ type: "export_html" });
    const path = result?.data?.path;
    if (typeof path !== "string" || !path) throw new Error("Pi did not return an export path.");
    toast(`Session exported to ${path}`);
  } catch (error) {
    toast(error?.message || "Couldn't export this session.", "error");
  }
}

async function openSessionControls() {
  const card = createUtilityCard("Session settings");
  card.textContent = "Loading…";
  let state;
  try { state = (await rpc({ type: "get_state" }))?.data || {}; }
  catch { card.textContent = "Couldn't read session settings."; return; }
  if (!card.isConnected) return;
  autoCompactionEnabled = typeof state.autoCompactionEnabled === "boolean" ? state.autoCompactionEnabled : autoCompactionEnabled;
  card.textContent = ""; card.className = "card session-controls";
  const title = document.createElement("h3"); title.textContent = state.sessionName ? `Session — ${state.sessionName}` : "Session controls";
  const metadata = document.createElement("p"); metadata.className = "prov";
  metadata.textContent = `${Number.isFinite(state.messageCount) ? state.messageCount : "?"} messages · ${state.sessionId || "session ID unavailable"}`;
  const actions = document.createElement("div"); actions.className = "row session-control-actions";
  const name = document.createElement("button"); name.textContent = "Name session"; name.onclick = () => { closeUtilityPanel(card); nameChatCard(); };
  const exportButton = document.createElement("button"); exportButton.textContent = "Export HTML"; exportButton.onclick = async () => { exportButton.disabled = true; await exportCurrentSession(); exportButton.disabled = false; };
  const compact = document.createElement("button"); compact.className = "ghost"; compact.textContent = `${autoCompactionEnabled ? "Disable" : "Enable"} auto-compaction`;
  compact.disabled = autoCompactionEnabled === null;
  compact.onclick = async () => {
    compact.disabled = true;
    try {
      const next = !autoCompactionEnabled;
      await rpc({ type: "set_auto_compaction", enabled: next });
      autoCompactionEnabled = next;
      compact.textContent = `${next ? "Disable" : "Enable"} auto-compaction`;
      toast(`Automatic compaction ${next ? "enabled" : "disabled"}.`);
    } catch { toast("Couldn't change automatic compaction.", "error"); }
    compact.disabled = autoCompactionEnabled === null;
  };
  actions.append(name, exportButton, compact);

  const retry = document.createElement("section"); retry.className = "session-retry-settings";
  const retryTitle = document.createElement("h4"); retryTitle.textContent = "Automatic retry";
  const retryHelp = document.createElement("p"); retryHelp.textContent = autoRetryPreference === null
    ? "Pi 0.84.3 can change this setting but does not report its current value. Choose Enable or Disable explicitly; Coop will not guess."
    : `Set to ${autoRetryPreference ? "enabled" : "disabled"} during this runtime.`;
  const retryActions = document.createElement("div"); retryActions.className = "row";
  for (const [enabled, label] of [[true, "Enable retry"], [false, "Disable retry"]]) {
    const button = document.createElement("button"); button.className = "ghost"; button.textContent = label;
    button.onclick = async () => {
      retryActions.querySelectorAll("button").forEach((item) => { item.disabled = true; });
      try {
        await rpc({ type: "set_auto_retry", enabled });
        autoRetryPreference = enabled;
        retryHelp.textContent = `Set to ${enabled ? "enabled" : "disabled"} during this runtime.`;
        toast(`Automatic retry ${enabled ? "enabled" : "disabled"}.`);
      } catch { toast("Couldn't change automatic retry.", "error"); }
      retryActions.querySelectorAll("button").forEach((item) => { item.disabled = false; });
    };
    retryActions.appendChild(button);
  }
  if (retryActive) {
    const stop = document.createElement("button"); stop.className = "stop"; stop.textContent = "Stop active retry"; stop.onclick = () => abortRetryBtn.click(); retryActions.appendChild(stop);
  }
  retry.append(retryTitle, retryHelp, retryActions);
  const close = document.createElement("button"); close.className = "ghost"; close.textContent = "Close"; close.onclick = () => closeUtilityPanel(card);
  card.append(title, metadata, actions, retry, close);
}

$("#sessionBtn").onclick = () => { void openSessionControls(); };

$("#commandsBtn").onclick = async () => {
  const card = createUtilityCard("Commands");
  card.textContent = "Loading…";
  let commands = [];
  try {
    const response = await rpc({ type: "get_commands" });
    const nativeCommands = window.coopDesktop?.getNativeCommands ? window.coopDesktop.getNativeCommands() : [];
    commands = window.CoopInteraction.normalizeCommands(response?.data?.commands, nativeCommands);
  } catch {
    card.textContent = "Couldn't discover commands.";
    return;
  }
  if (!commands.length) { card.textContent = "No commands are available in this workspace."; return; }
  if (!card.isConnected) return;
  card.textContent = "";
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Commands";
  const help = document.createElement("p");
  help.textContent = "Discovered from the active Pi runtime and this Desktop shell. Pi commands are placed in the composer so you can review arguments before sending.";
  const filter = document.createElement("input");
  filter.placeholder = `Filter ${commands.length} commands…`;
  const list = document.createElement("div");
  list.className = "row list command-list";
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "Close";
  close.onclick = () => closeUtilityPanel(card);
  for (const command of commands) {
    const button = document.createElement("button");
    button.disabled = !command.available;
    const name = document.createElement("b");
    name.textContent = command.name;
    const description = document.createElement("span");
    description.className = "command-description";
    description.textContent = command.description || "No description provided.";
    const provenance = document.createElement("span");
    provenance.className = "prov";
    provenance.textContent = [command.source, command.sourceDetail].filter(Boolean).join(" · ");
    button.append(name, description, provenance);
    button.onclick = async () => {
      if (command.kind === "desktop") {
        await runDesktopAction(command.nativeId);
      } else {
        input.value = `${command.command} `;
        input.dispatchEvent(new Event("input"));
        input.focus();
      }
      closeUtilityPanel(card, false);
    };
    list.appendChild(button);
  }
  filter.addEventListener("input", () => {
    const query = filter.value.trim().toLowerCase();
    for (const button of list.children) button.hidden = Boolean(query) && !button.textContent.toLowerCase().includes(query);
  });
  const actions = document.createElement("div");
  actions.className = "row";
  actions.appendChild(close);
  card.append(title, help, filter, list, actions);

  filter.focus();

};

modelChip.onclick = async () => {
  const sid = activeSid;
  const card = createUtilityCard("Model");
  const current = () => card.isConnected && activeSid === sid;
  card.textContent = "Loading…";
  let models = [];
  try {
    const r = await rpc({ type: "get_available_models", sid });
    models = (r && r.data && r.data.models) || [];
  } catch {
    if (!current()) return;
    card.textContent = "Couldn't load models. Try again.";
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.onclick = () => { if (current()) void modelChip.onclick(); };
    card.appendChild(retry);
    retry.focus();
    return;
  }
  if (!current()) return;
  if (!models.length) {
    card.textContent = "Connect a model to start working with Coop.";
    const setup = document.createElement("button");
    setup.textContent = "Set up model access";
    setup.onclick = () => { if (current()) void openHealthCard(); };
    card.appendChild(setup);
    setup.focus();
    return;
  }
  card.textContent = "";
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Choose a model";
  card.appendChild(title);
  // With hundreds of configured models, a type-to-filter box is essential.
  const filter = document.createElement("input");
  filter.setAttribute("aria-label", "Filter models");
  filter.placeholder = `Filter ${models.length} models…`;
  filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    for (const b of row.children) {
      b.hidden = q !== "" && !b.textContent.toLowerCase().includes(q);
    }
  });
  card.appendChild(filter);
  const row = document.createElement("div");
  row.className = "row list";
  const closeRow = document.createElement("div");
  closeRow.className = "row";
  const done = () => { if (current()) closeUtilityPanel(card); };
  let selecting = false;
  const select = async (command, fallback = null) => {
    if (!current() || selecting) return;
    selecting = true;
    cycle.disabled = true;
    for (const button of row.children) button.disabled = true;
    try {
      const result = await rpc({ ...command, sid });
      if (!current()) return;
      const model = command.type === "cycle_model" ? result?.data?.model : result?.data || fallback;
      if (!model) { toast("No other model is available."); return; }
      setModelChip(model);
      if (result?.data?.thinkingLevel) setThinkChip(result.data.thinkingLevel);
      toast(`Model set to ${shortModel(model)}.`);
      done();
    } catch {
      if (current()) toast("Couldn't switch model. Try again.", "error");
    } finally {
      selecting = false;
      cycle.disabled = false;
      for (const button of row.children) button.disabled = false;
    }
  };
  const cycle = document.createElement("button");
  cycle.className = "ghost";
  cycle.textContent = "Cycle model";
  cycle.title = "Use Pi's native model-cycle order";
  cycle.onclick = () => select({ type: "cycle_model" });
  for (const m of models) {
    const btn = document.createElement("button");
    btn.textContent = m.name || m.id;
    const prov = document.createElement("span");
    prov.className = "prov";
    prov.textContent = m.provider || "";
    btn.appendChild(prov);
    btn.onclick = () => select({ type: "set_model", provider: m.provider, modelId: m.id }, m);
    row.appendChild(btn);
  }
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = done;
  closeRow.append(cycle, cancel);
  card.append(row, closeRow);

  filter.focus();

};

thinkChip.onclick = async () => {
  const card = createUtilityCard("Thinking effort");
  card.textContent = "Loading…";
  let levels = availableThinkLevels;
  if (!levels.length) {
    try {
      const response = await rpc({ type: "get_available_thinking_levels" });
      levels = Array.isArray(response?.data?.levels) ? response.data.levels : [];
      availableThinkLevels = levels;
    } catch { /* friendly empty state below */ }
  }
  if (!levels.length) { card.textContent = "This model did not report any thinking levels."; return; }
  if (!card.isConnected) return;
  card.textContent = "";
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Thinking effort";
  const help = document.createElement("p");
  help.textContent = "Available levels come from the active Pi runtime and model.";
  const list = document.createElement("div");
  list.className = "row list";
  const done = () => closeUtilityPanel(card);
  for (const level of levels) {
    const button = document.createElement("button");
    button.textContent = level;
    if (level === currentThink) {
      const currentLabel = document.createElement("span");
      currentLabel.className = "prov";
      currentLabel.textContent = "current";
      button.appendChild(currentLabel);
    }
    button.onclick = async () => {
      try {
        await rpc({ type: "set_thinking_level", level });
        setThinkChip(level);
        done();
      } catch { toast("Couldn't change the thinking level.", "error"); }
    };
    list.appendChild(button);
  }
  const actions = document.createElement("div");
  actions.className = "row";
  const cycle = document.createElement("button");
  cycle.className = "ghost";
  cycle.textContent = "Cycle effort";
  cycle.onclick = async () => {
    try {
      const result = await rpc({ type: "cycle_thinking_level" });
      setThinkChip(result?.data?.level);
      done();
    } catch { toast("Couldn't cycle the thinking level.", "error"); }
  };
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "Cancel";
  close.onclick = done;
  actions.append(cycle, close);
  card.append(title, help, list, actions);


};

$("#queueBtn").onclick = () => {
  const card = createUtilityCard("Message queues");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Live message queues";
  const help = document.createElement("p");
  help.textContent = "Steer now adjusts the active turn. Send next waits for the current turn to finish. Queue processing modes are owned by Pi.";
  const makeSetting = (label, type, currentMode, setCurrent) => {
    const row = document.createElement("div");
    row.className = "queue-setting";
    const text = document.createElement("span");
    text.textContent = label;
    row.appendChild(text);
    for (const mode of ["all", "one-at-a-time"]) {
      const button = document.createElement("button");
      button.className = "ghost";
      button.textContent = mode;
      button.disabled = mode === currentMode;
      button.onclick = async () => {
        try {
          await rpc({ type, mode });
          setCurrent(mode);
          if (!card.isConnected) return;
          closeUtilityPanel(card);
          $("#queueBtn").click();
        } catch { toast("Couldn't change the queue mode.", "error"); }
      };
      row.appendChild(button);
    }
    return row;
  };
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "Close";
  close.onclick = () => closeUtilityPanel(card);
  const actions = document.createElement("div");
  actions.className = "row";
  actions.appendChild(close);
  card.append(
    title,
    help,
    makeSetting("Steering", "set_steering_mode", steeringMode, (mode) => { steeringMode = mode; }),
    makeSetting("Follow-up", "set_follow_up_mode", followUpMode, (mode) => { followUpMode = mode; }),
    actions,
  );


};

function putCommandInComposer(command) {
  input.value = `${command} `;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

function setupCommand(operationId) {
  if (operationId === "data-doc.configure") return "/setup-docs";
  if (["project.configure", "project.repair", "repositories.configure", "tabular-editor.configure"].includes(operationId)) return "/setup-project";
  return null;
}

async function readHealthContracts() {
  const suffix = `?sid=${encodeURIComponent(activeSid)}`;
  const keys = ["doctor", "auth", "setup", "profile"];
  const paths = ["/doctor", "/auth/providers", "/setup/state", "/profile"];
  const failures = {};
  const values = await Promise.all(paths.map(async (path, index) => {
    try {
      const response = await fetch(`${path}${suffix}`, { signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Service unavailable.");
      return body;
    } catch (error) {
      failures[keys[index]] = error.name === "TimeoutError" ? "This check timed out. Other setup and sign-in actions remain available." : error.message || "Service unavailable.";
      return {};
    }
  }));
  return window.CoopWorkspaceHealth.build({ doctor: values[0].report, auth: values[1], setup: values[2].report, profile: values[3].report, failures });
}

function openProfileForm(card, item, refresh) {
  const questionnaire = item.questionnaire?.fields;
  const presetContract = questionnaire?.communication?.preset;
  const options = Array.isArray(presetContract?.options) ? presetContract.options : [];
  if (!questionnaire || !options.length) {
    toast("The shared profile questionnaire is unavailable.", "error");
    return;
  }
  card.textContent = "";
  const title = document.createElement("h3");
  title.textContent = item.profile ? "Edit your Coop profile" : "Create your Coop profile";
  const help = document.createElement("p");
  help.textContent = "This personal preference is stored by Coop's existing profile owner and is not project or team knowledge.";
  const form = document.createElement("form");
  form.className = "profile-form";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Name";
  const name = document.createElement("input");
  name.type = "text";
  name.required = questionnaire.name?.required === true;
  name.maxLength = Number(questionnaire.name?.max_length) || 100;
  name.value = item.profile?.name || "";
  name.autocomplete = "name";
  nameLabel.appendChild(name);
  const presetLabel = document.createElement("label");
  presetLabel.textContent = "Communication style";
  const preset = document.createElement("select");
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.id;
    element.title = option.description || "";
    preset.appendChild(element);
  }
  preset.value = item.profile?.communication?.preset || "balanced";
  presetLabel.appendChild(preset);
  const explanation = document.createElement("p");
  explanation.className = "profile-preset-help";
  const customLabel = document.createElement("label");
  customLabel.textContent = "Custom instructions";
  const custom = document.createElement("textarea");
  custom.rows = 4;
  custom.maxLength = Number(questionnaire.communication?.custom_instructions?.max_length) || 1000;
  custom.value = item.profile?.communication?.custom_instructions || "";
  customLabel.appendChild(custom);
  const syncPreset = () => {
    const selected = options.find((option) => option.id === preset.value);
    explanation.textContent = selected?.description || "";
    custom.disabled = preset.value !== questionnaire.communication?.custom_instructions?.enabled_when_preset;
  };
  preset.onchange = syncPreset;
  syncPreset();
  const status = document.createElement("p");
  status.className = "profile-status";
  const actions = document.createElement("div");
  actions.className = "row";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save profile";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = refresh;
  actions.append(save, cancel);
  form.append(nameLabel, presetLabel, explanation, customLabel, status, actions);
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = "Saving through the shared Coop profile service…";
    try {
      const response = await fetch("/profile/apply", {
        method: "POST",
        headers: { "content-type": "application/json", "x-coop-csrf": "1" },
        body: JSON.stringify({
          sid: activeSid,
          approved: true,
          profile: { name: name.value, communication: { preset: preset.value, custom_instructions: custom.value } },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Profile could not be saved.");
      toast("Profile saved.");
      refresh();
    } catch (error) {
      status.textContent = error.message || "Profile could not be saved.";
      status.className = "profile-status health-error";
      save.disabled = false;
    }
  };
  card.append(title, help, form);
  name.focus();
}

async function openProjectConfigEditor(card, refresh) {
  const sid = activeSid;
  card.textContent = "";
  const loading = document.createElement("p");
  loading.textContent = "Reading the workspace project contract…";
  card.appendChild(loading);
  let current;
  try {
    const response = await fetch(`/config/current?sid=${encodeURIComponent(sid)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Project configuration could not be read.");
    current = body.report;
  } catch (error) {
    loading.textContent = error.message;
    loading.className = "health-error";
    return;
  }
  card.textContent = "";
  const title = document.createElement("h3");
  title.textContent = "Project contract";
  const help = document.createElement("p");
  help.textContent = current.state === "configured"
    ? "Advanced YAML editor. Preview validates the exact content; Apply requires a second explicit action and preserves a recoverable backup."
    : "No project contract exists yet. Use guided setup, or paste an explicit advanced-user contract here and validate it before writing.";
  const target = document.createElement("code");
  target.className = "config-target";
  target.textContent = current.targetPath;
  const editor = document.createElement("textarea");
  editor.className = "config-editor";
  editor.rows = 16;
  editor.spellcheck = false;
  editor.value = current.content || "";
  editor.setAttribute("aria-label", "Project contract YAML");
  const result = document.createElement("div");
  result.className = "config-result";
  const actions = document.createElement("div");
  actions.className = "row";
  const preview = document.createElement("button");
  preview.textContent = "Preview and validate";
  const guided = document.createElement("button");
  guided.type = "button";
  guided.className = "ghost";
  guided.textContent = "Guided setup";
  guided.onclick = () => { putCommandInComposer("/setup-project"); closeUtilityPanel(card, false); };
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = refresh;
  preview.onclick = async () => {
    preview.disabled = true;
    result.textContent = "Validating without writing…";
    try {
      const response = await fetch("/config/proposal", {
        method: "POST",
        headers: { "content-type": "application/json", "x-coop-csrf": "1" },
        body: JSON.stringify({ sid, candidate: editor.value }),
      });
      const body = await response.json().catch(() => ({}));
      const proposal = body.proposal;
      result.textContent = "";
      if (!response.ok || proposal?.state !== "proposed") {
        const heading = document.createElement("b");
        heading.textContent = "Validation failed";
        result.appendChild(heading);
        for (const diagnostic of proposal?.validation?.diagnostics || []) {
          const message = document.createElement("p");
          message.className = "health-error";
          message.textContent = diagnostic.message || diagnostic.code || "Invalid project configuration.";
          result.appendChild(message);
        }
        if (!proposal?.validation?.diagnostics?.length) {
          const message = document.createElement("p");
          message.className = "health-error";
          message.textContent = body.error || "Project configuration is invalid.";
          result.appendChild(message);
        }
        return;
      }
      const summary = document.createElement("p");
      summary.textContent = proposal.changed
        ? `Validated. Applying will replace ${proposal.targetPath}${proposal.preview.before === null ? "." : " after preserving its current bytes in .backups/."}`
        : "Validated. The proposed content is identical to the current project contract.";
      const previewGrid = document.createElement("div");
      previewGrid.className = "config-preview";
      for (const [label, content] of [["Current", proposal.preview.before], ["Proposed", proposal.preview.after]]) {
        const pane = document.createElement("section");
        const heading = document.createElement("b");
        heading.textContent = label;
        const code = document.createElement("pre");
        code.textContent = content === null ? "(file does not exist)" : content;
        pane.append(heading, code);
        previewGrid.appendChild(pane);
      }
      const apply = document.createElement("button");
      apply.textContent = proposal.changed ? "Apply approved contract" : "Confirm no change";
      apply.onclick = async () => {
        apply.disabled = true;
        try {
          const response = await fetch("/config/apply", {
            method: "POST",
            headers: { "content-type": "application/json", "x-coop-csrf": "1" },
            body: JSON.stringify({ sid, proposalId: proposal.proposalId, approved: true }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "Project configuration was not written.");
          toast(body.result?.backupPath ? "Project contract saved; prior version backed up." : "Project contract is current.");
          refresh();
        } catch (error) {
          apply.disabled = false;
          toast(error.message || "Project configuration was not written.", "error");
        }
      };
      result.append(summary, previewGrid, apply);
    } catch (error) {
      result.textContent = error.message || "Project configuration could not be validated.";
      result.className = "config-result health-error";
    } finally {
      preview.disabled = false;
    }
  };
  actions.append(preview, guided, cancel);
  card.append(title, help, target, editor, actions, result);
  editor.focus();
}

async function waitForModelLogin(refresh) {
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const response = await fetch(`/auth/providers?sid=${encodeURIComponent(activeSid)}`);
      const body = await response.json();
      if (body.providers?.find((provider) => provider.id === "model.openai-codex")?.state === "authenticated") {
        toast("Model sign-in completed.");
        refresh();
        return;
      }
    } catch { /* the user can still use Refresh after the terminal flow */ }
  }
}

async function openHealthCard(existingCard = null) {
  const card = createUtilityCard("Workspace health", existingCard);
  if (!card) return;
  card.className = "card health-card";
  card.textContent = "";
  const loading = document.createElement("p");
  loading.textContent = "Checking workspace setup, identities, and Coop Doctor…";
  card.appendChild(loading);
  let model;
  try { model = await readHealthContracts(); }
  catch (error) {
    loading.textContent = error.message || "Workspace health could not be inspected.";
    loading.className = "health-error";
    return;
  }
  if (!card.isConnected) return;
  card.textContent = "";
  const title = document.createElement("h3");
  title.textContent = "Workspace Health";
  const summary = document.createElement("p");
  summary.textContent = `Overall: ${model.state}${model.checkedAt ? ` · checked ${new Date(model.checkedAt).toLocaleString()}` : ""}. Optional integrations may remain not configured.`;
  card.append(title, summary);

  const refresh = () => { void openHealthCard(card); };
  for (const section of model.sections) {
    const group = document.createElement("details");
    group.className = "health-group";
    group.open = section.id !== "doctor" || model.state === "error";
    const heading = document.createElement("summary");
    heading.textContent = `${section.title} (${section.items.length})`;
    group.appendChild(heading);
    for (const item of section.items) {
      const row = document.createElement("div");
      row.className = "health-row";
      const badge = document.createElement("span");
      badge.className = `health-state state-${item.state}`;
      badge.textContent = item.state;
      const copy = document.createElement("span");
      copy.className = "health-copy";
      const name = document.createElement("b");
      name.textContent = item.title;
      const detail = document.createElement("span");
      detail.textContent = item.detail || (item.selected === false ? "Optional; not selected." : "");
      copy.append(name, detail);
      row.append(badge, copy);
      if (item.action?.kind === "profile") {
        const action = document.createElement("button");
        action.className = "ghost";
        action.textContent = item.profile ? "Edit" : "Set up";
        action.onclick = () => openProfileForm(card, item, refresh);
        row.appendChild(action);
      } else if (item.action?.kind === "setup") {
        const command = setupCommand(item.action.operationId);
        const action = document.createElement("button");
        action.className = "ghost";
        action.textContent = command ? "Set up" : "View guidance";
        action.onclick = () => {
          if (command) { putCommandInComposer(command); closeUtilityPanel(card, false); }
          else toast(item.detail || "Use the recommended setup action shown in Health.");
        };
        row.appendChild(action);
      } else if (item.action?.kind === "auth") {
        const action = document.createElement("button");
        action.className = "ghost";
        const modelLogin = item.action.providerId === "model.openai-codex" && item.action.method === "pi-terminal";
        action.textContent = item.action.reauthenticate ? "Re-authenticate" : "Sign in";
        action.disabled = !item.action.available || !modelLogin || !window.coopDesktop?.startModelLogin;
        action.title = action.disabled
          ? modelLogin ? "The preview model-login bridge is available in Coop Desktop." : "Microsoft login execution is not yet exposed by the shared auth provider contract."
          : "";
        action.onclick = async () => {
          if (modelLogin) {
            try {
              await window.coopDesktop.startModelLogin();
              toast("Complete model sign-in in the terminal window. Health will refresh automatically.");
              void waitForModelLogin(refresh);
            } catch (error) { toast(error.message || "Model sign-in could not start.", "error"); }
          } else {
            toast("Microsoft login execution is not yet exposed by the shared auth provider contract.", "warning");
          }
        };
        row.appendChild(action);
      } else if (item.action?.kind === "repair") {
        const action = document.createElement("button");
        action.className = "ghost";
        action.textContent = "Approval required";
        action.title = item.detail || "This Doctor repair is not executed by the read-only Health view.";
        action.onclick = () => toast(item.detail || "Run the recommended Doctor repair after reviewing it.", "warning");
        row.appendChild(action);
      }
      group.appendChild(row);
    }
    card.appendChild(group);
  }
  const actions = document.createElement("div");
  actions.className = "row health-actions";
  const refreshButton = document.createElement("button");
  refreshButton.textContent = "Refresh";
  refreshButton.onclick = refresh;
  const project = document.createElement("button");
  project.className = "ghost";
  project.textContent = "Project contract";
  project.onclick = () => { void openProjectConfigEditor(card, refresh); };
  const lineage = document.createElement("button");
  lineage.className = "ghost";
  lineage.textContent = "Lineage setup";
  lineage.onclick = () => { putCommandInComposer("/setup-docs"); closeUtilityPanel(card, false); };
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "Close";
  close.onclick = () => closeUtilityPanel(card);
  actions.append(refreshButton, project, lineage, close);
  card.appendChild(actions);
}

async function missionContract(id, url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `${id} is unavailable.`), { contractId: id });
  return body;
}

async function readMissionControlContracts() {
  const suffix = `?sid=${encodeURIComponent(activeSid)}`;
  const requests = [
    ["health", readHealthContracts()],
    ["workspace", missionContract("workspace", `/workspace/access${suffix}`)],
    ["git", missionContract("git", `/git/changes${suffix}`)],
    ["capabilities", missionContract("capabilities", "/capabilities")],
    ["knowledge", missionContract("knowledge", `/knowledge/catalog${suffix}`)],
  ];
  const settled = await Promise.allSettled(requests.map(([, promise]) => promise));
  const values = {};
  const failures = [];
  settled.forEach((result, index) => {
    const id = requests[index][0];
    if (result.status === "fulfilled") values[id] = result.value;
    else failures.push({ id, message: result.reason?.message || `${id} is unavailable.` });
  });
  let knowledge = null;
  if (values.knowledge?.catalog && window.CoopKnowledge) {
    try { knowledge = window.CoopKnowledge.build(values.knowledge.catalog); }
    catch (error) { failures.push({ id: "knowledge", message: error.message || "Knowledge evidence could not be projected." }); }
  }
  return window.CoopMissionControl.build({
    activeSid,
    fallbackCwd: chatsState.get(activeSid)?.cwd,
    chats: [...chatsState].map(([sid, chat]) => ({ sid, ...chat })),
    access: values.workspace,
    git: values.git,
    capabilities: values.capabilities,
    health: values.health,
    knowledge,
    failures,
  });
}

function missionStateLabel(state) {
  return ({
    ready: "ready",
    healthy: "healthy",
    clean: "clean",
    warning: "attention",
    partial: "partial",
    unavailable: "unavailable",
    unknown: "unknown",
    "not-configured": "not configured",
    "not-run": "not run",
    "read-only": "read only",
    override: "write override",
    error: "error",
  })[state] || state;
}

function missionTile(titleText, state, detailText) {
  const tile = document.createElement("section");
  tile.className = `mission-tile state-${state}`;
  const heading = document.createElement("div"); heading.className = "mission-tile-heading";
  const title = document.createElement("b"); title.textContent = titleText;
  const badge = document.createElement("span"); badge.className = `health-state state-${state}`; badge.textContent = missionStateLabel(state);
  const detail = document.createElement("p"); detail.textContent = detailText;
  heading.append(title, badge); tile.append(heading, detail);
  return tile;
}

async function openMissionControl(existingCard = null) {
  const card = createUtilityCard("Mission Control", existingCard);
  if (!card) return;
  card.className = "card mission-control";
  card.textContent = "";
  const loading = document.createElement("p");
  loading.textContent = "Building Mission Control from live Coop Core contracts…";
  card.appendChild(loading);
  let model;
  try { model = await readMissionControlContracts(); }
  catch (error) {
    loading.textContent = error.message || "Mission Control could not inspect this workspace.";
    loading.className = "health-error";
    return;
  }
  if (!card.isConnected) return;
  card.textContent = "";
  const titleRow = document.createElement("div"); titleRow.className = "mission-title";
  const title = document.createElement("h2"); title.textContent = "Mission Control";
  const overall = document.createElement("span"); overall.className = `health-state state-${model.state}`; overall.textContent = missionStateLabel(model.state);
  titleRow.append(title, overall);
  const intro = document.createElement("p");
  intro.textContent = "Your engineering workspace at a glance. Every status below comes from Coop Core; reviews and lineage remain ‘not run’ until evidence exists.";
  const grid = document.createElement("div"); grid.className = "mission-grid";
  const workspaceDetail = [model.workspace.cwd, `${model.workspace.accessMode} access`, model.workspace.worktree ? "isolated worktree" : model.workspace.git ? "Git checkout" : "non-Git folder"].join(" · ");
  grid.append(
    missionTile("Workspace", model.workspace.state, workspaceDetail),
    missionTile("Health", model.health.state, model.health.checkedAt ? `Checked ${new Date(model.health.checkedAt).toLocaleString()}.` : "Health evidence is unavailable."),
    missionTile("Sessions", model.sessions.state, `${model.sessions.total} open · ${model.sessions.busy} running · ${model.sessions.crashed} crashed · ${model.sessions.readOnly} read only.`),
    missionTile("Changes", model.changes.state, model.changes.detail),
    missionTile("Knowledge", model.knowledge.state, model.knowledge.sources ? `${model.knowledge.current} approved current · ${model.knowledge.history} draft or historical.` : "No governed project or team source is configured."),
    missionTile("Capabilities", model.capabilities.state, `${model.capabilities.available}/${model.capabilities.total} available · ${model.capabilities.unknown} unknown · ${model.capabilities.unavailable} unavailable on ${model.capabilities.platform}.`),
    missionTile("Reviews", model.engineering.reviews.state, model.engineering.reviews.detail),
    missionTile("Lineage & impact", model.engineering.lineage.state, model.engineering.lineage.detail),
  );
  card.append(titleRow, intro, grid);
  if (model.failures.length) {
    const warning = document.createElement("details"); warning.className = "mission-warnings";
    const heading = document.createElement("summary"); heading.textContent = `${model.failures.length} contract${model.failures.length === 1 ? "" : "s"} could not be inspected`;
    warning.appendChild(heading);
    for (const failure of model.failures) { const item = document.createElement("p"); item.textContent = `${failure.id}: ${failure.message}`; warning.appendChild(item); }
    card.appendChild(warning);
  }
  const actions = document.createElement("div"); actions.className = "mission-actions";
  const action = (label, description, handler, kind = "") => {
    const button = document.createElement("button"); button.className = `mission-action ${kind}`.trim();
    const name = document.createElement("b"); name.textContent = label;
    const copy = document.createElement("span"); copy.textContent = description;
    button.append(name, copy); button.onclick = handler; actions.appendChild(button);
  };
  action("Continue with Coop", "Return to the prompt and conversation.", () => { closeUtilityPanel(card); input.focus(); }, "primary");
  action("Review changes", "Ask the governed workflow to scope the Git diff and run applicable deterministic checks.", () => {
    putCommandInComposer("Review the current Git changes using the governed Review changes workflow. Keep SQL, DAX, BPA, and evidence-completeness results attributable, do not change files, and prepare a review handoff.");
    closeUtilityPanel(card, false);
  });
  action("Changes", "Inspect the current Git diff without writing.", () => { closeUtilityPanel(card); $("#diffBtn")?.click(); });
  action("Files", "Browse and preview workspace files.", () => { closeUtilityPanel(card); $("#filesBtn")?.click(); });
  action("Lineage", "Ask Coop for a focused upstream/downstream evidence view.", () => {
    putCommandInComposer("Help me inspect focused upstream and downstream lineage for this workspace. Ask me to select the target object, use authoritative Data Doc evidence, and make stale, partial, or missing evidence explicit.");
    closeUtilityPanel(card, false);
  });
  action("Impact", "Describe a proposed change and inspect risk before editing.", () => { closeUtilityPanel(card); openImpactGuide(); });
  action("Knowledge", "Search governed project and team guidance.", () => { closeUtilityPanel(card); void openKnowledgeHub(); });
  action("Health", "Inspect setup, identities, integrations, and Doctor evidence.", () => { closeUtilityPanel(card); void openHealthCard(); });
  const footer = document.createElement("div"); footer.className = "row mission-footer";
  const refresh = document.createElement("button"); refresh.textContent = "Refresh"; refresh.onclick = () => { void openMissionControl(card); };
  const close = document.createElement("button"); close.className = "ghost"; close.textContent = "Close"; close.onclick = () => closeUtilityPanel(card);
  footer.append(refresh, close); card.append(actions, footer);
}

function openImpactGuide() {
  const card = createUtilityCard("Impact setup");
  card.className = "card impact-guide";
  const title = document.createElement("h3"); title.textContent = "Guided impact analysis";
  const help = document.createElement("p");
  help.textContent = "Describe the proposed change. Coop will use the existing read-only impact-analysis skill and publish an evidence-attributed result; this does not approve implementation.";
  const form = document.createElement("div"); form.className = "impact-form";
  const field = (label, control) => { const wrapper = document.createElement("label"); const caption = document.createElement("span"); caption.textContent = label; wrapper.append(caption, control); form.appendChild(wrapper); return control; };
  const target = field("Exact target object", document.createElement("input")); target.placeholder = "e.g. Sales[Margin] or dbo.fact_sales";
  const changeIntent = document.createElement("select");
  for (const value of ["investigate", "add", "remove", "rename", "retype", "redefine", "move", "deprecate"]) { const option = document.createElement("option"); option.value = value; option.textContent = value; changeIntent.appendChild(option); }
  field("Proposed change type", changeIntent);
  const outcome = field("Intended outcome", document.createElement("textarea")); outcome.rows = 2; outcome.placeholder = "What should be different, and why?";
  const environment = field("Environment", document.createElement("input")); environment.placeholder = "e.g. QE Dev";
  const deployment = field("Deployment scope", document.createElement("input")); deployment.placeholder = "e.g. development model and linked reports";
  const refreshLabel = document.createElement("label"); refreshLabel.className = "impact-check"; const refresh = document.createElement("input"); refresh.type = "checkbox"; refreshLabel.append(refresh, document.createTextNode(" Refresh Data Doc outputs if the agent determines they are stale")); form.appendChild(refreshLabel);
  const liveLabel = document.createElement("label"); liveLabel.className = "impact-check"; const live = document.createElement("input"); live.type = "checkbox"; liveLabel.append(live, document.createTextNode(" Permit read-only Fabric and Power BI inspection")); form.appendChild(liveLabel);
  const actions = document.createElement("div"); actions.className = "row impact-actions";
  const run = document.createElement("button"); run.textContent = "Run analysis";
  const cancel = document.createElement("button"); cancel.className = "ghost"; cancel.textContent = "Cancel"; cancel.onclick = () => closeUtilityPanel(card);
  run.onclick = async () => {
    let prompt;
    try {
      prompt = window.CoopImpact.guidedPrompt({ target: target.value, changeIntent: changeIntent.value, intendedOutcome: outcome.value, environment: environment.value, deploymentScope: deployment.value, refreshLineage: refresh.checked, allowLiveReads: live.checked });
    } catch (error) { toast(error.message || "Complete the required impact fields.", "warning"); return; }
    if (chatsState.get(activeSid)?.busy) {
      putCommandInComposer(prompt);
      toast("The agent is busy, so the impact request is ready in the composer.");
      closeUtilityPanel(card, false);
      return;
    }
    run.disabled = true;
    try {
      await post("/prompt", { message: prompt });
      closeUtilityPanel(card);
      toast("Impact analysis started. Evidence and gaps will appear here when the skill publishes its structured result.");
    } catch (error) {
      run.disabled = false;
      toast(error.message || "Impact analysis could not start.", "error");
    }
  };
  actions.append(run, cancel);
  card.append(title, help, form, actions);

  target.focus();

}

async function knowledgeRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify({ sid: activeSid, ...body }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "Knowledge request failed.");
  return value;
}

function showKnowledgePreview(card, proposal, refresh) {
  card.textContent = "";
  const title = document.createElement("h3"); title.textContent = "Review knowledge source change";
  const summary = document.createElement("p");
  summary.textContent = `${proposal.operation} · ${proposal.sourceId}:${proposal.relativePath}. Applying writes the reviewed source file but never commits it.`;
  const grid = document.createElement("div"); grid.className = "config-preview knowledge-preview";
  for (const [label, content] of [["Current", proposal.preview.before], ["Proposed", proposal.preview.after]]) {
    const pane = document.createElement("section");
    const heading = document.createElement("b"); heading.textContent = label;
    const pre = document.createElement("pre"); pre.textContent = content === null ? "(new source record)" : content;
    pane.append(heading, pre); grid.appendChild(pane);
  }
  const actions = document.createElement("div"); actions.className = "row";
  const apply = document.createElement("button"); apply.textContent = "Apply reviewed source change";
  const cancel = document.createElement("button"); cancel.className = "ghost"; cancel.textContent = "Cancel"; cancel.onclick = refresh;
  apply.onclick = async () => {
    apply.disabled = true;
    try {
      const value = await knowledgeRequest("/knowledge/apply", { proposalId: proposal.proposalId, approved: true });
      toast(value.result?.backupId ? "Knowledge source updated; prior bytes are recoverable." : "Proposed knowledge source added for Git review.");
      refresh();
    } catch (error) {
      apply.disabled = false;
      toast(error.message || "Knowledge source was not changed.", "error");
    }
  };
  actions.append(apply, cancel);
  card.append(title, summary, grid, actions);
}

function openKnowledgeTransition(card, row, toStatus, refresh) {
  card.textContent = "";
  const title = document.createElement("h3"); title.textContent = `${toStatus[0].toUpperCase()}${toStatus.slice(1)} ${row.id}`;
  const help = document.createElement("p");
  help.textContent = "This is a human-reviewed lifecycle action. Preview the exact Markdown change before applying it; Coop will not commit or publish it.";
  const reviewerLabel = document.createElement("label"); reviewerLabel.textContent = "Reviewer identity";
  const reviewer = document.createElement("input"); reviewer.required = true; reviewer.placeholder = "name or team identity"; reviewerLabel.appendChild(reviewer);
  let replacement = null;
  if (toStatus === "superseded") {
    const replacementLabel = document.createElement("label"); replacementLabel.textContent = "Approved replacement record ID";
    replacement = document.createElement("input"); replacement.required = true; replacement.placeholder = "knowledge.example.replacement.002"; replacementLabel.appendChild(replacement);
    card.append(title, help, reviewerLabel, replacementLabel);
  } else card.append(title, help, reviewerLabel);
  const actions = document.createElement("div"); actions.className = "row";
  const preview = document.createElement("button"); preview.textContent = "Preview lifecycle change";
  const cancel = document.createElement("button"); cancel.className = "ghost"; cancel.textContent = "Cancel"; cancel.onclick = refresh;
  preview.onclick = async () => {
    if (!reviewer.value.trim()) { toast("Enter the human reviewer identity.", "warning"); return; }
    const record = structuredClone(row.record);
    record.status = toStatus;
    record.review = { reviewedAt: new Date().toISOString(), reviewedBy: reviewer.value.trim() };
    record.supersededBy = toStatus === "superseded" ? replacement.value.trim() : null;
    preview.disabled = true;
    try {
      const value = await knowledgeRequest("/knowledge/preview", { action: "transition", sourceId: row.sourceId, recordId: row.id, record });
      showKnowledgePreview(card, value.proposal, refresh);
    } catch (error) {
      preview.disabled = false;
      toast(error.message || "Knowledge lifecycle change is invalid.", "error");
    }
  };
  actions.append(preview, cancel); card.appendChild(actions); reviewer.focus();
}

function knowledgeDraft(source) {
  const team = source.scope === "team";
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "knowledge.replace-me.001",
    title: "Replace with a concise reusable lesson",
    kind: "pattern",
    scope: source.scope,
    sensitivity: team ? "internal" : "client-confidential",
    status: "proposed",
    confidence: "medium",
    tags: ["replace-me"],
    appliesTo: ["replace-me"],
    source: { type: "human-authored", references: ["replace-with-reviewed-source"] },
    createdAt: now,
    createdBy: "replace-with-author-identity",
    review: { reviewedAt: null, reviewedBy: null },
    project: { organizationId: team ? null : "replace-with-client", projectId: source.projectId },
    sanitization: { clientData: team ? "none" : "present", checkedAt: team ? now : null, checkedBy: team ? "replace-with-sanitization-reviewer" : null },
    supersedes: null,
    supersededBy: null,
    body: {
      context: "Describe where this applies.", problem: "Describe the observed problem.", why: "Explain why it happens.",
      approvedPattern: "State the approved pattern.", antiPattern: "State the anti-pattern.", detection: "Explain how to detect it.",
      example: "Provide a sanitized example.", exceptions: "Document exceptions or state none.", sources: "Cite reviewed sources without client secrets.",
    },
  };
}

function openKnowledgeProposalEditor(card, sources, refresh) {
  card.textContent = "";
  const title = document.createElement("h3"); title.textContent = "Propose knowledge";
  const help = document.createElement("p");
  help.textContent = "Start from a normalized record. Team drafts require a named sanitization check and no client identifiers. Nothing is copied from private memory or the session automatically.";
  const sourceLabel = document.createElement("label"); sourceLabel.textContent = "Destination repository";
  const source = document.createElement("select");
  for (const item of sources) { const option = document.createElement("option"); option.value = item.id; option.textContent = `${item.scope}: ${item.id}`; source.appendChild(option); }
  sourceLabel.appendChild(source);
  const editor = document.createElement("textarea"); editor.className = "config-editor"; editor.rows = 24; editor.spellcheck = false; editor.setAttribute("aria-label", "Knowledge record JSON");
  const sync = () => { const selected = sources.find((item) => item.id === source.value); editor.value = JSON.stringify(knowledgeDraft(selected), null, 2); };
  source.onchange = sync; sync();
  const actions = document.createElement("div"); actions.className = "row";
  const preview = document.createElement("button"); preview.textContent = "Validate and preview";
  const cancel = document.createElement("button"); cancel.className = "ghost"; cancel.textContent = "Cancel"; cancel.onclick = refresh;
  preview.onclick = async () => {
    let record;
    try { record = JSON.parse(editor.value); } catch { toast("Knowledge JSON is invalid.", "error"); return; }
    preview.disabled = true;
    try {
      const value = await knowledgeRequest("/knowledge/preview", { action: "create", sourceId: source.value, record });
      showKnowledgePreview(card, value.proposal, refresh);
    } catch (error) {
      preview.disabled = false;
      toast(error.message || "Knowledge proposal is invalid.", "error");
    }
  };
  actions.append(preview, cancel); card.append(title, help, sourceLabel, editor, actions); editor.focus();
}

async function openKnowledgeHub(existingCard = null) {
  const card = createUtilityCard("Knowledge", existingCard);
  if (!card) return; card.className = "card knowledge-card"; card.textContent = "";
  const loading = document.createElement("p"); loading.textContent = "Reading governed project and team knowledge…"; card.appendChild(loading);

  let catalog;
  try {
    const response = await fetch(`/knowledge/catalog?sid=${encodeURIComponent(activeSid)}`);
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Knowledge catalog is unavailable.");
    catalog = value.catalog;
  } catch (error) { loading.textContent = error.message; loading.className = "health-error"; return; }
  if (!card.isConnected) return;
  const model = window.CoopKnowledge.build(catalog);
  card.textContent = "";
  const title = document.createElement("h3"); title.textContent = "Knowledge Hub";
  const summary = document.createElement("p");
  summary.textContent = model.sources.length
    ? `${model.current.length} current · ${model.history.length} historical/draft · evidence ${model.complete ? "complete" : model.status}. Git source files remain authoritative.`
    : "No project or team knowledge repository is configured. Private memory remains separate and is never shown here.";
  card.append(title, summary);
  const refresh = () => { void openKnowledgeHub(card); };
  if (!model.sources.length) {
    const close = document.createElement("button"); close.className = "ghost"; close.textContent = "Close"; close.onclick = () => closeUtilityPanel(card); card.appendChild(close); return;
  }
  const filters = document.createElement("div"); filters.className = "knowledge-filters";
  const query = document.createElement("input"); query.type = "search"; query.placeholder = "Search IDs, titles, tags, tools…";
  const scope = document.createElement("select");
  for (const [value, label] of [["", "All scopes"], ["project", "Project"], ["team", "Team"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; scope.appendChild(option); }
  const status = document.createElement("select");
  for (const value of ["", "approved", "proposed", "rejected", "deprecated", "superseded"]) { const option = document.createElement("option"); option.value = value; option.textContent = value || "All states"; status.appendChild(option); }
  filters.append(query, scope, status); card.appendChild(filters);
  const list = document.createElement("div"); list.className = "knowledge-list"; card.appendChild(list);
  const render = () => {
    list.textContent = "";
    const rows = window.CoopKnowledge.filter(model, { query: query.value, scopes: scope.value ? [scope.value] : [], statuses: status.value ? [status.value] : [] });
    for (const row of rows) {
      const item = document.createElement("details"); item.className = "knowledge-row";
      const heading = document.createElement("summary");
      const badge = document.createElement("span"); badge.className = `knowledge-status state-${row.status}`; badge.textContent = row.status;
      const name = document.createElement("b"); name.textContent = row.title;
      const meta = document.createElement("span"); meta.className = "prov"; meta.textContent = `${row.scope} · ${row.kind}${row.stale ? " · stale" : ""}`;
      heading.append(badge, name, meta); item.appendChild(heading);
      const sourceText = document.createElement("p"); sourceText.textContent = `${row.id} · ${row.sourceId}:${row.relativePath} · ${row.sensitivity} · confidence ${row.confidence}`;
      const tags = document.createElement("p"); tags.textContent = `Tags: ${row.tags.join(", ") || "none"} · Applies to: ${row.appliesTo.join(", ") || "none"}`;
      const rowActions = document.createElement("div"); rowActions.className = "row";
      if (row.canUse) { const use = document.createElement("button"); use.textContent = "Use in this session"; use.onclick = () => { putCommandInComposer(window.CoopKnowledge.usePrompt(row)); closeUtilityPanel(card, false); }; rowActions.appendChild(use); }
      for (const [allowed, next, label] of [[row.canApprove, "approved", "Approve"], [row.canReject, "rejected", "Reject"], [row.canDeprecate, "deprecated", "Deprecate"], [row.canSupersede, "superseded", "Supersede"]]) {
        if (!allowed) continue;
        const action = document.createElement("button"); action.className = "ghost"; action.textContent = label; action.onclick = () => openKnowledgeTransition(card, row, next, refresh); rowActions.appendChild(action);
      }
      item.append(sourceText, tags, rowActions); list.appendChild(item);
    }
    if (!rows.length) { const empty = document.createElement("p"); empty.textContent = "No knowledge records match these filters."; list.appendChild(empty); }
  };
  query.oninput = render; scope.onchange = render; status.onchange = render; render();
  for (const diagnostic of model.diagnostics) { const warning = document.createElement("p"); warning.className = "health-error"; warning.textContent = `${diagnostic.code}: ${diagnostic.message}`; card.appendChild(warning); }
  const actions = document.createElement("div"); actions.className = "row";
  const propose = document.createElement("button"); propose.textContent = "Propose knowledge"; propose.onclick = () => openKnowledgeProposalEditor(card, model.sources, refresh);
  const reload = document.createElement("button"); reload.className = "ghost"; reload.textContent = "Refresh"; reload.onclick = refresh;
  const close = document.createElement("button"); close.className = "ghost"; close.textContent = "Close"; close.onclick = () => closeUtilityPanel(card);
  actions.append(propose, reload, close); card.appendChild(actions); query.focus();
}

$("#healthBtn").onclick = () => { void openHealthCard(); };
$("#impactBtn").onclick = openImpactGuide;
$("#knowledgeBtn").onclick = () => { void openKnowledgeHub(); };
$("#missionControlBtn").onclick = () => { void openMissionControl(); };
$("#themeBtn").onclick = () => openThemePicker();

$("#compactBtn").onclick = async () => {
  toast("Compacting the conversation…");
  try {
    const r = await rpc({ type: "compact" });
    const d = (r && r.data) || {};
    toast(d.tokensBefore ? `Compacted: ~${Math.round(d.tokensBefore / 1000)}k → ~${Math.round((d.estimatedTokensAfter || 0) / 1000)}k tokens.` : "Compacted.");
  } catch (e) {
    // A 504 means the bridge stopped WAITING (180s) — not that pi failed. Compaction may
    // still finish; don't claim outright failure, and refresh the gauge shortly so a late
    // success is reflected. Any other error is a real failure.
    if (e && e.status === 504) {
      toast("Compaction is taking longer than expected — it may still finish; the context gauge will update when it does.");
      setTimeout(refreshCtx, 5000);
    } else {
      toast(e?.data?.code === "chat-unavailable" ? e.message : "Compaction failed or timed out.", "error");
    }
  }
};

// --- usage meter (shared extension status, including session replay) ------------
// The usage extension owns polling, model eligibility and errors. Render its
// status instead of submitting periodic slash commands into the conversation.
const usageEl = $("#usage"), usageText = $("#usageText");
const bar5 = $("#bar5"), bar7 = $("#bar7");

function clearUsage() {
  usageEl.hidden = true;
  usageText.textContent = "";
  usageEl.querySelector(".meter").title = "";
  bar5.style.width = bar7.style.width = "0%";
}

function maybeUsage(text) {
  if (/^Usage (?:unavailable|hidden|display is disabled)/i.test(text)) { clearUsage(); return true; }
  const parsed = window.CoopUsage.parse(text);
  if (!parsed) return false;
  usageEl.hidden = false;
  usageText.textContent = parsed.windows.map(w => `${w.label} ${w.remaining === null ? "--" : w.remaining + "%"}`).join(" · ");
  usageEl.querySelector(".meter").title = parsed.title;
  [bar5, bar7].forEach((bar, index) => {
    const w = parsed.windows[index];
    bar.style.width = `${w?.remaining ?? 0}%`;
    bar.hidden = !w || w.remaining === null;
  });
  return true;
}

const input = $("#input");
const composer = document.querySelector(".composer");
const imageInput = $("#imageInput");
const attachmentLane = $("#attachmentLane");
let imageLimits = window.CoopInteraction.imageLimits(null);
let attachments = [];
let textAttachments = [];
let attachmentReads = Promise.resolve();
let pendingAttachmentBatches = 0;
let pendingSubmission = null;
const textAttachmentLimits = window.CoopPortability.DEFAULT_TEXT_LIMITS;

async function refreshImageLimits() {
  try {
    const response = await fetch("/capabilities");
    if (response.ok) imageLimits = window.CoopInteraction.imageLimits((await response.json())?.limits?.promptImages);
  } catch { /* server still enforces the same contract; defaults remain conservative */ }
}

function renderAttachments() {
  attachmentLane.textContent = "";
  for (const attachment of attachments) {
    const item = document.createElement("span");
    item.className = "attachment";
    item.title = `${attachment.name} · ${Math.ceil(attachment.bytes / 1024)} KiB`;
    const preview = document.createElement("img");
    preview.src = `data:${attachment.mimeType};base64,${attachment.data}`;
    preview.alt = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Remove ${attachment.name}`;
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.onclick = () => {
      attachments = attachments.filter((candidate) => candidate.id !== attachment.id);
      renderAttachments();
    };
    item.append(preview, remove);
    attachmentLane.appendChild(item);
  }
  for (const attachment of textAttachments) {
    const item = document.createElement("span");
    item.className = "attachment text-attachment";
    item.title = `${attachment.name} · ${Math.ceil(attachment.bytes / 1024)} KiB · attached as plain text`;
    const icon = document.createElement("span"); icon.className = "text-attachment-icon"; icon.textContent = "TXT"; icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span"); name.className = "text-attachment-name"; name.textContent = attachment.name;
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = `Remove ${attachment.name}`; remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.onclick = () => { textAttachments = textAttachments.filter((candidate) => candidate.id !== attachment.id); renderAttachments(); };
    item.append(icon, name, remove); attachmentLane.appendChild(item);
  }
  if (pendingAttachmentBatches || pendingSubmission) {
    const loading = document.createElement("span");
    loading.className = "attachment";
    loading.setAttribute("role", "status");
    loading.textContent = pendingAttachmentBatches ? "Reading attachments…" : "Sending…";
    attachmentLane.appendChild(loading);
  }
  attachmentLane.hidden = attachments.length === 0 && textAttachments.length === 0 && !pendingAttachmentBatches && !pendingSubmission;
  for (const button of [sendBtn, steerBtn, followUpBtn]) button.disabled = pendingAttachmentBatches > 0 || pendingSubmission !== null;
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name || "that image"}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) { reject(new Error("The image could not be encoded.")); return; }
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || "pasted-image",
        mimeType: file.type,
        bytes: file.size,
        data: result.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  for (const file of Array.from(files || [])) {
    const admitted = window.CoopInteraction.admitImage([...(pendingSubmission?.images || []), ...attachments], file, imageLimits);
    if (!admitted.ok) { toast(admitted.error, "warning"); continue; }
    try {
      const attachment = await readImage(file);
      attachments.push(attachment);
      renderAttachments();
    } catch (error) {
      toast(error.message || "Couldn't attach that image.", "error");
    }
  }
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name || "that file"}.`));
    reader.onload = () => {
      try {
        resolve({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: window.CoopPortability.cleanName(file.name),
          mimeType: file.type || "text/plain",
          bytes: file.size,
          content: window.CoopPortability.validateTextContent(reader.result || "", file.name),
        });
      } catch (error) { reject(error); }
    };
    reader.readAsText(file);
  });
}

function addFiles(files) {
  // FileList can be cleared by the picker immediately after this call. Snapshot
  // now and serialize all picker, paste and drop reads against committed limits.
  const selected = Array.from(files || []);
  if (!selected.length) return Promise.resolve();
  pendingAttachmentBatches++;
  renderAttachments();
  const result = attachmentReads.then(() => readFiles(selected));
  attachmentReads = result.catch(() => {});
  return result.finally(() => {
    pendingAttachmentBatches--;
    renderAttachments();
  });
}

async function readFiles(files) {
  for (const file of Array.from(files || [])) {
    if (String(file.type || "").startsWith("image/")) { await addImages([file]); continue; }
    const admitted = window.CoopPortability.admitTextFile([...(pendingSubmission?.textFiles || []), ...textAttachments], file, textAttachmentLimits);
    if (!admitted.ok) { toast(admitted.error, "warning"); continue; }
    try { const attachment = await readTextFile(file); textAttachments.push(attachment); renderAttachments(); }
    catch (error) { toast(error.message || "Couldn't attach that text file.", "error"); }
  }
}

$("#attachImages").onclick = () => imageInput.click();
imageInput.addEventListener("change", () => {
  void addFiles(imageInput.files);
  imageInput.value = "";
});
input.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile()).filter(Boolean);
  if (!images.length) return; // ordinary SQL/DAX/YAML/text paste remains untouched
  event.preventDefault();
  void addFiles(images);
});
composer.addEventListener("dragover", (event) => {
  if (![...(event.dataTransfer?.items || [])].some((item) => item.kind === "file")) return;
  event.preventDefault();
  composer.classList.add("dragging");
});
composer.addEventListener("dragleave", () => composer.classList.remove("dragging"));
composer.addEventListener("drop", (event) => {
  composer.classList.remove("dragging");
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return; // do not swallow ordinary dragged text
  event.preventDefault();
  void addFiles(files);
});

async function submit(kind = "prompt") {
  if (desktopNavigationRestoring) return;
  if (pendingSubmission) {
    toast("The previous message is still sending. Your draft is saved here.", "warning");
    return;
  }
  if (pendingAttachmentBatches) {
    toast("Attachments are still loading. Please wait before sending.", "warning");
    return;
  }
  const rawMessage = input.value;
  const hasMessage = rawMessage.trim().length > 0;
  if (!hasMessage && !attachments.length && !textAttachments.length) return;
  const message = hasMessage ? rawMessage : "Please inspect the attached file(s).";
  // If a file is open in the Files panel with attach enabled, wrap the outgoing
  // prompt with the viewing-context directive. Slash commands are never wrapped —
  // the wrapper would break command parsing.
  const attach = !message.startsWith("/") && window.coopFiles ? window.coopFiles.attachTarget() : "";
  const contextual = attach ? wrapViewingContext(message, attach) : message;
  const outgoing = window.CoopPortability.wrapTextAttachments(contextual, textAttachments);
  // No local echo: the user bubble renders from the message_start event on the
  // stream (single source of truth — identical for live sends, replays after a
  // reconnect, and steered messages that Pi delivers later).
  const sentAttachments = attachments;
  const sentTextAttachments = textAttachments;
  // Reserve capacity until the response settles so failure can restore every
  // attachment without dropping files added to the next draft.
  pendingSubmission = { images: sentAttachments, textFiles: sentTextAttachments };
  input.value = ""; input.style.height = "auto";
  attachments = [];
  textAttachments = [];
  renderAttachments();
  try {
    const images = sentAttachments.map(({ mimeType, data }) => ({ type: "image", mimeType, data }));
    if (kind === "steer") {
      const reply = await rpc({ type: "steer", message: outgoing, images });
      if (reply?.success !== true) throw new Error("Steering message was not accepted.");
      toast("Steering message queued for the active turn.");
    } else if (kind === "follow_up") {
      const reply = await rpc({ type: "follow_up", message: outgoing, images });
      if (reply?.success !== true) throw new Error("Follow-up was not accepted.");
      toast("Follow-up queued for the next turn.");
    } else {
      await post("/prompt", { message: outgoing, images });
    }
  } catch (error) {
    // Preserve both the failed message and anything typed or attached meanwhile.
    const message = error.data?.code === "chat-unavailable"
      ? "This chat's agent has stopped. Start a new chat or reopen the workspace, then resend your restored draft and attachments."
      : "Couldn't send. Your message and attachments are restored before the newer draft.";
    toast(message, "error");
    input.value = rawMessage + (rawMessage && input.value ? "\n\n" : "") + input.value;
    attachments = [...sentAttachments, ...attachments];
    textAttachments = [...sentTextAttachments, ...textAttachments];
    input.dispatchEvent(new Event("input"));
  } finally {
    pendingSubmission = null;
    renderAttachments();
  }
}
sendBtn.onclick = () => submit("prompt");
steerBtn.onclick = () => submit("steer");
followUpBtn.onclick = () => submit("follow_up");
stopBtn.onclick = () => post("/abort", {}).catch(() => toast("Couldn't reach coop web.", "error"));
abortRetryBtn.onclick = async () => {
  abortRetryBtn.disabled = true;
  try {
    await rpc({ type: "abort_retry" });
    setRetryActive(false);
    statusPhase = "";
    if (!dot.classList.contains("busy")) statusText.textContent = "ready";
    toast("Stopped the active retry sequence.");
  } catch { toast("Couldn't stop the active retry.", "error"); }
  abortRetryBtn.disabled = false;
};
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const kind = dot.classList.contains("busy") ? (e.metaKey || e.ctrlKey ? "steer" : "follow_up") : "prompt";
    submit(kind);
  }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });

void initializeTheme();
connect();
refreshImageLimits();
refreshState();
