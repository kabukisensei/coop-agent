#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} is missing or invalid.`); }
}

function versionAtLeast(actual, minimum) {
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export function managedRuntimeBuildPlan(target) {
  if (!TARGETS.has(target)) throw new Error(`Unsupported managed-runtime build target: ${target || "<missing>"}.`);
  const release = readJson(resolve(ROOT, "config", "release-manifest.json"), "Release manifest");
  const build = readJson(resolve(ROOT, "config", "managed-runtime-build.json"), "Managed-runtime build configuration");
  if (build.schemaVersion !== 1 || !versionAtLeast(build.nodeVersion, release.node.min)) throw new Error("Managed Node pin is incompatible with the release manifest.");
  const source = build.sources?.[target];
  if (!source || !source.url.startsWith(`https://nodejs.org/download/release/v${build.nodeVersion}/`) || !source.file.includes(build.nodeVersion) || !/^[0-9a-f]{64}$/.test(source.sha256)) {
    throw new Error(`Managed Node source for ${target} is invalid.`);
  }
  const pythonSource = build.pythonSources?.[target];
  const pythonReleaseBase = `https://github.com/astral-sh/python-build-standalone/releases/download/${build.pythonBuildRelease}/`;
  if (!/^3\.12\.\d+$/.test(build.pythonVersion)
    || !/^\d{8}$/.test(build.pythonBuildRelease)
    || !pythonSource
    || !pythonSource.url.startsWith(pythonReleaseBase)
    || !pythonSource.file.includes(`cpython-${build.pythonVersion}+${build.pythonBuildRelease}-`)
    || pythonSource.archive !== "tar.gz"
    || pythonSource.root !== "python"
    || !/^[0-9a-f]{64}$/.test(pythonSource.sha256)) {
    throw new Error(`Managed Python source for ${target} is invalid.`);
  }
  const excluded = new Set(build.targetExclusions?.[target] || []);
  for (const name of excluded) if (!Object.hasOwn(release.npm_tools, name)) throw new Error(`Managed-runtime exclusion is not a release-manifest npm tool: ${name}.`);
  const npmSpecs = [
    `${release.pi.package}@${release.pi.version}`,
    ...Object.entries(release.extensions).map(([name, version]) => `${name}@${version}`),
    ...Object.entries(release.npm_tools).filter(([name]) => !excluded.has(name)).map(([name, version]) => `${name}@${version}`),
    ...Object.entries(release.mcp_servers).map(([name, version]) => `${name}@${version}`),
  ];
  const pipSpecs = Object.entries(release.python_tools).map(([name, version]) => `${name}==${version}`);
  const requiredPythonCommands = build.requiredPythonCommands;
  if (!Array.isArray(requiredPythonCommands) || !requiredPythonCommands.length || requiredPythonCommands.some((name) => !/^[A-Za-z0-9_.-]+$/.test(name)) || new Set(requiredPythonCommands).size !== requiredPythonCommands.length) {
    throw new Error("Managed-runtime required Python commands are invalid.");
  }
  if (new Set(npmSpecs).size !== npmSpecs.length || new Set(pipSpecs).size !== pipSpecs.length) throw new Error("Managed-runtime dependency plan contains duplicate exact specs.");
  return Object.freeze({
    schemaVersion: 1,
    target,
    node: Object.freeze({ version: build.nodeVersion, ...source }),
    python: Object.freeze({ version: build.pythonVersion, buildRelease: build.pythonBuildRelease, ...pythonSource }),
    npmSpecs: Object.freeze(npmSpecs),
    pipSpecs: Object.freeze(pipSpecs),
    requiredPythonCommands: Object.freeze([...requiredPythonCommands]),
    excludedNpmPackages: Object.freeze([...excluded].sort()),
    release: Object.freeze({ coop: release.coop_version, pi: release.pi.version, minimumNode: release.node.min }),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = process.argv[2] || `${process.platform}-${process.arch}`;
    process.stdout.write(`${JSON.stringify(managedRuntimeBuildPlan(target), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`managed-runtime-build-plan: ${error.message}\n`);
    process.exitCode = 1;
  }
}
