#!/usr/bin/env node
// Upgrade acceptance for the coop window package (master plan D1k, F3; Aaron
// 2026-10-07: the one installer must work for people who already have coop,
// and its shortcut must open the window; Aaron 2026-10-20: one install per
// machine). Two cases on a clean runner, after desktop/scripts/verify-installer.mjs
// has installed and removed the new build:
//
//   A. this machine over this account: the previous release's installer as a
//      per-user install (/S /currentuser, what releases before F3 were), with
//      the `coop` link and "coop (terminal)" its first launch wrote, then this
//      build for every account (/S /allusers). One Add/Remove entry, in HKLM,
//      at the new version; the per-user package gone with its link and
//      shortcuts (its own uninstaller ran, completely); "coop" for every
//      account opens the new coop.exe; the profile's window data and agent
//      settings kept; the next launch re-runs setup; the machine shim, PATH
//      entry and update task there. Installing this build over itself keeps
//      them; a real uninstall removes them.
//   B. this machine over a terminal install: a `coop` link and "coop"/"coop
//      (terminal)" shortcuts that start this checkout (the runner's terminal
//      coop), then this build. The all-users "coop" opens the window; the
//      account's link and shortcuts stay the terminal install's; the package
//      knows it is the machine install and would link nothing for the
//      account; the machine shim runs the account's link (a developer clone
//      wins); a terminal `coop update` (its shortcut repair) leaves the
//      all-users shortcuts alone; the uninstall keeps the terminal install's
//      link and shortcuts.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_TIMEOUT_MS, UNINSTALL_TIMEOUT_MS, UPDATE_TASK, assertDisposableInstallerHost, machinePath, nsisInvocation, packagePaths, pathHasEntry,
  ps, registryEntries, runOwned, scheduledTaskXml, sha256, writeTerminalShortcut,
} from "./verify-installer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A shortcut's target and arguments. */
async function shortcut(file) {
  const out = await ps("$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($env:COOP_LNK); [Console]::Out.Write($sc.TargetPath + '|' + $sc.Arguments)", { COOP_LNK: file });
  const [target, ...rest] = out.split("|");
  return { target, args: rest.join("|") };
}

/** Call a lib/common.ps1 function from a coop root and return its output. */
async function coopCall(coopRoot, expression) {
  return ps(". (Join-Path $env:COOP_CALL_ROOT 'lib\\common.ps1'); " + expression, { COOP_CALL_ROOT: coopRoot }, 180000);
}

function same(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }

async function install(exe, dir, mode) {
  const call = nsisInvocation(exe, dir, { mode });
  const started = Date.now();
  await runOwned(call.command, call.args, call.options, INSTALL_TIMEOUT_MS);
  return Math.round((Date.now() - started) / 1000);
}

async function uninstall(paths, mode) {
  if (!existsSync(paths.uninstaller)) return;
  const call = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true, mode });
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
  const machine = packagePaths();
  const user = packagePaths(process.env, "user");
  const settingsFile = join(process.env.USERPROFILE, ".coop", "agent", "settings.json");
  const report = { ok: false, previous: { installer: previous.split(/[\\/]/).pop(), version: prevReport.version }, current: { installer: current.split(/[\\/]/).pop(), version }, steps: [] };
  const step = (name, note) => { report.steps.push({ name, note }); console.log(`  ✓ ${name}${note ? `: ${note}` : ""}`); };

  if ((await registryEntries()).length) throw new Error("coop is already registered on this runner");
  for (const dir of [machine.installDir, user.installDir]) {
    if (existsSync(dir)) throw new Error(`${dir} already exists on this runner`);
  }
  if (await scheduledTaskXml()) throw new Error(`the scheduled task "${UPDATE_TASK}" already exists on this runner`);
  const prevLink = `@call "${join(user.installDir, "resources", "coop", "bin", "coop.cmd")}" %*\r\n`;
  const prevTerminal = join(user.installDir, "resources", "coop", "bin", "coop-desktop.ps1");
  const checkoutLink = `@echo off\r\ncall "${join(ROOT, "bin", "coop.cmd")}" %*\r\n`;
  const checkoutTerminal = join(ROOT, "bin", "coop-desktop.ps1");
  const cleanup = () => {
    for (const file of [machine.launcherLink, machine.terminalShortcut, machine.startMenuTerminalShortcut, machine.userDesktopShortcut, machine.userStartMenuShortcut, machine.updateState]) rmSync(file, { force: true });
  };

  // Profile data a teammate has: the window's data and the agent settings.
  mkdirSync(machine.profileData, { recursive: true });
  const sentinelFile = join(machine.profileData, "upgrade-acceptance-sentinel.txt");
  const sentinel = randomBytes(16).toString("hex");
  writeFileSync(sentinelFile, sentinel);
  mkdirSync(dirname(settingsFile), { recursive: true });
  const settingsBefore = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : `{"upgradeAcceptance":"${sentinel}"}\n`;
  writeFileSync(settingsFile, settingsBefore);

  let installed = "";
  try {
    // --- A. this machine over this account ---------------------------------------
    let seconds = await install(previous, user.installDir, "currentuser");
    installed = "user";
    const prevEntries = await registryEntries();
    if (prevEntries.length !== 1 || prevEntries[0].Hive !== "HKCU") throw new Error(`the previous release did not install for this account: ${JSON.stringify(prevEntries)}`);
    // What the previous package's first launch wrote: its own link and "coop (terminal)".
    mkdirSync(dirname(user.launcherLink), { recursive: true });
    writeFileSync(user.launcherLink, prevLink);
    await writeTerminalShortcut(user.terminalShortcut, prevTerminal);
    step("A. the previous release installed for this account (HKCU), with its first-launch link and shortcut", `${report.previous.installer} ${prevEntries[0].DisplayVersion} (${seconds}s)`);

    seconds = await install(current, machine.installDir, "allusers");
    installed = "machine";
    const entries = await registryEntries();
    if (entries.length !== 1 || entries[0].Hive !== "HKLM" || entries[0].DisplayVersion !== version) throw new Error(`after the upgrade Add/Remove shows ${JSON.stringify(entries)}`);
    if (!existsSync(machine.exe) || !existsSync(machine.runtime)) throw new Error("the upgrade did not lay down this build's payload (no coop.exe or runtime)");
    if (existsSync(user.exe) || existsSync(user.uninstaller)) throw new Error(`the account's older package is still at ${user.installDir}`);
    step("A. this build installed for every account: one Add/Remove entry (HKLM), the account's package removed", `${entries[0].DisplayName} ${entries[0].DisplayVersion} (${seconds}s)`);

    if (existsSync(user.launcherLink) || existsSync(user.terminalShortcut)) throw new Error("the older package's `coop` link or \"coop (terminal)\" survived its removal");
    for (const file of [user.desktopShortcut, user.startMenuShortcut]) {
      if (existsSync(file)) throw new Error(`the older package's shortcut survived: ${file}`);
    }
    step("A. the older package's link and shortcuts for this account are gone (its own uninstaller ran)");

    for (const file of [machine.desktopShortcut, machine.startMenuShortcut]) {
      if (!existsSync(file)) throw new Error(`after the upgrade the shortcut is missing: ${file}`);
      const sc = await shortcut(file);
      if (!same(sc.target, machine.exe)) throw new Error(`after the upgrade ${file} starts ${sc.target}, not ${machine.exe}`);
    }
    step("A. \"coop\" on the Desktop and in the Start Menu of every account opens the new window", machine.exe);

    if (readFileSync(sentinelFile, "utf8") !== sentinel || readFileSync(settingsFile, "utf8") !== settingsBefore) throw new Error("the upgrade changed the profile's window data or agent settings");
    if (existsSync(machine.electronAppData)) throw new Error(`${machine.electronAppData} appeared during the upgrade`);
    step("A. the profile's window data and agent settings kept");

    const doctor = JSON.parse((await runOwned(machine.exe, ["--doctor"], { windowsHide: true, cwd: machine.installDir }, 60000)).trim().split(/\r?\n/).filter(Boolean).pop());
    if (doctor.version !== version) throw new Error(`after the upgrade coop.exe --doctor reports ${doctor.version}`);
    const snapshot = join(machine.installDir, "resources", "coop");
    const pending = await coopCall(snapshot, "[Console]::Out.Write([string](Test-CoopBundledSetupPending))");
    if (!pending.endsWith("True")) throw new Error(`after the upgrade the next launch would not finish setup (Test-CoopBundledSetupPending: ${pending})`);
    step("A. the next launch finishes setup for the new version");

    if (!existsSync(machine.machineShim) || !existsSync(machine.machineMarker) || !(await scheduledTaskXml()) || !pathHasEntry(await machinePath(), machine.machineBin)) throw new Error("the machine shim, marker, PATH entry or update task is missing after the upgrade");
    step("A. the coop command for every account and the update task are there");

    // Installing this build over itself (what the update task does with a newer
    // one): the uninstaller runs with --updated and keeps the machine pieces.
    seconds = await install(current, machine.installDir, "allusers");
    const again = await registryEntries();
    if (again.length !== 1 || again[0].Hive !== "HKLM") throw new Error(`installing over this build left ${JSON.stringify(again)}`);
    if (!existsSync(machine.machineShim) || !existsSync(machine.machineMarker) || !(await scheduledTaskXml()) || !pathHasEntry(await machinePath(), machine.machineBin)) throw new Error("installing over this build removed the machine shim, marker, PATH entry or update task");
    step("A. installing over this build keeps the shim, the marker, the PATH entry and the update task", `${seconds}s`);

    await uninstall(machine, "allusers");
    installed = "";
    if (existsSync(machine.machineShim) || (await scheduledTaskXml()) || pathHasEntry(await machinePath(), machine.machineBin)) throw new Error("a real uninstall left the machine shim, the PATH entry or the update task");
    if ((await registryEntries()).length) throw new Error("a real uninstall left an Add/Remove entry");
    step("A. a real uninstall removes them");
    cleanup();

    // --- B. this machine over a terminal install ------------------------------------
    // This checkout is the runner's terminal coop: its link and both shortcuts.
    mkdirSync(dirname(user.launcherLink), { recursive: true });
    writeFileSync(user.launcherLink, checkoutLink);
    await coopCall(ROOT, "[void](Set-CoopDesktopShortcuts)");
    for (const file of [user.desktopShortcut, user.terminalShortcut]) {
      if (!existsSync(file)) throw new Error(`the terminal install wrote no ${file}`);
    }
    const termMainBefore = await shortcut(user.desktopShortcut);
    step("B. a terminal install's `coop` link and \"coop\"/\"coop (terminal)\" shortcuts");

    seconds = await install(current, machine.installDir, "allusers");
    installed = "machine";
    for (const file of [machine.desktopShortcut, machine.startMenuShortcut]) {
      const sc = await shortcut(file);
      if (!same(sc.target, machine.exe)) throw new Error(`after installing the window ${file} starts ${sc.target} ${sc.args}, not the window`);
    }
    step("B. this build installed: \"coop\" for every account opens the window", `${seconds}s`);

    if (readFileSync(user.launcherLink, "utf8") !== checkoutLink) throw new Error("installing the window changed the terminal install's `coop` link");
    const term = await shortcut(user.terminalShortcut);
    if (!term.args.toLowerCase().includes(checkoutTerminal.toLowerCase())) throw new Error(`installing the window changed "coop (terminal)": ${term.args}`);
    const termMain = await shortcut(user.desktopShortcut);
    if (!same(termMain.target, termMainBefore.target) || termMain.args !== termMainBefore.args) throw new Error(`installing the window changed the account's own "coop": ${termMain.target} ${termMain.args}`);
    const foreign = await coopCall(snapshot, "[Console]::Out.Write([string](Test-CoopForeignLauncherLink) + ',' + [string](Test-CoopMachineInstall) + ',' + (Get-CoopInstallKind))");
    if (!foreign.endsWith("True,True,machine")) throw new Error(`the package does not see the terminal install and the machine install (foreign link, machine, kind: ${foreign})`);
    step("B. the account's `coop`, \"coop\" and \"coop (terminal)\" stay the terminal install's; the package knows it is this machine's install");

    // The machine shim prefers the account's link: a stub link proves which ran.
    writeFileSync(user.launcherLink, "@echo off\r\necho LINK-WINS %*\r\n");
    const shimOut = await runOwned(process.env.ComSpec || "cmd.exe", ["/d", "/c", `"${machine.machineShim}" version`], { windowsHide: true, windowsVerbatimArguments: true }, 60000);
    writeFileSync(user.launcherLink, checkoutLink);
    if (!shimOut.includes("LINK-WINS version")) throw new Error(`the machine shim did not run the account's link: ${shimOut.trim().slice(-200)}`);
    step("B. the machine shim runs the account's own `coop` link first (a developer clone wins)");

    // The terminal's own shortcut repair (`coop update`, `coop install`) leaves the all-users shortcuts alone.
    await coopCall(ROOT, "[void](Set-CoopDesktopShortcuts -OnlyIfPresent)");
    const after = await shortcut(machine.desktopShortcut);
    if (!same(after.target, machine.exe)) throw new Error(`a terminal shortcut repair changed the all-users "coop": ${after.target} ${after.args}`);
    step("B. a terminal `coop update` leaves \"coop\" for every account on the window");

    await uninstall(machine, "allusers");
    installed = "";
    if (!existsSync(user.launcherLink) || readFileSync(user.launcherLink, "utf8") !== checkoutLink) throw new Error("uninstalling the window removed the terminal install's `coop` link");
    if (!existsSync(user.terminalShortcut) || !existsSync(user.desktopShortcut)) throw new Error("uninstalling the window removed the terminal install's shortcuts");
    if (readFileSync(sentinelFile, "utf8") !== sentinel || readFileSync(settingsFile, "utf8") !== settingsBefore) throw new Error("the profile's window data or agent settings changed");
    step("B. uninstalling the window keeps the terminal install's link and shortcuts");
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    if (installed === "machine") { try { await uninstall(machine, "allusers"); report.cleanup = "uninstalled"; } catch (cleanupError) { report.cleanup = cleanupError.message; } }
    if (installed === "user") { try { await uninstall(user, "currentuser"); report.cleanup = "uninstalled"; } catch (cleanupError) { report.cleanup = cleanupError.message; } }
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
