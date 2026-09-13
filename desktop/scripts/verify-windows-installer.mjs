#!/usr/bin/env node
// Mutating acceptance test restricted to explicitly enabled disposable CI hosts.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { terminateWindowsRuntimeTree } from "../src/runtime-supervisor.mjs";
import { verifyManagedInstallation, verifyManagedPackage } from "./verify-managed-package.mjs";
import { probeNativeApplication } from "./verify-native-application.mjs";

export function assertDisposableInstallerHost(env = process.env, platform = process.platform) {
  if (platform !== "win32") throw new Error("Installer acceptance requires Windows.");
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || env.COOP_DESKTOP_DISPOSABLE_INSTALL_TEST !== "1") {
    throw new Error("Installer acceptance requires an explicitly enabled disposable GitHub-hosted runner.");
  }
}

export function buildNsisInvocation(executable, directory, { uninstall = false } = {}) {
  if (![executable, directory].every(path => typeof path === "string" && win32.isAbsolute(path) && !/["\x00-\x1f]/.test(path))) throw new Error("NSIS path is invalid.");
  // NSIS requires /D= and _?= to be final and unquoted, even with spaces.
  return { executable, args: ["/S", "/currentuser", `${uninstall ? "_?=" : "/D="}${directory}`],
    options: { shell: false, windowsVerbatimArguments: true, windowsHide: true } };
}

async function bounded(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise, new Promise(done => { timer = setTimeout(() => done(null), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function runOwnedCommand(executable, args, options = {}, timeoutMs = 180000) {
  const child = spawn(executable, args, { ...options, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", error, overflow = false;
  const closed = new Promise(done => child.once("close", code => done({ code })));
  child.on("error", failure => { error = failure; });
  child.stdout.on("data", chunk => {
    stdout += chunk.toString("utf8");
    if (stdout.length > 2 * 1024 * 1024) { overflow = true; stdout = stdout.slice(-2 * 1024 * 1024); }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-32768); });
  let result = await bounded(closed, timeoutMs);
  if (!result) {
    error = new Error("Owned installer acceptance command timed out.");
    try { if (child.pid) await terminateWindowsRuntimeTree(child.pid); } catch { /* Report unconfirmed exit below. */ }
    result = await bounded(closed, 5000);
    if (!result) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  }
  if (error || !result || result.code !== 0 || overflow) {
    const failure = new Error(`Installer acceptance command failed (${result?.code ?? "exit unconfirmed"}): ${error?.message || "nonzero exit or excessive output"}`);
    failure.diagnostics = stderr;
    failure.processExitUnconfirmed = !result;
    throw failure;
  }
  return stdout;
}

const REGISTRY_CHECK = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$paths = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$items = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Coop Desktop*' } | Select-Object DisplayName, DisplayVersion, UninstallString)
@{ installations = $items; appData = [Environment]::GetFolderPath('ApplicationData') } | ConvertTo-Json -Depth 4 -Compress
`;

async function inspectRegistry() {
  const powershell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return JSON.parse(await runOwnedCommand(powershell, ["-NoProfile", "-NonInteractive", "-Command", REGISTRY_CHECK], {}, 30000));
}

async function digest(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

async function main(argv) {
  assertDisposableInstallerHost();
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist-installers"), output;
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--root", "--output"].includes(argv[i]) || !argv[i + 1]) throw new Error("Expected --root or --output followed by a path.");
    if (argv[i] === "--root") root = resolve(argv[i + 1]); else output = resolve(argv[i + 1]);
  }
  if (!process.env.RUNNER_TEMP || !win32.isAbsolute(process.env.RUNNER_TEMP)) throw new Error("Disposable runner temporary directory is required.");
  const original = await verifyManagedPackage({ root });
  const files = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && /^Coop-Desktop-.*\.exe$/i.test(entry.name));
  if (files.length !== 1) throw new Error("Expected exactly one development NSIS installer.");
  const installer = join(root, files[0].name);
  const before = await inspectRegistry();
  if (before.installations.length) throw new Error("Refusing installer acceptance because Coop Desktop is already registered.");
  if (!win32.isAbsolute(before.appData)) throw new Error("Windows application data location is unavailable.");
  const appData = join(before.appData, "Coop Desktop");
  if (existsSync(appData)) throw new Error("Refusing to use an existing Coop Desktop data directory.");
  const state = await mkdtemp(join(process.env.RUNNER_TEMP, "coop-installer-acceptance-"));
  const installed = join(state, "Coop Desktop"), workspace = join(state, "workspace");
  await mkdir(workspace); await mkdir(appData);
  const marker = join(appData, "installer-acceptance-sentinel.txt"), sentinel = randomBytes(32).toString("hex");
  await writeFile(marker, sentinel, { flag: "wx" });
  const executable = join(installed, "Coop Desktop.exe"), uninstaller = join(installed, "Uninstall Coop Desktop.exe");
  const report = { ok: false, installer: files[0].name, installerSha256: await digest(installer), phases: [], signedDistribution: false };
  let failure, uninstallNeeded = false;
  const runNsis = async (file, uninstall = false) => {
    const invocation = buildNsisInvocation(file, installed, { uninstall });
    await runOwnedCommand(invocation.executable, invocation.args, invocation.options);
  };
  try {
    uninstallNeeded = true;
    for (const phase of ["install", "reinstall-repair"]) {
      await runNsis(installer);
      const verified = await verifyManagedInstallation({ directory: installed });
      if (await digest(verified.appAsar) !== await digest(original.appAsar)) throw new Error("Installed application ASAR differs from the built package.");
      const renderer = join(verified.managedRuntime, "coop", "web", "public", "app.js");
      if (await digest(renderer) !== await digest(join(original.managedRuntime, "coop", "web", "public", "app.js"))) throw new Error("Installed renderer was not restored exactly.");
      if (await readFile(marker, "utf8") !== sentinel) throw new Error("Installer changed the application-data sentinel.");
      const { extractFile } = await import("@electron/asar");
      const version = JSON.parse(extractFile(verified.appAsar, "package.json").toString("utf8")).version;
      const registered = await inspectRegistry();
      if (registered.installations.length !== 1 || registered.installations[0].DisplayVersion !== version || !registered.installations[0].UninstallString?.toLowerCase().includes(uninstaller.toLowerCase())) throw new Error("Installer registration does not identify the installed application.");
      const native = await probeNativeApplication({ executable, version, workspace, profileRoot: state });
      const runtimeOutput = await runOwnedCommand(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/verify-managed-runtime.mjs"),
        "--bundle", verified.managedRuntime, "--workspace", workspace, "--agent", join(state, `${phase}-agent`)], {}, 120000);
      const runtime = JSON.parse(runtimeOutput.trim().split(/\r?\n/).at(-1));
      if (!runtime.ok || !runtime.shutdownConfirmed || !runtime.immediateWritableRestart) throw new Error("Installed runtime did not complete writable restart checks.");
      report.phases.push({ phase, native, runtime });
      if (phase === "install") {
        await unlink(renderer); // Deliberately damage only this test-owned installation.
        if (existsSync(renderer)) throw new Error("Repair fixture did not remove the renderer.");
      }
    }
    await runNsis(uninstaller, true); uninstallNeeded = false;
    if (existsSync(executable) || existsSync(join(installed, "resources"))) throw new Error("Uninstall left the application payload installed.");
    if ((await inspectRegistry()).installations.length) throw new Error("Uninstall left Coop Desktop registered.");
    if (await readFile(marker, "utf8") !== sentinel) throw new Error("Uninstall removed or changed the application-data sentinel.");
    report.uninstalled = true; report.userDataSentinelPreserved = true; report.ok = true;
  } catch (error) { failure = error; report.error = error.message; report.diagnostics = error.diagnostics || ""; report.observation = error.observation || null; }
  finally {
    if (failure?.processExitUnconfirmed || failure?.observation?.mainProcessExited === false) report.failureCleanup = "Skipped because an earlier process exit is unconfirmed.";
    else if (uninstallNeeded && existsSync(uninstaller)) {
      try { await runNsis(uninstaller, true); report.failureCleanup = "uninstaller exited successfully"; }
      catch (error) { report.failureCleanup = error.message; }
    }
    if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
