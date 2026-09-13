import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  buildRuntimeShutdownInvocation,
  buildTerminalLaunchRequest,
  validateTerminalHandoffRequest,
} from "../web/terminal-handoff.mjs";

const dist = process.env.COOP_TEST_DIST;
const extension = dist ? await import(pathToFileURL(`${dist}/coop-tools.mjs`).href) : null;
let count = 0;
const test = async (name, fn) => {
  await fn();
  count++;
  console.log(`  ✓ ${name}`);
};

await test("handoff mode is allowlisted", () => {
  assert.deepEqual(validateTerminalHandoffRequest({ mode: "open", executable: "sh" }), { ok: true, mode: "open" });
  assert.equal(validateTerminalHandoffRequest({ mode: "shell", command: "rm" }).ok, false);
  assert.equal(validateTerminalHandoffRequest(null).ok, false);
});

await test("launch descriptors never accept renderer-controlled commands", () => {
  assert.deepEqual(buildTerminalLaunchRequest({
    handoffId: "handoff-1",
    mode: "open",
    cwd: "/workspace",
  }), {
    ok: true,
    launch: {
      schemaVersion: 1,
      kind: "native-terminal",
      handoffId: "handoff-1",
      mode: "open",
      cwd: "/workspace",
      executable: "coop",
      args: [],
    },
  });
  const clone = buildTerminalLaunchRequest({
    handoffId: "handoff-2",
    mode: "clone",
    cwd: "/workspace",
    sessionPath: "/agent/sessions/clone.jsonl",
    executable: "evil",
  });
  assert.equal(clone.ok, true);
  assert.equal(clone.launch.executable, "coop");
  assert.deepEqual(clone.launch.args, ["--session", "/agent/sessions/clone.jsonl"]);
  assert.equal(buildTerminalLaunchRequest({ handoffId: "handoff-3", mode: "move", cwd: "/workspace" }).ok, false);
});

await test("runtime shutdown adapter is authenticated and RPC-only", async () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const invocation = buildRuntimeShutdownInvocation({ requestId: "handoff-4", secret });
  assert.equal(invocation.ok, true);
  assert.match(invocation.command.message, /^\/coop-runtime-shutdown [A-Za-z0-9_-]+$/);
  if (!extension) return;
  const encoded = invocation.command.message.split(" ")[1];
  assert.deepEqual(extension.decodeRuntimeShutdownRequest(encoded), {
    requestId: "handoff-4",
    bridgeSecret: secret,
  });
  let shutdowns = 0;
  extension.shutdownFromRuntime(encoded, { mode: "rpc", shutdown: () => { shutdowns++; } }, secret);
  assert.equal(shutdowns, 1);
  assert.throws(() => extension.shutdownFromRuntime(encoded, { mode: "rpc", shutdown: () => {} }, "wrong-secret-wrong-secret"), /authentication failed/);
  assert.throws(() => extension.shutdownFromRuntime(encoded, { mode: "tui", shutdown: () => {} }, secret), /Coop Runtime only/);
});

console.log(`terminal handoff: ${count} tests passed`);
