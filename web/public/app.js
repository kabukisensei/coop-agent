// coop web SPA — renders the governed Pi RPC event stream as a friendly chat.
// Served with a strict CSP (no inline script/style). No dependencies.
"use strict";

const $ = (s) => document.querySelector(s);
const transcript = $("#transcript"), scroll = $("#scroll");
const dot = $("#dot"), statusText = $("#statusText");
const stopBtn = $("#stop");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
const stick = (was) => { if (was) scroll.scrollTop = scroll.scrollHeight; };

// --- markdown-lite (escape FIRST, then a few safe transforms) -----------------
// Supports: fenced code blocks, headings, bullet lists, inline code, **bold**,
// and bare http(s) links. Everything else stays literal text — no raw HTML ever.
function renderMarkdown(raw) {
  const lines = String(raw).split("\n");
  const out = [];
  let inCode = false, code = [], inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  const inline = (s) =>
    esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`);
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = []; }
      else closeList();
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    closeList();
    if (line.trim() === "") out.push("<p></p>");
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && code.length) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  closeList();
  return out.join("");
}

// --- transcript primitives -----------------------------------------------------
function bubble(role, text = "") {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  const b = document.createElement("div");
  b.className = "bubble";
  if (role === "assistant") { b.dataset.raw = text; b.innerHTML = renderMarkdown(text); }
  else b.textContent = text;
  wrap.appendChild(b);
  transcript.appendChild(wrap);
  scroll.scrollTop = scroll.scrollHeight;
  return b;
}
let current = null; // current streaming assistant bubble
let tools = new Map();

function appendAssistant(delta) {
  const was = atBottom();
  if (!current) current = bubble("assistant", "");
  current.dataset.raw = (current.dataset.raw || "") + delta;
  current.innerHTML = renderMarkdown(current.dataset.raw);
  stick(was);
}

function setBusy(b) {
  dot.classList.toggle("busy", b);
  statusText.textContent = b ? "thinking…" : "ready";
  stopBtn.hidden = !b;
}

function toast(message, kind = "info") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = message;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

// --- extension UI requests (Start Here menu, approvals, prompts) ---------------
async function respond(id, payload) { await post("/ui-response", { id, ...payload }); }

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

// --- human-readable review results (sql_review / dax_review) -------------------
const SEV_ORDER = ["error", "warning", "info"];

function reviewCard(evt) {
  const report = evt.result && evt.result.details && evt.result.details.report;
  const findings = report && Array.isArray(report.findings) ? report.findings : null;
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card review";

  const name = evt.toolName === "sql_review" ? "SQL review" : "DAX review";
  const title = document.createElement("h3");

  if (!findings) {
    // Raw fallback: the tool's JSON changed shape or didn't parse — show what we have.
    title.textContent = `${name} — result`;
    card.appendChild(title);
    const det = document.createElement("details");
    det.open = true;
    const sum = document.createElement("summary");
    sum.textContent = "Raw result";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(evt.result && evt.result.details ? evt.result.details : evt.result, null, 2);
    det.append(sum, pre);
    card.appendChild(det);
  } else {
    const bySev = { error: [], warning: [], info: [] };
    for (const f of findings) {
      const s = String(f.severity || "info").toLowerCase();
      (bySev[s] || bySev.info).push(f);
    }
    title.innerHTML =
      `${esc(name)} <span class="counts">— ${findings.length} finding${findings.length === 1 ? "" : "s"}: ` +
      `${bySev.error.length} error · ${bySev.warning.length} warning · ${bySev.info.length} info</span>`;
    card.appendChild(title);

    if (findings.length === 0) {
      const p = document.createElement("p");
      p.textContent = "No findings — this passes the Cooptimize standards. ✓";
      card.appendChild(p);
    }
    for (const sev of SEV_ORDER) {
      if (!bySev[sev].length) continue;
      const h = document.createElement("div");
      h.className = `sev ${sev}`;
      h.textContent = sev.toUpperCase();
      card.appendChild(h);
      for (const f of bySev[sev]) {
        const d = document.createElement("div");
        d.className = "finding";
        const loc = [f.file, f.line].filter((x) => x !== undefined && x !== null && x !== "").join(":");
        d.innerHTML =
          `${f.rule_id ? `<span class="rule">${esc(f.rule_id)}</span> ` : ""}${esc(f.message || f.note || "")}` +
          `${loc ? `<br><span class="loc">${esc(loc)}${f.object ? ` — ${esc(f.object)}` : ""}</span>` : ""}`;
        card.appendChild(d);
      }
    }
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Raw JSON";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(report, null, 2);
    det.append(sum, pre);
    card.appendChild(det);
  }

  transcript.appendChild(card);
  stick(was);
}

// --- event stream ---------------------------------------------------------------
function resetTranscript() {
  transcript.textContent = "";
  current = null;
  tools = new Map();
  setBusy(false);
}

function handle(evt) {
  const was = atBottom();
  switch (evt.type) {
    case "__hello":
      resetTranscript(); // reconnect: server replays history next — start clean
      break;
    case "agent_start": setBusy(true); break;
    case "agent_end": setBusy(false); current = null; break;
    case "message_start":
      if (evt.message && evt.message.role === "user") {
        // Sole renderer of user bubbles (live sends, replays, steered deliveries).
        const c = Array.isArray(evt.message.content) ? evt.message.content : [];
        const text = c.filter((p) => p.type === "text").map((p) => p.text).join("\n") || (typeof evt.message.content === "string" ? evt.message.content : "");
        if (text.trim()) bubble("user", text);
      }
      if (evt.message && evt.message.role === "assistant") current = null;
      break;
    case "message_update": {
      const d = evt.assistantMessageEvent || {};
      if (d.type === "text_start") current = bubble("assistant", "");
      else if (d.type === "text_delta") appendAssistant(d.delta || "");
      break;
    }
    case "message_end": current = null; break;
    case "tool_execution_start": {
      const el = document.createElement("div");
      el.className = "tool";
      el.innerHTML = "⚙ " + esc(evt.toolName || "tool") + " …";
      transcript.appendChild(el);
      tools.set(evt.toolCallId, el);
      stick(was);
      break;
    }
    case "tool_execution_end": {
      const el = tools.get(evt.toolCallId);
      if (el) {
        el.innerHTML = (evt.isError ? '<span class="bad">✗</span> ' : '<span class="ok">✓</span> ') + esc(evt.toolName || "tool");
      }
      if ((evt.toolName === "sql_review" || evt.toolName === "dax_review") && !evt.isError) reviewCard(evt);
      break;
    }
    case "extension_ui_request":
      if (evt.method === "notify") toast(evt.message || "", evt.notifyType || "info");
      else if (["select", "confirm", "input", "editor"].includes(evt.method)) uiCard(evt);
      // setStatus/setWidget/setTitle: not rendered
      break;
  }
}

// --- transport --------------------------------------------------------------------
async function post(path, body) {
  await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify(body),
  });
}
function connect() {
  const es = new EventSource("/events");
  es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* skip bad frame */ } };
  es.onerror = () => { statusText.textContent = "reconnecting…"; };
}

const input = $("#input");
function send() {
  const message = input.value.trim();
  if (!message) return;
  // No local echo: the user bubble renders from the message_start event on the
  // stream (single source of truth — identical for live sends, replays after a
  // reconnect, and steered messages that Pi delivers later).
  if (dot.classList.contains("busy")) toast("Queued — coop will pick this up in a moment.");
  input.value = ""; input.style.height = "auto";
  post("/prompt", { message });
}
$("#send").onclick = send;
stopBtn.onclick = () => post("/abort", {});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });

connect();
