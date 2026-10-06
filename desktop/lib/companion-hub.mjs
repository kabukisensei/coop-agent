// One window's side of the phone companion (master plan row MC2, contract in
// desktop/COMPANION.md): the live session's incarnation, the phone's event
// stream and its buffer, the questions Pi is waiting on with one arbiter for
// both screens, and the idempotent chat, stop and answer the phone may send.
// The HTTP server (companion-server.mjs) only authenticates and routes to this.
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { buildUiResponse } from "./rpc-commands.mjs";
import { TODO_TOOL, applyTodoResult, createTodos, startTurn, todoLines, todosFromMessages } from "../renderer/todos.mjs";
import {
  LIMITS, classifyQuestion, decideAnswer, eventEnvelope, newIncarnation, phoneCommand, phoneCommandList, resumePoint,
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
const thinkingText = (content) => (Array.isArray(content) ? content.filter((p) => p && p.type === "thinking" && typeof p.thinking === "string").map((p) => p.thinking).join("\n\n").trim() : "");
const resultText = (result) => messageText(result && result.content);
const panelText = (text) => String(text === undefined || text === null ? "" : text).replace(ANSI, "").slice(0, PANEL_CHARS);

/** The text parts of a Pi message's content, joined; thinking and tool calls are left out. */
export function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
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
  constructor({ windowsUser, client, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random } = {}) {
    super();
    Object.assign(this, { windowsUser: windowsUser || "", client: client || "", now, setTimer, clearTimer, random });
    this.pi = null;
    this.incarnation = "";
    this.accessOn = false;
    this.sessionName = "";
    this.commands = [];
    this.reset();
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

  /** Follow a new Pi (a new incarnation): access goes off, old questions and submissions are void. */
  attach(pi) {
    this.reset();
    this.pi = pi;
    this.incarnation = newIncarnation(this.random);
    this.setAccess(false, "session-changed");
    if (pi) {
      pi.on("event", (message) => { if (this.pi === pi) this.onPiEvent(message); });
      pi.on("exit", () => { if (this.pi === pi) this.onPiExit(); });
    }
    this.#push("session", this.identity());
    return this.incarnation;
  }

  /** The session changed inside the same Pi (/new, a switch, a fork): a new incarnation too. */
  renew() {
    const pi = this.pi;
    for (const q of this.questions.values()) if (q.state === "open") this.#close(q, "cancelled", "pi");
    this.reset();
    this.pi = pi;
    this.incarnation = newIncarnation(this.random);
    this.setAccess(false, "session-changed");
    this.#push("session", this.identity());
  }

  setAccess(on, reason = "") {
    const next = on === true && Boolean(this.pi) && !this.pi.exited && Boolean(this.client);
    if (next === this.accessOn) return this.accessOn;
    this.accessOn = next;
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
        break;
      case "message_start":
        if (message.message && message.message.role === "user") {
          const text = messageText(message.message.content);
          if (text) this.#push("message", { id: `u${this.seq + 1}`, role: "user", text, final: true });
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

  onPiExit() {
    for (const q of this.questions.values()) if (q.state === "open") this.#close(q, "cancelled", "pi");
    this.partial = null;
    this.#status("exited");
    this.setAccess(false, "pi-exited");
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
      // As the window sends it: while coop works, Send now steers and Queue waits.
      const prompt = { type: "prompt", message: request.text };
      if (this.status === "running") prompt.streamingBehavior = request.mode === "steer" ? "steer" : "followUp";
      this.pi.request(prompt, { timeoutMs: 0 }).catch(() => {});
      return { ok: true };
    });
  }

  /** Queued messages back to the phone's text box (the terminal's Alt+Up). */
  dequeue(deviceId, request) {
    return this.#remember(deviceId, request.submissionId, async () => {
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      try {
        const response = await this.pi.request({ type: "clear_queue" });
        const data = response && response.success && response.data ? response.data : {};
        const texts = [...(data.steering || []), ...(data.followUp || [])].map(String).filter(Boolean);
        return { ok: true, texts };
      } catch {
        return { ok: false, code: "pi-not-running" };
      }
    });
  }

  /** Pi's command list (extensions, prompt templates, skills), kept for MC6's check. */
  async refreshCommands() {
    if (!this.pi || this.pi.exited) return this.commands;
    try {
      const response = await this.pi.request({ type: "get_commands" });
      const list = response && response.success && response.data && Array.isArray(response.data.commands) ? response.data.commands : null;
      if (list) this.commands = list.filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name, description: String(c.description || ""), source: String(c.source || "") }));
    } catch { /* keep the last list */ }
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
  control(deviceId, request) {
    return this.#remember(deviceId, request.submissionId, async () => {
      if (request.incarnation !== this.incarnation) return { ok: false, code: "wrong-session" };
      if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
      const ask = async (command, options) => {
        try {
          const response = await this.pi.request(command, options);
          return response && response.success ? { ok: true, data: response.data || {} } : { ok: false, error: response && response.error };
        } catch (error) {
          return { ok: false, error: error && error.message };
        }
      };
      let result;
      switch (request.action) {
        case "model": {
          const list = await ask({ type: "get_available_models" });
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
          if (result.ok) this.setSessionName(request.name);
          break;
        default:
          return { ok: false, code: "bad-request" };
      }
      return result.ok ? { ok: true } : { ok: false, code: "changed", message: String(result.error || "coop could not do that").slice(0, 200) };
    });
  }

  // ---- reads -------------------------------------------------------------

  /** What the phone's session sheets show (MC7): no file paths leave the VM. */
  async details() {
    if (!this.pi || this.pi.exited) return { ok: false, code: "pi-not-running" };
    const ask = (type) => this.pi.request({ type }).then((r) => (r && r.success && r.data ? r.data : {}), () => ({}));
    const [state, stats, available, thinking] = await Promise.all([ask("get_state"), ask("get_session_stats"), ask("get_available_models"), ask("get_available_thinking_levels")]);
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
  async snapshot() {
    let messages = [];
    if (this.pi && !this.pi.exited) {
      try {
        const response = await this.pi.request({ type: "get_messages" });
        const list = response.success && response.data && Array.isArray(response.data.messages) ? response.data.messages : [];
        // A resumed session's list is in its history; after that the events keep it.
        if (!this.todos.found) { const todos = todosFromMessages(list); if (todos.found) this.todos = todos; }
        messages = list
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .map((m, i) => ({ id: `h${i}`, role: m.role, text: messageText(m.content), final: true, content: m.content }))
          .filter((m) => m.text)
          .slice(-SNAPSHOT_MESSAGES)
          .map(({ content, ...m }) => (m.role === "assistant" && this.#keepThinking(`m:${m.id}`, content) ? { ...m, thinking: true } : m));
      } catch { /* the stream will catch up */ }
      await this.refreshCommands();
    }
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
