// config/pi-lock.json pins Pi's OWN dependency tree (master plan row U3): the
// committed lock agrees with the manifest's Pi, `matches` reads an installed
// tree against it, and `apply` moves a resolved tree into Pi's node_modules
// (the staged-tree seam stands in for `npm ci`). Offline; nothing is resolved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { checkLock, treeProblems, wrapperPackageJson, MARKER } = require(join(ROOT, "lib", "pilock.js"));
const PILOCK = join(ROOT, "lib", "pilock.js");
const LOCK = join(ROOT, "config", "pi-lock.json");
const manifest = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));
const lock = JSON.parse(readFileSync(LOCK, "utf8"));
const PI = "@earendil-works/pi-coding-agent";

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [PILOCK, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// --- the committed lock -------------------------------------------------------
assert.deepEqual(checkLock(manifest, lock), [], "config/pi-lock.json agrees with the manifest (regenerate: node lib/pilock.js generate)");
assert.equal(lock.packages[`node_modules/${PI}`].version, manifest.pi.version);
assert.equal(wrapperPackageJson(manifest).dependencies[PI], manifest.pi.version);
assert.ok(lock.packages["node_modules/@earendil-works/pi-codemode"], "the lock carries pi-codemode, the package that broke fresh installs");
assert.equal(run(["check"]).code, 0);
const drifted = JSON.parse(JSON.stringify(lock));
drifted.packages[""].dependencies[PI] = "0.0.1";
assert.ok(checkLock(manifest, drifted).some((p) => p.includes("lock root pins")), "a root pin off the manifest is reported");
const nested = JSON.parse(JSON.stringify(lock));
nested.packages[`node_modules/${PI}/node_modules/yaml`] = { version: "1.0.0" };
assert.ok(checkLock(manifest, nested).some((p) => p.includes("nested under Pi")), "a package nested under Pi is refused (apply moves siblings only)");

// --- a fake installed Pi and a fake staged tree ---------------------------------
// A small lock: Pi plus two hoisted dependencies, one with a nested conflict.
const small = {
  name: "coop-pi-runtime", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "coop-pi-runtime", dependencies: { [PI]: "9.9.9" } },
    [`node_modules/${PI}`]: { version: "9.9.9" },
    "node_modules/yaml": { version: "2.0.0" },
    "node_modules/@scope/dep": { version: "1.0.0" },
    "node_modules/@scope/dep/node_modules/yaml": { version: "1.5.0" },
  },
};
const tmp = mkdtempSync(join(tmpdir(), "coop-pilock-test-"));
try {
  const smallLock = join(tmp, "pi-lock.json");
  writeFileSync(smallLock, JSON.stringify(small, null, 2));
  const pkg = (dir, name, version) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version })); };
  const root = join(tmp, "global", "node_modules");
  const piDir = join(root, "@earendil-works", "pi-coding-agent");
  pkg(piDir, PI, "9.9.9");
  // What `npm install -g` left: a floating yaml 2.1.0 and a stray package.
  pkg(join(piDir, "node_modules", "yaml"), "yaml", "2.1.0");
  pkg(join(piDir, "node_modules", "@scope", "dep"), "@scope/dep", "1.0.0");
  pkg(join(piDir, "node_modules", "@scope", "dep", "node_modules", "yaml"), "yaml", "1.5.0");
  pkg(join(piDir, "node_modules", "stray"), "stray", "0.1.0");
  const before = treeProblems(piDir, small);
  assert.ok(before.some((p) => p.includes("node_modules/yaml is 2.1.0, lock has 2.0.0")), before.join("; "));
  assert.ok(before.some((p) => p.includes("node_modules/stray is installed but not in the lock")), before.join("; "));
  assert.equal(run(["matches", piDir, smallLock]).code, 1);

  // The staged tree: the wrapper's node_modules, Pi hoisted beside its dependencies.
  const stage = join(tmp, "stage");
  pkg(join(stage, "node_modules", "@earendil-works", "pi-coding-agent"), PI, "9.9.9");
  pkg(join(stage, "node_modules", "yaml"), "yaml", "2.0.0");
  pkg(join(stage, "node_modules", "@scope", "dep"), "@scope/dep", "1.0.0");
  pkg(join(stage, "node_modules", "@scope", "dep", "node_modules", "yaml"), "yaml", "1.5.0");
  writeFileSync(join(stage, "node_modules", ".package-lock.json"), "{}");
  const applied = run(["apply", piDir, smallLock], { COOP_PILOCK_STAGED: stage });
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /runs the locked dependency tree/);
  assert.equal(treeProblems(piDir, small).length, 0, treeProblems(piDir, small).join("; "));
  assert.equal(run(["matches", piDir, smallLock]).code, 0);
  assert.ok(!existsSync(join(piDir, "node_modules", "stray")), "the floating tree is replaced, not merged");
  assert.ok(!existsSync(join(piDir, "node_modules", "@earendil-works", "pi-coding-agent")), "the staged copy of Pi does not nest under the installed Pi");
  assert.ok(!existsSync(join(piDir, "node_modules", ".package-lock.json")), "the wrapper's hidden lockfile does not travel");
  assert.ok(!existsSync(join(piDir, "node_modules.coop-old")), "the old tree is gone");
  const marker = JSON.parse(readFileSync(join(piDir, "node_modules", MARKER), "utf8"));
  assert.equal(marker.pi, "9.9.9");
  assert.match(marker.lock_sha256, /^[0-9A-F]{64}$/);
  assert.equal(readFileSync(join(piDir, "package.json"), "utf8"), JSON.stringify({ name: PI, version: "9.9.9" }), "Pi's own files are untouched");

  // The lock is for one Pi version: another installed Pi is refused, tree unchanged.
  writeFileSync(join(piDir, "package.json"), JSON.stringify({ name: PI, version: "9.9.8" }));
  const refused = run(["apply", piDir, smallLock], { COOP_PILOCK_STAGED: stage });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /installed Pi is 9.9.8, the lock is for 9.9.9/);
  assert.ok(existsSync(join(piDir, "node_modules", "yaml")), "a refused apply leaves the tree alone");

  // Usage errors exit 2.
  assert.equal(run([]).code, 2);
  assert.equal(run(["apply"]).code, 2);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("  ✓ pilock tests passed");
