import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeInvocation, startCoopRuntime, validateRuntimeReady } from "../desktop/spikes/electron/runtime-supervisor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`  ✓ ${name}`); }

await test("Desktop invokes only the supported runtime command and never reconstructs Pi arguments", () => {
  const call = buildRuntimeInvocation({ coopCommand: "coop", workspace: "/work/client", port: 0 });
  assert.equal(call.command, "coop");
  assert.deepEqual(call.args, ["runtime", "--transport", "http", "--json", "--port", "0", "--cwd", "/work/client"]);
  assert.equal(call.args.includes("pi"), false);
  assert.equal(call.args.includes("--mode"), false);
});

await test("ready handshake accepts only the versioned loopback transport", () => {
  const base = { type: "runtime.ready", contractVersion: 1, transport: "http", endpoint: "http://127.0.0.1:7420", oneTimeToken: "0".repeat(32), runtimePid: 123 };
  assert.equal(validateRuntimeReady(base).endpoint, "http://127.0.0.1:7420");
  assert.throws(() => validateRuntimeReady({ ...base, endpoint: "http://0.0.0.0:7420" }), /loopback/);
  assert.throws(() => validateRuntimeReady({ ...base, oneTimeToken: "weak" }), /token/);
});

await test("runtime supervisor reads the structured handshake and cleans up its child", async () => {
  const fixture = join(ROOT, "tests", "fixtures", "stub-coop-runtime.mjs");
  const runtime = await startCoopRuntime({ workspace: ROOT, coopCommand: process.execPath, commandPrefix: [fixture], readyTimeoutMs: 5000 });
  assert.equal(runtime.ready.piVersion, "0.84.3");
  assert.equal(runtime.child.exitCode, null);
  let closed = false;
  runtime.child.once("close", () => { closed = true; });
  await runtime.stop({ graceMs: 1000 });
  // Windows may report termination as a signal, leaving exitCode null. Check
  // the actual lifecycle and PID instead of requiring a numeric exit status.
  assert.equal(closed, true);
  assert.throws(() => process.kill(runtime.child.pid, 0), { code: "ESRCH" });
});

await test("runtime supervisor handles signal termination without escalating to SIGKILL or re-killing", async () => {
  function createMockSpawn({ preTerminated = false } = {}) {
    const signals = [];
    const terminatedPids = [];
    let spawned = null;
    const spawnImpl = () => {
      const child = new EventEmitter();
      spawned = child;
      child.pid = 43210;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = preTerminated ? "SIGTERM" : null;
      child.kill = (signal = "SIGTERM") => {
        signals.push(signal);
        child.exitCode = null;
        child.signalCode = signal;
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({
          type: "runtime.ready",
          contractVersion: 1,
          transport: "http",
          endpoint: "http://127.0.0.1:54321",
          oneTimeToken: "0123456789abcdef0123456789abcdef",
          runtimePid: 12345,
        }) + "\n");
        if (preTerminated) queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      });
      return child;
    };
    // On Windows the supervisor stops the tree via taskkill on child.pid rather
    // than child.kill; route the injected terminator through the mock kill so
    // the signal contract is exercised on every platform and no real PID is
    // ever touched.
    const terminateTreeImpl = async (pid) => {
      terminatedPids.push(pid);
      spawned.kill("SIGTERM");
    };
    return { spawnImpl, signals, terminatedPids, terminateTreeImpl };
  }

  // 1. stop sends SIGTERM but does not escalate after confirmed termination
  const { spawnImpl: spawnRunning, signals: runningSignals, terminatedPids: runningTerminated, terminateTreeImpl: runningTerminate } = createMockSpawn();
  const running = await startCoopRuntime({ workspace: ROOT, spawnImpl: spawnRunning, terminateTreeImpl: runningTerminate });
  assert.equal(running.child.exitCode, null);
  assert.equal(running.child.signalCode, null);

  await running.stop({ graceMs: 500 });
  assert.deepEqual(runningSignals, ["SIGTERM"]);
  if (process.platform === "win32") assert.deepEqual(runningTerminated, [43210]);
  assert.equal(running.child.exitCode, null);
  assert.equal(running.child.signalCode, "SIGTERM");

  // 2. Calling stop again sends no additional signals
  await running.stop({ graceMs: 500 });
  assert.deepEqual(runningSignals, ["SIGTERM"]);
  if (process.platform === "win32") assert.deepEqual(runningTerminated, [43210]);

  // 3. A child already terminated by signal receives no kill request
  const { spawnImpl: spawnTerminated, signals: terminatedSignals, terminatedPids: terminatedTreePids, terminateTreeImpl: terminatedTerminate } = createMockSpawn({ preTerminated: true });
  const terminated = await startCoopRuntime({ workspace: ROOT, spawnImpl: spawnTerminated, terminateTreeImpl: terminatedTerminate });
  assert.equal(terminated.child.exitCode, null);
  assert.equal(terminated.child.signalCode, "SIGTERM");

  await terminated.stop({ graceMs: 500 });
  assert.deepEqual(terminatedSignals, []);
  assert.deepEqual(terminatedTreePids, []);

});

await test("Electron renderer is sandboxed and receives only named IPC methods", () => {
  const main = readFileSync(join(ROOT, "desktop", "spikes", "electron", "main.mjs"), "utf8");
  const preload = readFileSync(join(ROOT, "desktop", "spikes", "electron", "preload.cjs"), "utf8");
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setPermissionRequestHandler\([^]*callback\(false\)/);
  assert.match(main, /event\.senderFrame === mainWindow\?\.webContents\.mainFrame/);
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|invoke)\s*[),]/);
  assert.doesNotMatch(preload, /shell\.|child_process|node:fs/);
  assert.deepEqual([...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]).sort(), ["coop:choose-workspace", "coop:get-shell-info"]);
});

await test("Tauri uses the same fixed runtime contract and a narrow command surface", () => {
  const source = readFileSync(join(ROOT, "desktop", "spikes", "tauri", "src-tauri", "src", "lib.rs"), "utf8");
  const capability = JSON.parse(readFileSync(join(ROOT, "desktop", "spikes", "tauri", "src-tauri", "capabilities", "main.json"), "utf8"));
  assert.match(source, /\.args\(\[[^]*?"runtime",[^]*?"--transport",[^]*?"http",[^]*?"--json",[^]*?"--port",[^]*?"0",[^]*?"--cwd",[^]*?workspace,[^]*?\]\)/);
  assert.doesNotMatch(source, /(?:--mode|\bpi\b|Command::new\("(?:sh|bash|zsh|powershell|pwsh)"\))/);
  assert.match(source, /recv_timeout\(Duration::from_secs\(20\)\)/);
  assert.match(source, /endpoint\.host_str\(\) != Some\("127\.0\.0\.1"\)/);
  assert.match(source, /on_navigation\(move \|target\| target\.origin\(\)\.ascii_serialization\(\) == origin\)/);
  assert.deepEqual([...source.matchAll(/#\[tauri::command\]\s*fn\s+(\w+)/g)].map((match) => match[1]).sort(), ["choose_workspace", "shell_info"]);
  assert.deepEqual(capability.remote.urls, ["http://127.0.0.1:*"]);
  assert.deepEqual(capability.permissions, ["core:default"]);
});

console.log(`desktop shell spike: ${count} tests passed`);
