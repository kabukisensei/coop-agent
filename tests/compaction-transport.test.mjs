// Issue #236: coop-tools answers `session_before_compact` with a compaction it ran
// over the configured SSE transport, using Pi's own compact() through injected seams.
// Bundle built by tests/run.sh (COOP_TEST_DIST).
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST must be set by tests/run.sh");
const mod = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);
const { createCompactionTransportHandler, readPiTransportSettings, TRANSPORT_AWARE_APIS } = mod;

// --- settings reader mirrors Pi's resolution -------------------------------
const dir = mkdtempSync(join(tmpdir(), "coop-compact-"));
assert.deepEqual(readPiTransportSettings(dir).transport, "auto", "missing settings.json → auto");
assert.equal(readPiTransportSettings(dir).timeoutMs, 300000, "Pi default idle timeout");
writeFileSync(join(dir, "settings.json"), "{not json");
assert.equal(readPiTransportSettings(dir).transport, "auto", "malformed settings → auto");
writeFileSync(join(dir, "settings.json"), JSON.stringify({ transport: "sse", httpIdleTimeoutMs: 0, retry: { maxRetries: 5 } }));
let s = readPiTransportSettings(dir);
assert.equal(s.transport, "sse");
assert.equal(s.timeoutMs, 2147483647, "httpIdleTimeoutMs 0 disables, like Pi's sdk");
assert.equal(s.retry.maxRetries, 5);
assert.equal(s.retry.enabled, true);
writeFileSync(join(dir, "settings.json"), JSON.stringify({ transport: "sse", httpIdleTimeoutMs: 1000, retry: { provider: { timeoutMs: 42 } } }));
assert.equal(readPiTransportSettings(dir).timeoutMs, 42, "retry.provider.timeoutMs wins over httpIdleTimeoutMs");
writeFileSync(join(dir, "settings.json"), JSON.stringify({ websockets: false }));
assert.equal(readPiTransportSettings(dir).transport, "sse", "legacy websockets:false → sse");
writeFileSync(join(dir, "settings.json"), JSON.stringify({ transport: "bogus" }));
assert.equal(readPiTransportSettings(dir).transport, "auto", "unknown transport → auto");

assert.ok(TRANSPORT_AWARE_APIS.has("openai-codex-responses"));

// --- handler ----------------------------------------------------------------
const codexModel = { provider: "openai-codex", id: "gpt-5", api: "openai-codex-responses", reasoning: true };
const preparation = { firstKeptEntryId: "e9", messagesToSummarize: [{ role: "user", content: "hi" }], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 123, settings: { reserveTokens: 16384 } };

function makeDeps(settings, overrides = {}) {
  const calls = { compact: [], stream: [] };
  const deps = {
    readSettings: () => ({ transport: "auto", timeoutMs: 300000, retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 }, ...settings }),
    loadCompact: async () => async (...args) => {
      calls.compact.push(args);
      const [prep, model, apiKey, headers, custom, signal, thinking, streamFn, env, retry] = args;
      // Exercise the stream function the way Pi's completeSummarization does.
      const res = await streamFn(model, { messages: prep.messagesToSummarize }, { signal, apiKey, headers, env, cacheRetention: "none", sessionId: "fresh" });
      return { summary: `summary via ${res.transport}`, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, details: { thinking, retry, custom } };
    },
    loadStreamSimple: async () => (model, context, options) => {
      calls.stream.push({ model, context, options });
      return { transport: options.transport, result: async () => ({ role: "assistant", content: [] }) };
    },
    getThinkingLevel: () => "high",
    ...overrides,
  };
  return { deps, calls };
}
const okRegistry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "tok", headers: { "x-a": "1", "x-gone": null }, baseUrl: "https://chatgpt.example/backend-api" }) };

// 1. transport sse + Codex model: coop compacts over SSE for manual and automatic reasons.
for (const reason of ["manual", "threshold", "overflow"]) {
  const { deps, calls } = makeDeps({ transport: "sse", timeoutMs: 7000 });
  const handler = createCompactionTransportHandler(deps);
  const signal = new AbortController().signal;
  const out = await handler({ type: "session_before_compact", preparation, reason, willRetry: false, signal, customInstructions: reason === "manual" ? "keep it short" : undefined }, { model: codexModel, modelRegistry: okRegistry, thinkingLevel: "low" });
  assert.ok(out && out.compaction, `${reason}: returns a compaction`);
  assert.equal(out.compaction.summary, "summary via sse", `${reason}: summary generated over sse`);
  assert.equal(out.compaction.firstKeptEntryId, "e9");
  assert.equal(out.compaction.tokensBefore, 123);
  assert.equal(calls.compact.length, 1);
  const [prep, model, apiKey, headers, custom, sig, thinking, , env, retry] = calls.compact[0];
  assert.equal(prep, preparation, "preparation passed through untouched");
  assert.equal(model.baseUrl, "https://chatgpt.example/backend-api", "resolved baseUrl applied to the request model");
  assert.equal(model.api, "openai-codex-responses");
  assert.equal(apiKey, "tok");
  assert.deepEqual(headers, { "x-a": "1" }, "null (deleted) headers dropped");
  assert.equal(custom, reason === "manual" ? "keep it short" : undefined);
  assert.equal(sig, signal, "abort signal forwarded");
  assert.equal(thinking, "low", "context thinking level wins");
  assert.equal(env, undefined);
  assert.equal(retry.maxRetries, 3);
  assert.equal(calls.stream.length, 1);
  const opts = calls.stream[0].options;
  assert.equal(opts.transport, "sse", "stream options carry the configured transport");
  assert.equal(opts.timeoutMs, 7000, "idle timeout from settings");
  assert.equal(opts.cacheRetention, "none", "Pi's own summarization options are preserved");
  assert.equal(opts.sessionId, "fresh");
  assert.equal(opts.apiKey, "tok");
}

// 2. thinking level falls back to pi.getThinkingLevel() when the context has none.
{
  const { deps, calls } = makeDeps({ transport: "sse" });
  await createCompactionTransportHandler(deps)({ preparation, reason: "manual", signal: undefined }, { model: codexModel, modelRegistry: okRegistry });
  assert.equal(calls.compact[0][6], "high");
}

// 3. Any other transport leaves Pi's default path alone (auto, websocket, websocket-cached).
for (const transport of ["auto", "websocket", "websocket-cached"]) {
  const { deps, calls } = makeDeps({ transport });
  const out = await createCompactionTransportHandler(deps)({ preparation, reason: "manual" }, { model: codexModel, modelRegistry: okRegistry });
  assert.equal(out, undefined, `${transport}: Pi compacts`);
  assert.equal(calls.compact.length, 0);
}

// 4. A model whose provider ignores `transport` is left to Pi.
{
  const { deps, calls } = makeDeps({ transport: "sse" });
  const out = await createCompactionTransportHandler(deps)({ preparation, reason: "manual" }, { model: { ...codexModel, api: "anthropic-messages" }, modelRegistry: okRegistry });
  assert.equal(out, undefined);
  assert.equal(calls.compact.length, 0);
}
{
  const { deps } = makeDeps({ transport: "sse" });
  assert.equal(await createCompactionTransportHandler(deps)({ preparation, reason: "manual" }, { model: undefined, modelRegistry: okRegistry }), undefined, "no model → Pi");
}

// 5. Auth that cannot be resolved, or a Pi without the seams, falls back to Pi's own path.
{
  const { deps, calls } = makeDeps({ transport: "sse" });
  const out = await createCompactionTransportHandler(deps)({ preparation, reason: "manual" }, { model: codexModel, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } });
  assert.equal(out, undefined);
  assert.equal(calls.compact.length, 0);
}
{
  const { deps } = makeDeps({ transport: "sse" }, { loadCompact: async () => { throw new Error("no export"); } });
  assert.equal(await createCompactionTransportHandler(deps)({ preparation, reason: "manual" }, { model: codexModel, modelRegistry: okRegistry }), undefined, "missing compact() export → Pi");
}
{
  const { deps } = makeDeps({ transport: "sse" }, { readSettings: () => { throw new Error("boom"); } });
  assert.equal(await createCompactionTransportHandler(deps)({ preparation, reason: "manual" }, { model: codexModel, modelRegistry: okRegistry }), undefined, "settings error → Pi");
}
{
  const { deps } = makeDeps({ transport: "sse" });
  assert.equal(await createCompactionTransportHandler(deps)({ preparation, reason: "manual" }, { model: codexModel }), undefined, "no modelRegistry → Pi");
}

// 6. A provider failure during the SSE summary propagates as ONE clear failure (Pi then
//    emits session_compact_failed and keeps the history); nothing is silently swallowed.
{
  const { deps } = makeDeps({ transport: "sse" }, { loadStreamSimple: async () => () => { throw new Error("Codex SSE response headers timed out after 7000ms"); } });
  await assert.rejects(
    createCompactionTransportHandler(deps)({ preparation, reason: "threshold" }, { model: codexModel, modelRegistry: okRegistry }),
    /timed out after 7000ms/,
  );
}

// 7. Registration: coopTools(pi) registers the hook under session_before_compact.
{
  const events = [];
  const pi = {
    on: (event) => { events.push(event); },
    registerTool: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    sendUserMessage: () => {},
    getThinkingLevel: () => "medium",
  };
  mod.default(pi);
  assert.ok(events.includes("session_before_compact"), "coop-tools registers session_before_compact");
}

console.log("✓ compaction-transport tests passed");
