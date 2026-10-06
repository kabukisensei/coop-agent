#!/usr/bin/env node
// Installer acceptance for the coop window package (master plan D1c, D1d):
// install the built NSIS installer silently as the current user, check the
// Add/Remove entry and the shortcuts, run `coop.exe --doctor`, check the
// bundled runtime (the pinned Node answers, Pi and every extension are at
// their pins, the lock is the shipped one) and the coop snapshot (its
// `coop version` runs the bundled Pi), uninstall silently and check nothing of
// the package is left while the profile is untouched.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_SHIMS_DROPPED, bundledDownloads, hasWheel, longestPath } from "./build-installer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRODUCT = "coop (window)";
// D1m: the package's own shortcut is plain "coop" (electron-builder nsis.shortcutName);
// the first launch adds "coop (terminal)" beside it.
const SHORTCUT = "coop";

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
  const runtime = join(installDir, "resources", "runtime");
  return {
    installDir,
    exe: join(installDir, "coop.exe"),
    // The package's first launch writes these (scripts/install.ps1 in bundled
    // mode); the uninstaller removes them when they point into installDir.
    // The package's own "coop" shortcut is the exe's; the launch adds "coop (terminal)".
    launcherLink: join(env.LOCALAPPDATA, "coop", "bin", "coop.cmd"),
    terminalShortcut: join(env.USERPROFILE, "Desktop", "coop (terminal).lnk"),
    startMenuTerminalShortcut: join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "coop (terminal).lnk"),
    uninstaller: join(installDir, "Uninstall coop.exe"),
    // D1d: the bundled runtime and the coop snapshot beside the asar.
    runtime,
    nodeDir: join(runtime, "node"),
    nodeExe: join(runtime, "node", "node.exe"),
    npmPrefix: join(runtime, "npm"),
    piPackage: join(runtime, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    piShim: join(runtime, "npm", "pi.cmd"),
    extensions: join(runtime, "extensions"),
    coopPs1: join(installDir, "resources", "coop", "bin", "coop.ps1"),
    startMenuShortcut: join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", `${SHORTCUT}.lnk`),
    desktopShortcut: join(env.USERPROFILE, "Desktop", `${SHORTCUT}.lnk`),
    // Electron's default appData folder for the product; the window keeps its
    // data under the coop profile instead, so this must never appear.
    electronAppData: join(env.APPDATA, "coop"),
    profileData: join(env.USERPROFILE, ".coop", "desktop", "data"),
  };
}

// The package carries the bundled runtime (D1d: Node, Pi, the extension tree,
// the repository snapshot), so NSIS unpacks tens of thousands of files; a
// GitHub-hosted runner needs well over three minutes for that.
const INSTALL_TIMEOUT_MS = 900000;
const UNINSTALL_TIMEOUT_MS = 600000;

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

/** Write a "coop (terminal)" shortcut the way scripts/install.ps1 does (powershell.exe -File <launcher>). */
async function writeTerminalShortcut(file, launcher) {
  const powershell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut($env:COOP_LNK); $sc.TargetPath = '${powershell.replace(/'/g, "''")}'; $sc.Arguments = ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $env:COOP_LAUNCHER + '"'); $sc.Save()`;
  await runOwned(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, COOP_LNK: file, COOP_LAUNCHER: launcher } }, 60000);
  if (!existsSync(file)) throw new Error(`could not write ${file}`);
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
  const manifest = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));
  const lockSha256 = sha256(join(ROOT, "config", "extensions-lock.json"));
  const powershell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const paths = packagePaths();
  const report = { ok: false, installer: installers[0], installerSha256: sha256(installer), version, steps: [] };
  const step = (name, detail) => { report.steps.push({ name, ...detail }); console.log(`  ✓ ${name}${detail && detail.note ? `: ${detail.note}` : ""}`); };

  if ((await registryEntries()).length) throw new Error(`${PRODUCT} is already registered on this runner`);
  if (existsSync(paths.installDir)) throw new Error(`${paths.installDir} already exists on this runner`);
  if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} already exists on this runner`);
  for (const file of [paths.launcherLink, paths.terminalShortcut, paths.startMenuTerminalShortcut]) {
    if (existsSync(file)) throw new Error(`${file} already exists on this runner`);
  }
  // The profile's window data: a sentinel that must survive install, doctor and uninstall.
  mkdirSync(paths.profileData, { recursive: true });
  const sentinelFile = join(paths.profileData, "installer-acceptance-sentinel.txt");
  const sentinel = randomBytes(16).toString("hex");
  writeFileSync(sentinelFile, sentinel, { flag: "wx" });

  let installed = false;
  try {
    const install = nsisInvocation(installer, paths.installDir);
    const installStarted = Date.now();
    await runOwned(install.command, install.args, install.options, INSTALL_TIMEOUT_MS);
    installed = true;
    const installSeconds = Math.round((Date.now() - installStarted) / 1000);
    if (!existsSync(paths.exe) || !existsSync(paths.uninstaller)) throw new Error(`install left no ${paths.exe} or uninstaller`);
    step("silent per-user install", { note: `${paths.installDir} (${installSeconds}s)`, seconds: installSeconds });

    const entries = await registryEntries();
    if (entries.length !== 1) throw new Error(`expected one Add/Remove entry for ${PRODUCT}, found ${entries.length}`);
    const entry = entries[0];
    if (entry.DisplayVersion !== version) throw new Error(`Add/Remove shows version ${entry.DisplayVersion}, built ${version}`);
    if (!String(entry.UninstallString || "").toLowerCase().includes(paths.uninstaller.toLowerCase())) throw new Error(`Add/Remove uninstall string is ${entry.UninstallString}`);
    step("Add/Remove Programs entry", { note: `${entry.DisplayName} ${entry.DisplayVersion}` });

    for (const [name, file] of [["Start Menu", paths.startMenuShortcut], ["Desktop", paths.desktopShortcut]]) {
      if (!existsSync(file)) throw new Error(`${name} shortcut missing: ${file}`);
    }
    step("Start Menu and Desktop shortcuts", { note: SHORTCUT });

    const doctorOut = await runOwned(paths.exe, ["--doctor"], { windowsHide: true, cwd: paths.installDir }, 60000);
    const doctorLine = doctorOut.trim().split(/\r?\n/).filter(Boolean).pop() || "";
    let doctor;
    try { doctor = JSON.parse(doctorLine); } catch { throw new Error(`coop.exe --doctor printed no JSON: ${doctorOut.slice(-300)}`); }
    if (doctor.product !== "coop window" || doctor.version !== version || doctor.packaged !== true) throw new Error(`doctor report: ${doctorLine}`);
    if (!doctor.pdfjs || !doctor.pdfScript) throw new Error(`the package lacks pdf.js or its script: ${doctorLine}`);
    if (doctor.coop.toLowerCase() !== paths.coopPs1.toLowerCase()) throw new Error(`doctor names ${doctor.coop || "no coop"}, not the bundled ${paths.coopPs1}`);
    if (!doctor.runtime || doctor.runtime.node !== manifest.desktop.node.version || doctor.runtime.pi !== manifest.pi.version || doctor.runtime.extensions !== true) {
      throw new Error(`doctor's runtime is not the manifest's Node ${manifest.desktop.node.version}, Pi ${manifest.pi.version} and extension tree: ${doctorLine}`);
    }
    step("coop.exe --doctor", { note: doctorLine, doctor });

    // D1d: the bundled runtime answers and is exactly what the manifest pins.
    const nodeOut = (await runOwned(paths.nodeExe, ["--version"], { windowsHide: true }, 60000)).trim();
    if (nodeOut !== `v${manifest.desktop.node.version}`) throw new Error(`bundled node.exe --version printed ${nodeOut}`);
    const piPkg = JSON.parse(readFileSync(paths.piPackage, "utf8"));
    if (piPkg.version !== manifest.pi.version || !existsSync(paths.piShim)) throw new Error(`bundled Pi is ${piPkg.version}, shim ${existsSync(paths.piShim)}`);
    for (const [name, pin] of Object.entries(manifest.npm_tools || {})) {
      const pkg = join(paths.runtime, "npm", "node_modules", name, "package.json");
      if (!existsSync(pkg) || JSON.parse(readFileSync(pkg, "utf8")).version !== pin) throw new Error(`bundled ${name} is not ${pin}`);
    }
    if (sha256(join(paths.extensions, "package-lock.json")) !== lockSha256) throw new Error("the bundled extension tree's lock is not config/extensions-lock.json");
    for (const [name, pin] of Object.entries(manifest.extensions || {})) {
      const pkg = join(paths.extensions, "node_modules", name, "package.json");
      if (!existsSync(pkg) || JSON.parse(readFileSync(pkg, "utf8")).version !== pin) throw new Error(`bundled ${name} is not ${pin}`);
    }
    step("bundled Node, Pi, npm tools and the extension tree at the manifest's pins", { note: `Node ${nodeOut}, Pi ${piPkg.version}` });

    // The Node zip's npm.ps1 answered `npm prefix -g` with 'Unknown command'
    // (D1d VM check): PowerShell must resolve `& npm` to the bundled npm.cmd,
    // with the bundled Node first on PATH as lib/common.ps1 puts it.
    for (const shim of NODE_SHIMS_DROPPED) {
      if (existsSync(join(paths.nodeDir, shim))) throw new Error(`the bundled Node still carries ${shim}`);
    }
    const npmScript = "$env:PATH = $env:COOP_NODE_DIR + ';' + $env:PATH; $env:npm_config_prefix = $env:COOP_NPM_PREFIX; & npm prefix -g";
    const npmOut = (await runOwned(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", npmScript], { windowsHide: true, env: { ...process.env, COOP_NODE_DIR: paths.nodeDir, COOP_NPM_PREFIX: paths.npmPrefix } }, 120000)).trim();
    if (npmOut.toLowerCase() !== paths.npmPrefix.toLowerCase()) throw new Error(`\`& npm prefix -g\` under PowerShell printed ${npmOut || "nothing"}, not the bundled prefix ${paths.npmPrefix}`);
    step("PowerShell's `& npm` runs the bundled npm.cmd", { note: npmOut });

    // D1k: Git, Python with pipx, the Azure CLI, the wheel folder and the ODBC
    // installers are in the package and answer, so a teammate installs nothing else.
    const gitOut = (await runOwned(join(paths.runtime, "git", "cmd", "git.exe"), ["--version"], { windowsHide: true }, 60000)).trim();
    if (!gitOut.includes(manifest.desktop.git.version)) throw new Error(`bundled git --version printed ${gitOut}`);
    const pyOut = (await runOwned(join(paths.runtime, "python", "python.exe"), ["--version"], { windowsHide: true }, 60000)).trim();
    if (pyOut !== `Python ${manifest.desktop.python.version}`) throw new Error(`bundled python --version printed ${pyOut}`);
    const pipxOut = (await runOwned(process.env.ComSpec || "cmd.exe", ["/d", "/c", join(paths.runtime, "python", "Scripts", "pipx.cmd"), "--version"], { windowsHide: true }, 60000)).trim();
    if (!/^\d+\.\d+/.test(pipxOut)) throw new Error(`bundled pipx.cmd --version printed ${pipxOut || "nothing"}`);
    const azOut = await runOwned(process.env.ComSpec || "cmd.exe", ["/d", "/c", join(paths.runtime, "az", "bin", "az.cmd"), "version", "--output", "json"], { windowsHide: true }, 180000);
    if (!azOut.includes(`"${manifest.desktop.azure_cli.version}"`)) throw new Error(`bundled az version printed ${azOut.trim().slice(-300)}`);
    if (existsSync(join(paths.runtime, "az", "Scripts", "fab.exe"))) throw new Error("the bundled Azure CLI still carries Scripts\\fab.exe (Python Fabric)");
    const wheels = readdirSync(join(paths.runtime, "python-wheels"));
    for (const [name, pin] of Object.entries(manifest.python_tools || {})) {
      if (!hasWheel(wheels, name, pin)) throw new Error(`the bundled wheel folder has no ${name} ${pin}`);
    }
    for (const item of bundledDownloads(manifest).filter((i) => i.name)) {
      const file = join(paths.runtime, item.dir, item.name);
      if (!existsSync(file) || sha256(file) !== item.sha256) throw new Error(`the bundled ${item.name} is missing or not the manifest's ${item.key} ${item.version}`);
    }
    step("bundled Git, Python with pipx, the Azure CLI, the Python tool wheels and the ODBC installers", { note: `${gitOut}; ${pyOut}; pipx ${pipxOut}; az ${manifest.desktop.azure_cli.version}; ${wheels.length} wheel(s)` });

    // Every bundled file must fit Windows' 260-character path limit in a
    // teammate's profile: the runner's user name is short, so measure against
    // the per-user default C:\Users\<name>\AppData\Local\Programs\coop\resources\
    // with a 20-character name (the longest a Windows account name can be).
    const longest = longestPath(join(paths.installDir, "resources"));
    const worst = "C:\\Users\\".length + 20 + "\\AppData\\Local\\Programs\\coop\\resources\\".length + longest.length;
    if (worst >= 260) throw new Error(`the package's longest path is ${longest.length} characters under resources (${longest.path}): ${worst} with a 20-character user name, over Windows' limit`);
    step("bundled paths fit Windows' path limit", { note: `longest ${longest.length} chars under resources (${worst} with a 20-character user name): ${longest.path}`, longestPath: longest, worstCase: worst });

    // The coop snapshot runs on the bundled runtime: `coop version` resolves the
    // bundled pi.cmd (lib/common.ps1 puts the runtime first on PATH) even though
    // this runner has its own Node and no Pi.
    const versionOut = await runOwned(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.coopPs1, "version"], { windowsHide: true, cwd: paths.installDir }, 120000);
    const coopLine = versionOut.split(/\r?\n/).find((line) => /^coop \d/.test(line.trim())) || "";
    const piLine = versionOut.split(/\r?\n/).find((line) => /^pi\s/.test(line.trim())) || "";
    if (!coopLine.includes(`coop ${version}`) || !piLine.includes(manifest.pi.version)) throw new Error(`bundled coop version printed: ${versionOut.trim().slice(-300)}`);
    step("bundled coop.ps1 version runs the bundled Pi", { note: `${coopLine.trim()}; ${piLine.trim()}` });

    if (readFileSync(sentinelFile, "utf8") !== sentinel) throw new Error("install or doctor changed the profile's window data");
    if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} appeared: the window's data left the coop profile`);
    step("profile untouched by install and doctor");

    // What the package's first launch writes (scripts/install.ps1 in bundled
    // mode): the `coop` link and "coop (terminal)" shortcut pointing into the
    // package, which the uninstaller must remove, beside a terminal install's
    // own shortcut pointing elsewhere, which it must keep.
    mkdirSync(dirname(paths.launcherLink), { recursive: true });
    writeFileSync(paths.launcherLink, `@call "${join(paths.installDir, "resources", "coop", "bin", "coop.cmd")}" %*\r\n`, { flag: "wx" });
    await writeTerminalShortcut(paths.terminalShortcut, join(paths.installDir, "resources", "coop", "bin", "coop-desktop.ps1"));
    const foreignLauncher = join(process.env.USERPROFILE, "coop-agent-elsewhere", "bin", "coop-desktop.ps1");
    await writeTerminalShortcut(paths.startMenuTerminalShortcut, foreignLauncher);
    step("first-launch link and shortcuts written for the uninstall check");

    const uninstall = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true });
    const uninstallStarted = Date.now();
    await runOwned(uninstall.command, uninstall.args, uninstall.options, UNINSTALL_TIMEOUT_MS);
    installed = false;
    const uninstallSeconds = Math.round((Date.now() - uninstallStarted) / 1000);
    // The uninstaller removes itself last; give the file system a moment.
    for (let waited = 0; existsSync(paths.uninstaller) && waited < 30; waited++) await new Promise((done) => setTimeout(done, 1000));
    if (existsSync(paths.exe) || existsSync(join(paths.installDir, "resources")) || existsSync(paths.runtime)) throw new Error("uninstall left the package installed");
    if ((await registryEntries()).length) throw new Error(`uninstall left ${PRODUCT} in Add/Remove Programs`);
    for (const file of [paths.startMenuShortcut, paths.desktopShortcut]) {
      if (existsSync(file)) throw new Error(`uninstall left a shortcut: ${file}`);
    }
    if (readFileSync(sentinelFile, "utf8") !== sentinel) throw new Error("uninstall removed or changed the profile's window data");
    if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} appeared during uninstall`);
    for (const file of [paths.launcherLink, paths.terminalShortcut]) {
      if (existsSync(file)) throw new Error(`uninstall left the package's ${file}`);
    }
    if (!existsSync(paths.startMenuTerminalShortcut)) throw new Error("uninstall removed a terminal install's own \"coop (terminal)\" shortcut");
    rmSync(paths.startMenuTerminalShortcut, { force: true });
    step("silent uninstall leaves no package, entry, shortcut, link or first-launch shortcut; profile data and a foreign shortcut kept", { note: `${uninstallSeconds}s`, seconds: uninstallSeconds });
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    for (const file of [paths.launcherLink, paths.terminalShortcut, paths.startMenuTerminalShortcut]) rmSync(file, { force: true });
    if (installed && existsSync(paths.uninstaller)) {
      try {
        const uninstall = nsisInvocation(paths.uninstaller, paths.installDir, { uninstall: true });
        await runOwned(uninstall.command, uninstall.args, uninstall.options, UNINSTALL_TIMEOUT_MS);
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
