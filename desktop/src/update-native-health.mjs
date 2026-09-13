import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectManagedRuntime } from "./managed-runtime.mjs";
import { createHealthProfile, waitForProbeGroupExit } from "./update-health-profile.mjs";
import { buildNativeProbeEnvironment } from "./update-probe-environment.mjs";

export async function nativeApplicationHealth(appPath, request, descriptor, signal, {
  spawnImpl = spawn, timeoutMs = 90000, terminationTimeoutMs = 5000, waitForGroupExit = waitForProbeGroupExit, inspectRuntime = inspectManagedRuntime,
} = {}) {
  if (![timeoutMs, terminationTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new Error("Native health deadlines are invalid.");
  signal?.throwIfAborted();
  const profile = await createHealthProfile(request.versionRoot, "native");
  const userData = profile.path;
  await writeFile(join(userData, "desktop-state.json"), JSON.stringify({ schemaVersion: 1, lastWorkspace: request.workspace }), { mode: 0o600 });
  const token = randomBytes(32).toString("hex");
  const environment = buildNativeProbeEnvironment(userData, token);
  for (const path of new Set([environment.TEMP, environment.APPDATA, environment.LOCALAPPDATA].filter(Boolean))) await mkdir(path, { recursive: true });
  let pid, closed = false;
  const healthy = await new Promise(resolve => {
    const windows = process.platform === "win32";
    const command = windows ? inspectRuntime(join(appPath, "resources", "managed-runtime")).python : join(appPath, "Contents", "MacOS", "Coop Desktop");
    const args = windows ? ["-I", "-B", join(dirname(fileURLToPath(import.meta.url)), "update-windows-job.py"), join(appPath, "Coop Desktop.exe"), `--user-data-dir=${userData}`] : [`--user-data-dir=${userData}`];
    const child = spawnImpl(command, args, {
      cwd: request.workspace, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      env: environment,

    });
    pid = child.pid;
    let output = "", ready = false, failed = false, killTimer, exitTimer, settled = false;
    const killGroup = strength => {
      if (!child.pid) return;
      // Closing the supervisor's job handle kills even detached descendants.
      if (windows) { child.kill(); return; }
      try { process.kill(-child.pid, strength); } catch (error) { if (error.code !== "ESRCH") failed = true; }
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(exitTimer);
      signal?.removeEventListener("abort", stop);
      if (!closed) { child.stdout.destroy(); child.unref(); }
      resolve(value);
    };
    const stop = () => {
      if (settled) return;
      failed = true; killGroup("SIGTERM");
      killTimer ||= setTimeout(() => killGroup("SIGKILL"), Math.min(3000, terminationTimeoutMs / 2));
      exitTimer ||= setTimeout(() => finish(false), terminationTimeoutMs);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", chunk => {
      if (settled || failed) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 65536) { stop(); output = ""; return; }
      let newline;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === "desktop.update-health" && value.token === token && value.version === descriptor.desktopVersion) ready = true;
        } catch { /* Electron may also write diagnostic lines. */ }
      }
    });
    child.on("error", () => { failed = true; });
    child.on("close", code => {
      closed = true;
      if (settled) return;
      // The probe normally stops its runtime before reporting ready. Also reap
      // any descendants left by an early main-process crash or timeout.
      killGroup("SIGKILL");
      finish(code === 0 && ready && !failed);
    });
  });
  // A matching health acknowledgement is insufficient while a probe may still
  // use the active app. Preserve the transaction for the independent recovery
  // worker, which stops probes before attempting replacement or relaunch.
  if (!closed || (pid !== undefined && !await waitForGroupExit(pid))) {
    const error = new Error("Native health process exit could not be confirmed; recovery must wait for probe shutdown.");
    error.code = "UPDATE_HEALTH_PROCESS_EXIT_UNCONFIRMED";
    throw error;
  }
  signal?.throwIfAborted();
  if (healthy) await profile.discard();
  return healthy;
}
