// coop web — the Pi RPC protocol contract + a hardened JSONL splitter.
//
// WHY THIS FILE EXISTS
// coop web speaks Pi's RPC protocol "from memory": before this module nothing in
// the repo stated which commands the bridge sends or which event shapes the SPA
// renders, so a Pi upgrade that renamed a field failed SILENTLY (blank bubbles,
// dead tool pills). This module is the machine-readable statement of that wire
// contract plus a cheap drift DETECTOR (not an enforcer): the bridge validates
// every parsed pi event against the contract at its single chokepoint
// (handlePiLine) and, on an unknown or shape-mismatched event, logs to stderr and
// shows a one-time browser toast — so the next Pi bump fails LOUDLY and
// actionably instead of quietly degrading.
//
// It is imported by web/server.mjs and by the tests. It is NOT served to the
// browser (validation happens bridge-side, behind both the SSE and polling
// transports); it is a pure, side-effect-free ESM module — importable in Node
// without spawning anything.
//
// VERIFIED AGAINST Pi 0.80.2 — the contract entries below were checked against
// the installed `pi-agent-core` / `pi-ai` dist type unions (notably
// `AssistantMessageEvent` in dist/types.d.ts, which includes the `toolcall_*`
// members) and against `rpc-mode.js`, which forwards session events wholesale.
// Every entry must exist in the REAL protocol — no aspirational entries. When Pi
// is upgraded, follow the "Protocol contract (when Pi is upgraded)" checklist in
// web/README.md and re-verify against the new package's types.
//
// JSONL FRAMING RULE (load-bearing): split on "\n" only and strip a trailing
// "\r". NEVER use Node `readline` — Pi's own docs warn it mis-splits on U+2028 /
// U+2029 inside JSON strings and corrupts messages. `createJsonlSplitter` below
// is the one framer; the regression tests in tests/protocol.test.mjs pin it.

import { StringDecoder } from "node:string_decoder";

// --- Contract data: commands the bridge SENDS to pi stdin ----------------------
// Whitelist of RPC commands the browser may relay through POST /rpc. Kept HERE,
// next to the rest of the contract, so the whitelist and the contract can never
// drift apart; server.mjs imports it (and its `.has()` usage requires a Set).
export const RPC_ALLOWED = new Set([
  "new_session",
  "get_state",
  "get_available_models",
  "set_model",
  "set_thinking_level",
  "compact",
  "get_session_stats", // read-only: tokens, cost, context usage (header gauge)
  "set_session_name", // names the current conversation (History list)
]);

// Every command the bridge ever writes to pi stdin, mapped to a field spec (see
// the field-spec mini-language below). Derived from actual usage in server.mjs —
// documentation + self-consistency only; nothing validates live outbound traffic.
//
// Launch-flags contract (documentation only — `spawnPi` is not changed here):
//   spawn = launch-spec `bin`/`args` + "--mode" "rpc" "-a" (+ "--session <file>"
//   on resume). NEVER drop `-a` — the agent runs silently ungoverned otherwise.
export const COMMANDS_SENT = {
  prompt: { message: "string", streamingBehavior: "string?" },
  extension_ui_response: { id: "string", value: "any?", confirmed: "boolean?", cancelled: "boolean?" },
  abort: {},
  get_messages: {},
  // The eight RPC_ALLOWED commands with their whitelisted fields (see the /rpc
  // handler in server.mjs — only these fields are ever forwarded).
  new_session: {},
  get_state: {},
  get_available_models: {},
  set_model: { provider: "string", modelId: "string" },
  set_thinking_level: { level: "string" },
  compact: { customInstructions: "string?" },
  get_session_stats: {},
  set_session_name: { name: "string" },
};

// --- Contract data: events the bridge / SPA CONSUME ----------------------------
// The nine assistant-message event kinds Pi streams inside `message_update`. The
// `toolcall_*` members are load-bearing: Pi 0.80.2's `AssistantMessageEvent`
// union includes them and rpc-mode forwards session events wholesale, so EVERY
// real tool call produces `message_update` events with `assistantMessageEvent.type:
// "toolcall_*"`. The SPA falls through on them today (no renderer), but omitting
// them here would make the drift detector fire a permanent false positive in
// essentially every real session.
export const ASSISTANT_MESSAGE_EVENTS = [
  "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end",
];

// Every extension-UI method Pi 0.80.x can send on an `extension_ui_request`. Must
// stay in sync with the dispatcher in app.js (M4 renders the ones beyond the four
// dialogs; anything not here is drift-flagged and renders as a fallback card).
export const UI_METHODS = [
  "select", "confirm", "input", "editor", "notify",
  "setStatus", "setWidget", "setTitle", "set_editor_text",
];

// Every event type the bridge (handlePiLine) or SPA (handle() in app.js)
// dereferences, with a SHALLOW field spec (top-level kinds only — enough to catch
// a rename/removal, cheap enough to run on every event). Two members carry an
// extra subcheck, applied in checkEvent: `message_update.assistantMessageEvent`
// and `extension_ui_request.method`.
export const EVENTS_CONSUMED = {
  agent_start: {}, // toggles `busy`
  agent_end: { messages: "array?", willRetry: "boolean?" },
  message_start: { message: "object" }, // SPA reads message.role, message.content
  message_update: { message: "object?", assistantMessageEvent: "object?" },
  message_end: { message: "object?" }, // SPA reads message.usage, .role, .responseModel|model
  tool_execution_start: { toolCallId: "string", toolName: "string", args: "any?" },
  tool_execution_update: { toolCallId: "string", toolName: "string?", partialResult: "any?" },
  tool_execution_end: { toolCallId: "string", toolName: "string?", result: "any?", isError: "boolean?" },
  compaction_start: { reason: "string?" },
  compaction_end: {},
  extension_ui_request: { id: "string", method: "string" },
  response: { command: "string?", success: "boolean", id: "any?", data: "any?", error: "string?" },
};

// Types Pi 0.80.x emits that coop-web deliberately ignores but must NOT warn
// about. Each was verified to exist in the installed Pi 0.80.2 package (grep of
// `pi-coding-agent` / `pi-agent-core` dist). Do not add aspirational entries: an
// earlier draft listed `streaming_state`, which does not exist in 0.80.2 and was
// dropped.
export const EVENTS_KNOWN_IGNORED = [
  "turn_start", "turn_end", "queue_update", "auto_retry_start", "auto_retry_end",
  "thinking_level_changed", "extension_error", "session_info_changed",
];

// The `data` fields the SPA actually dereferences per claimed /rpc command,
// checked only when `success === true`. Loose ({}) where the SPA reads nothing
// structural. Every key here must be a member of COMMANDS_SENT (self-consistency).
export const RESPONSE_DATA = {
  get_state: { model: "object?", thinkingLevel: "string?" },
  get_available_models: { models: "array" },
  get_session_stats: { contextUsage: "object?", tokens: "object?", cost: "number?" },
  new_session: { cancelled: "boolean?" },
  get_messages: { messages: "array" },
  compact: {},
  set_model: {},
  set_thinking_level: {},
  set_session_name: {},
};

// Bridge-synthesized event types (always skipped by the validator — they never
// come from pi). Documented so future sections don't collide.
//   M3 adds "__replay"; M5 adds "__chats" and "__reset" — each milestone must
//   extend this list as it lands.
// M5 envelope + __hello shape (multi-session): SSE frames are enveloped as
//   {"sid":<sid>,"n":<n?>,"ev":<raw pi line or bridge synthetic>}   (per chat), or
//   {"ev":<bridge synthetic>}                                       (global: __hello, __chats).
// The global __hello is {type:"__hello", chats:[{sid,cwd,busy,status,createdAt}], maxChats};
// __chats is {type:"__chats", chats:[…]}; the per-chat __reset is {type:"__reset", cwd, epoch}
// (replaces the old per-chat __hello after new_session/chdir/resume).
export const BRIDGE_EVENTS = ["__hello", "__fatal", "__message", "__drift", "__replay", "__chats", "__reset"];

// --- Field-spec mini-language + checkers (no Zod — top-level kinds only) --------
// A spec is `{field: kind}` where kind is one of the strings below, with a "?"
// suffix meaning optional. Extra unknown fields on the object are NEVER a
// problem — Pi may add fields freely; this is drift DETECTION, not enforcement.

function describeType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function kindOk(val, kind) {
  switch (kind) {
    case "any": return true;
    case "string": return typeof val === "string";
    case "number": return typeof val === "number";
    case "boolean": return typeof val === "boolean";
    case "array": return Array.isArray(val);
    case "object": return val !== null && typeof val === "object" && !Array.isArray(val);
    default: return true; // unrecognized kind in the contract — don't flag traffic for our typo
  }
}

// Returns a list of human-readable problems (empty = shape ok). A non-object
// `obj` only fails on the spec's REQUIRED fields (so a loose/all-optional spec
// tolerates a missing `data` object on a response — see checkResponseData).
export function checkShape(obj, spec) {
  const problems = [];
  const isObj = obj !== null && typeof obj === "object";
  for (const field of Object.keys(spec)) {
    let kind = spec[field];
    const optional = kind.endsWith("?");
    if (optional) kind = kind.slice(0, -1);
    const val = isObj ? obj[field] : undefined;
    if (val === undefined) {
      if (!optional) problems.push(`missing required field ${field}`);
      continue;
    }
    if (!kindOk(val, kind)) {
      problems.push(`field ${field}: expected ${kind}, got ${describeType(val)}`);
    }
  }
  return problems;
}

// Classify one parsed pi event against the contract.
//   { kind: "ok" | "unknown" | "mismatch", problems: string[] }
// Dispatch: bridge-synthesized ("__"-prefixed) or known-ignored -> ok; a
// contract member -> checkShape + the two subchecks; anything else -> unknown.
export function checkEvent(evt) {
  if (evt === null || typeof evt !== "object" || typeof evt.type !== "string") {
    return { kind: "unknown", problems: ["event has no string `type`"] };
  }
  const type = evt.type;
  if (type.startsWith("__") || EVENTS_KNOWN_IGNORED.includes(type)) {
    return { kind: "ok", problems: [] };
  }
  const spec = EVENTS_CONSUMED[type];
  if (!spec) {
    return { kind: "unknown", problems: [`unrecognized event type '${type}'`] };
  }
  const problems = checkShape(evt, spec);
  // Subcheck: a message_update's assistantMessageEvent must be a known kind, and
  // the streaming `*_delta` members must carry a string `delta` (this is what a
  // real tool call streams as partial-JSON args — toolcall_delta included).
  if (type === "message_update" && evt.assistantMessageEvent !== null && typeof evt.assistantMessageEvent === "object") {
    const ame = evt.assistantMessageEvent;
    if (typeof ame.type !== "string" || !ASSISTANT_MESSAGE_EVENTS.includes(ame.type)) {
      problems.push(`assistantMessageEvent.type '${ame.type}' is not a known AssistantMessageEvent`);
    } else if (ame.type.endsWith("_delta") && typeof ame.delta !== "string") {
      problems.push(`assistantMessageEvent ${ame.type}: delta expected string, got ${describeType(ame.delta)}`);
    }
  }
  // Subcheck: an extension_ui_request method must be one coop-web knows about.
  if (type === "extension_ui_request" && typeof evt.method === "string" && !UI_METHODS.includes(evt.method)) {
    problems.push(`extension_ui_request method '${evt.method}' is not a known UI method`);
  }
  return { kind: problems.length ? "mismatch" : "ok", problems };
}

// Validate the `data` payload of a claimed /rpc response (caller gates on
// success === true). Returns problems (empty when the command has no spec).
export function checkResponseData(command, data) {
  const spec = RESPONSE_DATA[command];
  if (!spec) return [];
  return checkShape(data, spec);
}

// --- Hardened JSONL splitter ---------------------------------------------------
// Replaces the inline `buf += chunk.toString("utf8")` framer in server.mjs.
// `createJsonlSplitter(onLine, opts)` returns a `feed(chunk)` you call per stdout
// data event. Semantics (re-implemented from pi-vis's byte-level jsonl-stream.ts —
// studied, not copied):
//
//   1. UTF-8 boundary fix (the real bug): a per-instance StringDecoder carries a
//      partial multi-byte code point across pipe-chunk boundaries. The old
//      `chunk.toString("utf8")` yielded U+FFFD when an emoji / CJK char in a
//      text_delta straddled a chunk, corrupting that JSON line — which
//      handlePiLine then silently dropped.
//   2. "\n"-only split via indexOf (JS string indexOf("\n") never matches
//      U+2028/U+2029, so U+2028/29 inside a JSON string can't split a line —
//      the "NEVER readline" rule, pinned by a regression test).
//   3. CRLF tolerance: strip one trailing "\r". Blank lines: skipped.
//   4. O(n) partial buffering: pending segments are kept as an ARRAY, joined only
//      when the terminating "\n" arrives — a huge line fed in small chunks isn't
//      repeatedly re-concatenated.
//   5. Oversized-line cap: `opts.maxLineLength` (default 64 MiB, matching
//      pi-vis; measured in string length ≈ bytes, approximate). When a line
//      exceeds it the line is dropped, `opts.onOversize?.(len)` fires ONCE, and
//      the stream recovers on the next "\n". Today's buffer is unbounded.
export function createJsonlSplitter(onLine, opts = {}) {
  const decoder = new StringDecoder("utf8");
  const maxLineLength = opts.maxLineLength || 64 * 1024 * 1024;
  const onOversize = typeof opts.onOversize === "function" ? opts.onOversize : null;
  let pending = []; // string segments of the current unterminated line
  let pendingLen = 0; // total length across `pending` (so we never rescan to measure)
  let overflow = false; // current line blew the cap — discard through its next "\n"

  const emit = (line) => {
    if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF input
    if (!line.trim()) return; // skip blank lines
    onLine(line);
  };

  return function feed(chunk) {
    // A Buffer goes through the decoder (carries partial code points); a string
    // (tests) is already decoded and passes through.
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    let nl;
    while ((nl = text.indexOf("\n", start)) >= 0) {
      const segment = text.slice(start, nl);
      start = nl + 1;
      if (overflow) {
        // The rest of an already-reported oversized line ends here — reset.
        pending = []; pendingLen = 0; overflow = false;
        continue;
      }
      const fullLen = pendingLen + segment.length;
      if (fullLen > maxLineLength) {
        // A complete-but-oversized line — drop it, report once, keep going.
        pending = []; pendingLen = 0;
        if (onOversize) onOversize(fullLen);
        continue;
      }
      if (pendingLen) {
        pending.push(segment);
        emit(pending.join(""));
        pending = []; pendingLen = 0;
      } else {
        emit(segment);
      }
    }
    // Buffer the trailing partial (no "\n" yet).
    if (start < text.length) {
      if (overflow) return; // still discarding the oversized line's remainder
      const tail = text.slice(start);
      const newLen = pendingLen + tail.length;
      if (newLen > maxLineLength) {
        // The partial itself blew the cap: drop it and flag overflow so the
        // eventual completion of this line is discarded too.
        pending = []; pendingLen = 0; overflow = true;
        if (onOversize) onOversize(newLen);
        return;
      }
      pending.push(tail);
      pendingLen = newLen;
    }
  };
}
