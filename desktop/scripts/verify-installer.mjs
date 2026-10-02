#!/usr/bin/env node
// Installer acceptance for the coop window package (master plan D1c): install
// the built NSIS installer silently as the current user, check the Add/Remove
// entry and the shortcuts, run `coop.exe --doctor`, uninstall silently and
// check nothing of the package is left while the profile is untouched.
//
// It MUTATES the machine it runs on (an install, registry entries, shortcuts),
// so it runs only on a disposable GitHub-hosted Windows runner that opted in
// with COOP_INSTALLER_TEST=1 (salvaged from the September branch's
// assertDisposableInstallerHost); anywhere else it refuses. The CI job
// `installer (Windows)` runs it after desktop/scripts/build-installer.mjs.
//
//   node desktop/scripts/verify-installer.mjs [--dist <dir>] [--output <report.json>]
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRODUCT = "coop (window)";

export function assertDisposableInstallerHost(env = process.env, platform = process.platform) {
  if (platform !== "win32") throw new Error("installer acceptance runs on Windows only");
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || env.COOP_INSTALLER_TEST !== "1") {
    throw new Error("installer acceptance installs and uninstalls a package: it runs only on a GitHub-hosted runner with COOP_INSTALLER_TEST=1");
  }
}

/** NSIS: `/S /currentuser`, then `/D=` (install) or `_?=` (uninstall) last and unquoted, as NSIS requires. */
export function nsisInvocation(executable, directory, { uninstall = false } = {}) {
  for (const path of [executable, directory]) {
    if (typeof path !== "string" || !win32.isAbsolute(path) || /["\0-\x1f]/.test(path)) throw new Error(`NSIS path is invalid: ${path}`);
  }
  return {
    command: executable,
    args: ["/S", "/currentuser", `${uninstall ? "_?=" : "/D="}${directory}`],
    options: { shell: false, windowsVerbatimArguments: true, windowsHide: true },
  };
}

/** The places the package touches (electron-builder's per-user NSIS layout). */
export function packagePaths(env = process.env) {
  const installDir = join(env.LOCALAPPDATA, "Programs", "coop");
  return {
    installDir,
    exe: join(installDir, "coop.exe"),
    uninstaller: join(installDir, "Uninstall coop.exe"),
    startMenuShortcut: join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", `${PRODUCT}.lnk`),
    desktopShortcut: join(env.USERPROFILE, "Desktop", `${PRODUCT}.lnk`),
    // Electron's default appData folder for the product; the window keeps its
    // data under the coop profile instead, so this must never appear.
    electronAppData: join(env.APPDATA, "coop"),
    profileData: join(env.USERPROFILE, ".coop", "desktop", "data"),
  };
}

function runOwned(command, args, options = {}, timeoutMs = 180000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-32768); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.trim().split("\n").slice(-5).join(" | ")}`));
      else resolvePromise(stdout);
    });
  });
}

const REGISTRY = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$paths = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$items = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'coop (window)*' } | Select-Object DisplayName, DisplayVersion, UninstallString, InstallLocation)
ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
`;

async function registryEntries() {
  const powershell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const out = await runOwned(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", REGISTRY], { windowsHide: true }, 60000);
  const parsed = JSON.parse(out.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function main(argv) {
  assertDisposableInstallerHost();
  let dist = join(ROOT, "desktop", "installer", "dist");
  let output = "";
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--dist" && argv[i + 1]) dist = resolve(argv[i + 1]);
    else if (argv[i] === "--output" && argv[i + 1]) output = resolve(argv[i + 1]);
    else throw new Error("usage: verify-installer.mjs [--dist <dir>] [--output <report.json>]");
  }
  const installers = readdirSync(dist).filter((name) => /^coop-window-.*\.exe$/i.test(name));
  if (installers.length !== 1) throw new Error(`expected one coop-window-*.exe in ${dist}, found ${installers.length}`);
  const installer = join(dist, installers[0]);
  const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  const paths = packagePaths();
  const report = { ok: false, installer: installers[0], installerSha256: sha256(installer), version, steps: [] };
  const step = (name, detail) => { report.steps.push({ name, ...detail }); console.log(`  ✓ ${name}${detail && detail.note ? `: ${detail.note}` : ""}`); };

  if ((await registryEntries()).length) throw new Error(`${PRODUCT} is already registered on this runner`);
  if (existsSync(paths.installDir)) throw new Error(`${paths.installDir} already exists on this runner`);
  if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} already exists on this runner`);
  // The profile's window data: a sentinel that must survive install, doctor and uninstall.
  mkdirSync(paths.profileData, { recursive: true });
  const sentinelFile = join(paths.profileData, "installer-acceptance-sentinel.txt");
  const sentinel = randomBytes(16).toString("hex");
  writeFileSync(sentinelFile, sentinel, { flag: "wx" });

  let installed = false;
  try {
    const install = nsisInvocation(installer, paths.installDir);
    await runOwned(install.command, install.args, install.options);
    installed = true;
    if (!existsSync(paths.exe) || !existsSync(paths.uninstaller)) throw new Error(`install left no ${paths.exe} or uninstaller`);
    step("silent per-user install", { note: paths.installDir });

    const entries = await registryEntries();
    if (entries.length !== 1) throw new Error(`expected one Add/Remove entry for ${PRODUCT}, found ${entries.length}`);
    const entry = entries[0];
    if (entry.DisplayVersion !== version) throw new Error(`Add/Remove shows version ${entry.DisplayVersion}, built ${version}`);
    if (!String(entry.UninstallString || "").toLowerCase().includes(paths.uninstaller.toLowerCase())) throw new Error(`Add/Remove uninstall string is ${entry.UninstallString}`);
    step("Add/Remove Programs entry", { note: `${entry.DisplayName} ${entry.DisplayVersion}` });

    for (const [name, file] of [["Start Menu", paths.startMenuShortcut], ["Desktop", paths.desktopShortcut]]) {
      if (!existsSync(file)) throw new Error(`${name} shortcut missing: ${file}`);
    }
    step("Start Menu and Desktop shortcuts", { note: PRODUCT });

    const doctorOut = await runOwned(paths.exe, ["--doctor"], { windowsHide: true, cwd: paths.installDir }, 60000);
    const doctorLine = doctorOut.trim().split(/\r?\n/).filter(Boolean).pop() || "";
    let doctor;
    try { doctor = JSON.parse(doctorLine); } catch { throw new Error(`coop.exe --doctor printed no JSON: ${doctorOut.slice(-300)}`); }
    if (doctor.product !== "coop window" || doctor.version !== version || doctor.packaged !== true) throw new Error(`doctor report: ${doctorLine}`);
    if (!doctor.pdfjs || !doctor.pdfScript) throw new Error(`the package lacks pdf.js or its script: ${doctorLine}`);
    if (doctor.coop !== "") throw new Error(`doctor found a terminal coop on a runner that has none: ${doctor.coop}`);
    step("coop.exe --doctor", { note: doctorLine, doctor });

    if (readFileSync(sentinelFile, "utf8") !== sentinel) throw new Error("install or doctor changed the profile's window data");
    if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} appeared: the window's data left the coop profile`);
    step("profile untouched by install and doctor");

    const uninstall = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true });
    await runOwned(uninstall.command, uninstall.args, uninstall.options);
    installed = false;
    // The uninstaller removes itself last; give the file system a moment.
    for (let waited = 0; existsSync(paths.uninstaller) && waited < 30; waited++) await new Promise((done) => setTimeout(done, 1000));
    if (existsSync(paths.exe) || existsSync(join(paths.installDir, "resources"))) throw new Error("uninstall left the package installed");
    if ((await registryEntries()).length) throw new Error(`uninstall left ${PRODUCT} in Add/Remove Programs`);
    for (const file of [paths.startMenuShortcut, paths.desktopShortcut]) {
      if (existsSync(file)) throw new Error(`uninstall left a shortcut: ${file}`);
    }
    if (readFileSync(sentinelFile, "utf8") !== sentinel) throw new Error("uninstall removed or changed the profile's window data");
    if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} appeared during uninstall`);
    step("silent uninstall leaves no package, entry or shortcut; profile data kept");
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    if (installed && existsSync(paths.uninstaller)) {
      try {
        const uninstall = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true });
        await runOwned(uninstall.command, uninstall.args, uninstall.options);
        report.cleanup = "uninstalled";
      } catch (cleanupError) { report.cleanup = cleanupError.message; }
    }
    throw error;
  } finally {
    if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify({ ok: report.ok, installer: report.installer, sha256: report.installerSha256, version }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
}
