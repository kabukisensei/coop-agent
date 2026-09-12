import { projectTranscriptMessages, selectSessionChain, REPLAY_THINKING_MAX, REPLAY_TOOL_OUT_MAX } from "../web/transcript-replay.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { writeSse } from "../web/sse-writer.mjs";
import { readFileSync } from "node:fs";
import { buildExecutionEnvelope, capabilityForTool } from "../web/execution-envelope.mjs";
import { RuntimeEventStream } from "../web/runtime-events.mjs";

let count = 0;
const test = async (name, fn) => {
  await fn();
  count++;
  console.log(`  ✓ ${name}`);
};

await test("slow SSE clients queue in order until drain and disconnect at a byte budget", () => {
  class Response extends EventEmitter {
    writableLength = 0;
    frames = [];
    blocked = true;
    write(frame) { this.frames.push(frame); this.writableLength += Buffer.byteLength(frame); return !this.blocked; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const slow = new Response();
  assert.equal(writeSse(slow, "one", 20), true);
  assert.equal(writeSse(slow, "two", 20), true);
  assert.deepEqual(slow.frames, ["one"]);
  slow.blocked = false;
  slow.writableLength = 0;
  slow.emit("drain");
  assert.deepEqual(slow.frames, ["one", "two"]);
  const stuck = new Response();
  writeSse(stuck, "12345", 10);
  writeSse(stuck, "67890", 10);
  assert.equal(writeSse(stuck, "x", 10), false);
  assert.equal(stuck.destroyed, true);
  assert.equal(writeSse(stuck, "after", 10), false);
  const healthy = new Response(); healthy.blocked = false;
  assert.equal(writeSse(healthy, "unaffected", 20), true);
  const unicode = new Response();
  assert.equal(writeSse(unicode, "😀", 3), false);
});

await test("renderer forced reconnect replays the active session while ordinary reselection is a no-op", async () => {
  const source = readFileSync(new URL("../web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function switchChat(");
  const end = source.indexOf("// A working-folder change", start);
  const seen = [];
  const context = vm.createContext({
    chatsState: new Map([["one", { cwd: "/project" }]]), activeSid: "one", switching: false,
    switchSeq: 0, pendingLive: [], mode: "sse", window: {}, replaying: false,
    fetch: async url => { seen.push(url); return { ok: true, json: async () => ({ next: 1, events: [JSON.stringify({ type: "extension_ui_request", id: "approval" })] }) }; },
    handle: event => seen.push(event.id), renderTabs() {}, renderQueue() {}, resetTranscript() {},
    setCwd() {}, refreshState() {}, resetPanels() {}, maybeOpenDesktopMissionControl() {},
    clearUsage() { seen.push("usage-cleared"); },
  });
  vm.runInContext(source.slice(start, end), context);
  await context.switchChat("one");
  assert.deepEqual(seen, []);
  await context.switchChat("one", { force: true });
  assert.deepEqual(seen, ["usage-cleared", "/events-poll?sid=one&since=0", "approval"]);
  assert.equal(context.activeSid, "one");
  assert.equal(context.switching, false);
  assert.match(source, /else \{ ensureActiveExists\(\); if \(!desktopNavigationRestoring && activeSid\) switchChat\(activeSid, \{ force: true \}\); \}/);
});

await test("active-branch replay retains ordered reasoning, tool evidence and unknown completion", () => {
  const input = [null, { role: "user", content: "Question\u2028second line" },
    { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(REPLAY_THINKING_MAX + 1) },
      { type: "toolCall", id: "failed", name: "bash", arguments: { command: "sleep 90" } },
      { type: "toolCall", id: "missing", name: "write", arguments: {} },
      { type: "text", text: "Done" }] },
    { role: "toolResult", toolCallId: "failed", isError: true, content: [{ type: "text", text: "Command aborted" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "ok", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "ok", isError: false, content: "a".repeat(REPLAY_TOOL_OUT_MAX + 1) }];
  const before = JSON.stringify(input);
  const events = projectTranscriptMessages(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(events[0].text, "Question\u2028second line");
  assert.equal(events[1].parts[0].text.length, REPLAY_THINKING_MAX);
  assert.deepEqual(events[1].parts[1], { kind: "tool", name: "bash", args: { command: "sleep 90" }, output: "Command aborted", isError: true, incomplete: false });
  assert.equal(events[1].parts[2].incomplete, true);
  assert.equal(events[1].parts[3].text, "Done");
  assert.equal(events[2].parts[0].incomplete, false);
  assert.match(events[2].parts[0].output, /1 more chars/);
  assert.deepEqual(projectTranscriptMessages(null), []);
  assert.deepEqual(projectTranscriptMessages([{ role: "assistant", content: [null, {}] }]), []);
});

await test("History branch selection follows Pi's leaf and rejects ambiguous or broken chains", () => {
  const entries = [{ type: "session", id: "header" },
    { id: "root", parentId: null }, { id: "selected", parentId: "root", timestamp: 1 },
    { id: "other", parentId: "root", timestamp: Number.MAX_SAFE_INTEGER }];
  assert.deepEqual(selectSessionChain(entries, "selected"), { chain: entries.slice(1, 3), branched: true });
  assert.deepEqual(selectSessionChain(entries, "root").chain, [entries[1]]);
  assert.deepEqual(selectSessionChain(entries, null).chain, []);
  assert.equal(selectSessionChain(entries, undefined), null);
  assert.equal(selectSessionChain(entries, "missing"), null);
  assert.equal(selectSessionChain([...entries, entries[1]], "selected"), null);
  assert.equal(selectSessionChain([{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }], "a"), null);
  assert.equal(selectSessionChain([{ id: "a", parentId: "missing" }], "a"), null);
});

await test("execution and evidence states remain independent", () => {
  const envelope = buildExecutionEnvelope({
    toolName: "dax_review",
    isError: false,
    result: {
      content: [{ type: "text", text: "One report file could not be parsed." }],
      details: { report: {
        version: "0.22.0",
        coverage: { pbir: { status: "partial", files_attempted: 2, files_parsed: 1 } },
        summary: { error: 1, warning: 0, info: 0 },
        findings: [{ rule_id: "DAX-BROKEN-FIELD-REF" }],
        agent_review: [],
        diagnostics: [{ severity: "error", message: "bad visual" }],
        verdict: { clean: false },
      } },
    },
  }, { runId: "run-1", artifactId: "artifact-1" });
  assert.equal(envelope.capabilityId, "coop.review.dax");
  assert.equal(envelope.executionStatus, "completed");
  assert.equal(envelope.evidenceStatus, "partial");
  assert.equal(envelope.verdict, "findings");
  assert.equal(envelope.results.findings.length, 1);
  assert.deepEqual(envelope.artifacts, [{ id: "artifact-1", kind: "raw-tool-output", mediaType: "application/json" }]);
});

await test("tool errors are failed evidence and unknown tools do not impersonate capabilities", () => {
  const failed = buildExecutionEnvelope({ toolName: "sql_review", isError: true, result: {} }, { runId: "run-2", artifactId: "artifact-2" });
  assert.equal(failed.executionStatus, "failed");
  assert.equal(failed.evidenceStatus, "failed");
  assert.equal(failed.verdict, "failed");
  assert.equal(capabilityForTool("bash"), null);
  assert.equal(buildExecutionEnvelope({ toolName: "bash", isError: false }, { runId: "run-3", artifactId: "artifact-3" }), null);
});

await test("legacy Data Doc lineage remains usable but cannot claim complete edge evidence", () => {
  const envelope = buildExecutionEnvelope({
    toolName: "data_doc",
    isError: false,
    result: { details: { lineage: { object: { id: "gold_table:dbo.fact" }, upstream: [], downstream: [] } } },
  }, { runId: "lineage-legacy", artifactId: "lineage-legacy-raw" });
  assert.equal(envelope.executionStatus, "completed");
  assert.equal(envelope.evidenceStatus, "partial");
  assert.equal(envelope.results.data.object.id, "gold_table:dbo.fact");
});

await test("runtime stream is monotonic, reconnectable, and snapshot-aware", () => {
  let tick = 0;
  const stream = new RuntimeEventStream({
    streamId: "c1",
    maxEvents: 10,
    now: () => new Date(Date.UTC(2026, 8, 4, 12, 0, tick++)),
  });
  stream.append("session.started", { cwd: "/workspace" });
  stream.revise();
  for (let i = 0; i < 11; i++) stream.append("agent.message.delta", { delta: String(i) });
  const poll = stream.poll(0);
  assert.equal(poll.baseSequence, 2);
  assert.equal(poll.nextSequence, 12);
  assert.equal(poll.snapshotRevision, 1);
  assert.equal(poll.resetRequired, true);
  assert.equal(poll.events[0].sequence, 3);
  assert.equal(new Set(poll.events.map((event) => event.eventId)).size, poll.events.length);
  const incremental = stream.poll(10);
  assert.deepEqual(incremental.events.map((event) => event.sequence), [11, 12]);
  assert.equal(incremental.resetRequired, false);
});

await test("checked-in schemas pin the public contract versions and state vocabularies", () => {
  const envelopeSchema = JSON.parse(readFileSync(new URL("../config/execution-envelope.schema.json", import.meta.url), "utf8"));
  const eventSchema = JSON.parse(readFileSync(new URL("../config/runtime-event.schema.json", import.meta.url), "utf8"));
  assert.equal(envelopeSchema.properties.schemaVersion.const, 1);
  assert.deepEqual(envelopeSchema.properties.executionStatus.enum, ["completed", "failed", "cancelled"]);
  assert.deepEqual(envelopeSchema.properties.evidenceStatus.enum, ["complete", "partial", "failed", "not-applicable"]);
  assert.equal(eventSchema.properties.contractVersion.const, 1);
  assert.ok(eventSchema.required.includes("snapshotRevision"));
  assert.ok(eventSchema.required.includes("raw"));
});

console.log(`runtime domain contracts: ${count} tests passed`);
