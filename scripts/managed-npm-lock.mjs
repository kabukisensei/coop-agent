import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);
const ordered = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
const fail = message => { throw new Error(`Managed npm resolution: ${message}`); };

function nativeDependencyPaths(lock, target) {
  const [platform, arch] = target.split("-");
  const names = platform === "win32" ? "(?:win32|windows)" : "(?:darwin|macos)";
  const pattern = new RegExp(`-${names}-${arch}(?:-|$)`);
  const required = new Set();
  for (const [parent, entry] of Object.entries(lock.packages)) {
    for (const [name, version] of Object.entries(entry.optionalDependencies || {})) {
      if (!pattern.test(name)) continue;
      let base = parent, found;
      for (;;) {
        const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
        if (lock.packages[candidate]) { found = candidate; break; }
        const boundary = base.lastIndexOf("node_modules/");
        if (boundary < 0) break;
        base = base.slice(0, boundary).replace(/\/$/, "");
      }
      if (!found || lock.packages[found].version !== version) fail(`target-native dependency is missing or mismatched: ${name}.`);
      required.add(found);
    }
  }
  return [...required].sort();
}

export function loadManagedNpmLock(plan, path) {
  if (!TARGETS.has(plan.target)) fail("unsupported target.");
  const bytes = readFileSync(path || join(ROOT, "config", "managed-npm", `${plan.target}.package-lock.json`));
  const lock = JSON.parse(bytes);
  const dependencies = Object.fromEntries(plan.npmSpecs.map(spec => [spec.slice(0, spec.lastIndexOf("@")), spec.slice(spec.lastIndexOf("@") + 1)]));
  const packageJson = { name: "coop-managed-runtime", version: "0.0.0", private: true, dependencies };
  if (lock.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages) ||
      lock.name !== packageJson.name || lock.version !== packageJson.version ||
      ordered(lock.packages[""]?.dependencies) !== ordered(dependencies)) fail("lock does not match the release manifest; refresh it explicitly.");
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === "") continue;
    if (!name.startsWith("node_modules/") || /[\\\x00-\x1f:]/.test(name) || name.split("/").some(part => !part || part === "." || part === "..") ||
        !entry || entry.link || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version) ||
        !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || "")) fail(`invalid or unhashed entry ${name}.`);
    let url;
    try { url = new URL(entry.resolved); } catch { fail(`invalid archive URL for ${name}.`); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) fail(`invalid archive URL for ${name}.`);
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (lock.packages[`node_modules/${name}`]?.version !== version) fail(`top-level pin differs for ${name}.`);
  }
  return { lock, bytes, packageJson, nativeDependencies: nativeDependencyPaths(lock, plan.target), sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function writeManagedNpmInputs(prefix, resolution) {
  mkdirSync(prefix); // Fresh, exclusive prefix: never replace an existing install.
  writeFileSync(join(prefix, "package.json"), JSON.stringify(resolution.packageJson, null, 2) + "\n", { flag: "wx" });
  writeFileSync(join(prefix, "package-lock.json"), resolution.bytes, { flag: "wx" });
}

export function verifyManagedNpmResolution(prefix, resolution) {
  const installed = JSON.parse(readFileSync(join(prefix, "node_modules", ".package-lock.json")));
  if (installed.lockfileVersion !== 3 || !installed.packages || Array.isArray(installed.packages)) fail("installed lock is invalid.");
  // npm's upstream shrinkwrap handling can add optional platform packages or
  // omit integrity even during ci. Reconcile every installed entry after archive
  // completion, so that behavior cannot silently change our committed resolution.
  for (const [name, entry] of Object.entries(installed.packages)) {
    const expected = resolution.lock.packages[name];
    if (!expected || ["version", "resolved", "integrity"].some(field => entry?.[field] !== expected[field])) fail(`installed dependency differs at ${name}.`);
  }
  for (const [name, entry] of Object.entries(resolution.lock.packages)) {
    if (name && !entry.optional && !installed.packages[name]) fail(`required dependency is missing at ${name}.`);
  }
  for (const name of resolution.nativeDependencies) {
    if (!installed.packages[name]) fail(`target-native dependency was not installed: ${name}.`);
  }
  if (!readFileSync(join(prefix, "package-lock.json")).equals(resolution.bytes)) fail("resolution lock changed during installation.");
  return { packages: Object.keys(installed.packages).length, sha256: resolution.sha256 };
}
