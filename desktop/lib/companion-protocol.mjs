// The phone companion's contract (master plan section 12.4, row MC1). The
// window's companion server (MC2) and the phone page (MC3) both import this
// file; the reasons behind each rule are in desktop/COMPANION.md.
//
// Everything here is a pure decision over plain data: what a request may
// carry, whether a device may act on this session, what a question shows on
// the phone, whether an answer is accepted and what Pi receives, and whether a
// reconnecting phone replays events or reloads the snapshot. Nothing listens,
// stores or talks to Pi; MC2 wires these decisions to the live PiSession.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { buildUiResponse, CommandError } from "./rpc-commands.mjs";
import { BUILTINS, TERMINAL_ONLY } from "../renderer/commands.mjs";

export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  bodyBytes: 96 * 1024,
  chatChars: 16_000,
  answerChars: 64_000,
  deviceNameChars: 60,
  requestsPerMinute: 60,
  answersPerMinute: 20,
  pairFailuresPerHour: 5,
  pairingCodeMs: 5 * 60_000,
  deviceIdleMs: 7 * 24 * 3600_000,
  deviceMaxMs: 30 * 24 * 3600_000,
  eventBufferCount: 2000,
  eventBufferMs: 15 * 60_000,
  submissionMemoryMs: 10 * 60_000,
});

/** The whole remote surface. Anything else is a 404, never a pass-through to Pi. */
export const ROUTES = Object.freeze({
  "POST /api/pair": "pair",
  "GET /api/snapshot": "snapshot",
  "GET /api/events": "events",
  "POST /api/chat": "chat",
  "POST /api/stop": "stop",
  "POST /api/dequeue": "dequeue",
  "POST /api/answer": "answer",
  "POST /api/logout": "logout",
});

/** Refusal codes the phone shows in words; each maps to one HTTP status. */
export const CODES = Object.freeze({
  "bad-request": 400,
  "not-paired": 401,
  "revoked": 401,
  "device-expired": 401,
  "bad-origin": 403,
  "wrong-user": 403,
  "wrong-client": 403,
  "access-off": 403,
  "not-found": 404,
  "wrong-session": 409,
  "unknown-question": 409,
  "already-answered": 409,
  "expired": 409,
  "cancelled": 409,
  "changed": 409,
  "too-large": 413,
  "desktop-only": 422,
  "unknown-command": 422,
  "not-an-option": 422,
  "rate-limited": 429,
  "pi-not-running": 503,
});

export class ProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = CODES[code] ? code : "bad-request";
    this.status = CODES[this.code];
  }
}

const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INCARNATION = /^[A-Za-z0-9_-]{16,64}$/;
const QUESTION_ID = /^q[0-9a-f]{24}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// Crockford base32 without I, L, O, U: read off the window and typed on a phone.
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

function field(body, name, pattern) {
  const value = body[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new ProtocolError("bad-request", `${name} is missing or malformed`);
  return value;
}

function onlyKeys(body, keys) {
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new ProtocolError("bad-request", `unexpected field ${key.slice(0, 40)}`);
}

function plainText(value, name, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new ProtocolError("bad-request", `${name} must be text`);
  if (!allowEmpty && !value.trim()) throw new ProtocolError("bad-request", `${name} is empty`);
  if (value.length > max) throw new ProtocolError("too-large", `${name} is too long`);
  if (value.includes("\0")) throw new ProtocolError("bad-request", `${name} contains a null character`);
  return value;
}

/**
 * Cookie-authenticated writes must come from the companion's own page: the
 * Origin header equals the one origin the window serves, the body is JSON and
 * carries the custom header a cross-site form cannot set.
 */
export function checkOrigin(method, headers, allowedOrigin) {
  if (method === "GET") return;
  const get = (name) => headers[name] ?? headers[name.toLowerCase()];
  if (typeof allowedOrigin !== "string" || !allowedOrigin || get("origin") !== allowedOrigin) throw new ProtocolError("bad-origin");
  if (get("x-coop-companion") !== String(PROTOCOL_VERSION)) throw new ProtocolError("bad-origin");
  if (!/^application\/json(;|$)/i.test(String(get("content-type") || ""))) throw new ProtocolError("bad-request", "body must be JSON");
}

/**
 * One request, rebuilt field by field. `body` is the parsed JSON (null for GET);
 * `rawBytes` its size before parsing. Returns `{ op, ...fields }`.
 */
export function validateRequest(method, path, body, rawBytes = 0) {
  const op = ROUTES[`${method} ${path}`];
  if (!op) throw new ProtocolError("not-found");
  if (rawBytes > LIMITS.bodyBytes) throw new ProtocolError("too-large");
  if (method === "GET") return { op };
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProtocolError("bad-request", "body missing");
  switch (op) {
    case "pair": {
      onlyKeys(body, ["code", "deviceName"]);
      const code = String(body.code ?? "").toUpperCase().replace(/[\s-]/g, "");
      if (!PAIRING_CODE.test(code)) throw new ProtocolError("bad-request", "pairing code is malformed");
      return { op, code, deviceName: plainText(body.deviceName, "device name", LIMITS.deviceNameChars).trim() };
    }
    case "chat": {
      onlyKeys(body, ["submissionId", "incarnation", "text", "mode"]);
      const text = plainText(body.text, "message", LIMITS.chatChars);
      // A `!` line is a shell on the VM: desktop only (MC1). Slash commands are
      // checked by the hub against Pi's own list (phoneCommand, MC6).
      if (/^\s*!/.test(text)) throw new ProtocolError("desktop-only", "a ! line runs a shell on the VM: use the coop window");
      const mode = body.mode === undefined ? "queue" : body.mode;
      if (mode !== "queue" && mode !== "steer") throw new ProtocolError("bad-request", "mode is queue or steer");
      return { op, submissionId: field(body, "submissionId", SUBMISSION_ID), incarnation: field(body, "incarnation", INCARNATION), text, mode };
    }
    case "stop":
    case "dequeue":
      onlyKeys(body, ["submissionId", "incarnation"]);
      return { op, submissionId: field(body, "submissionId", SUBMISSION_ID), incarnation: field(body, "incarnation", INCARNATION) };
    case "answer": {
      onlyKeys(body, ["submissionId", "incarnation", "questionId", "digest", "answer"]);
      const answer = body.answer;
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new ProtocolError("bad-request", "answer missing");
      onlyKeys(answer, ["cancelled", "confirmed", "value"]);
      const kinds = ["cancelled", "confirmed", "value"].filter((key) => answer[key] !== undefined);
      if (kinds.length !== 1) throw new ProtocolError("bad-request", "an answer is exactly one of cancelled, confirmed or value");
      let clean;
      if (kinds[0] === "cancelled") {
        if (answer.cancelled !== true) throw new ProtocolError("bad-request", "cancelled must be true");
        clean = { cancelled: true };
      } else if (kinds[0] === "confirmed") {
        if (typeof answer.confirmed !== "boolean") throw new ProtocolError("bad-request", "confirmed must be true or false");
        clean = { confirmed: answer.confirmed };
      } else {
        clean = { value: plainText(answer.value, "answer", LIMITS.answerChars, { allowEmpty: true }) };
      }
      return {
        op,
        submissionId: field(body, "submissionId", SUBMISSION_ID),
        incarnation: field(body, "incarnation", INCARNATION),
        questionId: field(body, "questionId", QUESTION_ID),
        digest: field(body, "digest", DIGEST),
        answer: clean,
      };
    }
    case "logout":
      onlyKeys(body, []);
      return { op };
    default:
      throw new ProtocolError("not-found");
  }
}

// ---- identity: pairing codes, device secrets, grants -------------------------

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A one-time pairing code for the window to show: 8 characters, ~40 bits, 5 minutes, one use. */
export function newPairingCode(random = randomBytes) {
  const bytes = random(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) code += PAIRING_ALPHABET[bytes[i] % 32];
  return code;
}

/** A device secret (the cookie value) and the hash the VM keeps. The secret itself is never stored. */
export function newDeviceSecret(random = randomBytes) {
  const secret = random(32).toString("base64url");
  return { secret, secretHash: sha256(secret) };
}

export const hashSecret = (secret) => sha256(String(secret));

/** Constant-time compare of a presented secret against a stored hash. */
export function secretMatches(secret, secretHash) {
  if (typeof secret !== "string" || typeof secretHash !== "string" || !DIGEST.test(secretHash)) return false;
  const a = Buffer.from(sha256(secret), "hex");
  const b = Buffer.from(secretHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * May this device act on this live session? Checked on every request, after
 * the private network has let the request through and whatever it says:
 *
 * - device: the stored record `{ id, secretHash, windowsUser, client, createdAt, lastSeenAt, revokedAt }`
 * - secret: the cookie the phone presented
 * - binding: the window's live state `{ windowsUser, client, incarnation, accessOn }`
 * - incarnation: the session the request names (writes), or undefined (reads)
 *
 * Returns null when allowed, else a refusal code.
 */
export function checkGrant({ device, secret, binding, incarnation, now = Date.now() }) {
  if (!device || !secretMatches(secret, device.secretHash)) return "not-paired";
  if (device.revokedAt) return "revoked";
  if (now - device.createdAt > LIMITS.deviceMaxMs || now - (device.lastSeenAt || device.createdAt) > LIMITS.deviceIdleMs) return "device-expired";
  if (!binding || !sameName(device.windowsUser, binding.windowsUser)) return "wrong-user";
  if (!sameName(device.client, binding.client)) return "wrong-client";
  if (binding.accessOn !== true) return "access-off";
  if (incarnation !== undefined && incarnation !== binding.incarnation) return "wrong-session";
  return null;
}

/** A new session incarnation: changes on every Pi start, /new, session switch, project switch and window restart. */
export const newIncarnation = (random = randomBytes) => random(18).toString("base64url");

// ---- questions ---------------------------------------------------------------

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
// coop-guardrails writes production writes in capitals (G1): "PRODUCTION write
// under unlock ...", "PRODUCTION Warehouse SQL mutation/DDL call".
const PRODUCTION = /\bPRODUCTION\b/;
// Options that grant more than the one action shown, such as coop-guardrails'
// "Allow <server> edits for this session (...)".
const WIDENING = /\bfor (this|the rest of the) session\b|\balways\b|\bdon'?t ask again\b/i;

/** SHA-256 over the exact action: method, title, message and options as Pi sent them. */
export function actionDigest(request) {
  const canonical = JSON.stringify([
    String(request.method || ""),
    String(request.title || ""),
    String(request.message || ""),
    Array.isArray(request.options) ? request.options.map(String) : [],
  ]);
  return sha256(canonical);
}

/** The phone's id for a Pi dialog: opaque, and different in every session incarnation. */
export const questionId = (incarnation, piId) => `q${sha256(`${incarnation}\n${piId}`).slice(0, 24)}`;

/**
 * What the phone shows for one Pi extension_ui_request, or null when it is not
 * a question. `phone` is "answer" or "desktop" (shown read-only with "Continue
 * on the desktop"); `options` is what the phone may pick from, never more than
 * Pi offered; `hidden` counts the options kept for the desktop.
 */
export function classifyQuestion(request, incarnation) {
  if (!request || request.type !== "extension_ui_request" || !DIALOGS.has(request.method) || typeof request.id !== "string") return null;
  const base = {
    questionId: questionId(incarnation, request.id),
    piId: request.id,
    method: request.method,
    title: String(request.title || ""),
    message: String(request.message || ""),
    digest: actionDigest(request),
    timeoutMs: Number.isSafeInteger(request.timeout) && request.timeout > 0 ? request.timeout : null,
    // What the desktop's input and editor cards start with.
    placeholder: typeof request.placeholder === "string" ? request.placeholder.slice(0, 200) : "",
    prefill: request.method === "editor" && typeof request.prefill === "string" ? request.prefill.slice(0, LIMITS.answerChars) : "",
  };
  if (PRODUCTION.test(base.title) || PRODUCTION.test(base.message)) {
    return { ...base, phone: "desktop", reason: "production", options: [], hidden: Array.isArray(request.options) ? request.options.length : 0 };
  }
  if (request.method !== "select") return { ...base, phone: "answer", reason: "", options: [], hidden: 0 };
  const all = Array.isArray(request.options) ? request.options.map(String) : [];
  if (PRODUCTION.test(all.join("\n"))) return { ...base, phone: "desktop", reason: "production", options: [], hidden: all.length };
  const options = all.filter((option) => !WIDENING.test(option));
  if (options.length === 0) return { ...base, phone: "desktop", reason: "session-wide", options: [], hidden: all.length };
  return { ...base, phone: "answer", reason: "", options, hidden: all.length - options.length };
}

/**
 * Decide one phone answer. `question` is classifyQuestion's result plus
 * `state` ("open", "answered", "expired", "cancelled"); `incarnation` the live
 * session's. Returns `{ ok: true, response }` with the extension_ui_response
 * for Pi, or `{ ok: false, code }`. MC2 runs this and the state change in one
 * synchronous step so the first valid answer, from either screen, wins.
 */
export function decideAnswer({ question, request, incarnation }) {
  if (request.incarnation !== incarnation) return { ok: false, code: "wrong-session" };
  if (!question || question.questionId !== request.questionId) return { ok: false, code: "unknown-question" };
  if (question.state === "answered") return { ok: false, code: "already-answered" };
  if (question.state === "expired") return { ok: false, code: "expired" };
  if (question.state === "cancelled") return { ok: false, code: "cancelled" };
  if (question.state !== "open") return { ok: false, code: "unknown-question" };
  if (request.digest !== question.digest) return { ok: false, code: "changed" };
  // Declining is always allowed, even on a desktop-only question.
  const declines = request.answer.cancelled === true || request.answer.confirmed === false;
  if (question.phone !== "answer" && !declines) return { ok: false, code: "desktop-only" };
  if (question.method === "confirm" && request.answer.value !== undefined) return { ok: false, code: "bad-request" };
  if (question.method !== "confirm" && request.answer.confirmed !== undefined) return { ok: false, code: "bad-request" };
  if (question.phone !== "answer" && request.answer.confirmed === false) {
    return { ok: true, response: { type: "extension_ui_response", id: question.piId, confirmed: false } };
  }
  try {
    const response = buildUiResponse({ id: question.piId, method: question.method, options: question.options }, request.answer);
    return { ok: true, response };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, code: question.method === "select" ? "not-an-option" : "bad-request" };
    throw error;
  }
}

// ---- slash commands (MC6) ----------------------------------------------------

const BUILTIN_NAMES = new Set(BUILTINS.map((command) => command.name));

/**
 * Whether a phone message that starts with `/` may go to Pi as typed. Pi's
 * built-ins belong to its terminal UI (the window runs them itself), so they
 * wait for their own rows (MC7, MC9) or stay in the terminal; the extension
 * screens that exist only in the terminal stay there; anything else must be a
 * command Pi listed (`get_commands`: extensions, prompt templates, skills).
 * `piCommands` is that list. Returns `{ ok: true }` or `{ ok: false, code, message }`.
 */
export function phoneCommand(text, piCommands = []) {
  const match = /^\s*\/([A-Za-z0-9:._-]+)/.exec(String(text || ""));
  if (!match) return { ok: true };
  const name = match[1];
  if (BUILTIN_NAMES.has(name)) return { ok: false, code: "desktop-only", message: `/${name} runs in the coop window for now` };
  if (Object.hasOwn(TERMINAL_ONLY, name)) return { ok: false, code: "desktop-only", message: `/${name} opens ${TERMINAL_ONLY[name]}, which exists only in the terminal` };
  const known = Array.isArray(piCommands) && piCommands.some((command) => command && command.name === name);
  return known ? { ok: true } : { ok: false, code: "unknown-command", message: `coop has no /${name} command` };
}

/** The commands the phone lists when you type `/`: Pi's own, minus the ones above. */
export function phoneCommandList(piCommands = []) {
  return (Array.isArray(piCommands) ? piCommands : [])
    .filter((command) => command && typeof command.name === "string" && phoneCommand(`/${command.name}`, piCommands).ok)
    .map((command) => ({ name: command.name, description: String(command.description || "").split("\n")[0].slice(0, 200), source: String(command.source || "") }));
}

// ---- events and reconnect ----------------------------------------------------

/** The only event types the phone receives; MC2 maps Pi's RPC events onto these. */
export const EVENT_TYPES = Object.freeze([
  "status",            // { state: "idle" | "running" | "exited", queue?: { steering: [], followUp: [] } }
  "message",           // { id, role: "user" | "assistant", text, final }
  "tool",              // { id, name, label, state: "running" | "done" | "error" }
  "question",          // classifyQuestion's result without piId
  "question_resolved", // { questionId, outcome: "answered" | "expired" | "cancelled", by: "desktop" | "phone" | "pi" }
  "notice",            // { level: "info" | "warning" | "error", text }
  "session",           // { incarnation, windowsUser, client, sessionName }
]);

/** One event as sent on the stream; `id` is the SSE id the phone echoes in Last-Event-ID. */
export function eventEnvelope({ seq, incarnation, type, data, at = Date.now() }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`not a companion event: ${type}`);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("seq must be a positive integer");
  return { v: PROTOCOL_VERSION, id: `${incarnation}:${seq}`, seq, incarnation, type, at, data };
}

/**
 * A reconnecting phone: replay from the buffer, or reload the snapshot.
 * `lastEventId` is the Last-Event-ID header ("incarnation:seq", or empty);
 * `buffer` is `{ incarnation, firstSeq, lastSeq }` (firstSeq 0 when empty).
 */
export function resumePoint(lastEventId, buffer) {
  const match = /^([A-Za-z0-9_-]{16,64}):(\d{1,15})$/.exec(String(lastEventId || ""));
  if (!match) return { mode: "snapshot", reason: "first-connect" };
  const [, incarnation, seqText] = match;
  const seq = Number(seqText);
  if (incarnation !== buffer.incarnation) return { mode: "snapshot", reason: "session-changed" };
  if (seq > buffer.lastSeq) return { mode: "snapshot", reason: "ahead" };
  if (seq === buffer.lastSeq) return { mode: "replay", from: seq + 1 };
  if (buffer.firstSeq === 0 || seq + 1 < buffer.firstSeq) return { mode: "snapshot", reason: "gap" };
  return { mode: "replay", from: seq + 1 };
}
