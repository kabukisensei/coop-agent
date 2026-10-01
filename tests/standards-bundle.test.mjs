import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUNDLE_ROOT, RESOLUTION_STATES, buildStandardsContext, bundledStandardsStatus, pinStandardsTask, provenanceText,
  refreshCanonical, resolveStandard, sourceStatus, standardsRegistry, writeStandardsBundle,
} from "../lib/standards.mjs";

// The bundled copy of the coop-standards wiki (ST1, Aaron 2026-10-01): the offline
// and first-run fallback after project override, canonical and stale last-known-good.
// Part 1 checks the copy this checkout ships; part 2 exercises the resolver against
// a fixture wiki bundled the way `bundle-update` does it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "coop-std-bundle-")));
const snapshots = join(tmp, "snapshots");
const remote = join(tmp, "wiki-remote");
const clone = join(tmp, "wiki-clone");
const bundle = join(tmp, "bundle");
const cache = join(tmp, "cache", "canonical"), state = join(tmp, "cache", "status.json");
const registryPath = join(tmp, "registry.json");
let now = 1_000_000, count = 0;
const test = (id, name, fn) => { fn(); count++; console.log(`  ✓ ${id} ${name}`); };
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const article = (fields, body) => `---\n${Object.entries({ layer: "agnostic", technology: "agnostic", status: "active", ...fields }).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

try {
  // --- Part 1: the shipped copy -------------------------------------------------
  test("BND-01", "config/standards-bundle verifies against the registry and covers sql, dax and semantic_model", () => {
    const status = bundledStandardsStatus({});
    assert.equal(status.state, "available", JSON.stringify(status));
    assert.equal(status.path, realpathSync(DEFAULT_BUNDLE_ROOT));
    assert.match(status.revision, /^[0-9a-f]{40}$/);
    for (const domain of ["sql", "dax", "semantic_model"]) assert.ok(status.domains.includes(domain), `bundle lacks ${domain}`);
    const meta = JSON.parse(readFileSync(join(DEFAULT_BUNDLE_ROOT, "bundle.json"), "utf8"));
    const registry = standardsRegistry().canonical;
    assert.equal(meta.repository, registry.repository); assert.equal(meta.branch, registry.authoritative_branch);
    assert.ok(meta.articles.length >= 10);
    for (const a of meta.articles) assert.ok(existsSync(join(DEFAULT_BUNDLE_ROOT, ...a.file.split("/"))), `listed article missing: ${a.file}`);
    const check = execFileSync(process.execPath, [join(ROOT, "lib", "standards-cli.mjs"), "bundle-check"], { encoding: "utf8" });
    assert.equal(JSON.parse(check).state, "available");
  });

  test("BND-02", "with no canonical cache the shipped copy answers, degraded, and the agent is told", () => {
    const opts = { canonicalRoot: join(tmp, "real-none", "canonical"), statePath: join(tmp, "real-none", "status.json"), snapshotRoot: snapshots, refresh: false, cwd: tmp };
    const r = resolveStandard("sql", opts);
    assert.equal(r.state, "bundled"); assert.equal(r.degraded, true); assert.equal(r.immutable, true); assert.equal(r.canonical_state, "unavailable");
    assert.ok(r.articles.length >= 5); assert.match(r.path, /snapshots/);
    assert.equal(resolveStandard("sql", { ...opts, authRequired: true }).canonical_state, "auth_required");
    const context = buildStandardsContext("Write a gold stored procedure for customer sales", opts);
    assert.deepEqual(context.domains, ["sql"]);
    const text = provenanceText(context.records[0]);
    assert.match(text, /state=bundled/); assert.match(text, /bundled=\d{4}-\d{2}-\d{2}/); assert.match(text, /run coop sync/);
    assert.match(context.records[0].sections.map((s) => s.heading).join(" "), /Stored Procedures/);
    const status = sourceStatus(opts);
    assert.equal(status.bundle.state, "available"); assert.equal(status.domains.sql.state, "bundled"); assert.equal(status.domains.sql.fallback, true);
    const lines = execFileSync(process.execPath, [join(ROOT, "lib", "standards-cli.mjs"), "doctor-lines", "", tmp], { encoding: "utf8", env: { ...process.env, COOP_STANDARDS_ROOT: opts.canonicalRoot, COOP_STANDARDS_STATE: opts.statePath, COOP_STANDARDS_SNAPSHOT_ROOT: snapshots, NO_COLOR: "1" } });
    assert.match(lines, /source\tbundled-copy\tavailable\t[0-9a-f]{40}\|captured \d{4}-\d{2}-\d{2}/);
    assert.match(lines, /domain\tsql\tformal_standard\/bundled\t/);
    assert.equal(resolveStandard("sql", { ...opts, bundleRoot: false }).state, "unavailable");
  });

  // --- Part 2: fixture wiki, bundled the way bundle-update does -----------------
  put(remote, "SQL/SQL Conventions.md", article({ id: "sql_conventions", title: "SQL Conventions", domain: "sql", artifact: "conventions" }, "# SQL Conventions\n## Security\nParameterize inputs.\n"));
  put(remote, "SQL/Gold/Stored Procedures.md", article({ id: "sql_gold_stored_procedures", title: "Gold Stored Procedures", domain: "sql", layer: "gold", artifact: "stored_procedure" }, "# Gold Stored Procedures\nUse schema-qualified names.\n"));
  put(remote, "Power BI/Semantic Model/DAX.md", article({ id: "powerbi_dax", title: "Power BI DAX", domain: "powerbi", layer: "semantic_model", artifact: "dax_expression", technology: "power_bi" }, "# DAX\nUse explicit measures.\n"));
  put(remote, "SQL/Drafts/Not Yet.md", article({ id: "sql_draft", title: "Draft", domain: "sql", artifact: "view", status: "draft" }, "# Draft\nNot active.\n"));
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  git(remote, ["config", "user.email", "standards@test.invalid"]); git(remote, ["config", "user.name", "Standards Test"]);
  git(remote, ["add", "."]); git(remote, ["commit", "-q", "-m", "r1"]);
  const r1 = git(remote, ["rev-parse", "HEAD"]);
  writeFileSync(registryPath, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: remote, authoritative_branch: "main", freshness_seconds: 900, timeout_seconds: 30 } }));
  const opts = (more = {}) => ({ canonicalRoot: cache, statePath: state, snapshotRoot: snapshots, registryPath, fixtureRegistry: true, remote, now: () => now, refresh: false, bundleRoot: bundle, cwd: tmp, ...more });
  const none = (more = {}) => opts({ canonicalRoot: join(tmp, "none", "canonical"), statePath: join(tmp, "none", "status.json"), ...more });

  test("BND-03", "bundle-update writes the active articles at their wiki paths plus bundle.json from a verified clone", () => {
    execFileSync("git", ["clone", "-q", "--branch", "main", remote, clone]);
    assert.throws(() => writeStandardsBundle(join(tmp, "not-a-clone"), bundle, opts()), /missing, unsafe, or dirty/);
    const result = writeStandardsBundle(clone, bundle, opts());
    assert.equal(result.revision, r1); assert.equal(result.articles, 3); assert.deepEqual(result.domains, ["dax", "sql"]);
    const meta = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));
    assert.equal(meta.repository, remote); assert.equal(meta.branch, "main"); assert.equal(meta.revision, r1); assert.equal(meta.captured_ms, now);
    assert.deepEqual(meta.articles.map((a) => a.file), ["Power BI/Semantic Model/DAX.md", "SQL/Gold/Stored Procedures.md", "SQL/SQL Conventions.md"]);
    assert.equal(existsSync(join(bundle, "SQL", "Drafts", "Not Yet.md")), false, "inactive articles are not bundled");
    // Only a bundle (or an empty / missing directory) is ever replaced.
    const other = join(tmp, "other"); mkdirSync(other); writeFileSync(join(other, "keep.txt"), "x");
    assert.throws(() => writeStandardsBundle(clone, other, opts()), /not a standards bundle/);
    assert.equal(bundledStandardsStatus(opts()).state, "available");
  });

  test("BND-04", "precedence: project override, canonical, stale last-known-good, then the bundle; same bytes give the same snapshot hash", () => {
    assert.equal(refreshCanonical(opts({ force: true })).ok, true);
    const canonical = resolveStandard("sql", opts());
    assert.equal(canonical.state, "canonical"); assert.equal(canonical.revision, r1);
    const stale = resolveStandard("sql", opts({ now: () => now + 901_000 }));
    assert.equal(stale.state, "stale_last_known_good");
    const bundled = resolveStandard("sql", none());
    assert.equal(bundled.state, "bundled"); assert.equal(bundled.revision, r1); assert.equal(bundled.sha256, canonical.sha256); assert.equal(bundled.path, canonical.path);
    assert.deepEqual(bundled.articles.map((a) => a.file), canonical.articles.map((a) => a.file));
    assert.equal(resolveStandard("documentation", none()).state, "unavailable", "a domain the bundle lacks stays unavailable");
    const project = join(tmp, "project"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "client"));
    writeFileSync(join(project, "client", "sql.md"), "# Client SQL\nClient rule.");
    writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql:\n    path: client/sql.md\n");
    assert.equal(resolveStandard("sql", none({ cwd: project })).state, "project_override");
    const pinned = pinStandardsTask(["sql", "dax"], none());
    assert.deepEqual(pinned.resolutions.map((r) => r.state), ["bundled", "bundled"]);
    assert.equal(resolveStandard("sql", none({ taskPin: pinned.taskPin })).state, "bundled", "a pinned bundled resolution survives the task");
    assert.equal(RESOLUTION_STATES.indexOf("bundled"), RESOLUTION_STATES.indexOf("stale_last_known_good") + 1);
  });

  test("BND-05", "a bundle that is edited, incomplete, extended or for another repository is no bundle", () => {
    const sqlPath = join(bundle, "SQL", "SQL Conventions.md");
    const original = readFileSync(sqlPath);
    writeFileSync(sqlPath, original.toString("utf8").replace("Parameterize inputs.", "Concatenate inputs."));
    assert.equal(resolveStandard("sql", none()).state, "unavailable", "an edited article disqualifies the bundle");
    assert.match(bundledStandardsStatus(opts()).detail, /do not match/);
    writeFileSync(sqlPath, original);
    assert.equal(resolveStandard("sql", none()).state, "bundled");
    put(bundle, "SQL/Extra.md", article({ id: "sql_extra", title: "Extra", domain: "sql", artifact: "view" }, "# Extra\n"));
    assert.equal(resolveStandard("sql", none()).state, "unavailable", "an unlisted article disqualifies the bundle");
    rmSync(join(bundle, "SQL", "Extra.md"));
    rmSync(join(bundle, "Power BI"), { recursive: true });
    assert.equal(resolveStandard("sql", none()).state, "unavailable", "a missing listed article disqualifies the bundle");
    writeStandardsBundle(clone, bundle, opts());
    const meta = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));
    writeFileSync(join(bundle, "bundle.json"), JSON.stringify({ ...meta, repository: "https://github.com/example/other-standards.git" }));
    assert.equal(resolveStandard("sql", none()).state, "unavailable", "another repository's bundle is ignored");
    assert.match(bundledStandardsStatus(opts()).detail, /another repository/);
    writeFileSync(join(bundle, "bundle.json"), JSON.stringify(meta));
    assert.equal(resolveStandard("sql", none()).state, "bundled");
  });

  console.log(`  ${count} standards bundle tests passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
