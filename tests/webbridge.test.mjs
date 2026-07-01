// Integration tests for web/server.mjs (the coop web bridge).
// Spawns the bridge against a STUB pi (tests/stub-pi.mjs) — no real LLM, no network
// beyond localhost. Covers: token/cookie auth, CSRF header, SSE replay with the
// __hello marker, answered-dialog skipping on reconnect, and prompt forwarding.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = 7460 + Math.floor(Math.random() * 400); // avoid collisions across runs

let n = 0;
const t = (name, ok) => {
  assert.ok(ok, name);
  n++;
  console.log(`  ✓ ${name}`);
};

// --- start the bridge against the stub pi ------------------------------------
const spec = JSON.stringify({ bin: process.execPath, args: [join(HERE, "stub-pi.mjs")], env: {} });
const server = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--port", String(PORT)], {
  env: { ...process.env, COOP_LAUNCH_SPEC: spec, COOP_WEB_NO_OPEN: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => (serverErr += d));

const die = (msg) => {
  console.error(msg, "\n--- server stderr ---\n" + serverErr);
  try { server.kill(); } catch { /* ignore */ }
  process.exit(1);
};
server.on("exit", (code) => { if (code) die(`bridge exited early (${code})`); });

// Wait for the printed URL (carries the one-time token).
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("bridge didn't start in 10s")), 10000);
  const poll = setInterval(() => {
    const m = serverErr.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);
    if (m) { clearTimeout(timer); clearInterval(poll); resolve(m[0]); }
  }, 100);
}).catch((e) => die(e.message));
const base = `http://127.0.0.1:${PORT}`;

// --- auth --------------------------------------------------------------------
let r = await fetch(base + "/", { redirect: "manual" });
t("landing without token -> 401", r.status === 401);

r = await fetch(base + "/events");
t("/events without cookie -> 401", r.status === 401);

r = await fetch(url);
t("landing with token -> 200", r.status === 200);
const setCookie = r.headers.get("set-cookie") || "";
t("sets HttpOnly SameSite=Strict cookie", /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie));
t("landing sends a strict CSP", /default-src 'none'/.test(r.headers.get("content-security-policy") || ""));
const cookie = setCookie.split(";")[0];
const html = await r.text();
t("serves the SPA shell", html.includes("<title>coop</title>") && html.includes("/app.js"));

r = await fetch(base + "/app.js", { headers: { cookie } });
t("app.js served with cookie", r.status === 200 && /javascript/.test(r.headers.get("content-type") || ""));

// fetch() forbids overriding Host, so use raw http for the rebinding-guard probe.
const rebindStatus = await new Promise((resolve) => {
  import("node:http").then(({ request }) => {
    const rq = request(
      { host: "127.0.0.1", port: PORT, path: "/", headers: { host: "evil.example" } },
      (rs) => { rs.resume(); resolve(rs.statusCode); },
    );
    rq.on("error", () => resolve(0));
    rq.end();
  });
});
t("wrong Host header -> 403 (rebinding guard)", rebindStatus === 403);

// --- CSRF ----------------------------------------------------------------------
r = await fetch(base + "/prompt", {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: '{"message":"x"}',
});
t("POST without X-Coop-CSRF -> 403", r.status === 403);

// --- SSE: hello + replay of the stub's startup dialog ----------------------------
async function readSse(ms) {
  const ctrl = new AbortController();
  const resp = await fetch(base + "/events", { headers: { cookie }, signal: ctrl.signal });
  const reader = resp.body.getReader();
  let buf = "";
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const race = await Promise.race([
      reader.read(),
      new Promise((res) => setTimeout(() => res(null), Math.max(50, until - Date.now()))),
    ]);
    if (!race || race.done) break;
    buf += Buffer.from(race.value).toString("utf8");
  }
  ctrl.abort();
  return buf
    .split("\n\n")
    .map((f) => f.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((f) => { try { return JSON.parse(f); } catch { return null; } })
    .filter(Boolean);
}

let events = await readSse(1500);
t("SSE starts with __hello", events.length > 0 && events[0].type === "__hello");
const dialog = events.find((e) => e.type === "extension_ui_request" && e.method === "select");
t("stub's select dialog is replayed", !!dialog);
t("notify toasts are NOT replayed", !events.some((e) => e.method === "notify"));

// --- prompt forwarding: stub echoes the prompt back as a text_delta ---------------
const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify(body),
  });

r = await post("/prompt", { message: "marco" });
t("POST /prompt with CSRF -> 200", r.status === 200);
await new Promise((res) => setTimeout(res, 400));
events = await readSse(1200);
const echo = events.find(
  (e) => e.type === "message_update" && e.assistantMessageEvent && e.assistantMessageEvent.delta === "polo:marco",
);
t("prompt reached the stub pi and its reply streamed back", !!echo);

// --- ui-response marks the dialog answered (skipped on the next replay) -----------
r = await post("/ui-response", { id: dialog.id, value: dialog.options[0] });
t("POST /ui-response -> 200", r.status === 200);
events = await readSse(1200);
t("answered dialog is not replayed on reconnect", !events.some((e) => e.type === "extension_ui_request" && e.id === dialog.id));

server.kill();
console.log(`  ${n} web-bridge tests passed`);
process.exit(0);
