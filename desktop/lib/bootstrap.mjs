// The packaged window (master plan D1c, D1d): the same desktop/ code, installed
// by the unsigned per-user installer under %LOCALAPPDATA%\Programs\coop, with
// coop itself inside: resources\coop is a snapshot of the repository and
// resources\runtime holds the pinned Node, Pi and extension tree (D1d), so the
// package needs no terminal install. Started from its shortcut it has no
// launch spec, so it runs the bundled `bin\coop.ps1 desktop --app <this exe>`
// in a console (a terminal coop on PATH or in %LOCALAPPDATA% only when the
// package carries none). coop.ps1 then does everything it does for the
// runtime-tree window (on the first launch the install itself, then the
// launch checks, the Warehouse token, the spec) and starts this exe again with
// the spec in its environment; that second process hands the spec to the
// first through Electron's single-instance lock, and the window opens.
import { existsSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";

/** Where the terminal's `coop install` puts its launcher (scripts/install.ps1, step 6). */
export function launcherPath(env = process.env) {
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "coop", "bin", "coop.cmd") : "";
}

/** The package's own coop (D1d): resources\coop\bin\coop.ps1, or "" when it carries none. */
export function bundledCoop(resourcesPath, exists = existsSync) {
  if (!resourcesPath) return "";
  const coop = join(resourcesPath, "coop", "bin", "coop.ps1");
  return exists(coop) ? coop : "";
}

/**
 * The coop to ask for a window: the package's own snapshot first (D1d), then
 * the terminal coop's launcher, `coop.cmd` on PATH, then the install's own
 * %LOCALAPPDATA%\coop\bin\coop.cmd (the order bin/coop-desktop.ps1 uses once
 * there is no sibling checkout). "" when there is no coop at all.
 */
export function findCoop(env = process.env, exists = existsSync, resourcesPath = "") {
  const bundled = bundledCoop(resourcesPath, exists);
  if (bundled) return bundled;
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

/**
 * What resources\runtime carries (D1d), from its coop-runtime.json: the Node
 * and Pi versions and whether the extension tree is there. null when the
 * package has no runtime (a D1c-era package) or the marker is unreadable.
 */
export function packagedRuntime(resourcesPath, { exists = existsSync, read = (file) => readFileSync(file, "utf8") } = {}) {
  if (!resourcesPath) return null;
  const dir = join(resourcesPath, "runtime");
  const marker = join(dir, "coop-runtime.json");
  if (!exists(marker)) return null;
  let info;
  try { info = JSON.parse(read(marker)); } catch { return null; }
  if (!info || info.schema !== 1 || !info.node || !info.npm) return null;
  const nodeExe = join(dir, String(info.node.dir || "node"), "node.exe");
  const prefix = join(dir, String(info.npm.prefix || "npm"));
  const extensions = info.extensions ? join(dir, String(info.extensions.dir || "extensions"), "node_modules") : "";
  return {
    node: exists(nodeExe) ? String(info.node.version || "") : "",
    pi: exists(join(prefix, "pi.cmd")) ? String(info.pi || "") : "",
    extensions: Boolean(extensions && exists(extensions)),
    coop: String(info.coop || ""),
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
  const resources = packaged ? resourcesPath : "";
  return {
    product: "coop window",
    version,
    packaged,
    exe: execPath,
    coop: findCoop(env, existsSync, resources),
    pdfjs: Boolean(paths.pdfjsDir),
    pdfScript: Boolean(paths.pdfScript),
    // D1d: the bundled runtime, or null for a package without one.
    runtime: packagedRuntime(resources),
  };
}
