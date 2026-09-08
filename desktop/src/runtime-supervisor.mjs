import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";
import { randomBytes } from "node:crypto";

const READY_LIMIT = 64 * 1024;

export function terminateWindowsRuntimeTree(pid, { systemRoot = process.env.SystemRoot, execFileImpl = execFile } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new TypeError("Runtime process ID is invalid."));
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot) || /[\x00-\x1f]/.test(systemRoot)) {
    return Promise.reject(new Error("Windows SystemRoot is required to stop the runtime tree."));
  }
  return new Promise((resolve, reject) => {
    execFileImpl(win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 64 * 1024 },
      error => error ? reject(new Error("Windows runtime process-tree termination failed.", { cause: error })) : resolve());
  });
}

export function buildRuntimeInvocation({ coopCommand = "coop", commandPrefix = [], workspace, port = 0 }) {
  if (typeof workspace !== "string" || !workspace.trim()) throw new TypeError("A workspace path is required.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("Runtime port is invalid.");
  return {
    command: coopCommand,
    args: [...commandPrefix, "runtime", "--transport", "http", "--json", "--port", String(port), "--cwd", workspace],
  };
}

export function validateRuntimeReady(value) {
  if (value?.type !== "runtime.ready" || value.contractVersion !== 1 || value.transport !== "http") throw new Error("Coop Runtime returned an incompatible ready event.");
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") throw new Error("Coop Runtime did not bind to the required loopback address.");
  if (typeof value.oneTimeToken !== "string" || !/^[0-9a-f]{32}$/i.test(value.oneTimeToken)) throw new Error("Coop Runtime returned an invalid one-time token.");
  if (!Number.isInteger(value.runtimePid) || value.runtimePid <= 0) throw new Error("Coop Runtime returned an invalid process ID.");
  return { ...value, endpoint: endpoint.origin };
}

async function waitForExit(closed, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function startCoopRuntime({
  workspace,
  coopCommand = process.env.COOP_BIN || "coop",
  commandPrefix = [],
  port = 0,
  env = process.env,
  spawnImpl = spawn,
  readyTimeoutMs = 20_000,
  onStderr = () => {},
  onExit = () => {},
} = {}) {
  const invocation = buildRuntimeInvocation({ coopCommand, commandPrefix, workspace, port });
  const ownerToken = randomBytes(32).toString("hex");
  const child = spawnImpl(invocation.command, invocation.args, {
    cwd: workspace,
    env: { ...env, COOP_DESKTOP_SHELL: "1", COOP_DESKTOP_RUNTIME_OWNER_TOKEN: ownerToken },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });

  // Runtime clients use HTTP; finish launcher stdin immediately. A closed pipe
  // provides EOF without relying on the Windows NUL-device input path.
  child.stdin?.on("error", () => {}); // Spawn failure or early exit can close it first.
  child.stdin?.end();

  let ready, exited = false, stopRequested = false, stopTask;
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    exited = true;
    resolve();
    if (ready && !stopRequested) onExit({ code, signal });
  }));
  const stop = ({ graceMs = 3000 } = {}) => {
    if (!Number.isFinite(graceMs) || graceMs < 0) return Promise.reject(new RangeError("Runtime shutdown grace period is invalid."));
    if (stopTask) return stopTask;
    if (exited) return Promise.resolve();
    stopRequested = true;
    stopTask = (async () => {
      try {
        if (ready?.shutdownProtocol === "http-v1" && graceMs > 0) {
          const deadline = Date.now() + graceMs;
          try {
            const response = await fetch(`${ready.endpoint}/runtime/shutdown`, {
              method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.ceil(graceMs))),
              headers: { cookie: `coop_token=${ready.oneTimeToken}`, "x-coop-csrf": "1", "x-coop-runtime-owner": ownerToken },
            });
            await response.body?.cancel();
            if (response.ok && await waitForExit(closed, Math.max(0, deadline - Date.now()))) return;
          } catch { /* Fall back to terminating the owned process below. */ }
          if (exited) return;
        }
        if (!child.pid) {
          if (await waitForExit(closed, 1000)) return;
          throw new Error("Failed runtime launch did not close its process handles.");
        }
        if (process.platform === "win32") {
          // The launcher is PowerShell. Killing it first loses the parent needed
          // to reap its runtime/Pi descendants, which also keep our pipes open.
          try { await terminateWindowsRuntimeTree(child.pid); }
          catch (error) { if (!exited) throw error; }
          if (!await waitForExit(closed, Math.max(graceMs, 1000))) throw new Error("Coop Runtime shutdown could not be confirmed.");
          return;
        }
        child.kill("SIGTERM");
        if (await waitForExit(closed, graceMs)) return;
        child.kill("SIGKILL");
        if (!await waitForExit(closed, 1000)) throw new Error("Coop Runtime shutdown could not be confirmed.");
      } finally { stopTask = null; }
    })();
    return stopTask;
  };
  try {
    ready = await new Promise((resolveReady, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("Coop Runtime did not become ready in time.")), readyTimeoutMs);
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > READY_LIMIT) { finish(reject, new Error("Coop Runtime ready event exceeded the safety limit.")); return; }
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try { finish(resolveReady, validateRuntimeReady(JSON.parse(stdout.slice(0, newline)))); }
        catch (error) { finish(reject, error); }
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < READY_LIMIT) stderr += chunk.toString("utf8");
        onStderr(chunk.toString("utf8"));
      });
      child.once("error", (error) => finish(reject, error));
      child.once("close", (code) => finish(reject, new Error(`Coop Runtime exited before ready (${code ?? "unknown"}).${stderr.trim() ? " Check Coop Health for details." : ""}`)));
    });
  } catch (error) {
    // A failed ready handshake still owns a child. Reap it before surfacing the
    // startup failure; otherwise retry/update cleanup can overlap that runtime.
    try { await stop({ graceMs: 1000 }); }
    catch (shutdownError) { throw new AggregateError([error, shutdownError], "Coop Runtime startup failed and shutdown could not be confirmed."); }
    throw error;
  }

  return { ready, child, invocation, stop };
}
