#!/usr/bin/env node
/**
 * Pi's own dependency tree, pinned (master plan section 6.6, row U3).
 *
 * config/release-manifest.json pins Pi by version, and `coop install` puts it on
 * a machine with `npm install -g @earendil-works/pi-coding-agent@<pin>`. That
 * pins Pi alone: Pi stopped shipping npm-shrinkwrap.json in 1.0.1, so npm
 * resolves Pi's dependencies on the day of the install. On 2026-10-12
 * pi-codemode 1.2.0 dropped an export Pi 1.1.0 imports, and a fresh install of
 * the pinned Pi stopped starting while every earlier install kept working.
 *
 * config/pi-lock.json is npm's package-lock.json (lockfileVersion 3) for a
 * one-dependency package, `coop-pi-runtime`, whose dependency is the manifest's
 * Pi. `apply` installs that package from the lock with `npm ci` beside the
 * installed Pi and moves the resolved tree into Pi's own node_modules, so the
 * global Pi runs the dependency versions the release was qualified with, on
 * every machine and in the window package's bundled prefix.
 *
 * Layout: the lock's root has one dependency, so npm hoists every package Pi
 * needs beside Pi in the staged tree (`node_modules/<name>`) and nests only the
 * conflicts under the package that needs them. Inside the installed Pi the same
 * tree lives one level down, at `<pi>/node_modules/<name>`, which is where Node
 * resolves Pi's imports first. `matches` checks that layout offline.
 *
 * usage:
 *   node lib/pilock.js generate [manifest] [out]   regenerate the lock (network; resolves the tree once)
 *   node lib/pilock.js check    [manifest] [lock]  lock agrees with the manifest's Pi (offline)
 *   node lib/pilock.js apply    <pi-dir> [lock]    install Pi's dependencies from the lock into <pi-dir>/node_modules
 *   node lib/pilock.js matches  <pi-dir> [lock]    <pi-dir>/node_modules holds exactly the lock's tree (offline)
 *
 * <pi-dir> is the installed package, `<npm global root>/@earendil-works/pi-coding-agent`.
 * `apply` writes <pi-dir>/node_modules/.coop-pi-lock.json (the lock's SHA-256
 * and Pi version) so lib/common.ps1 can tell an applied lock from a pending one
 * without walking the tree. COOP_PILOCK_STAGED=<dir> makes `apply` take an
 * already resolved tree (<dir>/node_modules) instead of running `npm ci`; the
 * tests use it, nothing else should.
 *
 * `check` and `matches` print one reason per mismatch; exit 0 when consistent,
 * 1 when not, 2 on bad usage or an unreadable file. Called by lib/common.ps1,
 * scripts/doctor.ps1 and desktop/scripts/build-installer.mjs
 * (one implementation).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { npmBin, readJson, markNoGyp, PI_AGENT } = require("./extlock.js");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(ROOT, "config", "release-manifest.json");
const DEFAULT_LOCK = path.join(ROOT, "config", "pi-lock.json");
const WRAPPER = "coop-pi-runtime";
const MARKER = ".coop-pi-lock.json";
const PI_KEY = `node_modules/${PI_AGENT}`;

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

// The one-dependency package the lock resolves.
function wrapperPackageJson(manifest) {
  const pi = manifest.pi && manifest.pi.version;
  if (!pi) { console.error("pilock: manifest has no pi.version"); process.exit(2); }
  const name = (manifest.pi && manifest.pi.package) || PI_AGENT;
  return { name: WRAPPER, private: true, dependencies: { [name]: pi } };
}

function generate(manifestPath, outPath) {
  const manifest = readJson(manifestPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coop-pilock-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify(wrapperPackageJson(manifest), null, 2) + "\n");
    const r = spawnSync(npmBin(), ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: tmp, stdio: "inherit", shell: process.platform === "win32",
    });
    if (r.status !== 0) { console.error("pilock: npm install --package-lock-only failed"); process.exit(1); }
    const lock = readJson(path.join(tmp, "package-lock.json"));
    markNoGyp(lock, tmp);
    fs.writeFileSync(outPath, JSON.stringify(lock, null, 2) + "\n");
    const problems = checkLock(manifest, lock);
    if (problems.length) { for (const p of problems) console.error(`pilock: ${p}`); process.exit(1); }
    console.log(`pilock: wrote ${path.relative(process.cwd(), outPath) || outPath} (${Object.keys(lock.packages || {}).length - 2} packages under Pi ${manifest.pi.version})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Reasons the lock disagrees with the manifest (empty = consistent).
function checkLock(manifest, lock) {
  const problems = [];
  const want = wrapperPackageJson(manifest);
  const [name, pin] = Object.entries(want.dependencies)[0];
  const packages = (lock && lock.packages) || {};
  const root = packages[""] || {};
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3`);
  const have = root.dependencies || {};
  if (have[name] !== pin) problems.push(`lock root pins ${name}@${have[name] || "(absent)"}, manifest says ${pin}`);
  for (const dep of Object.keys(have)) if (dep !== name) problems.push(`lock root carries ${dep}, which is not Pi`);
  const entry = packages[`node_modules/${name}`];
  if (!entry) problems.push(`lock has no node_modules/${name} entry`);
  else if (entry.version !== pin) problems.push(`lock installs ${name}@${entry.version}, manifest says ${pin}`);
  for (const key of Object.keys(packages)) {
    if (key.startsWith(`node_modules/${name}/node_modules/`)) problems.push(`${key} is nested under Pi; the lock's layout must hoist every dependency beside it`);
  }
  return problems;
}

function check(manifestPath, lockPath) {
  const problems = checkLock(readJson(manifestPath), readJson(lockPath));
  if (problems.length) {
    for (const p of problems) console.error(`pilock: ${p}`);
    console.error("pilock: regenerate with: node lib/pilock.js generate");
    process.exit(1);
  }
  console.log("pilock: lock matches the manifest");
}

function installedVersion(dir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || ""); } catch { return ""; }
}

// The installed path of a lock entry: `node_modules/<x>` beside Pi in the staged
// tree is `<pi>/node_modules/<x>` once applied.
function installedPath(piDir, key) {
  return path.join(piDir, key);
}

// Reasons <pi-dir>/node_modules differs from the lock (empty = matches).
function treeProblems(piDir, lock) {
  const problems = [];
  const packages = (lock && lock.packages) || {};
  const piEntry = packages[PI_KEY] || {};
  const got = installedVersion(piDir);
  if (!got) return [`no Pi package at ${piDir}`];
  if (piEntry.version && got !== piEntry.version) problems.push(`installed Pi is ${got}, the lock is for ${piEntry.version}`);
  const expectedTop = new Set();
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || key === PI_KEY || entry.link) continue;
    const rel = key.slice("node_modules/".length);
    const top = rel.startsWith("@") ? rel.split("/").slice(0, 2).join("/") : rel.split("/")[0];
    if (!rel.includes("/node_modules/")) expectedTop.add(top);
    const have = installedVersion(installedPath(piDir, key));
    if (!have) problems.push(`${key} is missing (lock has ${entry.version})`);
    else if (entry.version && have !== entry.version) problems.push(`${key} is ${have}, lock has ${entry.version}`);
  }
  const nm = path.join(piDir, "node_modules");
  let names = [];
  try { names = fs.readdirSync(nm, { withFileTypes: true }); } catch { return problems.length ? problems : [`no node_modules under ${piDir}`]; }
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    if (d.name.startsWith("@")) {
      let inner = [];
      try { inner = fs.readdirSync(path.join(nm, d.name), { withFileTypes: true }); } catch { continue; }
      for (const e of inner) {
        if (!e.isDirectory()) continue;
        const full = `${d.name}/${e.name}`;
        if (!expectedTop.has(full)) problems.push(`node_modules/${full} is installed but not in the lock`);
      }
    } else if (!expectedTop.has(d.name)) {
      problems.push(`node_modules/${d.name} is installed but not in the lock`);
    }
  }
  return problems;
}

function matches(piDir, lockPath) {
  const problems = treeProblems(path.resolve(piDir), readJson(lockPath));
  if (problems.length) {
    for (const p of problems.slice(0, 20)) console.error(`pilock: ${p}`);
    if (problems.length > 20) console.error(`pilock: ... ${problems.length - 20} more`);
    console.error(`pilock: ${problems.length} difference(s); apply with: coop update`);
    process.exit(1);
  }
  console.log("pilock: Pi's dependency tree matches the lock");
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }

// Move a directory, by rename when the volumes agree, else copy and delete.
function moveDir(from, to) {
  try { fs.renameSync(from, to); return; } catch (e) { if (e.code !== "EXDEV" && e.code !== "EPERM") throw e; }
  fs.cpSync(from, to, { recursive: true });
  rmrf(from);
}

// Stale stage folders from an apply that died (a reboot, a killed install).
function removeStaleStages(parent) {
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return; }
  for (const n of names) if (n.startsWith(".coop-pi-stage-")) rmrf(path.join(parent, n));
}

function apply(piDirArg, lockPath) {
  const piDir = path.resolve(piDirArg);
  const lock = readJson(lockPath);
  const packages = lock.packages || {};
  const piEntry = packages[PI_KEY];
  if (!piEntry) { console.error(`pilock: ${lockPath} has no ${PI_KEY} entry`); process.exit(2); }
  const got = installedVersion(piDir);
  if (!got) { console.error(`pilock: no Pi package at ${piDir}`); process.exit(1); }
  if (got !== piEntry.version) { console.error(`pilock: installed Pi is ${got}, the lock is for ${piEntry.version}; not applied`); process.exit(1); }
  for (const key of Object.keys(packages)) {
    if (key.startsWith(`${PI_KEY}/node_modules/`)) { console.error(`pilock: ${key} is nested under Pi in the lock; regenerate the lock`); process.exit(1); }
  }

  // Resolve the tree: a staged copy (tests) or `npm ci` of the wrapper beside Pi,
  // on the same volume so the final move is a rename. Lifecycle scripts run as
  // they do for `npm install -g` (@google/genai's preinstall, protobufjs's postinstall).
  const parent = path.dirname(piDir);
  removeStaleStages(parent);
  let stage = process.env.COOP_PILOCK_STAGED ? path.resolve(process.env.COOP_PILOCK_STAGED) : "";
  let ownStage = false;
  if (!stage) {
    stage = path.join(parent, `.coop-pi-stage-${process.pid}-${Date.now().toString(36)}`);
    ownStage = true;
    fs.mkdirSync(stage, { recursive: true });
    const root = packages[""] || {};
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: root.name || WRAPPER, private: true, dependencies: root.dependencies || {} }, null, 2) + "\n");
    fs.copyFileSync(lockPath, path.join(stage, "package-lock.json"));
    const r = spawnSync(npmBin(), ["ci", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) { rmrf(stage); console.error("pilock: npm ci of the Pi dependency tree failed; the installed tree is unchanged"); process.exit(1); }
  }
  const stagedNm = path.join(stage, "node_modules");
  const stagedPi = path.join(stagedNm, ...PI_AGENT.split("/"));
  if (!fs.existsSync(path.join(stagedPi, "package.json"))) { if (ownStage) rmrf(stage); console.error(`pilock: the staged tree has no ${PI_AGENT}`); process.exit(1); }
  if (fs.existsSync(path.join(stagedPi, "node_modules"))) { if (ownStage) rmrf(stage); console.error("pilock: the staged tree nests packages under Pi; regenerate the lock"); process.exit(1); }
  // The staged Pi is the lock's copy of a package already installed; only its
  // siblings move. The hidden lockfile describes the wrapper, not Pi: drop it.
  rmrf(stagedPi);
  const scope = path.dirname(stagedPi);
  try { if (fs.readdirSync(scope).length === 0) fs.rmdirSync(scope); } catch {}
  rmrf(path.join(stagedNm, ".package-lock.json"));

  const target = path.join(piDir, "node_modules");
  const old = path.join(piDir, "node_modules.coop-old");
  rmrf(old);
  if (fs.existsSync(target)) fs.renameSync(target, old);
  try {
    moveDir(stagedNm, target);
  } catch (e) {
    if (fs.existsSync(old) && !fs.existsSync(target)) fs.renameSync(old, target);
    if (ownStage) rmrf(stage);
    console.error(`pilock: could not move the resolved tree into ${target}: ${e.message}; the installed tree is unchanged`);
    process.exit(1);
  }
  rmrf(old);
  if (ownStage) rmrf(stage);
  // The marker only once the tree checks out, so a bad apply stays pending.
  const problems = treeProblems(piDir, lock);
  if (problems.length) { for (const p of problems.slice(0, 10)) console.error(`pilock: ${p}`); console.error("pilock: the applied tree does not match the lock"); process.exit(1); }
  fs.writeFileSync(path.join(target, MARKER), JSON.stringify({ lock_sha256: sha256File(lockPath), pi: piEntry.version, applied_at: new Date().toISOString() }, null, 2) + "\n");
  console.log(`pilock: Pi ${piEntry.version} runs the locked dependency tree (${Object.keys(packages).length - 2} packages)`);
}

module.exports = { wrapperPackageJson, checkLock, treeProblems, MARKER, DEFAULT_LOCK };

if (require.main !== module) return;
const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case "generate": generate(a || DEFAULT_MANIFEST, b || DEFAULT_LOCK); break;
  case "check": check(a || DEFAULT_MANIFEST, b || DEFAULT_LOCK); break;
  case "apply":
    if (!a) { console.error("usage: pilock.js apply <pi-dir> [lock]"); process.exit(2); }
    apply(a, b || DEFAULT_LOCK); break;
  case "matches":
    if (!a) { console.error("usage: pilock.js matches <pi-dir> [lock]"); process.exit(2); }
    matches(a, b || DEFAULT_LOCK); break;
  default:
    console.error("usage: pilock.js generate|check [manifest] [lock] | apply <pi-dir> [lock] | matches <pi-dir> [lock]");
    process.exit(2);
}
