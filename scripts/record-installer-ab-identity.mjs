#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packagedPaths } from "../desktop/scripts/verify-managed-package.mjs";

const CANDIDATE = "ed516b2a183f3e6346344a669d6e37b321a4dcf8";
function fail(message) { throw new Error(message); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function packageVersion(name) { return JSON.parse(readFileSync(resolve("desktop/node_modules", name, "package.json"), "utf8")).version; }
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) fail(`Unknown or incomplete argument: ${argv[i] || "<missing>"}`);
    values[argv[i].slice(2)] = argv[i + 1];
  }
  if (!/^(control|treatment)$/.test(values.label || "")) fail("--label must be control or treatment.");
  if (!/^26\.15\.(3|6)$/.test(values.builder || "")) fail("--builder must be 26.15.3 or 26.15.6.");
  if (values.compression && !/^(lzma|zip)$/.test(values.compression)) fail("--compression must be lzma or zip when provided.");
  if (values.compression === "zip" && !values["effective-config"]) fail("--effective-config is required for zip treatment.");
  if (!values.output) fail("--output is required.");
  return values;
}
function treeStats(root) {
  const state = { files: 0, directories: 0, bytes: 0 };
  const walk = directory => {
    state.directories += 1;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { state.files += 1; state.bytes += statSync(path).size; }
    }
  };
  walk(root);
  return state;
}
function archiveInventory(installer) {
  const text = execFileSync("7z", ["l", "-slt", installer], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const entries = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const item = {};
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^([^=]+) = (.*)$/);
      if (match) item[match[1].trim()] = match[2].trim();
    }
    if (item.Path && (item.Size || item.Folder)) entries.push({
      path: item.Path,
      folder: item.Folder === "+",
      size: item.Size ? Number(item.Size) : null,
      packedSize: item["Packed Size"] ? Number(item["Packed Size"]) : null,
      method: item.Method || null,
      crc: item.CRC || null,
    });
  }
  if (!entries.length) fail("7-Zip did not expose installer archive entries.");
  return entries;
}

const options = parseArgs(process.argv.slice(2));
const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
if (candidate !== CANDIDATE) fail(`Expected exact candidate ${CANDIDATE}, got ${candidate}.`);
const actualBuilder = packageVersion("electron-builder");
const actualElectron = packageVersion("electron");
if (actualBuilder !== options.builder) fail(`Expected electron-builder ${options.builder}, got ${actualBuilder}.`);
if (actualElectron !== "44.2.0") fail(`Electron changed: expected 44.2.0, got ${actualElectron}.`);
const builderFamily = Object.fromEntries(["electron-builder", "app-builder-lib", "dmg-builder", "electron-builder-squirrel-windows", "builder-util", "builder-util-runtime"].map(name => [name, packageVersion(name)]));
const packaged = packagedPaths(resolve("desktop/dist-installers"));
const installers = readdirSync("desktop/dist-installers").filter(name => /^Coop-Desktop-.*\.exe$/i.test(name));
if (installers.length !== 1) fail(`Expected one installer, found ${installers.length}.`);
const installer = resolve("desktop/dist-installers", installers[0]);
const managed = join(packaged.resources, "managed-runtime");
const identity = {
  schemaVersion: 1,
  diagnosticOnly: true,
  releaseAcceptance: false,
  runtimeGateClaimedPassed: false,
  abLabel: options.label,
  compressionTreatment: options.compression || null,
  productCandidateSha: candidate,
  productCandidateTree: tree,
  target: `${process.platform}-${process.arch}`,
  electronVersion: actualElectron,
  electronBuilderVersion: actualBuilder,
  builderFamily,
  nsisConfig: {
    managedConfigSha256: sha256("desktop/electron-builder-managed.cjs"),
    installerConfigSha256: sha256("desktop/electron-builder-installer.cjs"),
  },
  checksums: {
    releaseManifestSha256: sha256("config/release-manifest.json"),
    developmentCompanionsSha256: sha256("config/development-companions.json"),
    desktopPackageLockSha256: sha256("desktop/package-lock.json"),
    managedRuntimeManifestSha256: sha256(join(managed, "manifest.json")),
    managedRuntimeInventorySha256: sha256(join(managed, "dependency-inventory.json")),
    packagedAppAsarSha256: sha256(join(packaged.resources, "app.asar")),
    packagedExecutableSha256: sha256(packaged.fuseTarget),
    installerSha256: sha256(installer),
    effectiveConfigSha256: options["effective-config"] ? sha256(resolve(options["effective-config"])) : null,
  },
  characteristics: {
    packagedResources: treeStats(packaged.resources),
    managedRuntime: treeStats(managed),
    appAsarBytes: statSync(join(packaged.resources, "app.asar")).size,
    packagedExecutableBytes: statSync(packaged.fuseTarget).size,
    installerBytes: statSync(installer).size,
    installerArchive: archiveInventory(installer),
  },
  installer: { filename: installers[0], size: statSync(installer).size },
};
writeFileSync(resolve(options.output), `${JSON.stringify(identity, null, 2)}\n`);
console.log(JSON.stringify({ label: options.label, builder: actualBuilder, electron: actualElectron, installer: identity.installer, sha256: identity.checksums.installerSha256 }));
