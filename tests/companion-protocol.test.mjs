/**
 * The phone companion's contract (master plan row MC1, desktop/COMPANION.md):
 * request validation, the origin rule, device grants, question classification,
 * answer decisions and reconnect. Pure functions over fixtures; no server, no
 * network, no Pi.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODES, LIMITS, ProtocolError, ROUTES, actionDigest, checkGrant, checkOrigin, classifyQuestion,
  decideAnswer, eventEnvelope, hashSecret, newDeviceSecret, newIncarnation, newPairingCode,
  questionId, resumePoint, secretMatches, validateRequest,
  phoneCommand, phoneCommandList,
} from "../desktop/lib/companion-protocol.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/companion/questions.json"), "utf8"));
let checks = 0;
const ok = (name, fn) => { fn(); checks += 1; };
const refuses = (code, fn) => assert.throws(fn, (error) => error instanceof ProtocolError && error.code === code, `expected ${code}`);

const INC = "AAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_INC = "BBBBBBBBBBBBBBBBBBBBBBBB";
const SUB = "0f8fad5b-d9cb-469f-a165-70867728950e";

// ---- the remote surface ------------------------------------------------------
ok("only fifteen routes exist and every code has a status", () => {
  assert.deepEqual(Object.values(ROUTES).sort(), ["answer", "chat", "control", "dequeue", "detail", "details", "events", "files", "logout", "pair", "sessionAction", "sessions", "snapshot", "stop", "upload"]);
  for (const status of Object.values(CODES)) assert.ok(status >= 400 && status < 600);
});
ok("anything else is not found, including Pi's own commands", () => {
  for (const [method, path] of [["POST", "/api/bash"], ["POST", "/api/rpc"], ["GET", "/api/file"], ["POST", "/api/files"], ["GET", "/api/upload"], ["POST", "/api/new_session"], ["POST", "/api/unlock-prod"], ["DELETE", "/api/pair"], ["GET", "/api/chat"]]) {
    refuses("not-found", () => validateRequest(method, path, {}));
  }
});
ok("bodies over the limit are refused before parsing matters", () => {
  refuses("too-large", () => validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "hi" }, LIMITS.bodyBytes + 1));
});
ok("chat is rebuilt field by field; extra fields, commands and shell lines are refused", () => {
  assert.deepEqual(validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "check the view" }), { op: "chat", submissionId: SUB, incarnation: INC, text: "check the view", mode: "queue", attachments: [] });
  assert.equal(validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "hi", mode: "steer" }).mode, "steer");
  refuses("bad-request", () => validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "hi", mode: "bash" }));
  refuses("bad-request", () => validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "hi", type: "bash" }));
  refuses("bad-request", () => validateRequest("POST", "/api/chat", { submissionId: "1", incarnation: INC, text: "hi" }));
  refuses("bad-request", () => validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "   " }));
  refuses("too-large", () => validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "x".repeat(LIMITS.chatChars + 1) }));
  // A /command passes the shape check; the hub decides against Pi's list (phoneCommand).
  assert.equal(validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "/start" }).text, "/start");
  refuses("desktop-only", () => validateRequest("POST", "/api/chat", { submissionId: SUB, incarnation: INC, text: "  !rm -rf x" }));
});
ok("an answer is exactly one of cancelled, confirmed or value", () => {
  const base = { submissionId: SUB, incarnation: INC, questionId: questionId(INC, "ui-1"), digest: "a".repeat(64) };
  assert.deepEqual(validateRequest("POST", "/api/answer", { ...base, answer: { confirmed: true } }).answer, { confirmed: true });
  assert.deepEqual(validateRequest("POST", "/api/answer", { ...base, answer: { value: "" } }).answer, { value: "" });
  refuses("bad-request", () => validateRequest("POST", "/api/answer", { ...base, answer: { confirmed: true, value: "x" } }));
  refuses("bad-request", () => validateRequest("POST", "/api/answer", { ...base, answer: { cancelled: false } }));
  refuses("bad-request", () => validateRequest("POST", "/api/answer", { ...base, answer: { approveSession: true } }));
  refuses("bad-request", () => validateRequest("POST", "/api/answer", { ...base, questionId: "ui-1", answer: { confirmed: true } }));
});
ok("pairing codes are 8 Crockford characters; dashes, spaces and case are forgiven", () => {
  const code = newPairingCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(validateRequest("POST", "/api/pair", { code: "abcd-efgh", deviceName: "Aaron's phone" }).code, "ABCDEFGH");
  refuses("bad-request", () => validateRequest("POST", "/api/pair", { code: "ABCDEFGI", deviceName: "p" }));
  refuses("too-large", () => validateRequest("POST", "/api/pair", { code: "ABCDEFGH", deviceName: "x".repeat(61) }));
});
ok("writes need the companion's own origin, its header and a JSON body", () => {
  const good = { origin: "https://coop.example", "x-coop-companion": "1", "content-type": "application/json" };
  checkOrigin("POST", good, "https://coop.example");
  checkOrigin("GET", {}, "https://coop.example");
  refuses("bad-origin", () => checkOrigin("POST", { ...good, origin: "https://evil.example" }, "https://coop.example"));
  refuses("bad-origin", () => checkOrigin("POST", { ...good, origin: undefined }, "https://coop.example"));
  refuses("bad-origin", () => checkOrigin("POST", { ...good, "x-coop-companion": undefined }, "https://coop.example"));
  refuses("bad-request", () => checkOrigin("POST", { ...good, "content-type": "text/plain" }, "https://coop.example"));
});

// ---- identity: denied independently of the network ---------------------------
const now = Date.UTC(2026, 9, 6, 12);
const { secret, secretHash } = newDeviceSecret();
const device = { id: "d1", secretHash, windowsUser: "CONTOSO-VM\\aaron", client: "Example Co", createdAt: now - 3600_000, lastSeenAt: now - 60_000, revokedAt: null };
const binding = { windowsUser: "contoso-vm\\Aaron", client: "example co", incarnation: INC, accessOn: true };
ok("the device secret is kept only as a hash and compared in constant time", () => {
  assert.equal(hashSecret(secret), secretHash);
  assert.ok(!JSON.stringify(device).includes(secret));
  assert.ok(secretMatches(secret, secretHash));
  assert.ok(!secretMatches(`${secret}x`, secretHash));
  assert.ok(!secretMatches(secret, "nothex"));
});
ok("the right device on the right user, client and session is allowed", () => {
  assert.equal(checkGrant({ device, secret, binding, now }), null);
  assert.equal(checkGrant({ device, secret, binding, incarnation: INC, now }), null);
});
ok("every wrong identity is refused, each with its own code", () => {
  assert.equal(checkGrant({ device: null, secret, binding, now }), "not-paired");
  assert.equal(checkGrant({ device, secret: "guess", binding, now }), "not-paired");
  assert.equal(checkGrant({ device: { ...device, revokedAt: now - 1 }, secret, binding, now }), "revoked");
  assert.equal(checkGrant({ device: { ...device, createdAt: now - LIMITS.deviceMaxMs - 1, lastSeenAt: now }, secret, binding, now }), "device-expired");
  assert.equal(checkGrant({ device: { ...device, lastSeenAt: now - LIMITS.deviceIdleMs - 1 }, secret, binding, now }), "device-expired");
  assert.equal(checkGrant({ device, secret, binding: { ...binding, windowsUser: "CONTOSO-VM\\other" }, now }), "wrong-user");
  assert.equal(checkGrant({ device, secret, binding: { ...binding, client: "Other Client" }, now }), "wrong-client");
  assert.equal(checkGrant({ device, secret, binding: { ...binding, client: "" }, now }), "wrong-client");
  assert.equal(checkGrant({ device, secret, binding: { ...binding, accessOn: false }, now }), "access-off");
  assert.equal(checkGrant({ device, secret, binding, incarnation: OTHER_INC, now }), "wrong-session");
});
ok("incarnations are fresh and well formed", () => {
  const a = newIncarnation();
  assert.notEqual(a, newIncarnation());
  assert.match(a, /^[A-Za-z0-9_-]{16,64}$/);
});

// ---- questions ---------------------------------------------------------------
for (const item of fixtures.cases) {
  ok(`question: ${item.name}`, () => {
    const q = classifyQuestion(item.request, INC);
    if (item.expect === null) { assert.equal(q, null); return; }
    for (const [key, value] of Object.entries(item.expect)) assert.deepEqual(q[key], value, `${item.name}: ${key}`);
    assert.equal(q.digest, actionDigest(item.request));
    assert.equal(q.questionId, questionId(INC, item.request.id));
    assert.ok(q.options.every((option) => (item.request.options || []).includes(option)), "the phone never offers an option Pi did not");
  });
}
ok("the same Pi dialog has a different id in another session", () => {
  assert.notEqual(questionId(INC, "ui-1"), questionId(OTHER_INC, "ui-1"));
});

const byName = (fragment) => fixtures.cases.find((item) => item.name.includes(fragment)).request;
const open = (request) => ({ ...classifyQuestion(request, INC), state: "open" });
const answer = (q, body, inc = INC) => ({ incarnation: inc, questionId: q.questionId, digest: q.digest, answer: body });

ok("an allowed option reaches Pi exactly as Pi offered it", () => {
  const q = open(byName("session-wide option"));
  assert.deepEqual(decideAnswer({ question: q, request: answer(q, { value: "Allow once" }), incarnation: INC }), { ok: true, response: { type: "extension_ui_response", id: "ui-1", value: "Allow once" } });
});
ok("the session-wide option cannot be picked from the phone", () => {
  const q = open(byName("session-wide option"));
  const widening = byName("session-wide option").options[1];
  assert.deepEqual(decideAnswer({ question: q, request: answer(q, { value: widening }), incarnation: INC }), { ok: false, code: "not-an-option" });
});
ok("a confirm is answered yes or no", () => {
  const q = open(byName("dev: answerable"));
  assert.deepEqual(decideAnswer({ question: q, request: answer(q, { confirmed: true }), incarnation: INC }).response, { type: "extension_ui_response", id: "ui-2", confirmed: true });
  assert.deepEqual(decideAnswer({ question: q, request: answer(q, { value: "yes" }), incarnation: INC }), { ok: false, code: "bad-request" });
});
ok("a production approval cannot be given from the phone, only declined", () => {
  const q = open(byName("production write under a G1 unlock: desktop"));
  assert.deepEqual(decideAnswer({ question: q, request: answer(q, { confirmed: true }), incarnation: INC }), { ok: false, code: "desktop-only" });
  assert.deepEqual(decideAnswer({ question: q, request: answer(q, { confirmed: false }), incarnation: INC }).response, { type: "extension_ui_response", id: "ui-3", confirmed: false });
  const s = open(byName("production MCP write"));
  assert.deepEqual(decideAnswer({ question: s, request: answer(s, { value: "Allow once" }), incarnation: INC }), { ok: false, code: "desktop-only" });
  assert.deepEqual(decideAnswer({ question: s, request: answer(s, { cancelled: true }), incarnation: INC }).response, { type: "extension_ui_response", id: "ui-4", cancelled: true });
});
ok("stale, altered, resolved and wrong-session answers are refused", () => {
  const q = open(byName("dev: answerable"));
  const yes = answer(q, { confirmed: true });
  assert.equal(decideAnswer({ question: q, request: yes, incarnation: OTHER_INC }).code, "wrong-session");
  assert.equal(decideAnswer({ question: q, request: answer(q, { confirmed: true }, OTHER_INC), incarnation: INC }).code, "wrong-session");
  assert.equal(decideAnswer({ question: undefined, request: yes, incarnation: INC }).code, "unknown-question");
  assert.equal(decideAnswer({ question: { ...q, state: "answered" }, request: yes, incarnation: INC }).code, "already-answered");
  assert.equal(decideAnswer({ question: { ...q, state: "expired" }, request: yes, incarnation: INC }).code, "expired");
  assert.equal(decideAnswer({ question: { ...q, state: "cancelled" }, request: yes, incarnation: INC }).code, "cancelled");
  assert.equal(decideAnswer({ question: q, request: { ...yes, digest: "0".repeat(64) }, incarnation: INC }).code, "changed");
  assert.equal(decideAnswer({ question: q, request: { ...yes, questionId: questionId(INC, "ui-9") }, incarnation: INC }).code, "unknown-question");
});
ok("a changed command text changes the digest", () => {
  const request = byName("dev: answerable");
  assert.notEqual(actionDigest(request), actionDigest({ ...request, message: request.message.replace("Id = 7", "Id = 8") }));
});
ok("input and editor take text, empty included", () => {
  const q = open(byName("editor"));
  assert.deepEqual(decideAnswer({ question: q, request: answer(q, { value: "" }), incarnation: INC }).response, { type: "extension_ui_response", id: "ui-7", value: "" });
});

// ---- events and reconnect ----------------------------------------------------
ok("events carry the session and a sequence number; unknown types are refused", () => {
  const event = eventEnvelope({ seq: 4, incarnation: INC, type: "status", data: { state: "running" }, at: 1 });
  assert.deepEqual(event, { v: 1, id: `${INC}:4`, seq: 4, incarnation: INC, type: "status", at: 1, data: { state: "running" } });
  assert.throws(() => eventEnvelope({ seq: 1, incarnation: INC, type: "bash_execution_update", data: {} }));
  assert.throws(() => eventEnvelope({ seq: 0, incarnation: INC, type: "status", data: {} }));
});
ok("reconnect replays only a gap-free tail of the same session; otherwise the snapshot", () => {
  const buffer = { incarnation: INC, firstSeq: 100, lastSeq: 250 };
  assert.deepEqual(resumePoint("", buffer), { mode: "snapshot", reason: "first-connect" });
  assert.deepEqual(resumePoint(`${INC}:250`, buffer), { mode: "replay", from: 251 });
  assert.deepEqual(resumePoint(`${INC}:120`, buffer), { mode: "replay", from: 121 });
  assert.deepEqual(resumePoint(`${INC}:99`, buffer), { mode: "replay", from: 100 });
  assert.deepEqual(resumePoint(`${INC}:98`, buffer), { mode: "snapshot", reason: "gap" });
  assert.deepEqual(resumePoint(`${INC}:251`, buffer), { mode: "snapshot", reason: "ahead" });
  assert.deepEqual(resumePoint(`${OTHER_INC}:120`, buffer), { mode: "snapshot", reason: "session-changed" });
  assert.deepEqual(resumePoint(`${INC}:5`, { incarnation: INC, firstSeq: 0, lastSeq: 9 }), { mode: "snapshot", reason: "gap" });
  assert.deepEqual(resumePoint("garbage", buffer), { mode: "snapshot", reason: "first-connect" });
});

ok("/ commands (MC6): Pi's own commands pass; built-ins, terminal screens and unknown names do not", () => {
  const pi = [{ name: "start", description: "Start here\nmore", source: "extension" }, { name: "spec-first", source: "prompt" }, { name: "skill:coop-workflow", source: "skill" }, { name: "pets", source: "extension" }];
  assert.deepEqual(phoneCommand("/start", pi), { ok: true });
  assert.deepEqual(phoneCommand("  /skill:coop-workflow tidy the view", pi), { ok: true });
  assert.deepEqual(phoneCommand("plain text", pi), { ok: true });
  for (const builtin of ["/new", "/model x", "/trust", "/quit", "/login"]) assert.equal(phoneCommand(builtin, pi).code, "desktop-only");
  assert.equal(phoneCommand("/pets", pi).code, "desktop-only");
  assert.equal(phoneCommand("/nope", pi).code, "unknown-command");
  assert.deepEqual(phoneCommandList(pi).map((c) => c.name), ["start", "spec-first", "skill:coop-workflow"]);
  assert.equal(phoneCommandList(pi)[0].description, "Start here");
});

ok("session controls (MC7): model, thinking, compact and name, each with only its own fields", () => {
  const base = { submissionId: SUB, incarnation: INC };
  const v = (body) => validateRequest("POST", "/api/session", { ...base, ...body });
  assert.deepEqual(v({ action: "model", provider: "openai", modelId: "gpt-5" }), { op: "control", ...base, action: "model", provider: "openai", modelId: "gpt-5" });
  assert.equal(v({ action: "thinking", level: "high" }).level, "high");
  assert.deepEqual(v({ action: "compact" }), { op: "control", ...base, action: "compact" });
  assert.equal(v({ action: "compact", instructions: "keep the SQL" }).instructions, "keep the SQL");
  assert.equal(v({ action: "name", name: "  Sales views  " }).name, "Sales views");
  assert.equal(validateRequest("GET", "/api/session", null).op, "details");
  for (const bad of [{ action: "bash", command: "dir" }, { action: "thinking", level: "huge" }, { action: "model", provider: "openai" }, { action: "thinking", level: "high", name: "x" }, { action: "name", name: " " }, { action: "set_auto_compaction" }]) {
    assert.throws(() => v(bad), ProtocolError, JSON.stringify(bad));
  }
  assert.equal(phoneCommand("/model", []).code, "desktop-only");
  assert.match(phoneCommand("/model", []).message, /menu: Model/);
});

ok("session actions (MC9): ids only, never a path", () => {
  const base = { submissionId: SUB, incarnation: INC };
  const v = (body) => validateRequest("POST", "/api/sessions", { ...base, ...body });
  assert.deepEqual(v({ action: "new" }), { op: "sessionAction", ...base, action: "new" });
  assert.equal(v({ action: "resume", sessionId: "0193-abc" }).sessionId, "0193-abc");
  assert.equal(v({ action: "fork", entryId: "e2" }).entryId, "e2");
  for (const bad of [{ action: "resume", sessionId: "C:\\x\\s.jsonl" }, { action: "resume", sessionPath: "/x" }, { action: "new", sessionId: "s" }, { action: "delete" }, { action: "fork" }]) {
    assert.throws(() => v(bad), ProtocolError, JSON.stringify(bad));
  }
});

ok("photos and files (MC10): a plain name and base64, the big body only on the upload route", () => {
  const base = { submissionId: SUB, incarnation: INC };
  const up = (body, raw = 0) => validateRequest("POST", "/api/upload", { ...base, ...body }, raw);
  assert.deepEqual(up({ name: " IMG_1.jpg ", data: "QUJD" }), { op: "upload", ...base, name: "IMG_1.jpg", data: "QUJD" });
  for (const bad of [{ name: "../x.txt", data: "QQ==" }, { name: "C:x", data: "QQ==" }, { name: "..", data: "QQ==" }, { name: "a.txt", data: "not base64!" }, { name: "a.txt", data: "" }, { name: "a.txt", data: "QQ==", path: "/x" }]) {
    assert.throws(() => up(bad), ProtocolError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => up({ name: "a.txt", data: "QQ==" }, LIMITS.bodyBytes * 10));
  assert.throws(() => up({ name: "a.txt", data: "QQ==" }, LIMITS.uploadBytes + 1), (e) => e.code === "too-large");
  assert.throws(() => validateRequest("POST", "/api/chat", { ...base, text: "hi" }, LIMITS.bodyBytes + 1), (e) => e.code === "too-large");
  const chat = (body) => validateRequest("POST", "/api/chat", { ...base, ...body });
  const id = `u${"a".repeat(24)}`;
  assert.deepEqual(chat({ text: "", attachments: [id] }).attachments, [id]);
  assert.deepEqual(chat({ text: "hi" }).attachments, []);
  for (const bad of [{ text: "" }, { text: "x", attachments: ["/etc/passwd"] }, { text: "x", attachments: [id, id] }, { text: "x", attachments: Array.from({ length: 11 }, (_, i) => `u${String(i).padStart(24, "0")}`) }]) {
    assert.throws(() => chat(bad), ProtocolError, JSON.stringify(bad));
  }
  assert.equal(phoneCommand("/fork").message, "On the phone, /fork is in the menu: Sessions");
});

console.log(`✓ companion protocol (MC1): ${checks} checks`);
