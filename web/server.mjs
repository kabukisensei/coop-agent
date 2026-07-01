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
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
const CWD = getArg("--cwd", process.cwd());

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
function spawnPi() {
  const bin = spec.bin || "pi";
  const args = [...spec.args, "--mode", "rpc", "-a"];
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

const pi = spawnPi();
pi.on("error", (e) => {
  console.error("coop web: failed to start pi:", e.message);
  process.exit(1);
});
pi.on("exit", (code) => {
  console.error(`coop web: pi exited (${code}). Shutting down.`);
  process.exit(code || 0);
});

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

// --- Parse Pi's stdout as strict JSONL (\n only — NOT a generic line reader) --
let stdoutBuf = "";
pi.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    let line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF input
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // ignore any non-JSON noise on stdout
    }
    if (evt.type === "agent_start") busy = true;
    if (evt.type === "agent_end") busy = false;
    record(line, evt);
    broadcast(line); // forward the raw JSON line verbatim
  }
});
pi.stderr.on("data", (c) => process.stderr.write(c)); // pi diagnostics -> our console
pi.stdin.on("error", (e) => console.error("coop web: pi stdin error:", e.message)); // don't crash on async write errors

// --- HTTP server ---------------------------------------------------------------
const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
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
