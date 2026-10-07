#!/usr/bin/env node
// Upgrade acceptance for the coop window package (master plan D1k; Aaron
// 2026-10-07: the one installer must work for people who already have coop,
// and its shortcut must open the window). Two cases on a clean runner, after
// desktop/scripts/verify-installer.mjs has installed and removed the new build:
//
//   A. window over window: the previous release's installer, then this build
//      over it. One Add/Remove entry at the new version, the new payload, the
//      "coop" shortcuts open the new coop.exe, the profile's window data and
//      agent settings kept, the package's own `coop` link and "coop (terminal)"
//      kept (an upgrade is not an uninstall), and the next launch re-runs setup.
//   B. window over a terminal install: a `coop` link and "coop"/"coop
//      (terminal)" shortcuts that start this checkout (the runner's terminal
//      coop), then this build. "coop" now opens the window; the terminal
//      link and "coop (terminal)" are the terminal install's still; the
//      package's first launch leaves them alone; a terminal `coop update`
//      (its shortcut repair) keeps "coop" on the window; the uninstall keeps
//      the terminal install's link and shortcut.
//
// Like verify-installer.mjs it MUTATES the machine, so it runs only on a
// disposable GitHub-hosted Windows runner with COOP_INSTALLER_TEST=1.
//
//   node desktop/scripts/verify-upgrade.mjs --previous <dir> [--dist <dir>] [--output <report.json>]
//
// <dir> holds the previous release's coop-window-*.exe and its
// installer-acceptance.json (the exe's SHA-256 must match that report).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_TIMEOUT_MS, UNINSTALL_TIMEOUT_MS, assertDisposableInstallerHost, nsisInvocation, packagePaths,
  registryEntries, runOwned, sha256, writeTerminalShortcut,
} from "./verify-installer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function powershellExe() {
  return win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Run Windows PowerShell 5.1 with a command; paths travel in the environment. */
async function ps(command, env = {}) {
  return (await runOwned(powershellExe(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, env: { ...process.env, ...env } }, 180000)).trim();
}

/** A shortcut's target and arguments. */
async function shortcut(file) {
  const out = await ps("$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($env:COOP_LNK); [Console]::Out.Write($sc.TargetPath + '|' + $sc.Arguments)", { COOP_LNK: file });
  const [target, ...rest] = out.split("|");
  return { target, args: rest.join("|") };
}

/** Call a lib/common.ps1 function from a coop root and return its output. */
async function coopCall(coopRoot, expression) {
  return ps(". (Join-Path $env:COOP_CALL_ROOT 'lib\\common.ps1'); " + expression, { COOP_CALL_ROOT: coopRoot });
}

function same(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }

async function install(exe, dir) {
  const call = nsisInvocation(exe, dir);
  const started = Date.now();
  await runOwned(call.command, call.args, call.options, INSTALL_TIMEOUT_MS);
  return Math.round((Date.now() - started) / 1000);
}

async function uninstall(paths) {
  if (!existsSync(paths.uninstaller)) return;
  const call = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true });
  await runOwned(call.command, call.args, call.options, UNINSTALL_TIMEOUT_MS);
  for (let waited = 0; existsSync(paths.uninstaller) && waited < 30; waited++) await new Promise((done) => setTimeout(done, 1000));
}

function oneExe(dir) {
  const found = readdirSync(dir).filter((name) => /^coop-window-.*\.exe$/i.test(name));
  if (found.length !== 1) throw new Error(`expected one coop-window-*.exe in ${dir}, found ${found.length}`);
  return join(dir, found[0]);
}

async function main(argv) {
  assertDisposableInstallerHost();
  let dist = join(ROOT, "desktop", "installer", "dist");
  let previousDir = "";
  let output = "";
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--dist" && argv[i + 1]) dist = resolve(argv[i + 1]);
    else if (argv[i] === "--previous" && argv[i + 1]) previousDir = resolve(argv[i + 1]);
    else if (argv[i] === "--output" && argv[i + 1]) output = resolve(argv[i + 1]);
    else throw new Error("usage: verify-upgrade.mjs --previous <dir> [--dist <dir>] [--output <report.json>]");
  }
  if (!previousDir) throw new Error("--previous <dir> is required");
  const current = oneExe(dist);
  const previous = oneExe(previousDir);
  const prevReport = JSON.parse(readFileSync(join(previousDir, "installer-acceptance.json"), "utf8"));
  if (!same(prevReport.installerSha256, sha256(previous))) throw new Error(`the previous installer's SHA-256 is not the one its release's acceptance report names`);
  const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  const paths = packagePaths();
  const gitDir = join(paths.runtime, "git");
  const settingsFile = join(process.env.USERPROFILE, ".coop", "agent", "settings.json");
  const report = { ok: false, previous: { installer: previous.split(/[\\/]/).pop(), version: prevReport.version }, current: { installer: current.split(/[\\/]/).pop(), version }, steps: [] };
  const step = (name, note) => { report.steps.push({ name, note }); console.log(`  ✓ ${name}${note ? `: ${note}` : ""}`); };

  if ((await registryEntries()).length) throw new Error("coop (window) is already registered on this runner");
  if (existsSync(paths.installDir)) throw new Error(`${paths.installDir} already exists on this runner`);
  const ownLink = `@call "${join(paths.installDir, "resources", "coop", "bin", "coop.cmd")}" %*\r\n`;
  const ownTerminal = join(paths.installDir, "resources", "coop", "bin", "coop-desktop.ps1");
  const checkoutLink = `@echo off\r\ncall "${join(ROOT, "bin", "coop.cmd")}" %*\r\n`;
  const checkoutTerminal = join(ROOT, "bin", "coop-desktop.ps1");
  const cleanup = () => {
    for (const file of [paths.launcherLink, paths.terminalShortcut, paths.startMenuTerminalShortcut, paths.desktopShortcut, paths.startMenuShortcut]) rmSync(file, { force: true });
  };

  // Profile data a teammate has: the window's data and the agent settings.
  mkdirSync(paths.profileData, { recursive: true });
  const sentinelFile = join(paths.profileData, "upgrade-acceptance-sentinel.txt");
  const sentinel = randomBytes(16).toString("hex");
  writeFileSync(sentinelFile, sentinel);
  mkdirSync(dirname(settingsFile), { recursive: true });
  const settingsBefore = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : `{"upgradeAcceptance":"${sentinel}"}\n`;
  writeFileSync(settingsFile, settingsBefore);

  let installed = false;
  try {
    // --- A. window over window ------------------------------------------------
    let seconds = await install(previous, paths.installDir);
    installed = true;
    if (existsSync(gitDir)) throw new Error("the previous release already carries runtime\\git: this check cannot tell the payloads apart");
    // What the previous package's first launch wrote: its own link and "coop (terminal)".
    mkdirSync(dirname(paths.launcherLink), { recursive: true });
    writeFileSync(paths.launcherLink, ownLink);
    await writeTerminalShortcut(paths.terminalShortcut, ownTerminal);
    step("A. the previous release installed, with its first-launch link and shortcut", `${report.previous.installer} (${seconds}s)`);

    seconds = await install(current, paths.installDir);
    const entries = await registryEntries();
    if (entries.length !== 1 || entries[0].DisplayVersion !== version) throw new Error(`after the upgrade Add/Remove shows ${JSON.stringify(entries)}`);
    if (!existsSync(gitDir) || !existsSync(paths.exe)) throw new Error("the upgrade did not lay down this build's payload (no runtime\\git or coop.exe)");
    step("A. this build installed over it: one Add/Remove entry, the new payload", `${entries[0].DisplayName} ${entries[0].DisplayVersion} (${seconds}s)`);

    for (const file of [paths.desktopShortcut, paths.startMenuShortcut]) {
      if (!existsSync(file)) throw new Error(`after the upgrade the shortcut is missing: ${file}`);
      const sc = await shortcut(file);
      if (!same(sc.target, paths.exe)) throw new Error(`after the upgrade ${file} starts ${sc.target}, not ${paths.exe}`);
    }
    step("A. \"coop\" on the Desktop and in the Start Menu opens the new window", paths.exe);

    if (readFileSync(sentinelFile, "utf8") !== sentinel || readFileSync(settingsFile, "utf8") !== settingsBefore) throw new Error("the upgrade changed the profile's window data or agent settings");
    if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} appeared during the upgrade`);
    step("A. the profile's window data and agent settings kept");

    // The new uninstaller keeps them on an upgrade; an older one (<= this
    // change) removed them, and the re-run setup below writes them back.
    const linkKept = existsSync(paths.launcherLink) && existsSync(paths.terminalShortcut);
    const doctor = JSON.parse((await runOwned(paths.exe, ["--doctor"], { windowsHide: true, cwd: paths.installDir }, 60000)).trim().split(/\r?\n/).filter(Boolean).pop());
    if (doctor.version !== version) throw new Error(`after the upgrade coop.exe --doctor reports ${doctor.version}`);
    const pending = await coopCall(join(paths.installDir, "resources", "coop"), "[Console]::Out.Write([string](Test-CoopBundledSetupPending))");
    if (!pending.endsWith("True")) throw new Error(`after the upgrade the next launch would not finish setup (Test-CoopBundledSetupPending: ${pending})`);
    step("A. the next launch finishes setup for the new version", linkKept ? "the `coop` link and \"coop (terminal)\" also survived the upgrade" : "the previous uninstaller removed the `coop` link and \"coop (terminal)\"; setup writes them back");

    // A later upgrade over this build keeps them: this build's uninstaller skips its cleanup with --updated.
    writeFileSync(paths.launcherLink, ownLink);
    await writeTerminalShortcut(paths.terminalShortcut, ownTerminal);
    seconds = await install(current, paths.installDir);
    if (!existsSync(paths.launcherLink) || !existsSync(paths.terminalShortcut)) throw new Error("reinstalling over this build removed the package's `coop` link or \"coop (terminal)\" shortcut");
    step("A. installing over this build keeps the `coop` link and \"coop (terminal)\"", `${seconds}s`);

    await uninstall(paths);
    installed = false;
    if (existsSync(paths.launcherLink) || existsSync(paths.terminalShortcut)) throw new Error("a real uninstall left the package's link or \"coop (terminal)\"");
    step("A. a real uninstall still removes them");
    cleanup();

    // --- B. window over a terminal install -------------------------------------
    // This checkout is the runner's terminal coop: its link and both shortcuts.
    mkdirSync(dirname(paths.launcherLink), { recursive: true });
    writeFileSync(paths.launcherLink, checkoutLink);
    await coopCall(ROOT, "[void](Set-CoopDesktopShortcuts)");
    for (const file of [paths.desktopShortcut, paths.terminalShortcut]) {
      if (!existsSync(file)) throw new Error(`the terminal install wrote no ${file}`);
    }
    step("B. a terminal install's `coop` link and \"coop\"/\"coop (terminal)\" shortcuts");

    seconds = await install(current, paths.installDir);
    installed = true;
    for (const file of [paths.desktopShortcut, paths.startMenuShortcut]) {
      const sc = await shortcut(file);
      if (!same(sc.target, paths.exe)) throw new Error(`after installing the window ${file} starts ${sc.target} ${sc.args}, not the window`);
    }
    step("B. this build installed: \"coop\" now opens the window", `${seconds}s`);

    if (readFileSync(paths.launcherLink, "utf8") !== checkoutLink) throw new Error("installing the window changed the terminal install's `coop` link");
    const term = await shortcut(paths.terminalShortcut);
    if (!term.args.toLowerCase().includes(checkoutTerminal.toLowerCase())) throw new Error(`installing the window changed "coop (terminal)": ${term.args}`);
    const snapshot = join(paths.installDir, "resources", "coop");
    const foreign = await coopCall(snapshot, "[Console]::Out.Write([string](Test-CoopForeignLauncherLink) + ',' + [string](Test-CoopForeignTerminalShortcut))");
    if (!foreign.endsWith("True,True")) throw new Error(`the package's first launch would take over the terminal install (foreign link, shortcut: ${foreign})`);
    step("B. the terminal `coop` and \"coop (terminal)\" stay the terminal install's; the first launch leaves them");

    // The terminal's own shortcut repair (`coop update`, `coop install`) keeps "coop" on the window.
    await coopCall(ROOT, "[void](Set-CoopDesktopShortcuts -OnlyIfPresent)");
    const after = await shortcut(paths.desktopShortcut);
    if (!same(after.target, paths.exe)) throw new Error(`a terminal shortcut repair took "coop" back: ${after.target} ${after.args}`);
    step("B. a terminal `coop update` keeps \"coop\" on the window");

    await uninstall(paths);
    installed = false;
    if (!existsSync(paths.launcherLink) || readFileSync(paths.launcherLink, "utf8") !== checkoutLink) throw new Error("uninstalling the window removed the terminal install's `coop` link");
    if (!existsSync(paths.terminalShortcut)) throw new Error("uninstalling the window removed the terminal install's \"coop (terminal)\"");
    if (readFileSync(sentinelFile, "utf8") !== sentinel || readFileSync(settingsFile, "utf8") !== settingsBefore) throw new Error("the profile's window data or agent settings changed");
    step("B. uninstalling the window keeps the terminal install's link and \"coop (terminal)\"");
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    if (installed) { try { await uninstall(paths); report.cleanup = "uninstalled"; } catch (cleanupError) { report.cleanup = cleanupError.message; } }
    throw error;
  } finally {
    cleanup();
    if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify({ ok: report.ok, previous: report.previous, current: report.current }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
}
