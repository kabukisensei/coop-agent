#!/usr/bin/env node
// The coop window's runtime lockfile (master plan D1b).
//
// config/desktop-lock.json is npm's package-lock.json (lockfileVersion 3) for a
// tree that holds the manifest's two window pins: Electron (desktop.electron)
// and pdf.js (desktop.pdfjs, the pdfjs-dist package that reads attached PDFs
// in a child process). The window runtime installs from it with
// `npm ci --ignore-scripts --omit=optional` into <profile dir>\desktop\runtime
// (Install-CoopDesktopRuntime in lib/common.ps1), so every machine on a release
// gets the same packages and the same checksums.json Electron's install.js
// verifies the binary against. Optional packages (pdf.js's canvas, which only
// rendering needs) stay in the lock and out of the tree.
//
// usage:
//   node desktop/scripts/runtime-lock.mjs generate [manifest] [out]   regenerate (network; resolves only, downloads no binary)
//   node desktop/scripts/runtime-lock.mjs check    [manifest] [lock]  the lock agrees with the manifest (offline)
//
// `check` prints one reason per mismatch; exit 0 when consistent, 1 when not,
// 2 on bad usage or an unreadable file.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_MANIFEST = join(ROOT, "config", "release-manifest.json");
const DEFAULT_LOCK = join(ROOT, "config", "desktop-lock.json");
export const RUNTIME_NAME = "coop-desktop-runtime";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`runtime-lock: cannot read ${file}: ${error.message}`);
    process.exit(2);
  }
}

/** The pins the runtime tree holds, as package name -> version. */
export function runtimePins(manifest) {
  const desktop = (manifest && manifest.desktop) || {};
  if (!desktop.electron) throw new Error("manifest has no desktop.electron");
  if (!desktop.pdfjs) throw new Error("manifest has no desktop.pdfjs");
  return { electron: desktop.electron, "pdfjs-dist": desktop.pdfjs };
}

/** The package.json the runtime tree installs: the two pins and nothing else. */
export function runtimePackageJson(manifest) {
  return { name: RUNTIME_NAME, private: true, dependencies: runtimePins(manifest) };
}

/** Reasons the lock does not match the manifest; empty when it does. */
export function lockProblems(manifest, lock) {
  const problems = [];
  let want;
  try { want = runtimePackageJson(manifest); } catch (error) { return [error.message]; }
  if (!lock || lock.lockfileVersion !== 3) problems.push("lockfileVersion is not 3");
  const packages = (lock && lock.packages) || {};
  const root = packages[""] || {};
  const deps = root.dependencies || {};
  if (JSON.stringify(deps) !== JSON.stringify(want.dependencies)) {
    problems.push(`root dependencies are ${JSON.stringify(deps)}, the manifest pins ${JSON.stringify(want.dependencies)}`);
  }
  for (const [name, version] of Object.entries(want.dependencies)) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || entry.version !== version) problems.push(`node_modules/${name} is ${entry ? entry.version : "missing"}, the manifest pins ${version}`);
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (!key) continue;
    if (!entry.resolved || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved)) problems.push(`${key} does not resolve from registry.npmjs.org`);
    if (!entry.integrity || !entry.integrity.startsWith("sha512-")) problems.push(`${key} has no sha512 integrity`);
  }
  return problems;
}

function generate(manifestFile, out) {
  const manifest = readJson(manifestFile);
  const dir = mkdtempSync(join(tmpdir(), "coop-desktop-lock-"));
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(runtimePackageJson(manifest), null, 2)}\n`);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npm, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: dir, stdio: "inherit", shell: process.platform === "win32",
    });
    if (result.status !== 0) { console.error("runtime-lock: npm install --package-lock-only failed"); process.exit(1); }
    copyFileSync(join(dir, "package-lock.json"), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const problems = lockProblems(manifest, readJson(out));
  if (problems.length) { for (const p of problems) console.error(`runtime-lock: ${p}`); process.exit(1); }
  console.log(`runtime-lock: wrote ${out}`);
}

function check(manifestFile, lockFile) {
  const problems = lockProblems(readJson(manifestFile), readJson(lockFile));
  for (const p of problems) console.error(`runtime-lock: ${p}`);
  if (problems.length) process.exit(1);
  console.log("runtime-lock: config/desktop-lock.json matches the manifest");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b] = process.argv.slice(2);
  if (command === "generate") generate(a || DEFAULT_MANIFEST, b || DEFAULT_LOCK);
  else if (command === "check") check(a || DEFAULT_MANIFEST, b || DEFAULT_LOCK);
  else { console.error("usage: node desktop/scripts/runtime-lock.mjs generate|check [manifest] [lock]"); process.exit(2); }
}
