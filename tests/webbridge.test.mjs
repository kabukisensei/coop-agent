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
// A fake agent dir with one prior session for THIS cwd, so /sessions and /resume
// can be exercised (the bridge mirrors pi's session-dir encoding).
import { mkdirSync, writeFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { resolve as resolvePath } from "node:path";
const agentDir = mkdtempSync(join(osTmp(), "coop-web-test-"));

// A controlled working folder with known files, for the Files-panel endpoints
// (/files, /file) and their path jail. `outside` is a sibling the jail must never
// reach, incl. via the `escape` symlink planted inside the work dir.
const workDir = mkdtempSync(join(osTmp(), "coop-web-work-"));
const outside = mkdtempSync(join(osTmp(), "coop-web-outside-"));
writeFileSync(join(outside, "secret.txt"), "TOP SECRET — must never be served\n");
writeFileSync(join(workDir, "notes.md"), "# Title\n\nHello **world**.\n");
writeFileSync(join(workDir, "data.csv"), "name,age\nAlice,30\nBob,25\n");
mkdirSync(join(workDir, "sub"));
writeFileSync(join(workDir, "sub", "inner.txt"), "inner file contents\n");
try { symlinkSync(outside, join(workDir, "escape")); } catch { /* symlinks may be unavailable (e.g. Windows w/o privilege) */ }
const encoded = `--${resolvePath(process.cwd()).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessDir = join(agentDir, "sessions", encoded);
mkdirSync(sessDir, { recursive: true });
const FAKE_SESSION = "2026-07-01T00-00-00-000Z_test-session.jsonl";
writeFileSync(join(sessDir, FAKE_SESSION), [
  JSON.stringify({ type: "session", version: 3, id: "test-session", timestamp: "2026-07-01T00:00:00.000Z", cwd: process.cwd() }),
  JSON.stringify({ type: "session_info", name: "My old chat" }),
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello from the past" }] } }),
].join("\n") + "\n");

const spec = JSON.stringify({ bin: process.execPath, args: [join(HERE, "stub-pi.mjs")], env: { PI_CODING_AGENT_DIR: agentDir } });
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

r = await fetch(base + "/viewer.js", { headers: { cookie } });
t("viewer.js served with cookie", r.status === 200 && /javascript/.test(r.headers.get("content-type") || ""));

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

// --- polling fallback (/events-poll) ----------------------------------------------
r = await fetch(base + "/events-poll?since=0");
t("/events-poll without cookie -> 401", r.status === 401);

r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
t("/events-poll with cookie -> 200", r.status === 200);
let poll = await r.json();
t("poll returns a cursor + cwd", typeof poll.next === "number" && poll.next > 0 && typeof poll.cwd === "string");
t("poll at 0 excludes the answered dialog", !poll.events.some((l) => l.includes(dialog.id)));
t("poll at 0 includes earlier stream events", poll.events.some((l) => l.includes("polo:marco")));

const cursor = poll.next;
await post("/prompt", { message: "again" });
await new Promise((res) => setTimeout(res, 400));
r = await fetch(base + `/events-poll?since=${cursor}`, { headers: { cookie } });
poll = await r.json();
t("incremental poll returns only new events", poll.events.some((l) => l.includes("polo:again")) && !poll.events.some((l) => l.includes("polo:marco")));

// --- /rpc relay (toolbar commands) --------------------------------------------
r = await fetch(base + "/rpc", {
  method: "POST",
  headers: { cookie, "content-type": "application/json", "x-coop-csrf": "1" },
  body: JSON.stringify({ type: "prompt", message: "sneaky" }),
});
t("/rpc rejects non-whitelisted commands", r.status === 400);

r = await post("/rpc", { type: "get_state" });
t("/rpc get_state -> 200", r.status === 200);
let state = await r.json();
t("get_state response correlated (model returned)", state.success === true && state.data.model.id === "stub-1");

r = await fetch(base + `/events-poll?since=0`, { headers: { cookie } });
poll = await r.json();
t("claimed rpc responses are NOT recorded in history", !poll.events.some((l) => l.includes('"command":"get_state"')));

r = await post("/rpc", { type: "set_model", provider: "stub", modelId: "stub-2" });
state = await r.json();
t("/rpc set_model round-trips", state.success === true && state.data.id === "stub-2");

r = await post("/rpc", { type: "get_session_stats" });
state = await r.json();
t("/rpc get_session_stats returns context usage", state.success === true && state.data.contextUsage.percent === 6);

r = await post("/rpc", { type: "set_session_name", name: "My named chat" });
state = await r.json();
t("/rpc set_session_name round-trips", state.success === true);

r = await post("/rpc", { type: "new_session" });
state = await r.json();
t("/rpc new_session -> success", state.success === true && state.data.cancelled === false);
r = await fetch(base + `/events-poll?since=0`, { headers: { cookie } });
poll = await r.json();
t("new_session resets the replay history", poll.next === 0 && poll.events.length === 0);

// --- /sessions + /resume ------------------------------------------------------------
r = await fetch(base + "/sessions", { headers: { cookie } });
t("/sessions -> 200", r.status === 200);
let sess = (await r.json()).sessions;
const mine = sess.find((x) => x.file === FAKE_SESSION);
t("lists the prior conversation with name + preview", !!mine && mine.name === "My old chat" && mine.preview.includes("hello from the past"));

r = await post("/resume", { file: "../evil.jsonl" });
t("/resume path-jails the filename", r.status === 400);

r = await post("/resume", { file: FAKE_SESSION });
t("/resume a real conversation -> 200", r.status === 200);
await new Promise((res) => setTimeout(res, 900)); // respawn + backfill
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("backfilled user turn arrives as __message", poll.events.some((l) => l.includes('"__message"') && l.includes("old question")));
t("backfilled assistant turn carries its tool call", poll.events.some((l) => l.includes("old answer") && l.includes("sql_review")));

// --- /folders (recent working folders from the session store) ---------------------
r = await fetch(base + "/folders", { headers: { cookie } });
t("/folders -> 200", r.status === 200);
let folders = (await r.json()).folders;
t("/folders lists the prior session's cwd (from the header, not the dir name)",
  Array.isArray(folders) && folders.some((f) => f.dir === resolvePath(process.cwd())));

// --- /chdir (restart the agent in a new working folder) ---------------------------
r = await post("/chdir", { dir: join(ROOT, "no-such-folder-xyz") });
t("/chdir rejects a missing folder", r.status === 400);

const target = resolvePath(workDir);
r = await post("/chdir", { dir: target });
t("/chdir switches to a real folder", r.status === 200);
let ch = await r.json();
t("chdir echoes the resolved folder", ch.ok === true && ch.cwd === target);
await new Promise((res) => setTimeout(res, 600)); // let the respawned stub boot
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("poll reports the new folder", poll.cwd === target);
t("restarted agent's startup dialog arrives fresh", poll.events.some((l) => l.includes("What would you like to do")));

// --- /files + /file (read-only Files panel, jailed to the working folder) ---------
r = await fetch(base + "/files", { headers: { cookie } });
t("/files -> 200", r.status === 200);
let tree = await r.json();
const treeNames = (tree.tree || []).map((n) => n.name);
t("/files lists the working folder's entries", treeNames.includes("notes.md") && treeNames.includes("data.csv") && treeNames.includes("sub"));
const subNode = (tree.tree || []).find((n) => n.name === "sub");
t("/files nests subdirectories", subNode && subNode.type === "dir" && (subNode.children || []).some((c) => c.name === "inner.txt"));

r = await fetch(base + "/file?p=notes.md", { headers: { cookie } });
t("/file reads a markdown file (kind=markdown)", r.status === 200);
let file = await r.json();
t("/file returns the file's content + kind", file.ok === true && file.kind === "markdown" && file.content.includes("# Title"));

r = await fetch(base + "/file?p=data.csv", { headers: { cookie } });
file = await r.json();
t("/file tags csv as a sheet", file.ok === true && file.kind === "sheet");

r = await fetch(base + "/file?p=sub/inner.txt", { headers: { cookie } });
file = await r.json();
t("/file reads a nested file", file.ok === true && file.content.includes("inner file contents"));

r = await fetch(base + "/file?p=" + encodeURIComponent("../../etc/passwd"), { headers: { cookie } });
t("/file rejects ../ traversal (path jail)", r.status === 400);

r = await fetch(base + "/file?p=" + encodeURIComponent("escape/secret.txt"), { headers: { cookie } });
t("/file rejects a symlink that escapes the jail (realpath check)", r.status === 400);

r = await fetch(base + "/file?p=does-not-exist.md", { headers: { cookie } });
t("/file rejects a missing file", r.status === 400);

r = await fetch(base + "/files");
t("/files without cookie -> 401", r.status === 401);

server.kill();
console.log(`  ${n} web-bridge tests passed`);
process.exit(0);
