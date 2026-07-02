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
  // A buffered run of |-prefixed lines becomes a table if line 2 is a separator
  // row (|---|:---:|…); otherwise the run renders as plain paragraphs.
  const flushTable = () => {
    if (!table.length) return;
    const rows = table; table = [];
    const cells = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inline(c.trim()));
    if (rows.length >= 2 && /^\s*\|[\s:|-]+\|?\s*$/.test(rows[1]) && rows[1].includes("-")) {
      const html = ["<table><thead><tr>"];
      for (const c of cells(rows[0])) html.push(`<th>${c}</th>`);
      html.push("</tr></thead><tbody>");
      for (const row of rows.slice(2)) {
        html.push("<tr>");
        for (const c of cells(row)) html.push(`<td>${c}</td>`);
        html.push("</tr>");
      }
      html.push("</tbody></table>");
      out.push(html.join(""));
    } else {
      for (const row of rows) out.push(`<p>${inline(row)}</p>`);
    }
  };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = []; }
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
  if (inCode && code.length) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
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
  transcript.appendChild(wrap);
  scroll.scrollTop = scroll.scrollHeight;
  return b;
}
let current = null; // current streaming assistant bubble
let tools = new Map(); // toolCallId -> { sum, outp, hint }
let thinkingEl = null; // current streaming thinking <details> (open while streaming)
let assistantT0 = 0; // when the current assistant message started (for tok/s)

function appendAssistant(delta) {
  const was = atBottom();
  if (!current) current = bubble("assistant", "");
  current.dataset.raw = (current.dataset.raw || "") + delta;
  current.innerHTML = renderMarkdown(current.dataset.raw);
  stick(was);
}

// Reasoning stream: a collapsible block that stays open while the model thinks,
// then folds shut when the visible answer starts (the TUI shows the same stream).
function appendThinking(delta) {
  const was = atBottom();
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
  }
  thinkingEl.lastElementChild.textContent += delta;
  stick(was);
}
function endThinking() {
  if (thinkingEl) thinkingEl.open = false;
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
  if (b) {
    if (!busySince) busySince = Date.now(); // replayed agent_starts keep the original clock
    if (!statusTimer) statusTimer = setInterval(renderStatus, 1000);
    renderStatus();
  } else {
    busySince = 0; curTool = "";
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (!statusPhase) statusText.textContent = "ready";
  }
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

// The one way a user turn becomes a bubble (live sends, replays, backfills).
function userBubble(raw) {
  const { file, text } = stripViewingContext(raw);
  if (!text.trim() && !file) return;
  const b = bubble("user", text);
  if (file) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.textContent = "📎 " + (file.split(/[\\/]/).pop() || file);
    chip.title = file;
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
  thinkingEl = null;
  statusPhase = "";
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
    case "agent_end":
      setBusy(false);
      endThinking();
      current = null;
      refreshCtx(); // context gauge: cheap read-only stats after each turn
      if (window.coopFiles) window.coopFiles.onAgentEnd(); // the agent may have written files
      break;
    case "__fatal": {
      // The bridge's last words before it exits: the agent process died.
      setBusy(false);
      statusPhase = "";
      statusText.textContent = "coop stopped — close this window and start coop again";
      const card = document.createElement("div");
      card.className = "card";
      const h = document.createElement("h3");
      h.textContent = "coop stopped unexpectedly";
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
          el.innerHTML = '<span class="ok">✓</span> ' + esc(name);
          transcript.appendChild(el);
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
      endThinking();
      // Compact per-response stats under the bubble (Hephaestus-style): output
      // tokens, throughput, cache reads, model. Only when the turn produced a
      // visible bubble and the message actually carries usage.
      const m = evt.message || {};
      if (m.role === "assistant" && current) {
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
  window.coopCwd = cwd; // viewer.js prefixes relative file paths with this for attach
  const el = document.querySelector("#cwd");
  if (el) { el.textContent = cwd; el.title = `coop is working in ${cwd} — click to change`; }
}

// Change the working folder: the bridge restarts the governed agent IN that
// folder, so tools, lineage docs, and the header all agree. (Asking the agent to
// `cd` in chat only moves its shell — not where coop's tools operate.)
document.querySelector("#cwd").addEventListener("click", async () => {
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
        body: JSON.stringify({ dir }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(data.error || "Couldn't switch to that folder.", "error");
        if (busyEl) busyEl.disabled = false;
        return;
      }
      toast(`Now working in ${data.cwd}`);
      card.remove(); // the transcript resets via the fresh __hello broadcast
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
  p.textContent = (recents.length ? "Or paste" : "Paste") + " the full path of the folder coop should work in (tip: copy it from the File Explorer address bar). This starts a fresh conversation there.";
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
  let since = 0, first = true, fails = 0, epoch = null;
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
      fails = 0;
      // The __hello reset frame is broadcast-only (SSE), so on this polling path we
      // detect a server-side reset (new_session/chdir/resume) via the epoch instead.
      if (first) { resetTranscript(); first = false; }
      else if (epoch !== null && data.epoch !== epoch) { resetTranscript(); }
      epoch = data.epoch;
      if (data.cwd) setCwd(data.cwd); // every poll, so a chdir updates the header here too
      since = data.next;
      for (const line of data.events) { try { handle(JSON.parse(line)); } catch { /* skip */ } }
      if (/connecting|reconnecting/.test(statusText.textContent)) setBusy(dot.classList.contains("busy"));
      setTimeout(tick, 1500);
    } catch {
      // On loopback a poll can only fail because the bridge (and its pi child) is
      // gone — there's no flaky network to 127.0.0.1. The SSE path surfaces this as
      // a terminal EventSource.CLOSED; the polling path can't get the __fatal frame
      // (the server exits before the next poll), so after a few failures we mirror
      // that terminal state instead of looping "reconnecting…" forever.
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
  refreshCtx();
  if (window.coopFiles) window.coopFiles.onAgentEnd(); // refresh the Files tree for the (possibly new) folder
}

// --- context gauge (get_session_stats) ------------------------------------------
// How full the conversation's context window is, refreshed after every turn and
// after compaction — the web twin of the TUI footer's context readout.
const ctxEl = $("#ctx"), ctxBar = $("#ctxBar"), ctxText = $("#ctxText");
async function refreshCtx() {
  try {
    const r = await rpc({ type: "get_session_stats" });
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
    // On success the server resets history and broadcasts a fresh __hello,
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
  let sessions = [];
  try {
    const r = await fetch("/sessions");
    if (!r.ok) throw new Error(String(r.status));
    sessions = (await r.json()).sessions || [];
  } catch {
    toast("Couldn't list previous conversations.", "error");
    return;
  }
  if (!sessions.length) {
    toast("No previous conversations in this folder yet.");
    return;
  }
  const was = atBottom();
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Resume a conversation";
  const p = document.createElement("p");
  p.textContent = "Previous conversations in this folder, newest first.";
  const row = document.createElement("div");
  row.className = "row list";
  const done = () => card.remove();
  for (const sess of sessions) {
    const btn = document.createElement("button");
    btn.textContent = sess.name || sess.preview || "(untitled)";
    const when = document.createElement("span");
    when.className = "prov";
    when.textContent = relTime(sess.mtime);
    btn.appendChild(when);
    if (sess.name && sess.preview) btn.title = sess.preview;
    btn.onclick = async () => {
      try {
        const r = await fetch("/resume", {
          method: "POST",
          headers: { "content-type": "application/json", "x-coop-csrf": "1" },
          body: JSON.stringify({ file: sess.file }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          toast(data.error || "Couldn't resume that conversation.", "error");
          return;
        }
        toast("Resuming — one moment while the conversation loads…");
        setTimeout(refreshState, 1500);
      } catch {
        toast("Couldn't reach coop web.", "error");
      }
      done();
    };
    row.appendChild(btn);
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
  card.append(title, p, row, closeRow);
  transcript.appendChild(card);
  stick(was);
};

// Name the current conversation (pi's set_session_name) so the History list shows
// a real title instead of the first message.
function nameChatCard() {
  const was = atBottom();
  const card = document.createElement("div");
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
  cancel.onclick = () => card.remove();
  ok.onclick = async () => {
    const name = field.value.trim();
    if (!name) return;
    ok.disabled = true;
    try {
      await rpc({ type: "set_session_name", name });
      toast(`Chat named “${name}”.`);
      card.remove();
    } catch {
      toast("Couldn't name the chat.", "error");
      ok.disabled = false;
    }
  };
  field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
  row.append(ok, cancel);
  card.append(title, field, row);
  transcript.appendChild(card);
  field.focus();
  stick(was);
}

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
  // If a file is open in the Files panel with attach enabled, wrap the outgoing
  // prompt with the viewing-context directive. Slash commands are never wrapped —
  // the wrapper would break command parsing.
  const attach = !message.startsWith("/") && window.coopFiles ? window.coopFiles.attachTarget() : "";
  const outgoing = attach ? wrapViewingContext(message, attach) : message;
  // No local echo: the user bubble renders from the message_start event on the
  // stream (single source of truth — identical for live sends, replays after a
  // reconnect, and steered messages that Pi delivers later).
  const wasBusy = dot.classList.contains("busy");
  input.value = ""; input.style.height = "auto";
  try {
    await post("/prompt", { message: outgoing });
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
