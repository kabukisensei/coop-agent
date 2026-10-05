#!/usr/bin/env node
// Build the coop window package (master plan D1c and D1d): the unsigned NSIS
// per-user installer of the window with Node, Pi, the extension tree and a
// snapshot of this repository inside, Windows x64. One download is the whole
// coop (D1d, Aaron 2026-10-03): nothing else is installed for Node, Pi, the
// extensions or coop's own files.
//
//   node desktop/scripts/build-installer.mjs                stage, then electron-builder
//   node desktop/scripts/build-installer.mjs --stage-only   stage only (any OS)
//   node desktop/scripts/build-installer.mjs --stage-only --no-install --no-runtime
//                                                           the window's files alone, no network
//
// Three stages under desktop/installer/, each exactly what ships:
//   stage/    the app (packed into the asar): desktop/ (main.mjs, preload.cjs,
//             lib/, renderer/, scripts/pdf-text.mjs), lib/*.mjs (the modules the
//             window imports), config/standards-registry.json and the standards
//             bundle, vibes/, themes/coop.ico, the splash, and pdf.js from
//             config/desktop-lock.json (npm ci, no scripts; Electron's shim is
//             dropped because electron-builder supplies the manifest's Electron).
//   runtime/  resources\runtime in the package (D1d): node/ (the nodejs.org
//             win-x64 zip the manifest pins by version and SHA-256, minus its
//             npm.ps1 and npx.ps1: PowerShell would pick those over npm.cmd and
//             the zip's copies answer `npm prefix -g` with "Unknown command"),
//             npm/ (an npm global prefix holding the manifest's Pi and the Power
//             BI tools, installed with that Node), extensions/ (the agent dir's
//             npm tree installed from config/extensions-lock.json with `npm ci`,
//             as coop sync does), and coop-runtime.json naming them. Both npm
//             trees are pruned of what nothing runs (pruneTree below), which
//             halves the file count and keeps every path under Windows' limit.
//   coop/     resources\coop in the package (D1d): the tracked files of this
//             checkout except tests, desktop/, the workflows, docs/history and
//             the repo's own dotfiles. bin/coop.ps1 runs from here; lib/common.ps1
//             finds the runtime folder beside it and puts the bundled Node and
//             Pi first on PATH.
// electron-builder (pinned in desktop/installer/package.json, `npm ci` there
// first) packs the stage with the manifest's Electron and copies runtime/ and
// coop/ as extraResources into desktop/installer/dist/coop-window-<version>-win-x64.exe.
// Nothing here touches the user's profile or a window runtime tree.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const INSTALLER = join(ROOT, "desktop", "installer");
export const STAGE = join(INSTALLER, "stage");
export const DIST = join(INSTALLER, "dist");
export const RUNTIME = join(INSTALLER, "runtime");
export const SNAPSHOT = join(INSTALLER, "coop");
export const CACHE = join(INSTALLER, "cache");

/** Files and folders that ship, relative to the checkout (folders end with /). */
export function stageEntries(root = ROOT) {
  const libModules = readdirSync(join(root, "lib")).filter((name) => name.endsWith(".mjs")).sort().map((name) => `lib/${name}`);
  return [
    "desktop/main.mjs",
    "desktop/preload.cjs",
    "desktop/PARITY.md",
    "desktop/lib/",
    "desktop/renderer/",
    "desktop/scripts/pdf-text.mjs",
    ...libModules,
    // lib/standards.mjs imports the registry and names the bundled standards.
    "config/standards-registry.json",
    "config/standards-bundle/",
    "vibes/",
    "themes/coop.ico",
    "extensions/coop-powerline/assets/splash.ansi",
  ];
}

/** The staged package.json: the window's version and pdf.js from the lock. */
export function stagePackage({ version, manifest }) {
  return {
    name: "coop-window",
    productName: "coop",
    description: "The coop window: the Cooptimize analytics agent, in a window.",
    version,
    private: true,
    type: "module",
    main: "desktop/main.mjs",
    dependencies: { electron: manifest.desktop.electron, "pdfjs-dist": manifest.desktop.pdfjs },
  };
}

/** The same package.json after `npm ci`: Electron is the shell, not a dependency to pack. */
export function shippedPackage(staged) {
  const { electron, ...dependencies } = staged.dependencies;
  void electron;
  return { ...staged, dependencies };
}

export function readVersion(root = ROOT) {
  return readFileSync(join(root, "VERSION"), "utf8").trim();
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command) });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status === null ? result.signal : result.status})`);
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command) });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status === null ? result.signal : result.status}): ${(result.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
  return result.stdout;
}

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** Write the stage from the checkout. Returns the stage path. */
export function stage({ root = ROOT, stageDir = STAGE, install = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, "config", "release-manifest.json"), "utf8"));
  const version = readVersion(root);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const entry of stageEntries(root)) {
    const from = join(root, entry);
    if (!existsSync(from)) throw new Error(`stage: ${entry} is missing from the checkout`);
    cpSync(from, join(stageDir, entry), { recursive: entry.endsWith("/") });
  }
  const staged = stagePackage({ version, manifest });
  writeFileSync(join(stageDir, "package.json"), JSON.stringify(staged, null, 2) + "\n");
  cpSync(join(root, "config", "desktop-lock.json"), join(stageDir, "package-lock.json"));
  if (install) {
    // The lock pins Electron and pdf.js together (the runtime tree installs
    // the same way); Electron's JavaScript shim is then dropped from the stage,
    // because electron-builder supplies the Electron the manifest pins.
    run(NPM, ["ci", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"], stageDir);
    rmSync(join(stageDir, "node_modules", "electron"), { recursive: true, force: true });
    rmSync(join(stageDir, "node_modules", ".bin"), { recursive: true, force: true });
  }
  writeFileSync(join(stageDir, "package.json"), JSON.stringify(shippedPackage(staged), null, 2) + "\n");
  rmSync(join(stageDir, "package-lock.json"), { force: true });
  return { stageDir, version, manifest };
}

// --- the bundled runtime (D1d) -------------------------------------------------

/** The nodejs.org archive the manifest pins (desktop.node): Windows x64 zip. */
export function nodeDownload(manifest) {
  const node = manifest.desktop && manifest.desktop.node;
  if (!node || !/^\d+\.\d+\.\d+$/.test(node.version || "") || !/^[0-9a-f]{64}$/.test(node.sha256 || "")) {
    throw new Error("the release manifest has no desktop.node { version, sha256 } pin");
  }
  const folder = `node-v${node.version}-win-x64`;
  return { version: node.version, sha256: node.sha256, folder, file: `${folder}.zip`, url: `https://nodejs.org/dist/v${node.version}/${folder}.zip` };
}

/** Pi and the Power BI tools, as `npm install -g` specs, into the bundled prefix. */
export function prefixPackages(manifest) {
  const specs = [`${manifest.pi.package}@${manifest.pi.version}`];
  for (const [name, version] of Object.entries(manifest.npm_tools || {})) specs.push(`${name}@${version}`);
  return specs;
}

/**
 * Which tracked files of the checkout ship as the package's coop snapshot
 * (resources\coop): everything coop runs from (bin, lib, scripts, config,
 * skills, prompts, extensions, docs, themes, vibes, VERSION, the Markdown at
 * the root) and nothing that only develops it.
 */
export function snapshotIncludes(file) {
  const posix = file.split(/[\\/]/).join("/");
  if (/^(tests|desktop|acceptance|\.github|\.agents|\.specify)\//.test(posix)) return false;
  if (/^docs\/history\//.test(posix)) return false;
  if (posix === ".gitignore" || posix === ".gitattributes" || posix === ".coop/project.yml") return false;
  return true;
}

/** resources\runtime\coop-runtime.json: what lib/common.ps1 reads to find the bundle. */
export function runtimeMarker({ manifest, version, lockSha256 }) {
  return {
    schema: 1,
    coop: version,
    node: { version: manifest.desktop.node.version, dir: "node" },
    npm: { prefix: "npm" },
    pi: manifest.pi.version,
    extensions: { dir: "extensions", lockSha256 },
  };
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** bsdtar (Windows 10+, macOS) opens a zip; GNU tar does not, so Linux falls back to unzip. */
function extractZip(zip, into) {
  mkdirSync(into, { recursive: true });
  const tar = spawnSync("tar", ["-xf", zip, "-C", into], { stdio: "inherit" });
  if (tar.status === 0) return;
  const unzip = spawnSync("unzip", ["-q", zip, "-d", into], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error(`could not extract ${zip} (tar ${tar.status}, unzip ${unzip.status})`);
}

/**
 * What the bundled npm trees carry that nothing runs: TypeScript declarations
 * (`.d.ts`, `.d.mts`, `.d.cts`, whole `dist-types` folders) and source maps.
 * Pi loads the extensions' TypeScript sources without type-checking, so the
 * declarations are dead weight: they are about half of the tree's files, and
 * the AWS SDK's `dist-types` folders hold the only paths long enough to break
 * the 260-character limit in a user's profile (and robocopy's seeding of the
 * agent dir). `.ts` sources, JavaScript, JSON, licenses and docs stay.
 */
export function prunable(name, isDirectory) {
  if (isDirectory) return name === "dist-types";
  return /\.d\.(ts|mts|cts)$/.test(name) || /\.map$/.test(name);
}

/** Remove the prunable entries under an npm tree; returns what was removed. */
export function pruneTree(dir) {
  const removed = { files: 0, dirs: 0 };
  if (!existsSync(dir)) return removed;
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (prunable(entry.name, true)) { rmSync(full, { recursive: true, force: true }); removed.dirs += 1; }
        else walk(full);
      } else if (entry.isFile() && prunable(entry.name, false)) {
        rmSync(full, { force: true });
        removed.files += 1;
      }
    }
  };
  walk(dir);
  return removed;
}

/** The Node zip's PowerShell shims, dropped from the bundled Node (see the header). */
export const NODE_SHIMS_DROPPED = ["npm.ps1", "npx.ps1"];

/**
 * The longest path under a folder, relative to it, as `{ length, path }`:
 * the package's files must stay under Windows' 260-character limit once
 * installed in a user's profile (verify-installer.mjs asserts it).
 */
export function longestPath(dir) {
  let longest = { length: 0, path: "" };
  const walk = (folder, rel) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(folder, entry.name), relPath);
      else if (relPath.length > longest.length) longest = { length: relPath.length, path: relPath };
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, "");
  return longest;
}

/**
 * Stage resources\runtime: the pinned Node (downloaded once into
 * desktop/installer/cache and checked against the manifest's SHA-256), the npm
 * prefix with Pi and the Power BI tools, the extension tree from the lock, and
 * the marker. Needs the network and, for a tree whose packages fetch prebuilt
 * binaries (better-sqlite3 under pi-hermes-memory), the target platform: the
 * CI job runs it on windows-latest.
 */
export async function stageRuntime({ root = ROOT, runtimeDir = RUNTIME, cacheDir = CACHE } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, "config", "release-manifest.json"), "utf8"));
  const version = readVersion(root);
  const node = nodeDownload(manifest);
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const zip = join(cacheDir, node.file);
  if (!existsSync(zip) || sha256File(zip) !== node.sha256) {
    console.log(`downloading ${node.url}`);
    await download(node.url, zip);
  }
  const sum = sha256File(zip);
  if (sum !== node.sha256) throw new Error(`${node.file}: SHA-256 ${sum} does not match the manifest's ${node.sha256}`);
  const unpack = join(runtimeDir, "node-unpack");
  extractZip(zip, unpack);
  const nodeDir = join(runtimeDir, "node");
  renameSync(join(unpack, node.folder), nodeDir);
  rmSync(unpack, { recursive: true, force: true });
  if (!existsSync(join(nodeDir, "node.exe")) || !existsSync(join(nodeDir, "npm.cmd"))) throw new Error(`${node.file} did not unpack to node.exe and npm.cmd`);
  // PowerShell resolves `& npm` to npm.ps1 ahead of npm.cmd, and the zip's
  // npm.ps1 answers `npm prefix -g` with 'Unknown command: "pm"' (seen on the
  // D1d VM check): lib/common.ps1 and scripts/install.ps1 call `& npm`, so only
  // the .cmd shims ship.
  for (const shim of NODE_SHIMS_DROPPED) rmSync(join(nodeDir, shim), { force: true });
  console.log(`staged Node ${node.version} (${node.file}, SHA-256 verified; ${NODE_SHIMS_DROPPED.join(", ")} dropped)`);

  // Everything below runs the bundled Node (so a prebuilt binary matches its ABI)
  // and only on Windows, where that Node runs.
  if (process.platform !== "win32") throw new Error("the runtime stage installs packages with the bundled Windows Node: run it on Windows (--no-runtime skips it)");
  const env = { ...process.env, PATH: `${nodeDir};${process.env.PATH || ""}` };
  const npm = join(nodeDir, "npm.cmd");

  const prefix = join(runtimeDir, "npm");
  mkdirSync(prefix, { recursive: true });
  run(npm, ["install", "-g", "--no-audit", "--no-fund", ...prefixPackages(manifest)], runtimeDir, { ...env, npm_config_prefix: prefix });
  const piPkg = join(prefix, "node_modules", manifest.pi.package, "package.json");
  if (!existsSync(piPkg) || JSON.parse(readFileSync(piPkg, "utf8")).version !== manifest.pi.version) throw new Error(`Pi ${manifest.pi.version} is not in the bundled prefix`);
  if (!existsSync(join(prefix, "pi.cmd"))) throw new Error("the bundled prefix has no pi.cmd shim");
  const prunedPrefix = pruneTree(join(prefix, "node_modules"));
  console.log(`staged Pi ${manifest.pi.version} and ${Object.keys(manifest.npm_tools || {}).length} npm tool(s) in the bundled prefix (${prunedPrefix.files} declaration/map file(s) and ${prunedPrefix.dirs} dist-types folder(s) pruned)`);

  const extensions = join(runtimeDir, "extensions");
  mkdirSync(extensions, { recursive: true });
  const treePackage = capture(process.execPath, [join(root, "lib", "extlock.js"), "package-json", join(root, "config", "release-manifest.json")], root);
  writeFileSync(join(extensions, "package.json"), treePackage);
  const lock = join(root, "config", "extensions-lock.json");
  cpSync(lock, join(extensions, "package-lock.json"));
  // Lifecycle scripts run as in coop sync (Install-CoopExtensionsLock).
  run(npm, ["ci", "--no-audit", "--no-fund"], extensions, { ...env, npm_config_prefix: prefix });
  for (const [name, pin] of Object.entries(manifest.extensions || {})) {
    const pkg = join(extensions, "node_modules", name, "package.json");
    if (!existsSync(pkg) || JSON.parse(readFileSync(pkg, "utf8")).version !== pin) throw new Error(`${name}@${pin} is not in the bundled extension tree`);
  }
  const lockSha256 = sha256File(lock);
  if (sha256File(join(extensions, "package-lock.json")) !== lockSha256) throw new Error("npm ci rewrote the extension lock");
  const prunedTree = pruneTree(join(extensions, "node_modules"));
  const longest = longestPath(runtimeDir);
  console.log(`staged the extension tree (${Object.keys(manifest.extensions || {}).length} extension(s) from config/extensions-lock.json; ${prunedTree.files} declaration/map file(s) and ${prunedTree.dirs} dist-types folder(s) pruned; longest path ${longest.length} chars: ${longest.path})`);

  writeFileSync(join(runtimeDir, "coop-runtime.json"), JSON.stringify(runtimeMarker({ manifest, version, lockSha256 }), null, 2) + "\n");
  return { runtimeDir, version, manifest };
}

/** Stage resources\coop: the tracked files of the checkout that ship (snapshotIncludes). */
export function stageSnapshot({ root = ROOT, snapshotDir = SNAPSHOT } = {}) {
  const listed = capture("git", ["-C", root, "ls-files", "-z"], root).split("\0").filter(Boolean);
  if (listed.length < 50) throw new Error(`git ls-files listed ${listed.length} file(s): the snapshot needs a git checkout`);
  rmSync(snapshotDir, { recursive: true, force: true });
  let count = 0;
  for (const file of listed) {
    if (!snapshotIncludes(file)) continue;
    const from = join(root, file);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(snapshotDir, file)), { recursive: true });
    cpSync(from, join(snapshotDir, file));
    count += 1;
  }
  for (const required of ["bin/coop.ps1", "lib/common.ps1", "scripts/install.ps1", "config/release-manifest.json", "config/extensions-lock.json", "docs/guardrails.md", "VERSION"]) {
    if (!existsSync(join(snapshotDir, required))) throw new Error(`snapshot: ${required} is missing`);
  }
  console.log(`staged the coop snapshot (${count} files)`);
  return { snapshotDir, count };
}

async function build() {
  const { version } = stage();
  await stageRuntime();
  stageSnapshot();
  const builder = join(INSTALLER, "node_modules", "electron-builder", "cli.js");
  if (!existsSync(builder)) throw new Error("electron-builder is not installed: run `npm ci` in desktop/installer first");
  rmSync(DIST, { recursive: true, force: true });
  run(process.execPath, [builder, "--config", join(INSTALLER, "electron-builder.cjs"), "--projectDir", STAGE, "--win", "nsis", "--x64", "--publish", "never"], INSTALLER);
  const exe = readdirSync(DIST).find((name) => /^coop-window-.*\.exe$/i.test(name));
  if (!exe) throw new Error(`no installer in ${DIST}`);
  console.log(`built ${join(DIST, exe)} (coop ${version})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--stage-only")) {
      const { stageDir } = stage({ install: !process.argv.includes("--no-install") });
      console.log(`staged ${stageDir}`);
      if (!process.argv.includes("--no-runtime")) {
        await stageRuntime();
        stageSnapshot();
      }
    } else {
      await build();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
