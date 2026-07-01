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
  // Tokenize code spans FIRST, then apply bold/link transforms only to the
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
          .replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`);
      })
      .join("");
  };
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

// --- human-readable review results (sql_review / dax_review) -------------------
const SEV_ORDER = ["error", "warning", "info"];

function reviewCard(evt) {
  const report = evt.result && evt.result.details && evt.result.details.report;
  // Mirror the extension's summarizeReview, which accepts findings || results.
  const findings = report && (Array.isArray(report.findings) ? report.findings : Array.isArray(report.results) ? report.results : null);
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
      // Own-property guard: a severity like "constructor" must not hit the prototype.
      (Object.prototype.hasOwnProperty.call(bySev, s) ? bySev[s] : bySev.info).push(f);
    }
    title.innerHTML =
      `${esc(name)} <span class="counts">— ${findings.length} finding${findings.length === 1 ? "" : "s"}: ` +
      `${bySev.error.length} error · ${bySev.warning.length} warning · ${bySev.info.length} info</span>`;
    card.appendChild(title);

    if (findings.length === 0) {
      const p = document.createElement("p");
      // Careful copy: a run can be filtered by min_severity, so "no findings"
      // means clean at this threshold — not a blanket certification.
      p.textContent = "No findings in this check. ✓";
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
      if (evt.cwd) setCwd(evt.cwd);
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
      if (evt.method === "notify") {
        // Usage snapshots (pi-better-openai's /openai-usage) render as the header
        // meter instead of a toast; everything else stays a toast.
        if (!maybeUsage(evt.message || "")) toast(evt.message || "", evt.notifyType || "info");
      } else if (["select", "confirm", "input", "editor"].includes(evt.method)) uiCard(evt);
      // setStatus/setWidget/setTitle: not rendered
      break;
    case "response":
      // Surface command rejections (e.g. a prompt refused mid-stream) instead of
      // failing silently.
      if (evt.success === false) toast(`coop rejected a command${evt.error ? `: ${evt.error}` : ""}.`, "error");
      break;
  }
}

// --- transport --------------------------------------------------------------------
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res;
}
let currentCwd = "";
function setCwd(cwd) {
  currentCwd = cwd;
  const el = document.querySelector("#cwd");
  if (el) { el.textContent = cwd; el.title = `coop is working in ${cwd} — click to change`; }
}

// Change the working folder: the bridge restarts the governed agent IN that
// folder, so tools, lineage docs, and the header all agree. (Asking the agent to
// `cd` in chat only moves its shell — not where coop's tools operate.)
document.querySelector("#cwd").addEventListener("click", () => {
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Change working folder";
  const p = document.createElement("p");
  p.textContent = "Paste the full path of the folder coop should work in (tip: copy it from the File Explorer address bar). This starts a fresh conversation there.";
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
  ok.onclick = async () => {
    const dir = field.value.trim();
    if (!dir) return;
    ok.disabled = true;
    try {
      const r = await fetch("/chdir", {
        method: "POST",
        headers: { "content-type": "application/json", "x-coop-csrf": "1" },
        body: JSON.stringify({ dir }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(data.error || "Couldn't switch to that folder.", "error");
        ok.disabled = false;
        return;
      }
      toast(`Now working in ${data.cwd}`);
      card.remove(); // the transcript resets via the fresh __hello broadcast
      setTimeout(refreshState, 1500); // repopulate model/thinking chips for the new session
    } catch {
      toast("Couldn't reach coop web.", "error");
      ok.disabled = false;
    }
  };
  field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
  row.append(ok, cancel);
  card.append(title, p, field, row);
  transcript.appendChild(card);
  field.focus();
  stick(was);
});

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
  es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* skip bad frame */ } };
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
  let since = 0, first = true;
  statusText.textContent = "connecting…";
  const tick = async () => {
    try {
      const r = await fetch(`/events-poll?since=${since}`);
      if (r.status === 401) {
        statusText.textContent = "session expired — close this window and start coop again";
        return; // stop polling: the cookie belongs to a previous coop web run
      }
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (first) { resetTranscript(); first = false; if (data.cwd) setCwd(data.cwd); }
      since = data.next;
      for (const line of data.events) { try { handle(JSON.parse(line)); } catch { /* skip */ } }
      if (/connecting|reconnecting/.test(statusText.textContent)) setBusy(dot.classList.contains("busy"));
      setTimeout(tick, 1500);
    } catch {
      statusText.textContent = "reconnecting…";
      setTimeout(tick, 2500);
    }
  };
  tick();
}

// --- toolbar: new chat, model picker, thinking level, compact ------------------
async function rpc(body) {
  const res = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/rpc ${body.type} -> ${res.status}`);
  return res.json();
}

const modelChip = $("#modelChip"), thinkChip = $("#thinkChip");
const THINK_LEVELS = ["off", "minimal", "low", "medium", "high"];
let currentThink = "medium";

function shortModel(m) {
  const label = (m && (m.name || m.id)) || "model…";
  return label.length > 26 ? label.slice(0, 25) + "…" : label;
}
function setModelChip(m) {
  modelChip.textContent = shortModel(m);
  if (m) modelChip.title = `Model: ${m.id || ""} (${m.provider || ""}) — click to change`;
}
function setThinkChip(level) {
  if (level) currentThink = level;
  thinkChip.textContent = `🧠 ${currentThink}`;
}

async function refreshState() {
  try {
    const st = await rpc({ type: "get_state" });
    const d = (st && st.data) || {};
    setModelChip(d.model);
    setThinkChip(d.thinkingLevel);
    startUsagePolling(d.model);
  } catch {
    /* toolbar stays generic — chat still works */
  }
}

$("#newChat").onclick = async () => {
  try {
    const r = await rpc({ type: "new_session" });
    if (r && r.data && r.data.cancelled) toast("New chat was cancelled.");
    // On success the server resets history and broadcasts a fresh __hello,
    // which clears this transcript.
  } catch {
    toast("Couldn't start a new chat — is coop web still running?", "error");
  }
};

modelChip.onclick = async () => {
  let models = [];
  try {
    const r = await rpc({ type: "get_available_models" });
    models = (r && r.data && r.data.models) || [];
  } catch {
    toast("Couldn't list models.", "error");
    return;
  }
  if (!models.length) {
    toast("No other models are configured.");
    return;
  }
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Choose a model";
  card.appendChild(title);
  // With hundreds of configured models, a type-to-filter box is essential.
  const filter = document.createElement("input");
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
  const done = () => card.remove();
  for (const m of models) {
    const btn = document.createElement("button");
    btn.textContent = m.name || m.id;
    const prov = document.createElement("span");
    prov.className = "prov";
    prov.textContent = m.provider || "";
    btn.appendChild(prov);
    btn.onclick = async () => {
      try {
        const r = await rpc({ type: "set_model", provider: m.provider, modelId: m.id });
        setModelChip((r && r.data) || m);
        toast(`Model set to ${m.name || m.id}.`);
      } catch {
        toast("Couldn't switch model.", "error");
      }
      done();
    };
    row.appendChild(btn);
  }
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = done;
  closeRow.appendChild(cancel);
  card.append(row, closeRow);
  transcript.appendChild(card);
  filter.focus();
  stick(was);
};

thinkChip.onclick = async () => {
  const next = THINK_LEVELS[(THINK_LEVELS.indexOf(currentThink) + 1) % THINK_LEVELS.length];
  try {
    await rpc({ type: "set_thinking_level", level: next });
    setThinkChip(next);
  } catch {
    toast("Couldn't change the thinking level.", "error");
  }
};

$("#compactBtn").onclick = async () => {
  toast("Compacting the conversation…");
  try {
    const r = await rpc({ type: "compact" });
    const d = (r && r.data) || {};
    toast(d.tokensBefore ? `Compacted: ~${Math.round(d.tokensBefore / 1000)}k → ~${Math.round((d.estimatedTokensAfter || 0) / 1000)}k tokens.` : "Compacted.");
  } catch {
    toast("Compaction failed or timed out.", "error");
  }
};

// --- usage meter (pi-better-openai subscription snapshot) -----------------------
// The extension's footer meter is TUI-only, but its /openai-usage command reports
// the same snapshot via notify ("Usage: 5h: 62% | 7d: 81% | …"). We poll it and
// render the header meter (values are % LEFT in each window).
const usageEl = $("#usage"), usageText = $("#usageText");
const bar5 = $("#bar5"), bar7 = $("#bar7");
let usagePolling = false;

function maybeUsage(text) {
  if (!/^Usage:\s*5h:/i.test(text)) return false;
  const m5 = /5h:\s*([\d.]+)%/i.exec(text);
  const m7 = /7d:\s*([\d.]+)%/i.exec(text);
  usageEl.hidden = false;
  usageText.textContent = [m5 && `5h ${m5[1]}%`, m7 && `7d ${m7[1]}%`].filter(Boolean).join(" · ") || "usage";
  usageEl.querySelector(".meter").title = text + "  (percent remaining)";
  if (m5) bar5.style.width = Math.min(100, Number(m5[1])) + "%";
  if (m7) bar7.style.width = Math.min(100, Number(m7[1])) + "%";
  return true;
}

function startUsagePolling(model) {
  // Only when an OpenAI-family model is active — the /openai-usage command comes
  // from pi-better-openai, which coop installs alongside it.
  const sig = `${(model && model.provider) || ""} ${(model && model.id) || ""}`;
  if (usagePolling || !/openai|codex/i.test(sig)) return;
  usagePolling = true;
  const ask = () => post("/prompt", { message: "/openai-usage" }).catch(() => { /* retry next tick */ });
  ask();
  setInterval(ask, 120000);
}

const input = $("#input");
async function send() {
  const message = input.value.trim();
  if (!message) return;
  // No local echo: the user bubble renders from the message_start event on the
  // stream (single source of truth — identical for live sends, replays after a
  // reconnect, and steered messages that Pi delivers later).
  const wasBusy = dot.classList.contains("busy");
  input.value = ""; input.style.height = "auto";
  try {
    await post("/prompt", { message });
    if (wasBusy) toast("Queued — coop will pick this up in a moment.");
  } catch {
    // Never lose the user's words: put the message back in the composer.
    toast("Couldn't send — is coop web still running?", "error");
    input.value = message;
    input.dispatchEvent(new Event("input"));
  }
}
$("#send").onclick = send;
stopBtn.onclick = () => post("/abort", {}).catch(() => toast("Couldn't reach coop web.", "error"));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });

connect();
refreshState();
