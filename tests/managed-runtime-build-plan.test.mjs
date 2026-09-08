import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { managedRuntimeBuildPlan } from "../scripts/managed-runtime-build-plan.mjs";
import { validateReviewWork, validateLineageWork, verifyManagedExtensionWork } from "../scripts/verify-managed-tool-work.mjs";


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

test("managed-runtime smoke covers pull requests and native macOS and Windows build workers", () => {
  const workflow = readFileSync(resolve(ROOT, ".github", "workflows", "managed-desktop-smoke.yml"), "utf8");
  const verifier = readFileSync(resolve(ROOT, "scripts", "verify-managed-runtime.mjs"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /config\/development-companions\.json/);
  assert.match(workflow, /build-development-wheels\.py/);
  assert.match(workflow, /--development-wheels/);
  assert.match(workflow, /packagedPaths/);
  assert.match(workflow, /coop-packaged-agent/);
  assert.match(workflow, /macos-latest, windows-latest/);
  assert.match(workflow, /prepare-managed-runtime\.mjs/);
  assert.match(workflow, /verify-managed-runtime\.mjs/);
  assert.match(workflow, /package:managed:mac/);
  assert.match(workflow, /package:managed:win/);
  assert.match(verifier, /COOP_DESKTOP_AGENT_DIR/);
  assert.match(verifier, /runtime\.stop/);
});

test("installed-tool evidence rejects no-op reviews, wrong versions, diagnostics and incomplete lineage", () => {
  const report = { tool: "coop-sql-review", version: "1.0.0", diagnostics: [], findings: [{ rule_id: "SQL-NO-SELECT-STAR" }] };
  const validate = value => validateReviewWork(value, report.tool, report.version, "SQL-NO-SELECT-STAR");
  assert.equal(validate(report).findings, 1);
  for (const patch of [{ tool: "other" }, { version: "0.9.0" }, { diagnostics: ["unreadable file"] }, { findings: [] }, { findings: [{ rule_id: "other" }] }]) {
    assert.throws(() => validate({ ...report, ...patch }), /did not analyze/);
  }
  const ids = ["view:silver.dim_customer", "semantic_model:legacy", "measure:legacy.total rev", "pbi_table:legacy.factsales", "silver_table:bronze.raw_erp_contact"];
  const graph = { nodes: Object.fromEntries(ids.map(id => [id, { id, name: id.endsWith("raw_erp_contact") ? "raw_erp_contact" : id }])), edges: [
    { source_id: ids[2], target_id: ids[3], edge_type: "references" },
    { source_id: ids[0], target_id: ids[4], edge_type: "reads" },
  ] };
  assert.deepEqual(validateLineageWork(graph), { nodes: 5, edges: 2 });
  assert.throws(() => validateLineageWork({ nodes: {}, edges: [] }), /lineage/);
  assert.throws(() => validateLineageWork({ ...graph, edges: graph.edges.slice(0, 1) }), /lineage/);
  assert.throws(() => validateLineageWork({ ...graph, edges: graph.edges.slice(1) }), /lineage/);
});

{
  const root = mkdtempSync(join(tmpdir(), "coop-extension-verifier-failure-"));
  const environment = { ...process.env };
  try {
    await assert.rejects(verifyManagedExtensionWork({ root: join(root, "missing-bundle"), node: process.execPath, coopRoot: root }, { tempRoot: root }), /Cannot find module/);
    assert.ok(Object.keys(process.env).length === Object.keys(environment).length && Object.keys(environment).every(key => process.env[key] === environment[key]), "Failed extension verification must restore the caller environment.");
    assert.deepEqual(readdirSync(root), [], "Failed extension verification must remove its temporary profile and source fixtures.");
    count += 1;
    console.log("  ✓ failed extension loading restores caller environment and cleans disposable state");
  } finally { rmSync(root, { recursive: true, force: true }); }
}


console.log(`managed runtime build plan: ${count} tests passed`);
