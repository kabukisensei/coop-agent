// Unit tests for web/protocol.mjs — the Pi RPC protocol contract, the shape
// checkers, and the hardened JSONL splitter. Pure module: importable without
// spawning anything. Flat t(name, ok) style, matching the other suites.
import { strict as assert } from "node:assert";
import {
  RPC_ALLOWED, COMMANDS_SENT, EVENTS_CONSUMED, EVENTS_KNOWN_IGNORED, RESPONSE_DATA,
  BRIDGE_EVENTS, checkShape, checkEvent, checkResponseData, createJsonlSplitter,
} from "../web/protocol.mjs";

let n = 0;
const t = (name, ok) => {
  assert.ok(ok, name);
  n++;
  console.log(`  ✓ ${name}`);
};

// A splitter that collects emitted lines and counts oversize reports.
function collector(opts = {}) {
  const lines = [];
  let oversize = 0;
  const feed = createJsonlSplitter((l) => lines.push(l), { ...opts, onOversize: () => oversize++ });
  return { feed, lines, oversizeCount: () => oversize };
}
const B = (s) => Buffer.from(s, "utf8");

// --- JSONL splitter -----------------------------------------------------------
{
  const c = collector();
  c.feed(B('{"a":1}\n{"b":2}\n'));
  t("splitter: two events in one chunk", c.lines.length === 2 && JSON.parse(c.lines[0]).a === 1 && JSON.parse(c.lines[1]).b === 2);
}
{
  const c = collector();
  c.feed(B('{"hel')); c.feed(B('lo":"wor')); c.feed(B('ld"}\n'));
  t("splitter: one event split across 3 chunks", c.lines.length === 1 && JSON.parse(c.lines[0]).hello === "world");
}
{
  // A 4-byte emoji split mid-code-point across two feed() calls. The old
  // chunk.toString("utf8") framer yielded U+FFFD here and corrupted the line;
  // the per-instance StringDecoder carries the partial code point across.
  const c = collector();
  const buf = B(JSON.stringify({ e: "😀" }) + "\n");
  const cut = buf.indexOf(0xf0) + 2; // 2 bytes into the 4-byte emoji sequence
  c.feed(buf.subarray(0, cut));
  c.feed(buf.subarray(cut));
  t("splitter: emoji split mid-code-point arrives intact (StringDecoder)", c.lines.length === 1 && JSON.parse(c.lines[0]).e === "😀");
}
{
  const c = collector();
  c.feed(B('{"crlf":true}\r\n'));
  t("splitter: strips a trailing \\r (CRLF)", c.lines.length === 1 && c.lines[0] === '{"crlf":true}' && JSON.parse(c.lines[0]).crlf === true);
}
{
  const c = collector();
  c.feed(B('{"a":1}\n\n   \n{"b":2}\n'));
  t("splitter: blank / whitespace-only lines are skipped", c.lines.length === 2);
}
{
  // U+2028 / U+2029 inside a JSON string must NOT split the line and must survive
  // intact — the "NEVER readline" guarantee at the splitter level.
  const c = collector();
  const val = "a b c";
  c.feed(B(JSON.stringify({ t: val }) + "\n"));
  t("splitter: literal U+2028/U+2029 in a string parses intact and un-split", c.lines.length === 1 && JSON.parse(c.lines[0]).t === val);
}
{
  // Oversized line dropped; onOversize fires once; the NEXT line still parses.
  const c = collector({ maxLineLength: 1024 });
  c.feed(B(JSON.stringify({ big: "x".repeat(2000) }) + "\n" + '{"ok":1}' + "\n"));
  t("splitter: oversized line dropped, onOversize once, next line still parses",
    c.lines.length === 1 && JSON.parse(c.lines[0]).ok === 1 && c.oversizeCount() === 1);
}
{
  // Oversized line fed in small chunks (partial exceeds the cap): still dropped
  // once, and recovery on the next \n.
  const c = collector({ maxLineLength: 64 });
  c.feed(B('{"x":"')); c.feed(B("y".repeat(100))); c.feed(B('"}\n')); c.feed(B('{"ok":2}\n'));
  t("splitter: oversized partial across chunks drops then recovers",
    c.lines.length === 1 && JSON.parse(c.lines[0]).ok === 2 && c.oversizeCount() === 1);
}
{
  // Two independent splitters must not share pending state.
  const a = collector(), b = collector();
  a.feed(B('{"partial":')); // buffered in A, never terminated
  b.feed(B('{"whole":1}\n'));
  t("splitter: partial state does not leak between instances", a.lines.length === 0 && b.lines.length === 1 && JSON.parse(b.lines[0]).whole === 1);
}

// --- checkShape ---------------------------------------------------------------
t("checkShape: missing required field is a problem", checkShape({}, { x: "string" }).length === 1);
t("checkShape: wrong kind is a problem", checkShape({ x: 1 }, { x: "string" }).some((p) => /expected string/.test(p)));
t("checkShape: an absent optional field is ok", checkShape({}, { x: "string?" }).length === 0);
t("checkShape: extra unknown fields are never a problem", checkShape({ x: "a", extra: 1, more: {} }, { x: "string" }).length === 0);
t("checkShape: array vs object kinds are distinguished", checkShape({ a: [], o: {} }, { a: "object", o: "array" }).length === 2);

// --- checkEvent: every stub-pi-emitted event shape is ok ----------------------
const STUB_EVENTS = [
  { type: "extension_ui_request", id: "stub-dialog-1", method: "select", title: "Welcome", options: ["A", "B"] },
  { type: "extension_ui_request", id: "stub-notify-1", method: "notify", message: "stub ready", notifyType: "info" },
  { type: "response", command: "prompt", success: true },
  { type: "agent_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  { type: "message_update", message: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
  { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "polo:hi" } },
  { type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0 } },
  { type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolCallId: "tc1", toolName: "read" } },
  { type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"n' } },
  { type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1 } },
  { type: "agent_end", messages: [] },
  { type: "response", command: "get_state", success: true, data: { model: { id: "stub-1" }, thinkingLevel: "medium" } },
  { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "ls" } },
  { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: {}, isError: false },
  { type: "compaction_start", reason: "auto" },
  { type: "compaction_end" },
];
t("checkEvent: every stub-pi-emitted event shape -> ok", STUB_EVENTS.every((e) => checkEvent(e).kind === "ok"));

// known-ignored types never warn
t("checkEvent: each EVENTS_KNOWN_IGNORED type -> ok", EVENTS_KNOWN_IGNORED.every((ty) => checkEvent({ type: ty }).kind === "ok"));
// bridge-synthesized types are always skipped
t("checkEvent: every BRIDGE_EVENTS type -> ok", BRIDGE_EVENTS.every((ty) => checkEvent({ type: ty }).kind === "ok"));

t("checkEvent: a brand new event type -> unknown", checkEvent({ type: "brand_new_event", x: 1 }).kind === "unknown");
{
  const r = checkEvent({ type: "tool_execution_end" });
  t("checkEvent: tool_execution_end without toolCallId -> mismatch (with a toolCallId problem)",
    r.kind === "mismatch" && r.problems.some((p) => /toolCallId/.test(p)));
}
t("checkEvent: no string type -> unknown", checkEvent({ x: 1 }).kind === "unknown" && checkEvent(null).kind === "unknown");

// the message_update / assistantMessageEvent subcheck
t("checkEvent: message_update with a bogus assistantMessageEvent type -> mismatch",
  checkEvent({ type: "message_update", assistantMessageEvent: { type: "bogus" } }).kind === "mismatch");
t("checkEvent: message_update toolcall_delta with a STRING delta -> ok (the blocker-fix pin)",
  checkEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '{"pa' } }).kind === "ok");
t("checkEvent: message_update toolcall_delta with a NON-string delta -> mismatch",
  checkEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: 42 } }).kind === "mismatch");

// the extension_ui_request method subcheck
t("checkEvent: extension_ui_request with an unknown method -> mismatch",
  checkEvent({ type: "extension_ui_request", id: "x", method: "holo_display" }).kind === "mismatch");

// --- checkResponseData --------------------------------------------------------
t("checkResponseData: get_available_models needs a models array",
  checkResponseData("get_available_models", { models: [] }).length === 0 &&
  checkResponseData("get_available_models", {}).length === 1);
t("checkResponseData: get_state fields are all optional (loose)",
  checkResponseData("get_state", {}).length === 0 &&
  checkResponseData("get_state", { model: {}, thinkingLevel: "high" }).length === 0);
t("checkResponseData: get_state with a wrong-kind field -> problem",
  checkResponseData("get_state", { thinkingLevel: 5 }).length === 1);
t("checkResponseData: an un-specced command -> no problems", checkResponseData("no_such_command", { anything: 1 }).length === 0);

// --- contract self-consistency ------------------------------------------------
t("contract: every RPC_ALLOWED member has a COMMANDS_SENT entry",
  [...RPC_ALLOWED].every((c) => Object.prototype.hasOwnProperty.call(COMMANDS_SENT, c)));
t("contract: every RESPONSE_DATA key is a COMMANDS_SENT entry",
  Object.keys(RESPONSE_DATA).every((k) => Object.prototype.hasOwnProperty.call(COMMANDS_SENT, k)));
t("contract: EVENTS_CONSUMED and EVENTS_KNOWN_IGNORED do not overlap",
  !Object.keys(EVENTS_CONSUMED).some((ty) => EVENTS_KNOWN_IGNORED.includes(ty)));

console.log(`  ${n} protocol contract tests passed`);
process.exit(0);
