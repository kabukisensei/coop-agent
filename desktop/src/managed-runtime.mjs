import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { resolveCoopLauncher } from "./coop-launcher.mjs";
import { dependencyInventoryDigest, validateDependencyInventory } from "./dependency-inventory.mjs";

const PLATFORM = new Set(["darwin", "win32"]);
const ARCH = new Set(["arm64", "x64"]);
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function parseJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} is missing or invalid.`); }
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function bundlePath(root, value, label, kind = "file") {
  if (typeof value !== "string" || !value || value.length > 300 || isAbsolute(value) || win32.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`Managed runtime ${label} path is invalid.`);
  }
  const lexical = resolve(root, value);
  if (!inside(root, lexical)) throw new Error(`Managed runtime ${label} escapes the bundle.`);
  let actual;
  try { actual = realpathSync(lexical); }
  catch { throw new Error(`Managed runtime ${label} is missing.`); }
  if (!inside(root, actual)) throw new Error(`Managed runtime ${label} escapes the bundle.`);
  const stat = lstatSync(actual);
  if ((kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())) {
    throw new Error(`Managed runtime ${label} has the wrong type.`);
  }
  return actual;
}

function exactVersion(value, label) {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error(`Managed runtime ${label} version is invalid.`);
  return value;
}

function versionAtLeast(actual, minimum) {
  const a = actual.split(/[.-]/).slice(0, 3).map(Number);
  const b = minimum.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

function sameStringMap(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right)) return false;
  const a = Object.entries(left).sort(([x], [y]) => x.localeCompare(y));
  const b = Object.entries(right).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(a) === JSON.stringify(b);
}

export function inspectManagedRuntime(root, { platform = process.platform, arch = process.arch } = {}) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("Managed runtime root must be absolute.");
  let actualRoot;
  try { actualRoot = realpathSync(root); }
  catch { throw new Error("Managed runtime bundle is unavailable."); }
  const manifestPath = bundlePath(actualRoot, "manifest.json", "manifest");
  const manifest = parseJson(manifestPath, "Managed runtime manifest");
  if (manifest.schemaVersion !== 1 || !PLATFORM.has(manifest.target?.platform) || !ARCH.has(manifest.target?.arch)) {
    throw new Error("Managed runtime manifest contract is incompatible.");
  }
  if (manifest.target.platform !== platform || manifest.target.arch !== arch) {
    throw new Error(`Managed runtime targets ${manifest.target.platform}-${manifest.target.arch}, not ${platform}-${arch}.`);
  }
  const inventoryMeta = manifest.inventory;
  const expectedInventoryFields = ["path", "sha256", "npmPackages", "pythonDistributions", "completeNpmIntegrity"];
  if (!inventoryMeta || typeof inventoryMeta !== "object" || Array.isArray(inventoryMeta)
    || JSON.stringify(Object.keys(inventoryMeta).sort()) !== JSON.stringify(expectedInventoryFields.sort())
    || inventoryMeta.path !== "dependency-inventory.json" || !/^[0-9a-f]{64}$/.test(inventoryMeta.sha256 || "")
    || !Number.isSafeInteger(inventoryMeta.npmPackages) || inventoryMeta.npmPackages < 1
    || !Number.isSafeInteger(inventoryMeta.pythonDistributions) || inventoryMeta.pythonDistributions < 1
    || typeof inventoryMeta.completeNpmIntegrity !== "boolean") {
    throw new Error("Managed runtime dependency inventory metadata is invalid.");
  }
  const inventoryPath = bundlePath(actualRoot, inventoryMeta.path, "dependency inventory");
  const inventoryBytes = readFileSync(inventoryPath);
  if (dependencyInventoryDigest(inventoryBytes) !== inventoryMeta.sha256) throw new Error("Managed runtime dependency inventory checksum is invalid.");
  let dependencyInventory;
  try { dependencyInventory = validateDependencyInventory(JSON.parse(inventoryBytes.toString("utf8")), { platform, arch }); }
  catch { throw new Error("Managed runtime dependency inventory contract is invalid."); }
  const pythonDistributionCount = dependencyInventory.python.tools.reduce((total, tool) => total + tool.distributions.length, 0);
  if (dependencyInventory.npm.packages.length !== inventoryMeta.npmPackages || pythonDistributionCount !== inventoryMeta.pythonDistributions || dependencyInventory.npm.completeIntegrity !== inventoryMeta.completeNpmIntegrity) {
    throw new Error("Managed runtime dependency inventory counts are inconsistent.");
  }

  const coopRoot = bundlePath(actualRoot, manifest.paths?.coopRoot, "Coop root", "directory");
  const launcher = bundlePath(actualRoot, manifest.paths?.launcher, "launcher");
  const node = bundlePath(actualRoot, manifest.paths?.node, "Node executable");
  const nodeVersionFile = bundlePath(actualRoot, manifest.paths?.nodeVersionFile, "Node version record");
  const python = bundlePath(actualRoot, manifest.paths?.python, "Python executable");
  const pythonVersionFile = bundlePath(actualRoot, manifest.paths?.pythonVersionFile, "Python version record");
  const piPackage = bundlePath(actualRoot, manifest.paths?.piPackage, "Pi package manifest");
  const bundledReleasePath = bundlePath(actualRoot, relative(actualRoot, join(coopRoot, "config", "release-manifest.json")), "bundled Coop release manifest");
  const bundledBuildPath = bundlePath(actualRoot, relative(actualRoot, join(coopRoot, "config", "managed-runtime-build.json")), "bundled managed-runtime build configuration");
  const bundledVersionPath = bundlePath(actualRoot, relative(actualRoot, join(coopRoot, "VERSION")), "bundled Coop version");
  const bundledRelease = parseJson(bundledReleasePath, "Bundled Coop release manifest");
  const bundledBuild = parseJson(bundledBuildPath, "Bundled managed-runtime build configuration");
  const bundledCoopVersion = readFileSync(bundledVersionPath, "utf8").trim();
  const bundledPi = parseJson(piPackage, "Bundled Pi package manifest");
  const coopVersion = exactVersion(manifest.versions?.coop, "Coop");
  const piVersion = exactVersion(manifest.versions?.pi, "Pi");
  const nodeVersion = exactVersion(manifest.versions?.node, "Node");
  const pythonVersion = exactVersion(manifest.versions?.python, "Python");
  const pythonTools = manifest.versions?.pythonTools;
  const npmPackages = manifest.versions?.npmPackages;
  const recordedNodeVersion = readFileSync(nodeVersionFile, "utf8").trim().replace(/^v/, "");
  const recordedPythonVersion = readFileSync(pythonVersionFile, "utf8").trim().replace(/^Python\s+/i, "");
  const minimumNode = exactVersion(manifest.minimums?.node, "minimum Node");
  const minimumPython = exactVersion(manifest.minimums?.python, "minimum Python");
  if (bundledCoopVersion !== coopVersion || bundledRelease.coop_version !== coopVersion) throw new Error("Managed Coop version does not match its release metadata.");
  if (bundledRelease.pi?.version !== piVersion || bundledPi.version !== piVersion) throw new Error("Managed Pi version does not match the Coop release manifest.");
  if (recordedNodeVersion !== nodeVersion) throw new Error("Managed Node version does not match its staged version record.");
  if (recordedPythonVersion !== pythonVersion) throw new Error("Managed Python version does not match its staged version record.");
  if (bundledRelease.node?.min !== minimumNode) throw new Error("Managed Node minimum does not match the Coop release manifest.");
  if (bundledBuild.pythonVersion !== pythonVersion) throw new Error("Managed Python version does not match the bundled build configuration.");
  if (!versionAtLeast(nodeVersion, minimumNode)) throw new Error("Managed Node is older than the Coop release minimum.");
  if (!versionAtLeast(pythonVersion, minimumPython)) throw new Error("Managed Python is older than the bundle minimum.");
  if (!sameStringMap(pythonTools, bundledRelease.python_tools)) throw new Error("Managed Python tool versions do not match the Coop release manifest.");
  const targetKey = `${manifest.target.platform}-${manifest.target.arch}`;
  const excludedNpm = new Set(bundledBuild.targetExclusions?.[targetKey] || []);
  const expectedNpm = {
    [bundledRelease.pi.package]: bundledRelease.pi.version,
    ...bundledRelease.extensions,
    ...Object.fromEntries(Object.entries(bundledRelease.npm_tools || {}).filter(([name]) => !excludedNpm.has(name))),
    ...bundledRelease.mcp_servers,
  };
  if (!sameStringMap(npmPackages, expectedNpm)) throw new Error("Managed npm package versions do not match the target release plan.");
  for (const [name, expected] of Object.entries(expectedNpm)) {
    const packagePath = bundlePath(actualRoot, `npm/node_modules/${name}/package.json`, `npm package ${name}`);
    if (parseJson(packagePath, `Managed npm package ${name}`).version !== expected) throw new Error(`Managed npm package version is invalid: ${name}.`);
  }

  const executableDirs = Array.isArray(manifest.paths?.executableDirs)
    ? manifest.paths.executableDirs.map((value, index) => bundlePath(actualRoot, value, `executable directory ${index + 1}`, "directory"))
    : [];
  if (!executableDirs.some((value) => inside(value, node))) throw new Error("Managed Node is not inside an allowlisted executable directory.");
  const pythonCommands = Array.isArray(manifest.paths?.pythonCommands) ? manifest.paths.pythonCommands : [];
  if (!pythonCommands.length || pythonCommands.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value))) throw new Error("Managed Python command inventory is invalid.");
  for (const required of bundledBuild.requiredPythonCommands || []) if (!pythonCommands.includes(required)) throw new Error(`Managed Python command is missing: ${required}.`);
  const pythonToolRoots = manifest.paths?.pythonToolRoots;
  if (!pythonToolRoots || typeof pythonToolRoots !== "object" || Array.isArray(pythonToolRoots)) throw new Error("Managed Python tool roots are invalid.");
  if (JSON.stringify(Object.keys(pythonToolRoots).map((name) => name.toLowerCase()).sort()) !== JSON.stringify(Object.keys(pythonTools).map((name) => name.toLowerCase()).sort())) throw new Error("Managed Python tool root inventory does not match the release manifest.");
  const resolvedPythonToolRoots = Object.fromEntries(Object.entries(pythonToolRoots).map(([name, value]) => [name, bundlePath(actualRoot, value, `Python tool root ${name}`, "directory")]));
  for (const command of pythonCommands) bundlePath(actualRoot, `python/bin/${command}${platform === "win32" ? ".cmd" : ""}`, `Python command ${command}`);

  return Object.freeze({
    root: actualRoot,
    manifestPath,
    coopRoot,
    launcher,
    node,
    python,
    executableDirs: Object.freeze(executableDirs),
    pythonCommands: Object.freeze([...pythonCommands]),
    pythonToolRoots: Object.freeze(resolvedPythonToolRoots),
    dependencyInventory,
    versions: Object.freeze({ coop: coopVersion, pi: piVersion, node: nodeVersion, python: pythonVersion, npmPackages: Object.freeze({ ...npmPackages }), pythonTools: Object.freeze({ ...pythonTools }) }),
  });
}

export function managedDesktopAgentDir(userData, versions) {
  if (typeof userData !== "string" || !isAbsolute(userData) || /[\0\r\n]/.test(userData)) throw new Error("Desktop user-data path is invalid.");
  const coop = exactVersion(versions?.coop, "Coop");
  const pi = exactVersion(versions?.pi, "Pi");
  return join(userData, "managed-agent", `coop-${coop}-pi-${pi}`);
}

export function resolveDesktopCoopLauncher({
  explicit,
  packaged = false,
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  available,
} = {}) {
  if (explicit) return { ...resolveCoopLauncher(explicit, { platform, env, available }), source: "explicit", versions: null };
  const managedRoot = resourcesPath ? join(resourcesPath, "managed-runtime") : null;
  if (packaged && managedRoot && existsSync(managedRoot)) {
    const managed = inspectManagedRuntime(managedRoot, { platform, arch });
    return {
      ...resolveCoopLauncher(managed.launcher, { platform, env, available }),
      source: "managed",
      versions: managed.versions,
      managedRoot: managed.root,
    };
  }
  return { ...resolveCoopLauncher("coop", { platform, env, available }), source: "installed", versions: null };
}
