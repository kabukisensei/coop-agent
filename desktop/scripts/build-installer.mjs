#!/usr/bin/env node
// Build the coop window package (master plan D1c): the unsigned NSIS per-user
// installer of the window alone, Windows x64.
//
//   node desktop/scripts/build-installer.mjs              stage, then electron-builder
//   node desktop/scripts/build-installer.mjs --stage-only  stage only (any OS, no network)
//
// Stage: desktop/installer/stage holds exactly what ships, at the same relative
// paths as in this checkout, so the window's imports (`../lib/paths.mjs`, the
// vibes, the splash, the icon) resolve inside the asar as they do here:
//   desktop/     main.mjs, preload.cjs, lib/, renderer/, scripts/pdf-text.mjs
//   lib/*.mjs    the modules the window imports (standards, paths, contract...)
//   config/standards-registry.json and config/standards-bundle/ (lib/standards.mjs)
//   vibes/, themes/coop.ico, extensions/coop-powerline/assets/splash.ansi
//   node_modules/pdfjs-dist from config/desktop-lock.json (npm ci, no scripts)
// The staged package.json names the window's version (VERSION) and pdf.js as
// its one dependency. electron-builder (pinned in desktop/installer/package.json,
// `npm ci` there first) packs the stage with the manifest's Electron into
// desktop/installer/dist/coop-window-<version>-win-x64.exe. Nothing here
// touches the user's profile or the window runtime tree.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const INSTALLER = join(ROOT, "desktop", "installer");
export const STAGE = join(INSTALLER, "stage");
export const DIST = join(INSTALLER, "dist");

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

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command) });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status === null ? result.signal : result.status})`);
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

function build() {
  const { version } = stage();
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
    } else {
      build();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
