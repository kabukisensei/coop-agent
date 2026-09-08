#!/usr/bin/env node
// CI diagnosis only. Does not change the native acceptance environment or gates.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNativeProbeEnvironment } from "./verify-native-application.mjs";

const MARKER = "coop-powershell-ready";
const MACHINE_FIELDS = ["SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE", "PSModulePath", "COMPUTERNAME", "USERDOMAIN", "USERNAME"];

export function windowsShellCases(profile, source) {
  const native = buildNativeProbeEnvironment(profile, undefined, "win32", source);
  delete native.COOP_DESKTOP_UPDATE_PROBE;
  const machine = { ...native };
  for (const name of MACHINE_FIELDS) {
    const key = Object.keys(source).find(key => key.toLowerCase() === name.toLowerCase());
    if (key && typeof source[key] === "string") machine[name] = source[key];
  }
  return [
    { name: "native-null-input", env: native, stdin: "ignore" },
    { name: "native-closed-pipe", env: native, stdin: "pipe" },
    { name: "machine-fields-null-input", env: machine, stdin: "ignore" },
    { name: "machine-fields-closed-pipe", env: machine, stdin: "pipe" },
  ];
}

export function observeWindowsShell(executable, probe, { run = spawnSync, timeoutMs = 10000, gone = pid => {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
} } = {}) {
  const started = performance.now();
  // This fixed command only calls .NET in its own process; it cannot launch a
  // child or read credentials. An unconfirmed exit stops the entire matrix.
  const result = run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::WriteLine('${MARKER}')`], {
    env: probe.env, cwd: probe.env.HOME, shell: false, windowsHide: true,
    stdio: [probe.stdin, "pipe", "pipe"], ...(probe.stdin === "pipe" ? { input: "" } : {}),
    encoding: "utf8", timeout: timeoutMs, maxBuffer: 65536,
  });
  const processExited = result.pid > 0 ? gone(result.pid) : ["ENOENT", "EACCES", "ENOEXEC"].includes(result.error?.code);
  return { name: probe.name, elapsedMs: Math.round(performance.now() - started),
    pid: result.pid || null, processExited, exitCode: result.status, signal: result.signal,
    errorCode: result.error?.code || null, stdoutBytes: Buffer.byteLength(result.stdout || ""),
    stderrBytes: Buffer.byteLength(result.stderr || ""),
    healthy: processExited && !result.error && result.status === 0 && result.stdout?.trim() === MARKER };
}

function main(argv) {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") throw new Error("Windows shell diagnostics require Windows CI.");
  if (argv.length !== 2 || argv[0] !== "--output") throw new Error("Expected --output followed by a receipt path.");
  const output = resolve(argv[1]);
  const profile = mkdtempSync(win32.join(tmpdir(), "coop-shell-diagnostic-"));
  const cases = windowsShellCases(profile, process.env), results = [];
  for (const path of new Set([cases[0].env.TEMP, cases[0].env.APPDATA, cases[0].env.LOCALAPPDATA])) mkdirSync(path, { recursive: true });
  const executable = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  for (const probe of cases) {
    const result = observeWindowsShell(executable, probe);
    results.push(result);
    writeFileSync(output, JSON.stringify({ diagnosticOnly: true, results }, null, 2));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.processExited) throw new Error("Windows shell exit is unconfirmed; further probes stopped.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
