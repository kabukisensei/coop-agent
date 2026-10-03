// Behavioral tests for extensions/coop-mobile (master plan M1). Gate lane: no
// network, no timers beyond a few milliseconds, a temp home. Graph and Entra are
// replaced with a fake fetch; the extension's pure helpers are tested directly and
// the whole extension is driven through the real ExtensionAPI contract (a factory
// that receives `pi` and registers commands and handlers).
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = mkdtempSync(path.join(tmpdir(), "coop-mobile-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.COOP_DIR;
const dist = process.env.COOP_TEST_DIST || "/tmp/coop-test-dist";
const modPath = path.join(dist, "coop-mobile.mjs");
assert.ok(existsSync(modPath), `bundle missing: ${modPath}`);
const mod = await import(pathToFileURL(modPath).href);

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// --- Pure helpers ------------------------------------------------------------------

await check("stripHtml: Teams HTML bodies become the visible text", () => {
  assert.equal(mod.stripHtml("<p>yes</p>"), "yes");
  assert.equal(mod.stripHtml("<div><p>line 1</p><p>line&nbsp;2 &amp; <b>3</b></p></div>"), "line 1\nline 2 & 3");
  assert.equal(mod.stripHtml("<p>&lt;script&gt;</p>"), "<script>");
});

await check("parseAnswer: confirm accepts only explicit yes/no forms", () => {
  const d = { kind: "confirm", title: "Write report.sql?" };
  for (const yes of ["1", "yes", "Y", "approve", "Allow", "ok."]) assert.deepEqual(mod.parseAnswer(d, yes), { ok: true, value: true }, yes);
  for (const no of ["2", "no", "n", "decline", "cancel"]) assert.deepEqual(mod.parseAnswer(d, no), { ok: true, value: false }, no);
  for (const bad of ["", "sure", "yes please do it", "3", "maybe"]) assert.equal(mod.parseAnswer(d, bad).ok, false, bad);
});

await check("parseAnswer: select takes a number or the exact option, never a guess", () => {
  const d = { kind: "select", title: "Edit?", options: ["Allow once", "Allow for this session", "Decline"] };
  assert.deepEqual(mod.parseAnswer(d, "2"), { ok: true, value: "Allow for this session" });
  assert.deepEqual(mod.parseAnswer(d, "decline"), { ok: true, value: "Decline" });
  assert.deepEqual(mod.parseAnswer(d, "cancel"), { ok: true, value: undefined });
  assert.equal(mod.parseAnswer(d, "0").ok, false);
  assert.equal(mod.parseAnswer(d, "4").ok, false);
  assert.equal(mod.parseAnswer(d, "allow").ok, false, "a prefix of two options is ambiguous");
  assert.equal(mod.parseAnswer(d, "yes").ok, false, "yes is not an option of a select");
});

await check("parseAnswer: input takes the text, cancel cancels", () => {
  const d = { kind: "input", title: "Name?" };
  assert.deepEqual(mod.parseAnswer(d, "  Tidy report  "), { ok: true, value: "Tidy report" });
  assert.deepEqual(mod.parseAnswer(d, "cancel"), { ok: true, value: undefined });
});

await check("buildDialogMessage: numbered, with the reply instruction", () => {
  const text = mod.buildDialogMessage({ kind: "select", title: "coop guardrails", options: ["Allow once", "Decline"] });
  assert.match(text, /coop needs an answer: coop guardrails/);
  assert.match(text, /1\. Allow once\n2\. Decline/);
  assert.match(text, /Reply with the number/);
  assert.match(mod.buildDialogMessage({ kind: "confirm", title: "Commit?", message: "3 files" }), /3 files\n\nReply 1 \(yes\) or 2 \(no\)\./);
});

await check("filterIncoming: only the pinned user, after the start, not our own posts, oldest first", () => {
  const since = "2026-10-03T09:00:00.000Z";
  const msgs = [
    { id: "late", createdDateTime: "2026-10-03T09:00:05.000Z", from: { user: { id: "me" } }, body: { content: "second" } },
    { id: "own", createdDateTime: "2026-10-03T09:00:04.000Z", from: { user: { id: "me" } }, body: { content: "coop posted this" } },
    { id: "other", createdDateTime: "2026-10-03T09:00:03.000Z", from: { user: { id: "someone-else" } }, body: { content: "yes" } },
    { id: "app", createdDateTime: "2026-10-03T09:00:03.500Z", from: { application: { id: "bot" }, user: null }, body: { content: "yes" } },
    { id: "sys", createdDateTime: "2026-10-03T09:00:03.700Z", messageType: "systemEventMessage", from: { user: { id: "me" } }, body: { content: "yes" } },
    { id: "early", createdDateTime: "2026-10-03T09:00:02.000Z", from: { user: { id: "me" } }, body: { content: "first" } },
    { id: "old", createdDateTime: "2026-10-03T08:59:59.000Z", from: { user: { id: "me" } }, body: { content: "before mobile on" } },
    { id: "seen", createdDateTime: "2026-10-03T09:00:01.000Z", from: { user: { id: "me" } }, body: { content: "already handled" } },
    { id: "own-unrecorded", createdDateTime: "2026-10-03T09:00:04.500Z", from: { user: { id: "me" } }, body: { contentType: "html", content: "<p>coop needs an answer: x</p>" } },
  ];
  const picked = mod.filterIncoming(msgs, { userId: "me", since, ownIds: new Set(["own"]), ownTexts: new Set(["coop needs an answer: x"]), seen: new Set(["seen"]) });
  assert.deepEqual(picked.map((m) => m.id), ["early", "late"]);
});

await check("redactSecrets: tokens, keys and key=value credentials never reach Teams", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.equal(mod.redactSecrets(`Authorization: Bearer ${jwt}`), "Authorization: Bearer [jwt redacted]");
  assert.equal(mod.redactSecrets("Server=x;Password=Sup3r$ecret1;Database=y"), "Server=x;Password=[redacted];Database=y");
  assert.equal(mod.redactSecrets("AccountKey=abc123def456==;EndpointSuffix=core"), "AccountKey=[redacted];EndpointSuffix=core");
  assert.equal(mod.redactSecrets("https://x.blob.core.windows.net/c?sv=2024-01-01&sig=AbCdEf123456%2B"), "https://x.blob.core.windows.net/c?sv=[redacted]&sig=[redacted]");
  assert.equal(mod.redactSecrets("found ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "found [token redacted]");
  assert.equal(mod.redactSecrets("Tidy report.sql and commit"), "Tidy report.sql and commit", "ordinary text is untouched");
  assert.equal(mod.redactSecrets("the password field is required"), "the password field is required", "prose about passwords is untouched");
});

await check("truncateForPost: long replies are cut with a note", () => {
  const long = "x".repeat(mod.MAX_POST_CHARS + 100);
  const cut = mod.truncateForPost(long);
  assert.ok(cut.length <= mod.MAX_POST_CHARS);
  assert.match(cut, /truncated/);
  assert.equal(mod.truncateForPost("short"), "short");
});

// --- The dialog race -----------------------------------------------------------

const dialogWithSignal = (resolveWith, onAbort) => (signal) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => { onAbort?.(); resolve(resolveWith.abortedValue); }, { once: true });
    if (resolveWith.answer !== undefined) setTimeout(() => resolve(resolveWith.answer), resolveWith.after ?? 5);
  });

await check("raceDialog: the phone's answer wins and the terminal dialog is aborted", async () => {
  let terminalAborted = false;
  const local = dialogWithSignal({ abortedValue: false }, () => { terminalAborted = true; });
  const remote = (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ answered: false }), { once: true });
    setTimeout(() => resolve({ answered: true, value: true }), 5);
  });
  const r = await mod.raceDialog(local, remote);
  assert.deepEqual(r, { source: "remote", value: true });
  assert.ok(terminalAborted, "the terminal dialog was closed through its signal");
});

await check("raceDialog: the terminal's answer wins and the phone request is aborted", async () => {
  let phoneAborted = false;
  const local = dialogWithSignal({ abortedValue: undefined, answer: "Decline", after: 5 });
  const remote = (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { phoneAborted = true; resolve({ answered: false }); }, { once: true });
  });
  const r = await mod.raceDialog(local, remote);
  assert.deepEqual(r, { source: "local", value: "Decline" });
  assert.ok(phoneAborted);
});

await check("raceDialog: a dialog timeout (local default) is the answer when the phone stays silent", async () => {
  const local = dialogWithSignal({ abortedValue: false, answer: false, after: 5 });
  const remote = (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ answered: false }), { once: true }));
  const r = await mod.raceDialog(local, remote);
  assert.deepEqual(r, { source: "local", value: false });
});

await check("raceDialog: the caller's own signal aborts both", async () => {
  const outer = new AbortController();
  const local = dialogWithSignal({ abortedValue: false });
  const remote = (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ answered: false }), { once: true }));
  const p = mod.raceDialog(local, remote, outer.signal);
  outer.abort();
  assert.deepEqual(await p, { source: "local", value: false });
});

// --- Config and token store ----------------------------------------------------------

await check("config: missing, malformed and invalid files mean 'not set up'", () => {
  assert.equal(mod.loadConfig(), null);
  mod.saveConfig({ schema_version: 1, tenant_id: "contoso.onmicrosoft.com", client_id: "not-a-guid", chat_id: "", auto_on: true, poll_ms: 10 });
  assert.equal(mod.loadConfig(), null, "client id must be a GUID");
});

await check("config: a valid file round-trips with defaults applied", () => {
  mod.saveConfig({ schema_version: 1, tenant_id: "contoso.onmicrosoft.com", client_id: "11111111-2222-3333-4444-555555555555", chat_id: "", auto_on: "yes", poll_ms: 10 });
  const c = mod.loadConfig();
  assert.equal(c.chat_id, mod.DEFAULT_CHAT_ID);
  assert.equal(c.auto_on, false, "auto_on is only ever boolean true");
  assert.equal(c.poll_ms, 3000, "too-fast polling falls back to the default");
  assert.equal(mod.configPath(), path.join(home, ".coop", "mobile.json"));
});

await check("token store: the refresh token never sits in the file unprotected on Windows paths; file mode elsewhere", () => {
  const record = mod.saveAuth({ schema_version: 1, tenant_id: "t", client_id: "11111111-2222-3333-4444-555555555555", user_id: "me", upn: "aaron@example.com", refresh_token: "secret-rt", signed_in_at: "now" }, process.env, "linux");
  assert.equal(record.protection, "file");
  if (process.platform !== "win32") assert.equal(statSync(mod.authPath()).mode & 0o777, 0o600);
  const loaded = mod.loadAuth();
  assert.equal(loaded.user_id, "me");
  assert.equal(mod.unprotectSecret(loaded.refresh_token, loaded.protection, "linux"), "secret-rt");
  assert.throws(() => mod.unprotectSecret("AAAA", "dpapi", "linux"), /DPAPI/);
  assert.ok(mod.clearAuth());
  assert.equal(mod.loadAuth(), null);
  assert.equal(mod.clearAuth(), false);
});

// --- Entra and Graph through a fake fetch ----------------------------------------------

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

await check("device code flow: pending, slow_down, then tokens", async () => {
  const calls = [];
  let n = 0;
  const f = async (url, init) => {
    calls.push([url, init?.body]);
    if (url.endsWith("/devicecode")) return jsonResponse(200, { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", interval: 0, expires_in: 60, message: "go" });
    n++;
    if (n === 1) return jsonResponse(400, { error: "authorization_pending" });
    if (n === 2) return jsonResponse(400, { error: "slow_down" });
    return jsonResponse(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
  };
  const config = { tenant_id: "contoso.onmicrosoft.com", client_id: "11111111-2222-3333-4444-555555555555" };
  const code = await mod.requestDeviceCode(config, f);
  assert.equal(code.user_code, "ABCD-EFGH");
  assert.match(calls[0][1], /scope=https%3A%2F%2Fgraph\.microsoft\.com%2FChat\.ReadWrite/);
  assert.ok(!/Chat\.Read\.All|ChatMessage\.Send|Mail/.test(calls[0][1]), "scopes stay minimal");
  // slow_down adds 5 s by the spec; keep the test fast by stubbing the timer.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 1);
  try {
    const token = await mod.pollDeviceToken(config, code, f);
    assert.equal(token.refresh_token, "rt");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

await check("GraphClient: a rotated refresh token is handed back to be saved", async () => {
  let rotatedTo = null;
  const f = async (url) => url.includes("/oauth2/v2.0/token")
    ? jsonResponse(200, { access_token: "at", refresh_token: "rt-2", expires_in: 3600 })
    : jsonResponse(200, { id: "me", userPrincipalName: "u" });
  const auth = { schema_version: 1, tenant_id: "t", client_id: "c", user_id: "me", upn: "u", protection: "file", refresh_token: "", signed_in_at: "" };
  const g = new mod.GraphClient(auth, "rt-1", f, (t) => { rotatedTo = t; });
  await g.me();
  assert.equal(rotatedTo, "rt-2");
});

await check("GraphClient: refreshes once, retries a 429 with retry-after, surfaces failures", async () => {
  const log = [];
  let refreshes = 0;
  let throttled = false;
  const f = async (url, init) => {
    log.push(url);
    if (url.includes("/oauth2/v2.0/token")) { refreshes++; return jsonResponse(200, { access_token: "at", expires_in: 3600 }); }
    assert.equal(init.headers.authorization, "Bearer at");
    if (url.endsWith("/me?$select=id,userPrincipalName")) return jsonResponse(200, { id: "me", userPrincipalName: "aaron@example.com" });
    if (url.includes("/messages?$top=10")) {
      if (!throttled) { throttled = true; return jsonResponse(429, {}, { "retry-after": "0" }); }
      return jsonResponse(200, { value: [{ id: "m1", createdDateTime: "2026-10-03T09:00:01Z", from: { user: { id: "me" } }, body: { contentType: "html", content: "<p>1</p>" } }] });
    }
    if (url.includes("/chats/48%3Anotes/messages") && init.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), { body: { contentType: "text", content: "hello" } });
      return jsonResponse(201, { id: "posted-1" });
    }
    return jsonResponse(404, { error: "nope" });
  };
  const auth = { schema_version: 1, tenant_id: "t", client_id: "c", user_id: "me", upn: "u", protection: "file", refresh_token: "", signed_in_at: "" };
  const g = new mod.GraphClient(auth, "rt", f);
  const me = await g.me();
  assert.equal(me.id, "me");
  const msgs = await g.listMessages("48:notes");
  assert.equal(msgs.length, 1);
  assert.deepEqual(await g.post("48:notes", "hello"), { id: "posted-1", createdDateTime: "" });
  assert.equal(refreshes, 1, "one refresh serves every call");
  await assert.rejects(() => g.request("GET", "/missing"), /404/);
});

// --- The extension through the ExtensionAPI contract -------------------------------------

const makePi = () => {
  const handlers = {};
  const commands = {};
  const sent = [];
  const pi = {
    on: (event, h) => { handlers[event] = h; return () => {}; },
    registerCommand: (name, opts) => { commands[name] = opts; },
    sendUserMessage: (text, opts) => sent.push([text, opts]),
  };
  return { pi, handlers, commands, sent };
};
const makeCtx = (ui, extra = {}) => ({ hasUI: true, ui, cwd: "/work", isIdle: () => true, abort: () => {}, ...extra });

await check("extension: registers /mobile and the handlers it needs; nothing runs without /mobile on", () => {
  const { pi, handlers, commands } = makePi();
  mod.default(pi);
  assert.ok(commands.mobile, "/mobile registered");
  for (const e of ["session_start", "before_agent_start", "agent_end", "session_shutdown", "tool_execution_end"]) assert.ok(handlers[e], e);
  assert.deepEqual(commands.mobile.getArgumentCompletions("lo").map((c) => c.value), ["login", "logout"]);
});

await check("extension: /mobile on without setup or sign-in refuses and leaves the UI untouched", async () => {
  const { pi, commands } = makePi();
  mod.default(pi);
  const notes = [];
  const confirm = async () => true;
  const ui = { confirm, select: async () => undefined, input: async () => undefined, notify: (m, t) => notes.push([m, t]) };
  rmSync(mod.configPath(), { force: true });
  await commands.mobile.handler("on", makeCtx(ui));
  assert.ok(notes.some(([m]) => /not set up/.test(m)), notes.join("|"));
  assert.equal(ui.confirm, confirm, "confirm was not patched");
  // Set up but not signed in.
  mod.saveConfig({ schema_version: 1, tenant_id: "contoso.onmicrosoft.com", client_id: "11111111-2222-3333-4444-555555555555", chat_id: "", auto_on: false, poll_ms: 3000 });
  await commands.mobile.handler("on", makeCtx(ui));
  assert.ok(notes.some(([m]) => /not signed in/.test(m)));
  assert.equal(ui.confirm, confirm);
});

await check("extension: a declined /mobile on confirmation does nothing", async () => {
  const { pi, commands } = makePi();
  mod.default(pi);
  const asked = [];
  const ui = { confirm: async (t, m) => { asked.push(t); return false; }, select: async () => undefined, input: async () => undefined, notify: () => {} };
  await commands.mobile.handler("on", makeCtx(ui));
  assert.deepEqual(asked, ["coop mobile"]);
});

await check("extension: /mobile status reports off, setup and sign-in state", async () => {
  const { pi, commands } = makePi();
  mod.default(pi);
  const notes = [];
  await commands.mobile.handler("", makeCtx({ notify: (m) => notes.push(m) }));
  assert.match(notes[0], /coop mobile: off/);
  assert.match(notes[0], /not signed in/);
});

// --- End to end: /mobile on against a fake Graph ---------------------------------------------

await check("extension: on, a guardrail confirm answered from the phone, a prompt from the phone, replies posted, off restores the UI", async () => {
  mod.saveConfig({ schema_version: 1, tenant_id: "contoso.onmicrosoft.com", client_id: "11111111-2222-3333-4444-555555555555", chat_id: "", auto_on: false, poll_ms: 2000 });
  mod.saveAuth({ schema_version: 1, tenant_id: "contoso.onmicrosoft.com", client_id: "11111111-2222-3333-4444-555555555555", user_id: "me", upn: "aaron@example.com", refresh_token: "rt", signed_in_at: "now" }, process.env, "linux");
  const posted = [];
  const inbox = [];
  let postCounter = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.includes("/oauth2/v2.0/token")) return jsonResponse(200, { access_token: "at", expires_in: 3600 });
    if (/\/me\/chats\/48%3Anotes\?/.test(url)) return jsonResponse(200, { id: "48:notes", members: [{ userId: "me" }] });
    if (url.includes("/messages?$top=")) return jsonResponse(200, { value: [...inbox].reverse() });
    if (init?.method === "POST" && url.includes("/chats/48%3Anotes/messages")) {
      const content = JSON.parse(init.body).body.content;
      posted.push(content);
      const id = `own-${++postCounter}`;
      // Graph's clock: the "mobile on" post is backdated a minute so a reply can sit between it and the question.
      const createdDateTime = new Date(Date.now() - (postCounter === 1 ? 60000 : 0)).toISOString();
      inbox.push({ id, createdDateTime, from: { user: { id: "me" } }, body: { contentType: "text", content } });
      return jsonResponse(201, { id, createdDateTime });
    }
    return jsonResponse(404, { error: "unexpected " + url });
  };
  const fromPhone = (text, who = "me", offsetMs = 1000) => inbox.push({ id: `phone-${inbox.length}`, createdDateTime: new Date(Date.now() + offsetMs).toISOString(), from: { user: { id: who } }, body: { contentType: "html", content: `<p>${text}</p>` } });
  try {
    const { pi, handlers, commands, sent } = makePi();
    const ext = mod.default(pi);
    const terminal = { aborted: false, answers: [] };
    const origConfirm = async (title, message, opts) => new Promise((resolve) => {
      opts?.signal?.addEventListener("abort", () => { terminal.aborted = true; resolve(false); }, { once: true });
      terminal.answers.push((v) => resolve(v));
    });
    const ui = { confirm: async (t, m, o) => (t === "coop mobile" ? true : origConfirm(t, m, o)), select: async () => undefined, input: async () => undefined, notify: () => {} };
    const ctx = makeCtx(ui);
    await commands.mobile.handler("on", ctx);
    assert.ok(ext.isOn(), "mobile is on");
    assert.match(posted[0], /coop mobile on/);
    assert.notEqual(ui.confirm.toString(), origConfirm.toString(), "confirm is mirrored");

    // A guardrail asks; the phone answers "1"; the terminal dialog is aborted.
    const pending = ui.confirm("coop guardrails", "Write report.sql?");
    await new Promise((r) => setTimeout(r, 5));
    assert.match(posted.at(-1), /coop needs an answer: coop guardrails[\s\S]*Reply 1 \(yes\) or 2 \(no\)/);
    fromPhone("yes", "someone-else");
    await ext.pollNow();
    assert.ok(!terminal.aborted, "another user's yes is ignored");
    fromPhone("maybe");
    await ext.pollNow();
    assert.match(posted.at(-1), /Reply 1 \(yes\) or 2 \(no\)/, "an ambiguous reply gets a hint, not an answer");
    fromPhone("1", "me", -5000);
    await ext.pollNow();
    assert.match(posted.at(-1), /Ignored "1": it was written before the question/, "a yes older than the question is never an approval");
    assert.ok(!terminal.aborted, "the dialog is still open");
    fromPhone("1");
    await ext.pollNow();
    assert.equal(await pending, true);
    assert.ok(terminal.aborted, "the terminal dialog closed when the phone answered");
    assert.match(posted.at(-1), /Got it: yes/);

    // The terminal answers the next one; the phone is told.
    const second = ui.confirm("coop guardrails", "Commit?");
    await new Promise((r) => setTimeout(r, 5));
    terminal.answers.at(-1)(false);
    assert.equal(await second, false);
    await new Promise((r) => setTimeout(r, 5));
    assert.match(posted.at(-1), /Commit\?.*\(answered in the terminal\)/);

    // Text from the phone becomes a prompt; the reply posts after the turn.
    fromPhone("tidy report.sql");
    await ext.pollNow();
    assert.deepEqual(sent, [["tidy report.sql", undefined]]);
    await handlers.tool_execution_end({}, ctx);
    await handlers.agent_end({ messages: [{ role: "user", content: [{ type: "text", text: "tidy report.sql" }] }, { role: "assistant", content: [{ type: "text", text: "Done: report.sql tidied. Connection uses Password=Hunter2!x" }] }] }, ctx);
    assert.equal(posted.at(-1), "Done: report.sql tidied. Connection uses Password=[redacted] (1 tool call)");

    // /status and an unknown slash command from the phone.
    fromPhone("/status");
    await ext.pollNow();
    assert.match(posted.at(-1), /coop mobile: on as aaron@example.com in \/work/);
    fromPhone("/model gpt");
    await ext.pollNow();
    assert.match(posted.at(-1), /Only \/stop, \/status and \/mobile off/);

    await commands.mobile.handler("off", ctx);
    assert.ok(!ext.isOn());
    assert.match(posted.at(-1), /coop mobile off/);
    const restored = ui.confirm("coop guardrails", "x", {});
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(posted.filter((p) => /coop needs an answer/.test(p)).length, 2, "after off, dialogs are no longer mirrored");
    terminal.answers.at(-1)(true);
    assert.equal(await restored, true, "after off the original dialog is back");
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`✓ coop-mobile tests passed (${passed})`);
