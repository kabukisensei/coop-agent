import { spawn } from "node:child_process";

const READY_LIMIT = 64 * 1024;

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
  const child = spawnImpl(invocation.command, invocation.args, {
    cwd: workspace,
    env: { ...env, COOP_DESKTOP_SHELL: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });

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
