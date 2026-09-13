import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

// Private Node IPC, not a renderer endpoint. Trust policy is transferred in
// memory from the signed app; the helper never loads replacement keys from disk.
export function launchUpdateHelper({ nodePath, helperPath, request, logPath, spawnImpl = spawn, timeoutMs = 300000 } = {}) {
  const log = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawnImpl(nodePath, [helperPath], { detached: true, cwd: request.userData,
      env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: ["ignore", "ignore", log, "ipc"] });
  } finally { closeSync(log); }
  let ready = false, closed = false, settleReady, failReady, settleClosed;
  const completion = new Promise(resolve => { settleClosed = resolve; });
  const prepared = new Promise((resolve, reject) => { settleReady = resolve; failReady = reject; });
  // Register the rejection handler before a fast spawn error can arrive.
  prepared.catch(() => {});
  const timer = setTimeout(() => {
    failReady(new Error("Update helper preparation timed out."));
    if (child.connected) child.send({ type: "cancel" }, () => {});
  }, timeoutMs);
  child.on("message", message => {
    if (message?.type === "ready" && !ready) { ready = true; clearTimeout(timer); settleReady(message); }
    if (message?.type === "error") failReady(new Error("Update helper could not prepare the installation."));
  });
  child.on("error", () => failReady(new Error("Update helper could not start.")));
  child.on("close", code => {
    closed = true; clearTimeout(timer);
    if (!ready) failReady(new Error("Update helper stopped before preparation completed."));
    settleClosed(code);
  });
  child.send({ type: "prepare", ...request }, error => { if (error) failReady(new Error("Update helper request could not be delivered.")); });
  return Object.freeze({
    pid: child.pid,
    prepared,
    completion,
    cancel: async () => {
      if (!closed && child.connected) child.send({ type: "cancel" }, () => {});
      await completion;
    },
    apply: async () => {
      await prepared;
      if (closed || !child.connected) throw new Error("Update helper is no longer available.");
      await new Promise((resolve, reject) => child.send({ type: "apply" }, error => error ? reject(error) : resolve()));
      // The caller exits explicitly after this acknowledgement. Keep the handle
      // observable until then so cancellation and test callers can await close.
    },
  });
}
