#!/usr/bin/env node
// Exercise real Pi through the packaged runtime's authenticated HTTP boundary.
// No credential copying, model request, global install, or business workspace.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectManagedRuntime, resolveDesktopCoopLauncher } from "../desktop/src/managed-runtime.mjs";
import { startCoopRuntime } from "../desktop/src/runtime-supervisor.mjs";
import { checkResponseData } from "../web/protocol.mjs";

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--bundle", "--workspace", "--agent"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Expected unique --bundle, --workspace and --agent paths.");
    options[args[i]] = resolve(args[i + 1]);
  }
  if (Object.keys(options).length !== 3) throw new Error("All three paths are required.");
  const bundlePath = options["--bundle"], workspace = options["--workspace"], agent = options["--agent"];
  if (!existsSync(workspace) || existsSync(agent)) throw new Error("Use an existing disposable workspace and a fresh agent directory.");
  assert.equal(join(dirname(bundlePath), "managed-runtime"), bundlePath);
  const bundle = inspectManagedRuntime(bundlePath);
  const launcher = resolveDesktopCoopLauncher({ packaged: true, resourcesPath: dirname(bundlePath) });
  assert.equal(launcher.source, "managed");
  mkdirSync(agent, { recursive: true });
  // Preserve OS process-launch prerequisites, excluding provider keys/tokens.
  const allowed = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "SYSTEMDRIVE", "USERNAME", "USERDOMAIN", "LANG", "LC_ALL"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  Object.assign(env, { COOP_DESKTOP_AGENT_DIR: agent, COOP_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, COOP_SKIP_AZ: "1", COOP_NO_ONBOARD: "1" });
  const runtime = await startCoopRuntime({ workspace, coopCommand: launcher.command, commandPrefix: launcher.commandPrefix, env, onStderr: text => process.stderr.write(text), readyTimeoutMs: 90_000 });
  let receipt;
  try {
    const endpoint = runtime.ready.endpoint;
    const landing = await fetch(`${endpoint}/?token=${encodeURIComponent(runtime.ready.oneTimeToken)}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(landing.status, 200);
    const cookie = landing.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie?.startsWith("coop_token="), "runtime cookie missing");
    const rpc = async (type) => {
      const response = await fetch(`${endpoint}/rpc`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-coop-csrf": "1" }, body: JSON.stringify({ type }), signal: AbortSignal.timeout(40_000) });
      assert.equal(response.status, 200, `${type} HTTP status`);
      const reply = await response.json();
      assert.equal(reply.success, true, `${type} did not succeed`);
      assert.deepEqual(checkResponseData(type, reply.data), [], `${type} response contract`);
      return reply.data;
    };
    let before;
    const startup = Date.now();
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { before = await rpc("get_state"); break; }
      catch (error) {
        if (error.actual !== 504 || attempt === 4) throw error;
        console.error(JSON.stringify({ startupPending: true, attempt, elapsedMs: Date.now() - startup }));
      }
    }
    console.error(JSON.stringify({ piStartupMs: Date.now() - startup }));
    assert.equal(before.isStreaming, false);
    const commands = await rpc("get_commands");
    assert.ok(commands.commands.some((command) => command.name === "coop-refresh-models"), "managed first-party extension is not loaded");
    const models = await rpc("get_available_models");
    const stats = await rpc("get_session_stats");
    const after = await rpc("get_state");
    assert.equal(after.messageCount, 0, "model refresh must not create a model prompt");
    assert.equal(after.isStreaming, false);
    assert.equal(models.models.length, 0, "fresh isolated profile must not inherit unrelated provider credentials");
    for (const key of ["userMessages", "assistantMessages"]) if (stats[key] !== undefined) assert.equal(stats[key], 0);
    const auth = join(agent, "auth.json");
    if (existsSync(auth)) assert.deepEqual(JSON.parse(readFileSync(auth, "utf8")), {});
    receipt = { ok: true, target: `${process.platform}-${process.arch}`, pi: bundle.versions.pi, runtimePid: runtime.ready.runtimePid,
      commands: commands.commands.length, availableModels: models.models.length, messages: after.messageCount,
      checks: ["get_state", "get_commands", "model availability refresh", "get_session_stats", "empty isolated credentials"] };
  } finally { await runtime.stop({ graceMs: 5000 }); }
  assert.throws(() => process.kill(runtime.ready.runtimePid, 0), { code: "ESRCH" }, "runtime process must exit");
  let listening = false;
  try { await fetch(runtime.ready.endpoint, { signal: AbortSignal.timeout(2000) }); listening = true; } catch { /* Closed loopback listener expected. */ }
  assert.equal(listening, false, "runtime listener must close");
  console.log(JSON.stringify({ ...receipt, cleanShutdown: true }));
}

main().catch((error) => { console.error(`verify-managed-protocol: ${error.message}`); process.exitCode = 1; });
