/**
 * The phone companion's window side (master plan row MC2, desktop/COMPANION.md):
 * the hub over a fake Pi (events, questions, the one arbiter for both screens,
 * idempotent writes, reconnect) and the HTTP server on a loopback port, driven
 * the way the phone page drives it. Gate lane: a real server on 127.0.0.1 with
 * an OS-chosen port, no network, no Electron, no Pi.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionHub, messageText, toolLabel } from "../desktop/lib/companion-hub.mjs";
import { DeviceStore } from "../desktop/lib/companion-devices.mjs";
import { createCompanionServer, readCookie } from "../desktop/lib/companion-server.mjs";
import { LIMITS } from "../desktop/lib/companion-protocol.mjs";
import { originFromStatus, tailscaleCommand } from "../desktop/lib/companion-tailscale.mjs";

const temp = mkdtempSync(join(tmpdir(), "coop-companion-"));
let checks = 0;
async function check(name, fn) {
  try { await fn(); checks += 1; } catch (error) { console.error(`✗ ${name}`); throw error; }
}

class FakePi extends EventEmitter {
  constructor() { super(); this.exited = false; this.sent = []; this.answers = []; this.dialogs = new Map(); this.messages = []; }
  request(command) {
    this.sent.push(command);
    const data = command.type === "get_messages" ? { messages: this.messages }
      : command.type === "get_commands" ? { commands: this.commands || [] }
      : command.type === "clear_queue" ? { steering: ["look at the view"], followUp: ["then the report"] }
      : command.type === "get_available_models" ? { models: [{ provider: "openai", id: "gpt-5", name: "GPT-5", contextWindow: 400000 }, { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" }] }
      : command.type === "get_available_thinking_levels" ? { levels: ["off", "low", "medium", "high"] }
      : command.type === "get_fork_messages" ? { messages: [{ entryId: "e1", text: "tidy the view\nmore" }, { entryId: "e2", text: "now the report" }] }
      : command.type === "fork" ? { text: "now the report", cancelled: false }
      : command.type === "get_state" ? { model: { provider: "openai", id: "gpt-5", name: "GPT-5" }, thinkingLevel: "medium", sessionFile: "C:\\Users\\aaron\\.coop\\s.jsonl", autoCompactionEnabled: true }
      : command.type === "get_session_stats" ? { userMessages: 3, assistantMessages: 3, toolCalls: 7, tokens: { input: 12000, output: 3400 }, cost: 0.12, contextUsage: { tokens: 15400, contextWindow: 400000, percent: 3.85 } } : {};
    return Promise.resolve({ type: "response", success: true, data });
  }
  dialog(id) { return this.dialogs.get(id); }
  answer(response) { if (!this.dialogs.has(response.id)) return false; this.dialogs.delete(response.id); this.answers.push(response); return true; }
  ask(request) { this.dialogs.set(request.id, request); this.emit("event", request); }
  exit() { this.exited = true; this.emit("exit", { code: 0 }); }
}

const timers = [];
const fakeTimer = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; };
const clearFake = (t) => { if (t) t.live = false; };
const runTimers = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };

function newHub(extra = {}) {
  const pi = new FakePi();
  const hub = new CompanionHub({ windowsUser: "VM\\aaron", client: "Example Co", setTimer: fakeTimer, clearTimer: clearFake, ...extra });
  hub.attach(pi);
  return { pi, hub };
}
const SUB = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const confirmQ = { type: "extension_ui_request", id: "c1", method: "confirm", title: "coop guardrails", message: "Destructive command (rm -rf):\n  rm -rf build\nRun it?" };
const selectQ = { type: "extension_ui_request", id: "s1", method: "select", title: "coop guardrails\nThis looks like a MUTATING MCP action:\n  fabric.x\nRun it?", options: ["Allow once", "Allow fabric edits for this session (deletes still ask; production is blocked)", "Decline"] };

// ---- the hub -------------------------------------------------------------------
await check("Pi's events become the phone's types; thinking and tool output stay out of the stream, on tap only (MC8)", () => {
  const { pi, hub } = newHub();
  const types = [];
  hub.on("event", (e) => types.push([e.type, e.data]));
  pi.emit("event", { type: "agent_start" });
  pi.emit("event", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "tidy report.sql" }] } });
  pi.emit("event", { type: "message_start", message: { role: "assistant", content: [] } });
  pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret plan" } });
  pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "One " } });
  pi.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "question." } });
  runTimers();
  pi.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "One question." }] } });
  pi.emit("event", { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "C:\\work\\sql\\report.sql", oldText: "SELECT secret" } });
  pi.emit("event", { type: "tool_execution_end", toolCallId: "t1", toolName: "edit", result: { content: [{ type: "text", text: "diff with client data" }] }, isError: false });
  pi.emit("event", { type: "extension_ui_request", id: "n1", method: "notify", message: "Standards loaded", notifyType: "info" });
  pi.emit("event", { type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "x" });
  pi.emit("event", { type: "agent_end" });
  const text = JSON.stringify(types);
  assert.ok(!text.includes("secret plan") && !text.includes("SELECT secret") && !text.includes("diff with client data") && !text.includes("C:\\\\work"));
  assert.deepEqual(types.map(([t]) => t), ["status", "message", "message", "message", "tool", "tool", "notice", "panel", "status"]);
  assert.deepEqual(types[2][1], { id: types[3][1].id, role: "assistant", text: "One question.", final: false });
  assert.deepEqual(types[3][1], { id: types[3][1].id, role: "assistant", text: "One question.", final: true, thinking: true });
  assert.deepEqual(types[4][1], { id: "t1", name: "edit", label: "report.sql", state: "running", detail: true });
  // Only the phone that taps a line reads what is behind it.
  assert.equal(hub.detail(`m:${types[3][1].id}`).detail.thinking, "secret plan");
  const tool = hub.detail("t1".replace(/^/, "t:")).detail;
  assert.equal(tool.output, "diff with client data");
  assert.match(tool.args, /SELECT secret/);
  assert.equal(hub.detail("t:nope").code, "not-found");
  assert.equal(messageText("plain"), "plain");
  assert.equal(toolLabel("bash", { command: "rm -rf x" }), "");
});

await check("one arbiter: the phone answers first, the desktop's later answer is refused, Pi gets one", () => {
  const { pi, hub } = newHub();
  const closed = [];
  hub.on("resolved", (r) => closed.push(r));
  pi.ask(confirmQ);
  const [q] = hub.openQuestions();
  const result = hub.answerFromPhone("d1", { submissionId: SUB(1), incarnation: hub.incarnation, questionId: q.questionId, digest: q.digest, answer: { confirmed: false } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(hub.answerFromDesktop("c1", { confirmed: true }), { ok: false, error: "that question was already answered" });
  assert.deepEqual(pi.answers, [{ type: "extension_ui_response", id: "c1", confirmed: false }]);
  assert.deepEqual(closed, [{ piId: "c1", outcome: "answered", by: "phone" }], "the desktop card closes");
});

await check("one arbiter: the desktop answers first, the phone's later answer is refused", () => {
  const { pi, hub } = newHub();
  pi.ask(selectQ);
  const [q] = hub.openQuestions();
  assert.deepEqual(q.options, ["Allow once", "Decline"]);
  assert.deepEqual(hub.answerFromDesktop("s1", { value: selectQ.options[1] }), { ok: true }, "the desktop may pick the session-wide option");
  const late = hub.answerFromPhone("d1", { submissionId: SUB(2), incarnation: hub.incarnation, questionId: q.questionId, digest: q.digest, answer: { value: "Allow once" } });
  assert.deepEqual(late, { ok: false, code: "already-answered" });
  assert.equal(pi.answers.length, 1);
  assert.equal(hub.openQuestions().length, 0);
});

await check("a retried phone answer returns the first outcome and reaches Pi once", () => {
  const { pi, hub } = newHub();
  pi.ask(confirmQ);
  const [q] = hub.openQuestions();
  const body = { submissionId: SUB(3), incarnation: hub.incarnation, questionId: q.questionId, digest: q.digest, answer: { confirmed: true } };
  assert.deepEqual(hub.answerFromPhone("d1", body), { ok: true });
  assert.deepEqual(hub.answerFromPhone("d1", body), { ok: true });
  assert.equal(pi.answers.length, 1);
});

await check("a timed-out question expires on the window's clock; answers after it are refused", () => {
  const { pi, hub } = newHub();
  pi.ask({ ...confirmQ, id: "c2", timeout: 30_000 });
  const [q] = hub.openQuestions();
  runTimers();
  assert.equal(hub.openQuestions().length, 0);
  assert.equal(hub.answerFromPhone("d1", { submissionId: SUB(4), incarnation: hub.incarnation, questionId: q.questionId, digest: q.digest, answer: { confirmed: true } }).code, "expired");
  assert.equal(pi.answers.length, 0);
});

await check("Pi exiting cancels questions, reports exited and turns access off", () => {
  const { pi, hub } = newHub();
  hub.setAccess(true);
  assert.equal(hub.accessOn, true);
  pi.ask(confirmQ);
  const [q] = hub.openQuestions();
  pi.exit();
  assert.equal(hub.accessOn, false);
  assert.equal(hub.status, "exited");
  assert.equal(hub.answerFromPhone("d1", { submissionId: SUB(5), incarnation: hub.incarnation, questionId: q.questionId, digest: q.digest, answer: { confirmed: true } }).code, "cancelled");
});

await check("a new session is a new incarnation: access off, old questions and writes refused", () => {
  const { pi, hub } = newHub();
  hub.setAccess(true);
  pi.ask(confirmQ);
  const [q] = hub.openQuestions();
  const old = hub.incarnation;
  hub.renew();
  assert.notEqual(hub.incarnation, old);
  assert.equal(hub.accessOn, false);
  assert.equal(hub.answerFromPhone("d1", { submissionId: SUB(6), incarnation: old, questionId: q.questionId, digest: q.digest, answer: { confirmed: true } }).code, "wrong-session");
  assert.equal(hub.chat("d1", { submissionId: SUB(7), incarnation: old, text: "hi" }).code, "wrong-session");
});

await check("chat is a prompt when idle; while coop works it steers or queues as asked; stop aborts; retries send once", () => {
  const { pi, hub } = newHub();
  hub.chat("d1", { submissionId: SUB(8), incarnation: hub.incarnation, text: "first", mode: "steer" });
  pi.emit("event", { type: "agent_start" });
  hub.chat("d1", { submissionId: SUB(9), incarnation: hub.incarnation, text: "second", mode: "queue" });
  hub.chat("d1", { submissionId: SUB(9), incarnation: hub.incarnation, text: "second", mode: "queue" });
  hub.chat("d1", { submissionId: SUB(11), incarnation: hub.incarnation, text: "use the dev target", mode: "steer" });
  hub.stop("d1", { submissionId: SUB(10), incarnation: hub.incarnation });
  assert.deepEqual(pi.sent, [
    { type: "prompt", message: "first" },
    { type: "prompt", message: "second", streamingBehavior: "followUp" },
    { type: "prompt", message: "use the dev target", streamingBehavior: "steer" },
    { type: "abort" },
  ]);
});

await check("/ commands (MC6): Pi's listed commands go as typed; built-ins and unknown names are refused with a reason", async () => {
  const { pi, hub } = newHub();
  pi.commands = [{ name: "start", description: "Start here", source: "extension" }, { name: "pets", source: "extension" }];
  const snap = await hub.snapshot();
  assert.deepEqual(snap.commands.map((c) => c.name), ["start"]);
  assert.deepEqual(hub.chat("d1", { submissionId: SUB(20), incarnation: hub.incarnation, text: "/start", mode: "steer" }), { ok: true });
  const refused = hub.chat("d1", { submissionId: SUB(21), incarnation: hub.incarnation, text: "/new", mode: "steer" });
  assert.equal(refused.code, "desktop-only");
  assert.match(refused.message, /coop window/);
  assert.equal(hub.chat("d1", { submissionId: SUB(22), incarnation: hub.incarnation, text: "/pets", mode: "steer" }).code, "desktop-only");
  assert.equal(hub.chat("d1", { submissionId: SUB(23), incarnation: hub.incarnation, text: "/nope", mode: "steer" }).code, "unknown-command");
  assert.deepEqual(pi.sent.filter((c) => c.type === "prompt"), [{ type: "prompt", message: "/start" }]);
});

await check("queue (MC6): Pi's queue reaches the phone; Edit queued brings the texts back", async () => {
  const { pi, hub } = newHub();
  const events = [];
  hub.on("event", (e) => events.push(e));
  pi.emit("event", { type: "queue_update", steering: ["look at the view"], followUp: ["then the report"] });
  const status = events.find((e) => e.type === "status");
  assert.deepEqual(status.data.queue, { steering: ["look at the view"], followUp: ["then the report"] });
  assert.deepEqual((await hub.snapshot()).queue, { steering: ["look at the view"], followUp: ["then the report"] });
  const back = await hub.dequeue("d1", { submissionId: SUB(30), incarnation: hub.incarnation });
  assert.deepEqual(back, { ok: true, texts: ["look at the view", "then the report"] });
  assert.equal((await hub.dequeue("d1", { submissionId: SUB(31), incarnation: "CCCCCCCCCCCCCCCCCCCCCCCC" })).code, "wrong-session");
});

await check("panel (MC8): status line, widgets and the todo panel above the prompt", async () => {
  const { pi, hub } = newHub();
  const panels = [];
  hub.on("event", (e) => { if (e.type === "panel") panels.push(e.data); });
  pi.emit("event", { type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "std", statusText: "\x1b[32mstandards: bundled\x1b[0m" });
  pi.emit("event", { type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "ctx", widgetLines: ["line 1", "line 2"] });
  pi.emit("event", { type: "tool_execution_end", toolCallId: "t9", toolName: "todo", result: { content: [], details: { tasks: [{ id: 1, subject: "Read the view", status: "in_progress", activeForm: "Reading" }, { id: 2, subject: "Fix it", status: "pending" }], nextId: 3 } } });
  const last = panels.at(-1);
  assert.deepEqual(last.status, ["standards: bundled"], "ANSI colours are dropped");
  assert.deepEqual(last.widgets, [{ key: "ctx", lines: ["line 1", "line 2"] }]);
  assert.equal(last.todo[0], "● Todos (0/2)");
  assert.match(last.todo[1], /Read the view \(Reading\)/);
  assert.deepEqual((await hub.snapshot()).panel, last);
  pi.emit("event", { type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "std" });
  assert.deepEqual(panels.at(-1).status, []);
});

await check("session controls (MC7): a listed model, a thinking level, compact when idle, a name; details carry no paths", async () => {
  const { pi, hub } = newHub();
  const req = (n, body) => ({ submissionId: SUB(40 + n), incarnation: hub.incarnation, ...body });
  assert.deepEqual(await hub.control("d1", req(0, { action: "model", provider: "openai", modelId: "gpt-5-mini" })), { ok: true });
  assert.deepEqual(pi.sent.at(-1), { type: "set_model", provider: "openai", modelId: "gpt-5-mini" });
  const unlisted = await hub.control("d1", req(1, { action: "model", provider: "evil", modelId: "x" }));
  assert.equal(unlisted.code, "not-an-option");
  assert.ok(!pi.sent.some((c) => c.type === "set_model" && c.provider === "evil"), "an unlisted model never reaches Pi");
  assert.deepEqual(await hub.control("d1", req(2, { action: "thinking", level: "high" })), { ok: true });
  assert.deepEqual(pi.sent.at(-1), { type: "set_thinking_level", level: "high" });
  assert.deepEqual(await hub.control("d1", req(3, { action: "name", name: "Sales views" })), { ok: true });
  assert.equal(hub.sessionName, "Sales views");
  pi.emit("event", { type: "agent_start" });
  assert.equal((await hub.control("d1", req(4, { action: "compact" }))).code, "busy");
  pi.emit("event", { type: "agent_end" });
  assert.deepEqual(await hub.control("d1", req(5, { action: "compact", instructions: "keep the SQL" })), { ok: true });
  assert.deepEqual(pi.sent.at(-1), { type: "compact", customInstructions: "keep the SQL" });
  assert.equal((await hub.control("d1", { ...req(6, { action: "thinking", level: "low" }), incarnation: "CCCCCCCCCCCCCCCCCCCCCCCC" })).code, "wrong-session");
  const { details } = await hub.details();
  assert.equal(details.model.id, "gpt-5");
  assert.deepEqual(details.levels, ["off", "low", "medium", "high"]);
  assert.equal(details.models.length, 2);
  assert.equal(details.stats.toolCalls, 7);
  assert.ok(!JSON.stringify(details).includes(".jsonl"), "the session file path stays on the VM");
});

await check("sessions (MC9): ids resolve against the window's lists; a session the phone opens keeps access, one the desk opens does not", async () => {
  const changed = [];
  const host = {
    list: () => [{ id: "s-old", path: "C:\\Users\\aaron\\.coop\\sessions\\x\\old.jsonl", name: "Old", title: "tidy", modified: 1, messages: 2 }],
    exportPath: async () => "C:\\Users\\aaron\\.coop\\sessions\\x\\coop-session-1.html",
    changed: (action) => changed.push(action),
  };
  const { pi, hub } = newHub({ host });
  hub.accessOn = true;
  const req = (n, body) => ({ submissionId: SUB(70 + n), incarnation: hub.incarnation, ...body });
  const listed = await hub.sessions();
  assert.deepEqual(listed.sessions.map((s) => s.id), ["s-old"]);
  assert.ok(!JSON.stringify(listed).includes(".jsonl"), "no session path leaves the VM");
  assert.deepEqual(listed.prompts, [{ entryId: "e1", text: "tidy the view" }, { entryId: "e2", text: "now the report" }]);
  assert.equal((await hub.sessionAction("d1", req(0, { action: "resume", sessionId: "nope" }))).code, "not-an-option");
  const before = hub.incarnation;
  assert.deepEqual(await hub.sessionAction("d1", req(1, { action: "resume", sessionId: "s-old" })), { ok: true });
  assert.deepEqual(pi.sent.at(-1), { type: "switch_session", sessionPath: "C:\\Users\\aaron\\.coop\\sessions\\x\\old.jsonl" });
  assert.notEqual(hub.incarnation, before);
  assert.equal(hub.accessOn, true, "the phone opened it, so it keeps access");
  assert.deepEqual(changed, ["resume"]);
  assert.equal((await hub.sessionAction("d1", req(2, { action: "fork", entryId: "e9" }))).code, "not-an-option");
  assert.deepEqual(await hub.sessionAction("d1", { submissionId: SUB(73), incarnation: hub.incarnation, action: "fork", entryId: "e2" }), { ok: true, text: "now the report" });
  assert.deepEqual(await hub.sessionAction("d1", { submissionId: SUB(74), incarnation: hub.incarnation, action: "export" }), { ok: true, file: "coop-session-1.html" });
  pi.emit("event", { type: "agent_start" });
  assert.equal((await hub.sessionAction("d1", { submissionId: SUB(75), incarnation: hub.incarnation, action: "new" })).code, "busy");
  pi.emit("event", { type: "agent_end" });
  hub.renew();
  assert.equal(hub.accessOn, false, "a session changed at the desk still ends access");
});

await check("access needs a client in the project file and a running Pi", () => {
  const { hub } = newHub({ client: "" });
  assert.equal(hub.setAccess(true), false);
});

await check("reconnect: replay a gap-free tail of the same session, else the snapshot", async () => {
  const { pi, hub } = newHub();
  pi.emit("event", { type: "agent_start" });
  pi.emit("event", { type: "agent_end" });
  const [, second, third] = hub.buffer;
  const replay = hub.resume(second.id);
  assert.equal(replay.mode, "replay");
  assert.deepEqual(replay.events.map((e) => e.seq), [third.seq]);
  assert.equal(hub.resume("").mode, "snapshot");
  pi.messages = [{ role: "user", content: "hi" }, { role: "toolResult", content: [{ type: "text", text: "rows" }] }, { role: "assistant", content: [{ type: "text", text: "hello" }] }];
  const snap = await hub.snapshot();
  assert.deepEqual(snap.messages.map((m) => [m.role, m.text]), [["user", "hi"], ["assistant", "hello"]], "tool results stay on the VM");
  assert.equal(snap.lastEventId, third.id);
  assert.equal(snap.client, "Example Co");
});

// ---- the device store ------------------------------------------------------------
await check("pairing codes work once, expire, die after five wrong tries; secrets are stored hashed", () => {
  let t = 1_000_000;
  const file = join(temp, "store1", "devices.json");
  const store = new DeviceStore(file, { now: () => t });
  const { code } = store.startPairing({ windowsUser: "VM\\aaron", client: "Example Co" });
  const { device, secret } = store.redeem(code, "Aaron's phone");
  assert.ok(device && secret);
  assert.ok(!readFileSync(file, "utf8").includes(secret));
  assert.deepEqual(store.redeem(code, "again"), { error: "not-paired" });
  const second = store.startPairing({ windowsUser: "VM\\aaron", client: "Example Co" });
  t += LIMITS.pairingCodeMs + 1;
  assert.deepEqual(store.redeem(second.code, "late"), { error: "not-paired" });
  const third = store.startPairing({ windowsUser: "VM\\aaron", client: "Example Co" });
  for (let i = 0; i < 5; i += 1) store.redeem("ZZZZZZZZ", "guess");
  assert.deepEqual(store.redeem(third.code, "after guesses"), { error: "not-paired" });
  assert.deepEqual(new DeviceStore(file).list().map((d) => d.name), ["Aaron's phone"]);
  store.revoke(device.id);
  assert.deepEqual(store.list(), []);
});

// ---- the server, driven like the phone page --------------------------------------
const ORIGIN = "https://coop-vm.example-tailnet.ts.net";
const webRoot = join(temp, "web");
mkdirSync(webRoot);
writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>coop</title>");
writeFileSync(join(webRoot, "pixel.woff2"), "wOF2");
writeFileSync(join(temp, "secret.txt"), "not served");

function call(port, method, path, { body, cookie, origin = ORIGIN, host = new URL(ORIGIN).host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const h = { Host: host };
    if (method !== "GET") Object.assign(h, { Origin: origin, "X-Coop-Companion": "1", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    Object.assign(h, headers);
    if (cookie) h.Cookie = cookie;
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

function stream(port, cookie, lastEventId = "") {
  return new Promise((resolve, reject) => {
    const headers = { Host: new URL(ORIGIN).host, Cookie: cookie };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path: "/api/events", headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      resolve({ res, read: () => text, close: () => req.destroy(), ended: new Promise((r) => res.on("end", r)) });
    });
    req.on("error", reject);
    req.end();
  });
}

const { pi, hub } = newHub();
let activeHub = hub;
const store = new DeviceStore(join(temp, "store2", "devices.json"));
const audit = [];
const companion = createCompanionServer({ store, active: () => activeHub, origin: ORIGIN, webRoot, audit: (e) => audit.push(e), port: 0 });
await companion.listen();
const port = companion.server.address().port;
// The test listens on an OS-chosen port; requests name the tailnet host.
let cookie = "";

try {
  await check("server: the page is served with its CSP; nothing outside the web folder is", async () => {
    const page = await call(port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
    assert.equal((await call(port, "GET", "/pixel.woff2")).headers["content-type"], "font/woff2");
    assert.equal((await call(port, "GET", "/../secret.txt")).status, 404);
    assert.equal((await call(port, "GET", "/%2e%2e/secret.txt")).status, 404);
  });

  await check("server: a request for another host name gets nothing (DNS rebinding)", async () => {
    assert.equal((await call(port, "GET", "/", { host: "evil.example" })).status, 421);
  });

  await check("server: pairing with the code from the window sets an HttpOnly, Secure, SameSite=Strict cookie", async () => {
    const wrong = await call(port, "POST", "/api/pair", { body: { code: "ABCDEFGH", deviceName: "phone" } });
    assert.equal(wrong.json.code, "not-paired");
    const { code } = store.startPairing({ windowsUser: "VM\\aaron", client: "Example Co" });
    const res = await call(port, "POST", "/api/pair", { body: { code, deviceName: "Aaron's phone" } });
    assert.equal(res.status, 200);
    const set = String(res.headers["set-cookie"]);
    assert.match(set, /HttpOnly/);
    assert.match(set, /Secure/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Path=\/api/);
    cookie = set.split(";")[0];
    assert.ok(readCookie(cookie));
  });

  await check("server: access off in the window refuses a paired phone", async () => {
    const res = await call(port, "GET", "/api/snapshot", { cookie });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, "access-off");
  });

  hub.setAccess(true);

  await check("server: with access on, the snapshot names the user, client and session", async () => {
    const res = await call(port, "GET", "/api/snapshot", { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.snapshot.client, "Example Co");
    assert.equal(res.json.snapshot.windowsUser, "VM\\aaron");
    assert.equal(res.json.snapshot.incarnation, hub.incarnation);
    assert.equal(res.headers["cache-control"], "no-store");
  });

  await check("server: no cookie, a forged cookie, a cross-site origin or a missing header are refused", async () => {
    assert.equal((await call(port, "GET", "/api/snapshot")).json.code, "not-paired");
    assert.equal((await call(port, "GET", "/api/snapshot", { cookie: `${cookie.split(".")[0]}.${"A".repeat(43)}` })).json.code, "not-paired");
    const body = { submissionId: SUB(20), incarnation: hub.incarnation, text: "hi" };
    assert.equal((await call(port, "POST", "/api/chat", { cookie, body, origin: "https://evil.example" })).json.code, "bad-origin");
    assert.equal((await call(port, "POST", "/api/chat", { cookie, body, headers: { "X-Coop-Companion": "" } })).json.code, "bad-origin");
  });

  await check("server: Pi's own commands have no route", async () => {
    for (const path of ["/api/bash", "/api/rpc", "/api/new_session", "/api/unlock-prod", "/api/files"]) {
      assert.equal((await call(port, "POST", path, { cookie, body: {} })).status, 404, path);
    }
  });

  await check("server: chat reaches Pi once even when retried; slash commands stay on the desktop", async () => {
    const body = { submissionId: SUB(21), incarnation: hub.incarnation, text: "what changed?" };
    assert.equal((await call(port, "POST", "/api/chat", { cookie, body })).status, 200);
    assert.equal((await call(port, "POST", "/api/chat", { cookie, body })).status, 200);
    assert.equal(pi.sent.filter((c) => c.message === "what changed?").length, 1);
    assert.equal((await call(port, "POST", "/api/chat", { cookie, body: { ...body, submissionId: SUB(22), text: "/new" } })).json.code, "desktop-only");
  });

  await check("server: a tapped tool line reads its detail; a malformed id is refused (MC8)", async () => {
    pi.emit("event", { type: "tool_execution_start", toolCallId: "call_7", toolName: "read", args: { path: "a.sql" } });
    const read = await call(port, "GET", "/api/detail?id=t%3Acall_7", { cookie });
    assert.equal(read.status, 200);
    assert.equal(read.json.detail.name, "read");
    assert.equal((await call(port, "GET", "/api/detail?id=..%2Fetc", { cookie })).json.code, "bad-request");
    assert.equal((await call(port, "GET", "/api/detail?id=t%3Agone", { cookie })).status, 404);
  });

  await check("server: the session sheets read details and set the thinking level (MC7)", async () => {
    const read = await call(port, "GET", "/api/session", { cookie });
    assert.equal(read.status, 200);
    assert.equal(read.json.details.thinkingLevel, "medium");
    const body = { submissionId: SUB(60), incarnation: hub.incarnation, action: "thinking", level: "low" };
    assert.equal((await call(port, "POST", "/api/session", { cookie, body })).status, 200);
    assert.deepEqual(pi.sent.at(-1), { type: "set_thinking_level", level: "low" });
    const bad = await call(port, "POST", "/api/session", { cookie, body: { ...body, submissionId: SUB(61), action: "model", provider: "evil", modelId: "x", level: undefined } });
    assert.equal(bad.json.code, "not-an-option");
  });

  await check("server: events stream live, the desktop's answer closes the phone's card, and an answer races correctly", async () => {
    const s = await stream(port, cookie);
    pi.ask(confirmQ);
    await new Promise((r) => setTimeout(r, 50));
    assert.match(s.read(), /event: resync/);
    assert.match(s.read(), /event: question/);
    const q = hub.openQuestions()[0];
    hub.answerFromDesktop("c1", { confirmed: false });
    await new Promise((r) => setTimeout(r, 50));
    assert.match(s.read(), /"outcome":"answered","by":"desktop"/);
    const late = await call(port, "POST", "/api/answer", { cookie, body: { submissionId: SUB(23), incarnation: hub.incarnation, questionId: q.questionId, digest: q.digest, answer: { confirmed: true } } });
    assert.equal(late.json.code, "already-answered");
    s.close();
  });

  await check("server: a phone approval reaches Pi as the exact answer", async () => {
    pi.ask({ ...confirmQ, id: "c9" });
    const q = hub.openQuestions()[0];
    const res = await call(port, "POST", "/api/answer", { cookie, body: { submissionId: SUB(24), incarnation: hub.incarnation, questionId: q.questionId, digest: q.digest, answer: { confirmed: true } } });
    assert.equal(res.status, 200);
    assert.deepEqual(pi.answers.at(-1), { type: "extension_ui_response", id: "c9", confirmed: true });
  });

  await check("server: removing the device in the window ends its stream and refuses it at once", async () => {
    const s = await stream(port, cookie);
    const id = readCookie(cookie).id;
    companion.revoked(store.revoke(id));
    await s.ended;
    assert.equal((await call(port, "GET", "/api/snapshot", { cookie })).json.code, "revoked");
  });

  await check("server: a phone paired on another client is refused here", async () => {
    const { code } = store.startPairing({ windowsUser: "VM\\aaron", client: "Other Client" });
    const res = await call(port, "POST", "/api/pair", { body: { code, deviceName: "phone" } });
    const other = String(res.headers["set-cookie"]).split(";")[0];
    assert.equal((await call(port, "GET", "/api/snapshot", { cookie: other })).json.code, "wrong-client");
  });

  await check("server: no window with access on refuses everything", async () => {
    activeHub = null;
    const { code } = store.startPairing({ windowsUser: "VM\\aaron", client: "Example Co" });
    const res = await call(port, "POST", "/api/pair", { body: { code, deviceName: "phone" } });
    const fresh = String(res.headers["set-cookie"]).split(";")[0];
    assert.equal((await call(port, "GET", "/api/snapshot", { cookie: fresh })).json.code, "wrong-user");
  });

  await check("server: the audit log names outcomes, never message text or answers", () => {
    const text = JSON.stringify(audit);
    assert.ok(audit.some((e) => e.kind === "paired") && audit.some((e) => e.kind === "answer") && audit.some((e) => e.code === "access-off"));
    assert.ok(!text.includes("what changed?"));
  });
} finally {
  await companion.close();
  rmSync(temp, { recursive: true, force: true });
}

await check("tailscale: the origin is the VM's tailnet name, and nothing when Tailscale is off", () => {
  assert.equal(originFromStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "coop-vm.example-tailnet.ts.net." } })), "https://coop-vm.example-tailnet.ts.net");
  assert.equal(originFromStatus(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "coop-vm.example-tailnet.ts.net." } })), "");
  assert.equal(originFromStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "evil.example.com." } })), "");
  assert.equal(originFromStatus("not json"), "");
  assert.equal(tailscaleCommand("win32", { ProgramFiles: "C:\\Program Files" }, () => true), "C:\\Program Files\\Tailscale\\tailscale.exe");
});

// ---- the phone page (MC3): what ships, and what it may load ------------------------
const ROOT = join(import.meta.dirname, "..");
const pageDir = join(ROOT, "desktop", "companion");
await check("page: every file the page names ships, from this origin only, with the shared desktop modules", async () => {
  const html = readFileSync(join(pageDir, "index.html"), "utf8");
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    assert.ok(!/^[a-z]+:|^\/\//i.test(ref), `no outside resource: ${ref}`);
    if (!ref.startsWith("shared/")) assert.ok(existsSync(join(pageDir, ref)), `ships: ${ref}`);
  }
  assert.ok(!/<script(?![^>]*src=)/i.test(html) && !/ on[a-z]+=/i.test(html) && !/ style=/i.test(html), "no inline script, handler or style (the CSP forbids them)");
  const js = readFileSync(join(pageDir, "app.js"), "utf8");
  for (const [, ref] of js.matchAll(/from "\.\/(shared\/[^"]+)"/g)) assert.ok(["shared/dialogs.mjs", "shared/markdown.mjs"].includes(ref));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), "VM text never becomes HTML");
  assert.ok(!/localStorage\.setItem\((?!"coop-theme")/.test(js), "only the theme is kept on the phone");
  const sw = readFileSync(join(pageDir, "sw.js"), "utf8");
  assert.match(sw, /startsWith\("\/api\/"\)\) return;/, "the service worker never touches /api");
  const manifest = JSON.parse(readFileSync(join(pageDir, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) assert.ok(existsSync(join(pageDir, icon.src)));
});

await check("page: four themes from the menu, Retro in the coop site's look (MC5), its font from this origin under its licence", () => {
  const html = readFileSync(join(pageDir, "index.html"), "utf8");
  for (const part of ['data-style="modern"', 'data-style="retro"', 'data-mode="dark"', 'data-mode="light"']) assert.ok(html.includes(part), part);
  assert.ok(!/<select/.test(html), "the menu replaces the theme list");
  assert.match(readFileSync(join(pageDir, "app.js"), "utf8"), /const THEMES = \["modern-dark", "modern-light", "retro-dark", "retro-light"\];/);
  const css = readFileSync(join(pageDir, "style.css"), "utf8");
  const fonts = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(fonts.length >= 2, "the pixel face is declared");
  for (const ref of fonts) {
    assert.ok(!/^[a-z]+:|^\/\//i.test(ref), `no outside font: ${ref}`);
    assert.ok(existsSync(join(pageDir, ref)), `ships: ${ref}`);
  }
  assert.match(readFileSync(join(pageDir, "fonts", "OFL.txt"), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});

console.log(`✓ companion server (MC2) and page (MC3): ${checks} checks`);
