#!/usr/bin/env node
// CI diagnosis only. Does not change the native acceptance environment or gates.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNativeProbeEnvironment } from "./verify-native-application.mjs";

const MARKER = "coop-powershell-ready";
const FILE_SCRIPTS = {
  explicitManagement: "$ErrorActionPreference = 'Stop'\n[Console]::Error.WriteLine('coop-powershell-stage:file-enter')\n$PSModuleAutoLoadingPreference = 'None'\n$moduleFile = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')\n[Console]::Error.WriteLine('coop-powershell-stage:management-import-start')\nMicrosoft.PowerShell.Core\\Import-Module -Name $moduleFile -ErrorAction Stop\n[Console]::Error.WriteLine('coop-powershell-stage:management-import-ready')\n$bootstrapRoot = Microsoft.PowerShell.Management\\Split-Path -Parent $PSScriptRoot\n[Console]::Error.WriteLine('coop-powershell-stage:split-path-ready')\n[Console]::WriteLine('coop-powershell-ready')\n",
  minimal: "$ErrorActionPreference = 'Stop'\n[Console]::Error.WriteLine('coop-powershell-stage:file-enter')\n[Console]::WriteLine('coop-powershell-ready')\n",
  cmdlets: "$ErrorActionPreference = 'Stop'\n[Console]::Error.WriteLine('coop-powershell-stage:file-enter')\n$bootstrapRoot = Split-Path -Parent $PSScriptRoot\n[Console]::Error.WriteLine('coop-powershell-stage:split-path-ready')\n[Console]::WriteLine('coop-powershell-ready')\n",
};
export function writeWindowsShellFixtures(profile) {
  if (!isAbsolute(profile)) throw new Error("Shell fixture profile must be absolute.");
  for (const [kind, source] of Object.entries(FILE_SCRIPTS)) writeFileSync(join(profile, `probe-${kind}.ps1`), "\uFEFF" + source, { flag: "wx" });
}
const MACHINE_FIELDS = ["SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE", "PSModulePath", "COMPUTERNAME", "USERDOMAIN", "USERNAME"];

export function windowsShellCases(profile, source) {
  const native = buildNativeProbeEnvironment(profile, undefined, "win32", source);
  delete native.COOP_DESKTOP_UPDATE_PROBE;
  const machine = { ...native };
  for (const name of MACHINE_FIELDS) {
    const key = Object.keys(source).find(key => key.toLowerCase() === name.toLowerCase());
    if (key && typeof source[key] === "string") machine[name] = source[key];
  }
  // Independent child-only probes; never change the actual acceptance environment.
  const coreModules = { ...native, PSModulePath: win32.join(native.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") };
  const noCache = { ...native, PSModuleAnalysisCachePath: "NUL" };
  return [
    { name: "native-null-input", env: native, stdin: "ignore" },
    { name: "native-closed-pipe", env: native, stdin: "pipe" },
    { name: "machine-fields-null-input", env: machine, stdin: "ignore" },
    { name: "machine-fields-closed-pipe", env: machine, stdin: "pipe" },
    { name: "native-file-minimal", env: native, stdin: "ignore", fileKind: "minimal" },
    { name: "machine-fields-file-minimal", env: machine, stdin: "ignore", fileKind: "minimal" },
    { name: "native-file-cmdlets", env: native, stdin: "ignore", fileKind: "cmdlets" },
    { name: "machine-fields-file-cmdlets", env: machine, stdin: "ignore", fileKind: "cmdlets" },
    { name: "native-file-cmdlets-closed-pipe", env: native, stdin: "pipe", fileKind: "cmdlets" },
    { name: "machine-fields-file-cmdlets-closed-pipe", env: machine, stdin: "pipe", fileKind: "cmdlets" },
    { name: "native-core-module-path", env: coreModules, stdin: "pipe", fileKind: "cmdlets" },
    { name: "native-module-cache-disabled", env: noCache, stdin: "pipe", fileKind: "cmdlets" },
    { name: "native-explicit-management-module", env: native, stdin: "pipe", fileKind: "explicitManagement" },
  ];
}

export function observeWindowsShell(executable, probe, { run = spawnSync, timeoutMs = 10000, gone = pid => {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
} } = {}) {
  const started = performance.now();
  // Fixed scripts distinguish -File loading from the bootstrap's first cmdlet.
  // They do not launch children or read credentials. Stop on unconfirmed exit.
  if (probe.fileKind !== undefined && !Object.hasOwn(FILE_SCRIPTS, probe.fileKind)) throw new Error("Unknown shell fixture kind.");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", ...(probe.fileKind
    ? ["-ExecutionPolicy", "Bypass", "-File", join(probe.env.HOME, `probe-${probe.fileKind}.ps1`)]
    : ["-Command", `[Console]::WriteLine('${MARKER}')`])];
  const result = run(executable, args, {
    env: probe.env, cwd: probe.env.HOME, shell: false, windowsHide: true,
    stdio: [probe.stdin, "pipe", "pipe"], ...(probe.stdin === "pipe" ? { input: "" } : {}),
    encoding: "utf8", timeout: timeoutMs, maxBuffer: 65536,
  });
  const processExited = result.pid > 0 ? gone(result.pid) : ["ENOENT", "EACCES", "ENOEXEC"].includes(result.error?.code);
  return { name: probe.name, elapsedMs: Math.round(performance.now() - started),
    pid: result.pid || null, processExited, exitCode: result.status, signal: result.signal,
    errorCode: result.error?.code || null, stdoutBytes: Buffer.byteLength(result.stdout || ""),
    stderrBytes: Buffer.byteLength(result.stderr || ""),
    stages: [...(result.stderr || "").matchAll(/(?:^|\r?\n)coop-powershell-stage:(file-enter|management-import-start|management-import-ready|split-path-ready)(?=\r?\n|$)/g)].map(match => match[1]),
    healthy: processExited && !result.error && result.status === 0 && result.stdout?.trim() === MARKER };
}

function main(argv) {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") throw new Error("Windows shell diagnostics require Windows CI.");
  if (argv.length !== 2 || argv[0] !== "--output") throw new Error("Expected --output followed by a receipt path.");
  const output = resolve(argv[1]);
  const profile = mkdtempSync(win32.join(tmpdir(), "coop-shell-diagnostic-"));
  writeWindowsShellFixtures(profile);
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
