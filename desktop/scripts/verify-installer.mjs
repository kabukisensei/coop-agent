#!/usr/bin/env node
// Installer acceptance for the coop window package (master plan D1c, D1d, F3):
// install the built NSIS installer silently for every account (/S /allusers,
// the runner is an administrator), check the Add/Remove entry (HKLM), the
// all-users shortcuts, the machine-wide pieces scripts/machine-install.ps1
// wrote (the `coop` command for every account on the machine PATH, the
// machine marker, the "coop update" scheduled task) and that the shim runs
// the bundled coop, run scripts/auto-update.ps1 as a dry run and read its
// state, run `coop.exe --doctor`, check the bundled runtime (the pinned Node
// answers, Pi and every extension are at their pins, the lock is the shipped
// one) and the coop snapshot (its `coop version` runs the bundled Pi),
// uninstall silently and check nothing of the package, the shim, the PATH
// entry or the task is left while the profile is untouched.
//
// It MUTATES the machine it runs on (an install, registry entries, the machine
// PATH, a scheduled task, shortcuts), so it runs only on a disposable
// GitHub-hosted Windows runner that opted in with COOP_INSTALLER_TEST=1
// (salvaged from the September branch's assertDisposableInstallerHost);
// anywhere else it refuses. The CI job `installer (Windows)` runs it after
// desktop/scripts/build-installer.mjs.
//
//   node desktop/scripts/verify-installer.mjs [--dist <dir>] [--output <report.json>]
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_SHIMS_DROPPED, bundledDownloads, hasWheel, longestPath } from "./build-installer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// F3: the Add/Remove entry is plain "coop" (electron-builder nsis.uninstallDisplayName);
// releases before it were "coop (window)".
const PRODUCT = "coop";
// D1m: the package's own shortcut is plain "coop" (electron-builder nsis.shortcutName);
// a per-user first launch used to add "coop (terminal)" beside it.
const SHORTCUT = "coop";
// F3: the scheduled task scripts/machine-install.ps1 registers.
export const UPDATE_TASK = "coop update";

export function assertDisposableInstallerHost(env = process.env, platform = process.platform) {
  if (platform !== "win32") throw new Error("installer acceptance runs on Windows only");
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || env.COOP_INSTALLER_TEST !== "1") {
    throw new Error("installer acceptance installs and uninstalls a package: it runs only on a GitHub-hosted runner with COOP_INSTALLER_TEST=1");
  }
}

/**
 * NSIS: `/S`, the install mode (`/allusers`, the package's own since F3, or
 * `/currentuser` for a release before it), then `/D=` (install) or `_?=`
 * (uninstall) last and unquoted, as NSIS requires.
 */
export function nsisInvocation(executable, directory, { uninstall = false, mode = "allusers" } = {}) {
  for (const path of [executable, directory]) {
    if (typeof path !== "string" || !win32.isAbsolute(path) || /["\0-\x1f]/.test(path)) throw new Error(`NSIS path is invalid: ${path}`);
  }
  if (mode !== "allusers" && mode !== "currentuser") throw new Error(`NSIS install mode is invalid: ${mode}`);
  return {
    command: executable,
    args: ["/S", `/${mode}`, `${uninstall ? "_?=" : "/D="}${directory}`],
    options: { shell: false, windowsVerbatimArguments: true, windowsHide: true },
  };
}

function pick(env, name) {
  return env[name] || env[name.toUpperCase()] || "";
}

/**
 * The places the package touches: electron-builder's per-machine NSIS layout
 * (F3: %ProgramFiles%\coop, all-users shortcuts, HKLM) plus the machine-wide
 * pieces scripts/machine-install.ps1 adds; mode "user" gives the per-user
 * layout of the releases before F3 (%LOCALAPPDATA%\Programs\coop, this
 * account's shortcuts), which the upgrade acceptance installs first. The
 * per-account files (the `coop` link and the shortcuts a terminal install or
 * an older package's first launch wrote) are the same in both modes.
 */
export function packagePaths(env = process.env, mode = "machine") {
  const machine = mode === "machine";
  const programFiles = pick(env, "ProgramW6432") || pick(env, "ProgramFiles");
  const programData = pick(env, "ProgramData");
  const publicDir = pick(env, "Public") || join(pick(env, "SystemDrive") || "C:", "Users", "Public");
  const installDir = machine ? join(programFiles, "coop") : join(env.LOCALAPPDATA, "Programs", "coop");
  const programs = machine ? join(programData, "Microsoft", "Windows", "Start Menu", "Programs") : join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
  const desktop = machine ? join(publicDir, "Desktop") : join(env.USERPROFILE, "Desktop");
  const runtime = join(installDir, "resources", "runtime");
  const machineDir = join(programData, "coop");
  return {
    mode,
    installDir,
    exe: join(installDir, "coop.exe"),
    // What a terminal install, or an older package's first launch, writes for
    // this account (scripts/install.ps1); the uninstaller removes the package's
    // own when they point into installDir. The package's own "coop" shortcut
    // is the exe's; a per-user launch added "coop (terminal)".
    launcherLink: join(env.LOCALAPPDATA, "coop", "bin", "coop.cmd"),
    terminalShortcut: join(env.USERPROFILE, "Desktop", "coop (terminal).lnk"),
    startMenuTerminalShortcut: join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "coop (terminal).lnk"),
    userDesktopShortcut: join(env.USERPROFILE, "Desktop", `${SHORTCUT}.lnk`),
    userStartMenuShortcut: join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", `${SHORTCUT}.lnk`),
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
    coopCmd: join(installDir, "resources", "coop", "bin", "coop.cmd"),
    startMenuShortcut: join(programs, `${SHORTCUT}.lnk`),
    desktopShortcut: join(desktop, `${SHORTCUT}.lnk`),
    // F3: the machine-wide pieces (scripts/machine-install.ps1).
    machineBin: join(installDir, "bin"),
    machineShim: join(installDir, "bin", "coop.cmd"),
    machineMarker: join(runtime, "machine-install.json"),
    autoUpdate: join(installDir, "resources", "coop", "scripts", "auto-update.ps1"),
    machineDir,
    updateState: join(machineDir, "update-state.json"),
    // What a dry run writes instead (never the live state, which every launch reads).
    dryRunState: join(machineDir, "update-state.dry-run.json"),
    updateLog: join(machineDir, "logs", "update.log"),
    // Electron's default appData folder for the product; the window keeps its
    // data under the coop profile instead, so this must never appear.
    electronAppData: join(env.APPDATA, "coop"),
    profileData: join(env.USERPROFILE, ".coop", "desktop", "data"),
  };
}

// The package carries the bundled runtime (D1d: Node, Pi, the extension tree,
// the repository snapshot), so NSIS unpacks tens of thousands of files; a
// GitHub-hosted runner needs well over three minutes for that.
export const INSTALL_TIMEOUT_MS = 900000;
export const UNINSTALL_TIMEOUT_MS = 600000;

export function runOwned(command, args, options = {}, timeoutMs = 180000) {
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

function powershellExe() {
  return win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Run Windows PowerShell 5.1 with a command; values travel in the environment. */
export async function ps(command, env = {}, timeoutMs = 60000) {
  return (await runOwned(powershellExe(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true, env: { ...process.env, ...env } }, timeoutMs)).trim();
}

const REGISTRY = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$paths = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$items = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'coop' -or $_.DisplayName -like 'coop (window)*' } | Select-Object DisplayName, DisplayVersion, UninstallString, InstallLocation, @{ Name = 'Hive'; Expression = { if ($_.PSPath -like '*HKEY_CURRENT_USER*') { 'HKCU' } else { 'HKLM' } } })
ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
`;

/** The package's Add/Remove entries, with the hive each one lives in. */
export async function registryEntries() {
  const out = await ps(REGISTRY);
  const parsed = JSON.parse(out.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The raw machine PATH (HKLM, %VAR% tokens unexpanded). */
export async function machinePath() {
  return ps("[Console]::Out.Write([string](Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment').Path)");
}
export function pathHasEntry(pathValue, entry) {
  const needle = entry.replace(/[\\/]+$/, "").toLowerCase();
  return pathValue.split(";").some((e) => e.trim().replace(/[\\/]+$/, "").toLowerCase() === needle);
}

/** The scheduled task's XML (schtasks /Query /XML), or "" when it is not registered. */
export async function scheduledTaskXml(name = UPDATE_TASK) {
  try {
    return await runOwned("schtasks.exe", ["/Query", "/TN", name, "/XML"], { windowsHide: true }, 60000);
  } catch { return ""; }
}

/** Write a "coop (terminal)" shortcut the way scripts/install.ps1 does (powershell.exe -File <launcher>). */
export async function writeTerminalShortcut(file, launcher) {
  const powershell = powershellExe();
  const script = `$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut($env:COOP_LNK); $sc.TargetPath = '${powershell.replace(/'/g, "''")}'; $sc.Arguments = ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $env:COOP_LAUNCHER + '"'); $sc.Save()`;
  await ps(script, { COOP_LNK: file, COOP_LAUNCHER: launcher });
  if (!existsSync(file)) throw new Error(`could not write ${file}`);
}

export function sha256(file) {
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
  const powershell = powershellExe();
  const paths = packagePaths();
  const userPaths = packagePaths(process.env, "user");
  const report = { ok: false, installer: installers[0], installerSha256: sha256(installer), version, steps: [] };
  const step = (name, detail) => { report.steps.push({ name, ...detail }); console.log(`  ✓ ${name}${detail && detail.note ? `: ${detail.note}` : ""}`); };

  if ((await registryEntries()).length) throw new Error(`${PRODUCT} is already registered on this runner`);
  for (const dir of [paths.installDir, userPaths.installDir, paths.electronAppData]) {
    if (existsSync(dir)) throw new Error(`${dir} already exists on this runner`);
  }
  for (const file of [paths.launcherLink, paths.terminalShortcut, paths.startMenuTerminalShortcut, paths.updateState, paths.dryRunState]) {
    if (existsSync(file)) throw new Error(`${file} already exists on this runner`);
  }
  if (pathHasEntry(await machinePath(), paths.machineBin)) throw new Error(`${paths.machineBin} is already on this runner's machine PATH`);
  if (await scheduledTaskXml()) throw new Error(`the scheduled task "${UPDATE_TASK}" already exists on this runner`);
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
    if (existsSync(userPaths.installDir)) throw new Error(`a per-machine install also wrote ${userPaths.installDir}`);
    step("silent per-machine install (/S /allusers)", { note: `${paths.installDir} (${installSeconds}s)`, seconds: installSeconds });

    const entries = await registryEntries();
    if (entries.length !== 1) throw new Error(`expected one Add/Remove entry for ${PRODUCT}, found ${entries.length}: ${JSON.stringify(entries)}`);
    const entry = entries[0];
    if (entry.Hive !== "HKLM") throw new Error(`the Add/Remove entry is in ${entry.Hive}, not HKLM (this machine)`);
    if (entry.DisplayName !== PRODUCT) throw new Error(`the Add/Remove entry is "${entry.DisplayName}", not "${PRODUCT}"`);
    if (entry.DisplayVersion !== version) throw new Error(`Add/Remove shows version ${entry.DisplayVersion}, built ${version}`);
    if (!String(entry.UninstallString || "").toLowerCase().includes(paths.uninstaller.toLowerCase())) throw new Error(`Add/Remove uninstall string is ${entry.UninstallString}`);
    step("Add/Remove Programs entry (HKLM, this machine)", { note: `${entry.DisplayName} ${entry.DisplayVersion}` });

    for (const [name, file] of [["all-users Start Menu", paths.startMenuShortcut], ["Public Desktop", paths.desktopShortcut]]) {
      if (!existsSync(file)) throw new Error(`${name} shortcut missing: ${file}`);
    }
    for (const file of [paths.userDesktopShortcut, paths.userStartMenuShortcut]) {
      if (existsSync(file)) throw new Error(`a per-machine install wrote this account's shortcut: ${file}`);
    }
    step("Start Menu and Desktop shortcuts for every account", { note: SHORTCUT });

    // F3: the machine-wide pieces scripts/machine-install.ps1 wrote from the installer.
    if (!existsSync(paths.machineShim)) throw new Error(`no machine shim: ${paths.machineShim}`);
    const shim = readFileSync(paths.machineShim, "utf8");
    if (!shim.includes("%LOCALAPPDATA%\\coop\\bin\\coop.cmd") || !shim.toLowerCase().includes(paths.coopCmd.toLowerCase())) throw new Error(`the machine shim does not prefer this account's link and fall back to the package: ${shim}`);
    if (!existsSync(paths.machineMarker)) throw new Error(`no machine marker: ${paths.machineMarker}`);
    const marker = JSON.parse(readFileSync(paths.machineMarker, "utf8"));
    if (marker.schema_version !== 1 || marker.version !== version || String(marker.install_dir || "").toLowerCase() !== paths.installDir.toLowerCase()) throw new Error(`the machine marker is wrong: ${JSON.stringify(marker)}`);
    const machinePathAfter = await machinePath();
    if (!pathHasEntry(machinePathAfter, paths.machineBin)) throw new Error(`${paths.machineBin} is not on the machine PATH: ${machinePathAfter}`);
    step("the coop command for every account: the machine shim, the marker, the machine PATH entry", { note: paths.machineShim });

    const taskXml = await scheduledTaskXml();
    if (!taskXml) throw new Error(`the scheduled task "${UPDATE_TASK}" is not registered`);
    if (!taskXml.includes("S-1-5-18") || !taskXml.toLowerCase().includes(paths.autoUpdate.toLowerCase())) throw new Error(`the scheduled task does not run ${paths.autoUpdate} as SYSTEM: ${taskXml.slice(-600)}`);
    for (const needle of ["<LogonTrigger>", "<CalendarTrigger>", "<Interval>PT1H</Interval>", "<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>", "<StartWhenAvailable>true</StartWhenAvailable>"]) {
      if (!taskXml.includes(needle)) throw new Error(`the scheduled task lacks ${needle}`);
    }
    step(`scheduled task "${UPDATE_TASK}" (SYSTEM; daily 03:00 hourly, at logon)`, { note: paths.autoUpdate });

    // The shim is what `coop` resolves to in a new terminal: through cmd.exe it runs the bundled coop.
    const shimOut = await runOwned(process.env.ComSpec || "cmd.exe", ["/d", "/c", `"${paths.machineShim}" version`], { windowsHide: true, windowsVerbatimArguments: true, cwd: paths.machineDir }, 180000);
    const shimLine = shimOut.split(/\r?\n/).find((line) => /^coop \d/.test(line.trim())) || "";
    if (!shimLine.includes(`coop ${version}`)) throw new Error(`the machine shim's \`coop version\` printed: ${shimOut.trim().slice(-300)}`);
    step("the machine shim runs the bundled coop", { note: shimLine.trim() });

    // The update task's script, as a dry run: it checks github.com, installs
    // nothing and records the state every account's launch reads.
    const dryOut = await runOwned(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.autoUpdate, "-DryRun"], { windowsHide: true, cwd: paths.machineDir }, 180000);
    if (!existsSync(paths.dryRunState)) throw new Error(`auto-update.ps1 -DryRun wrote no ${paths.dryRunState}: ${dryOut.trim().slice(-300)}`);
    if (existsSync(paths.updateState)) throw new Error(`auto-update.ps1 -DryRun wrote the live ${paths.updateState} (every launch would announce its result)`);
    const state = JSON.parse(readFileSync(paths.dryRunState, "utf8"));
    if (state.schema_version !== 1 || state.installed_version !== version || !state.last_run) throw new Error(`the update state is wrong: ${JSON.stringify(state)}`);
    if (!/^(up to date|dry run: would install v\d|waiting: coop is open)/.test(String(state.last_result))) throw new Error(`auto-update.ps1 -DryRun recorded: ${state.last_result}`);
    if (!existsSync(paths.updateLog)) throw new Error(`auto-update.ps1 wrote no ${paths.updateLog}`);
    step("auto-update.ps1 dry run records its own state file (not the live one) and the log", { note: `${state.last_result} (newest ${state.latest_version})`, updateState: state });

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
    for (const shimFile of NODE_SHIMS_DROPPED) {
      if (existsSync(join(paths.nodeDir, shimFile))) throw new Error(`the bundled Node still carries ${shimFile}`);
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

    // Every bundled file must fit Windows' 260-character path limit. The
    // machine install's C:\Program Files\coop\resources\ is short; measure
    // against the longer per-user default an older release used, with a
    // 20-character name (the longest a Windows account name can be), so a
    // release never grows a path a per-user install could not hold either.
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

    // The snapshot knows it is this machine's install (lib/common.ps1), so a
    // first launch links nothing for the account and doctor says so.
    const kindOut = await ps(". (Join-Path $env:COOP_CALL_ROOT 'lib\\common.ps1'); [Console]::Out.Write((Get-CoopInstallKind) + '|' + [string](Test-CoopMachineInstall) + '|' + (Get-CoopInstallDoctorRow).Message)", { COOP_CALL_ROOT: join(paths.installDir, "resources", "coop") }, 120000);
    if (!kindOut.startsWith("machine|True|install: this machine (")) throw new Error(`the snapshot does not see the machine install: ${kindOut}`);
    step("the bundled coop knows it is this machine's install", { note: kindOut.split("|").pop() });

    if (readFileSync(sentinelFile, "utf8") !== sentinel) throw new Error("install or doctor changed the profile's window data");
    if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} appeared: the window's data left the coop profile`);
    step("profile untouched by install, doctor and the update dry run");

    // What an older package's first launch wrote for this account (scripts/install.ps1
    // in bundled mode): a `coop` link and "coop (terminal)" shortcut pointing into
    // the package, which the uninstaller must remove, beside a terminal install's
    // own shortcut pointing elsewhere, which it must keep.
    mkdirSync(dirname(paths.launcherLink), { recursive: true });
    writeFileSync(paths.launcherLink, `@call "${paths.coopCmd}" %*\r\n`, { flag: "wx" });
    await writeTerminalShortcut(paths.terminalShortcut, join(paths.installDir, "resources", "coop", "bin", "coop-desktop.ps1"));
    const foreignLauncher = join(process.env.USERPROFILE, "coop-agent-elsewhere", "bin", "coop-desktop.ps1");
    await writeTerminalShortcut(paths.startMenuTerminalShortcut, foreignLauncher);
    step("an account's link and shortcuts written for the uninstall check");

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
    if (existsSync(paths.machineShim)) throw new Error(`uninstall left the machine shim: ${paths.machineShim}`);
    const machinePathGone = await machinePath();
    if (pathHasEntry(machinePathGone, paths.machineBin)) throw new Error(`uninstall left ${paths.machineBin} on the machine PATH`);
    if (await scheduledTaskXml()) throw new Error(`uninstall left the scheduled task "${UPDATE_TASK}"`);
    if (readFileSync(sentinelFile, "utf8") !== sentinel) throw new Error("uninstall removed or changed the profile's window data");
    if (existsSync(paths.electronAppData)) throw new Error(`${paths.electronAppData} appeared during uninstall`);
    for (const file of [paths.launcherLink, paths.terminalShortcut]) {
      if (existsSync(file)) throw new Error(`uninstall left the package's ${file}`);
    }
    if (!existsSync(paths.startMenuTerminalShortcut)) throw new Error("uninstall removed a terminal install's own \"coop (terminal)\" shortcut");
    rmSync(paths.startMenuTerminalShortcut, { force: true });
    step("silent uninstall leaves no package, entry, shortcut, shim, PATH entry, task, link or first-launch shortcut; profile data and a foreign shortcut kept", { note: `${uninstallSeconds}s`, seconds: uninstallSeconds });
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
    rmSync(paths.updateState, { force: true });
    rmSync(paths.dryRunState, { force: true });
    if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify({ ok: report.ok, installer: report.installer, sha256: report.installerSha256, version }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
}
