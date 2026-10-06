// The phone companion's server (master plan row MC2, contract in
// desktop/COMPANION.md). It listens on 127.0.0.1 only; Tailscale's `serve`
// carries the phone's requests to it inside the tailnet. Every API request is
// checked here, in order: host, origin, size, shape (companion-protocol.mjs),
// rate, then the device grant against the window that has phone access on.
// The phone page's own files (MC3) are served from `webRoot` under a strict CSP.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { CODES, DETAIL_ID, LIMITS, ProtocolError, checkGrant, checkOrigin, validateRequest } from "./companion-protocol.mjs";

export const DEFAULT_PORT = 47821;
export const COOKIE = "coop_device";
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const HEARTBEAT_MS = 25_000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cache-Control": "no-store" };

/** `coop_device=<id>.<secret>` from a Cookie header, or null. */
export function readCookie(header) {
  for (const part of String(header || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE) continue;
    const match = /^([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{20,100})$/.exec(rest.join("="));
    return match ? { id: match[1], secret: match[2] } : null;
  }
  return null;
}

const deviceCookie = (id, secret) => `${COOKIE}=${id}.${secret}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(LIMITS.deviceMaxMs / 1000)}`;
const clearedCookie = `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** A fixed-window counter per key. */
class Limiter {
  constructor(limit, windowMs, now) { Object.assign(this, { limit, windowMs, now, hits: new Map() }); }
  take(key) {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t - entry.start >= this.windowMs) { this.hits.set(key, { start: t, count: 1 }); return true; }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

/**
 * Build the server. `active()` returns the hub of the window whose phone access
 * is on (or null); `origin` is the companion's public origin, the Tailscale name
 * (`https://<vm>.<tailnet>.ts.net`); `audit(entry)` writes one log line.
 */
export function createCompanionServer({ store, active, origin, webRoot = "", shared = {}, audit = () => {}, now = Date.now, port = DEFAULT_PORT }) {
  const allowedHosts = new Set([new URL(origin).host, `127.0.0.1:${port}`, `localhost:${port}`]);
  const requests = new Limiter(LIMITS.requestsPerMinute, 60_000, now);
  const answers = new Limiter(LIMITS.answersPerMinute, 60_000, now);
  const pairs = new Limiter(LIMITS.pairFailuresPerHour, 3600_000, now);
  /** @type {Map<string, Set<import("node:http").ServerResponse>>} open streams by device */
  const streams = new Map();

  function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  function refuse(res, code, message, device) {
    audit({ kind: "refused", code, device: device || "" });
    sendJson(res, CODES[code] || 400, { ok: false, code, message: message || code });
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMITS.bodyBytes) throw new ProtocolError("too-large");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return { body: null, size };
    try { return { body: JSON.parse(text), size }; } catch { throw new ProtocolError("bad-request", "body is not JSON"); }
  }

  async function servePage(req, res, path) {
    if (req.method !== "GET" || !webRoot) { res.writeHead(404, SECURITY_HEADERS); res.end(); return; }
    // The desktop's own question parsers, Markdown renderer and theme tokens
    // are shared by name, so the phone draws questions as the window does.
    const sharedFile = Object.hasOwn(shared, path) ? shared[path] : "";
    let rel = "";
    try { rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1)); } catch { rel = "\0"; }
    const file = sharedFile || normalize(join(webRoot, rel));
    const type = TYPES[extname(file).toLowerCase()];
    if (!type || (!sharedFile && (!file.startsWith(webRoot + sep) || rel.includes("\0")))) { res.writeHead(404, SECURITY_HEADERS); res.end(); return; }
    try {
      const body = await readFile(file);
      // The page's own files only; no API response is ever cacheable.
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Security-Policy": PAGE_CSP, "Cache-Control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404, SECURITY_HEADERS);
      res.end();
    }
  }

  function closeStreams(deviceId) {
    for (const [id, set] of streams) {
      if (deviceId !== "*" && id !== deviceId) continue;
      for (const res of set) { try { res.end(); } catch { /* gone */ } }
      streams.delete(id);
    }
  }

  function openStream(req, res, hub, deviceId, after) {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const write = (event) => res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    // EventSource repeats the last id on its own; the page passes the snapshot's as `after`.
    const start = hub.resume(req.headers["last-event-id"] || after);
    if (start.mode === "replay") start.events.forEach(write);
    else res.write(`event: resync\ndata: ${JSON.stringify({ reason: start.reason })}\n\n`);
    const onEvent = (event) => write(event);
    // Access going off (a new session, Pi exiting, the window's toggle) ends
    // the stream; the phone's next request is refused with the reason.
    const onAccess = ({ on }) => { if (!on) res.end(); };
    hub.on("event", onEvent);
    hub.on("access", onAccess);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
    if (!streams.has(deviceId)) streams.set(deviceId, new Set());
    streams.get(deviceId).add(res);
    res.on("close", () => {
      clearInterval(beat);
      hub.off("event", onEvent);
      hub.off("access", onAccess);
      const set = streams.get(deviceId);
      if (set) { set.delete(res); if (!set.size) streams.delete(deviceId); }
    });
  }

  async function handleApi(req, res, path, query) {
    const ip = req.socket.remoteAddress || "";
    let request;
    try {
      checkOrigin(req.method, req.headers, origin);
      const { body, size } = req.method === "GET" ? { body: null, size: 0 } : await readBody(req);
      request = validateRequest(req.method, path, body, size);
    } catch (error) {
      if (error instanceof ProtocolError) return refuse(res, error.code, error.message);
      throw error;
    }

    if (request.op === "pair") {
      if (!pairs.take(ip)) return refuse(res, "rate-limited");
      const result = store.redeem(request.code, request.deviceName);
      if (result.error) return refuse(res, result.error, "that pairing code is wrong or has expired");
      // Pairing a code does not count against the failures.
      pairs.hits.delete(ip);
      audit({ kind: "paired", device: result.device.id, client: result.device.client });
      return sendJson(res, 200, { ok: true, device: { id: result.device.id, name: result.device.name, client: result.device.client } }, { "Set-Cookie": deviceCookie(result.device.id, result.secret) });
    }

    const cookie = readCookie(req.headers.cookie);
    const device = cookie ? store.get(cookie.id) : null;
    const hub = active();
    const binding = hub ? hub.binding : { windowsUser: "", client: "", incarnation: "", accessOn: false };
    if (request.op === "logout") {
      // Signing out works whatever the session: it removes this device.
      if (device && cookie && checkGrant({ device, secret: cookie.secret, binding: { ...binding, windowsUser: device.windowsUser, client: device.client, accessOn: true }, now: now() }) === null) {
        store.revoke(device.id);
        closeStreams(device.id);
        audit({ kind: "signed-out", device: device.id });
      }
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedCookie });
    }
    const denied = checkGrant({ device, secret: cookie ? cookie.secret : "", binding, incarnation: request.incarnation, now: now() });
    if (denied) return refuse(res, denied, undefined, device ? device.id : "");
    if (!requests.take(device.id)) return refuse(res, "rate-limited", undefined, device.id);
    store.touch(device.id);

    switch (request.op) {
      case "snapshot":
        return sendJson(res, 200, { ok: true, snapshot: await hub.snapshot(), device: { id: device.id, name: device.name } });
      case "events":
        return openStream(req, res, hub, device.id, String(query.get("after") || "").slice(0, 100));
      case "chat": {
        const result = hub.chat(device.id, request);
        audit({ kind: "chat", device: device.id, outcome: result.ok ? "sent" : result.code });
        return result.ok ? sendJson(res, 200, { ok: true }) : refuse(res, result.code, result.message, device.id);
      }
      case "dequeue": {
        const result = await hub.dequeue(device.id, request);
        audit({ kind: "dequeue", device: device.id, outcome: result.ok ? "returned" : result.code });
        return result.ok ? sendJson(res, 200, { ok: true, texts: result.texts }) : refuse(res, result.code, undefined, device.id);
      }
      case "detail": {
        const id = String(query.get("id") || "");
        if (!DETAIL_ID.test(id)) return refuse(res, "bad-request", "id is malformed", device.id);
        const result = hub.detail(id);
        return result.ok ? sendJson(res, 200, { ok: true, detail: result.detail }) : refuse(res, result.code, result.message, device.id);
      }
      case "sessions": {
        const result = await hub.sessions();
        return result.ok ? sendJson(res, 200, { ok: true, sessions: result.sessions, prompts: result.prompts }) : refuse(res, result.code, undefined, device.id);
      }
      case "sessionAction": {
        const result = await hub.sessionAction(device.id, request);
        audit({ kind: "session", device: device.id, action: request.action, outcome: result.ok ? "done" : result.code });
        if (!result.ok) return refuse(res, result.code, result.message, device.id);
        const { ok, ...rest } = result;
        return sendJson(res, 200, { ok: true, ...rest });
      }
      case "details": {
        const result = await hub.details();
        return result.ok ? sendJson(res, 200, { ok: true, details: result.details }) : refuse(res, result.code, undefined, device.id);
      }
      case "control": {
        const result = await hub.control(device.id, request);
        audit({ kind: "control", device: device.id, action: request.action, outcome: result.ok ? "sent" : result.code });
        return result.ok ? sendJson(res, 200, { ok: true }) : refuse(res, result.code, result.message, device.id);
      }
      case "stop": {
        const result = hub.stop(device.id, request);
        audit({ kind: "stop", device: device.id, outcome: result.ok ? "sent" : result.code });
        return result.ok ? sendJson(res, 200, { ok: true }) : refuse(res, result.code, undefined, device.id);
      }
      case "answer": {
        if (!answers.take(device.id)) return refuse(res, "rate-limited", undefined, device.id);
        const result = hub.answerFromPhone(device.id, request);
        audit({ kind: "answer", device: device.id, question: request.questionId, outcome: result.ok ? "answered" : result.code });
        return result.ok ? sendJson(res, 200, { ok: true }) : refuse(res, result.code, undefined, device.id);
      }
      default:
        return refuse(res, "not-found");
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://companion");
      // Only the companion's own names: a page elsewhere that points a name at
      // 127.0.0.1 (DNS rebinding) gets nothing.
      if (!allowedHosts.has(String(req.headers.host || ""))) { res.writeHead(421, SECURITY_HEADERS); res.end(); return; }
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url.pathname, url.searchParams);
      else await servePage(req, res, url.pathname);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: "error" });
      else res.end();
    }
  });

  return {
    server,
    /** Listen on loopback only. Resolves once listening; rejects if the port is taken. */
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(server.address()); });
      });
    },
    close() {
      closeStreams("*");
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /** End a removed device's streams at once. */
    revoked(ids) { for (const id of ids) closeStreams(id); },
  };
}
