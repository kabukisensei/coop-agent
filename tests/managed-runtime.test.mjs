import { resolveManagedDesktopProfile } from "../desktop/src/managed-profile.mjs";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectManagedRuntime, managedDesktopAgentDir, resolveDesktopCoopLauncher } from "../desktop/src/managed-runtime.mjs";
import { buildDependencyInventory, validateDependencyInventory, dependencyInventoryDigest, serializeDependencyInventory } from "../desktop/src/dependency-inventory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));
const BUILD = JSON.parse(readFileSync(join(ROOT, "config", "managed-runtime-build.json"), "utf8"));
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "config", "managed-runtime.schema.json"), "utf8"));
const INVENTORY_SCHEMA = JSON.parse(readFileSync(join(ROOT, "config", "dependency-inventory.schema.json"), "utf8"));
const TEST_PLATFORM = process.platform === "win32" ? "win32" : "darwin";
const TEST_ARCH = new Set(["arm64", "x64"]).has(process.arch) ? process.arch : "x64";
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`  ✓ ${name}`); }

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode ? { mode } : undefined);
}

function expectedNpmPackages(target) {
  const excluded = new Set(BUILD.targetExclusions[`${target.platform}-${target.arch}`] || []);
  return {
    [RELEASE.pi.package]: RELEASE.pi.version,
    ...RELEASE.extensions,
    ...Object.fromEntries(Object.entries(RELEASE.npm_tools).filter(([name]) => !excluded.has(name))),
    ...RELEASE.mcp_servers,
  };
}

await test("inventory retains Python post releases and missing npm integrity; rejects ambiguous distributions and unsafe paths", () => {
  assert.equal(INVENTORY_SCHEMA.properties.python.properties.tools.type, "array");
  const base = mkdtempSync(join(tmpdir(), "coop-inventory-"));
  try {
    const npmPrefix = join(base, "npm");
    const pythonRoot = join(base, "python");
    const target = { platform: TEST_PLATFORM, arch: TEST_ARCH };
    write(join(npmPrefix, "node_modules", "example", "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
    write(join(npmPrefix, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/example": { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz" } } }));
    write(join(pythonRoot, "example-2.9.0.post0.dist-info", "METADATA"), "Name: example\nVersion: 2.9.0.post0\n");
    const build = () => buildDependencyInventory({ npmPrefix, pythonTools: [{ name: "example", root: pythonRoot }], target });
    const inventory = build();
    validateDependencyInventory(inventory, target);
    assert.equal(inventory.npm.completeIntegrity, false);
    assert.equal(inventory.python.tools[0].distributions[0].version, "2.9.0.post0");
    assert.equal(serializeDependencyInventory(build()), serializeDependencyInventory(inventory));
    for (const path of ["node_modules/../escape", "node_modules/example\\..\\escape", "node_modules//example"]) {
      const invalid = structuredClone(inventory);
      invalid.npm.packages[0].path = path;
      assert.throws(() => validateDependencyInventory(invalid, target), /invalid/);
    }
    write(join(pythonRoot, "example-2.8.0.dist-info", "METADATA"), "Name: Example\nVersion: 2.8.0\n");
    assert.throws(build, /ambiguous/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function fixture(base, overrides = {}) {
  const root = join(base, "managed-runtime");
  const target = overrides.target || { platform: TEST_PLATFORM, arch: TEST_ARCH };
  const windows = target.platform === "win32";
  const npmPackages = expectedNpmPackages(target);
  const versions = { coop: RELEASE.coop_version, pi: RELEASE.pi.version, node: "22.22.3", python: "3.12.14", npmPackages, pythonTools: RELEASE.python_tools };
  write(join(root, "coop", "VERSION"), `${RELEASE.coop_version}\n`);
  write(join(root, "coop", "config", "release-manifest.json"), `${JSON.stringify(RELEASE)}\n`);
  write(join(root, "coop", "config", "managed-runtime-build.json"), `${JSON.stringify(BUILD)}\n`);
  for (const [name, version] of Object.entries(npmPackages)) write(join(root, "npm", "node_modules", ...name.split("/"), "package.json"), `${JSON.stringify({ name, version })}\n`);
  write(join(root, "node", ...(windows ? ["node.exe"] : ["bin", "node"])), "node", 0o755);
  write(join(root, "node-version.txt"), "22.22.3\n");
  write(join(root, "python", "runtime", ...(windows ? ["python.exe"] : ["bin", "python3"])), "python", 0o755);
  write(join(root, "python-version.txt"), "3.12.14\n");
  write(join(root, "bin", windows ? "coop-desktop.ps1" : "coop-desktop"), windows ? "\uFEFFexit 0\n" : "#!/bin/sh\nexit 0\n", 0o755);
  mkdirSync(join(root, "npm", "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(root, "python", "bin"), { recursive: true });
  for (const command of BUILD.requiredPythonCommands) write(join(root, "python", "bin", `${command}${windows ? ".cmd" : ""}`), windows ? "@echo off\r\n" : "#!/bin/sh\n", 0o755);
  for (const name of Object.keys(RELEASE.python_tools)) mkdirSync(join(root, "python", "tools", name, "site-packages"), { recursive: true });
  const dependencyInventory = {
    schemaVersion: 1,
    target,
    npm: {
      lockfileVersion: 3,
      completeIntegrity: true,
      packages: Object.entries(npmPackages).map(([name, version]) => ({ path: `node_modules/${name}`, name, version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`, integrity: "sha512-YQ==" })).sort((a, b) => a.path.localeCompare(b.path, "en")),
    },
    python: {
      tools: Object.entries(RELEASE.python_tools).map(([name, version]) => ({ name, distributions: [{ name, version, metadata: `${name.replaceAll("-", "_")}-${version}.dist-info` }] })).sort((a, b) => a.name.localeCompare(b.name, "en")),
    },
  };
  const inventoryBytes = serializeDependencyInventory(dependencyInventory);
  write(join(root, "dependency-inventory.json"), inventoryBytes);
  const manifest = {
    schemaVersion: 1,
    target,
    versions,
    minimums: { node: RELEASE.node.min, python: "3.12.0" },
    inventory: {
      path: "dependency-inventory.json",
      sha256: dependencyInventoryDigest(inventoryBytes),
      npmPackages: dependencyInventory.npm.packages.length,
      pythonDistributions: dependencyInventory.python.tools.length,
      completeNpmIntegrity: true,
    },
    paths: {
      coopRoot: "coop",
      launcher: `bin/${windows ? "coop-desktop.ps1" : "coop-desktop"}`,
      node: windows ? "node/node.exe" : "node/bin/node",
      nodeVersionFile: "node-version.txt",
      python: windows ? "python/runtime/python.exe" : "python/runtime/bin/python3",
      pythonVersionFile: "python-version.txt",
      pythonCommands: [...BUILD.requiredPythonCommands],
      pythonToolRoots: Object.fromEntries(Object.keys(RELEASE.python_tools).map((name) => [name, `python/tools/${name}/site-packages`])),
      piPackage: `npm/node_modules/${RELEASE.pi.package}/package.json`,
      executableDirs: [windows ? "node" : "node/bin", "npm/node_modules/.bin", "python/bin"],
    },
    ...overrides.manifest,
  };
  write(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

await test("managed packaging is explicit, schema-pinned, and separate from preview artifacts", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "desktop", "package.json"), "utf8"));
  assert.equal(SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(SCHEMA.required, ["schemaVersion", "target", "versions", "minimums", "inventory", "paths"]);
  assert.match(pkg.scripts["package:managed:mac"], /electron-builder-managed\.cjs/);
  assert.match(pkg.scripts["package:managed:win"], /electron-builder-managed\.cjs/);
  assert.ok(!pkg.build.extraResources, "preview packaging must not pretend to contain a managed runtime");
  const builder = readFileSync(join(ROOT, "desktop", "electron-builder-managed.cjs"), "utf8");
  assert.match(builder, /COOP_DESKTOP_MANAGED_RUNTIME_DIR/);
  assert.match(builder, /to: "managed-runtime"/);
  assert.match(builder, /com\.cooptimize\.coop\.desktop/);
  assert.match(builder, /dist-managed/);
  assert.match(builder, /manifest\.target\.arch/);
});

await test("a packaged Desktop resolves the exact platform managed launcher and pinned versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-managed-runtime-"));
  try {
    const root = fixture(dir);
    const inspected = inspectManagedRuntime(root, { platform: TEST_PLATFORM, arch: TEST_ARCH });
    assert.equal(inspected.versions.coop, RELEASE.coop_version);
    assert.equal(inspected.versions.pi, RELEASE.pi.version);
    assert.equal(inspected.versions.python, "3.12.14");
    assert.deepEqual(inspected.versions.pythonTools, RELEASE.python_tools);
    const available = (candidate) => candidate === inspected.launcher || candidate.toLowerCase() === "c:\\powershell\\pwsh.exe";
    const launcher = resolveDesktopCoopLauncher({
      packaged: true,
      resourcesPath: dir,
      platform: TEST_PLATFORM,
      arch: TEST_ARCH,
      env: TEST_PLATFORM === "win32" ? { Path: "C:\\PowerShell", PATHEXT: ".EXE" } : { PATH: "" },
      available: TEST_PLATFORM === "win32" ? available : undefined,
    });
    assert.equal(launcher.source, "managed");
    assert.equal(launcher.terminalExecutable, inspected.launcher);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test("legacy managed Desktop profile names remain available for in-place adoption", () => {
  const base = TEST_PLATFORM === "win32" ? "C:\\Users\\Consultant\\AppData\\Roaming\\Coop Desktop" : "/Users/consultant/Library/Application Support/Coop Desktop";
  const result = managedDesktopAgentDir(base, { coop: RELEASE.coop_version, pi: RELEASE.pi.version });
  assert.match(result, new RegExp(`managed-agent[/\\\\]coop-${RELEASE.coop_version}-pi-${RELEASE.pi.version}$`));
  assert.equal(result.includes(".coop/agent"), false);
  assert.throws(() => managedDesktopAgentDir("relative", { coop: RELEASE.coop_version, pi: RELEASE.pi.version }), /user-data path/);
});

await test("fresh managed profiles have a durable identity independent of runtime versions", () => {
  const base = mkdtempSync(join(tmpdir(), "coop-profile-stable-"));
  try {
    const profile = resolveManagedDesktopProfile(base);
    assert.equal(profile, join(base, "managed-agent", "profile-v1"));
    writeFileSync(join(profile, "continuity-marker.txt"), "existing profile data");
    assert.equal(resolveManagedDesktopProfile(base), profile);
    assert.equal(readFileSync(join(profile, "continuity-marker.txt"), "utf8"), "existing profile data");
    assert.deepEqual(JSON.parse(readFileSync(join(base, "managed-agent", "active-profile.json"), "utf8")), { schemaVersion: 1, directory: "profile-v1" });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

await test("a single legacy profile is adopted in place and kept after another runtime version appears", () => {
  const base = mkdtempSync(join(tmpdir(), "coop-profile-legacy-"));
  try {
    const old = managedDesktopAgentDir(base, { coop: "0.14.0", pi: "0.83.0" });
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "continuity-marker.txt"), "do not copy or rewrite");
    assert.equal(resolveManagedDesktopProfile(base), old);
    mkdirSync(managedDesktopAgentDir(base, { coop: RELEASE.coop_version, pi: RELEASE.pi.version }), { recursive: true });
    assert.equal(resolveManagedDesktopProfile(base), old);
    assert.equal(readFileSync(join(old, "continuity-marker.txt"), "utf8"), "do not copy or rewrite");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

await test("multiple legacy profiles require an explicit in-root choice and never merge", () => {
  const base = mkdtempSync(join(tmpdir(), "coop-profile-ambiguous-"));
  try {
    const one = managedDesktopAgentDir(base, { coop: "0.14.0", pi: "0.83.0" });
    const two = managedDesktopAgentDir(base, { coop: "0.15.2", pi: "0.84.3" });
    mkdirSync(one, { recursive: true }); mkdirSync(two, { recursive: true });
    assert.throws(() => resolveManagedDesktopProfile(base), error => error.code === "PROFILE_SELECTION_REQUIRED" && error.candidates.length === 2);
    assert.throws(() => resolveManagedDesktopProfile(base, { selectedDirectory: base }), /existing Desktop profiles/);
    assert.equal(resolveManagedDesktopProfile(base, { selectedDirectory: one }), one);
    assert.equal(resolveManagedDesktopProfile(base, { selectedDirectory: two }), one, "an existing pointer cannot be silently changed");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

await test("corrupt or escaping profile pointers fail closed and remain unchanged", () => {
  const base = mkdtempSync(join(tmpdir(), "coop-profile-invalid-"));
  try {
    const root = join(base, "managed-agent"); mkdirSync(root);
    const pointer = join(root, "active-profile.json");
    for (const text of ["broken JSON", JSON.stringify({ schemaVersion: 1, directory: "../../outside" }), JSON.stringify({ schemaVersion: 1, directory: "profile-v1" })]) {
      writeFileSync(pointer, text);
      assert.throws(() => resolveManagedDesktopProfile(base), /pointer|missing/);
      assert.equal(readFileSync(pointer, "utf8"), text);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

await test("linked managed profile roots are rejected", () => {
  const base = mkdtempSync(join(tmpdir(), "coop-profile-link-"));
  try {
    const outside = join(base, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(base, "managed-agent"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => resolveManagedDesktopProfile(base), /real directory/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

await test("managed runtime mismatch and path escapes fail closed without installed fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-managed-runtime-bad-"));
  try {
    const root = fixture(dir);
    const wrongPlatform = TEST_PLATFORM === "win32" ? "darwin" : "win32";
    assert.throws(() => inspectManagedRuntime(root, { platform: wrongPlatform, arch: TEST_ARCH }), /targets/);
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.paths.launcher = "../outside";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => resolveDesktopCoopLauncher({ packaged: true, resourcesPath: dir, platform: TEST_PLATFORM, arch: TEST_ARCH }), /escapes the bundle/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test("managed runtime rejects an executable symlink that resolves outside the signed bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-managed-runtime-link-"));
  try {
    const root = fixture(dir);
    const external = join(dir, "external-launcher");
    mkdirSync(external, { recursive: true });
    write(join(external, TEST_PLATFORM === "win32" ? "coop-desktop.ps1" : "coop-desktop"), "exit 0\n", 0o755);
    const link = join(root, "linked-launcher");
    symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.paths.launcher = `linked-launcher/${TEST_PLATFORM === "win32" ? "coop-desktop.ps1" : "coop-desktop"}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => inspectManagedRuntime(root, { platform: TEST_PLATFORM, arch: TEST_ARCH }), /escapes the bundle/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test("the offline staging command validates every release pin and never overwrites output", () => {
  if (process.platform === "win32") {
    // The ordinary Windows logic job intentionally has no system Python
    // prerequisite. The managed-runtime smoke job downloads the checksum-pinned
    // CPython distribution and executes this integration path on Windows.
    assert.equal(BUILD.pythonSources["win32-x64"].root, "python");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "coop-managed-stage-"));
  try {
    const nodeRoot = join(dir, "node-source");
    const npmPrefix = join(dir, "npm-source");
    const python = join(dir, "python-source");
    const output = join(dir, "bundle");
    if (process.platform === "win32") {
      copyFileSync(process.execPath, join(nodeRoot, "node.exe"));
    } else {
      write(join(nodeRoot, "bin", "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.22.3; else exec ${JSON.stringify(process.execPath)} "$@"; fi\n`, 0o755);
    }
    const stageTarget = { platform: process.platform, arch: TEST_ARCH };
    const stageNpmPackages = expectedNpmPackages(stageTarget);
    for (const [name, version] of Object.entries(stageNpmPackages)) write(join(npmPrefix, "node_modules", ...name.split("/"), "package.json"), `${JSON.stringify({ name, version })}\n`);
    write(join(npmPrefix, "node_modules", ".package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, requires: true, packages: Object.fromEntries(Object.entries(stageNpmPackages).map(([name, version]) => [`node_modules/${name}`, { version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`, integrity: "sha512-YQ==" }])) }, null, 2)}\n`);
    write(join(npmPrefix, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi"), process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", 0o755);
    if (process.platform !== "win32") {
      write(join(python, "bin", "python3.12"), "#!/bin/sh\necho Python 3.12.14\n", 0o755);
      symlinkSync("python3.12", join(python, "bin", "python3"));
    }
    const entrypoints = {
      "coop-data-doc": "coop-data-doc = coop_data_doc.cli:main\n",
      "coop-sql-review": "coop-sql-review = coop_sql_review.cli:main\n",
      "coop-dax-review": "coop-dax-review = coop_dax_review.cli:main\n",
      "ms-fabric-cli": "fab = ms_fabric_cli.cli:main\n",
    };
    const toolArgs = [];
    for (const [name, version] of Object.entries(RELEASE.python_tools)) {
      const tool = join(dir, "python-tools", name);
      const folder = `${name.replaceAll("-", "_")}-${version}.dist-info`;
      write(join(tool, folder, "METADATA"), `Name: ${name}\nVersion: ${version}\n`);
      if (entrypoints[name]) write(join(tool, folder, "entry_points.txt"), `[console_scripts]\n${entrypoints[name]}`);
      toolArgs.push("--python-tool", `${name}=${tool}`);
    }
    const args = [join(ROOT, "scripts", "stage-managed-runtime.mjs"), "--output", output, "--node-root", nodeRoot, "--npm-prefix", npmPrefix, "--python-root", python, ...toolArgs];
    const first = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    if (!new Set(["darwin", "win32"]).has(process.platform)) {
      assert.notEqual(first.status, 0);
      assert.match(first.stderr, /Unsupported managed-runtime target/);
      return;
    }
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).ok, true);
    const inspected = inspectManagedRuntime(output);
    assert.equal(inspected.versions.pi, RELEASE.pi.version);
    assert.equal(inspected.versions.python, "3.12.14");
    assert.deepEqual(inspected.pythonCommands, ["coop-data-doc", "coop-dax-review", "coop-sql-review", "fab"]);
    const wrapper = readFileSync(join(output, "python", "bin", "coop-data-doc"), "utf8");
    assert.doesNotMatch(wrapper, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(wrapper, /runtime_root=/);
    const launcher = readFileSync(join(output, "bin", "coop-desktop"), "utf8");
    assert.match(launcher, /COOP_DESKTOP_AGENT_DIR/);
    assert.match(launcher, /PI_CODING_AGENT_DIR/);
    assert.match(launcher, /COOP_MANAGED_EXTENSIONS_ROOT/);
    assert.match(launcher, /export PYTHONDONTWRITEBYTECODE=1/);
    assert.equal(readFileSync(join(ROOT, "scripts/stage-managed-runtime.mjs"), "utf8").includes("$env:PYTHONDONTWRITEBYTECODE = '1'"), true);
    assert.equal(existsSync(join(output, "coop/lib/__pycache__")), false);
    const launchSpec = spawnSync(join(output, "bin", "coop-desktop"), ["--no-launch"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, COOP_DESKTOP_AGENT_DIR: join(dir, "desktop-agent") },
    });
    assert.equal(launchSpec.status, 0, launchSpec.stderr);
    for (const name of Object.keys(RELEASE.extensions)) assert.equal(launchSpec.stdout.includes(`/npm/node_modules/${name}`), true, name);
    const second = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing to overwrite/);
    if (process.platform !== "win32") {
      const stagedPythonLink = join(output, "python", "runtime", "bin", "python3");
      assert.equal(readlinkSync(stagedPythonLink), "python3.12");
    }
    const relocated = join(dir, "bundle-relocated");
    renameSync(output, relocated);
    assert.equal(inspectManagedRuntime(relocated).versions.python, "3.12.14");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`managed runtime: ${count} tests passed`);
