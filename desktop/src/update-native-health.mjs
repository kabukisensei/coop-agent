import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectManagedRuntime } from "./managed-runtime.mjs";
import { createHealthProfile, waitForProbeGroupExit } from "./update-health-profile.mjs";

export async function nativeApplicationHealth(appPath, request, descriptor, signal, { spawnImpl = spawn, timeoutMs = 90000 } = {}) {
  signal?.throwIfAborted();
  const profile = await createHealthProfile(request.versionRoot, "native");
  const userData = profile.path;
  await writeFile(join(userData, "desktop-state.json"), JSON.stringify({ schemaVersion: 1, lastWorkspace: request.workspace }), { mode: 0o600 });
  const token = randomBytes(32).toString("hex");
  let pid;
  const healthy = await new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const command = windows ? inspectManagedRuntime(join(appPath, "resources", "managed-runtime")).python : join(appPath, "Contents", "MacOS", "Coop Desktop");
    const args = windows ? ["-I", "-B", join(dirname(fileURLToPath(import.meta.url)), "update-windows-job.py"), join(appPath, "Coop Desktop.exe"), `--user-data-dir=${userData}`] : [`--user-data-dir=${userData}`];
    // Windows needs its OS launch prerequisites, but no provider keys/tokens.
    const osKeys = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE"]);
    const environment = windows ? Object.fromEntries(Object.entries(process.env).filter(([key]) => osKeys.has(key.toUpperCase()))) : { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    const child = spawnImpl(command, args, {
      cwd: request.workspace, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      env: { ...environment, COOP_SKIP_AZ: "1", COOP_NO_ONBOARD: "1", COOP_DESKTOP_UPDATE_PROBE: token },
    });
    pid = child.pid;
    let output = "", ready = false, failed = false, killTimer;
    const killGroup = strength => {
      if (!child.pid) return;
      // Closing the supervisor's job handle kills even detached descendants.
      if (windows) { child.kill(); return; }
      try { process.kill(-child.pid, strength); } catch (error) { if (error.code !== "ESRCH") failed = true; }
    };
    const stop = () => {
      failed = true; killGroup("SIGTERM");
      killTimer ||= setTimeout(() => killGroup("SIGKILL"), 3000);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", chunk => {
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
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop);
      // The probe normally stops its runtime before reporting ready. Also reap
      // any descendants left by an early main-process crash or timeout.
      killGroup("SIGKILL");
      if (signal?.aborted) reject(signal.reason);
      else resolve(code === 0 && ready && !failed);
    });
  });
  if (healthy && await waitForProbeGroupExit(pid)) await profile.discard();
  return healthy;
}
