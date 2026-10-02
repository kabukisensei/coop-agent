// One Pi process in RPC mode: spawn, correlate command responses by id, surface
// events, answer extension dialogs, and end Pi with all of its children.
import { spawn, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { JsonlSplitter, encodeLine } from "./jsonl.mjs";

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export class PiSession extends EventEmitter {
  constructor({ command, args, cwd, env, spawnImpl = spawn, platform = process.platform, responseTimeoutMs = 120_000 }) {
    super();
    Object.assign(this, { command, args, cwd, env, spawnImpl, platform, responseTimeoutMs });
    this.pending = new Map();
    this.dialogs = new Map();
    this.counter = 0;
    this.child = null;
    this.exited = false;
    this.stderrTail = "";
    this.startedAt = 0;
    this.cleanup = Promise.resolve();
  }

  start() {
    if (this.child) throw new Error("Pi is already running");
    const child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      // Its own process group on POSIX so stop() can end MCP servers and tools too.
      detached: this.platform !== "win32",
    });
    this.child = child;
    this.startedAt = Date.now();
    const splitter = new JsonlSplitter((line) => this.#onLine(line));
    child.stdout.on("data", (chunk) => {
      try { splitter.push(chunk); } catch (error) { this.emit("protocol-error", error.message); }
    });
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8000);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => this.#finish(null, error.message));
    child.once("exit", (code, signal) => { splitter.flush(); this.#finish(code, signal ? `signal ${signal}` : ""); });
    return this;
  }

  #finish(code, reason) {
    if (this.exited) return;
    this.exited = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error("Pi exited")); }
    this.pending.clear();
    this.dialogs.clear();
    // Whatever Pi started and left running (MCP servers, a tool's process)
    // ends with it, whether Pi quit, crashed or was killed.
    if (this.child) this.cleanup = endLeftovers(this.child.pid, this.platform, this.startedAt);
    this.emit("exit", { code, reason, stderr: this.stderrTail });
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.emit("protocol-error", "Pi sent a line that is not JSON"); return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "response" && typeof message.id === "string" && this.pending.has(message.id)) {
      const { resolve, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      resolve(message);
      return;
    }
    if (message.type === "extension_ui_request" && DIALOGS.has(message.method)) {
      this.dialogs.set(message.id, message);
    }
    this.emit("event", message);
  }

  /**
   * Send one already-validated command; resolves with Pi's response record.
   * timeoutMs 0 waits as long as Pi runs (bash and compact answer when done).
   */
  request(command, { timeoutMs = this.responseTimeoutMs } = {}) {
    if (!this.child || this.exited) return Promise.reject(new Error("Pi is not running"));
    const id = `d${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not answer ${command.type}`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeLine({ ...command, id }));
    });
  }

  /** Dialogs Pi is still waiting on, oldest first. */
  openDialogs() {
    return [...this.dialogs.values()];
  }

  /** The open dialog with this id, or undefined. */
  dialog(id) {
    return this.dialogs.get(id);
  }

  /** Answer an open dialog with an already-validated extension_ui_response. */
  answer(response) {
    if (!this.dialogs.has(response.id)) return false;
    this.dialogs.delete(response.id);
    if (this.child && !this.exited) this.child.stdin.write(encodeLine(response));
    return true;
  }

  /**
   * End Pi and everything it started: Pi gets its stdin closed and graceMs to
   * quit, then its whole tree is killed. Resolves once Pi has exited and
   * anything it left behind has been ended.
   */
  stop({ graceMs = 3000 } = {}) {
    if (!this.child || this.exited) return this.cleanup;
    const child = this.child;
    const done = new Promise((resolve) => this.once("exit", resolve));
    try { child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => killTree(child.pid, this.platform), graceMs);
    return done.then(() => { clearTimeout(timer); return this.cleanup; });
  }
}

/** taskkill /T on Windows (the whole tree); the process group elsewhere. */
export function killTree(pid, platform = process.platform, { execFileImpl = execFile, systemRoot = process.env.SystemRoot } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  if (platform === "win32") {
    if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) return Promise.resolve();
    return new Promise((resolve) => {
      execFileImpl(win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolve());
    });
  }
  try { process.kill(-pid, "SIGTERM"); } catch { /* group already gone */ }
  return Promise.resolve();
}

// Windows keeps a dead process's id as its children's ParentProcessId, so
// the processes a dead Pi left are still found by walking down from its id.
// Only processes created after Pi started count, in case the id was reused.
// The ids travel in the environment; the script is fixed text.
const LEFTOVERS_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$since=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:COOP_PI_STARTED).UtcDateTime.AddSeconds(-2)",
  "$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)",
  "$ids=New-Object System.Collections.Generic.List[int]",
  "$queue=New-Object System.Collections.Generic.Queue[int]",
  "$queue.Enqueue([int]$env:COOP_PI_PID)",
  "while($queue.Count -gt 0){$p=$queue.Dequeue();foreach($c in $all){if($c.ParentProcessId -eq $p -and $c.CreationDate -and $c.CreationDate.ToUniversalTime() -ge $since -and -not $ids.Contains([int]$c.ProcessId)){$ids.Add([int]$c.ProcessId);$queue.Enqueue([int]$c.ProcessId)}}}",
  "foreach($id in $ids){Stop-Process -Id $id -Force}",
].join("; ");

/** End what Pi left running once it has exited. Resolves when done. */
export function endLeftovers(pid, platform = process.platform, startedAt = 0, { execFileImpl = execFile, systemRoot = process.env.SystemRoot, env = process.env } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  if (platform !== "win32") return killTree(pid, platform);
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot) || !Number.isSafeInteger(startedAt) || startedAt <= 0) return Promise.resolve();
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(LEFTOVERS_PS, "utf16le").toString("base64")];
  return new Promise((resolve) => {
    execFileImpl(powershell, args, { windowsHide: true, timeout: 15_000, env: { ...env, COOP_PI_PID: String(pid), COOP_PI_STARTED: String(startedAt) } }, () => resolve());
  });
}
