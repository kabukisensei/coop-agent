// Where the phone finds the companion (master plan row MC2; Aaron chose
// Tailscale on 2026-10-06): the VM's name inside the tailnet, read from
// `tailscale status --json`, as `https://<vm>.<tailnet>.ts.net`. `tailscale
// serve` (set up once, desktop/COMPANION.md) carries that name to the loopback
// port. Read-only: coop never changes Tailscale's settings.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** tailscale.exe on PATH, else where the Windows installer puts it. */
export function tailscaleCommand(platform = process.platform, env = process.env, exists = existsSync) {
  if (platform !== "win32") return "tailscale";
  const installed = win32.join(env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe");
  return exists(installed) ? installed : "tailscale.exe";
}

/** The origin from `tailscale status --json` output, or "" when Tailscale is off or signed out. */
export function originFromStatus(text) {
  let status;
  try { status = JSON.parse(String(text || "")); } catch { return ""; }
  if (!status || status.BackendState !== "Running" || !status.Self) return "";
  const name = String(status.Self.DNSName || "").replace(/\.$/, "").toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name) ? `https://${name}` : "";
}

/** Resolves to the companion's origin, or "" with Tailscale missing, off or signed out. */
export function tailnetOrigin({ execFileImpl = execFile, platform = process.platform, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFileImpl(tailscaleCommand(platform, env), ["status", "--json"], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : originFromStatus(stdout));
    });
  });
}
