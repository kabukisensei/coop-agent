// The packaged window (master plan D1c): the same desktop/ code, installed by
// the unsigned per-user installer under %LOCALAPPDATA%\Programs\coop. The
// package still needs the terminal coop: started from its shortcut it has no
// launch spec, so it finds the terminal's `coop` launcher the way
// bin/coop-desktop.ps1 does and runs `coop desktop --app <this exe>` in a
// console. coop.ps1 then does everything it does for the runtime-tree window
// (launch checks, the Warehouse token, the spec) and starts this exe again
// with the spec in its environment; that second process hands the spec to the
// first through Electron's single-instance lock, and the window opens.
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";

/** Where the terminal's `coop install` puts its launcher (scripts/install.ps1, step 6). */
export function launcherPath(env = process.env) {
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "coop", "bin", "coop.cmd") : "";
}

/**
 * The terminal coop's launcher: `coop.cmd` on PATH, then the install's own
 * %LOCALAPPDATA%\coop\bin\coop.cmd (the order bin/coop-desktop.ps1 uses once
 * there is no sibling checkout). "" when coop is not installed.
 */
export function findCoop(env = process.env, exists = existsSync) {
  const candidates = [];
  const path = env.PATH || env.Path || "";
  for (const dir of path.split(";")) {
    const clean = dir.trim().replace(/^"|"$/g, "");
    if (clean && !/[\0\r\n]/.test(clean)) candidates.push(join(clean, "coop.cmd"));
  }
  const launcher = launcherPath(env);
  if (launcher) candidates.push(launcher);
  return candidates.find((candidate) => exists(candidate)) || "";
}

// Fixed text: paths travel in environment variables, never in a command line.
// The console shows coop's launch checks (as the "coop (window)" shortcut does)
// and stays open on a failure so the message can be read.
const SCRIPT = [
  "Set-Location -LiteralPath $env:COOP_BOOT_CWD",
  "& $env:COOP_BOOT_COOP desktop --app $env:COOP_BOOT_APP",
  "$code = $LASTEXITCODE",
  "if ($code) { Read-Host 'Press Enter to close' }",
  "exit $code",
].join("; ");

function checkPath(name, value) {
  if (typeof value !== "string" || !win32.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${name} is not an absolute path`);
}

/**
 * The console process that asks the terminal coop to open this package's
 * window on a folder. Windows only; the caller spawns it and waits for its
 * exit (a new console appears because the packaged app has none).
 */
export function bootstrapProcess({ coop, app, cwd, env = process.env, systemRoot = env.SystemRoot }) {
  checkPath("coop", coop);
  checkPath("app", app);
  checkPath("cwd", cwd);
  checkPath("SystemRoot", systemRoot);
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")],
    options: { cwd, env: { ...env, COOP_BOOT_COOP: coop, COOP_BOOT_APP: app, COOP_BOOT_CWD: cwd }, windowsHide: false, shell: false, stdio: "ignore" },
  };
}

/**
 * Where the package keeps the files its child processes read: electron-builder
 * leaves `asarUnpack` entries beside the asar, and plain node (which reads the
 * PDF text) cannot open an asar. "" entries mean the package lacks them.
 */
export function packagedPaths(resourcesPath, exists = existsSync) {
  const unpacked = join(resourcesPath, "app.asar.unpacked");
  const pdfjs = join(unpacked, "node_modules", "pdfjs-dist");
  const pdfScript = join(unpacked, "desktop", "scripts", "pdf-text.mjs");
  return {
    pdfjsDir: exists(join(pdfjs, "package.json")) ? pdfjs : "",
    pdfScript: exists(pdfScript) ? pdfScript : "",
  };
}

/** The folder named on the command line (`coop.exe <folder>`), else "". */
export function folderArgument(argv, exists = existsSync) {
  const rest = argv.filter((arg) => typeof arg === "string" && !arg.startsWith("--"));
  const folder = rest[rest.length - 1];
  return folder && win32.isAbsolute(folder) && !/[\0\r\n]/.test(folder) && exists(folder) ? folder : "";
}

/**
 * What `coop.exe --doctor` prints: one JSON line a script can read (the CI
 * job installs the package, runs this and uninstalls). Nothing is started.
 */
export function doctorReport({ version, packaged, execPath, env = process.env, resourcesPath = "" }) {
  const paths = packaged && resourcesPath ? packagedPaths(resourcesPath) : { pdfjsDir: "", pdfScript: "" };
  return {
    product: "coop window",
    version,
    packaged,
    exe: execPath,
    coop: findCoop(env),
    pdfjs: Boolean(paths.pdfjsDir),
    pdfScript: Boolean(paths.pdfScript),
  };
}
