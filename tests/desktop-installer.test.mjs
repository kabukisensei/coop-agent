/**
 * The coop window package (master plan D1c): the installed package's bootstrap
 * (finding the terminal coop, the console that asks it for a window, the
 * --doctor report, the unpacked paths), the electron-builder configuration
 * against the plan's NSIS and fuse decisions, the staged app (every file the
 * window imports, the version, pdf.js as the one dependency) and the
 * acceptance script's NSIS invocation and host guard.
 *
 * Gate lane: no Electron, no electron-builder, no npm, no network. The stage
 * is written without `npm ci` (install: false) into a temp folder.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapProcess, doctorReport, findCoop, folderArgument, launcherPath, packagedPaths } from "../desktop/lib/bootstrap.mjs";
import { consoleProcess } from "../desktop/lib/terminal.mjs";
import { loadSettings, saveSettings } from "../desktop/lib/settings.mjs";
import { readVersion, shippedPackage, stage, stageEntries, stagePackage } from "../desktop/scripts/build-installer.mjs";
import { assertDisposableInstallerHost, nsisInvocation, packagePaths } from "../desktop/scripts/verify-installer.mjs";
import { verifiedInstaller } from "../desktop/scripts/check-installer-report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${String(error && error.stack || error).split("\n").slice(0, 6).join("\n    ")}`);
    failed += 1;
  }
}

const temp = mkdtempSync(join(tmpdir(), "coop-installer-test-"));
const decode = (encoded) => Buffer.from(encoded, "base64").toString("utf16le");

// --- bootstrap ------------------------------------------------------------------
await check("findCoop: coop.cmd on PATH wins, then the install's launcher, else empty", () => {
  const env = { PATH: "C:\\tools;\"C:\\Program Files\\x\";C:\\Users\\me\\AppData\\Local\\coop\\bin", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", SystemRoot: "C:\\Windows" };
  const launcher = join("C:\\Users\\me\\AppData\\Local", "coop", "bin", "coop.cmd");
  assert.equal(launcherPath(env), launcher);
  assert.equal(findCoop(env, (p) => p === join("C:\\tools", "coop.cmd")), join("C:\\tools", "coop.cmd"));
  assert.equal(findCoop(env, (p) => p === launcher), launcher);
  assert.equal(findCoop(env, () => false), "");
  assert.equal(findCoop({}, () => true), "");
});

await check("bootstrapProcess: a console running `coop desktop --app <exe>`, paths only in the environment", () => {
  const proc = bootstrapProcess({ coop: "C:\\Users\\me\\AppData\\Local\\coop\\bin\\coop.cmd", app: "C:\\Users\\me\\AppData\\Local\\Programs\\coop\\coop.exe", cwd: "C:\\work\\repo", env: { X: "1" }, systemRoot: "C:\\Windows" });
  assert.equal(proc.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(proc.options.windowsHide, false);
  assert.equal(proc.options.stdio, "ignore");
  assert.equal(proc.options.cwd, "C:\\work\\repo");
  assert.equal(proc.options.env.COOP_BOOT_COOP, "C:\\Users\\me\\AppData\\Local\\coop\\bin\\coop.cmd");
  assert.equal(proc.options.env.COOP_BOOT_APP, "C:\\Users\\me\\AppData\\Local\\Programs\\coop\\coop.exe");
  assert.equal(proc.options.env.X, "1");
  const script = decode(proc.args[proc.args.length - 1]);
  assert.match(script, /desktop --app \$env:COOP_BOOT_APP/);
  assert.match(script, /Read-Host/);
  assert.doesNotMatch(script, /coop\.exe|C:\\/);
  assert.throws(() => bootstrapProcess({ coop: "coop", app: "C:\\a.exe", cwd: "C:\\w", systemRoot: "C:\\Windows" }), /coop is not an absolute path/);
  assert.throws(() => bootstrapProcess({ coop: "C:\\c.cmd", app: "C:\\a.exe", cwd: "C:\\w\n", systemRoot: "C:\\Windows" }), /cwd/);
});

await check("Open folder from the package passes the exe through COOP_TERMINAL_APP", () => {
  const packaged = consoleProcess({ mode: "window", coop: "C:\\coop\\bin\\coop.ps1", cwd: "C:\\w", app: "C:\\p\\coop.exe", env: {}, systemRoot: "C:\\Windows" });
  assert.equal(packaged.options.env.COOP_TERMINAL_APP, "C:\\p\\coop.exe");
  const inner = decode(packaged.args[packaged.args.length - 1]);
  const script = decode(inner.match(/'-EncodedCommand','([^']+)'/)[1]);
  assert.match(script, /if \(\$env:COOP_TERMINAL_APP\) \{ & \$env:COOP_TERMINAL_COOP desktop --app \$env:COOP_TERMINAL_APP \} else \{ & \$env:COOP_TERMINAL_COOP desktop \}/);
  const runtime = consoleProcess({ mode: "window", coop: "C:\\coop\\bin\\coop.ps1", cwd: "C:\\w", env: {}, systemRoot: "C:\\Windows" });
  assert.equal(runtime.options.env.COOP_TERMINAL_APP, "");
  assert.throws(() => consoleProcess({ mode: "window", coop: "C:\\coop\\bin\\coop.ps1", cwd: "C:\\w", app: "coop.exe", env: {}, systemRoot: "C:\\Windows" }), /app is not an absolute path/);
});

await check("packagedPaths: pdf.js and its script beside the asar, unpacked", () => {
  const resources = "C:\\Users\\me\\AppData\\Local\\Programs\\coop\\resources";
  const have = new Set([
    join(resources, "app.asar.unpacked", "node_modules", "pdfjs-dist", "package.json"),
    join(resources, "app.asar.unpacked", "desktop", "scripts", "pdf-text.mjs"),
  ]);
  const paths = packagedPaths(resources, (p) => have.has(p));
  assert.equal(paths.pdfjsDir, join(resources, "app.asar.unpacked", "node_modules", "pdfjs-dist"));
  assert.equal(paths.pdfScript, join(resources, "app.asar.unpacked", "desktop", "scripts", "pdf-text.mjs"));
  assert.deepEqual(packagedPaths(resources, () => false), { pdfjsDir: "", pdfScript: "" });
});

await check("folderArgument: the last plain absolute argument that exists", () => {
  assert.equal(folderArgument(["--doctor", "C:\\work"], (p) => p === "C:\\work"), "C:\\work");
  assert.equal(folderArgument(["C:\\work"], () => false), "");
  assert.equal(folderArgument(["work"], () => true), "");
  assert.equal(folderArgument([], () => true), "");
});

await check("doctorReport: one JSON-able line naming the package, coop and pdf.js", () => {
  const resources = "C:\\p\\resources";
  const report = doctorReport({ version: "0.29.0", packaged: true, execPath: "C:\\p\\coop.exe", env: { PATH: "", LOCALAPPDATA: "C:\\nowhere" }, resourcesPath: resources });
  assert.deepEqual(report, { product: "coop window", version: "0.29.0", packaged: true, exe: "C:\\p\\coop.exe", coop: "", pdfjs: false, pdfScript: false });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

await check("settings keep the last folder for the package's picker", () => {
  const file = join(temp, "settings.json");
  const saved = saveSettings(file, { theme: "retro-dark", lastFolder: "C:\\work\\repo" });
  assert.equal(saved.lastFolder, "C:\\work\\repo");
  assert.equal(loadSettings(file).lastFolder, "C:\\work\\repo");
  assert.equal(saveSettings(file, { lastFolder: "bad\nvalue" }).lastFolder, "");
  assert.equal(loadSettings(join(temp, "missing.json")).lastFolder, "");
});

// --- electron-builder configuration ------------------------------------------
const config = require("../desktop/installer/electron-builder.cjs");

await check("electron-builder: NSIS per-user, no elevation, data kept, shortcuts, unsigned (plan 11.2 and 11.5)", () => {
  assert.equal(config.appId, "com.cooptimize.coop");
  assert.equal(config.productName, "coop");
  assert.equal(config.electronVersion, MANIFEST.desktop.electron);
  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.nsis.createDesktopShortcut, true);
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.shortcutName, "coop (window)");
  assert.match(config.artifactName, /^coop-window-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/);
  assert.equal(config.nsis.artifactName, config.artifactName);
  for (const icon of [config.win.icon, config.nsis.installerIcon, config.nsis.uninstallerIcon]) {
    assert.equal(icon, join(ROOT, "themes", "coop.ico"));
    assert.ok(existsSync(icon));
  }
  assert.equal(config.win.signtoolOptions, null);
  assert.equal(config.asar, true);
  assert.deepEqual(config.asarUnpack, ["node_modules/pdfjs-dist/**", "desktop/scripts/pdf-text.mjs"]);
  assert.equal(config.directories.app, join(ROOT, "desktop", "installer", "stage"));
});

await check("electron-builder: the September fuse policy (run-as-node off, asar integrity on, asar only)", () => {
  assert.deepEqual(config.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  });
});

await check("desktop/installer pins electron-builder with a lockfile and no other dependency", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "desktop", "installer", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.devDependencies), ["electron-builder"]);
  assert.match(pkg.devDependencies["electron-builder"], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies, undefined);
  const lock = JSON.parse(readFileSync(join(ROOT, "desktop", "installer", "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/electron-builder"].version, pkg.devDependencies["electron-builder"]);
});

// --- the staged app -----------------------------------------------------------------
await check("stage: every module the window imports, the vibes, the splash and the icon ship", () => {
  const entries = stageEntries(ROOT);
  for (const entry of entries) assert.ok(existsSync(join(ROOT, entry)), `${entry} exists`);
  assert.ok(entries.includes("desktop/main.mjs") && entries.includes("desktop/preload.cjs") && entries.includes("desktop/lib/") && entries.includes("desktop/renderer/"));
  assert.ok(entries.includes("desktop/scripts/pdf-text.mjs"));
  assert.ok(entries.includes("vibes/") && entries.includes("themes/coop.ico") && entries.includes("extensions/coop-powerline/assets/splash.ansi"));
  // Every `../../lib/<x>.mjs` and `../lib/<x>.mjs` import under desktop/ is staged.
  const imports = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) { if (name !== "installer" && name !== "scripts") walk(file); continue; }
      if (!/\.(mjs|cjs)$/.test(name)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/from "(\.\.\/)+lib\/([^"]+)"/g)) imports.add(`lib/${match[2]}`);
    }
  };
  walk(join(ROOT, "desktop"));
  assert.ok(imports.size >= 3, `found ${imports.size} lib imports`);
  for (const file of imports) assert.ok(entries.includes(file), `${file} is staged`);
  // No test, fixture or installer tooling ships.
  assert.ok(!entries.some((entry) => /tests|installer|record-fixture|runtime-lock/.test(entry)));
});

await check("stage: package.json carries the window's version and pdf.js; Electron is dropped after npm ci", () => {
  const version = readVersion(ROOT);
  assert.match(version, /^\d+\.\d+\.\d+/);
  const staged = stagePackage({ version, manifest: MANIFEST });
  assert.equal(staged.version, version);
  assert.equal(staged.main, "desktop/main.mjs");
  assert.equal(staged.type, "module");
  assert.deepEqual(staged.dependencies, { electron: MANIFEST.desktop.electron, "pdfjs-dist": MANIFEST.desktop.pdfjs });
  const shipped = shippedPackage(staged);
  assert.deepEqual(shipped.dependencies, { "pdfjs-dist": MANIFEST.desktop.pdfjs });
  assert.equal(shipped.version, version);
});

await check("stage --no-install writes the files at their checkout paths with the shipped package.json", () => {
  const stageDir = join(temp, "stage");
  const result = stage({ root: ROOT, stageDir, install: false });
  assert.equal(result.stageDir, stageDir);
  for (const entry of stageEntries(ROOT)) assert.ok(existsSync(join(stageDir, entry)), `${entry} staged`);
  const pkg = JSON.parse(readFileSync(join(stageDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "coop-window");
  assert.deepEqual(pkg.dependencies, { "pdfjs-dist": MANIFEST.desktop.pdfjs });
  assert.ok(!existsSync(join(stageDir, "package-lock.json")));
  // Every relative import under the staged desktop/ and lib/ (modules and
  // JSON alike) resolves inside the stage: the asar has nothing else.
  const walk = (dir, files = []) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) { if (name !== "renderer") walk(file, files); } else if (/\.(mjs|cjs)$/.test(name)) files.push(file);
    }
    return files;
  };
  let imports = 0;
  for (const file of [...walk(join(stageDir, "desktop")), ...walk(join(stageDir, "lib"))]) {
    for (const match of readFileSync(file, "utf8").matchAll(/from "(\.\.?\/[^"]+)"/g)) {
      imports += 1;
      assert.ok(existsSync(join(dirname(file), match[1])), `${relative(stageDir, file)} imports ${match[1]}, which is staged`);
    }
  }
  assert.ok(imports > 20, `checked ${imports} imports`);
  const vibes = readdirSync(join(stageDir, "vibes"));
  assert.ok(vibes.length > 0);
  assert.equal(relative(stageDir, join(stageDir, "themes", "coop.ico")).split(sep).join("/"), "themes/coop.ico");
});

// --- the acceptance script -----------------------------------------------------
await check("verify-installer refuses every host but an opted-in GitHub-hosted Windows runner", () => {
  assert.throws(() => assertDisposableInstallerHost({}, "linux"), /Windows only/);
  assert.throws(() => assertDisposableInstallerHost({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }, "win32"), /COOP_INSTALLER_TEST=1/);
  assert.throws(() => assertDisposableInstallerHost({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted", COOP_INSTALLER_TEST: "1" }, "win32"), /GitHub-hosted/);
  assert.doesNotThrow(() => assertDisposableInstallerHost({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", COOP_INSTALLER_TEST: "1" }, "win32"));
});

await check("verify-installer: NSIS gets /S /currentuser then /D= or _?= last and unquoted", () => {
  const install = nsisInvocation("C:\\dist\\coop-window-0.29.0-win-x64.exe", "C:\\Users\\me\\AppData\\Local\\Programs\\coop");
  assert.deepEqual(install.args, ["/S", "/currentuser", "/D=C:\\Users\\me\\AppData\\Local\\Programs\\coop"]);
  assert.equal(install.options.windowsVerbatimArguments, true);
  const uninstall = nsisInvocation("C:\\Users\\me\\AppData\\Local\\Programs\\coop\\Uninstall coop.exe", "C:\\Users\\me\\AppData\\Local\\Programs\\coop", { uninstall: true });
  assert.equal(uninstall.args[2], "_?=C:\\Users\\me\\AppData\\Local\\Programs\\coop");
  assert.throws(() => nsisInvocation("relative.exe", "C:\\x"), /invalid/);
  assert.throws(() => nsisInvocation("C:\\a.exe", "C:\\x\"y"), /invalid/);
});

await check("verify-installer: the package's paths follow electron-builder's per-user layout", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", APPDATA: "C:\\Users\\me\\AppData\\Roaming", USERPROFILE: "C:\\Users\\me" };
  const paths = packagePaths(env);
  assert.equal(paths.exe, join("C:\\Users\\me\\AppData\\Local", "Programs", "coop", "coop.exe"));
  assert.equal(paths.uninstaller, join("C:\\Users\\me\\AppData\\Local", "Programs", "coop", "Uninstall coop.exe"));
  assert.match(paths.startMenuShortcut, /Start Menu[\\/]Programs[\\/]coop \(window\)\.lnk$/);
  assert.match(paths.desktopShortcut, /Desktop[\\/]coop \(window\)\.lnk$/);
  assert.equal(paths.profileData, join("C:\\Users\\me", ".coop", "desktop", "data"));
  assert.equal(paths.electronAppData, join("C:\\Users\\me\\AppData\\Roaming", "coop"));
});

await check("check-installer-report: publishes only the exe whose SHA-256 the passing report names (#277)", () => {
  const dir = join(temp, "release-installer");
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, "coop-window-9.9.9-win-x64.exe");
  writeFileSync(exe, "not really an installer");
  const sha = createHash("sha256").update(readFileSync(exe)).digest("hex");
  const report = { ok: true, installer: "coop-window-9.9.9-win-x64.exe", installerSha256: sha, version: "9.9.9", steps: [] };
  assert.deepEqual(verifiedInstaller(report, dir, "9.9.9"), { file: exe, sha256: sha, version: "9.9.9" });
  assert.throws(() => verifiedInstaller({ ...report, ok: false, error: "uninstall left the package installed" }, dir, "9.9.9"), /does not say ok: uninstall left/);
  assert.throws(() => verifiedInstaller({ ...report, installerSha256: "0".repeat(64) }, dir, "9.9.9"), /the acceptance passed on 0{64}/);
  assert.throws(() => verifiedInstaller({ ...report, version: "9.9.8" }, dir, "9.9.9"), /ran on version 9\.9\.8, this release is 9\.9\.9/);
  assert.throws(() => verifiedInstaller({ ...report, installerSha256: undefined }, dir, "9.9.9"), /no installer SHA-256/);
  assert.throws(() => verifiedInstaller(null, dir, "9.9.9"), /not an object/);
  writeFileSync(join(dir, "coop-window-9.9.9-other.exe"), "a second build");
  assert.throws(() => verifiedInstaller(report, dir, "9.9.9"), /expected one coop-window-\*\.exe .* found 2/);
});

await check("release.yml: the tag build runs the acceptance on the release bytes and publishes only a verified exe (#277)", () => {
  const release = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobs = release.split(/^  (?=[a-z-]+:\s*$)/m);
  const installer = jobs.find((job) => job.startsWith("installer:"));
  const publish = jobs.find((job) => job.startsWith("release:"));
  assert.ok(installer && publish, "release.yml has installer and release jobs");
  // The PR job's verifier step, same opt-in, same script, on the tag build.
  assert.match(installer, /COOP_INSTALLER_TEST: '1'/, "the tag installer job opts the disposable runner in");
  assert.match(installer, /run: node desktop\/scripts\/verify-installer\.mjs --output "\$env:RUNNER_TEMP\\installer-acceptance\.json"/, "the tag installer job runs the same verifier as ci.yml");
  assert.match(ci, /run: node desktop\/scripts\/verify-installer\.mjs --output "\$env:RUNNER_TEMP\\installer-acceptance\.json"/, "ci.yml still runs the verifier the same way");
  assert.doesNotMatch(installer, /continue-on-error/, "a failed acceptance fails the installer job");
  assert.match(installer, /if: always\(\)\s+with:\s+name: coop-window-installer-acceptance\s+path: \$\{\{ runner\.temp \}\}\/installer-acceptance\.json\s+if-no-files-found: error/, "the report is uploaded on success and failure");
  // The release job depends on the installer job, so a failed acceptance publishes nothing.
  assert.match(publish, /needs: \[installer\]/, "release needs the installer job");
  assert.doesNotMatch(publish, /if: always\(\)|if: \$\{\{ always/, "release does not run past a failed installer job");
  assert.match(publish, /name: coop-window-installer-acceptance\s+path: installer/, "release downloads the report beside the exe");
  const order = [publish.indexOf("name: coop-window-installer\n"), publish.indexOf("check-installer-report.mjs installer/installer-acceptance.json installer"), publish.indexOf("Create GitHub Release")];
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], "download, then the report check, then publish");
  assert.match(publish, /files: \|\s+installer\/coop-window-\*\.exe\s+installer\/installer-acceptance\.json\s+fail_on_unmatched_files: true/, "the release carries the exe and its acceptance report");
  // The ancestry and VERSION guard is still the first step of the release job.
  assert.match(publish, /Refuse a tag that isn't VERSION or isn't on origin\/main/, "the tag guard stays");
  assert.ok(publish.indexOf("Refuse a tag that isn't VERSION") < publish.indexOf("Refuse an installer the acceptance did not pass on"), "tag guard runs before the installer check");
});

rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
