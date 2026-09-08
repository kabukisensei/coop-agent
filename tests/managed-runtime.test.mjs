import { windowsShellCases, observeWindowsShell, writeWindowsShellFixtures } from "../desktop/scripts/diagnose-windows-shell.mjs";
import { resolveManagedToolInvocation, execCoopTool } from "../lib/managed-tool-invocation.mjs";
import { assertDisposableInstallerHost, buildNsisInvocation } from "../desktop/scripts/verify-windows-installer.mjs";
import { buildNativeProbeEnvironment, probeNativeApplication } from "../desktop/scripts/verify-native-application.mjs";
import { resolveManagedDesktopProfile } from "../desktop/src/managed-profile.mjs";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
    const upstreamUsage = readFileSync(join(ROOT, "tests/fixtures/pi-better-openai-0.1.22/usage.ts"), "utf8");
    write(join(npmPrefix, "node_modules/pi-better-openai/src/usage.ts"), upstreamUsage);
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
    const upstreamUsage = readFileSync(join(ROOT, "tests/fixtures/pi-better-openai-0.1.22/usage.ts"), "utf8");
    write(join(npmPrefix, "node_modules/pi-better-openai/src/usage.ts"), upstreamUsage);
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
    assert.equal(readFileSync(join(npmPrefix, "node_modules/pi-better-openai/src/usage.ts"), "utf8"), upstreamUsage, "staging preserves acquired package source");
    assert.match(readFileSync(join(output, "npm/node_modules/pi-better-openai/src/usage.ts"), "utf8"), /windowLabels/);
    assert.equal(JSON.parse(readFileSync(join(output, "coop-compatibility.json"), "utf8"))[0].id, "usage-window-duration-v1");
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
    const traceSpec = spawnSync(join(output, "bin", "coop-desktop"), ["--no-launch"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, COOP_DESKTOP_AGENT_DIR: join(dir, "desktop-agent"), COOP_RUNTIME_STARTUP_TRACE: "1" },
    });
    assert.equal(traceSpec.status, 0, traceSpec.stderr);
    assert.equal(traceSpec.stdout, launchSpec.stdout);
    const stages = [...traceSpec.stderr.matchAll(/\[coop-startup\] ([a-z-]+)/g)].map(match => match[1]);
    assert.deepEqual(stages.slice(0, 3), ["bootstrap-enter", "bootstrap-root-ready", "bootstrap-dispatch"]);

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

await test("native app probes isolate Windows credentials and profile paths", async () => {
  const env = buildNativeProbeEnvironment("C:\\probe", "challenge", "win32", { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "fixture", NODE_OPTIONS: "--inspect" });
  assert.equal(env.OS, "Windows_NT");
  assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(env.USERPROFILE, "C:\\probe");
  assert.equal(env.APPDATA, "C:\\probe\\AppData\\Roaming");
  assert.equal(env.LOCALAPPDATA, "C:\\probe\\AppData\\Local");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.COOP_DESKTOP_UPDATE_PROBE, "challenge");
});

await test("native readiness requires the challenge, version and clean exit; failed profiles remain", async () => {
  for (const mode of ["healthy", "wrong-token", "wrong-version", "bad-exit", "hang", "spawn-error"]) {
    const root = mkdtempSync(join(tmpdir(), "coop-native-probe-test-"));
    let profile, pid;
    try {
      const report = await probeNativeApplication({ executable: process.execPath, version: "0.0.1", workspace: root, profileRoot: root,
        timeoutMs: mode === "hang" ? 200 : 5000 }, {
        spawnImpl: (_command, args, options) => {
          profile = args[0].slice("--user-data-dir=".length);
          const script = mode === "hang" ? "setInterval(() => {}, 1000)" :
            `process.stdout.write(JSON.stringify({type:"desktop.update-health",token:${mode === "wrong-token" ? '"wrong"' : 'process.env.COOP_DESKTOP_UPDATE_PROBE'},version:${JSON.stringify(mode === "wrong-version" ? "0.0.2" : "0.0.1")}})+"\\n");process.exitCode=${mode === "bad-exit" ? 7 : 0};`;
          const child = spawn(mode === "spawn-error" ? join(root, "missing-program") : process.execPath, ["-e", script], options);
          pid = child.pid; return child;
        },
      });
      assert.equal(mode, "healthy");
      assert.equal(report.rendererAndChatReady, true);
      assert.equal(report.mainProcessExited, true);
      assert.equal(report.profileRemoved, true);
    } catch (error) {
      if (mode === "healthy") throw error;
      assert.match(error.message, /Native application/);
      assert.equal(typeof error.observation.stdoutBytes, "number");
      assert.equal(error.observation.ready, mode === "bad-exit");
      assert.equal(existsSync(profile), true);
    } finally {
      if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      rmSync(root, { recursive: true, force: true });
    }
  }
});

await test("installer mutation requires an explicitly enabled disposable Windows runner", async () => {
  const allowed = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", COOP_DESKTOP_DISPOSABLE_INSTALL_TEST: "1" };
  assert.doesNotThrow(() => assertDisposableInstallerHost(allowed, "win32"));
  for (const env of [{}, {...allowed, RUNNER_ENVIRONMENT:"self-hosted"}, {...allowed, COOP_DESKTOP_DISPOSABLE_INSTALL_TEST:"0"}]) {
    assert.throws(() => assertDisposableInstallerHost(env, "win32"), /disposable/);
  }
  assert.throws(() => assertDisposableInstallerHost(allowed, "darwin"), /Windows/);
});

await test("NSIS preserves its unquoted final path argument and never enables elevation or CRC bypass", async () => {
  const executable = "C:\\build files\\setup.exe", directory = "C:\\test files\\Coop Desktop";
  const install = buildNsisInvocation(executable, directory);
  assert.deepEqual(install.args, ["/S", "/currentuser", "/D=" + directory]);
  assert.equal(install.options.windowsVerbatimArguments, true);
  assert.equal(install.options.shell, false);
  const uninstall = buildNsisInvocation(executable, directory, { uninstall: true });
  assert.deepEqual(uninstall.args, ["/S", "/currentuser", "_?=" + directory]);
  for (const path of ["relative", 'C:\\bad"path', "C:\\bad\npath"]) {
    assert.throws(() => buildNsisInvocation(executable, path), /path/);
  }
});

await test("Windows shell diagnosis varies machine fields and input without copying credentials or real profiles", () => {
  const cases = windowsShellCases("C:\\isolated", { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Programs", USERNAME: "fixture", HOME: "C:\\real", USERPROFILE: "C:\\real", APPDATA: "C:\\real-appdata", OPENAI_API_KEY: "fixture", NODE_OPTIONS: "fixture" });
  assert.deepEqual(cases.map(value => value.stdin), ["ignore", "pipe", "ignore", "pipe", "ignore", "ignore", "ignore", "ignore", "pipe", "pipe"]);
  for (const value of cases) {
    assert.equal(value.env.HOME, "C:\\isolated"); assert.equal(value.env.USERPROFILE, "C:\\isolated");
    assert.equal(value.env.OPENAI_API_KEY, undefined); assert.equal(value.env.NODE_OPTIONS, undefined);
    assert.equal(value.env.COOP_DESKTOP_UPDATE_PROBE, undefined);
    assert.notEqual(value.env.APPDATA, "C:\\real-appdata");
  }
  assert.equal(cases[0].env.ProgramFiles, undefined);
  assert.equal(cases[2].env.ProgramFiles, "C:\\Programs");
});

await test("Windows shell diagnosis never treats uncertain or timed-out processes as healthy", () => {
  const probe = { name: "fixture", env: { HOME: ROOT }, stdin: "pipe" };
  for (const stopped of [true, false]) {
    const result = observeWindowsShell("fixture", probe, { gone: () => stopped, run: (_exe, args, options) => {
      assert.deepEqual(args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('coop-powershell-ready')"]);
      assert.equal(options.shell, false); assert.equal(options.input, "");
      return { pid: 12345, status: 0, signal: null, stdout: "coop-powershell-ready\n", stderr: "" };
    } });
    assert.equal(result.processExited, stopped); assert.equal(result.healthy, stopped);
  }
  const result = observeWindowsShell("fixture", probe, { run: () => ({ pid: 0, error: { code: "ETIMEDOUT" } }) });
  assert.equal(result.processExited, false); assert.equal(result.healthy, false);
});

await test("Windows shell file diagnostics execute literal files and retain only known stage markers", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-file-probe é & "));
  try {
    writeWindowsShellFixtures(root);
    for (const kind of ["minimal", "cmdlets"]) {
      assert.equal(readFileSync(join(root, `probe-${kind}.ps1`)).subarray(0, 3).toString("hex"), "efbbbf");
      const probe = { name: kind, fileKind: kind, env: { HOME: root }, stdin: "ignore" };
      const result = observeWindowsShell("fixture", probe, { gone: () => true, run: (_exe, args, options) => {
        assert.deepEqual(args.slice(-4), ["-ExecutionPolicy", "Bypass", "-File", join(root, `probe-${kind}.ps1`)]);
        assert.equal(options.shell, false);
        return { pid: 12345, status: 0, stdout: "coop-powershell-ready\n", stderr: "unrelated text\ncoop-powershell-stage:file-enter\r\ncoop-powershell-stage:unknown\ncoop-powershell-stage:split-path-ready\n" };
      } });
      assert.deepEqual(result.stages, ["file-enter", "split-path-ready"]); assert.equal(result.healthy, true);
    }
    assert.throws(() => observeWindowsShell("fixture", { fileKind: "../untrusted" }), /Unknown shell fixture/);
    const shell = process.platform === "win32" ? process.env.PWSH_EXE || "powershell.exe" : "pwsh";
    if (spawnSync(shell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"], { timeout: 5000 }).status === 0) {
      for (const fileKind of ["minimal", "cmdlets"]) {
        const result = observeWindowsShell(shell, { name: fileKind, fileKind, env: { ...process.env, HOME: root, USERPROFILE: root }, stdin: "ignore" });
        assert.equal(result.healthy, true, JSON.stringify(result));
        assert.deepEqual(result.stages, fileKind === "minimal" ? ["file-enter"] : ["file-enter", "split-path-ready"]);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("Windows shell diagnosis observes real child exit after success and timeout", () => {
  for (const mode of ["healthy", "timeout"]) {
    const probe = { name: mode, env: { ...process.env, HOME: ROOT }, stdin: "ignore" };
    const result = observeWindowsShell(process.execPath, probe, { timeoutMs: mode === "healthy" ? 5000 : 500, run: (exe, _args, options) => spawnSync(exe, ["-e", mode === "healthy" ? "console.log('coop-powershell-ready')" : "console.log('coop-powershell-ready');setInterval(()=>{},1000)"], options) });
    assert.equal(result.healthy, mode === "healthy");
    assert.equal(result.processExited, true);
    assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
    if (mode === "timeout") assert.equal(result.errorCode, "ETIMEDOUT");
  }
});

await test("managed launch skips global npm discovery while ordinary terminal launch retains it", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-managed-path-"));
  try {
    for (const managed of ["0", "1"]) {
      const marker = join(root, `npm-${managed}`);
      const windows = process.platform === "win32";
      const command = windows ? process.env.PWSH_EXE || "powershell.exe" : "bash";
      const args = windows
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "function global:npm { [IO.File]::WriteAllText($env:COOP_NPM_PROBE, 'called') }; & $env:COOP_FIXTURE_SCRIPT help"]
        : ["-c", 'npm() { : > "$COOP_NPM_PROBE"; }; export -f npm; exec bash "$COOP_FIXTURE_SCRIPT" help'];
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000,
        env: { ...process.env, HOME: root, COOP_AGENT_DIR: join(root, "agent"),
          COOP_DESKTOP_MANAGED_RUNTIME: managed, COOP_NPM_PROBE: marker,
          COOP_FIXTURE_SCRIPT: join(ROOT, "bin", windows ? "coop.ps1" : "coop") } });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(marker), managed !== "1", "managed launch must not query a global npm installation");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("managed shared helpers preserve PATH even when global fallback folders exist", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-managed-fallback-"));
  try {
    mkdirSync(join(root, ".local", "bin"), { recursive: true });
    mkdirSync(join(root, "Programs", "Microsoft", "Azure CLI", "wbin"), { recursive: true });
    const windows = process.platform === "win32";
    const env = { ...process.env, HOME: root, LOCALAPPDATA: root,
      COOP_DESKTOP_MANAGED_RUNTIME: "1", COOP_COMMON_FIXTURE: join(ROOT, "lib", windows ? "common.ps1" : "common.sh") };
    delete env.COOP_TEST_STUB_PATH;
    const result = spawnSync(windows ? process.env.PWSH_EXE || "powershell.exe" : "bash", windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$originalPath = $env:PATH; . $env:COOP_COMMON_FIXTURE; if ($originalPath -cne $env:PATH) { throw 'Managed PATH changed' }"]
      : ["-c", 'original_path="$PATH"; source "$COOP_COMMON_FIXTURE"; test "$original_path" = "$PATH"'],
    { env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("managed Python tools preserve literal arguments and use only private immutable UTF-8 execution", () => {
  const root = mkdtempSync(join(tmpdir(), "coop managed tools café &-"));
  try {
    const coop = join(root, "coop"), python = join(root, "python/runtime/python.exe");
    mkdirSync(coop); write(python, "fixture");
    const names = ["coop-data-doc", "coop-sql-review", "coop-dax-review", "fab"];
    for (const name of names) write(join(root, `python/entrypoints/${name}.py`), "fixture");
    write(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, target: { platform: "win32" }, paths: { coopRoot: "coop", python: "python/runtime/python.exe", pythonCommands: names } }));
    const env = { COOP_DESKTOP_MANAGED_RUNTIME: "1", COOP_ROOT: coop, PATH: "C:\\external-tools" };
    const args = ["--config", 'C:\\café & 中文 (1)\\literal"%value%.yml'];
    for (const name of names) {
      const result = resolveManagedToolInvocation(name, args, env, "win32");
      assert.equal(result.command, realpathSync(python));
      assert.deepEqual(result.args, ["-I", "-B", "-X", "utf8", realpathSync(join(root, `python/entrypoints/${name}.py`)), ...args]);
    }
    assert.equal(resolveManagedToolInvocation("unrelated", args, env, "win32"), null);
    assert.equal(resolveManagedToolInvocation("coop-data-doc", args, {}, "win32"), null);
    assert.throws(() => resolveManagedToolInvocation("coop-data-doc", ["bad\0argument"], env, "win32"), /arguments/);
    assert.throws(() => resolveManagedToolInvocation("coop-data-doc", [], { ...env, COOP_ROOT: "relative" }, "win32"), /root/);
    assert.throws(() => resolveManagedToolInvocation("coop-data-doc", [], env, "darwin"), /contract/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

if (process.platform !== "win32") await test("managed invocation accepts an internal Python link but rejects escaping links and unlisted tools", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-tool-links-"));
  try {
    const coop = join(root, "coop"), python = join(root, "python/runtime/bin/python3"), target = join(root, "python/runtime/bin/python3.12");
    mkdirSync(coop); write(target, "fixture"); symlinkSync(target, python);
    write(join(root, "python/entrypoints/coop-data-doc.py"), "fixture");
    const manifest = { schemaVersion: 1, target: { platform: "darwin" }, paths: { coopRoot: "coop", python: "python/runtime/bin/python3", pythonCommands: ["coop-data-doc"] } };
    write(join(root, "manifest.json"), JSON.stringify(manifest));
    const env = { COOP_DESKTOP_MANAGED_RUNTIME: "1", COOP_ROOT: coop };
    assert.equal(resolveManagedToolInvocation("coop-data-doc", [], env, "darwin").command, realpathSync(target));
    assert.throws(() => resolveManagedToolInvocation("coop-sql-review", [], env, "darwin"), /contract/);
    rmSync(python); symlinkSync(process.execPath, python);
    assert.throws(() => resolveManagedToolInvocation("coop-data-doc", [], env, "darwin"), /escapes/);
    rmSync(python); symlinkSync(target, python);
    const script = join(root, "python/entrypoints/coop-data-doc.py");
    rmSync(script); symlinkSync(target, script);
    assert.throws(() => resolveManagedToolInvocation("coop-data-doc", [], env, "darwin"), /regular/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("managed tool invocation rejects a runtime directory linked outside its bundle", () => {
  const base = mkdtempSync(join(tmpdir(), "coop-tool-junction-"));
  try {
    const root = join(base, "bundle"), outside = join(base, "outside");
    mkdirSync(join(root, "coop"), { recursive: true }); mkdirSync(join(root, "python"));
    write(join(outside, "python.exe"), "external");
    symlinkSync(outside, join(root, "python/runtime"), process.platform === "win32" ? "junction" : "dir");
    write(join(root, "python/entrypoints/coop-data-doc.py"), "fixture");
    write(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, target: { platform: "win32" }, paths: { coopRoot: "coop", python: "python/runtime/python.exe", pythonCommands: ["coop-data-doc"] } }));
    assert.throws(() => resolveManagedToolInvocation("coop-data-doc", [], { COOP_DESKTOP_MANAGED_RUNTIME: "1", COOP_ROOT: join(root, "coop") }, "win32"), /escapes/);
    assert.equal(readFileSync(join(outside, "python.exe"), "utf8"), "external");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

await test("ordinary tool execution preserves the original command, arguments and cancellation options", async () => {
  const saved = process.env.COOP_DESKTOP_MANAGED_RUNTIME;
  delete process.env.COOP_DESKTOP_MANAGED_RUNTIME;
  try {
    const args = ["scan"], options = { cwd: ROOT, signal: new AbortController().signal };
    const pi = { exec: async (command, received, config) => { assert.equal(command, "coop-data-doc"); assert.equal(received, args); assert.equal(config, options); return "result"; } };
    assert.equal(await execCoopTool(pi, "coop-data-doc", args, options), "result");
  } finally { if (saved === undefined) delete process.env.COOP_DESKTOP_MANAGED_RUNTIME; else process.env.COOP_DESKTOP_MANAGED_RUNTIME = saved; }
});

await test("startup diagnostics are opt-in, preserve stdout and report only fixed stages", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-startup-trace-"));
  try {
    const windows = process.platform === "win32";
    const shells = windows ? [process.env.PWSH_EXE || "powershell.exe"] : ["bash"];
    if (!windows && spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "exit 0"], { timeout: 5000 }).status === 0) shells.push("pwsh");
    for (const shell of shells) {
      const powershell = shell !== "bash";
      const args = powershell ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(ROOT, "bin/coop.ps1"), "runtime", "--help"]
        : [join(ROOT, "bin/coop"), "runtime", "--help"];
      const env = { ...process.env, HOME: root, USERPROFILE: root, COOP_AGENT_DIR: join(root, "agent"), COOP_DESKTOP_MANAGED_RUNTIME: "1" };
      delete env.COOP_RUNTIME_STARTUP_TRACE;
      const plain = spawnSync(shell, args, { env, encoding: "utf8", timeout: 10000 });
      assert.ifError(plain.error); assert.equal(plain.status, 0, plain.stderr);
      assert.doesNotMatch(plain.stderr, /coop-startup/);
      const traced = spawnSync(shell, args, { env: { ...env, COOP_RUNTIME_STARTUP_TRACE: "1" }, encoding: "utf8", timeout: 10000 });
      assert.ifError(traced.error); assert.equal(traced.status, 0, traced.stderr);
      assert.equal(traced.stdout, plain.stdout, "startup diagnostics must not corrupt runtime stdout");
      assert.deepEqual(traced.stderr.trim().split(/\r?\n/), ["[coop-startup] dispatcher-enter", "[coop-startup] helpers-ready", "[coop-startup] paths-ready"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`managed runtime: ${count} tests passed`);
