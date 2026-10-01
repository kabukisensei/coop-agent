#!/usr/bin/env node
/**
 * coop's isolated extension tree lockfile (issue #152).
 *
 * Every top-level pin is exact (config/release-manifest.json), but until this
 * file existed nothing pinned the TRANSITIVE dependencies of the isolated tree
 * (~/.coop/agent/npm): each machine resolved "latest in range" on the day it
 * synced, so two machines on one coop release could run different code.
 *
 * config/extensions-lock.json is npm's package-lock.json (lockfileVersion 3)
 * for the manifest's extension set, resolved with the same overrides
 * lib/_extdeps.py writes (pi-ai, pi-tui and the agent peer pinned to the
 * manifest's Pi). `coop sync` copies it next to the tree's package.json and runs
 * `npm ci`, so every machine on a release installs the same transitive versions.
 *
 * usage:
 *   node lib/extlock.js generate [manifest] [out]   regenerate the lock (network)
 *   node lib/extlock.js check    [manifest] [lock]  lock agrees with the manifest
 *   node lib/extlock.js matches  <agent-dir> [lock] tree's package.json fits the lock
 *
 * `check` and `matches` are offline and print one reason per mismatch; exit 0
 * when consistent, 1 when not, 2 on bad usage or an unreadable file.
 * Shared by lib/common.sh and lib/common.ps1 (one implementation, no twin).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(ROOT, "config", "release-manifest.json");
const DEFAULT_LOCK = path.join(ROOT, "config", "extensions-lock.json");
const PI_AI = "@earendil-works/pi-ai";
const PI_TUI = "@earendil-works/pi-tui";
const PI_AGENT = "@earendil-works/pi-coding-agent";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`extlock: cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
}

// The package.json the isolated tree converges to: exact extension pins plus the
// shared-library overrides (the same block lib/_extdeps.py writes on sync).
function treePackageJson(manifest) {
  const pi = manifest.pi && manifest.pi.version;
  if (!pi) { console.error("extlock: manifest has no pi.version"); process.exit(2); }
  const deps = {};
  for (const name of Object.keys(manifest.extensions || {}).sort()) deps[name] = manifest.extensions[name];
  return {
    name: "pi-extensions",
    private: true,
    dependencies: deps,
    overrides: { [PI_AI]: pi, [PI_TUI]: pi, [PI_AGENT]: pi },
  };
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function generate(manifestPath, outPath) {
  const manifest = readJson(manifestPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coop-extlock-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify(treePackageJson(manifest), null, 2) + "\n");
    const r = spawnSync(npmBin(), ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: tmp, stdio: "inherit", shell: process.platform === "win32",
    });
    if (r.status !== 0) { console.error("extlock: npm install --package-lock-only failed"); process.exit(1); }
    const lock = readJson(path.join(tmp, "package-lock.json"));
    fs.writeFileSync(outPath, JSON.stringify(lock, null, 2) + "\n");
    const problems = checkLock(manifest, lock);
    if (problems.length) { for (const p of problems) console.error(`extlock: ${p}`); process.exit(1); }
    console.log(`extlock: wrote ${path.relative(process.cwd(), outPath) || outPath} (${Object.keys(lock.packages || {}).length - 1} packages, Pi ${manifest.pi.version})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Reasons the lock disagrees with the manifest (empty = consistent).
function checkLock(manifest, lock) {
  const problems = [];
  const want = treePackageJson(manifest);
  const packages = (lock && lock.packages) || {};
  const root = packages[""] || {};
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3`);
  const have = root.dependencies || {};
  for (const [name, ver] of Object.entries(want.dependencies)) {
    if (!(name in have)) problems.push(`lock root is missing extension ${name}@${ver}`);
    else if (have[name] !== ver) problems.push(`lock root pins ${name}@${have[name]}, manifest says ${ver}`);
    const entry = packages[`node_modules/${name}`];
    if (!entry) problems.push(`lock has no node_modules/${name} entry`);
    else if (entry.version !== ver) problems.push(`lock installs ${name}@${entry.version}, manifest says ${ver}`);
  }
  for (const name of Object.keys(have)) {
    if (!(name in want.dependencies)) problems.push(`lock root carries ${name}, which the manifest does not list`);
  }
  for (const [name, ver] of Object.entries(want.overrides)) {
    for (const [key, entry] of Object.entries(packages)) {
      if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) {
        if (entry.version !== ver) problems.push(`${key} is ${entry.version}, but the manifest's Pi is ${ver}`);
      }
    }
  }
  return problems;
}

function check(manifestPath, lockPath) {
  const problems = checkLock(readJson(manifestPath), readJson(lockPath));
  if (problems.length) {
    for (const p of problems) console.error(`extlock: ${p}`);
    console.error("extlock: regenerate with: node lib/extlock.js generate");
    process.exit(1);
  }
  console.log("extlock: lock matches the manifest");
}

// Can `npm ci` apply this lock to the tree? Only when the tree's package.json
// declares exactly the lock's root dependencies (a stale extra extension or a
// different pin makes npm ci refuse), and the overrides match the lock's Pi.
function matches(agentDir, lockPath) {
  const pj = path.join(String(agentDir).replace(/\\+/g, "/"), "npm", "package.json");
  if (!fs.existsSync(pj)) { console.error(`extlock: no ${pj}`); process.exit(1); }
  const tree = readJson(pj);
  const lock = readJson(lockPath);
  const want = ((lock.packages || {})[""] || {}).dependencies || {};
  const have = tree.dependencies || {};
  const problems = [];
  for (const [name, ver] of Object.entries(want)) {
    if (have[name] !== ver) problems.push(`tree declares ${name}@${have[name] || "(absent)"}, lock has ${ver}`);
  }
  for (const name of Object.keys(have)) {
    if (!(name in want)) problems.push(`tree declares ${name}, which the lock does not carry`);
  }
  const lockPi = ((lock.packages || {})[`node_modules/${PI_AI}`] || {}).version;
  const ovr = tree.overrides || {};
  for (const name of [PI_AI, PI_TUI, PI_AGENT]) {
    if (lockPi && ovr[name] && ovr[name] !== lockPi) problems.push(`tree overrides ${name} to ${ovr[name]}, lock resolves ${lockPi}`);
  }
  if (problems.length) { for (const p of problems) console.error(`extlock: ${p}`); process.exit(1); }
}

const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case "generate": generate(a || DEFAULT_MANIFEST, b || DEFAULT_LOCK); break;
  case "check": check(a || DEFAULT_MANIFEST, b || DEFAULT_LOCK); break;
  case "matches":
    if (!a) { console.error("usage: extlock.js matches <agent-dir> [lock]"); process.exit(2); }
    matches(a, b || DEFAULT_LOCK); break;
  default:
    console.error("usage: extlock.js generate|check [manifest] [lock] | matches <agent-dir> [lock]");
    process.exit(2);
}
