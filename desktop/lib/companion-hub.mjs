// One window's side of the phone companion (master plan row MC2, contract in
// desktop/COMPANION.md): the live session's incarnation, the phone's event
// stream and its buffer, the questions Pi is waiting on with one arbiter for
// both screens, and the idempotent chat, stop and answer the phone may send.
// The HTTP server (companion-server.mjs) only authenticates and routes to this.
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import { IMAGE_LIMITS, buildUiResponse } from "./rpc-commands.mjs";
import { attachmentNote } from "../renderer/attach-note.mjs";
import { imageBudgetProblem } from "../renderer/draft.mjs";
import { TODO_TOOL, applyTodoResult, createTodos, startTurn, todoLines, todosFromMessages } from "../renderer/todos.mjs";
import {
  LIMITS, ProtocolError, classifyQuestion, decideAnswer, eventEnvelope, newIncarnation, phoneCommand, phoneCommandList, resumePoint,
} from "./companion-protocol.mjs";

const SNAPSHOT_MESSAGES = 200;
const NOTICE_CHARS = 500;
const FLUSH_MS = 200;
// The status line and widgets above the prompt (MC8), bounded as notices are.
const PANEL_LINES = 40;
const PANEL_CHARS = 300;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Tool arguments and output and thinking, fetched on tap (MC8): bounded, kept in memory only.
const DETAIL_KEEP = 300;
const DETAIL_ARGS_CHARS = 4000;
const DETAIL_TEXT_CHARS = 16_000;
// Photos and files from the phone (MC10) wait here, per device, until a chat names them.
const UPLOAD_KEEP = 10;
const UPLOAD_MS = 30 * 60_000;
const RELOAD_CARRY_MS = 60_000;
// The session tree (MC9): what the window's default view shows, as rows.
const TREE_ROWS = 400;
const TREE_TEXT_CHARS = 160;
const TREE_ROLES = new Set(["user", "assistant", "compactionSummary", "branchSummary", "compaction", "branch_summary"]);
const PHONE_IMAGE_LIMITS = Object.freeze({ images: IMAGE_LIMITS.maxImages, imageBytes: IMAGE_LIMITS.maxImageBytes, imageTotalBytes: IMAGE_LIMITS.maxTotalBytes });
const thinkingText = (content) => (Array.isArray(content) ? content.filter((p) => p && p.type === "thinking" && typeof p.thinking === "string").map((p) => p.thinking).join("\n\n").trim() : "");
const resultText = (result) => messageText(result && result.content);
/** 12k, 1.2M: the window's token format (renderer/timeline.mjs formatTokens). */
function tokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}
const panelText = (text) => String(text === undefined || text === null ? "" : text).replace(ANSI, "").slice(0, PANEL_CHARS);

/** The text parts of a Pi message's content, joined; thinking and tool calls are left out. */
export function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

/** How many images a user message carried (MC10): the phone shows the count, never the image. */
export function imageCount(content) {
  return Array.isArray(content) ? content.filter((part) => part && part.type === "image").length : 0;
}

/** A tool as the phone sees it: its name and, for file tools, the file's name only. */
export function toolLabel(name, args) {
  const path = args && typeof args === "object" ? args.path || args.file_path || args.filePath : "";
  return typeof path === "string" && path ? basename(path.replace(/\\/g, "/")).slice(0, 80) : "";
}

/** The phone's view of a question: everything but Pi's own id. */
const phoneQuestion = ({ piId, state, timer, request, ...rest }) => ({ ...rest, state });

export class CompanionHub extends EventEmitter {
  /**
   * identity: `{ windowsUser, client }` for this window; `sessionName` optional.
   * The timer and clock are injectable for tests.
   */
  constructor({ windowsUser, client, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random, host = null, appAccess = null } = {}) {
    super();
    // host (MC9, main.mjs): `list()` the folder's saved sessions with their
    // paths, `exportPath()` a file beside the session, `changed(message)` tells
    // the window the phone changed the session; (MC10) `attach(name, bytes)`
    // saves and reads a phone's file as the window attaches one, and
    // `files(query)` lists the folder's files for @ mentions.
    // appAccess (pair once): the window's app-wide phone switch. When given,
    // every new session in this tab follows it, so a paired phone keeps its
    // access through desk new sessions, switches and restarts.
    Object.assign(this, { windowsUser: windowsUser || "", client: client || "", now, setTimer, clearTimer, random, host, appAccess });
    this.pi = null;
    this.incarnation = "";
    this.accessOn = false;
    this.accessRevision = 0;
    this.sessionName = "";
    this.commands = [];
    this.uploads = new Map();
    // A reload the phone asked for (MC9) keeps its access through the restart.
    this.carryUntil = 0;
    this.reset();
  }

  // One continuation belongs to one worker/session and one uninterrupted grant.
  // App-wide pairing lets a NEW request follow a same-client session, but cannot
  // retarget an old control or mix two sessions into one snapshot.
  #scope(authorize = () => null) {
    const pi = this.pi;
    const incarnation = this.incarnation;
    const accessRevision = this.accessRevision;
    const check = () => {
      const denied = authorize();
      if (denied) throw new ProtocolError(denied);
      if (this.accessRevision !== accessRevision) throw new ProtocolError("access-off");
      if (this.pi !== pi || this.incarnation !== incarnation) throw new ProtocolError("wrong-session");
    };
    return {
      check,
      request: async (command, options) => {
        check();
        let response;
        try { response = await pi.request(command, options); }
        finally { check(); }
        return response;
      },
    };
  }

  reset() {
    for (const q of this.questions?.values() || []) if (q.timer) this.clearTimer(q.timer);
    this.seq = 0;
    this.buffer = [];
    this.questions = new Map();
    this.byPiId = new Map();
    this.submissions = new Map();
    this.status = "idle";
    this.queue = { steering: [], followUp: [] };
    this.statuses = new Map();
    this.widgets = new Map();
    this.todos = createTodos();
    // Context and usage, from get_session_stats after each turn (the window's
    // status bar), and whether a compaction is running: the phone's status line.
    this.usage = null;
    this.compacting = false;
    this.kept = new Map();
    this.partial = null;
    if (this.flushTimer) this.clearTimer(this.flushTimer);
    this.flushTimer = null;
  }

  /** What checkGrant compares a device against. */
  get binding() {
    return { windowsUser: this.windowsUser, client: this.client, incarnation: this.incarnation, accessOn: this.accessOn };
  }

  identity() {
    return { incarnation: this.incarnation, windowsUser: this.windowsUser, client: this.client, sessionName: this.sessionName };
  }

  /** What a new session's access is: the app-wide switch, or off when there is none. */
  #followAccess() {
    return typeof this.appAccess === "function" && this.appAccess() === true;
  }

  /** Follow a new Pi (a new incarnation): access follows the app switch, old questions and submissions are void. */
  attach(pi) {
    this.reset();
    this.pi = pi;
    this.incarnation = newIncarnation(this.random);
    const carrying = this.now() < this.carryUntil;
    this.carryUntil = 0;
    if (!carrying) this.setAccess(this.#followAccess(), "session-changed");
    if (pi) {
      pi.on("event", (message) => { if (this.pi === pi) this.onPiEvent(message); });
      pi.on("exit", () => { if (this.pi === pi) this.onPiExit(); });
    }
    this.#push("session", this.identity());
    return this.incarnation;
  }

  /**
   * A new session in this window (/new, a switch, a fork): a new incarnation.
   * Access follows the app switch; without one it ends, unless the phone
   * itself started or opened the session (MC9).
   */
  renew({ keepAccess = false } = {}) {
    const pi = this.pi;
    for (const q of this.questions.values()) if (q.state === "open") this.#close(q, "cancelled", "pi");
    this.reset();
    this.pi = pi;
    this.incarnation = newIncarnation(this.random);
    if (!keepAccess) this.setAccess(this.#followAccess(), "session-changed");
    this.#push("session", this.identity());
  }

  setAccess(on, reason = "") {
    const next = on === true && Boolean(this.pi) && !this.pi.exited && Boolean(this.client);
    if (next === this.accessOn) return this.accessOn;
    this.accessOn = next;
    this.accessRevision += 1;
    this.emit("access", { on: next, reason });
    return next;
  }

  setSessionName(name) {
    this.sessionName = String(name || "").slice(0, 200);
    this.#push("session", this.identity());
  }

  // ---- events --------------------------------------------------------------

  #push(type, data) {
    const event = eventEnvelope({ seq: ++this.seq, incarnation: this.incarnation, type, data, at: this.now() });
    this.buffer.push(event);
    const oldest = this.now() - LIMITS.eventBufferMs;
    while (this.buffer.length > LIMITS.eventBufferCount || (this.buffer.length > 1 && this.buffer[0].at < oldest)) this.buffer.shift();
    this.emit("event", event);
    return event;
  }

  #status(state) {
    if (this.status === state) return;
    // A finished turn is worth a notice on a closed phone page (MC11).
    if (this.status === "running" && state === "idle") this.emit("attention", { kind: "done" });
    this.status = state;
    this.#push("status", { state, queue: this.queue });
  }

  #flush() {
    this.flushTimer = null;
    if (this.partial) this.#push("message", { id: this.partial.id, role: "assistant", text: this.partial.text, final: false });
  }

  onPiEvent(message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "agent_start":
        // A new turn: the rows completed in the last one leave the todo panel.
        startTurn(this.todos);
        this.#status("running");
        if (this.todos.found) this.#pushPanel();
        break;
      case "agent_end":
      case "agent_settled":
        this.#status("idle");
        this.refreshUsage().catch(() => {});
        break;
      // A compaction can run for a while: the phone says so, as the window does.
      case "compaction_start":
        this.compacting = true;
        this.#push("notice", { level: "info", text: message.reason === "manual" ? "Compacting the conversation..." : "The context is nearly full; compacting the conversation..." });
        this.#pushPanel();
        break;
      case "compaction_end": {
        this.compacting = false;
        const result = message.result;
        const text = result
          ? `Compacted the conversation: about ${tokenCount(result.tokensBefore)} tokens down to ${tokenCount(result.estimatedTokensAfter)}.`
          : message.aborted ? "Compaction stopped." : `Compaction failed: ${String(message.errorMessage || "unknown error").slice(0, 300)}`;
        this.#push("notice", { level: result || message.aborted ? "info" : "error", text });
        this.#pushPanel();
        this.refreshUsage().catch(() => {});
        break;
      }
      case "message_start":
        if (message.message && message.message.role === "user") {
          const text = messageText(message.message.content);
          const images = imageCount(message.message.content);
          if (text || images) this.#push("message", { id: `u${this.seq + 1}`, role: "user", text, final: true, ...(images ? { images } : {}) });
        } else if (message.message && message.message.role === "assistant") {
          this.partial = { id: `a${this.seq + 1}`, text: "" };
        }
        break;
      case "message_update": {
        const delta = message.assistantMessageEvent;
        if (!delta || delta.type !== "text_delta" || typeof delta.delta !== "string") break;
        if (!this.partial) this.partial = { id: `a${this.seq + 1}`, text: "" };
        this.partial.text += delta.delta;
        if (!this.flushTimer) this.flushTimer = this.setTimer(() => this.#flush(), FLUSH_MS);
        break;
      }
      case "message_end":
        if (message.message && message.message.role === "assistant") {
          if (this.flushTimer) { this.clearTimer(this.flushTimer); this.flushTimer = null; }
          const id = this.partial ? this.partial.id : `a${this.seq + 1}`;
          this.partial = null;
          const text = messageText(message.message.content);
          const thinking = this.#keepThinking(`m:${id}`, message.message.content);
          if (text) this.#push("message", { id, role: "assistant", text, final: true, ...(thinking ? { thinking: true } : {}) });
        }
        break;
      case "tool_execution_start": {
        const id = String(message.toolCallId || "");
        let args = "";
        try { args = message.args === undefined ? "" : JSON.stringify(message.args, null, 2); } catch { /* not JSON */ }
        this.#keep(`t:${id}`, { kind: "tool", name: String(message.toolName || ""), args: String(args || "").slice(0, DETAIL_ARGS_CHARS), output: "", isError: false });
        this.#push("tool", { id, name: String(message.toolName || ""), label: toolLabel(message.toolName, message.args), state: "running", detail: true });
        break;
      }
      case "tool_execution_end": {
        const id = String(message.toolCallId || "");
        const kept = this.kept.get(`t:${id}`) || { kind: "tool", name: String(message.toolName || ""), args: "" };
        this.#keep(`t:${id}`, { ...kept, output: resultText(message.result).slice(0, DETAIL_TEXT_CHARS), isError: Boolean(message.isError) });
        this.#push("tool", { id, name: String(message.toolName || ""), label: "", state: message.isError ? "error" : "done", detail: true });
        // The todo panel, rebuilt from the `todo` results as the window does (MC8).
        if (message.toolName === TODO_TOOL && applyTodoResult(this.todos, message.result)) this.#pushPanel();
        break;
      }
      case "queue_update":
        this.queue = {
          steering: Array.isArray(message.steering) ? message.steering.map(String) : [],
          followUp: Array.isArray(message.followUp) ? message.followUp.map(String) : [],
        };
        this.#push("status", { state: this.status, queue: this.queue });
        break;
      case "session_info_changed":
        if (typeof message.name === "string") this.setSessionName(message.name);
        break;
      case "extension_ui_request":
        if (message.method === "setStatus") {
          const key = String(message.statusKey || "");
          if (message.statusText) this.statuses.set(key, panelText(message.statusText)); else this.statuses.delete(key);
          this.#pushPanel();
        } else if (message.method === "setWidget") {
          const key = String(message.widgetKey || "");
          if (Array.isArray(message.widgetLines)) this.widgets.set(key, message.widgetLines.slice(0, PANEL_LINES).map(panelText)); else this.widgets.delete(key);
          this.#pushPanel();
        } else if (message.method === "notify") {
          const level = ["info", "warning", "error"].includes(message.notifyType) ? message.notifyType : "info";
          const text = String(message.message || "").trim().slice(0, NOTICE_CHARS);
          if (text) this.#push("notice", { level, text });
        } else {
          this.#openQuestion(message);
        }
        break;
      default:
        break;
    }
  }

  /** The status line, the widgets and the todo panel, as the window shows them above the prompt. */
  panel() {
    return {
      status: [...this.statuses.values()].filter(Boolean),
      usage: this.usage,
      compacting: this.compacting,
      widgets: [...this.widgets].map(([key, lines]) => ({ key: key.slice(0, 80), lines })),
      todo: todoLines(this.todos),
    };
  }

  #keep(key, value) {
    this.kept.delete(key);
    this.kept.set(key, value);
    while (this.kept.size > DETAIL_KEEP) this.kept.delete(this.kept.keys().next().value);
  }

  #keepThinking(key, content) {
    const thinking = thinkingText(content).slice(0, DETAIL_TEXT_CHARS);
    if (thinking) this.#keep(key, { kind: "thinking", thinking });
    return Boolean(thinking);
  }

  /** One tool call's arguments and output, or one answer's thinking, for the phone that taps it (MC8). */
  detail(id) {
    const value = this.kept.get(id);
    return value ? { ok: true, detail: value } : { ok: false, code: "not-found", message: "That detail is no longer kept on the VM" };
  }

  #pushPanel() {
    this.#push("panel", this.panel());
  }

  /** Context and usage as the window's status bar shows them; `push` sends the panel when it changed. */
  async refreshUsage(push = true, scope = this.#scope()) {
    const pi = this.pi;
    if (!pi || pi.exited) return;
    let stats = null;
    try { const r = await scope.request({ type: "get_session_stats" }); stats = r && r.success && r.data ? r.data : null; } catch (error) { if (error instanceof ProtocolError) throw error; stats = null; }
    scope.check();
    if (!stats || this.pi !== pi) return;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const context = stats.contextUsage || {};
    const tokens = stats.tokens || {};
    const usage = { contextPercent: num(context.percent), contextTokens: num(context.tokens), contextWindow: num(context.contextWindow), tokensIn: num(tokens.input), tokensOut: num(tokens.output), cost: num(stats.cost) };
    const changed = JSON.stringify(usage) !== JSON.stringify(this.usage);
    this.usage = usage;
    if (push && changed) this.#pushPanel();
  }

  onPiExit() {
    for (const q of this.questions.values()) if (q.state === "open") this.#close(q, "cancelled", "pi");
    this.partial = null;
    this.#status("exited");
    if (this.now() >= this.carryUntil) this.setAccess(false, "pi-exited");
  }

  // ---- questions: one arbiter for both screens ---------------------------------

  #openQuestion(request) {
    const shape = classifyQuestion(request, this.incarnation);
    if (!shape || this.byPiId.has(request.id)) return;
    const q = { ...shape, state: "open", request, timer: null };
    // Pi ends a dialog with a timeout on its own; the window follows its clock,
    // whether or not a phone is awake.
    if (q.timeoutMs) q.timer = this.setTimer(() => { if (q.state === "open") this.#close(q, "expired", "pi"); }, q.timeoutMs);
    this.questions.set(q.questionId, q);
    this.byPiId.set(request.id, q);
    this.#push("question", phoneQuestion(q));
    this.emit("attention", { kind: "question" });
  }

  #close(q, outcome, by) {
    q.state = outcome;
    if (q.timer) { this.clearTimer(q.timer); q.timer = null; }
    this.#push("question_resolved", { questionId: q.questionId, outcome, by });
    this.emit("resolved", { piId: q.piId, outcome, by });
  }

  /** Open questions as the phone sees them. */
  openQuestions() {
    return [...this.questions.values()].filter((q) => q.state === "open").map(phoneQuestion);
  }

  /**
   * The desktop's answer, through the same arbiter: the desktop may pick any
   * option Pi offered. Returns `{ ok, error? }`; nothing reaches Pi twice.
   */
  answerFromDesktop(piId, answer) {
    if (!this.pi) return { ok: false, error: "no such question" };
    const q = this.byPiId.get(piId);
    if (q && q.state !== "open") return { ok: false, error: q.state === "answered" ? "that question was already answered" : `that question ${q.state === "expired" ? "expired" : "was cancelled"}` };
    const request = q ? q.request : this.pi.dialog(piId);
    if (!request) return { ok: false, error: "that question was already answered" };
    const response = buildUiResponse(request, answer);
    if (q) this.#close(q, "answered", "desktop");
    return { ok: this.pi.answer(response) };
  }

  // ---- phone writes, idempotent per device and submission ------------------------

  #remember(deviceId, submissionId, run) {
    const key = `${deviceId}:${submissionId}`;
    const now = this.now();
    for (const [k, v] of this.submissions) if (now - v.at > LIMITS.submissionMemoryMs) this.submissions.delete(k);
    const known = this.submissions.get(key);
    if (known) return known.result;
    const result = run();
    this.submissions.set(key, { at: now, result });
    return result;
  }

  /** `request` is validateRequest's answer op. Resolves to `{ ok, code? }`. */
  answerFromPhone(deviceId, request) {
    return this.#remember(deviceId, request.submissionId, () => {
      const q = this.questions.get(request.questionId);
      const decision = decideAnswer({ question: q, request, incarnation: this.incarnation });
      if (!decision.ok) return decision;
      // Decided and closed in this same synchronous step: a desktop answer
      // arriving next finds the question answered.
      this.#close(q, "answered", "phone");
      if (!this.pi || !this.pi.answer(decision.response)) return { ok: false, code: "already-answered" };
      return { ok: true };
    });
  }

  chat(deviceId, request) {
    return this.#remember(deviceId, request.submissionId, () => {
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      // A /command goes to Pi as typed only when Pi listed it (MC6).
      const command = phoneCommand(request.text, this.commands);
      if (!command.ok) return command;
      // Uploaded files (MC10) go as the window sends its attachments: images
      // as images, the rest named by path in the note.
      this.#pruneUploads();
      const files = [];
      for (const id of request.attachments || []) {
        const upload = this.uploads.get(id);
        if (!upload || upload.deviceId !== deviceId) return { ok: false, code: "not-found", message: "an attached file is gone; attach it again" };
        files.push(upload.file);
      }
      const budget = imageBudgetProblem(files, PHONE_IMAGE_LIMITS);
      if (budget) return { ok: false, code: "too-large", message: budget };
      // As the window sends it: while coop works, Send now steers and Queue waits.
      const prompt = { type: "prompt", message: request.text + attachmentNote(files) };
      const images = files.filter((file) => file.kind === "image").map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      if (images.length) prompt.images = images;
      for (const id of request.attachments || []) this.uploads.delete(id);
      if (this.status === "running") prompt.streamingBehavior = request.mode === "steer" ? "steer" : "followUp";
      this.pi.request(prompt, { timeoutMs: 0 }).catch(() => {});
      return { ok: true };
    });
  }

  #pruneUploads() {
    const oldest = this.now() - UPLOAD_MS;
    for (const [id, upload] of this.uploads) if (upload.at < oldest) this.uploads.delete(id);
  }

  /**
   * A photo or file from the phone (MC10), saved under the window's data
   * folder and read the way the window attaches a file. Resolves to
   * `{ ok, file: { id, name, kind, label, detail, size } }`; the id goes in a chat.
   */
  upload(deviceId, request, authorize) {
    const scope = this.#scope(authorize);
    return this.#remember(deviceId, request.submissionId, async () => {
      scope.check();
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      if (!this.host || typeof this.host.attach !== "function") return { ok: false, code: "desktop-only", message: "this window cannot take files from the phone" };
      this.#pruneUploads();
      const waiting = [...this.uploads.values()].filter((upload) => upload.deviceId === deviceId).length;
      if (waiting >= UPLOAD_KEEP) return { ok: false, code: "too-large", message: `${UPLOAD_KEEP} files at most can wait to be sent; send or remove some first` };
      let file;
      try {
        try { file = await this.host.attach(request.name, Buffer.from(request.data, "base64")); }
        finally { scope.check(); }
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        return { ok: false, code: "not-an-option", message: String((error && error.message) || "that file could not be read").slice(0, 300) };
      }
      scope.check();
      const id = `u${randomBytes(12).toString("hex")}`;
      this.uploads.set(id, { deviceId, at: this.now(), file });
      return { ok: true, file: { id, name: file.name, kind: file.kind, label: file.label || file.kind, detail: file.detail || "", size: file.size || 0 } };
    });
  }

  /** The working folder's files for an @ mention (MC10), as the window's composer lists them. */
  async files(query, authorize) {
    const scope = this.#scope(authorize);
    scope.check();
    if (!this.host || typeof this.host.files !== "function") return { ok: true, files: [] };
    try {
      const files = await this.host.files(String(query || ""));
      scope.check();
      return { ok: true, files: Array.isArray(files) ? files.filter((f) => typeof f === "string").slice(0, 30) : [] };
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      return { ok: true, files: [] };
    }
  }

  /** Queued messages back to the phone's text box (the terminal's Alt+Up). */
  dequeue(deviceId, request, authorize) {
    const scope = this.#scope(authorize);
    return this.#remember(deviceId, request.submissionId, async () => {
      scope.check();
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      try {
        const response = await scope.request({ type: "clear_queue" });
        const data = response && response.success && response.data ? response.data : {};
        const texts = [...(data.steering || []), ...(data.followUp || [])].map(String).filter(Boolean);
        return { ok: true, texts };
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        return { ok: false, code: "pi-not-running" };
      }
    });
  }

  /** Pi's command list (extensions, prompt templates, skills), kept for MC6's check. */
  async refreshCommands(scope = this.#scope()) {
    if (!this.pi || this.pi.exited) return this.commands;
    try {
      const response = await scope.request({ type: "get_commands" });
      scope.check();
      const list = response && response.success && response.data && Array.isArray(response.data.commands) ? response.data.commands : null;
      if (list) this.commands = list.filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name, description: String(c.description || ""), source: String(c.source || "") }));
    } catch (error) { if (error instanceof ProtocolError) throw error; /* keep the last list */ }
    return this.commands;
  }

  stop(deviceId, request) {
    return this.#remember(deviceId, request.submissionId, () => {
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      this.pi.request({ type: "abort" }).catch(() => {});
      return { ok: true };
    });
  }

  /**
   * The window's session controls from the phone (MC7): model, thinking level,
   * compact and the session's name, as the window's menus send them. A model
   * must be one Pi lists. Resolves to `{ ok, code?, message? }`.
   */
  control(deviceId, request, authorize) {
    const scope = this.#scope(authorize);
    return this.#remember(deviceId, request.submissionId, async () => {
      scope.check();
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      const ask = async (command, options) => {
        try {
          const response = await scope.request(command, options);
          return response && response.success ? { ok: true, data: response.data || {} } : { ok: false, error: response && response.error };
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          return { ok: false, error: error && error.message };
        }
      };
      let result;
      switch (request.action) {
        case "model": {
          const list = await ask({ type: "get_available_models" });
          scope.check();
          const models = list.ok && Array.isArray(list.data.models) ? list.data.models : [];
          if (!models.some((m) => m && m.provider === request.provider && m.id === request.modelId)) {
            return { ok: false, code: "not-an-option", message: `coop has no model ${request.provider}/${request.modelId}` };
          }
          result = await ask({ type: "set_model", provider: request.provider, modelId: request.modelId });
          break;
        }
        case "thinking":
          result = await ask({ type: "set_thinking_level", level: request.level });
          break;
        case "compact": {
          if (this.status === "running") return { ok: false, code: "busy", message: "coop is working: compact when it finishes" };
          const command = request.instructions ? { type: "compact", customInstructions: request.instructions } : { type: "compact" };
          // Compacting answers when it is done; the phone sees it in the stream.
          this.pi.request(command, { timeoutMs: 0 }).catch(() => {});
          return { ok: true };
        }
        case "name":
          result = await ask({ type: "set_session_name", name: request.name });
          scope.check();
          if (result.ok) this.setSessionName(request.name);
          break;
        default:
          return { ok: false, code: "bad-request" };
      }
      scope.check();
      return result.ok ? { ok: true } : { ok: false, code: "changed", message: String(result.error || "coop could not do that").slice(0, 200) };
    });
  }

  /**
   * Session actions from the phone (MC9): new, resume a saved session, fork
   * from an earlier prompt, clone, and export HTML beside the session file.
   * Ids resolve against the window's own lists; the phone never names a path.
   */
  sessionAction(deviceId, request, authorize) {
    const scope = this.#scope(authorize);
    return this.#remember(deviceId, request.submissionId, async () => {
      scope.check();
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      if (this.status === "running") return { ok: false, code: "busy", message: "coop is working: stop it or wait, then try again" };
      const ask = async (command) => {
        try {
          const response = await scope.request(command, { timeoutMs: 0 });
          if (!response || !response.success) return { ok: false, error: response && response.error };
          if (response.data && response.data.cancelled) return { ok: false, error: "an extension cancelled it" };
          return { ok: true, data: response.data || {} };
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          return { ok: false, error: error && error.message };
        }
      };
      let command;
      switch (request.action) {
        case "new": command = { type: "new_session" }; break;
        case "clone": command = { type: "clone" }; break;
        case "resume": {
          const session = this.host ? this.host.list().find((s) => s && s.id === request.sessionId) : null;
          if (!session) return { ok: false, code: "not-an-option", message: "That session is not one of this folder's saved sessions" };
          command = { type: "switch_session", sessionPath: session.path };
          break;
        }
        case "fork": {
          const list = await ask({ type: "get_fork_messages" });
          scope.check();
          const prompts = list.ok && Array.isArray(list.data.messages) ? list.data.messages : [];
          if (!prompts.some((m) => m && m.entryId === request.entryId)) return { ok: false, code: "not-an-option", message: "That prompt is not in this session" };
          command = { type: "fork", entryId: request.entryId };
          break;
        }
        case "reload": {
          // The window restarts coop on this session as its own /reload does;
          // the phone keeps access to the new coop for the next minute.
          if (!this.host || typeof this.host.reload !== "function") return { ok: false, code: "desktop-only", message: "this window cannot restart from the phone" };
          this.carryUntil = this.now() + RELOAD_CARRY_MS;
          this.host.reload();
          return { ok: true };
        }
        case "export": {
          let outputPath = "";
          try { outputPath = this.host ? await this.host.exportPath() : ""; }
          finally { scope.check(); }
          scope.check();
          if (!outputPath) return { ok: false, code: "changed", message: "This session is not saved yet, so there is nowhere to export it" };
          const result = await ask({ type: "export_html", outputPath });
          return result.ok ? { ok: true, file: basename(outputPath.replace(/\\/g, "/")) } : { ok: false, code: "changed", message: String(result.error || "coop could not export").slice(0, 200) };
        }
        default:
          return { ok: false, code: "bad-request" };
      }
      const result = await ask(command);
      if (!result.ok) return { ok: false, code: "changed", message: String(result.error || "coop could not do that").slice(0, 200) };
      scope.check();
      // The phone started or opened this session, so it keeps its access.
      this.renew({ keepAccess: true });
      if (this.host) this.host.changed(request.action);
      return { ok: true, ...(request.action === "fork" && typeof result.data.text === "string" ? { text: result.data.text.slice(0, LIMITS.chatChars) } : {}) };
    });
  }

  // ---- reads -------------------------------------------------------------

  /**
   * The session tree as the window's default view draws it (MC9): prompts,
   * answers and summaries, one line each, indented where the session branches.
   * Tool output stays on the VM. Rows: `{ depth, role, text, label, entryId, current }`;
   * a prompt's entryId is what Fork takes.
   */
  async tree(authorize) {
    const scope = this.#scope(authorize);
    scope.check();
    if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
    let data = {};
    try {
      const response = await scope.request({ type: "get_tree" });
      data = response && response.success && response.data ? response.data : {};
    } catch (error) { if (error instanceof ProtocolError) throw error; /* an empty tree */ }
    scope.check();
    const rows = [];
    const leaf = data.leafId;
    const lineOf = (entry) => {
      const message = entry.message || {};
      let text = messageText(message.content);
      if (!text && message.role === "assistant") {
        const tools = (Array.isArray(message.content) ? message.content : []).filter((c) => c && c.type === "toolCall").map((c) => c.name);
        text = tools.length ? `Runs ${tools.join(", ")}` : "";
      }
      if (!text) text = message.summary || entry.summary || "";
      return String(text).replace(/\s+/g, " ").trim().slice(0, TREE_TEXT_CHARS);
    };
    const walk = (start, depth) => {
      let node = start;
      while (node && rows.length < TREE_ROWS) {
        const entry = node.entry || {};
        const role = (entry.message && entry.message.role) || entry.type;
        const text = TREE_ROLES.has(role) ? lineOf(entry) : "";
        if (text || (TREE_ROLES.has(role) && node.label)) {
          rows.push({ depth, role, text, label: typeof node.label === "string" ? node.label.slice(0, 60) : "", ...(role === "user" && typeof entry.id === "string" ? { entryId: entry.id } : {}), current: entry.id === leaf });
        }
        const kids = Array.isArray(node.children) ? node.children : [];
        if (kids.length === 1) { node = kids[0]; continue; }
        for (const kid of kids) walk(kid, depth + 1);
        node = null;
      }
    };
    for (const root of Array.isArray(data.tree) ? data.tree : []) walk(root, 0);
    return { ok: true, rows, truncated: rows.length >= TREE_ROWS };
  }

  /** The folder's saved sessions and this session's prompts to fork from (MC9); no paths. */
  async sessions(authorize) {
    const scope = this.#scope(authorize);
    scope.check();
    if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
    const ask = (type) => scope.request({ type }).then((r) => (r && r.success && r.data ? r.data : {}), (error) => { if (error instanceof ProtocolError) throw error; return {}; });
    const [state, fork] = await Promise.all([ask("get_state"), ask("get_fork_messages")]);
    scope.check();
    const list = this.host ? this.host.list() : [];
    return {
      ok: true,
      sessions: list.slice(0, 50).map((s) => ({
        id: String(s.id || ""), name: String(s.name || "").slice(0, 200), title: String(s.title || "").slice(0, 200),
        modified: Number(s.modified) || 0, messages: Number(s.messages) || 0, current: s.path === state.sessionFile,
      })).filter((s) => s.id),
      prompts: (Array.isArray(fork.messages) ? fork.messages : [])
        .filter((m) => m && typeof m.entryId === "string")
        .map((m) => ({ entryId: m.entryId, text: String(m.text || "").split("\n")[0].slice(0, 200) })),
    };
  }


  /** What the phone's session sheets show (MC7): no file paths leave the VM. */
  async details(authorize) {
    const scope = this.#scope(authorize);
    scope.check();
    if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
    const ask = (type) => scope.request({ type }).then((r) => (r && r.success && r.data ? r.data : {}), (error) => { if (error instanceof ProtocolError) throw error; return {}; });
    const [state, stats, available, thinking] = await Promise.all([ask("get_state"), ask("get_session_stats"), ask("get_available_models"), ask("get_available_thinking_levels")]);
    scope.check();
    const model = (m) => (m && typeof m.id === "string" ? { provider: String(m.provider || ""), id: m.id, name: String(m.name || m.id), contextWindow: Number(m.contextWindow) || 0 } : null);
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const tokens = stats.tokens || {};
    const context = stats.contextUsage || {};
    return {
      ok: true,
      details: {
        model: model(state.model),
        thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : "off",
        levels: Array.isArray(thinking.levels) ? thinking.levels.filter((l) => typeof l === "string") : [],
        models: (Array.isArray(available.models) ? available.models : []).map(model).filter(Boolean),
        sessionName: this.sessionName,
        autoCompaction: Boolean(state.autoCompactionEnabled),
        stats: {
          prompts: num(stats.userMessages),
          answers: num(stats.assistantMessages),
          toolCalls: num(stats.toolCalls),
          tokensIn: num(tokens.input),
          tokensOut: num(tokens.output),
          cost: num(stats.cost),
          contextTokens: num(context.tokens),
          contextWindow: num(context.contextWindow),
          contextPercent: num(context.percent),
        },
      },
    };
  }


  /** The authoritative state for a phone that is starting or resyncing. */
  async snapshot(authorize) {
    const scope = this.#scope(authorize);
    scope.check();
    if (!this.usage) await this.refreshUsage(false, scope);
    scope.check();
    let messages = [];
    if (this.pi && !this.pi.exited) {
      try {
        const response = await scope.request({ type: "get_messages" });
        scope.check();
        const list = response.success && response.data && Array.isArray(response.data.messages) ? response.data.messages : [];
        // A resumed session's list is in its history; after that the events keep it.
        if (!this.todos.found) { const todos = todosFromMessages(list); if (todos.found) this.todos = todos; }
        messages = list
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .map((m, i) => ({ id: `h${i}`, role: m.role, text: messageText(m.content), final: true, content: m.content, ...(m.role === "user" && imageCount(m.content) ? { images: imageCount(m.content) } : {}) }))
          .filter((m) => m.text || m.images)
          .slice(-SNAPSHOT_MESSAGES)
          .map(({ content, ...m }) => (m.role === "assistant" && this.#keepThinking(`m:${m.id}`, content) ? { ...m, thinking: true } : m));
      } catch (error) { if (error instanceof ProtocolError) throw error; /* the stream will catch up */ }
      await this.refreshCommands(scope);
    }
    scope.check();
    const last = this.buffer[this.buffer.length - 1];
    return {
      v: 1,
      ...this.identity(),
      status: this.pi && this.pi.exited ? "exited" : this.status,
      messages: this.partial ? [...messages, { id: this.partial.id, role: "assistant", text: this.partial.text, final: false }] : messages,
      questions: this.openQuestions(),
      queue: this.queue,
      commands: phoneCommandList(this.commands),
      panel: this.panel(),
      lastEventId: last ? last.id : `${this.incarnation}:0`,
    };
  }

  /** Where a reconnecting stream starts: `{ mode: "replay", events }` or `{ mode: "snapshot", reason }`. */
  resume(lastEventId) {
    const first = this.buffer[0];
    const last = this.buffer[this.buffer.length - 1];
    const point = resumePoint(lastEventId, { incarnation: this.incarnation, firstSeq: first ? first.seq : 0, lastSeq: last ? last.seq : 0 });
    if (point.mode !== "replay") return point;
    return { mode: "replay", events: this.buffer.filter((event) => event.seq >= point.from) };
  }
}
