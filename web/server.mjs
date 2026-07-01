// coop web — a tiny localhost bridge that puts a friendly browser window in front
// of the SAME governed coop the terminal runs. (Phase-2 SPIKE; see docs/coop-web-plan.md.)
//
// It spawns `pi --mode rpc -a` using the shared launch spec (COOP_LAUNCH_SPEC, from
// `coop launch-spec --json`), relays Pi's JSONL events to the browser over SSE, and
// forwards prompts + extension-UI responses back to Pi's stdin. Node built-ins only.
//
// Security (spike-grade, non-negotiable even here):
//   - binds 127.0.0.1 only
//   - a one-time token (query -> httpOnly cookie) gates /events, /prompt, /ui-response
//   - Host header must be localhost/127.0.0.1 (basic DNS-rebinding guard)
//
// NOT for remote/multi-user use. A production coop web needs CSP/CSRF hardening and
// the review renderer — this proves the shape.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(getArg("--port", process.env.COOP_WEB_PORT || "7420"));
const HOST = "127.0.0.1";
const TOKEN = randomBytes(16).toString("hex");

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

// --- Spawn the governed Pi in RPC mode --------------------------------------
function spawnPi() {
  const bin = spec.bin || "pi";
  const args = [...spec.args, "--mode", "rpc", "-a"];
  const env = { ...process.env, ...(spec.env || {}) };
  if (process.platform === "win32") {
    // npm-global `pi` is a .cmd shim, which Node can only launch through a shell.
    const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    const line = [bin, ...args].map(q).join(" ");
    return spawn(line, { env, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
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

// --- Parse Pi's stdout as strict JSONL (\n only — NOT a generic line reader) --
const sseClients = new Set();
let busy = false; // agent streaming? (chooses prompt vs steer)
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
    broadcast(line); // forward the raw JSON line to browsers verbatim
  }
});
pi.stderr.on("data", (c) => process.stderr.write(c)); // pi diagnostics -> our console

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

// --- HTTP server -------------------------------------------------------------
const INDEX = readFileSync(join(HERE, "public", "index.html"), "utf8");

function hostOk(req) {
  const h = (req.headers.host || "").split(":")[0];
  return h === "127.0.0.1" || h === "localhost";
}
function cookieToken(req) {
  const m = /(?:^|;\s*)coop_token=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
function authed(req) {
  return cookieToken(req) === TOKEN;
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 1e6) req.destroy(); // cap payloads
    });
    req.on("end", () => resolve(b));
  });
}

const server = createServer(async (req, res) => {
  if (!hostOk(req)) {
    res.writeHead(403).end("bad host");
    return;
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Landing page: require the one-time token in the query, then set it as a cookie.
  if (req.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401, { "content-type": "text/plain" }).end("coop web: invalid or missing token.");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `coop_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
      "cache-control": "no-store",
    });
    res.end(INDEX);
    return;
  }

  // Everything below requires the cookie.
  if (!authed(req)) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`retry: 2000\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/prompt") {
    const { message } = JSON.parse((await readBody(req)) || "{}");
    if (message && String(message).trim()) {
      const cmd = { type: "prompt", message: String(message) };
      if (busy) cmd.streamingBehavior = "steer";
      sendToPi(cmd);
    }
    res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true}`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/ui-response") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body && body.id) {
      // Pass through the matching fields (value / confirmed / cancelled).
      sendToPi({ type: "extension_ui_response", ...body });
    }
    res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true}`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/abort") {
    sendToPi({ type: "abort" });
    res.writeHead(200).end(`{"ok":true}`);
    return;
  }

  res.writeHead(404).end("not found");
});

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
