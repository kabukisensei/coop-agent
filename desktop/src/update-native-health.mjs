import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHealthProfile, waitForProbeGroupExit } from "./update-health-profile.mjs";

export async function nativeApplicationHealth(appPath, request, descriptor, signal, {
  spawnImpl = spawn, timeoutMs = 90000, terminationTimeoutMs = 5000, waitForGroupExit = waitForProbeGroupExit,
} = {}) {
  if (![timeoutMs, terminationTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new Error("Native health deadlines are invalid.");
  signal?.throwIfAborted();
  const profile = await createHealthProfile(request.versionRoot, "native");
  const userData = profile.path;
  await writeFile(join(userData, "desktop-state.json"), JSON.stringify({ schemaVersion: 1, lastWorkspace: request.workspace }), { mode: 0o600 });
  const token = randomBytes(32).toString("hex");
  let pid, closed = false;
  const healthy = await new Promise(resolve => {
    const child = spawnImpl(join(appPath, "Contents", "MacOS", "Coop Desktop"), [`--user-data-dir=${userData}`], {
      cwd: request.workspace, detached: true, stdio: ["ignore", "pipe", "ignore"],
      env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", COOP_SKIP_AZ: "1", COOP_NO_ONBOARD: "1", COOP_DESKTOP_UPDATE_PROBE: token },
    });
    pid = child.pid;
    let output = "", ready = false, failed = false, killTimer, exitTimer, settled = false;
    const killGroup = strength => {
      if (!child.pid) return;
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
