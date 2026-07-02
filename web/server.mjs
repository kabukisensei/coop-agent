// coop web — a tiny localhost bridge that puts a friendly browser window in front
// of the SAME governed coop the terminal runs. See docs/coop-web-plan.md.
//
// It spawns `pi --mode rpc -a` using the shared launch spec (COOP_LAUNCH_SPEC, from
// `coop launch-spec --json`), relays Pi's JSONL events to the browser over SSE, and
// forwards prompts + extension-UI responses back to Pi's stdin. Node built-ins only.
//
// Security model (localhost, single user — layered):
//   - binds 127.0.0.1 only; Host header must be localhost/127.0.0.1 (DNS-rebinding guard)
//   - per-run random token (query -> HttpOnly SameSite=Strict cookie) gates every
//     route; compared timing-safe. Valid until this process exits.
//   - strict CSP (no inline script/style — the SPA is served as separate files),
//     nosniff, no-referrer; CORS is never enabled
//   - POSTs additionally require the X-Coop-CSRF custom header (cross-origin pages
//     can't set custom headers without a CORS preflight, which we never grant)
//
// NOT for remote or multi-user use.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync, fstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep, extname, resolve as resolvePath } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT_EXPLICIT = argv.includes("--port") || Boolean(process.env.COOP_WEB_PORT);
let PORT = Number(getArg("--port", process.env.COOP_WEB_PORT || "7420"));
const HOST = "127.0.0.1";
const TOKEN = randomBytes(16).toString("hex");
// Working folder for the agent: --cwd <dir>, else wherever `coop web` was run.
// Mutable: POST /chdir restarts the governed pi child in a new folder.
let CWD = getArg("--cwd", process.cwd());

// --- Resolve the governed launch spec ---------------------------------------
let spec;
try {
  spec = JSON.parse(process.env.COOP_LAUNCH_SPEC || "");
  if (!spec || !Array.isArray(spec.args)) throw new Error("no args");
} catch {
  console.error(
    "coop web: missing/invalid COOP_LAUNCH_SPEC. Run this via `coop web`, not `node server.mjs` directly.",
  );
  process.exit(1);
}

import { statSync } from "node:fs";
try {
  if (!statSync(CWD).isDirectory()) throw new Error("not a directory");
} catch {
  console.error(`coop web: working folder not found: ${CWD}`);
  process.exit(1);
}

// --- Spawn the governed Pi in RPC mode --------------------------------------
function spawnPi(extraArgs = []) {
  const bin = spec.bin || "pi";
  const args = [...spec.args, "--mode", "rpc", "-a", ...extraArgs];
  const env = { ...process.env, ...(spec.env || {}) };
  if (process.platform === "win32") {
    // npm-global `pi` is a .cmd shim, which Node can only launch through cmd.exe.
    // cmd has no safe escape for embedded `"` or `%` inside a quoted argument, so
    // refuse those outright (launch-spec args are repo paths + fixed flags — they
    // never legitimately contain either) rather than quote them wrongly.
    for (const a of [bin, ...args]) {
      if (/["%]/.test(String(a))) {
        console.error(`coop web: launch-spec argument contains '"' or '%', which cmd.exe cannot quote safely: ${a}`);
        process.exit(1);
      }
    }
    const line = [bin, ...args].map((s) => `"${s}"`).join(" ");
    // `/s` strips the first and last quote of the string after /c, so wrap the
    // whole line in one extra pair (the canonical cmd /s /c pattern).
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      env,
      cwd: CWD,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(bin, args, { env, cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
}

let pi; // current child — reassigned by restartPi(); handlers generation-check it
let stderrTail = ""; // bounded tail of pi's stderr, surfaced to the browser on a crash
const STDERR_TAIL_MAX = 4000;

function wirePi(child) {
  child.on("error", (e) => {
    console.error("coop web: failed to start pi:", e.message);
    if (child === pi) process.exit(1);
  });
  child.on("exit", (code) => {
    if (child !== pi) return; // an old child we intentionally replaced — ignore
    console.error(`coop web: pi exited (${code}). Shutting down.`);
    // Best-effort last words: tell connected browsers WHY instead of leaving them
    // on a generic "disconnected". SSE writes are buffered synchronously, so a
    // short grace period lets the frame flush before the process dies.
    broadcast(JSON.stringify({
      type: "__fatal",
      code: code === undefined ? null : code,
      stderrTail: stderrTail.trim().slice(-1500),
    }));
    setTimeout(() => process.exit(code || 0), 250);
  });
  // Strict \n-only JSONL parse, buffered PER CHILD (a replaced child's partial
  // line must never bleed into the new one's stream).
  let buf = "";
  child.stdout.on("data", (chunk) => {
    if (child !== pi) return;
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF input
      if (!line.trim()) continue;
      handlePiLine(line);
    }
  });
  child.stderr.on("data", (c) => {
    process.stderr.write(c); // pi diagnostics -> our console
    if (child !== pi) return;
    stderrTail = (stderrTail + c.toString("utf8")).slice(-STDERR_TAIL_MAX);
  });
  child.stdin.on("error", (e) => console.error("coop web: pi stdin error:", e.message));
}

pi = spawnPi();
wirePi(pi);

// Write one JSONL command to Pi's stdin (LF-terminated, per the RPC contract).
function sendToPi(obj) {
  try {
    pi.stdin.write(JSON.stringify(obj) + "\n");
  } catch (e) {
    console.error("coop web: could not write to pi:", e.message);
  }
}

// --- Event fan-out + reconnect replay -----------------------------------------
// We keep a bounded ring buffer of every event line broadcast to browsers. A new
// (or reconnecting) SSE client gets a `__hello` marker, then the replay, then live
// events — so refreshing the page or dropping the connection doesn't lose the
// transcript. Answered dialog cards and transient toasts are skipped on replay.
const HISTORY_MAX = 4000;
const history = []; // { line, uiId?, uiMethod? }
let historyBase = 0; // count of evicted entries — history[i] is global event #(historyBase+i)
const answeredUi = new Set();
const sseClients = new Set();
let busy = false; // agent streaming? (chooses prompt vs steer)

// --- RPC command relay (toolbar: new chat, model picker, thinking, compact) ----
// POST /rpc sends ONE whitelisted pi RPC command and returns pi's correlated
// response. Claimed responses are request-scoped: they are neither recorded in
// history nor broadcast to the event stream.
const RPC_ALLOWED = new Set([
  "new_session",
  "get_state",
  "get_available_models",
  "set_model",
  "set_thinking_level",
  "compact",
  "get_session_stats", // read-only: tokens, cost, context usage (header gauge)
  "set_session_name", // names the current conversation (History list)
]);
let rpcSeq = 0;
const pendingRpc = new Map(); // id -> { resolve, timer }

function record(line, evt) {
  const entry = { line };
  if (evt.type === "extension_ui_request") {
    entry.uiId = evt.id;
    entry.uiMethod = evt.method;
  }
  history.push(entry);
  if (history.length > HISTORY_MAX) {
    // Evict oldest — and drop their ids from answeredUi so the Set can't grow
    // unbounded over a long session.
    const evicted = history.splice(0, history.length - HISTORY_MAX);
    historyBase += evicted.length;
    for (const old of evicted) {
      if (old.uiId) answeredUi.delete(old.uiId);
    }
  }
}

function replayable(entry) {
  if (entry.uiMethod === "notify") return false; // transient toast
  if (entry.uiId && answeredUi.has(entry.uiId)) return false; // dialog already answered
  return true;
}

function broadcast(jsonLine) {
  const frame = `data: ${jsonLine}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Heartbeat: a comment frame every 15s keeps intermediaries (proxies, endpoint
// protection) from idling-out or indefinitely buffering the SSE stream.
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": ping\n\n");
    } catch {
      sseClients.delete(res);
    }
  }
}, 15000).unref();

// One parsed line from the CURRENT pi child (called by wirePi's stream reader).
function handlePiLine(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return; // ignore any non-JSON noise on stdout
  }
  if (evt.type === "response") {
    const waiter = evt.id !== undefined ? pendingRpc.get(evt.id) : undefined;
    if (waiter) {
      // Claimed by a /rpc call: request-scoped, never recorded or broadcast.
      pendingRpc.delete(evt.id);
      clearTimeout(waiter.timer);
      waiter.resolve(evt);
    } else {
      broadcast(line); // e.g. a rejected prompt — live only, meaningless on replay
    }
    return;
  }
  if (evt.type === "agent_start") busy = true;
  if (evt.type === "agent_end") busy = false;
  record(line, evt);
  broadcast(line); // forward the raw JSON line verbatim
}

// Restart the governed pi in a new working folder: fresh session, tools, and
// data-doc detection all consistent with the header. The old child's exit is
// ignored via the generation check in wirePi.
function restartPi(newCwd, extraArgs = []) {
  CWD = newCwd;
  const old = pi;
  pi = null; // generation check: old child's events/exit are ignored from here
  try { old.kill(); } catch { /* already gone */ }
  for (const [id, waiter] of pendingRpc) {
    clearTimeout(waiter.timer);
    waiter.resolve(null); // fail pending toolbar calls fast instead of timing out
    pendingRpc.delete(id);
  }
  busy = false;
  history.length = 0;
  historyBase = 0;
  answeredUi.clear();
  stderrTail = "";
  pi = spawnPi(extraArgs);
  wirePi(pi);
  broadcast(JSON.stringify({ type: "__hello", replay: 0, cwd: CWD }));
}

// One correlated RPC round-trip against the current pi child.
function rpcCall(cmd, timeoutMs = 30000) {
  const id = `web-${++rpcSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingRpc.set(id, { resolve, timer });
    sendToPi({ ...cmd, id });
  });
}

// --- Session listing + resume -------------------------------------------------
// Mirrors pi's getDefaultSessionDirPath: sessions live under
// <agentDir>/sessions/--<cwd with [/\:] -> - >--/. We list the newest files with
// a cheap scan for the display name (last session_info entry) and a preview
// (first user message), and resume by restarting pi with --session <file> —
// the file must live inside the current folder's session dir (path jail).
function sessionsDirFor(cwd) {
  const agentDir = (spec.env && spec.env.PI_CODING_AGENT_DIR) || process.env.PI_CODING_AGENT_DIR || "";
  if (!agentDir) return null;
  const safe = `--${resolvePath(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvePath(agentDir), "sessions", safe);
}

// Read up to maxBytes from the head of a file, without loading a multi-MB session
// wholesale. A truncated trailing line simply fails JSON.parse below and is skipped.
function readHead(fullPath, maxBytes) {
  let fd;
  try {
    fd = openSync(fullPath, "r");
    const len = Math.min(fstatSync(fd).size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const nread = readSync(fd, buf, off, len - off, off);
      if (nread <= 0) break;
      off += nread;
    }
    return buf.toString("utf8", 0, off);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function scanSessionFile(fullPath) {
  // Read a bounded head chunk: enough for the header + early entries (session name
  // and the first user message) without loading a multi-MB session wholesale.
  const text = readHead(fullPath, 256 * 1024);
  if (text === null) return null;
  const lines = text.split("\n");
  let name = "";
  let preview = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name; // last one wins
    if (!preview && entry.message && entry.message.role === "user") {
      const c = entry.message.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
      preview = String(t).replace(/\s+/g, " ").trim().slice(0, 80);
    }
  }
  return { name, preview };
}

// --- Recent working folders ----------------------------------------------------
// Folders coop has been used in before, derived from pi's session store: each
// sessions/--…--/ dir holds the conversations for one working folder. The dir
// NAME is a lossy encoding (hyphens in real path segments are indistinguishable
// from separators), so we read the authoritative `cwd` from the newest session
// file's header line instead — and only offer folders that still exist.
function recentFolders(limit = 12) {
  const agentDir = (spec.env && spec.env.PI_CODING_AGENT_DIR) || process.env.PI_CODING_AGENT_DIR || "";
  if (!agentDir) return [];
  const root = join(resolvePath(agentDir), "sessions");
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const byNewest = dirs
    .map((d) => {
      try {
        return { name: d.name, mtime: statSync(join(root, d.name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const seen = new Set();
  const out = [];
  for (const { name, mtime } of byNewest) {
    if (out.length >= limit) break;
    const dir = join(root, name);
    let newest = null;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const m = statSync(join(dir, f)).mtimeMs;
        if (!newest || m > newest.mtime) newest = { f, mtime: m };
      }
    } catch {
      continue;
    }
    if (!newest) continue;
    // The header ({"type":"session",…,"cwd":…}) is the first line of the file.
    const head = readHead(join(dir, newest.f), 8 * 1024);
    if (!head) continue;
    let cwd = "";
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
      } catch { /* truncated/odd line — keep scanning */ }
      break; // header is line one; don't scan the whole head
    }
    if (!cwd || seen.has(cwd)) continue;
    try {
      if (!statSync(cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(cwd);
    out.push({ dir: cwd, mtime });
  }
  return out;
}

// --- Read-only file browsing (Files panel) --------------------------------------
// The browser can LIST and READ files inside the current working folder — never
// outside it (path jail incl. symlink resolution), never write. This mirrors what
// the user could already see in their own file manager; it exists so review docs,
// lineage output, and CSVs are readable next to the chat.
const FILES_IGNORE = new Set([
  ".git", "node_modules", ".DS_Store", ".venv", "venv", "__pycache__", "dist", "out", ".next",
]);
const FILES_DEPTH = 6; // directory levels below CWD
const FILES_MAX = 2000; // total entries per listing — keeps the payload bounded
const FILE_TEXT_MAX = 1_000_000; // 1MB text preview cap

function listTree(dir, rel, depth, state) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes = [];
  for (const e of entries) {
    if (state.count >= FILES_MAX) {
      state.clipped = true;
      break;
    }
    if (FILES_IGNORE.has(e.name)) continue;
    if (e.name.startsWith(".") && e.name !== ".gitignore") continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      state.count++;
      nodes.push({
        name: e.name,
        path: childRel,
        type: "dir",
        children: depth > 0 ? listTree(join(dir, e.name), childRel, depth - 1, state) : [],
      });
    } else if (e.isFile()) {
      state.count++;
      nodes.push({ name: e.name, path: childRel, type: "file" });
    }
  }
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  return nodes;
}

const MD_EXT = new Set([".md", ".markdown", ".mdx"]);
const SHEET_EXT = new Set([".csv", ".tsv"]);
const DATA_EXT = new Set([".json", ".jsonl", ".ndjson"]);

// Resolve a browser-supplied relative path inside the CWD jail, or null.
// Two gates: the lexical resolve must stay under CWD (blocks ../ traversal), and
// the REAL path must too (blocks a symlink inside the tree pointing outside it).
function jailPath(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const root = resolvePath(CWD);
  const full = resolvePath(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    const real = realpathSync(full);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return real;
  } catch {
    return null; // doesn't exist / unreadable
  }
}

function readFilePreview(rel) {
  const full = jailPath(rel);
  if (!full) return null;
  let st;
  try {
    st = statSync(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const truncated = st.size > FILE_TEXT_MAX;
  const text = readHead(full, FILE_TEXT_MAX);
  if (text === null) return null;
  // Binary sniff: a NUL byte in the first 8KB means "don't render this as text".
  if (text.slice(0, 8192).includes("\0")) {
    return { path: rel, kind: "binary", content: "", truncated: false, size: st.size };
  }
  const ext = extname(full).toLowerCase();
  const kind = MD_EXT.has(ext) ? "markdown" : SHEET_EXT.has(ext) ? "sheet" : DATA_EXT.has(ext) ? "data" : "code";
  return { path: rel, kind, ext, content: text, truncated, size: st.size };
}

// After resuming, pull the active branch and backfill the browser transcript as
// synthetic __message events (recorded, so replay/polling see them too).
async function backfillMessages() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const reply = await rpcCall({ type: "get_messages" }, 5000);
    if (reply && reply.success && reply.data && Array.isArray(reply.data.messages)) {
      for (const m of reply.data.messages) {
        if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
        const c = m.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
        const tools = Array.isArray(c) ? c.filter((b) => b.type === "toolCall").map((b) => b.name) : [];
        if (!text.trim() && !tools.length) continue;
        const line = JSON.stringify({ type: "__message", role: m.role, text, tools });
        record(line, { type: "__message" });
        broadcast(line);
      }
      return;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  console.error("coop web: could not backfill the resumed conversation (get_messages never answered)");
}

// --- HTTP server ---------------------------------------------------------------
const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/viewer.js": { file: "viewer.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
const FAVICON = join(HERE, "..", "themes", "coop.ico");

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function baseHeaders(type) {
  return {
    "content-type": type,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

function hostOk(req) {
  const h = (req.headers.host || "").split(":")[0];
  return h === "127.0.0.1" || h === "localhost";
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function cookieToken(req) {
  const m = /(?:^|;\s*)coop_token=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
function authed(req) {
  const t = cookieToken(req);
  return t !== null && safeEqual(t, TOKEN);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 1e6) req.destroy(); // cap payloads
    });
    req.on("end", () => resolve(b));
    req.on("error", () => resolve(""));
    req.on("close", () => resolve(b)); // destroyed (cap hit) — settle the promise
  });
}
async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("coop web: request error:", e.message);
    try {
      res.writeHead(500, baseHeaders("text/plain")).end("error");
    } catch {
      /* headers already sent */
    }
  });
});

async function handle(req, res) {
  res.on("finish", () => {
    if (req.url && req.url.startsWith("/events-poll") && res.statusCode === 200) return;
    console.error(`  ${req.method} ${(req.url || "").split("?")[0]} -> ${res.statusCode}`);
  });
  if (!hostOk(req)) {
    res.writeHead(403, baseHeaders("text/plain")).end("bad host");
    return;
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Landing page: require the one-time token in the query, then set it as a cookie.
  if (req.method === "GET" && url.pathname === "/") {
    if (!safeEqual(url.searchParams.get("token") || "", TOKEN)) {
      res
        .writeHead(401, baseHeaders("text/plain"))
        .end("coop web: invalid or missing token. Restart with `coop web` and use the printed URL.");
      return;
    }
    res.writeHead(200, {
      ...baseHeaders(STATIC["/"].type),
      // No `Secure` flag: this is plain http on 127.0.0.1 (loopback never leaves the machine).
      "set-cookie": `coop_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(readFileSync(join(HERE, "public", STATIC["/"].file)));
    return;
  }

  // Everything below requires the cookie.
  if (!authed(req)) {
    res.writeHead(401, baseHeaders("text/plain")).end("unauthorized");
    return;
  }

  if (req.method === "GET" && STATIC[url.pathname] && url.pathname !== "/") {
    const s = STATIC[url.pathname];
    res.writeHead(200, baseHeaders(s.type));
    res.end(readFileSync(join(HERE, "public", s.file)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    if (existsSync(FAVICON)) {
      res.writeHead(200, baseHeaders("image/x-icon"));
      res.end(readFileSync(FAVICON));
    } else {
      res.writeHead(404, baseHeaders("text/plain")).end();
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      ...baseHeaders("text/event-stream"),
      connection: "keep-alive",
    });
    res.write(`retry: 2000\n\n`);
    // Hello marker (client clears its transcript), then replay, then live.
    res.write(`data: ${JSON.stringify({ type: "__hello", replay: history.length, cwd: CWD })}\n\n`);
    for (const entry of history) {
      if (replayable(entry)) res.write(`data: ${entry.line}\n\n`);
    }
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Polling fallback for environments where SSE never connects (some corporate
  // proxies/endpoint protection buffer or block streaming responses, even on
  // loopback). Returns everything after global event #since, plus the next cursor.
  if (req.method === "GET" && url.pathname === "/events-poll") {
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    const rel = Math.max(0, since - historyBase);
    const events = history.slice(rel).filter(replayable).map((e) => e.line);
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ next: historyBase + history.length, cwd: CWD, events }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const dir = sessionsDirFor(CWD);
    const sessions = [];
    if (dir && existsSync(dir)) {
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        files = [];
      }
      const withTimes = files
        .map((f) => {
          try {
            return { f, mtime: statSync(join(dir, f)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);
      for (const { f, mtime } of withTimes) {
        const meta = scanSessionFile(join(dir, f));
        if (!meta) continue;
        if (!meta.name && !meta.preview) continue; // empty shell sessions aren't resumable conversations
        sessions.push({ file: f, mtime, name: meta.name, preview: meta.preview });
      }
    }
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ sessions }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/folders") {
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ folders: recentFolders() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/files") {
    const state = { count: 0, clipped: false };
    const tree = listTree(resolvePath(CWD), "", FILES_DEPTH, state);
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ cwd: CWD, tree, clipped: state.clipped }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/file") {
    const preview = readFilePreview(url.searchParams.get("p") || "");
    if (!preview) {
      res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That file can't be shown." }));
      return;
    }
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, ...preview }));
    return;
  }

  // POSTs: require the CSRF custom header on top of the cookie.
  if (req.method === "POST") {
    if (req.headers["x-coop-csrf"] !== "1") {
      res.writeHead(403, baseHeaders("text/plain")).end("missing CSRF header");
      return;
    }

    if (url.pathname === "/prompt") {
      const body = await readJson(req);
      const message = body && body.message;
      if (message && String(message).trim()) {
        const cmd = { type: "prompt", message: String(message) };
        if (busy) cmd.streamingBehavior = "steer";
        sendToPi(cmd);
      }
      res.writeHead(200, baseHeaders("application/json")).end(`{"ok":true}`);
      return;
    }

    if (url.pathname === "/ui-response") {
      const body = await readJson(req);
      if (body && body.id) {
        answeredUi.add(body.id); // don't replay this dialog card on reconnect
        // Whitelist the fields — never spread an untrusted body over a fixed
        // `type`, or the browser could relay arbitrary RPC commands to pi.
        const reply = { type: "extension_ui_response", id: String(body.id) };
        if (body.value !== undefined) reply.value = body.value;
        if (body.confirmed !== undefined) reply.confirmed = Boolean(body.confirmed);
        if (body.cancelled !== undefined) reply.cancelled = Boolean(body.cancelled);
        sendToPi(reply);
      }
      res.writeHead(200, baseHeaders("application/json")).end(`{"ok":true}`);
      return;
    }

    if (url.pathname === "/rpc") {
      const body = await readJson(req);
      const type = body && body.type;
      if (!type || !RPC_ALLOWED.has(type)) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "command not allowed" }));
        return;
      }
      const cmd = { type };
      if (type === "set_model") {
        cmd.provider = String(body.provider || "");
        cmd.modelId = String(body.modelId || "");
      }
      if (type === "set_thinking_level") cmd.level = String(body.level || "medium");
      if (type === "compact" && body.customInstructions) cmd.customInstructions = String(body.customInstructions);
      if (type === "set_session_name") cmd.name = String(body.name || "").slice(0, 200);
      const reply = await rpcCall(cmd);
      if (!reply) {
        res.writeHead(504, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "pi did not answer in time" }));
        return;
      }
      if (type === "new_session" && reply.success && !(reply.data && reply.data.cancelled)) {
        // The old session's events are meaningless now: reset the replay buffer
        // and tell every connected client to start a fresh transcript.
        history.length = 0;
        historyBase = 0;
        answeredUi.clear();
        broadcast(JSON.stringify({ type: "__hello", replay: 0, cwd: CWD }));
      }
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify(reply));
      return;
    }

    if (url.pathname === "/resume") {
      const body = await readJson(req);
      const name = body && typeof body.file === "string" ? body.file : "";
      const dir = sessionsDirFor(CWD);
      // Path jail: a plain .jsonl basename inside THIS folder's session dir only.
      const safeName = /^[A-Za-z0-9._-]+\.jsonl$/.test(name);
      const full = dir && safeName ? join(dir, name) : "";
      if (!full || !existsSync(full)) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That conversation could not be found." }));
        return;
      }
      restartPi(CWD, ["--session", full]);
      console.error(`  resuming session ${name}`);
      backfillMessages(); // async: fills the fresh transcript once pi is up
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/chdir") {
      const body = await readJson(req);
      const target = body && typeof body.dir === "string" ? resolvePath(String(body.dir).trim()) : "";
      let ok = false;
      try {
        ok = Boolean(target) && statSync(target).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That folder doesn't exist. Paste a full path (e.g. C:\\Users\\you\\repo)." }));
        return;
      }
      restartPi(target);
      console.error(`  working folder changed -> ${target}`);
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, cwd: target }));
      return;
    }

    if (url.pathname === "/abort") {
      sendToPi({ type: "abort" });
      res.writeHead(200, baseHeaders("application/json")).end(`{"ok":true}`);
      return;
    }
  }

  res.writeHead(404, baseHeaders("text/plain")).end("not found");
}

// --- Open the browser (Edge app-mode = "it's an app" window on Windows) -------
function openBrowser(u) {
  const p = process.platform;
  try {
    if (p === "win32") {
      // Prefer Edge app-mode (chromeless); fall back to the default browser.
      spawn("cmd", ["/c", "start", "", "msedge", `--app=${u}`], { detached: true, stdio: "ignore" })
        .on("error", () => spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }));
    } else if (p === "darwin") {
      spawn("open", ["-na", "Microsoft Edge", "--args", `--app=${u}`], { detached: true, stdio: "ignore" })
        .on("error", () => spawn("open", [u], { detached: true, stdio: "ignore" }));
    } else {
      spawn("xdg-open", [u], { detached: true, stdio: "ignore" });
    }
  } catch {
    /* the URL is printed below regardless */
  }
}

// A busy default port (e.g. the desktop icon double-clicked twice) walks to the
// next free one instead of dying in a minimized console nobody sees. An explicit
// --port / COOP_WEB_PORT is respected strictly.
let portTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && !PORT_EXPLICIT && portTries < 10) {
    portTries++;
    PORT++;
    console.error(`coop web: port ${PORT - 1} is in use — trying ${PORT}…`);
    setTimeout(() => server.listen(PORT, HOST), 100);
    return;
  }
  if (e.code === "EADDRINUSE") {
    console.error(`coop web: port ${PORT} is already in use. Try:  coop web --port ${PORT + 1}`);
  } else {
    console.error("coop web: server error:", e.message);
  }
  try { pi.kill(); } catch { /* ignore */ }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const u = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.error(`\n  coop web is running.\n  Opening: ${u}\n  (If it doesn't open, paste that URL into your browser.)\n  Press Ctrl+C to stop.\n`);
  if (!/^(1|true|yes)$/i.test(process.env.COOP_WEB_NO_OPEN || "")) openBrowser(u);
});

function shutdown() {
  try { pi.kill(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
