// Regression tests for model error display exercising actual production code:
// 1. Production app.js syntax and VM loading check.
// 2. Live errors without tokens render standalone error bubble, toast, and clear busy state.
// 3. Live errors after partial output preserve streamed text and append error callout.
// 4. Missing or empty errorMessage uses useful stopReason fallback.
// 5. Error text renders safely as text content (no XSS injection) and redacts secrets.
// 6. A subsequent successful turn clears busy state and completes cleanly.
// 7. Session replay (__replay) renders both standalone errors and partial-output errors.
// 8. Error sanitization contract parity between protocol.mjs and app.js.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { sanitizeErrorMessage as protocolSanitize } from "../web/protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const APP_JS_PATH = join(ROOT, "web", "public", "app.js");
const THEME_JS_PATH = join(ROOT, "web", "public", "theme-system.js");

const appSource = readFileSync(APP_JS_PATH, "utf8");
const themeSource = readFileSync(THEME_JS_PATH, "utf8");

let testCount = 0;
const test = async (name, fn) => {
  await fn();
  testCount++;
  console.log(`  ✓ ${name}`);
};

// --- Production UI Test Harness ----------------------------------------------
// Creates a DOM environment and runs the actual production web/public/app.js
// inside a node:vm context. Exercises production handle(evt), bubble(),
// renderAssistantError(), toast(), setBusy(), flushStreaming(), etc.
function createProductionUi() {
  class MockElement {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase();
      this.className = "";
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.attributes = {};
      this._textContent = "";
      this.parentNode = null;
      this.hidden = false;
      this.scrollTop = 0;
      this.scrollHeight = 100;
      this.clientHeight = 100;
      this.classList = {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this._classes.has(c)) this._classes.delete(c);
            else this._classes.add(c);
          } else if (force) {
            this._classes.add(c);
          } else {
            this._classes.delete(c);
          }
        },
      };
    }
    get innerHTML() {
      return this._innerHTML || this.textContent;
    }
    set innerHTML(val) {
      this._innerHTML = String(val);
      this.children = [];
      const text = String(val).replace(/<[^>]*>/g, "");
      if (text) {
        const textNode = new MockElement("p");
        textNode._textContent = text;
        textNode.parentNode = this;
        this.children.push(textNode);
      }
    }
    get textContent() {
      if (this.children.length > 0) {
        return this.children.map((c) => c.textContent).join("");
      }
      return this._textContent || "";
    }
    set textContent(val) {
      this.children = [];
      this._textContent = String(val);
    }
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    append(...items) {
      for (const item of items) this.appendChild(item);
    }
    remove() {
      if (this.parentNode) {
        const idx = this.parentNode.children.indexOf(this);
        if (idx !== -1) this.parentNode.children.splice(idx, 1);
      }
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener() {}
    removeEventListener() {}
    focus() {}
    contains(el) {
      if (this.children.includes(el)) return true;
      return this.children.some((c) => c.contains(el));
    }
    replaceChildren(...items) {
      this.children = [];
      for (const item of items) this.appendChild(item);
    }
    querySelector(sel) {
      const match = (el) => {
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          return el.classList.contains(cls) || el.className.split(/\s+/).includes(cls);
        }
        if (sel.startsWith("#")) return el.id === sel.slice(1);
        return el.tagName.toLowerCase() === sel.toLowerCase();
      };
      for (const child of this.children) {
        if (match(child)) return child;
        const found = child.querySelector(sel);
        if (found) return found;
      }
      return null;
    }
    querySelectorAll(sel) {
      const results = [];
      const match = (el) => {
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          return el.classList.contains(cls) || el.className.split(/\s+/).includes(cls);
        }
        if (sel.startsWith("#")) return el.id === sel.slice(1);
        return el.tagName.toLowerCase() === sel.toLowerCase();
      };
      const scan = (el) => {
        for (const child of el.children) {
          if (match(child)) results.push(child);
          scan(child);
        }
      };
      scan(this);
      return results;
    }
  }

  const mockElements = new Map();
  function getOrCreateElement(id) {
    if (!mockElements.has(id)) {
      const el = new MockElement("div");
      el.id = id.replace(/^[#.]/, "");
      mockElements.set(id, el);
    }
    return mockElements.get(id);
  }

  // Pre-seed known elements queried at script evaluation
  getOrCreateElement("#transcript");
  getOrCreateElement("#scroll");
  getOrCreateElement("#dot");
  getOrCreateElement("#statusText");
  getOrCreateElement("#stop");
  getOrCreateElement("#abortRetry");
  getOrCreateElement("#send");
  getOrCreateElement("#steer");
  getOrCreateElement("#followUp");
  getOrCreateElement("#toasts");
  getOrCreateElement("#sidebarToggle");
  getOrCreateElement("#sessionSidebar");
  getOrCreateElement("#utilityPanel");
  getOrCreateElement("#utilityBody");
  getOrCreateElement("#utilityTitle");
  getOrCreateElement("#utilityClose");

  const document = {
    documentElement: new MockElement("html"),
    body: new MockElement("body"),
    createElement(tag) { return new MockElement(tag); },
    querySelector(sel) { return getOrCreateElement(sel); },
    querySelectorAll(sel) { return []; },
    getElementById(id) { return getOrCreateElement(id); },
    activeElement: new MockElement("div"),
    addEventListener() {},
    removeEventListener() {},
  };

  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
    }
    set onopen(cb) {
      this._onopen = cb;
      if (typeof cb === "function") cb({ type: "open" });
    }
    get onopen() { return this._onopen; }
    addEventListener() {}
    removeEventListener() {}
    close() { this.readyState = 2; }
  }

  const window = {
    document,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    location: { search: "", pathname: "/" },
    history: { replaceState() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch() { return Promise.reject(new Error("mock fetch")); },
    EventSource: MockEventSource,
    navigator: { clipboard: { writeText() {} } },
    CoopInteraction: {
      updateQueue(queue, evt) { return queue; },
      imageLimits() { return { maxImages: 10, maxSize: 5 * 1024 * 1024 }; },
    },
    CoopSessionTree: {},
    CoopHealth: {},
    CoopCapabilityViews: {},
    CoopFindings: {},
    CoopLineage: {},
    CoopImpact: {},
    CoopKnowledge: {},
    CoopMissionControl: {},
    CoopContentPortability: {},
  };
  window.window = window;

  const sandbox = {
    document,
    location: window.location,
    history: window.history,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    EventSource: MockEventSource,
    fetch: window.fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    console,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.CoopInteraction = {
    updateQueue(queue, evt) { return queue; },
    imageLimits() { return { maxImages: 10, maxSize: 5 * 1024 * 1024 }; },
  };
  sandbox.CoopSessionTree = {};
  sandbox.CoopHealth = {};
  sandbox.CoopCapabilityViews = {};
  sandbox.CoopFindings = {};
  sandbox.CoopLineage = {};
  sandbox.CoopImpact = {};
  sandbox.CoopKnowledge = {};
  sandbox.CoopMissionControl = {};
  sandbox.CoopContentPortability = {};
  sandbox.CoopPortability = {
    DEFAULT_TEXT_LIMITS: { maxFiles: 10, maxBytes: 1024 * 1024 },
  };

  const context = vm.createContext(sandbox);
  // Execute prerequisite theme system script, then production app.js
  vm.runInContext(themeSource, context);
  vm.runInContext(appSource, context);

  const transcript = mockElements.get("#transcript");
  const toasts = mockElements.get("#toasts");
  const dot = mockElements.get("#dot");
  const stopBtn = mockElements.get("#stop");
  const sendBtn = mockElements.get("#send");

  return {
    context,
    handle: (evt) => context.handle(evt),
    sanitizeErrorMessage: context.sanitizeErrorMessage,
    renderAssistantError: context.renderAssistantError,
    transcript,
    getToasts: () => toasts.children.map((t) => ({
      kind: t.className.replace(/^toast\s*/, ""),
      msg: t.textContent,
    })),
    isBusy: () => dot.classList.contains("busy"),
    isStopHidden: () => stopBtn.hidden,
    isSendHidden: () => sendBtn.hidden,
  };
}

// --- 1. Production app.js Syntax & Sandboxed Load ------------------------------
await test("production app.js passes node syntax check and loads cleanly in sandbox", () => {
  assert.doesNotThrow(() => {
    new vm.Script(appSource, { filename: "web/public/app.js" });
  }, "web/public/app.js must have valid JavaScript syntax");

  const ui = createProductionUi();
  assert.equal(typeof ui.handle, "function");
  assert.equal(typeof ui.sanitizeErrorMessage, "function");
  assert.equal(typeof ui.renderAssistantError, "function");
});

// --- 2. Live error without tokens --------------------------------------------
await test("live error without tokens creates standalone error bubble, toast, and clears busy state (production app.js)", () => {
  const ui = createProductionUi();

  // Agent turn begins
  ui.handle({ type: "agent_start" });
  assert.equal(ui.isBusy(), true, "UI must indicate busy state on agent_start");
  assert.equal(ui.isStopHidden(), false, "Stop button visible while busy");
  assert.equal(ui.isSendHidden(), true, "Send button hidden while busy");

  ui.handle({ type: "message_start", message: { role: "assistant" } });
  // No message_update text_start or text_delta delivered (upstream failure before first token)
  ui.handle({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "401: Unauthorized access token sk-live-supersecrettoken12345678",
    },
  });
  ui.handle({ type: "agent_end" });

  // Verify busy state is completely cleared
  assert.equal(ui.isBusy(), false, "Busy state must be cleared after agent_end");
  assert.equal(ui.isStopHidden(), true, "Stop button must be hidden");
  assert.equal(ui.isSendHidden(), false, "Send button must be visible");

  // Verify toast notification
  const toasts = ui.getToasts();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, "error");
  assert.equal(toasts[0].msg, "401: Unauthorized access token [REDACTED]");
  assert.ok(!toasts[0].msg.includes("sk-live-"), "Secret token must not appear in toast");

  // Verify transcript rendered standalone error bubble
  assert.equal(ui.transcript.children.length, 1);
  const wrap = ui.transcript.children[0];
  assert.ok(wrap.className.includes("msg assistant error"), "Wrapper must have error classes");
  const bubble = wrap.querySelector(".bubble");
  assert.ok(bubble != null, "Bubble must be present");
  const callout = bubble.querySelector(".error-callout");
  assert.ok(callout != null, "Error callout must be rendered inside bubble");
  assert.equal(callout.textContent, "⚠️ 401: Unauthorized access token [REDACTED]");
  assert.ok(!callout.textContent.includes("sk-live-"), "Secret token must not appear in transcript");
});

// --- 3. Live error after partial output ---------------------------------------
await test("live error after partial output preserves streamed text and appends error callout (production app.js)", () => {
  const ui = createProductionUi();

  ui.handle({ type: "agent_start" });
  ui.handle({ type: "message_start", message: { role: "assistant" } });
  ui.handle({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
  ui.handle({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Initial analysis completed successfully.\nStep 1: check credentials." },
  });
  // Abrupt model error mid-response
  ui.handle({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "503: Service Unavailable with Bearer secret-auth-token-12345678",
    },
  });
  ui.handle({ type: "agent_end" });

  assert.equal(ui.isBusy(), false);

  // Verify toast
  const toasts = ui.getToasts();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, "error");
  assert.equal(toasts[0].msg, "503: Service Unavailable with Bearer [REDACTED]");

  // Verify transcript: exactly 1 message bubble containing BOTH partial text AND error callout
  assert.equal(ui.transcript.children.length, 1);
  const wrap = ui.transcript.children[0];
  const bubble = wrap.querySelector(".bubble");
  assert.ok(bubble != null);
  assert.equal(bubble.dataset.raw, "Initial analysis completed successfully.\nStep 1: check credentials.");
  assert.ok(bubble.textContent.includes("Initial analysis completed successfully."));

  const callout = bubble.querySelector(".error-callout");
  assert.ok(callout != null, "Error callout must be appended to the existing partial bubble");
  assert.equal(callout.textContent, "⚠️ 503: Service Unavailable with Bearer [REDACTED]");
});

// --- 4. Missing errorMessage gets useful fallback ----------------------------
await test("missing or empty errorMessage uses useful stopReason fallback (production app.js)", () => {
  const ui = createProductionUi();

  // Subcase A: stopReason = "error", errorMessage is null
  ui.handle({ type: "message_start", message: { role: "assistant" } });
  ui.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: null },
  });
  ui.handle({ type: "agent_end" });

  let toasts = ui.getToasts();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, "Request stopped with error (error).");
  let callout = ui.transcript.children[0].querySelector(".error-callout");
  assert.equal(callout.textContent, "⚠️ Request stopped with error (error).");

  // Subcase B: stopReason = "error", errorMessage is whitespace only
  ui.handle({ type: "message_start", message: { role: "assistant" } });
  ui.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "   " },
  });
  ui.handle({ type: "agent_end" });

  toasts = ui.getToasts();
  assert.equal(toasts.length, 2);
  assert.equal(toasts[1].msg, "Request stopped with error (error).");
  callout = ui.transcript.children[1].querySelector(".error-callout");
  assert.equal(callout.textContent, "⚠️ Request stopped with error (error).");

  // Subcase C: no stopReason, empty errorMessage -> generic fallback
  assert.equal(ui.sanitizeErrorMessage("", "Custom model fallback."), "Custom model fallback.");
  assert.equal(ui.sanitizeErrorMessage(undefined), "Model request failed.");
});

// --- 5. Safe text rendering & secret redaction --------------------------------
await test("error text renders safely as text content without HTML injection and redacts credentials", () => {
  const ui = createProductionUi();

  const xssPayload = "<script>window._hacked=true;</script><img src=x onerror=alert(1)> & <b>unescaped</b>";
  const secretPayload = "Leaked key: api_key='secret-key-12345678' sk-proj-1234567890abcdef ?key=AIzaSySecret12345";

  ui.handle({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: `${xssPayload} ${secretPayload}`,
    },
  });

  const callout = ui.transcript.children[0].querySelector(".error-callout");
  assert.ok(callout != null);

  // Confirm no HTML elements (<script>, <img>, <b>) were created inside the error callout
  assert.equal(callout.querySelectorAll("script").length, 0, "No script tag allowed");
  assert.equal(callout.querySelectorAll("img").length, 0, "No img tag allowed");
  assert.equal(callout.querySelectorAll("b").length, 0, "No b tag allowed");

  // Content must be safely set as plain text with secrets redacted
  const text = callout.textContent;
  assert.ok(text.includes("<script>window._hacked=true;</script>"));
  assert.ok(text.includes("[REDACTED]"));
  assert.ok(!text.includes("secret-key-12345678"));
  assert.ok(!text.includes("sk-proj-1234567890abcdef"));
  assert.ok(!text.includes("AIzaSySecret12345"));
});

// --- 6. Subsequent successful turn works normally ----------------------------
await test("subsequent successful turn after an error works normally and clears state (production app.js)", () => {
  const ui = createProductionUi();

  // Turn 1: Fails with model error
  ui.handle({ type: "agent_start" });
  ui.handle({ type: "message_start", message: { role: "assistant" } });
  ui.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "429: Too Many Requests" },
  });
  ui.handle({ type: "agent_end" });

  assert.equal(ui.isBusy(), false);
  assert.equal(ui.transcript.children.length, 1);
  assert.ok(ui.transcript.children[0].querySelector(".error-callout") != null);

  // Turn 2: Succeeds cleanly
  ui.handle({ type: "agent_start" });
  assert.equal(ui.isBusy(), true, "Second turn sets busy true");
  ui.handle({ type: "message_start", message: { role: "assistant" } });
  ui.handle({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
  ui.handle({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "I am ready to help now!" },
  });
  ui.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", errorMessage: null, usage: { output: 15 } },
  });
  ui.handle({ type: "agent_end" });

  assert.equal(ui.isBusy(), false, "Busy cleared after successful second turn");
  assert.equal(ui.isStopHidden(), true);
  assert.equal(ui.isSendHidden(), false);

  // Exactly 2 messages in transcript
  const messages = ui.transcript.querySelectorAll(".msg");
  assert.equal(messages.length, 2, "Transcript should contain exactly 2 message rows");
  assert.ok(messages[0].querySelector(".error-callout") != null, "First message has error callout");
  const secondWrap = messages[1];
  const secondBubble = secondWrap.querySelector(".bubble");
  assert.ok(secondBubble != null);
  assert.equal(secondBubble.dataset.raw, "I am ready to help now!");
  // Second turn MUST NOT have any error callout
  assert.equal(secondBubble.querySelector(".error-callout"), null, "Second turn must not contain error callout");
  // Total toasts remain 1 (from first turn only)
  assert.equal(ui.getToasts().length, 1);
});

// --- 7. Session replay backfills both error types -----------------------------
await test("session replay backfills both standalone error and partial output error (production app.js)", () => {
  const ui = createProductionUi();

  // Replay event A: standalone error (no tokens)
  ui.handle({
    type: "__replay",
    role: "assistant",
    parts: [{ kind: "error", text: "401: Unauthorized session key [REDACTED]" }],
  });

  // Replay event B: partial output + error
  ui.handle({
    type: "__replay",
    role: "assistant",
    parts: [
      { kind: "text", text: "Replayed partial calculation before failure" },
      { kind: "error", text: "504: Gateway Timeout" },
    ],
  });

  assert.equal(ui.transcript.children.length, 2);

  // Bubble 1: standalone error
  const wrap1 = ui.transcript.children[0];
  assert.ok(wrap1.className.includes("msg assistant error"));
  const callout1 = wrap1.querySelector(".error-callout");
  assert.ok(callout1 != null);
  assert.equal(callout1.textContent, "⚠️ 401: Unauthorized session key [REDACTED]");

  // Bubble 2: partial text + error callout attached
  const wrap2 = ui.transcript.children[1];
  const bubble2 = wrap2.querySelector(".bubble");
  assert.ok(bubble2 != null);
  assert.ok(bubble2.textContent.includes("Replayed partial calculation before failure"));
  const callout2 = bubble2.querySelector(".error-callout");
  assert.ok(callout2 != null);
  assert.equal(callout2.textContent, "⚠️ 504: Gateway Timeout");
});

// --- 8. Error Sanitization Contract Parity ------------------------------------
await test("sanitizeErrorMessage contract parity between protocol.mjs and app.js", () => {
  const ui = createProductionUi();
  const cases = [
    ["Error: sk-or-v1-0123456789abcdef", "Error: [REDACTED]"],
    ["Auth Bearer eyJhbGciOiJIUzI1Ni...xyz", "Auth Bearer [REDACTED]"],
    ["https://api.com?key=AIzaSySecret12345", "https://api.com?key=[REDACTED]"],
    ["Set api_key='secret-val-12345'", "Set api_key='[REDACTED]'"],
    ["token=secret-token-abcdef123", "token=[REDACTED]"],
    ['401: {"message":"User not found.","code":401}', '401: {"message":"User not found.","code":401}'],
    [null, "Custom fallback"],
    [undefined, "Custom fallback"],
    ["   ", "Custom fallback"],
  ];

  for (const [input, expected] of cases) {
    const protocolResult = protocolSanitize(input, "Custom fallback");
    const appResult = ui.sanitizeErrorMessage(input, "Custom fallback");
    assert.equal(protocolResult, expected, `protocol.mjs failed for: ${input}`);
    assert.equal(appResult, expected, `app.js failed for: ${input}`);
    assert.equal(appResult, protocolResult, "Parity mismatch between app.js and protocol.mjs");
  }
});

console.log(`\nAll ${testCount} error-display production behavioral tests passed!`);
