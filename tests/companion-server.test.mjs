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
import { attach, saveUpload } from "../desktop/lib/attachments.mjs";
import { createPushSender, loadVapid, pushEndpointOk, vapidAuthorization } from "../desktop/lib/companion-push.mjs";
import { createPublicKey, verify } from "node:crypto";
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
      : command.type === "get_tree" ? this.tree || { tree: [] }
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
  const refused = hub.chat("d1", { submissionId: SUB(21), incarnation: hub.incarnation, text: "/hotkeys", mode: "steer" });
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
  // The snapshot also carries context and usage, read from Pi when the phone connects.
  const snap = (await hub.snapshot()).panel;
  assert.deepEqual({ ...snap, usage: null }, last);
  assert.deepEqual(snap.usage, { contextPercent: 3.85, contextTokens: 15400, contextWindow: 400000, tokensIn: 12000, tokensOut: 3400, cost: 0.12 });
  pi.emit("event", { type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "std" });
  assert.deepEqual(panels.at(-1).status, []);
});

await check("panel: a compaction shows on the phone, and context and usage refresh after it and after each turn", async () => {
  const { pi, hub } = newHub();
  const events = [];
  hub.on("event", (e) => events.push(e));
  pi.emit("event", { type: "compaction_start", reason: "threshold" });
  assert.equal(events.at(-2).type, "notice");
  assert.match(events.at(-2).data.text, /context is nearly full; compacting/);
  assert.equal(events.at(-1).data.compacting, true);
  pi.emit("event", { type: "compaction_end", result: { tokensBefore: 180000, estimatedTokensAfter: 21000 } });
  assert.equal(events.find((e) => e.type === "notice" && /Compacted/.test(e.data.text)).data.text, "Compacted the conversation: about 180k tokens down to 21k.");
  await new Promise((r) => setTimeout(r, 10));
  const panel = events.filter((e) => e.type === "panel").at(-1).data;
  assert.equal(panel.compacting, false);
  assert.equal(panel.usage.contextPercent, 3.85);
  pi.emit("event", { type: "compaction_end", errorMessage: "model refused" });
  assert.equal(events.filter((e) => e.type === "notice").at(-1).data.level, "error");
  const before = events.length;
  pi.emit("event", { type: "agent_end" });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!events.slice(before).some((e) => e.type === "panel"), "unchanged usage sends no panel");
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

await check("photos and files (MC10): saved under the window's data folder, sent as the window sends attachments", async () => {
  const uploads = join(temp, "phone-uploads");
  const folder = join(temp, "project");
  mkdirSync(join(folder, "views"), { recursive: true });
  const host = {
    attach: (name, bytes) => attach(saveUpload(uploads, name, bytes), { cwd: folder, store: join(temp, "extracts"), node: process.execPath, pdfjsDir: "" }),
    files: async (q) => ["views/", "views/sales.sql", "README.md"].filter((p) => p.includes(q)),
  };
  const { pi, hub } = newHub({ host });
  const req = (n, body) => ({ submissionId: SUB(80 + n), incarnation: hub.incarnation, ...body });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const photo = await hub.upload("d1", req(0, { name: "IMG_0001.png", data: png.toString("base64") }));
  assert.equal(photo.ok, true);
  assert.match(photo.file.id, /^u[0-9a-f]{24}$/);
  assert.equal(photo.file.kind, "image");
  assert.ok(!JSON.stringify(photo).includes(uploads), "no VM path goes back to the phone");
  const notes = await hub.upload("d1", req(1, { name: "notes.sql", data: Buffer.from("select 1").toString("base64") }));
  assert.equal(notes.file.kind, "text");
  assert.equal((await hub.upload("d1", req(2, { name: "old.doc", data: Buffer.from("x").toString("base64") }))).code, "not-an-option");
  // Another device cannot send this phone's files.
  assert.equal(hub.chat("d2", req(3, { text: "look", mode: "queue", attachments: [photo.file.id] })).code, "not-found");
  assert.deepEqual(hub.chat("d1", req(4, { text: "what is this?", mode: "queue", attachments: [photo.file.id, notes.file.id] })), { ok: true });
  const sent = pi.sent.at(-1);
  assert.equal(sent.type, "prompt");
  assert.match(sent.message, /^what is this\?\n\nAttached files \(read each one with the read tool before answering\):\n- notes\.sql: /);
  assert.equal(sent.images.length, 1);
  assert.equal(sent.images[0].mimeType, "image/png");
  assert.equal(hub.chat("d1", req(5, { text: "", mode: "queue", attachments: [photo.file.id] })).code, "not-found", "a file goes once");
  pi.emit("event", { type: "message_start", message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } });
  assert.equal(hub.buffer.at(-1).data.images, 1, "an image-only message still shows, as a count");
  assert.deepEqual((await hub.files("sales")).files, ["views/sales.sql"]);
  assert.deepEqual((await newHub().hub.files("x")).files, [], "no host, no list");
});

await check("the session tree (MC9): prompts and answers as indented rows, tool output left on the VM; a phone reload keeps access", async () => {
  const reloads = [];
  const { pi, hub } = newHub({ host: { list: () => [], exportPath: async () => "", changed: () => {}, reload: () => reloads.push(1) } });
  const node = (id, message, children = [], label) => ({ entry: { id, type: "message", message }, children, ...(label ? { label } : {}) });
  pi.tree = { leafId: "a2", tree: [node("u1", { role: "user", content: "tidy the view" }, [
    node("a1", { role: "assistant", content: [{ type: "toolCall", name: "read" }] }, [
      node("t1", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "SECRET ROWS" }] }, [
        node("u2", { role: "user", content: "now the report" }, [node("a2", { role: "assistant", content: [{ type: "text", text: "Done." }] })], "checkpoint"),
        node("u3", { role: "user", content: "or the model" }),
      ]),
    ]),
  ])] };
  const tree = await hub.tree();
  assert.deepEqual(tree.rows.map((r) => [r.depth, r.role, r.text, r.entryId || "", r.current]), [
    [0, "user", "tidy the view", "u1", false], [0, "assistant", "Runs read", "", false],
    [1, "user", "now the report", "u2", false], [1, "assistant", "Done.", "", true], [1, "user", "or the model", "u3", false],
  ]);
  assert.equal(tree.rows[2].label, "checkpoint");
  assert.ok(!JSON.stringify(tree).includes("SECRET"), "tool output stays on the VM");
  hub.accessOn = true;
  assert.deepEqual(await hub.sessionAction("d1", { submissionId: SUB(95), incarnation: hub.incarnation, action: "reload" }), { ok: true });
  assert.equal(reloads.length, 1);
  pi.exited = true;
  pi.emit("exit", {});
  assert.equal(hub.accessOn, true, "the old coop exiting during the phone's reload keeps access");
  const next = new FakePi();
  hub.attach(next);
  assert.equal(hub.accessOn, true, "the restarted coop keeps the phone's access");
  hub.attach(new FakePi());
  assert.equal(hub.accessOn, false, "a later restart at the desk ends it");
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
  assert.equal(snap.lastEventId, hub.buffer.at(-1).id, "the usage read after the turn is the last event");
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

await check("notices (MC11): known push services only, a VAPID key kept per user, an ES256 token, and no payload", async () => {
  for (const ok of ["https://web.push.apple.com/QGx", "https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x"]) assert.ok(pushEndpointOk(ok), ok);
  for (const bad of ["http://web.push.apple.com/x", "https://evil.example/web.push.apple.com", "https://fcm.googleapis.com:8443/x", "https://127.0.0.1/x", "https://a@fcm.googleapis.com/x", "not a url"]) assert.ok(!pushEndpointOk(bad), bad);
  const file = join(temp, "push", "push.json");
  const keys = loadVapid(file);
  assert.equal(loadVapid(file).publicKey, keys.publicKey, "the key pair is kept");
  assert.equal(Buffer.from(keys.publicKey, "base64url").length, 65);
  const auth = vapidAuthorization("https://web.push.apple.com/QGx", keys, "https://coop-vm.example-tailnet.ts.net", 1_000_000_000_000);
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = token.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: 1_000_000_000 + 12 * 3600, sub: "https://coop-vm.example-tailnet.ts.net" });
  const raw = Buffer.from(keys.publicKey, "base64url");
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
  const requests = [];
  const fakeRequest = (url, options, onResponse) => {
    const req = new EventEmitter();
    req.end = (body) => { requests.push({ url, options, body }); onResponse({ statusCode: 201, resume() {} }); };
    return req;
  };
  const sender = createPushSender({ keys, subject: "https://coop-vm.example-tailnet.ts.net", request: fakeRequest });
  assert.equal(await sender.send("https://fcm.googleapis.com/fcm/send/abc"), 201);
  assert.equal(await sender.send("https://evil.example/x"), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers["Content-Length"], "0");
  assert.equal(requests[0].body, undefined, "a notice carries nothing");
});

await check("notices (MC11): a question or a finished turn calls for attention", () => {
  const { pi, hub } = newHub();
  const seen = [];
  hub.on("attention", (e) => seen.push(e.kind));
  pi.emit("event", { type: "agent_start" });
  pi.emit("event", { type: "agent_end" });
  pi.emit("event", confirmQ);
  assert.deepEqual(seen, ["done", "question"]);
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
const pushed = [];
let pushStatus = 201;
const push = { publicKey: "BPUBLIC", send: async (endpoint) => { pushed.push(endpoint); return pushStatus; } };
let clock = 5_000_000;
const companion = createCompanionServer({ store, active: () => activeHub, origin: ORIGIN, webRoot, audit: (e) => audit.push(e), port: 0, push, now: () => clock++ });
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

  await check("server: an upload is read only from a paired phone, and its file goes with the next chat (MC10)", async () => {
    const big = await call(port, "POST", "/api/upload", { body: { submissionId: SUB(90), incarnation: hub.incarnation, name: "a.txt", data: "QQ==" } });
    assert.equal(big.json.code, "not-paired", "no cookie, no body read");
    const files = [];
    hub.host = { attach: async (name, bytes) => { files.push([name, bytes.toString()]); return { kind: "text", label: "text", name, size: bytes.length, ref: name }; }, files: async () => ["views/sales.sql"] };
    try {
      const up = await call(port, "POST", "/api/upload", { cookie, body: { submissionId: SUB(91), incarnation: hub.incarnation, name: "a.txt", data: Buffer.from("hello").toString("base64") } });
      assert.equal(up.status, 200);
      assert.deepEqual(files, [["a.txt", "hello"]]);
      assert.equal((await call(port, "POST", "/api/upload", { cookie, body: { submissionId: SUB(92), incarnation: hub.incarnation, name: "../a.txt", data: "QQ==" } })).json.code, "bad-request");
      const chat = await call(port, "POST", "/api/chat", { cookie, body: { submissionId: SUB(93), incarnation: hub.incarnation, text: "", attachments: [up.json.file.id] } });
      assert.equal(chat.status, 200);
      assert.match(pi.sent.at(-1).message, /- a\.txt: a\.txt$/);
      const listed = await call(port, "GET", "/api/files?q=sales", { cookie });
      assert.deepEqual(listed.json.files, ["views/sales.sql"]);
    } finally { hub.host = null; }
  });

  await check("server: notices go to a closed page only, a minute apart, and a dropped endpoint is forgotten (MC11)", async () => {
    assert.deepEqual((await call(port, "GET", "/api/push", { cookie })).json, { ok: true, available: true, publicKey: "BPUBLIC", on: false });
    assert.equal((await call(port, "POST", "/api/push", { cookie, body: { submissionId: SUB(96), action: "on", endpoint: "https://evil.example/x" } })).json.code, "not-an-option");
    assert.equal((await call(port, "POST", "/api/push", { cookie, body: { submissionId: SUB(97), action: "on", endpoint: "https://web.push.apple.com/QGx" } })).status, 200);
    assert.equal((await call(port, "GET", "/api/push", { cookie })).json.on, true);
    const open = await stream(port, cookie);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await companion.nudge(hub), [], "the page is open: no notice");
    open.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await companion.nudge(hub), [201]);
    assert.deepEqual(await companion.nudge(hub), [], "one a minute at most");
    clock += 61_000;
    pushStatus = 410;
    assert.deepEqual(await companion.nudge(hub), [410]);
    assert.equal((await call(port, "GET", "/api/push", { cookie })).json.on, false, "a gone subscription is dropped");
    assert.deepEqual(pushed, ["https://web.push.apple.com/QGx", "https://web.push.apple.com/QGx"]);
    pushStatus = 201;
  });

  await check("server: a tapped tool line reads its detail; a malformed id is refused (MC8)", async () => {
    pi.emit("event", { type: "tool_execution_start", toolCallId: "call_7", toolName: "read", args: { path: "a.sql" } });
    const read = await call(port, "GET", "/api/detail?id=t%3Acall_7", { cookie });
    assert.equal(read.status, 200);
    assert.equal(read.json.detail.name, "read");
    assert.equal((await call(port, "GET", "/api/detail?id=..%2Fetc", { cookie })).json.code, "bad-request");
    assert.equal((await call(port, "GET", "/api/detail?id=t%3Agone", { cookie })).status, 404);
    // OpenAI's tool call ids carry a "|" (MC4 on the VM).
    pi.emit("event", { type: "tool_execution_start", toolCallId: "call_8|fc_9", toolName: "bash", args: { command: "ls" } });
    const piped = await call(port, "GET", `/api/detail?id=${encodeURIComponent("t:call_8|fc_9")}`, { cookie });
    assert.equal(piped.status, 200);
    assert.equal(piped.json.detail.name, "bash");
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

  await check("server: a new session at the desk ends the phone's stream without a write after end (MC4)", async () => {
    const s = await stream(port, cookie);
    await new Promise((r) => setTimeout(r, 20));
    hub.renew();
    pi.emit("event", { type: "agent_start" });
    await s.ended;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await call(port, "GET", "/api/snapshot", { cookie })).json.code, "access-off");
    hub.setAccess(true);
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

  await check("server: no window with access on refuses everything, as access off", async () => {
    activeHub = null;
    const { code } = store.startPairing({ windowsUser: "VM\\aaron", client: "Example Co" });
    const res = await call(port, "POST", "/api/pair", { body: { code, deviceName: "phone" } });
    const fresh = String(res.headers["set-cookie"]).split(";")[0];
    assert.equal((await call(port, "GET", "/api/snapshot", { cookie: fresh })).json.code, "access-off");
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

// ---- pair once (Aaron, 2026-10-07): one app switch, the phone picks the tab ----------
await check("hub: with the app switch on, a desk new session, a switch and a new Pi keep phone access", () => {
  let appOn = true;
  const { pi, hub } = newHub({ appAccess: () => appOn });
  assert.equal(hub.accessOn, true, "a new Pi starts with access when the app switch is on");
  const before = hub.incarnation;
  const seen = [];
  hub.on("event", (e) => seen.push(e));
  hub.renew();
  assert.equal(hub.accessOn, true);
  assert.notEqual(hub.incarnation, before, "still a new incarnation");
  assert.equal(seen.at(-1).type, "session", "the phone hears the new session and reloads onto it");
  pi.exit();
  assert.equal(hub.accessOn, false, "no Pi, no access");
  hub.attach(new FakePi());
  assert.equal(hub.accessOn, true, "a restarted Pi follows the switch");
  appOn = false;
  hub.renew();
  assert.equal(hub.accessOn, false, "switch off: a new session has none");
  assert.equal(newHub({ appAccess: () => true, client: "" }).hub.accessOn, false, "a tab with no client never has access");
});

{
  const dir = mkdtempSync(join(tmpdir(), "coop-companion-tabs-"));
  const tabStore = new DeviceStore(join(dir, "devices.json"));
  const one = newHub({ appAccess: () => true });
  const two = newHub({ appAccess: () => true });
  const other = newHub({ appAccess: () => true, client: "Other Co" });
  two.hub.setSessionName("report tidy");
  let rows = [
    { id: 1, hub: one.hub, label: "New session", folder: "fabric", working: false, asking: false },
    { id: 2, hub: two.hub, label: "Tidy the report", folder: "fabric", working: true, asking: false },
    { id: 3, hub: other.hub, label: "Other client", folder: "other", working: false, asking: false },
  ];
  const tabAudit = [];
  const server = createCompanionServer({ store: tabStore, tabs: () => rows, origin: ORIGIN, webRoot, audit: (e) => tabAudit.push(e), port: 0 });
  await server.listen();
  const tport = server.server.address().port;
  const pair = async (name, extra = {}) => {
    const { code } = tabStore.startPairing({ windowsUser: "VM\\aaron", client: "Example Co" });
    const res = await call(tport, "POST", "/api/pair", { body: { code, deviceName: name }, ...extra });
    return String(res.headers["set-cookie"]).split(";")[0];
  };
  try {
    const phone = await pair("Aaron's iPhone");
    await check("tabs: the phone lists only the open tabs on its own client, and uses the front one", async () => {
      const res = await call(tport, "GET", "/api/tabs", { cookie: phone });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.tabs.map((t) => [t.id, t.current]), [[1, true], [2, false]]);
      assert.equal(res.json.tabs[1].sessionName, "report tidy");
      assert.equal(res.json.tabs[1].working, true);
      assert.equal((await call(tport, "GET", "/api/snapshot", { cookie: phone })).json.snapshot.incarnation, one.hub.incarnation);
    });
    await check("tabs: picking a tab moves the phone there; writes for the old tab are refused as wrong-session", async () => {
      const live = await stream(tport, phone);
      const res = await call(tport, "POST", "/api/tabs", { cookie: phone, body: { submissionId: SUB(901), tabId: 2 } });
      assert.equal(res.status, 200);
      await live.ended;
      assert.equal((await call(tport, "GET", "/api/snapshot", { cookie: phone })).json.snapshot.incarnation, two.hub.incarnation);
      const stale = await call(tport, "POST", "/api/stop", { cookie: phone, body: { submissionId: SUB(902), incarnation: one.hub.incarnation } });
      assert.equal(stale.json.code, "wrong-session");
      assert.ok(tabAudit.some((e) => e.kind === "tab" && e.tab === 2));
    });
    await check("tabs: another client's tab cannot be picked, and an unknown tab is not found", async () => {
      for (const tabId of [3, 99]) {
        const res = await call(tport, "POST", "/api/tabs", { cookie: phone, body: { submissionId: SUB(910 + tabId), tabId } });
        assert.equal(res.json.code, "not-found");
      }
      assert.equal((await call(tport, "GET", "/api/snapshot", { cookie: phone })).json.snapshot.client, "Example Co");
    });
    await check("tabs: when the picked tab closes, the phone falls back to the next open one", async () => {
      rows = rows.filter((r) => r.id !== 2);
      assert.equal((await call(tport, "GET", "/api/snapshot", { cookie: phone })).json.snapshot.incarnation, one.hub.incarnation);
    });
    await check("tabs: with only another client's tab open the phone hears wrong-client; with none, access-off", async () => {
      rows = rows.filter((r) => r.id === 3);
      assert.equal((await call(tport, "GET", "/api/snapshot", { cookie: phone })).json.code, "wrong-client");
      rows = [];
      assert.equal((await call(tport, "GET", "/api/snapshot", { cookie: phone })).json.code, "access-off");
    });
    await check("pairing the same phone again replaces its old entry, by its cookie or by its name", async () => {
      const again = await pair("New name", { cookie: phone });
      assert.deepEqual(tabStore.list().map((d) => d.name), ["New name"]);
      assert.equal((await call(tport, "GET", "/api/tabs", { cookie: phone })).json.code, "not-paired", "the old entry is gone");
      await pair("new NAME");
      assert.deepEqual(tabStore.list().map((d) => d.name), ["new NAME"]);
      assert.equal((await call(tport, "GET", "/api/tabs", { cookie: again })).json.code, "not-paired");
      await pair("Work iPad");
      assert.equal(tabStore.list().length, 2, "a phone with another name is a second device");
    });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
  for (const [, ref] of js.matchAll(/from "\.\/(shared\/[^"]+)"/g)) assert.ok(["shared/dialogs.mjs", "shared/markdown.mjs", "shared/attach-note.mjs"].includes(ref));
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
  // Aaron's MC4 feedback: Attach is a paperclip, button labels sit centred on one line,
  // and context and usage lead the status line with MCP lines last.
  assert.match(html, /<button id="attach"[^>]*aria-label="Attach a photo or file"[^>]*><svg[^>]*aria-hidden="true"/);
  assert.match(css, /\.btn \{[^}]*justify-content: center;[^}]*white-space: nowrap;/);
  const app = readFileSync(join(pageDir, "app.js"), "utf8");
  assert.match(app, /panel\.compacting \? "Compacting…" : "", usageLine\(panel\.usage\), \.\.\.lines/);
  // In the background the phone closes its stream on purpose, so the window sends
  // notices, and back in front it resumes from the last event (Aaron, 2026-10-07).
  assert.match(app, /addEventListener\("visibilitychange", \(\) => \{ if \(document\.visibilityState === "hidden"\) pause\(\); else resume\(\); \}\)/);
  assert.match(app, /window\.addEventListener\("pagehide", pause\);/);
  assert.match(app, /function resume\(\) \{[\s\S]*?if \(app\.paused && app\.ready\) \{[\s\S]*?openStream\(\);/);
  // Fields stay at 16px or more in every look, or iPhone Safari zooms the page past the screen (MC4).
  assert.match(css, /input, textarea, select \{ font-size: max\(16px, 1em\); \}/);
  for (const m of css.matchAll(/(?:^|\n)([^{}\n]*\b(?:input|textarea)\b[^{}]*)\{([^}]*)\}/g)) {
    const size = /font-size:\s*(\d+)px/.exec(m[2]);
    assert.ok(!size || Number(size[1]) >= 16, `a field under 16px: ${m[1].trim()}`);
  }
});

console.log(`✓ companion server (MC2) and page (MC3): ${checks} checks`);
