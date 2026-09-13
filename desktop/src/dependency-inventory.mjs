import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { readDevelopmentSource, validateDevelopmentSource } from "./development-wheels.mjs";

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
// Distribution metadata uses PEP 440 (including post/dev releases), not semver.
const PYTHON_VERSION = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i;
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

function fail(message) { throw new Error(message); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(`${label} fields are invalid.`);
}
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function normalizeName(value) { return value.trim().toLowerCase().replace(/[-_.]+/g, "-"); }
function safePackagePath(value) {
  return typeof value === "string" && value.startsWith("node_modules/") && value.length <= 500 && !/[\\\x00-\x1f:]/.test(value) && !isAbsolute(value) && !win32.isAbsolute(value) && value.split("/").every(part => part && part !== "." && part !== "..");
}
function httpsResolved(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail(`${label} is missing or invalid.`); }
}

export function buildDependencyInventory({ npmPrefix, pythonTools, target } = {}) {
  if (!npmPrefix || !Array.isArray(pythonTools) || !pythonTools.length || !target || !new Set(["darwin", "win32"]).has(target.platform) || !new Set(["arm64", "x64"]).has(target.arch)) fail("Dependency inventory inputs are invalid.");
  const lock = readJson(join(npmPrefix, "node_modules", ".package-lock.json"), "Installed npm resolution lock");
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) fail("Installed npm resolution lock is incompatible.");
  const npmPackages = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!safePackagePath(path) || !entry || typeof entry !== "object" || !VERSION.test(entry.version || "") || !httpsResolved(entry.resolved) || (entry.integrity != null && !INTEGRITY.test(entry.integrity))) fail(`Installed npm resolution entry is invalid: ${path || "<missing>"}.`);
    const absolute = resolve(npmPrefix, path);
    if (!inside(resolve(npmPrefix), absolute)) fail(`Installed npm resolution path escapes its prefix: ${path}.`);
    const pkg = readJson(join(absolute, "package.json"), `Installed npm package ${path}`);
    if (!PACKAGE.test(pkg.name || "") || pkg.version !== entry.version) fail(`Installed npm package does not match its resolution entry: ${path}.`);
    npmPackages.push(Object.freeze({ path, name: pkg.name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity || null }));
  }
  npmPackages.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const tools = pythonTools.map((tool) => {
    if (!PACKAGE.test(tool?.name || "") || typeof tool.root !== "string") fail("Python dependency inventory tool is invalid.");
    const seen = new Set();
    const distributions = [];
    for (const entry of readdirSync(tool.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
      const metadataPath = join(tool.root, entry.name, "METADATA");
      if (!existsSync(metadataPath)) fail(`Python distribution metadata is missing: ${tool.name}/${entry.name}.`);
      const metadata = readFileSync(metadataPath, "utf8");
      const name = metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
      const version = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
      const normalized = normalizeName(name || "");
      if (!PACKAGE.test(name || "") || !PYTHON_VERSION.test(version || "") || seen.has(normalized)) fail(`Python distribution metadata is invalid or ambiguous: ${tool.name}/${entry.name}.`);
      seen.add(normalized);
      distributions.push(Object.freeze({ name, version, metadata: entry.name }));
    }
    if (!distributions.length) fail(`Python dependency inventory is empty: ${tool.name}.`);
    distributions.sort((left, right) => normalizeName(left.name).localeCompare(normalizeName(right.name), "en"));
    const developmentSource = readDevelopmentSource(tool.root);
    if (developmentSource && (developmentSource.name !== tool.name || !distributions.some(entry => normalizeName(entry.name) === tool.name && entry.version === developmentSource.version))) fail("Development wheel does not match its Python inventory tool.");
    return Object.freeze({ name: tool.name, distributions: Object.freeze(distributions), ...(developmentSource ? { developmentSource } : {}) });
  }).sort((left, right) => left.name.localeCompare(right.name, "en"));

  return Object.freeze({
    schemaVersion: 1,
    target: Object.freeze({ platform: target.platform, arch: target.arch }),
    npm: Object.freeze({ lockfileVersion: 3, completeIntegrity: npmPackages.every((entry) => entry.integrity !== null), packages: Object.freeze(npmPackages) }),
    python: Object.freeze({ tools: Object.freeze(tools) }),
  });
}

export function serializeDependencyInventory(value) { return `${JSON.stringify(value, null, 2)}\n`; }
export function dependencyInventoryDigest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function validateDependencyInventory(value, { platform, arch } = {}) {
  exactKeys(value, ["schemaVersion", "target", "npm", "python"], "Dependency inventory");
  exactKeys(value.target, ["platform", "arch"], "Dependency inventory target");
  exactKeys(value.npm, ["lockfileVersion", "completeIntegrity", "packages"], "Dependency inventory npm section");
  exactKeys(value.python, ["tools"], "Dependency inventory Python section");
  if (value.schemaVersion !== 1 || value.target.platform !== platform || value.target.arch !== arch || value.npm.lockfileVersion !== 3 || typeof value.npm.completeIntegrity !== "boolean" || !Array.isArray(value.npm.packages) || !Array.isArray(value.python.tools)) fail("Dependency inventory contract is incompatible.");
  let priorPath = "";
  for (const entry of value.npm.packages) {
    exactKeys(entry, ["path", "name", "version", "resolved", "integrity"], "Dependency inventory npm package");
    if (!safePackagePath(entry.path) || (priorPath && entry.path.localeCompare(priorPath, "en") <= 0) || !PACKAGE.test(entry.name || "") || !VERSION.test(entry.version || "") || !httpsResolved(entry.resolved) || (entry.integrity !== null && !INTEGRITY.test(entry.integrity))) fail("Dependency inventory npm package is invalid or unsorted.");
    priorPath = entry.path;
  }
  let priorTool = "";
  for (const tool of value.python.tools) {
    exactKeys(tool, ["name", "distributions", ...(Object.hasOwn(tool, "developmentSource") ? ["developmentSource"] : [])], "Dependency inventory Python tool");
    if (!PACKAGE.test(tool.name || "") || (priorTool && tool.name.localeCompare(priorTool, "en") <= 0) || !Array.isArray(tool.distributions) || !tool.distributions.length) fail("Dependency inventory Python tool is invalid or unsorted.");
    priorTool = tool.name;
    let priorName = "";
    for (const distribution of tool.distributions) {
      exactKeys(distribution, ["name", "version", "metadata"], "Dependency inventory Python distribution");
      const normalized = normalizeName(distribution.name || "");
      if (!PACKAGE.test(distribution.name || "") || !PYTHON_VERSION.test(distribution.version || "") || typeof distribution.metadata !== "string" || !/^[a-z0-9_.+!-]+\.dist-info$/i.test(distribution.metadata) || (priorName && normalized.localeCompare(priorName, "en") <= 0)) fail("Dependency inventory Python distribution is invalid or unsorted.");
      priorName = normalized;
    }
    if (Object.hasOwn(tool, "developmentSource")) {
      const source = validateDevelopmentSource(tool.developmentSource);
      if (source.name !== tool.name || !tool.distributions.some(entry => normalizeName(entry.name) === source.name && entry.version === source.version)) fail("Dependency inventory development source does not match its tool.");
    }
  }
  if (value.npm.completeIntegrity !== value.npm.packages.every((entry) => entry.integrity !== null)) fail("Dependency inventory npm integrity state is inconsistent.");
  return value;
}
