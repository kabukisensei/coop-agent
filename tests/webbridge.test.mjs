// Integration tests for web/server.mjs (the coop web bridge).
// Spawns the bridge against a STUB pi (tests/stub-pi.mjs) — no real LLM, no network
// beyond localhost. Covers: token/cookie auth, CSRF header, SSE replay with the
// __hello marker, answered-dialog skipping on reconnect, and prompt forwarding.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
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
import { mkdirSync, writeFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
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
writeFileSync(join(workDir, ".env"), "SECRET_KEY=abc123\n"); // hidden by the listing; /file must not serve it either
mkdirSync(join(workDir, "sub"));
writeFileSync(join(workDir, "sub", "inner.txt"), "inner file contents\n");
let symlinked = false;
try { symlinkSync(outside, join(workDir, "escape")); symlinked = true; } catch { /* symlinks may be unavailable (e.g. Windows w/o privilege / Developer Mode) */ }
const encoded = `--${resolvePath(process.cwd()).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessDir = join(agentDir, "sessions", encoded);
mkdirSync(sessDir, { recursive: true });
// A full v3 tree that mirrors a real session file: header (NO parentId — never a
// leaf), session_info (no id — metadata, not part of the tree), a linear
// user->assistant(thinking+toolCall)->toolResult->assistant chain, PLUS a stale
// second leaf (b1) so `branched` is true. The user text stays "hello from the past"
// (the /sessions preview assertion depends on it). a2 has the latest timestamp, so
// it is the active leaf; b1 (older) is the abandoned branch.
const FAKE_SESSION = "2026-07-01T00-00-00-000Z_test-session.jsonl";
writeFileSync(join(sessDir, FAKE_SESSION), [
  JSON.stringify({ type: "session", version: 3, id: "test-session", timestamp: "2026-07-01T00:00:00.000Z", cwd: process.cwd() }),
  JSON.stringify({ type: "session_info", name: "My old chat", parentId: null, timestamp: "2026-07-01T00:00:00.500Z" }),
  JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello from the past" }] } }),
  JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering deeply" }, { type: "toolCall", id: "tc1", name: "read", arguments: { path: "notes.md" } }] } }),
  JSON.stringify({ type: "message", id: "t1", parentId: "a1", timestamp: "2026-07-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "tool output payload" }] } }),
  JSON.stringify({ type: "message", id: "a2", parentId: "t1", timestamp: "2026-07-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "rich old answer" }] } }),
  JSON.stringify({ type: "message", id: "b1", parentId: "u1", timestamp: "2026-07-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "stale branch answer" }] } }),
].join("\n") + "\n");

// A session whose FIRST user message was sent with a Files-panel attachment, so it is
// persisted wrapped in a <coop-viewing-context> directive. The /sessions preview must
// strip that wrapper and surface the real question (issue #6) — not the boilerplate.
const WRAP_SESSION = "2026-07-01T00-00-20-000Z_wrapped.jsonl";
const wrappedFirstMessage =
  '<coop-viewing-context file="/tmp/x.md">\n' +
  "The user is currently viewing this file in the coop web Files panel:\n/tmp/x.md\n" +
  'If they refer to "this file", assume they mean this file and read it as needed.\n' +
  "</coop-viewing-context>\n\nreal question here about revenue";
writeFileSync(join(sessDir, WRAP_SESSION), [
  JSON.stringify({ type: "session", version: 3, id: "wrapped-session", timestamp: "2026-07-01T00:00:20.000Z", cwd: process.cwd() }),
  JSON.stringify({ type: "message", id: "wru1", parentId: null, timestamp: "2026-07-01T00:00:21.000Z", message: { role: "user", content: [{ type: "text", text: wrappedFirstMessage }] } }),
  JSON.stringify({ type: "message", id: "wra1", parentId: "wru1", timestamp: "2026-07-01T00:00:22.000Z", message: { role: "assistant", content: [{ type: "text", text: "an answer" }] } }),
].join("\n") + "\n");

// A session whose only real content is unparseable — the file backfill yields zero
// turns, so /resume falls back to get_messages (proving the fallback still works).
const FALLBACK_SESSION = "2026-07-01T00-00-10-000Z_fallback.jsonl";
writeFileSync(join(sessDir, FALLBACK_SESSION), [
  JSON.stringify({ type: "session", version: 3, id: "fallback-session", timestamp: "2026-07-01T00:00:10.000Z", cwd: process.cwd() }),
  JSON.stringify({ type: "session_info", name: "Fallback chat", parentId: null, timestamp: "2026-07-01T00:00:10.500Z" }),
  "this is not json at all",
  "{ broken json",
].join("\n") + "\n");

// A STRICTLY LINEAR session in a SECOND workspace (workDir) — the cross-workspace
// group AND the linear-session control for the branch heuristic (one leaf ⇒ NOT
// branched, guarding the header-as-leaf false positive).
const workEncoded = `--${resolvePath(workDir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const workSessDir = join(agentDir, "sessions", workEncoded);
mkdirSync(workSessDir, { recursive: true });
const WORK_SESSION = "2026-07-02T00-00-00-000Z_work.jsonl";
writeFileSync(join(workSessDir, WORK_SESSION), [
  JSON.stringify({ type: "session", version: 3, id: "work-session", timestamp: "2026-07-02T00:00:00.000Z", cwd: resolvePath(workDir) }),
  JSON.stringify({ type: "session_info", name: "Work chat", parentId: null, timestamp: "2026-07-02T00:00:00.500Z" }),
  JSON.stringify({ type: "message", id: "wu1", parentId: null, timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "work question" }] } }),
  JSON.stringify({ type: "message", id: "wa1", parentId: "wu1", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "work answer" }] } }),
].join("\n") + "\n");

const spec = JSON.stringify({ bin: process.execPath, args: [join(HERE, "stub-pi.mjs")], env: { PI_CODING_AGENT_DIR: agentDir } });
const server = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--port", String(PORT)], {
  // COOP_WEB_MAX_CHATS=3 gives the multi-chat cap test a deterministic, cheap bound;
  // it affects nothing earlier in the file (all pre-multi-chat tests use one chat).
  env: { ...process.env, COOP_LAUNCH_SPEC: spec, COOP_WEB_NO_OPEN: "1", COOP_WEB_MAX_CHATS: "3" },
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
const appJsSrc = await r.text();
t("app.js served with cookie", r.status === 200 && /javascript/.test(r.headers.get("content-type") || ""));
// Fix B (docs/web-security-fix-plan.md): the SPA drops the landing ?token= from the URL
// after load (the cookie is the real gate). No DOM harness for app.js, so assert the guard.
t("app.js strips the token from the address bar after load (Fix B)",
  appJsSrc.includes('location.search.includes("token=")') && /history\.replaceState\(null, "", location\.pathname\)/.test(appJsSrc));

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

// --- SSE envelope: a GLOBAL __hello carrying the chats list (replay moved to poll) --
let events = await readSse(1500);
t("SSE starts with a global __hello carrying the chats list",
  events.length > 0 && events[0].ev && events[0].ev.type === "__hello" && Array.isArray(events[0].ev.chats));
const sid1 = events[0].ev.chats[0].sid;
t("__hello lists exactly one chat at boot", events[0].ev.chats.length === 1 && typeof sid1 === "string");

const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-coop-csrf": "1" },
    body: JSON.stringify(body),
  });

// Per-chat REPLAY now lives on /events-poll?sid (/events no longer replays). The stub's
// startup select dialog is replayed; the transient notify is not.
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
let rep = await r.json();
const dialogLine = rep.events.find((l) => l.includes('"method":"select"'));
t("stub's select dialog is replayed (via /events-poll?sid)", !!dialogLine);
const dialog = JSON.parse(dialogLine);
t("notify toasts are NOT replayed", !rep.events.some((l) => l.includes('"method":"notify"')));

// --- prompt forwarding: the LIVE reply is enveloped with the chat's sid + an integer n
const echoWatch = readSse(1600);
await new Promise((res) => setTimeout(res, 400)); // let the SSE stream connect
r = await post("/prompt", { message: "marco" });
t("POST /prompt with CSRF -> 200", r.status === 200);
events = await echoWatch;
const echoFrame = events.find((e) => e.ev && e.ev.type === "message_update" && e.ev.assistantMessageEvent && e.ev.assistantMessageEvent.delta === "polo:marco");
t("prompt reached the stub pi and its reply streamed back (enveloped)", !!echoFrame);
t("the live frame carries the chat's sid and an integer n", !!echoFrame && echoFrame.sid === sid1 && Number.isInteger(echoFrame.n));

// --- ui-response marks the dialog answered (skipped on the next replay) -----------
r = await post("/ui-response", { id: dialog.id, value: dialog.options[0] });
t("POST /ui-response -> 200", r.status === 200);
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
rep = await r.json();
t("answered dialog is not replayed", !rep.events.some((l) => l.includes(dialog.id)));

// --- polling fallback (/events-poll) ----------------------------------------------
r = await fetch(base + "/events-poll?since=0");
t("/events-poll without cookie -> 401", r.status === 401);

r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
t("/events-poll with cookie -> 200", r.status === 200);
let poll = await r.json();
t("poll returns a cursor + cwd", typeof poll.next === "number" && poll.next > 0 && typeof poll.cwd === "string");
t("poll at 0 excludes the answered dialog", !poll.events.some((l) => l.includes(dialog.id)));
t("poll at 0 includes earlier stream events", poll.events.some((l) => l.includes("polo:marco")));

// --- Fix A (docs/web-security-fix-plan.md): answeredUi is bounded, not unbounded ------
// Flood the per-chat dedupe set past its cap (ANSWERED_UI_MAX = 500) with distinct junk
// ids. Eviction is oldest-first, so: (1) the handler survives the flood, (2) the
// earlier-answered real dialog id — the OLDEST entry — is evicted and its card REPLAYS
// again (proving the Set is bounded, not growing forever), and (3) re-answering it is
// still honored (eviction didn't corrupt the Set). Re-answering restores the pre-flood
// state so later tests are unaffected.
let floodOk = true;
for (let i = 0; i < 550; i++) {
  const rr = await post("/ui-response", { id: `flood-${i}` });
  if (rr.status !== 200) floodOk = false;
}
t("flooding /ui-response past the cap stays 200 (handler survives eviction)", floodOk);
rep = await (await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } })).json();
t("answeredUi is bounded — the oldest answered dialog id was evicted, so its card replays again",
  rep.events.some((l) => l.includes(dialog.id)));
await post("/ui-response", { id: dialog.id, value: dialog.options[0] }); // re-answer -> restore state
rep = await (await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } })).json();
t("re-answering after the flood is still honored (eviction didn't corrupt the Set)",
  !rep.events.some((l) => l.includes(dialog.id)));

const cursor = poll.next;
await post("/prompt", { message: "again" });
await new Promise((res) => setTimeout(res, 400));
r = await fetch(base + `/events-poll?since=${cursor}`, { headers: { cookie } });
poll = await r.json();
t("incremental poll returns only new events", poll.events.some((l) => l.includes("polo:again")) && !poll.events.some((l) => l.includes("polo:marco")));

// --- extension-UI breadth (dock methods, replay semantics, fallback) --------------
// The stub's startup emits setStatus/setWidget/setTitle (stateful -> replayed),
// set_editor_text (live-only -> NOT replayed), and holo_display (unknown -> replayed
// until dismissed). Replay now lives on /events-poll?sid. Runs BEFORE the /rpc
// new_session reset, so the startup emissions are still in history.
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
rep = await r.json();
t("stateful setStatus/setWidget/setTitle are replayed",
  rep.events.some((l) => l.includes('"setStatus"')) &&
  rep.events.some((l) => l.includes('"setWidget"')) &&
  rep.events.some((l) => l.includes('"setTitle"')));
t("set_editor_text is NOT replayed (live-only composer prefill)",
  !rep.events.some((l) => l.includes('"set_editor_text"')));
t("an unknown UI method (holo_display) IS replayed until dismissed",
  rep.events.some((l) => l.includes('"holo_display"')));

// Dismiss the unknown-method card via /ui-response {cancelled}; confirm it's no longer
// replayed (answeredUi machinery, unmodified).
r = await post("/ui-response", { id: "stub-mystery-1", cancelled: true });
t("dismiss the unknown-method card -> 200", r.status === 200);
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
rep = await r.json();
t("a dismissed unknown-method card is not replayed", !rep.events.some((l) => l.includes("stub-mystery-1")));

// Poll path shares the replayable() filter: setStatus in; set_editor_text + notify out.
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("/events-poll includes setStatus but excludes set_editor_text and notify",
  poll.events.some((l) => l.includes('"setStatus"')) &&
  !poll.events.some((l) => l.includes('"set_editor_text"')) &&
  !poll.events.some((l) => l.includes('"notify"')));

// Delete-on-absent: "clear-status" makes the stub emit setStatus for "stub" with NO
// statusText (JSON omits undefined) — the SPA keys off the type to clear it. setStatus
// is recorded+replayable, so poll history (robust to SSE-window timing) and find the
// clear frame (the one WITHOUT statusText; the startup frame HAS it).
await post("/prompt", { message: "clear-status" });
await new Promise((res) => setTimeout(res, 500));
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
const clearFrame = poll.events
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .find((e) => e && e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "stub" && !("statusText" in e));
t("setStatus clear arrives with no statusText (delete-on-absent contract)", !!clearFrame);

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

// Capture the pre-reset epoch + the REAL monotonic cursor, to prove the polling
// path learns of the reset (the __hello reset frame is SSE-broadcast-only).
r = await fetch(base + `/events-poll?since=0`, { headers: { cookie } });
const beforeReset = await r.json();

r = await post("/rpc", { type: "new_session" });
state = await r.json();
t("/rpc new_session -> success", state.success === true && state.data.cancelled === false);
r = await fetch(base + `/events-poll?since=0`, { headers: { cookie } });
poll = await r.json();
t("new_session resets the replay history", poll.next === 0 && poll.events.length === 0);

// A poll carrying the pre-reset cursor must see a bumped epoch — the signal a
// polling-fallback client uses to clear its transcript after new_session/chdir/resume.
r = await fetch(base + `/events-poll?since=${beforeReset.next}`, { headers: { cookie } });
const afterReset = await r.json();
t("poll signals the reset via a bumped epoch", typeof afterReset.epoch === "number" && afterReset.epoch !== beforeReset.epoch);

// --- /sessions + /resume ------------------------------------------------------------
r = await fetch(base + "/sessions", { headers: { cookie } });
t("/sessions -> 200", r.status === 200);
let sess = (await r.json()).sessions;
const mine = sess.find((x) => x.file === FAKE_SESSION);
t("lists the prior conversation with name + preview", !!mine && mine.name === "My old chat" && mine.preview.includes("hello from the past"));
const wrapped = sess.find((x) => x.file === WRAP_SESSION);
t("/sessions strips the <coop-viewing-context> wrapper from the preview (issue #6)",
  !!wrapped && wrapped.preview.startsWith("real question here") && !wrapped.preview.includes("coop-viewing-context"));

r = await post("/resume", { file: "../evil.jsonl" });
t("/resume path-jails the filename", r.status === 400);

// Cross-workspace jail: a non-existent workspace, and a real dir whose session dir
// doesn't hold this file — both the uniform 400 (no oracle about which failed).
r = await post("/resume", { file: FAKE_SESSION, workspace: join(ROOT, "no-such-dir-xyz") });
t("/resume rejects a non-existent workspace", r.status === 400);
r = await post("/resume", { file: FAKE_SESSION, workspace: outside });
t("/resume rejects a real workspace with no matching session file", r.status === 400);

// Build up history in the current epoch so the pre-resume cursor is a genuine
// cross-epoch stale cursor (larger than the post-resume total) — pins the clamp.
await post("/prompt", { message: "warmup one" });
await new Promise((res) => setTimeout(res, 350));
await post("/prompt", { message: "warmup two" });
await new Promise((res) => setTimeout(res, 350));
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
const preResume = await r.json();
const preCursor = preResume.next, preEpoch = preResume.epoch;

// File-based backfill: FAKE_SESSION is a full tree -> __replay (thinking, tool
// args+output, final answer) + a branch info line (it has a real second leaf).
r = await post("/resume", { file: FAKE_SESSION });
t("/resume a real conversation -> 200", r.status === 200);
await new Promise((res) => setTimeout(res, 300)); // file backfill is synchronous — a short settle

// STALE-CURSOR POLL (the polling-transport regression guard): a cursor minted before
// the resume exceeds the reset total; without the §2.4 clamp the synchronous __replay
// backfill would be silently skipped (empty transcript after resume on polling).
r = await fetch(base + `/events-poll?since=${preCursor}`, { headers: { cookie } });
let staleP = await r.json();
t("stale pre-resume cursor sees the bumped epoch", typeof staleP.epoch === "number" && staleP.epoch !== preEpoch);
t("stale-cursor poll still delivers the __replay backfill (clamp works)",
  staleP.events.some((l) => l.includes("pondering deeply")) &&
  staleP.events.some((l) => l.includes("tool output payload")) &&
  staleP.events.some((l) => l.includes("rich old answer")) &&
  staleP.events.some((l) => l.includes('"__replay"') && l.includes('"kind":"info"')));
// The since=0 (SSE-replay) view carries the same high-fidelity content.
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("file backfill restores thinking + tool + final answer as __replay",
  poll.events.some((l) => l.includes('"__replay"') && l.includes("rich old answer")) &&
  poll.events.some((l) => l.includes("pondering deeply")));

// Fallback path: FALLBACK_SESSION yields no parseable turns -> get_messages backfill.
r = await post("/resume", { file: FALLBACK_SESSION });
t("/resume FALLBACK_SESSION -> 200", r.status === 200);
await new Promise((res) => setTimeout(res, 900)); // get_messages fallback polls the stub
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("an unparseable file falls back to the get_messages __message backfill",
  poll.events.some((l) => l.includes('"__message"') && l.includes("old question")) &&
  poll.events.some((l) => l.includes("old answer") && l.includes("sql_review")));

// --- /folders (recent working folders from the session store) ---------------------
r = await fetch(base + "/folders", { headers: { cookie } });
t("/folders -> 200", r.status === 200);
let folders = (await r.json()).folders;
t("/folders lists the prior session's cwd (from the header, not the dir name)",
  Array.isArray(folders) && folders.some((f) => f.dir === resolvePath(process.cwd())));

// --- /history (workspaces grouped; current folder marked SERVER-side via samePath) -
r = await fetch(base + "/history", { headers: { cookie } });
t("/history -> 200", r.status === 200);
const hist = await r.json();
t("/history returns a groups array", Array.isArray(hist.groups));
const currentGroups = hist.groups.filter((g) => g.current === true);
t("/history marks exactly one group current", currentGroups.length === 1);
t("the current group holds FAKE_SESSION named 'My old chat'",
  !!currentGroups[0] && currentGroups[0].sessions.some((s) => s.file === FAKE_SESSION && s.name === "My old chat"));
const workGroup = hist.groups.find((g) => g.dir === resolvePath(workDir));
t("a second group is the workDir workspace (current:false, exists:true, has WORK_SESSION)",
  !!workGroup && workGroup.current === false && workGroup.exists === true && workGroup.sessions.some((s) => s.file === WORK_SESSION));
r = await fetch(base + "/history");
t("/history without cookie -> 401", r.status === 401);

// --- cross-workspace resume (switch folder + resume in one click) -----------------
// Run immediately before the /chdir -> workDir block (which re-chdirs to the same
// target, so its fresh-startup assertions still hold).
r = await post("/resume", { file: WORK_SESSION, workspace: workDir });
t("cross-workspace /resume -> 200", r.status === 200);
await new Promise((res) => setTimeout(res, 400));
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("cross-workspace resume switched the working folder", poll.cwd === resolvePath(workDir));
t("cross-workspace resume backfilled the WORK_SESSION transcript",
  poll.events.some((l) => l.includes('"__replay"') && l.includes("work answer")));
t("a strictly linear session is NOT flagged branched (header-as-leaf guard)",
  !poll.events.some((l) => l.includes('"__replay"') && l.includes('"kind":"info"')));

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

// Only meaningful if the symlink was actually created — on a host without symlink
// privilege (Windows w/o Developer Mode) the fetch would test "missing file", not
// "symlink escape", passing for the wrong reason. Skip visibly instead.
if (symlinked) {
  r = await fetch(base + "/file?p=" + encodeURIComponent("escape/secret.txt"), { headers: { cookie } });
  t("/file rejects a symlink that escapes the jail (realpath check)", r.status === 400);
} else {
  console.log("  ~ SKIP /file symlink-escape jail test (symlinks unavailable on this host)");
}

r = await fetch(base + "/file?p=does-not-exist.md", { headers: { cookie } });
t("/file rejects a missing file", r.status === 400);

// Dotfiles the /files listing hides must not be readable via /file either.
r = await fetch(base + "/file?p=.env", { headers: { cookie } });
t("/file refuses a hidden dotfile the listing omits (.env)", r.status === 400);

r = await fetch(base + "/files");
t("/files without cookie -> 401", r.status === 401);

// --- /git/changes + /git/diff (read-only Changes panel, jailed to the folder) ----
// git availability gates the whole block (visible SKIP), like the symlink test above.
const hasGit = (() => { try { return spawnSync("git", ["--version"]).status === 0; } catch { return false; } })();
if (!hasGit) {
  console.log("  ~ SKIP git diff endpoint tests (git not installed)");
} else {
  // Non-repo: the current workDir (a bare mkdtemp) has no .git.
  r = await fetch(base + "/git/changes", { headers: { cookie } });
  let gc = await r.json();
  t("/git/changes in a non-repo folder -> repo:false", gc.ok === true && gc.git === true && gc.repo === false);

  // Fixture repo: one commit, then modify a.txt, delete b.txt, add untracked new.txt.
  const gitDir = mkdtempSync(join(osTmp(), "coop-web-git-"));
  const git = (args) => spawnSync("git", args, { cwd: gitDir, encoding: "utf8" });
  git(["init", "-q"]);
  writeFileSync(join(gitDir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(gitDir, "b.txt"), "bee\n");
  mkdirSync(join(gitDir, "keep"));
  writeFileSync(join(gitDir, "keep", "c.txt"), "cee\n");
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]);
  writeFileSync(join(gitDir, "a.txt"), "one\nTWO!\n");
  rmSync(join(gitDir, "b.txt"));
  writeFileSync(join(gitDir, "new.txt"), "new file\n");
  r = await post("/chdir", { dir: gitDir });
  t("/chdir into the fixture repo -> 200", r.status === 200);
  await new Promise((res) => setTimeout(res, 600));

  r = await fetch(base + "/git/changes", { headers: { cookie } });
  gc = await r.json();
  const byPath = Object.fromEntries((gc.files || []).map((f) => [f.path, f]));
  t("/git/changes reports repo:true against base HEAD", gc.ok === true && gc.repo === true && gc.base === "HEAD");
  t("/git/changes flags the modified file (M)", !!byPath["a.txt"] && byPath["a.txt"].status === "M");
  t("/git/changes flags the deleted file (D)", !!byPath["b.txt"] && byPath["b.txt"].status === "D");
  t("/git/changes flags the untracked file (A, untracked)", !!byPath["new.txt"] && byPath["new.txt"].status === "A" && byPath["new.txt"].untracked === true);
  const gPaths = (gc.files || []).map((f) => f.path);
  t("/git/changes sorts files alphabetically", gPaths.join("\n") === [...gPaths].sort((a, b) => a.localeCompare(b)).join("\n"));

  // Base ref resolution + rejection (bad + unresolvable share ONE shape — no oracle).
  r = await fetch(base + "/git/changes?base=HEAD", { headers: { cookie } });
  t("/git/changes?base=HEAD -> ok", (await r.json()).ok === true);
  r = await fetch(base + "/git/changes?base=--evil", { headers: { cookie } });
  t("/git/changes rejects an option-injection base ref", (await r.json()).ok === false);
  r = await fetch(base + "/git/changes?base=nope-such-ref", { headers: { cookie } });
  t("/git/changes rejects an unresolvable base ref (same shape)", (await r.json()).ok === false);

  // Unified diff for one file + the path jail (400 on jail failure, uniform message).
  r = await fetch(base + "/git/diff?p=a.txt", { headers: { cookie } });
  let gd = await r.json();
  t("/git/diff returns the file's unified diff", gd.ok === true && gd.diff.includes("@@") && gd.diff.includes("-two") && gd.diff.includes("+TWO!"));
  r = await fetch(base + "/git/diff?p=b.txt", { headers: { cookie } });
  gd = await r.json();
  t("/git/diff shows a deletion diff", gd.ok === true && gd.diff.includes("-bee"));
  for (const bad of ["../", "", ".git/config"]) {
    r = await fetch(base + "/git/diff?p=" + encodeURIComponent(bad), { headers: { cookie } });
    t(`/git/diff jails p=${JSON.stringify(bad)} -> 400`, r.status === 400);
  }

  // No-HEAD repo: a fresh init with one file -> noHead, everything reported untracked.
  const bareDir = mkdtempSync(join(osTmp(), "coop-web-git0-"));
  spawnSync("git", ["init", "-q"], { cwd: bareDir });
  writeFileSync(join(bareDir, "first.txt"), "hello\n");
  await post("/chdir", { dir: bareDir });
  await new Promise((res) => setTimeout(res, 600));
  r = await fetch(base + "/git/changes", { headers: { cookie } });
  gc = await r.json();
  t("/git/changes in a no-HEAD repo -> noHead:true, file reported untracked",
    gc.ok === true && gc.noHead === true && (gc.files || []).some((f) => f.path === "first.txt" && f.untracked === true));

  // Restore cwd to workDir so later tests keep their earlier assumptions.
  await post("/chdir", { dir: target });
  await new Promise((res) => setTimeout(res, 600));

  // git-missing: a SECOND bridge with an empty PATH -> spawn("git") ENOENT -> git:false.
  // (spec.bin is the absolute process.execPath, so the stub pi still starts.) Its port
  // is FAR outside the main bridge's random range (PORT is 7460–7859) so it can never
  // collide with a main bridge from this or a back-to-back run; explicit --port means
  // it fails fast rather than walking.
  const emptyPath = mkdtempSync(join(osTmp(), "coop-web-nopath-"));
  const PORT2 = PORT + 500;
  const server2 = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--port", String(PORT2)], {
    env: { ...process.env, PATH: emptyPath, COOP_LAUNCH_SPEC: spec, COOP_WEB_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err2 = "";
  server2.stderr.on("data", (d) => (err2 += d));
  const url2 = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(""), 8000);
    const poll = setInterval(() => {
      const m = err2.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);
      if (m) { clearTimeout(timer); clearInterval(poll); resolve(m[0]); }
    }, 100);
  });
  if (url2) {
    const r2 = await fetch(url2);
    const ck2 = (r2.headers.get("set-cookie") || "").split(";")[0];
    const gr = await fetch(`http://127.0.0.1:${PORT2}/git/changes`, { headers: { cookie: ck2 } });
    t("/git/changes with git absent -> git:false", (await gr.json()).git === false);
  } else {
    t("second bridge (git-missing) started", false);
  }
  // Wait for the second bridge to exit (release its port) before continuing.
  await new Promise((resolve) => {
    const done = setTimeout(resolve, 1500);
    server2.on("exit", () => { clearTimeout(done); resolve(); });
    try { server2.kill(); } catch { resolve(); }
  });

  r = await fetch(base + "/git/changes");
  t("/git/changes without cookie -> 401", r.status === 401);
}

// --- protocol drift detection (observe-only) + JSONL framer at the wire ---------
// The stub's `emit:<raw line>` hatch injects an arbitrary line straight through the
// real stdout pipe (no agent_start), so we can provoke unknown / shape-mismatched
// events and watch the bridge (a) still forward them verbatim — the dumb pipe — and
// (b) emit a one-time __drift toast (broadcast-only) + a stderr line. __drift is not
// recorded, so the SSE stream must be OPEN when the emit lands: start readSse, fire
// the emit mid-window, then await it.
async function emitAndWatch(raw, ms = 1800) {
  const p = readSse(ms);
  await new Promise((res) => setTimeout(res, 400)); // let the SSE stream connect
  await post("/prompt", { message: "emit:" + raw });
  return p;
}

// Live SSE frames are now enveloped as {sid, n?, ev}; the raw pi event is `ev`.
// 1. Unknown event: forwarded verbatim AND a __drift(kind:unknown) frame + stderr.
let driftEvents = await emitAndWatch('{"type":"totally_new_event","x":1}');
t("unknown event is still forwarded verbatim (dumb pipe intact)",
  driftEvents.some((e) => e.ev && e.ev.type === "totally_new_event" && e.ev.x === 1));
const drift1 = driftEvents.find((e) => e.ev && e.ev.type === "__drift" && e.ev.eventType === "totally_new_event");
t("unknown event triggers a __drift toast (kind:unknown)", !!drift1 && drift1.ev.kind === "unknown");
t("drift is logged to stderr (the authoritative record)", /protocol drift/.test(serverErr));

// 2. The same unknown type again: no NEW __drift, and exactly one stderr line (dedupe).
driftEvents = await emitAndWatch('{"type":"totally_new_event","x":2}');
t("a repeat of the same unknown type is deduped (no new __drift frame)",
  !driftEvents.some((e) => e.ev && e.ev.type === "__drift" && e.ev.eventType === "totally_new_event"));
t("repeat is still forwarded verbatim (dumb pipe unaffected by dedupe)",
  driftEvents.some((e) => e.ev && e.ev.type === "totally_new_event" && e.ev.x === 2));
t("dedupe: exactly one 'totally_new_event' drift line in stderr",
  (serverErr.match(/protocol drift.*totally_new_event/g) || []).length === 1);

// 3. Shape-mismatched event: __drift(kind:mismatch) naming the missing field.
driftEvents = await emitAndWatch('{"type":"tool_execution_end"}');
const drift3 = driftEvents.find((e) => e.ev && e.ev.type === "__drift" && e.ev.eventType === "tool_execution_end");
t("shape-mismatched event triggers a __drift (kind:mismatch, toolCallId problem)",
  !!drift3 && drift3.ev.kind === "mismatch" && drift3.ev.problems.some((p) => /toolCallId/.test(p)));

// 4. Known-ignored event: forwarded, but NOT drift-flagged (no false positive).
driftEvents = await emitAndWatch('{"type":"queue_update","steering":[],"followUp":[]}');
t("known-ignored event is forwarded but NOT drift-flagged",
  driftEvents.some((e) => e.ev && e.ev.type === "queue_update") &&
  !driftEvents.some((e) => e.ev && e.ev.type === "__drift" && e.ev.eventType === "queue_update"));

// 5. A literal U+2028 inside a text_delta must round-trip byte-identical through the
//    framer and /events-poll (integration-level regression guard for the "NEVER
//    readline" rule). Template literal → guarantees a literal U+2028 in the line.
const U2028 = String.fromCharCode(0x2028); // LINE SEPARATOR — must never split a JSONL line
const u2028Line = `{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"sep${U2028}test"}}`;
await post("/prompt", { message: "emit:" + u2028Line });
await new Promise((res) => setTimeout(res, 400));
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
const sepLine = poll.events.find((l) => l.includes('"text_delta"') && l.includes("sep") && l.includes("test"));
let sepParsed = null;
try { sepParsed = JSON.parse(sepLine); } catch { /* leave null */ }
t("U+2028 in a delta round-trips byte-identical through the framer + /events-poll",
  !!sepParsed && sepParsed.assistantMessageEvent.delta === `sep${U2028}test`);

// 6. /rpc get_state still round-trips and stays unrecorded (guards the RPC_ALLOWED
//    move into protocol.mjs).
r = await post("/rpc", { type: "get_state" });
state = await r.json();
t("/rpc get_state still round-trips after the RPC_ALLOWED move", state.success === true && state.data.model.id === "stub-1");
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("/rpc get_state stays unrecorded after the move", !poll.events.some((l) => l.includes('"command":"get_state"')));

// 6b. A bare JSON `null` line is valid JSON but not an event object — it must be
//     dropped as noise (only parsed JSON OBJECTS are validated), never crash the
//     bridge. Regression guard for the uncaughtException-on-null defect; it must
//     also add ZERO drift lines (non-objects are not validated).
await post("/prompt", { message: "emit:null" });
await new Promise((res) => setTimeout(res, 300));
r = await post("/prompt", { message: "still-alive" });
t("a bare JSON null line does not crash the bridge (emit:null)", r.status === 200);
await new Promise((res) => setTimeout(res, 400));
r = await fetch(base + "/events-poll?since=0", { headers: { cookie } });
poll = await r.json();
t("bridge still streams after a null line", poll.events.some((l) => l.includes("polo:still-alive")));

// 7. Final drift-count assertion. Every `protocol drift` line in the whole run must
//    be one of exactly three EXPECTED shapes: the emit-provoked unknown
//    (totally_new_event) ×1, the emit-provoked mismatch (tool_execution_end) ×1, and
//    the stub's `holo_display` unknown-UI-method (one per stub child — driftSeen is
//    cleared on each respawn, so its exact count tracks the suite's chdir/resume
//    spawns; we assert it appears but not an exact count, keeping the check robust to
//    added state-changing tests). Nothing OUTSIDE these three may drift — that is the
//    "standard stub conversation adds zero UNEXPECTED drift" contract, and it is what
//    would have caught the toolcall_* omission. (serverErr also legitimately carries
//    the banner, access-log lines, "resuming session …", and stub stderr — ignored.)
const driftLines = serverErr.match(/coop web: protocol drift[^\n]*/g) || [];
const provokedUnknown = driftLines.filter((l) => /totally_new_event/.test(l));
const provokedMismatch = driftLines.filter((l) => /tool_execution_end/.test(l));
const holoDrift = driftLines.filter((l) => /holo_display|extension_ui_request/.test(l));
const unexpectedDrift = driftLines.filter((l) =>
  !/totally_new_event/.test(l) && !/tool_execution_end/.test(l) && !/holo_display|extension_ui_request/.test(l));
t("drift: the emit-provoked unknown fires exactly once (deduped)", provokedUnknown.length === 1);
t("drift: the emit-provoked mismatch fires exactly once", provokedMismatch.length === 1);
t("drift: the stub's unknown UI method (holo_display) is flagged (>=1 per spawn)", holoDrift.length >= 1);
t("drift: NOTHING outside the three expected shapes ever drifts (contract holds)", unexpectedDrift.length === 0);

// --- M5 multi-session: isolation, per-chat state, cap, crash containment ----------
// (Appended last so the whole base suite above ran with ONE chat — its un-sid'd
// /events-poll calls used the single-chat fallback, and chat 2's holo_display drift
// lands AFTER the drift-count assertion.)

// 1. CSRF is required on /chat-new; then open chat 2.
r = await fetch(base + "/chat-new", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
t("POST /chat-new without CSRF -> 403", r.status === 403);

// 2. Open chat 2 and observe the SSE __chats frame naming both chats.
const chatsWatch = readSse(1600);
await new Promise((res) => setTimeout(res, 400));
r = await post("/chat-new", {});
const d2 = await r.json();
const sid2 = d2.sid;
t("POST /chat-new -> 200 with a fresh sid", r.status === 200 && typeof sid2 === "string" && sid2 !== sid1);
t("/chat-new defaults to the startup cwd", d2.cwd === resolvePath(process.cwd()));
events = await chatsWatch;
const chatsFrame = events.find((e) => e.ev && e.ev.type === "__chats");
t("an SSE __chats frame lists both chats",
  !!chatsFrame && chatsFrame.ev.chats.some((c) => c.sid === sid1) && chatsFrame.ev.chats.some((c) => c.sid === sid2));

// 3. Isolation: a prompt to one chat never appears in the other's stream.
await post("/prompt", { sid: sid1, message: "one" });
await post("/prompt", { sid: sid2, message: "two" });
await new Promise((res) => setTimeout(res, 700));
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
const p1 = await r.json();
r = await fetch(base + `/events-poll?sid=${sid2}&since=0`, { headers: { cookie } });
const p2 = await r.json();
t("chat 1's stream has its own reply and NOT chat 2's",
  p1.events.some((l) => l.includes("polo:one")) && !p1.events.some((l) => l.includes("polo:two")));
t("chat 2's stream has its own reply and NOT chat 1's",
  p2.events.some((l) => l.includes("polo:two")) && !p2.events.some((l) => l.includes("polo:one")));

// 4. Per-chat cwd + jail: put the two chats in DIFFERENT folders.
await post("/chdir", { sid: sid1, dir: resolvePath(process.cwd()) });
await new Promise((res) => setTimeout(res, 500));
r = await post("/chdir", { sid: sid2, dir: resolvePath(workDir) });
t("/chdir {sid:sid2} -> 200", r.status === 200);
await new Promise((res) => setTimeout(res, 600));
r = await fetch(base + `/events-poll?sid=${sid2}&since=0`, { headers: { cookie } });
const p2b = await r.json();
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
const p1b = await r.json();
t("each chat has its own cwd (sid2=workDir, sid1=cwd, and they differ)",
  p2b.cwd === resolvePath(workDir) && p1b.cwd === resolvePath(process.cwd()) && p1b.cwd !== p2b.cwd);
r = await fetch(base + `/files?sid=${sid2}`, { headers: { cookie } });
const files2 = await r.json();
t("/files?sid=sid2 lists workDir's files", (files2.tree || []).some((n) => n.name === "notes.md"));
r = await fetch(base + `/file?sid=${sid2}&p=.env`, { headers: { cookie } });
t("/file?sid=sid2&p=.env stays jailed per chat -> 400", r.status === 400);

// 5. Ambiguity + unknown sid (with the chats-bearing 400 body for polling recovery).
r = await post("/prompt", { message: "x" }); // no sid, 2 chats -> ambiguous
t("a no-sid POST with 2 chats open -> 400", r.status === 400);
r = await fetch(base + "/events-poll?sid=zzz&since=0", { headers: { cookie } });
t("/events-poll?sid=zzz -> 400", r.status === 400);
const zbody = await r.json();
t("the stale-sid 400 body carries the chats list (polling recovery)", Array.isArray(zbody.chats) && zbody.chats.length >= 2);

// 6. Cap (MAX_CHATS=3): open the 3rd; the 4th is refused; close the 3rd.
r = await post("/chat-new", {});
const d3 = await r.json();
const sid3 = d3.sid;
t("/chat-new opens the 3rd chat (registry at the cap)", r.status === 200 && typeof sid3 === "string");
r = await post("/chat-new", {});
t("a 4th /chat-new is refused with the friendly cap message", r.status === 400);
// Closing a FRESH, still-running chat must NOT record a spurious __fatal crash card
// (the generation check must be armed before the kill). Watch SSE across the close.
const closeWatch = readSse(1500);
await new Promise((res) => setTimeout(res, 300));
r = await post("/chat-close", { sid: sid3 });
t("/chat-close sid3 -> 200", r.status === 200);
events = await closeWatch;
t("closing a live chat emits NO spurious __fatal for it", !events.some((e) => e.sid === sid3 && e.ev && e.ev.type === "__fatal"));

// 7. Crash containment: crash chat 2; the bridge stays up; chat 1 still answers.
await post("/prompt", { sid: sid2, message: "__crash__" });
await new Promise((res) => setTimeout(res, 500));
t("the bridge process is still alive after a chat crash", server.exitCode === null);
r = await fetch(base + `/events-poll?sid=${sid2}&since=0`, { headers: { cookie } });
const pcrash = await r.json();
t("chat 2 reports status:exited + a recorded __fatal(code 3)",
  pcrash.status === "exited" && pcrash.events.some((l) => l.includes('"__fatal"') && l.includes('"code":3')));
await post("/prompt", { sid: sid1, message: "still-alive" });
await new Promise((res) => setTimeout(res, 400));
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
const p1c = await r.json();
t("chat 1 still answers after chat 2 crashed", p1c.events.some((l) => l.includes("polo:still-alive")));

// 8. Close targets the EXPLICIT sid — the close-the-wrong-chat regression guard.
r = await post("/chat-close", { sid: sid2 });
t("/chat-close sid2 -> 200", r.status === 200);
r = await fetch(base + `/events-poll?sid=${sid2}&since=0`, { headers: { cookie } });
t("polling the closed sid2 -> 400", r.status === 400);
await post("/prompt", { sid: sid1, message: "after-close" });
await new Promise((res) => setTimeout(res, 400));
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
const p1d = await r.json();
t("chat 1 still answers after chat 2 was closed (explicit-sid close guard)", p1d.events.some((l) => l.includes("polo:after-close")));

// 9. RPC scoping: new_session resets ONLY chat 1's history.
r = await post("/rpc", { sid: sid1, type: "new_session" });
const ns = await r.json();
t("/rpc new_session {sid:sid1} -> success", ns.success === true);
r = await fetch(base + `/events-poll?sid=${sid1}&since=0`, { headers: { cookie } });
const p1e = await r.json();
t("chat 1's history reset to 0 by its own new_session", p1e.next === 0);

// --- issue #10: DEFAULT_CWD is normalized (trailing separator / relative --cwd) -------
// A second, short-lived bridge started with a TRAILING-SEPARATOR --cwd must resolve the
// chat cwd to the canonical (separator-stripped) path, and /history must then mark that
// folder's group current — proving the whole cwd-compare chain uses one canonical form.
{
  const PORT2 = PORT + 1;
  const spec2 = JSON.stringify({ bin: process.execPath, args: [join(HERE, "stub-pi.mjs")], env: { PI_CODING_AGENT_DIR: agentDir } });
  const srv2 = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--port", String(PORT2), "--cwd", workDir + "/"], {
    env: { ...process.env, COOP_LAUNCH_SPEC: spec2, COOP_WEB_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err2 = "";
  srv2.stderr.on("data", (d) => (err2 += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge2 didn't start in 10s")), 10000);
    const poll = setInterval(() => {
      if (/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/.test(err2)) { clearTimeout(timer); clearInterval(poll); resolve(); }
    }, 100);
  }).catch((e) => die("bridge2: " + e.message + "\n" + err2));
  const base2 = `http://127.0.0.1:${PORT2}`;
  const url2 = err2.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/)[0];
  const cookie2 = ((await fetch(url2)).headers.get("set-cookie") || "").split(";")[0];
  // Read the __hello frame off SSE.
  const hello2 = await (async () => {
    const ctrl = new AbortController();
    const resp = await fetch(base2 + "/events", { headers: { cookie: cookie2 }, signal: ctrl.signal });
    const reader = resp.body.getReader();
    let buf = "";
    const until = Date.now() + 2000;
    while (Date.now() < until && !buf.includes("__hello")) {
      const race = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res(null), 100))]);
      if (!race || race.done) break;
      buf += Buffer.from(race.value).toString("utf8");
    }
    ctrl.abort();
    return buf.split("\n\n").map((f) => f.replace(/^data: /, "").trim()).filter(Boolean)
      .map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean)
      .find((e) => e.ev && e.ev.type === "__hello");
  })();
  t("trailing-separator --cwd normalizes the chat cwd to resolvePath(workDir)",
    !!hello2 && hello2.ev.chats[0].cwd === resolvePath(workDir));
  const h2 = await (await fetch(base2 + `/history?sid=${hello2.ev.chats[0].sid}`, { headers: { cookie: cookie2 } })).json();
  const cur2 = (h2.groups || []).find((g) => g.current);
  t("trailing-separator --cwd: /history marks the resolved folder current",
    !!cur2 && cur2.dir === resolvePath(workDir));
  await new Promise((resolve) => { const done = setTimeout(resolve, 2000); srv2.on("exit", () => { clearTimeout(done); resolve(); }); srv2.kill(); });
}

// --- issue #11: per-command /rpc timeout (compact gets a longer ceiling) --------------
// (a) On the default-timeout main bridge, a promptly-answered compact returns 200.
r = await post("/rpc", { sid: sid1, type: "compact" });
t("compact returns 200 on the default path (prompt answer)", r.status === 200);
{
  const cd = await r.json();
  t("compact 200 carries the summary data", !!cd && cd.success === true && cd.data && cd.data.tokensBefore === 50000);
}
// (b) A bridge with COOP_WEB_RPC_TIMEOUT_COMPACT=500 against a stub that delays compact
//     ~2 s returns 504 (the timeout path); a NON-compact command is unaffected, proving
//     the timeout is per-command, not a blanket change.
{
  const PORT3 = PORT + 2;
  const spec3 = JSON.stringify({ bin: process.execPath, args: [join(HERE, "stub-pi.mjs")], env: { PI_CODING_AGENT_DIR: agentDir } });
  const srv3 = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--port", String(PORT3)], {
    env: { ...process.env, COOP_LAUNCH_SPEC: spec3, COOP_WEB_NO_OPEN: "1", COOP_WEB_RPC_TIMEOUT_COMPACT: "500", COOP_STUB_COMPACT_DELAY_MS: "2000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err3 = "";
  srv3.stderr.on("data", (d) => (err3 += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge3 didn't start in 10s")), 10000);
    const poll = setInterval(() => { if (/\/\?token=[a-f0-9]+/.test(err3)) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 100);
  }).catch((e) => die("bridge3: " + e.message + "\n" + err3));
  const base3 = `http://127.0.0.1:${PORT3}`;
  const url3 = err3.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/)[0];
  const cookie3 = ((await fetch(url3)).headers.get("set-cookie") || "").split(";")[0];
  const rpc3 = (type) => fetch(base3 + "/rpc", { method: "POST", headers: { cookie: cookie3, "content-type": "application/json", "x-coop-csrf": "1" }, body: JSON.stringify({ type }) });
  t("compact times out -> 504 when COOP_WEB_RPC_TIMEOUT_COMPACT is short and pi is slow", (await rpc3("compact")).status === 504);
  t("a non-compact command is unaffected by the compact timeout override (200)", (await rpc3("get_state")).status === 200);
  await new Promise((resolve) => { const done = setTimeout(resolve, 2000); srv3.on("exit", () => { clearTimeout(done); resolve(); }); srv3.kill(); });
}

// Wait for the bridge to actually exit (release its port) before we exit, so a
// back-to-back run can't collide with a lingering listener.
await new Promise((resolve) => {
  const done = setTimeout(resolve, 2000);
  server.on("exit", () => { clearTimeout(done); resolve(); });
  server.kill();
});
console.log(`  ${n} web-bridge tests passed`);
process.exit(0);
