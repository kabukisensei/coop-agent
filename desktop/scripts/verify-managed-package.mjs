#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectManagedRuntime } from "../src/managed-runtime.mjs";

import { ensureUsageCompatibility } from "../../lib/openai-usage-compat.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const OFF = "0".charCodeAt(0);
const ON = "1".charCodeAt(0);
function expectedFuses(FuseV1Options) { return new Map([
  [FuseV1Options.RunAsNode, OFF],
  [FuseV1Options.EnableCookieEncryption, OFF],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, OFF],
  [FuseV1Options.EnableNodeCliInspectArguments, OFF],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, ON],
  [FuseV1Options.OnlyLoadAppFromAsar, ON],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, OFF],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, OFF],
]); }

function fail(message) { throw new Error(message); }
function parseArgs(argv) {
  let root = join(DESKTOP, "dist-managed");
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== "--root" || !argv[index + 1]) fail(`Unknown or incomplete argument: ${argv[index] || "<missing>"}.`);
    root = resolve(argv[index + 1]);
  }
  if (!isAbsolute(root)) fail("Packaged Desktop root must be absolute.");
  return root;
}

export function packagedPaths(root, platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    const app = join(root, `mac-${arch}`, "Coop Desktop.app");
    return Object.freeze({ fuseTarget: app, resources: join(app, "Contents", "Resources") });
  }
  if (platform === "win32" && arch === "x64") {
    const unpacked = join(root, "win-unpacked");
    return Object.freeze({ fuseTarget: join(unpacked, "Coop Desktop.exe"), resources: join(unpacked, "resources") });
  }
  fail(`Unsupported packaged Desktop verifier target: ${platform}-${arch}.`);
}

export async function verifyManagedPackage({ root, platform = process.platform, arch = process.arch } = {}) {
  // Build dependencies are needed only when inspecting an actual package.
  const { FuseV1Options, getCurrentFuseWire } = await import("@electron/fuses");
  const EXPECTED = expectedFuses(FuseV1Options);
  const paths = packagedPaths(resolve(root), platform, arch);
  for (const [label, path] of [["Electron target", paths.fuseTarget], ["resources directory", paths.resources]]) {
    if (!existsSync(path)) fail(`Packaged Desktop ${label} is missing.`);
  }
  const asar = join(paths.resources, "app.asar");
  if (!existsSync(asar) || !lstatSync(asar).isFile() || lstatSync(asar).isSymbolicLink()) fail("Packaged Desktop app.asar is missing or unsafe.");
  if (existsSync(join(paths.resources, "app")) || existsSync(join(paths.resources, "default_app.asar"))) fail("Packaged Desktop contains a loose application fallback.");
  const { extractFile } = await import("@electron/asar");
  function verifyImports(entry, read, seen = new Set()) {
    if (seen.has(entry)) return;
    seen.add(entry);
    let source;
    try { source = read(entry).toString("utf8"); }
    catch { fail(`Packaged Desktop module is missing: ${entry}`); }
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      verifyImports(posix.normalize(posix.join(posix.dirname(entry), match[1])), read, seen);
    }
  }
  verifyImports("src/main.mjs", entry => extractFile(asar, entry));
  verifyImports("update-helper.mjs", entry => readFileSync(join(paths.resources, "update-helper", entry)));
  const wire = await getCurrentFuseWire(paths.fuseTarget);
  if (wire.version !== "1") fail("Packaged Desktop fuse version is incompatible.");
  for (const [option, expected] of EXPECTED) {
    if (wire[option] !== expected) fail(`Packaged Desktop fuse ${FuseV1Options[option]} is not in the required state.`);
  }
  const managedRoot = join(paths.resources, "managed-runtime");
  const managed = inspectManagedRuntime(managedRoot, { platform, arch });
  const usageCorrection = ensureUsageCompatibility(join(managedRoot, "npm/node_modules/pi-better-openai"), { check: true });
  const corrections = JSON.parse(readFileSync(join(managedRoot, "coop-compatibility.json"), "utf8"));
  if (JSON.stringify(corrections) !== JSON.stringify([usageCorrection])) fail("Packaged compatibility receipt does not match the installed correction.");
  return Object.freeze({
    compatibilityPatches: corrections,
    ok: true,
    target: `${platform}-${arch}`,
    appAsar: asar,
    managedRuntime: managedRoot,
    versions: managed.versions,
    developmentSources: managed.dependencyInventory.python.tools.flatMap(tool => tool.developmentSource ? [tool.developmentSource] : []),
    fuses: Object.freeze(Object.fromEntries([...EXPECTED].map(([option, state]) => [FuseV1Options[option], state === ON ? "enabled" : "disabled"]))),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyManagedPackage({ root: parseArgs(process.argv.slice(2)) })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`verify-managed-package: ${error.message}\n`); process.exitCode = 1; });
}
