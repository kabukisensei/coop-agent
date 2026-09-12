import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedRuntimeBuildPlan } from "../scripts/managed-runtime-build-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(readFileSync(resolve(ROOT, "config", "release-manifest.json"), "utf8"));
const build = JSON.parse(readFileSync(resolve(ROOT, "config", "managed-runtime-build.json"), "utf8"));
const schema = JSON.parse(readFileSync(resolve(ROOT, "config", "managed-runtime-build.schema.json"), "utf8"));
let count = 0;
function test(name, fn) { fn(); count += 1; console.log(`  ✓ ${name}`); }

test("build inputs pin official Node and relocatable Python artifacts with SHA-256 for every release target", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(Object.keys(build.sources).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);
  assert.deepEqual(Object.keys(build.pythonSources).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);
  assert.deepEqual(Object.keys(build.targetExclusions).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);
  for (const [target, source] of Object.entries(build.sources)) {
    assert.match(source.url, new RegExp(`^https://nodejs\\.org/download/release/v${build.nodeVersion}/`), target);
    assert.equal(source.url.endsWith(`/${source.file}`), true, target);
    assert.match(source.sha256, /^[0-9a-f]{64}$/, target);
    assert.equal(source.root.includes(build.nodeVersion), true, target);
  }
  for (const [target, source] of Object.entries(build.pythonSources)) {
    assert.match(source.url, new RegExp(`^https://github\\.com/astral-sh/python-build-standalone/releases/download/${build.pythonBuildRelease}/`), target);
    assert.equal(decodeURIComponent(source.url).endsWith(`/${source.file}`), true, target);
    assert.match(source.sha256, /^[0-9a-f]{64}$/, target);
    assert.equal(source.file.includes(`cpython-${build.pythonVersion}+${build.pythonBuildRelease}`), true, target);
    assert.equal(source.root, "python", target);
  }
});

test("each target receives the exact complete release-manifest npm and Python plan", () => {
  for (const target of Object.keys(build.sources)) {
    const plan = managedRuntimeBuildPlan(target);
    assert.equal(plan.release.coop, release.coop_version);
    assert.equal(plan.release.pi, release.pi.version);
    assert.equal(plan.python.version, build.pythonVersion);
    assert.deepEqual(plan.requiredPythonCommands, build.requiredPythonCommands);
    const expectedNpm = 1 + Object.keys(release.extensions).length + Object.keys(release.npm_tools).length + Object.keys(release.mcp_servers).length - build.targetExclusions[target].length;
    assert.equal(plan.npmSpecs.length, expectedNpm);
    assert.equal(plan.npmSpecs[0], `${release.pi.package}@${release.pi.version}`);
    assert.deepEqual(plan.pipSpecs, Object.entries(release.python_tools).map(([name, version]) => `${name}==${version}`));
    assert.equal(plan.npmSpecs.every((spec) => /@\d+\.\d+\.\d+/.test(spec)), true);
    assert.deepEqual(plan.excludedNpmPackages, [...build.targetExclusions[target]].sort());
  }
  assert.equal(managedRuntimeBuildPlan("darwin-arm64").npmSpecs.some((spec) => spec.startsWith("@microsoft/powerbi-desktop-bridge-cli@")), false);
  assert.equal(managedRuntimeBuildPlan("win32-x64").npmSpecs.some((spec) => spec.startsWith("@microsoft/powerbi-desktop-bridge-cli@")), true);
});

test("unsupported or ambiguous build targets fail closed", () => {
  assert.throws(() => managedRuntimeBuildPlan("linux-x64"), /Unsupported/);
  assert.throws(() => managedRuntimeBuildPlan(""), /Unsupported/);
});

test("manual managed-runtime smoke covers native macOS and Windows build workers", () => {
  const workflow = readFileSync(resolve(ROOT, ".github", "workflows", "managed-desktop-smoke.yml"), "utf8");
  const verifier = readFileSync(resolve(ROOT, "scripts", "verify-managed-runtime.mjs"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /macos-latest, windows-latest/);
  assert.match(workflow, /prepare-managed-runtime\.mjs/);
  assert.match(workflow, /verify-managed-runtime\.mjs/);
  assert.match(workflow, /package:managed:mac/);
  assert.match(workflow, /package:managed:win/);
  assert.match(verifier, /COOP_DESKTOP_AGENT_DIR/);
  assert.match(verifier, /runtime\.stop/);
});

console.log(`managed runtime build plan: ${count} tests passed`);
