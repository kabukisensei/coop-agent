/** Contract tests for the final model-provider login handoff. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST is required");
const { default: coopTools, modelLoginAuthPath, shouldPrimeModelLogin, modelLoginCredentialFingerprint } = await import(
  pathToFileURL(join(dist, "coop-tools.mjs"))
);

const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldPrime = process.env.COOP_PRIME_MODEL_LOGIN;
const oldLoginOnly = process.env.COOP_LOGIN_ONLY;
try {
  const agentDir = mkdtempSync(join(tmpdir(), "coop-model-login-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.COOP_PRIME_MODEL_LOGIN = "1";

  assert.equal(modelLoginAuthPath(), join(agentDir, "auth.json"));
  assert.equal(shouldPrimeModelLogin({ hasUI: true, mode: "tui" }), true);
  assert.equal(shouldPrimeModelLogin({ hasUI: true, mode: "rpc" }), false);

  const handlers = new Map();
  const commands = new Map();
  const pi = {
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage() {},
  };
  coopTools(pi);
  let refreshOptions;
  let finishRefresh;
  const refreshing = commands.get("coop-refresh-models").handler("", { modelRegistry: {
    refresh(options) { refreshOptions = options; return new Promise(resolve => { finishRefresh = resolve; }); },
  } });
  let refreshFinished = false;
  refreshing.then(() => { refreshFinished = true; });
  await Promise.resolve();
  assert.equal(refreshFinished, false, "model refresh must finish before the RPC can list models");
  assert.deepEqual(refreshOptions, { allowNetwork: false });
  finishRefresh(); await refreshing;

  let editorText = "";
  const notices = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      setEditorText(value) { editorText = value; },
      notify(message) { notices.push(message); },
    },
  };
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(editorText, "/login openai-codex");
  assert.ok(notices.some((message) => message.includes("press Enter")));
  assert.equal(process.env.COOP_PRIME_MODEL_LOGIN, undefined, "handoff is one-shot");
  console.log("  ✓ fresh interactive Coop primes /login openai-codex before other startup dialogs");

  process.env.COOP_PRIME_MODEL_LOGIN = "1";
  process.env.COOP_LOGIN_ONLY = "1";
  for (const value of [{}, { other: { type: "oauth" } }, { "openai-codex": { type: "oauth" } }, { "openai-codex": { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 1 } }]) {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(value));
    assert.equal(modelLoginCredentialFingerprint(), null);
  }
  writeFileSync(join(agentDir, "auth.json"), "not-json");
  assert.equal(modelLoginCredentialFingerprint(), null);
  const credentials = { "openai-codex": { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000 } };
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials));
  assert.match(modelLoginCredentialFingerprint(), /^[a-f0-9]{64}$/);
  const loginHandlers = new Map();
  coopTools({
    ...pi,
    on(name, handler) { loginHandlers.set(name, handler); },
  });
  let shutdown = false;
  await loginHandlers.get("session_start")({ reason: "startup" }, {
    ...ctx,
    cwd: join(process.cwd(), "login-only"),
    model: { provider: "openai-codex", id: "gpt-5.5" },
    shutdown() { shutdown = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(shutdown, false, "existing credentials must not finish a new login");
  writeFileSync(join(agentDir, "auth.json"), "{}");
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(shutdown, false, "an empty auth file must not finish a login");
  credentials["openai-codex"].access = "test-new-access";
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials));
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(shutdown, true, "successful sign-in should return control to the installer");
  console.log("  ✓ sign-in-only mode closes after Pi stores model credentials");
} finally {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldPrime === undefined) delete process.env.COOP_PRIME_MODEL_LOGIN;
  else process.env.COOP_PRIME_MODEL_LOGIN = oldPrime;
  if (oldLoginOnly === undefined) delete process.env.COOP_LOGIN_ONLY;
  else process.env.COOP_LOGIN_ONLY = oldLoginOnly;
}
