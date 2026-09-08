#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { managedRuntimeBuildPlan } from "./managed-runtime-build-plan.mjs";
import { buildDependencyInventory, dependencyInventoryDigest, serializeDependencyInventory } from "../desktop/src/dependency-inventory.mjs";

import { ensureMcpIsolationCompatibility } from "../lib/mcp-isolation-compat.mjs";
import { ensureUsageCompatibility } from "../lib/openai-usage-compat.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COOP_FILES = ["bin", "config", "docs", "extensions", "lib", "prompts", "scripts", "skills", "themes", "vibes", "web", "LICENSE", "VERSION"];

function die(message) { throw new Error(message); }
function normalizeName(value) { return value.trim().toLowerCase().replace(/[-_.]+/g, "-"); }
function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function parseArgs(argv) {
  const result = { pythonTools: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--python-tool") {
      if (!value || !value.includes("=")) die("--python-tool requires name=path.");
      const separator = value.indexOf("=");
      const name = value.slice(0, separator);
      const path = value.slice(separator + 1);
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || !path) die("--python-tool requires a safe distribution name and path.");
      result.pythonTools.push({ name, root: resolve(path) });
      i += 1;
      continue;
    }
    if (new Set(["--output", "--node-root", "--npm-prefix", "--python-root"]).has(key)) {
      if (!value) die(`${key} requires a path.`);
      result[key.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = resolve(value);
      i += 1;
      continue;
    }
    die(`Unknown argument: ${key}`);
  }
  for (const key of ["output", "nodeRoot", "npmPrefix", "pythonRoot"]) if (!result[key]) die(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`);
  if (!result.pythonTools.length) die("At least one --python-tool is required.");
  if (new Set(result.pythonTools.map(({ name }) => normalizeName(name))).size !== result.pythonTools.length) die("Duplicate --python-tool distribution names are not allowed.");
  return result;
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { die(`${label} is missing or invalid: ${path}`); }
}

function assertInternalSymlinks(root) {
  const actualRoot = realpathSync(root);
  const pending = [actualRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!within(actualRoot, target)) die(`External symlink is not allowed in managed runtime input: ${path}`);
      } else if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile()) die(`Unsupported filesystem entry in managed runtime input: ${path}`);
    }
  }
}

function copyTree(source, destination) {
  if (!existsSync(source)) die(`Managed runtime input is missing: ${source}`);
  assertInternalSymlinks(source);
  cpSync(source, destination, { recursive: true, dereference: true, preserveTimestamps: true });
  const actualRoot = realpathSync(source);
  const pending = [actualRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const sourcePath = join(current, entry.name);
      if (entry.isDirectory()) { pending.push(sourcePath); continue; }
      if (!entry.isSymbolicLink()) continue;
      const sourceTarget = realpathSync(sourcePath);
      const destinationPath = join(destination, relative(actualRoot, sourcePath));
      const destinationTarget = join(destination, relative(actualRoot, sourceTarget));
      const relativeTarget = relative(dirname(destinationPath), destinationTarget);
      rmSync(destinationPath, { recursive: true, force: true });
      const targetType = process.platform === "win32" ? (statSync(sourceTarget).isDirectory() ? "dir" : "file") : undefined;
      symlinkSync(relativeTarget, destinationPath, targetType);
    }
  }
}

function removePythonCaches(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name === "__pycache__" || /\.py[co]$/.test(entry.name)) rmSync(path, { recursive: true, force: true });
    else if (entry.isDirectory()) removePythonCaches(path);
  }
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.error || result.status !== 0) die(`Could not verify runtime executable: ${command}`);
  const match = `${result.stdout || ""}\n${result.stderr || ""}`.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  if (!match) die(`Runtime executable did not report a semantic version: ${command}`);
  return match[1];
}

function versionAtLeast(actual, minimum) {
  const a = actual.split(/[.-]/).slice(0, 3).map(Number);
  const b = minimum.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}

function distributionVersions(root) {
  const versions = new Map();
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".dist-info")) {
          const metadata = join(path, "METADATA");
          if (!existsSync(metadata)) continue;
          const text = readFileSync(metadata, "utf8");
          const name = text.match(/^Name:\s*(.+)$/mi)?.[1];
          const version = text.match(/^Version:\s*(.+)$/mi)?.[1];
          if (name && version) versions.set(normalizeName(name), version.trim());
        } else if (!new Set(["__pycache__", ".git"]).has(entry.name)) pending.push(path);
      }
    }
  }
  return versions;
}

function distributionDirectory(root, distribution) {
  const expected = normalizeName(distribution);
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".dist-info")) {
        const metadata = join(path, "METADATA");
        if (!existsSync(metadata)) continue;
        const name = readFileSync(metadata, "utf8").match(/^Name:\s*(.+)$/mi)?.[1];
        if (name && normalizeName(name) === expected) return path;
      } else if (!new Set(["__pycache__", ".git"]).has(entry.name)) pending.push(path);
    }
  }
  return null;
}

function consoleEntryPoints(root, distribution) {
  const info = distributionDirectory(root, distribution);
  if (!info) die(`Python distribution metadata is missing for ${distribution}.`);
  const path = join(info, "entry_points.txt");
  if (!existsSync(path)) return [];
  const result = [];
  let section = "";
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) { section = header[1]; continue; }
    if (section !== "console_scripts") continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*):([A-Za-z_][A-Za-z0-9_.]*)(?:\s*\[[^\]]+\])?$/);
    if (!match) die(`Unsupported console entry point in ${path}: ${line}`);
    result.push({ command: match[1], module: match[2], callable: match[3] });
  }
  return result;
}

function writePythonLaunchers(root, platform, tools, requiredCommands) {
  const pythonBin = join(root, "python", "bin");
  const entrypointRoot = join(root, "python", "entrypoints");
  mkdirSync(pythonBin, { recursive: true });
  mkdirSync(entrypointRoot, { recursive: true });
  if (platform === "darwin") {
    writeFileSync(join(pythonBin, "python3"), `#!/usr/bin/env bash\nset -euo pipefail\nruntime_root="$(cd -P "$(dirname "${"${BASH_SOURCE[0]}"}")/../.." && pwd)"\nexec "$runtime_root/python/runtime/bin/python3" "$@"\n`, { mode: 0o755 });
  } else {
    writeFileSync(join(pythonBin, "python3.cmd"), "@echo off\r\n\"%~dp0..\\runtime\\python.exe\" %*\r\n");
    writeFileSync(join(pythonBin, "python.cmd"), "@echo off\r\n\"%~dp0..\\runtime\\python.exe\" %*\r\n");
    writeFileSync(join(pythonBin, "python3.ps1"), "\uFEFF$pythonRoot = Split-Path -Parent $PSScriptRoot\n& \"$pythonRoot\\runtime\\python.exe\" @args\nexit $LASTEXITCODE\n");
    writeFileSync(join(pythonBin, "python.ps1"), "\uFEFF$pythonRoot = Split-Path -Parent $PSScriptRoot\n& \"$pythonRoot\\runtime\\python.exe\" @args\nexit $LASTEXITCODE\n");
  }
  const commands = new Map();
  for (const tool of tools) {
    for (const entry of consoleEntryPoints(tool.source, tool.name)) {
      if (commands.has(entry.command)) die(`Duplicate Python console command in managed runtime: ${entry.command}`);
      commands.set(entry.command, { ...entry, tool: tool.name });
    }
  }
  for (const command of requiredCommands) if (!commands.has(command)) die(`Required Python command is missing from managed packages: ${command}.`);
  for (const [command, entry] of commands) {
    const runnerName = `${command}.py`;
    const runner = [
      "import importlib",
      "import os",
      "import sys",
      `tool_root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'tools', ${JSON.stringify(entry.tool)}, 'site-packages'))`,
      "sys.path.insert(0, tool_root)",
      `target = importlib.import_module(${JSON.stringify(entry.module)})`,
      `for part in ${JSON.stringify(entry.callable)}.split('.'):` ,
      "    target = getattr(target, part)",
      "raise SystemExit(target())",
      "",
    ].join("\n");
    writeFileSync(join(entrypointRoot, runnerName), runner);
    if (platform === "darwin") {
      writeFileSync(join(pythonBin, command), `#!/usr/bin/env bash\nset -euo pipefail\nruntime_root="$(cd -P "$(dirname "${"${BASH_SOURCE[0]}"}")/../.." && pwd)"\nexec "$runtime_root/python/runtime/bin/python3" "$runtime_root/python/entrypoints/${runnerName}" "$@"\n`, { mode: 0o755 });
    } else {
      writeFileSync(join(pythonBin, `${command}.cmd`), `@echo off\r\n"%~dp0..\\runtime\\python.exe" "%~dp0..\\entrypoints\\${runnerName}" %*\r\n`);
      writeFileSync(join(pythonBin, `${command}.ps1`), `\uFEFF$ErrorActionPreference = 'Stop'\n$pythonRoot = Split-Path -Parent $PSScriptRoot\n& "$pythonRoot\\runtime\\python.exe" "$pythonRoot\\entrypoints\\${runnerName}" @args\nexit $LASTEXITCODE\n`);
    }
  }
  return [...commands.keys()].sort();
}

function writeLaunchers(root, platform, executableDirs) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (platform === "darwin") {
    const path = join(bin, "coop-desktop");
    const dirs = executableDirs.map((item) => `\"$runtime_root/${item}\"`).join(":");
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\nif [ -z \"${"${COOP_DESKTOP_AGENT_DIR:-}"}\" ]; then echo \"Coop Desktop managed launcher requires an isolated agent directory.\" >&2; exit 64; fi\nruntime_root=\"$(cd -P \"$(dirname \"${"${BASH_SOURCE[0]}"}\")/..\" && pwd)\"\nexport COOP_AGENT_DIR=\"$COOP_DESKTOP_AGENT_DIR\" PI_CODING_AGENT_DIR=\"$COOP_DESKTOP_AGENT_DIR\"\nexport PYTHONDONTWRITEBYTECODE=1\nexport COOP_DESKTOP_MANAGED_RUNTIME=1 COOP_MANAGED_EXTENSIONS_ROOT=\"$runtime_root/npm/node_modules\"\nexport PATH=${dirs}:\"$PATH\"\n\"$runtime_root/node/bin/node\" \"$runtime_root/coop/lib/managed-mcp-config.mjs\" \"$runtime_root\" \"$COOP_DESKTOP_AGENT_DIR\"\nexec \"$runtime_root/coop/bin/coop\" \"$@\"\n`, { mode: 0o755 });
    return "bin/coop-desktop";
  }
  const ps1 = join(bin, "coop-desktop.ps1");
  const pathParts = executableDirs.map((item) => `$runtimeRoot\\${item.replaceAll("/", "\\")}`).join(";");
  writeFileSync(ps1, `\uFEFF$ErrorActionPreference = 'Stop'\nif (-not $env:COOP_DESKTOP_AGENT_DIR) { Write-Error 'Coop Desktop managed launcher requires an isolated agent directory.'; exit 64 }\n$runtimeRoot = Split-Path -Parent $PSScriptRoot\n$env:COOP_AGENT_DIR = $env:COOP_DESKTOP_AGENT_DIR\n$env:PI_CODING_AGENT_DIR = $env:COOP_DESKTOP_AGENT_DIR\n$env:PYTHONDONTWRITEBYTECODE = '1'\n$env:COOP_DESKTOP_MANAGED_RUNTIME = '1'\n$env:COOP_MANAGED_EXTENSIONS_ROOT = "$runtimeRoot\\npm\\node_modules"\n$env:Path = \"${pathParts};$env:Path\"\n& \"$runtimeRoot\\node\\node.exe\" \"$runtimeRoot\\coop\\lib\\managed-mcp-config.mjs\" $runtimeRoot $env:COOP_DESKTOP_AGENT_DIR\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n& \"$runtimeRoot\\coop\\bin\\coop.ps1\" @args\nexit $LASTEXITCODE\n`);
  writeFileSync(join(bin, "coop-desktop.cmd"), "@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"%~dp0coop-desktop.ps1\" %*\r\n");
  return "bin/coop-desktop.ps1";
}

function stage() {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(args.output)) die(`Output already exists; refusing to overwrite: ${args.output}`);
  if (dirname(args.output) === args.output) die("The filesystem root cannot be used as managed-runtime output.");
  const release = readJson(join(REPO, "config", "release-manifest.json"), "Coop release manifest");
  const build = readJson(join(REPO, "config", "managed-runtime-build.json"), "Managed runtime build configuration");
  const target = { platform: process.platform, arch: process.arch };
  if (!new Set(["darwin", "win32"]).has(target.platform) || !new Set(["arm64", "x64"]).has(target.arch)) die(`Unsupported managed-runtime target: ${target.platform}-${target.arch}`);
  const plan = managedRuntimeBuildPlan(`${target.platform}-${target.arch}`);
  const nodeRelative = target.platform === "win32" ? "node/node.exe" : "node/bin/node";
  const sourceNode = join(args.nodeRoot, target.platform === "win32" ? "node.exe" : "bin/node");
  const pythonRelative = target.platform === "win32" ? "python/runtime/python.exe" : "python/runtime/bin/python3";
  const sourcePython = join(args.pythonRoot, target.platform === "win32" ? "python.exe" : "bin/python3");
  for (const source of [args.nodeRoot, args.npmPrefix, args.pythonRoot, ...args.pythonTools.map(({ root }) => root)]) assertInternalSymlinks(source);
  const nodeVersion = commandVersion(sourceNode);
  const pythonVersion = commandVersion(sourcePython);
  if (!versionAtLeast(nodeVersion, release.node.min)) die(`Node ${nodeVersion} is older than required ${release.node.min}.`);
  if (pythonVersion !== build.pythonVersion) die(`Python ${pythonVersion} does not match required ${build.pythonVersion}.`);
  const piPackagePath = join(args.npmPrefix, "node_modules", ...release.pi.package.split("/"), "package.json");
  const piPackage = readJson(piPackagePath, "Pi package manifest");
  if (piPackage.version !== release.pi.version) die(`Pi ${piPackage.version || "unknown"} does not match required ${release.pi.version}.`);
  const npmPackages = {};
  for (const spec of plan.npmSpecs) {
    const separator = spec.lastIndexOf("@");
    const name = spec.slice(0, separator);
    const expected = spec.slice(separator + 1);
    const packagePath = join(args.npmPrefix, "node_modules", ...name.split("/"), "package.json");
    const pkg = readJson(packagePath, `Managed npm package ${name}`);
    if (pkg.version !== expected) die(`${name} ${pkg.version || "unknown"} does not match required ${expected}.`);
    npmPackages[name] = expected;
  }

  const availablePython = new Map();
  for (const tool of args.pythonTools) {
    if (!Object.keys(release.python_tools || {}).some((name) => normalizeName(name) === normalizeName(tool.name))) die(`Unexpected managed Python distribution: ${tool.name}.`);
    const versions = distributionVersions(tool.root);
    const actual = versions.get(normalizeName(tool.name));
    if (actual) availablePython.set(normalizeName(tool.name), actual);
  }
  for (const [name, expected] of Object.entries(release.python_tools || {})) {
    const actual = availablePython.get(normalizeName(name));
    if (actual !== expected) die(`${name} ${actual || "missing"} does not match required ${expected}.`);
  }
  const dependencyInventory = buildDependencyInventory({ npmPrefix: args.npmPrefix, pythonTools: args.pythonTools, target });
  const dependencyInventoryBytes = serializeDependencyInventory(dependencyInventory);

  const staging = `${args.output}.staging-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(args.output), { recursive: true });
    mkdirSync(staging, { recursive: false });
    for (const name of COOP_FILES) {
      const source = join(REPO, name);
      const destination = join(staging, "coop", name);
      mkdirSync(dirname(destination), { recursive: true });
      if (lstatSync(source).isDirectory()) copyTree(source, destination);
      else cpSync(source, destination, { preserveTimestamps: true });
    }
    copyTree(args.nodeRoot, join(staging, "node"));
    // Share the shell's immutable bundle inspection with managed Doctor.
    const inspectionRoot = join(staging, "lib/desktop-inspection");
    mkdirSync(inspectionRoot, { recursive: true });
    for (const name of ["managed-runtime.mjs", "coop-launcher.mjs", "dependency-inventory.mjs", "development-wheels.mjs"]) cpSync(join(REPO, "desktop/src", name), join(inspectionRoot, name));
    copyTree(args.npmPrefix, join(staging, "npm"));
    const usageCorrection = ensureUsageCompatibility(join(staging, "npm/node_modules/pi-better-openai"));
    writeFileSync(join(staging, "coop-compatibility.json"), JSON.stringify([usageCorrection, ensureMcpIsolationCompatibility(join(staging, "npm/node_modules/pi-mcp-adapter"))], null, 2) + "\n");
    copyTree(args.pythonRoot, join(staging, "python", "runtime"));
    const stagedTools = args.pythonTools.map((tool) => {
      const destination = `python/tools/${tool.name}/site-packages`;
      copyTree(tool.root, join(staging, destination));
      return { name: tool.name, source: join(staging, destination) };
    });
    const pythonCommands = writePythonLaunchers(staging, target.platform, stagedTools, build.requiredPythonCommands || []);
    removePythonCaches(join(staging, "coop"));
    const executableDirs = [target.platform === "win32" ? "node" : "node/bin", "npm/node_modules/.bin", "python/bin"];
    const launcher = writeLaunchers(staging, target.platform, executableDirs);
    writeFileSync(join(staging, "node-version.txt"), `${nodeVersion}\n`);
    writeFileSync(join(staging, "python-version.txt"), `${pythonVersion}\n`);
    writeFileSync(join(staging, "dependency-inventory.json"), dependencyInventoryBytes);
    const manifest = {
      schemaVersion: 1,
      target,
      versions: { coop: release.coop_version, pi: release.pi.version, node: nodeVersion, python: pythonVersion, npmPackages, pythonTools: release.python_tools },
      minimums: { node: release.node.min, python: "3.12.0" },
      inventory: {
        path: "dependency-inventory.json",
        sha256: dependencyInventoryDigest(dependencyInventoryBytes),
        npmPackages: dependencyInventory.npm.packages.length,
        pythonDistributions: dependencyInventory.python.tools.reduce((total, tool) => total + tool.distributions.length, 0),
        completeNpmIntegrity: dependencyInventory.npm.completeIntegrity,
      },
      paths: {
        coopRoot: "coop",
        launcher,
        node: nodeRelative,
        nodeVersionFile: "node-version.txt",
        python: pythonRelative,
        pythonVersionFile: "python-version.txt",
        pythonCommands,
        pythonToolRoots: Object.fromEntries(args.pythonTools.map(({ name }) => [name, `python/tools/${name}/site-packages`])),
        piPackage: `npm/node_modules/${release.pi.package}/package.json`,
        executableDirs,
      },
    };
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(staging, args.output);
    process.stdout.write(`${JSON.stringify({ ok: true, output: args.output, target, versions: manifest.versions })}\n`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

try { stage(); }
catch (error) { process.stderr.write(`stage-managed-runtime: ${error.message}\n`); process.exitCode = 1; }
