#!/usr/bin/env node
// Launch acceptance for the coop window package (master plan D1k; Aaron
// 2026-10-07: shortcuts that silently fail or never open the window). On a
// clean runner: install this build, then open the Desktop "coop" shortcut the
// way a double-click does (ShellExecute on the .lnk) and require a real
// window, twice:
//   1. a fresh profile: the shortcut shows the project picker window;
//   2. with a folder set to open next time: the shortcut runs the whole chain
//      (the exe, its setup console, the bundled coop.ps1 first-launch setup,
//      the spec hand-over) and the coop window opens on that folder; setup
//      records this version as done;
//   3. the shortcut clicked again while the window is open brings that window
//      forward and starts no second one (it used to do nothing at all).
// Then it uninstalls. Like verify-installer.mjs it MUTATES the machine, so it
// runs only on a disposable GitHub-hosted Windows runner with COOP_INSTALLER_TEST=1.
//
//   node desktop/scripts/verify-launch.mjs [--dist <dir>] [--output <report.json>]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_TIMEOUT_MS, UNINSTALL_TIMEOUT_MS, assertDisposableInstallerHost, nsisInvocation, packagePaths, registryEntries, runOwned,
} from "./verify-installer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PICKER_TITLE = "coop - open a project";
const SETUP_TIMEOUT_MS = 20 * 60 * 1000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function powershellExe() {
  return win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function ps(command, env = {}, timeoutMs = 120000) {
  return (await runOwned(powershellExe(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, env: { ...process.env, ...env } }, timeoutMs)).trim();
}

/** The coop.exe processes that own a visible top-level window: [{ id, title }]. */
async function coopWindows() {
  const out = await ps("$w = @(Get-Process -Name coop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ id = $_.Id; title = $_.MainWindowTitle } }); ConvertTo-Json -InputObject $w -Compress");
  const parsed = JSON.parse(out || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function coopProcessCount() {
  return Number(await ps("@(Get-Process -Name coop -ErrorAction SilentlyContinue).Count")) || 0;
}

/** Double-click: ShellExecute on the shortcut, from a process whose environment the launch inherits. */
async function openShortcut(lnk, env) {
  await ps("Start-Process -FilePath $env:COOP_LNK", { ...env, COOP_LNK: lnk });
}

async function waitFor(what, timeoutMs, test) {
  const started = Date.now();
  for (;;) {
    const value = await test();
    if (value) return { value, seconds: Math.round((Date.now() - started) / 1000) };
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await sleep(3000);
  }
}

async function stopCoop() {
  // The window process and its setup console (a child of coop.exe).
  try { await runOwned(join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/F", "/T", "/IM", "coop.exe"], { windowsHide: true }, 60000); } catch { /* none running */ }
  for (let i = 0; i < 20 && (await coopProcessCount()); i++) await sleep(1000);
}

async function main(argv) {
  assertDisposableInstallerHost();
  let dist = join(ROOT, "desktop", "installer", "dist");
  let output = "";
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--dist" && argv[i + 1]) dist = resolve(argv[i + 1]);
    else if (argv[i] === "--output" && argv[i + 1]) output = resolve(argv[i + 1]);
    else throw new Error("usage: verify-launch.mjs [--dist <dir>] [--output <report.json>]");
  }
  const found = readdirSync(dist).filter((name) => /^coop-window-.*\.exe$/i.test(name));
  if (found.length !== 1) throw new Error(`expected one coop-window-*.exe in ${dist}, found ${found.length}`);
  const installer = join(dist, found[0]);
  const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  const paths = packagePaths();
  const marker = join(process.env.USERPROFILE, ".coop", "desktop", "window-setup-version");
  const work = join(process.env.RUNNER_TEMP || process.env.TEMP, "coop-launch-work");
  mkdirSync(work, { recursive: true });
  // What a double-click cannot answer on a runner: the name question and the
  // browser model sign-in (both interactive by design on a teammate's machine).
  const env = { COOP_NO_ONBOARD: "1", COOP_NO_MODEL_LOGIN: "1" };
  const report = { ok: false, installer: found[0], version, steps: [] };
  const step = (name, note) => { report.steps.push({ name, note }); console.log(`  ✓ ${name}${note ? `: ${note}` : ""}`); };

  if ((await registryEntries()).length) throw new Error("coop (window) is already registered on this runner");
  if (await coopProcessCount()) throw new Error("a coop.exe is already running on this runner");
  let installed = false;
  try {
    const call = nsisInvocation(installer, paths.installDir);
    await runOwned(call.command, call.args, call.options, INSTALL_TIMEOUT_MS);
    installed = true;
    if (!existsSync(paths.desktopShortcut)) throw new Error(`no Desktop shortcut: ${paths.desktopShortcut}`);
    step("installed", paths.installDir);

    // 1. Fresh profile: the shortcut opens the project picker.
    await openShortcut(paths.desktopShortcut, env);
    const picker = await waitFor("the project picker window", 120000, async () => (await coopWindows()).find((w) => w.title === PICKER_TITLE));
    step("the Desktop shortcut opens a window (the project picker)", `${picker.seconds}s`);
    await stopCoop();

    // 2. A folder to open next time: the whole chain, first-launch setup included.
    const dataRoot = join(process.env.USERPROFILE, ".coop", "desktop", "data");
    const dirs = existsSync(dataRoot) ? readdirSync(dataRoot, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
    if (dirs.length !== 1) throw new Error(`expected the picker run to create one window data folder under ${dataRoot}, found ${dirs.length}`);
    const settingsFile = join(dataRoot, dirs[0].name, "settings.json");
    const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8") || "{}") : {};
    writeFileSync(settingsFile, JSON.stringify({ ...settings, openNextTime: work }, null, 2));
    await openShortcut(paths.desktopShortcut, env);
    // The window's title names the folder ("coop - coop-launch-work"), so an error box titled "coop" never passes.
    const opened = await waitFor("the coop window on the folder (first-launch setup runs first)", SETUP_TIMEOUT_MS, async () => (await coopWindows()).find((w) => w.title && w.title.endsWith(win32.basename(work))));
    step("the Desktop shortcut runs the first-launch setup and opens the coop window", `"${opened.value.title}" after ${opened.seconds}s`);
    const done = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (done !== version) throw new Error(`setup did not record this version as done (${marker}: "${done}")`);
    step("setup recorded this version, so the next start skips it", version);

    // 3. Clicked again while open: the same window comes forward, no second one.
    const before = await coopWindows();
    await openShortcut(paths.desktopShortcut, env);
    await sleep(15000);
    const after = await coopWindows();
    if (after.length !== before.length || !after.some((w) => w.id === opened.value.id)) throw new Error(`a second click changed the windows: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    step("a second click while open keeps the one window (brought forward)");
    await stopCoop();

    const uninstall = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true });
    await runOwned(uninstall.command, uninstall.args, uninstall.options, UNINSTALL_TIMEOUT_MS);
    installed = false;
    step("uninstalled");
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    try { report.windows = await coopWindows(); } catch { /* ignore */ }
    try { report.processes = await ps("Get-Process | Where-Object { $_.ProcessName -match '^(coop|powershell|pwsh|node|pi)$' } | Select-Object ProcessName, Id, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200"); } catch { /* ignore */ }
    console.error(report.processes || "");
    await stopCoop();
    if (installed && existsSync(paths.uninstaller)) {
      try {
        const uninstall = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true });
        await runOwned(uninstall.command, uninstall.args, uninstall.options, UNINSTALL_TIMEOUT_MS);
      } catch { /* the runner is disposable */ }
    }
    throw error;
  } finally {
    if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify({ ok: report.ok, installer: report.installer, version }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
}
