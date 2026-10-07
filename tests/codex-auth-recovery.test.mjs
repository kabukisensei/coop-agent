// A long Codex session survives a ChatGPT sign-in refresh: coop-tools closes the
// session's cached Codex connections when the token changes, and turns the backend's
// "auth context mismatch" rejection into an error Pi's auto-retry sends again.
// Bundle built by tests/run.sh (COOP_TEST_DIST).
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST must be set by tests/run.sh");
const mod = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);
const { createCodexAuthRecovery, CODEX_AUTH_CONTEXT_MISMATCH, CODEX_AUTH_RETRY_NOTE } = mod;

// Pi 0.87.1's retry pattern includes "connection.?lost"; the note must match it and
// must not look like a usage limit (Pi never retries those).
assert.match(CODEX_AUTH_RETRY_NOTE, /connection.?lost/i);
assert.doesNotMatch(CODEX_AUTH_RETRY_NOTE, /usage limit|quota|billing/i);
assert.match("Codex error: native turn auth context mismatch: scopes", CODEX_AUTH_CONTEXT_MISMATCH);

const codexModel = { provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" };
const otherModel = { provider: "anthropic", id: "claude", api: "anthropic-messages" };

function makeCtx({ model = codexModel, token = "tok-1", sessionId = "s1" } = {}) {
  const state = { token, model, sessionId };
  return {
    state,
    get model() { return state.model; },
    sessionManager: { getSessionId: () => state.sessionId },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: state.token }) },
  };
}
function makeRecovery({ fail = false } = {}) {
  const cleaned = [];
  const recovery = createCodexAuthRecovery({
    loadCleanup: async () => {
      if (fail) throw new Error("no seam");
      return (id) => cleaned.push(id);
    },
  });
  return { recovery, cleaned };
}

// --- before_provider_request -------------------------------------------------
{
  const { recovery, cleaned } = makeRecovery();
  const ctx = makeCtx();
  assert.equal(await recovery.beforeProviderRequest({ payload: { a: 1 } }, ctx), undefined, "payload never changes");
  assert.deepEqual(cleaned, [], "first request only records the token");
  await recovery.beforeProviderRequest({ payload: {} }, ctx);
  assert.deepEqual(cleaned, [], "same token keeps the cached connection");
  ctx.state.token = "tok-2";
  await recovery.beforeProviderRequest({ payload: {} }, ctx);
  assert.deepEqual(cleaned, ["s1"], "refreshed token closes the session's cached connections");
  await recovery.beforeProviderRequest({ payload: {} }, ctx);
  assert.deepEqual(cleaned, ["s1"], "only once per refresh");
  ctx.state.sessionId = "s2";
  await recovery.beforeProviderRequest({ payload: {} }, ctx);
  assert.deepEqual(cleaned, ["s1"], "a new session starts its own record");
}
{
  const { recovery, cleaned } = makeRecovery();
  const ctx = makeCtx({ model: otherModel });
  await recovery.beforeProviderRequest({ payload: {} }, ctx);
  ctx.state.token = "tok-2";
  await recovery.beforeProviderRequest({ payload: {} }, ctx);
  assert.deepEqual(cleaned, [], "non-Codex models are untouched");
}
{
  const { recovery } = makeRecovery({ fail: true });
  const ctx = makeCtx();
  await recovery.beforeProviderRequest({ payload: {} }, ctx);
  ctx.state.token = "tok-2";
  assert.equal(await recovery.beforeProviderRequest({ payload: {} }, ctx), undefined, "a missing seam never throws");
  const broken = { ...makeCtx(), modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("x"); } } };
  assert.equal(await recovery.beforeProviderRequest({ payload: {} }, broken), undefined, "auth lookup failure never throws");
}

// --- message_end ---------------------------------------------------------------
const failed = {
  role: "assistant",
  api: "openai-codex-responses",
  provider: "openai-codex",
  content: [],
  stopReason: "error",
  errorMessage: "Codex error: native turn auth context mismatch: scopes",
};
{
  const { recovery, cleaned } = makeRecovery();
  const ctx = makeCtx();
  const out = await recovery.messageEnd({ message: failed }, ctx);
  assert.deepEqual(cleaned, ["s1"], "the mismatch closes the cached connections");
  assert.ok(out?.message, "the message is replaced");
  assert.equal(out.message.role, "assistant");
  assert.equal(out.message.stopReason, "error", "still an error, so Pi retries rather than continuing");
  assert.ok(out.message.errorMessage.startsWith(failed.errorMessage), "the original error text is kept");
  assert.ok(out.message.errorMessage.includes(CODEX_AUTH_RETRY_NOTE));
  assert.equal(failed.errorMessage, "Codex error: native turn auth context mismatch: scopes", "the original object is not mutated");
  assert.equal(await recovery.messageEnd({ message: out.message }, ctx), undefined, "an already-marked error is left alone");
}
{
  const { recovery, cleaned } = makeRecovery();
  const ctx = makeCtx();
  assert.equal(await recovery.messageEnd({ message: { ...failed, errorMessage: "Codex error: something else" } }, ctx), undefined, "other errors untouched");
  assert.equal(await recovery.messageEnd({ message: { ...failed, stopReason: "stop" } }, ctx), undefined, "successful turns untouched");
  assert.equal(await recovery.messageEnd({ message: { ...failed, role: "user" } }, ctx), undefined, "user messages untouched");
  assert.equal(await recovery.messageEnd({ message: { ...failed, api: "anthropic-messages" } }, ctx), undefined, "other providers untouched");
  assert.deepEqual(cleaned, []);
}
{
  const { recovery } = makeRecovery({ fail: true });
  assert.equal(await recovery.messageEnd({ message: failed }, makeCtx()), undefined, "no reset possible: Pi's own error stands");
}

console.log("✓ Codex sign-in refresh recovery tests passed");
