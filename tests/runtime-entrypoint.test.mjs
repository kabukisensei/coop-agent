import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { delimiter, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let passed = 0;

function ok(message) {
  passed++;
  console.log(`  ✓ ${message}`);
}

function commandFor(args) {
  if (process.platform === "win32") {
    return {
      bin: process.env.PWSH_EXE || "powershell.exe",
      args: ["-NoProfile", "-File", join(ROOT, "bin", "coop.ps1"), ...args],
    };
  }
  return { bin: "bash", args: [join(ROOT, "bin", "coop"), ...args] };
}

function run(args, env = process.env) {
  const command = commandFor(args);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command.bin, command.args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

function waitForRuntimeEvent(child, stderrRef, timeoutMs = 15000) {
  return new Promise((resolveEvent, reject) => {
    let stdout = "";
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for runtime event; stderr=${stderrRef.value}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type?.startsWith("runtime.")) {
            clearTimeout(timer);
            resolveEvent(event);
            return;
          }
        } catch {
          // Ignore unrelated human output; --json should not emit any.
        }
      }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`runtime exited before readiness (code=${code}, signal=${signal}); stderr=${stderrRef.value}`));
    });
  });
}

function request(url, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveRequest({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
  });
}

function postJson(url, cookie, body) {
  return new Promise((resolveRequest, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        "X-Coop-CSRF": "1",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveRequest({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Pi child ${pid} remained alive after runtime shutdown`);
}

const invalid = await run(["runtime", "--transport", "stdio", "--json"]);
assert.equal(invalid.code, 2);
const invalidEvent = JSON.parse(invalid.stdout.trim());
assert.deepEqual(invalidEvent, {
  type: "runtime.error",
  contractVersion: 1,
  error: "unsupported runtime transport 'stdio' (supported: http)",
});
ok("unsupported transports fail with a structured runtime.error");

const help = await run(["runtime", "--help"]);
assert.equal(help.code, 0);
assert.match(help.stdout, /--transport http/);
ok("Bash/PowerShell entry point exposes the supported runtime contract");

if (process.platform === "win32") {
  console.log("  – lifecycle smoke is covered by the Bash/macOS suite; Windows launcher lifecycle is a DSK-012 packaging gate");
  console.log(`✓ runtime entry-point tests passed (${passed})`);
  process.exit(0);
}

const scratch = mkdtempSync(join(os.tmpdir(), "coop-runtime-test-"));
let runtime;
try {
  const stubBin = join(scratch, "bin");
  const workspace = join(scratch, "workspace with spaces");
  const marker = join(scratch, "pi-args.json");
  const envMarker = join(scratch, "pi-interface.txt");
  const pidFile = join(scratch, "pi.pid");
  const launcher = join(scratch, "pi-stub.mjs");
  const sessionDir = join(scratch, "agent", "sessions", "runtime-fixture");
  const originalSession = join(sessionDir, "original.jsonl");
  const clonedSession = join(sessionDir, "clone.jsonl");
  mkdirSync(stubBin);
  mkdirSync(workspace);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(originalSession, "{}\n", "utf8");
  writeFileSync(clonedSession, "{}\n", "utf8");
  writeFileSync(launcher, `
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
if (process.argv[2] === "--version") { console.log("pi 0.84.3"); process.exit(0); }
writeFileSync(process.env.COOP_TEST_PI_ARGS, JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.COOP_TEST_PI_INTERFACE, process.env.COOP_CLIENT_INTERFACE || "");
writeFileSync(process.env.COOP_TEST_PI_PID, String(process.pid));
await import(pathToFileURL(process.env.COOP_TEST_STUB_PI).href);
`, "utf8");
  const piPath = join(stubBin, "pi");
  writeFileSync(piPath, `#!/bin/sh\nexec "${process.execPath}" "${launcher}" "$@"\n`, "utf8");
  chmodSync(piPath, 0o755);
  const npmPath = join(stubBin, "npm");
  writeFileSync(npmPath, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(npmPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${stubBin}${delimiter}${process.env.PATH || ""}`,
    COOP_DIR: join(scratch, "coop"),
    COOP_AGENT_DIR: join(scratch, "agent"),
    PI_CODING_AGENT_DIR: join(scratch, "agent"),
    COOP_NO_ONBOARD: "1",
    COOP_SKIP_EXT_CHECK: "1",
    COOP_WEB_NO_OPEN: "1",
    COOP_TEST_PI_ARGS: marker,
    COOP_TEST_PI_INTERFACE: envMarker,
    COOP_TEST_PI_PID: pidFile,
    COOP_TEST_STUB_PI: join(ROOT, "tests", "stub-pi.mjs"),
    COOP_STUB_SESSION_FILE: originalSession,
    COOP_STUB_CLONE_SESSION_FILE: clonedSession,
  };
  const command = commandFor([
    "runtime", "--transport", "http", "--json", "--port", "0", "--cwd", workspace,
  ]);
  runtime = spawn(command.bin, command.args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  const stderrRef = { value: "" };
  runtime.stderr.on("data", (chunk) => { stderrRef.value += chunk.toString("utf8"); });
  const ready = await waitForRuntimeEvent(runtime, stderrRef);
  assert.equal(ready.type, "runtime.ready", JSON.stringify(ready));
  assert.equal(ready.contractVersion, 1);
  assert.equal(ready.transport, "http");
  assert.match(ready.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(ready.runtimePid, runtime.pid);
  assert.equal(ready.coopVersion, "0.23.1");
  assert.equal(ready.piVersion, "0.84.3");
  assert.match(ready.oneTimeToken, /^[a-f0-9]{32}$/);
  ok("runtime emits a versioned machine-readable ready event on an allocated loopback port");

  await waitForFile(marker);
  await waitForFile(envMarker);
  await waitForFile(pidFile);
  const piArgs = JSON.parse(readFileSync(marker, "utf8"));
  assert.deepEqual(piArgs.slice(-3), ["--mode", "rpc", "-a"]);
  assert.ok(piArgs.some((arg) => arg.endsWith("docs/guardrails.md")));
  assert.ok(piArgs.some((arg) => arg.endsWith("extensions/coop-tools/")) || piArgs.some((arg) => arg.endsWith("extensions/coop-tools")));
  ok("runtime consumes the governed launch spec and appends exactly --mode rpc -a");
  assert.equal(readFileSync(envMarker, "utf8"), "runtime");
  ok("runtime identifies its Pi child for shared session-lease diagnostics");
  const primaryPiPid = Number(readFileSync(pidFile, "utf8"));

  const landing = await request(`${ready.endpoint}/?token=${ready.oneTimeToken}`);
  assert.equal(landing.status, 200);
  const cookie = landing.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  assert.match(cookie || "", /^coop_token=/);
  const capabilities = await request(`${ready.endpoint}/capabilities`, { Cookie: cookie });
  assert.equal(capabilities.status, 200);
  const capabilityData = JSON.parse(capabilities.body);
  assert.equal(capabilityData.contractVersion, 1);
  assert.equal(capabilityData.versions.pi, "0.84.3");
  ok("ready endpoint authenticates and serves the shared capability contract");

  const workspaceAccess = await request(`${ready.endpoint}/workspace/access`, { Cookie: cookie });
  assert.equal(workspaceAccess.status, 200);
  assert.equal(JSON.parse(workspaceAccess.body).access.mode, "write");
  const conflicted = await postJson(`${ready.endpoint}/chat-new`, cookie, { cwd: workspace });
  assert.equal(conflicted.status, 409, conflicted.body);
  const conflictData = JSON.parse(conflicted.body);
  assert.equal(conflictData.code, "workspace-write-conflict");
  assert.deepEqual(conflictData.choices.map((choice) => choice.mode), ["worktree", "read-only", "override"]);
  const readOnlyChat = await postJson(`${ready.endpoint}/chat-new`, cookie, { cwd: workspace, workspaceAccess: "read-only" });
  assert.equal(readOnlyChat.status, 200, readOnlyChat.body);
  const readOnlyData = JSON.parse(readOnlyChat.body);
  assert.equal(readOnlyData.workspaceAccess.mode, "read-only");
  const closedReadOnly = await postJson(`${ready.endpoint}/chat-close`, cookie, { sid: readOnlyData.sid });
  assert.equal(closedReadOnly.status, 200);
  ok("runtime requires worktree, read-only, or explicit override for a second workspace writer");

  const opened = await postJson(`${ready.endpoint}/terminal-handoff`, cookie, { mode: "open" });
  assert.equal(opened.status, 200);
  const openedData = JSON.parse(opened.body);
  assert.equal(openedData.launch.executable, "coop");
  assert.deepEqual(openedData.launch.args, []);
  assert.equal(openedData.launch.cwd, workspace);
  ok("open-terminal handoff returns a fixed shell-owned Coop launch request");

  const cloned = await postJson(`${ready.endpoint}/terminal-handoff`, cookie, { mode: "clone" });
  assert.equal(cloned.status, 200, cloned.body);
  const clonedData = JSON.parse(cloned.body);
  assert.equal(clonedData.launch.mode, "clone");
  assert.deepEqual(clonedData.launch.args, ["--session", realpathSync(clonedSession)]);
  const stateAfterClone = await postJson(`${ready.endpoint}/rpc`, cookie, { type: "get_state" });
  assert.equal(realpathSync(JSON.parse(stateAfterClone.body).data.sessionFile), realpathSync(originalSession));
  ok("clone-to-terminal preserves Desktop ownership of the original session");

  const moved = await postJson(`${ready.endpoint}/terminal-handoff`, cookie, { mode: "move" });
  assert.equal(moved.status, 200, moved.body);
  const movedData = JSON.parse(moved.body);
  assert.equal(movedData.launch.mode, "move");
  assert.deepEqual(movedData.launch.args, ["--session", realpathSync(originalSession)]);
  await waitForProcessExit(primaryPiPid);
  ok("move-to-terminal gracefully releases the Desktop Pi process before launch authorization");

  runtime.kill("SIGTERM");
  await new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error("runtime did not stop after SIGTERM")), 5000);
    runtime.once("close", () => { clearTimeout(timer); resolveClose(); });
  });
  runtime = null;
  ok("runtime shutdown reaps its governed Pi child");
} finally {
  if (runtime && runtime.exitCode === null) runtime.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`✓ runtime entry-point tests passed (${passed})`);
