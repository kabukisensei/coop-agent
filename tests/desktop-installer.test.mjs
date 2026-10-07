/**
 * The coop window package (master plan D1c, D1d): the installed package's
 * bootstrap (the bundled coop first, then the terminal coop; the console that
 * asks it for a window; the --doctor report with the bundled runtime; the
 * unpacked paths), the electron-builder configuration against the plan's NSIS
 * and fuse decisions plus the D1d extraResources, the staged app (every file
 * the window imports, the version, pdf.js as the one dependency), the runtime
 * stage's pure parts (the Node download the manifest pins, the prefix specs,
 * the snapshot filter, the marker) and the acceptance script's NSIS
 * invocation, host guard and package paths.
 *
 * Gate lane: no Electron, no electron-builder, no npm, no network. The stage
 * is written without `npm ci` (install: false) into a temp folder; the runtime
 * is never staged here (it downloads Node and installs with it on Windows).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapProcess, bundledCoop, doctorReport, findCoop, folderArgument, launcherPath, packagedPaths, packagedRuntime } from "../desktop/lib/bootstrap.mjs";
import { consoleProcess } from "../desktop/lib/terminal.mjs";
import { loadSettings, saveSettings } from "../desktop/lib/settings.mjs";
import { DOWNLOAD_HOSTS, NODE_SHIMS_DROPPED, PIPX_SHIM, bundledDownloads, hasWheel, longestPath, nodeDownload, prefixPackages, pythonToolSpecs, prunable, pruneTree, readVersion, runtimeMarker, shippedPackage, snapshotIncludes, stage, stageEntries, stagePackage } from "../desktop/scripts/build-installer.mjs";
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

await check("findCoop: the package's own coop snapshot (D1d) answers before any terminal coop", () => {
  const resources = "C:\\Users\\me\\AppData\\Local\\Programs\\coop\\resources";
  const bundled = join(resources, "coop", "bin", "coop.ps1");
  const env = { PATH: "C:\\tools", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  assert.equal(bundledCoop(resources, (p) => p === bundled), bundled);
  assert.equal(bundledCoop(resources, () => false), "");
  assert.equal(bundledCoop("", () => true), "");
  assert.equal(findCoop(env, () => true, resources), bundled);
  assert.equal(findCoop(env, (p) => p === join("C:\\tools", "coop.cmd"), resources), join("C:\\tools", "coop.cmd"));
  assert.equal(findCoop(env, () => true), join("C:\\tools", "coop.cmd"));
});

await check("packagedRuntime: the marker names Node, Pi and the extension tree; a package without one is null", () => {
  const resources = "C:\\p\\resources";
  const runtime = join(resources, "runtime");
  const marker = JSON.stringify({ schema: 1, coop: "0.30.0", node: { version: "22.19.0", dir: "node" }, npm: { prefix: "npm" }, pi: "0.87.1", extensions: { dir: "extensions", lockSha256: "ab" } });
  const have = new Set([join(runtime, "coop-runtime.json"), join(runtime, "node", "node.exe"), join(runtime, "npm", "pi.cmd"), join(runtime, "extensions", "node_modules")]);
  const full = packagedRuntime(resources, { exists: (p) => have.has(p), read: () => marker });
  assert.deepEqual(full, { node: "22.19.0", pi: "0.87.1", extensions: true, coop: "0.30.0" });
  const bare = packagedRuntime(resources, { exists: (p) => p === join(runtime, "coop-runtime.json"), read: () => marker });
  assert.deepEqual(bare, { node: "", pi: "", extensions: false, coop: "0.30.0" });
  assert.equal(packagedRuntime(resources, { exists: () => false, read: () => marker }), null);
  assert.equal(packagedRuntime(resources, { exists: () => true, read: () => "{" }), null);
  assert.equal(packagedRuntime(resources, { exists: () => true, read: () => JSON.stringify({ schema: 2 }) }), null);
  assert.equal(packagedRuntime("", { exists: () => true, read: () => marker }), null);
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
  assert.deepEqual(report, { product: "coop window", version: "0.29.0", packaged: true, exe: "C:\\p\\coop.exe", coop: "", pdfjs: false, pdfScript: false, runtime: null });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
  assert.equal(doctorReport({ version: "0.29.0", packaged: false, execPath: "C:\\e.exe", env: { PATH: "", LOCALAPPDATA: "C:\\nowhere" }, resourcesPath: resources }).runtime, null);
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
  assert.equal(config.nsis.shortcutName, "coop");
  assert.match(config.artifactName, /^coop-window-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/);
  assert.equal(config.nsis.artifactName, config.artifactName);
  // D1d: the uninstaller drops the first launch's `coop` link and "coop"
  // shortcuts through the snapshot's scripts/window-uninstall.ps1.
  assert.equal(config.nsis.include, join(ROOT, "desktop", "installer", "resources", "installer.nsh"));
  const nsh = readFileSync(config.nsis.include, "utf8");
  assert.match(nsh, /!macro customUnInstall/);
  assert.match(nsh, /resources\\coop\\scripts\\window-uninstall\.ps1" "\$INSTDIR"/);
  // D1k: an upgrade (the new installer runs this uninstaller with --updated) keeps them.
  assert.match(nsh, /\$\{ifNot\} \$\{isUpdated\}[\s\S]*window-uninstall\.ps1[\s\S]*\$\{endIf\}/);
  assert.ok(existsSync(join(ROOT, "scripts", "window-uninstall.ps1")) && snapshotIncludes("scripts/window-uninstall.ps1"));
  for (const icon of [config.win.icon, config.nsis.installerIcon, config.nsis.uninstallerIcon]) {
    assert.equal(icon, join(ROOT, "themes", "coop.ico"));
    assert.ok(existsSync(icon));
  }
  assert.equal(config.win.signtoolOptions, null);
  assert.equal(config.asar, true);
  assert.deepEqual(config.asarUnpack, ["node_modules/pdfjs-dist/**", "desktop/scripts/pdf-text.mjs"]);
  assert.equal(config.directories.app, join(ROOT, "desktop", "installer", "stage"));
  // D1d: the runtime and the coop snapshot ride beside the asar as plain folders.
  assert.deepEqual(config.extraResources, [
    { from: join(ROOT, "desktop", "installer", "runtime"), to: "runtime" },
    { from: join(ROOT, "desktop", "installer", "coop"), to: "coop" },
  ]);
});

// --- the bundled runtime (D1d) ----------------------------------------------------
await check("runtime: the manifest pins the nodejs.org win-x64 zip by version and SHA-256", () => {
  const node = nodeDownload(MANIFEST);
  assert.equal(node.version, MANIFEST.desktop.node.version);
  assert.equal(node.url, `https://nodejs.org/dist/v${node.version}/node-v${node.version}-win-x64.zip`);
  assert.equal(node.file, `node-v${node.version}-win-x64.zip`);
  assert.match(node.sha256, /^[0-9a-f]{64}$/);
  // The bundled Node satisfies the terminal's own floor.
  assert.ok(node.version.localeCompare(MANIFEST.node.min, undefined, { numeric: true }) >= 0, `bundled ${node.version} >= node.min ${MANIFEST.node.min}`);
  assert.throws(() => nodeDownload({ desktop: {} }), /desktop\.node/);
  assert.throws(() => nodeDownload({ desktop: { node: { version: "22.19.0", sha256: "short" } } }), /desktop\.node/);
});

await check("runtime: only the Node zip's PowerShell shims are dropped (PowerShell must reach npm.cmd)", () => {
  assert.deepEqual(NODE_SHIMS_DROPPED, ["npm.ps1", "npx.ps1"]);
});

await check("runtime: pruning drops declarations, source maps and dist-types, keeps sources, JavaScript and licenses", () => {
  for (const [name, dir] of [["index.d.ts", false], ["index.d.mts", false], ["index.d.cts", false], ["index.js.map", false], ["styles.css.map", false], ["dist-types", true]]) {
    assert.ok(prunable(name, dir), `${name} is pruned`);
  }
  for (const [name, dir] of [["index.ts", false], ["index.js", false], ["index.mjs", false], ["package.json", false], ["LICENSE", false], ["README.md", false], ["SKILL.md", false], ["types.d.ts.txt", false], ["dist", true], ["types", true], ["dist-types", false], ["src", true]]) {
    assert.ok(!prunable(name, dir), `${name} stays`);
  }
  const tree = mkdtempSync(join(tmpdir(), "coop-prune-"));
  try {
    const pkg = join(tree, "node_modules", "@aws-sdk", "client");
    mkdirSync(join(pkg, "dist-types", "deep", "deeper"), { recursive: true });
    mkdirSync(join(pkg, "dist-cjs"), { recursive: true });
    mkdirSync(join(tree, "node_modules", "ext", "src"), { recursive: true });
    writeFileSync(join(pkg, "dist-types", "deep", "deeper", "x.d.ts"), "");
    writeFileSync(join(pkg, "dist-cjs", "index.js"), "");
    writeFileSync(join(pkg, "dist-cjs", "index.js.map"), "");
    writeFileSync(join(pkg, "dist-cjs", "index.d.ts"), "");
    writeFileSync(join(pkg, "package.json"), "{}");
    writeFileSync(join(tree, "node_modules", "ext", "src", "index.ts"), "");
    writeFileSync(join(tree, "node_modules", "ext", "README.md"), "");
    const before = longestPath(join(tree, "node_modules"));
    assert.equal(before.path, "@aws-sdk/client/dist-types/deep/deeper/x.d.ts");
    const removed = pruneTree(join(tree, "node_modules"));
    assert.deepEqual(removed, { files: 2, dirs: 1 });
    assert.ok(!existsSync(join(pkg, "dist-types")) && !existsSync(join(pkg, "dist-cjs", "index.js.map")) && !existsSync(join(pkg, "dist-cjs", "index.d.ts")));
    assert.ok(existsSync(join(pkg, "dist-cjs", "index.js")) && existsSync(join(pkg, "package.json")) && existsSync(join(tree, "node_modules", "ext", "src", "index.ts")) && existsSync(join(tree, "node_modules", "ext", "README.md")));
    const after = longestPath(join(tree, "node_modules"));
    assert.equal(after.path, "@aws-sdk/client/dist-cjs/index.js");
    assert.equal(after.length, after.path.length);
    assert.deepEqual(longestPath(join(tree, "missing")), { length: 0, path: "" });
    assert.deepEqual(pruneTree(join(tree, "missing")), { files: 0, dirs: 0 });
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

await check("runtime: the bundled prefix holds the manifest's Pi and every npm tool at its pin", () => {
  const specs = prefixPackages(MANIFEST);
  assert.equal(specs[0], `${MANIFEST.pi.package}@${MANIFEST.pi.version}`);
  for (const [name, pin] of Object.entries(MANIFEST.npm_tools)) assert.ok(specs.includes(`${name}@${pin}`), `${name}@${pin}`);
  assert.equal(specs.length, 1 + Object.keys(MANIFEST.npm_tools).length);
});

await check("runtime: the marker lib/common.ps1 reads names the folders, the pins and the lock", () => {
  const marker = runtimeMarker({ manifest: MANIFEST, version: "0.30.0", lockSha256: "ab".repeat(32) });
  assert.deepEqual(marker, {
    schema: 1,
    coop: "0.30.0",
    node: { version: MANIFEST.desktop.node.version, dir: "node" },
    npm: { prefix: "npm" },
    pi: MANIFEST.pi.version,
    extensions: { dir: "extensions", lockSha256: "ab".repeat(32) },
    git: { version: MANIFEST.desktop.git.version, dir: "git" },
    python: { version: MANIFEST.desktop.python.version, dir: "python", wheels: "python-wheels" },
    azureCli: { version: MANIFEST.desktop.azure_cli.version, dir: "az" },
    odbc: { version: MANIFEST.desktop.odbc.version, dir: "installers", msi: "msodbcsql.msi", vcRedist: "VC_redist.x64.exe", vcRedistVersion: MANIFEST.desktop.vc_redist.version },
  });
});

// --- everything else a teammate needs (D1k) ---------------------------------------
await check("runtime: Git, Python, the Azure CLI, ODBC 18 and its VC++ runtime come from their publishers, pinned by SHA-256", () => {
  const items = bundledDownloads(MANIFEST);
  assert.deepEqual(items.map((i) => i.key), ["git", "python", "azure_cli", "odbc", "vc_redist"]);
  for (const item of items) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/, `${item.key} sha256`);
    assert.ok(DOWNLOAD_HOSTS.includes(new URL(item.url).hostname), `${item.key} from ${item.url}`);
    assert.ok(item.url.startsWith("https://"), item.url);
  }
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(by.git.url, `https://github.com/git-for-windows/git/releases/download/v${MANIFEST.desktop.git.version}.windows.1/MinGit-${MANIFEST.desktop.git.version}-64-bit.zip`);
  assert.equal(by.python.url, `https://api.nuget.org/v3-flatcontainer/python/${MANIFEST.desktop.python.version}/python.${MANIFEST.desktop.python.version}.nupkg`);
  assert.equal(by.python.from, "tools");
  // The Fabric CLI needs 3.10-3.13.
  assert.match(MANIFEST.desktop.python.version, /^3\.(10|11|12|13)\./);
  // The Azure CLI zip's Scripts\ carries Python Fabric's fab.exe: dropped.
  assert.deepEqual(by.azure_cli.drop, ["Scripts"]);
  assert.equal(by.odbc.name, "msodbcsql.msi");
  assert.equal(by.vc_redist.name, "VC_redist.x64.exe");
  assert.throws(() => bundledDownloads({ desktop: { ...MANIFEST.desktop, git: undefined } }), /desktop\.git/);
  assert.throws(() => bundledDownloads({ desktop: { ...MANIFEST.desktop, python: { version: "3.14.0", sha256: "ab".repeat(32) } } }), /desktop\.python/);
  assert.throws(() => bundledDownloads({ desktop: { ...MANIFEST.desktop, odbc: { ...MANIFEST.desktop.odbc, url: "https://example.com/msodbcsql.msi" } } }), /desktop\.odbc\.url/);
  assert.throws(() => bundledDownloads({ desktop: { ...MANIFEST.desktop, vc_redist: { ...MANIFEST.desktop.vc_redist, url: "http://download.microsoft.com/x.exe" } } }), /desktop\.vc_redist\.url/);
});

await check("runtime: the wheel folder must hold every manifest Python tool at its pin; pipx runs through a .cmd", () => {
  const specs = pythonToolSpecs(MANIFEST);
  for (const [name, pin] of Object.entries(MANIFEST.python_tools)) assert.ok(specs.includes(`${name}==${pin}`), `${name}==${pin}`);
  const files = ["coop_data_doc-1.3.4-py3-none-any.whl", "ms_fabric_cli-1.7.0-py3-none-any.whl", "pyodbc-5.3.0-cp313-cp313-win_amd64.whl", "fabric_cicd-1.3.0-py3-none-any.whl"];
  assert.ok(hasWheel(files, "coop-data-doc", "1.3.4"));
  assert.ok(hasWheel(files, "ms-fabric-cli", "1.7.0"));
  assert.ok(hasWheel(files, "pyodbc", "5.3.0"));
  assert.ok(!hasWheel(files, "pyodbc", "5.2.0"));
  assert.ok(!hasWheel(["coop-data-doc-1.3.4.tar.gz"], "coop-data-doc", "1.3.4"));
  assert.equal(PIPX_SHIM, '@"%~dp0..\\python.exe" -m pipx %*\r\n');
});

await check("snapshot: coop's own files ship, the development-only ones do not", () => {
  for (const file of ["bin/coop.ps1", "bin/coop.cmd", "lib/common.ps1", "scripts/install.ps1", "config/release-manifest.json", "config/extensions-lock.json", "docs/guardrails.md", "skills/coop-workflow/SKILL.md", "extensions/coop-tools/index.ts", "themes/coop.ico", "vibes/x.txt", "VERSION", "README.md", ".coop/project.example.yml", "Install coop.cmd"]) {
    assert.ok(snapshotIncludes(file), `${file} ships`);
  }
  for (const file of ["tests/run.sh", "tests/fixtures/_common.ps1", "desktop/main.mjs", "desktop/installer/electron-builder.cjs", ".github/workflows/ci.yml", ".agents/skills/x/SKILL.md", ".specify/memory/constitution.md", "docs/history/old-plan.md", "acceptance/x.md", ".gitignore", ".gitattributes", ".coop/project.yml"]) {
    assert.ok(!snapshotIncludes(file), `${file} stays out`);
  }
  // Windows separators are the same decision.
  assert.ok(!snapshotIncludes("tests\\run.sh") && snapshotIncludes("bin\\coop.ps1"));
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
  assert.ok(entries.includes("desktop/main.mjs") && entries.includes("desktop/preload.cjs") && entries.includes("desktop/lib/") && entries.includes("desktop/renderer/") && entries.includes("desktop/companion/"));
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
  // D1m: the package's shortcut is plain "coop"; the first launch adds "coop (terminal)".
  assert.match(paths.startMenuShortcut, /Start Menu[\\/]Programs[\\/]coop\.lnk$/);
  assert.match(paths.desktopShortcut, /Desktop[\\/]coop\.lnk$/);
  assert.match(paths.terminalShortcut, /Desktop[\\/]coop \(terminal\)\.lnk$/);
  assert.match(paths.startMenuTerminalShortcut, /Start Menu[\\/]Programs[\\/]coop \(terminal\)\.lnk$/);
  assert.equal(paths.profileData, join("C:\\Users\\me", ".coop", "desktop", "data"));
  assert.equal(paths.electronAppData, join("C:\\Users\\me\\AppData\\Roaming", "coop"));
  // D1d: the runtime and the snapshot beside the asar.
  assert.equal(paths.runtime, join(paths.installDir, "resources", "runtime"));
  assert.equal(paths.nodeExe, join(paths.runtime, "node", "node.exe"));
  assert.equal(paths.piShim, join(paths.runtime, "npm", "pi.cmd"));
  assert.equal(paths.extensions, join(paths.runtime, "extensions"));
  assert.equal(paths.coopPs1, join(paths.installDir, "resources", "coop", "bin", "coop.ps1"));
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

await check("ci.yml: the upgrade acceptance installs the latest release, then this build over it (D1k)", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const jobs = ci.split(/^  (?=[a-z-]+:\s*$)/m);
  const upgrade = jobs.find((job) => job.startsWith("installer-upgrade:"));
  const gate = jobs.find((job) => job.startsWith("gate:"));
  assert.ok(upgrade, "ci.yml has an installer-upgrade job");
  assert.match(upgrade, /needs: \[installer\]/);
  assert.match(upgrade, /COOP_INSTALLER_TEST: '1'/);
  assert.match(upgrade, /gh release download --repo "\$env:GITHUB_REPOSITORY" --pattern 'coop-window-\*\.exe' --pattern 'installer-acceptance\.json'/);
  assert.match(upgrade, /run: node desktop\/scripts\/verify-upgrade\.mjs --previous /);
  assert.match(upgrade, /run: node desktop\/scripts\/verify-launch\.mjs /, "the shortcut is double-clicked and a window must open");
  assert.match(gate, /needs: \[[^\]]*\binstaller-upgrade\b/, "the gate needs the upgrade job");
  // verify-launch.mjs finds the picker by its window title; the page's <title> replaces the BrowserWindow one.
  const launch = readFileSync(join(ROOT, "desktop", "scripts", "verify-launch.mjs"), "utf8");
  const pickerTitle = /const PICKER_TITLE = "([^"]+)"/.exec(launch)[1];
  assert.match(readFileSync(join(ROOT, "desktop", "renderer", "picker.html"), "utf8"), new RegExp(`<title>${pickerTitle}</title>`), "picker.html carries the title the launch check waits for");
});

await check("release.yml: the tag build runs the acceptance on the release bytes and publishes only a verified exe (#277)", () => {
  // A Windows checkout may carry CRLF: normalise before matching line-anchored text.
  const release = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
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
