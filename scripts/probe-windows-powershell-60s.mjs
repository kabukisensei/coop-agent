#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packagedPaths } from "../desktop/scripts/verify-managed-package.mjs";
import { buildNativeProbeEnvironment } from "../desktop/scripts/verify-native-application.mjs";

const CANDIDATE = "ed516b2a183f3e6346344a669d6e37b321a4dcf8";
const BOUND_MS = 60_000;
const CASES = [
  "A-current-runtime",
  "B-explicit-management",
  "C-management-dispatcher",
  "D-management-utility-dispatcher",
  "E-dotnet-control",
];
const resources = packagedPaths(resolve("desktop/dist-managed")).resources;
const runtime = join(resources, "managed-runtime");
const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const taskkill = join(process.env.SystemRoot, "System32", "taskkill.exe");
const launcher = join(runtime, "bin", "coop-desktop.ps1");
const coopScript = join(runtime, "coop", "bin", "coop.ps1");
const now = () => new Date().toISOString();
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const commandArgs = script => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];

async function runFresh(caseName, repetition) {
  const root = join(process.env.RUNNER_TEMP, `probe10-${caseName}-${repetition}`);
  const profile = join(root, "profile");
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  const env = buildNativeProbeEnvironment(profile, undefined, "win32", process.env);
  delete env.COOP_DESKTOP_UPDATE_PROBE;
  Object.assign(env, {
    COOP_DESKTOP_AGENT_DIR: agent,
    COOP_AGENT_DIR: agent,
    PI_CODING_AGENT_DIR: agent,
    COOP_SKIP_AZ: "1",
    COOP_NO_ONBOARD: "1",
    COOP_RUNTIME_STARTUP_TRACE: "1",
  });
  for (const path of [profile, env.TEMP, env.APPDATA, env.LOCALAPPDATA, agent, workspace]) mkdirSync(path, { recursive: true });

  const dispatcher = `${psQuote(coopScript)} runtime --transport http --json --port 0 --cwd ${psQuote(workspace)}`;
  let args;
  let kind;
  if (caseName === "A-current-runtime") {
    args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher,
      "runtime", "--transport", "http", "--json", "--port", "0", "--cwd", workspace];
    kind = "dispatcher";
  } else if (caseName === "B-explicit-management") {
    args = commandArgs("[Console]::Error.WriteLine('probe:process-enter'); Import-Module Microsoft.PowerShell.Management; [Console]::Error.WriteLine('probe:import-complete'); $null = Split-Path -Parent 'C:\\probe\\file.txt'; [Console]::Error.WriteLine('probe:work-complete')");
    kind = "control";
  } else if (caseName === "C-management-dispatcher") {
    args = commandArgs(`Import-Module Microsoft.PowerShell.Management; [Console]::Error.WriteLine('probe:import-complete'); [Console]::Error.WriteLine('probe:dispatcher-invoke'); & ${dispatcher}`);
    kind = "dispatcher";
  } else if (caseName === "D-management-utility-dispatcher") {
    args = commandArgs(`Import-Module Microsoft.PowerShell.Management; Import-Module Microsoft.PowerShell.Utility; [Console]::Error.WriteLine('probe:import-complete'); [Console]::Error.WriteLine('probe:dispatcher-invoke'); & ${dispatcher}`);
    kind = "dispatcher";
  } else {
    args = commandArgs("[Console]::Error.WriteLine('probe:process-enter'); $null = [System.IO.Path]::GetDirectoryName('C:\\probe\\file.txt'); [Console]::Error.WriteLine('probe:work-complete')");
    kind = "control";
  }

  const startedAt = now();
  const startedMs = Date.now();
  let firstObservableAt = null;
  let exitAt = null;
  let timeoutAt = null;
  let timedOut = false;
  let exitCode = null;
  let signal = null;
  let spawnError = null;
  let cleanup = "not-needed";
  let observedText = "";
  const phases = {};
  const streamBytes = { stdout: 0, stderr: 0 };
  const child = spawn(powershell, args, {
    cwd: workspace,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid || null;

  const observe = (stream, chunk) => {
    const at = now();
    if (!firstObservableAt) firstObservableAt = at;
    streamBytes[stream] += Buffer.byteLength(chunk);
    observedText = (observedText + String(chunk)).slice(-8192);
    for (const marker of ["probe:process-enter", "probe:import-complete", "probe:work-complete", "probe:dispatcher-invoke"]) {
      if (observedText.includes(marker) && !phases[marker]) phases[marker] = at;
    }
    for (const match of observedText.matchAll(/\[coop-startup\] ([^\r\n]+)/g)) {
      if (!phases[`coop:${match[1]}`]) phases[`coop:${match[1]}`] = at;
    }
    if (/"type"\s*:\s*"runtime\.ready"/.test(observedText) && !phases["runtime:ready"]) phases["runtime:ready"] = at;
  };
  child.stdout.on("data", chunk => observe("stdout", chunk));
  child.stderr.on("data", chunk => observe("stderr", chunk));

  const closed = new Promise(resolveClose => {
    child.once("error", error => { spawnError = error.code || error.name; });
    child.once("close", (code, closeSignal) => {
      exitCode = code;
      signal = closeSignal;
      exitAt = now();
      resolveClose();
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutAt = now();
    if (pid) {
      try {
        execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000, stdio: "ignore" });
        cleanup = "owned-tree-terminated";
      } catch (error) {
        cleanup = `taskkill-${error.status ?? error.code ?? "failed"}`;
      }
    }
  }, BOUND_MS);
  await closed;
  clearTimeout(timer);

  const usefulWorkCompleted = kind === "dispatcher" ? Boolean(phases["runtime:ready"]) : Boolean(phases["probe:work-complete"]);
  return {
    case: caseName,
    repetition,
    pid,
    startedAt,
    firstObservableAt,
    moduleImportCompletedAt: phases["probe:import-complete"] || null,
    dispatcherInvokedAt: phases["probe:dispatcher-invoke"] || phases["coop:dispatcher-enter"] || null,
    usefulWorkCompletedAt: kind === "dispatcher" ? phases["runtime:ready"] || null : phases["probe:work-complete"] || null,
    exitAt,
    timeoutAt,
    elapsedMs: Date.now() - startedMs,
    exitCode,
    signal,
    spawnError,
    timedOut,
    cleanup,
    classification: spawnError ? "spawn-error"
      : timedOut ? (usefulWorkCompleted ? "timeout-after-useful-work" : "timeout-no-useful-work")
        : (usefulWorkCompleted ? "completed-useful-work" : "exited-no-useful-work"),
    usefulWorkCompleted,
    phases,
    streamBytes,
  };
}

const results = [];
for (let repetition = 1; repetition <= 3; repetition += 1) {
  for (const caseName of CASES) {
    const result = await runFresh(caseName, repetition);
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
const output = process.env.PROBE10_OUT;
if (!output) throw new Error("PROBE10_OUT is required.");
writeFileSync(output, JSON.stringify({ diagnosticOnly: true, candidate: CANDIDATE, boundMs: BOUND_MS, repetitions: 3, results }, null, 2));
