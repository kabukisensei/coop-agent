import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTHORITY_CLASSES, CANONICAL_REMOTE_STATE, activeCanonicalGeneration, buildStandardsContext, identifyTaskDomains,
  bindReviewerProvenance, projectStandardPaths, promoteReviewRun, refreshCanonical, resolveAcceptedReviewRun, resolveStandard, reviewStandardsArgs, sourceStatus,
  verifyReviewerProvenance,
} from "../lib/standards.mjs";

// Revision 9 authority resolution, exercised against a fixture shaped like the real
// cooptimize/coop-standards repository: an Obsidian wiki of front-matter articles in
// a git remote, refreshed into coop's generation cache the way `coop sync` does.
// The legacy self-authored manifest.json fixture seam is gone (#83).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "coop-std-rev9-"));
const snapshots = join(tmp, "snapshots");
const remote = join(tmp, "wiki-remote");
const cache = join(tmp, "cache", "canonical"), state = join(tmp, "cache", "status.json");
const registryPath = join(tmp, "registry.json");
let now = 1_000_000;
let count = 0;
const test = (id, name, fn) => { fn(); count++; console.log(`  ✓ ${id} ${name}`); };
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const article = (fields, body) => `---\n${Object.entries({ layer: "agnostic", technology: "agnostic", status: "active", ...fields }).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const writeWiki = (root, suffix) => {
  put(root, "SQL/SQL Conventions.md", article({ id: "sql_conventions", title: "SQL Conventions", domain: "sql", artifact: "conventions" }, `# SQL Conventions ${suffix}\n## Security\nParameterize inputs.\n`));
  put(root, "SQL/Gold/Stored Procedures.md", article({ id: "sql_gold_stored_procedures", title: "Gold Stored Procedures", domain: "sql", layer: "gold", artifact: "stored_procedure" }, `# Gold Stored Procedures ${suffix}\n## Stored procedures\nUse schema-qualified names.\n`));
  put(root, "Power BI/Semantic Model/DAX.md", article({ id: "powerbi_dax", title: "Power BI DAX", domain: "powerbi", layer: "semantic_model", artifact: "dax_expression", technology: "power_bi" }, `# DAX ${suffix}\n## Measures\nUse explicit measures.\n## Formatting\nFormat expressions.\n`));
  put(root, "Power BI/Semantic Model/Relationships.md", article({ id: "powerbi_relationships", title: "Power BI Relationships", domain: "powerbi", layer: "semantic_model", artifact: "relationship", technology: "power_bi" }, `# Relationships ${suffix}\n## Relationships and cardinality\nPrefer one-to-many relationships.\n`));
};
const gitInit = (root, message = "fixture", autocrlf = false) => {
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "standards@test.invalid"]);
  git(root, ["config", "user.name", "Standards Test"]);
  if (autocrlf) git(root, ["config", "core.autocrlf", "true"]);
  git(root, ["add", "."]); git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};
const makeReviewer = (domain, standardPath, version) => {
  const script = join(tmp, `${domain}-reviewer.mjs`);
  writeFileSync(script, `import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; import {resolve} from "node:path";\nconst a=process.argv.slice(2), i=a.indexOf("--standards"), p=resolve(i>=0?a[i+1]:${JSON.stringify(standardPath)}), h=createHash("sha256").update(readFileSync(p)).digest("hex"), count=${JSON.stringify(domain === "sql" ? "files_checked" : "models_checked")}; process.stdout.write(JSON.stringify({tool:${JSON.stringify(`coop-${domain}-review`)},schema_version:${domain === "sql" ? 4 : 3},version:${JSON.stringify(version)},[count]:0,standards:{path:p,sha256:h},findings:[],diagnostics:[],agent_review:[],summary:{error:0,warning:0,info:0},verdict:{clean:true,highest_severity:null}}));\n`);
  return { command: process.execPath, args: [script], script };
};
const reviewerReport = (reviewer, resolution) => JSON.parse(execFileSync(
  process.execPath,
  [reviewer.script, "check", tmp, "--format", "json", ...reviewStandardsArgs(resolution)],
  { encoding: "utf8" },
));

try {
  const bundledDir = join(tmp, "reviewer-bundles"); mkdirSync(bundledDir);
  const sqlBundled = join(bundledDir, "sql.md"), daxBundled = join(bundledDir, "dax.md");
  writeFileSync(sqlBundled, "# SQL reviewer standard\n## Stored procedures\nUse schema-qualified names and parameterized inputs.\n");
  writeFileSync(daxBundled, "# DAX reviewer standard\n## Measures\nUse explicit measures and variables.\n");
  const sqlReviewer = makeReviewer("sql", sqlBundled, "0.15.2");
  const daxReviewer = makeReviewer("dax", daxBundled, "0.22.0");
  const reviewerBins = { sql: sqlReviewer, dax: daxReviewer };
  // The cache is the canonical storage (`canonicalRoot` names its legacy leaf, the
  // parent is the base). `canonicalRoot: <missing>` means "no cached canonical".
  const opts = (more = {}) => ({ canonicalRoot: cache, statePath: state, snapshotRoot: snapshots, registryPath, fixtureRegistry: true, remote, now: () => now, refresh: false, reviewerBins, ...more });
  const none = (more = {}) => opts({ canonicalRoot: join(tmp, "none", "canonical"), statePath: join(tmp, "none", "status.json"), ...more });

  writeWiki(remote, "r1");
  const r1 = gitInit(remote, "r1", true);
  writeFileSync(registryPath, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: remote, authoritative_branch: "main", freshness_seconds: 900, timeout_seconds: 2 } }));

  test("STD-01", "fresh canonical bootstrap is verified from a Git remote into the generation cache", () => {
    const result = refreshCanonical(opts({ force: true }));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.revision, r1);
    const active = activeCanonicalGeneration(opts()); assert.equal(active.ok, true); assert.equal(active.revision, r1);
    const r = resolveStandard("sql", opts());
    assert.equal(r.state, "canonical"); assert.equal(r.revision, r1); assert.equal(r.file, "wiki:sql");
    assert.deepEqual(r.articles.map((a) => a.file), ["SQL/Gold/Stored Procedures.md", "SQL/SQL Conventions.md"]);
    assert.equal(JSON.parse(readFileSync(active.index)).domains.sql.sha256, r.sha256);
  });

  test("STD-02", "SQL context and reviewer-returned provenance use one immutable snapshot", () => {
    const operation = buildStandardsContext("Write a stored procedure for customer sales", opts({ cwd: tmp }));
    const record = operation.records[0];
    assert.deepEqual(operation.domains, ["sql"]); assert.match(record.sections.map((x) => x.heading).join(" "), /Gold Stored Procedures/);
    assert.equal(record.resolution.immutable, true); assert.match(record.resolution.path, /snapshots/);
    const report = reviewerReport(sqlReviewer, record.resolution);
    assert.deepEqual(verifyReviewerProvenance(record.resolution, report), { ok: true });
  });

  test("STD-02W", "content-addressed snapshots are reusable across fresh processes", () => {
    const script = join(tmp, "reuse-snapshot.mjs");
    writeFileSync(script, `import {buildStandardsContext} from ${JSON.stringify(pathToFileURL(join(ROOT, "lib", "standards.mjs")).href)};\nconst options=JSON.parse(process.argv[2]); const record=buildStandardsContext("Write a stored procedure",options).records[0]; process.stdout.write(JSON.stringify({path:record.resolution.path,headings:record.sections.map((section)=>section.heading)}));\n`);
    const childOptions = JSON.stringify({ cwd: tmp, canonicalRoot: cache, statePath: state, snapshotRoot: snapshots, registryPath, fixtureRegistry: true, remote, refresh: false });
    const run = () => JSON.parse(execFileSync(process.execPath, [script, childOptions], { encoding: "utf8" }));
    const first = run(), second = run();
    assert.equal(first.path, second.path);
    assert.match(first.headings.join(" "), /Gold Stored Procedures/);
    assert.match(second.headings.join(" "), /Gold Stored Procedures/);
  });

  test("STD-03", "DAX provenance mismatch is rejected", () => {
    const operation = buildStandardsContext("Repair this DAX measure expression", opts({ cwd: tmp }));
    const r = operation.records[0].resolution;
    assert.equal(r.domain, "dax"); assert.equal(r.state, "canonical");
    const report = reviewerReport(daxReviewer, r);
    assert.deepEqual(verifyReviewerProvenance(r, report), { ok: true });
    report.standards.sha256 = "0".repeat(64);
    assert.match(verifyReviewerProvenance(r, report).error, /hash mismatch/);
    report.standards.sha256 = r.sha256;
    report.standards.revision = "reviewer-owned-revision";
    assert.match(verifyReviewerProvenance(r, report).error, /provenance schema is invalid/);
    report.standards.revision = 7;
    assert.match(verifyReviewerProvenance(r, report).error, /revision claim is malformed|provenance schema is invalid/);
    delete report.standards.revision;
    const bound = bindReviewerProvenance(r, report);
    assert.equal(bound.binding.owner, "coop"); assert.equal(bound.binding.revision, r.revision);
    assert.match(verifyReviewerProvenance(r, report, { ...bound.binding, revision: "tampered" }).error, /binding mismatch/);
    delete report.standards;
    assert.match(verifyReviewerProvenance(r, report).error, /provenance is missing|unknown or missing fields/);
    assert.match(verifyReviewerProvenance(r, null).error, /envelope is missing|provenance is missing/);
  });

  test("STD-04", "semantic model, DAX, documentation and selective Incremental BI stay separate", () => {
    // Mirrors cooptimize/incremental-bi: layer folders, `layer:` front matter, an unlayered editing guide.
    const pattern = join(tmp, "incremental-bi"); mkdirSync(join(pattern, "Semantic Model"), { recursive: true }); mkdirSync(join(pattern, "Gold"));
    writeFileSync(join(pattern, "AGENTS.md"), "---\npublish: false\n---\n# Writing and editing this wiki\n## Refresh the wiki\nEditing guide only.\n");
    writeFileSync(join(pattern, "Gold", "Incremental Fact Considerations.md"), "---\ntitle: Incremental fact considerations\nlayer: gold\n---\n## Refresh gold facts\nGold only.\n");
    writeFileSync(join(pattern, "Semantic Model", "Power BI Incremental Refresh.md"), "---\ntitle: Power BI incremental refresh\nlayer: semantic-model\n---\n## Refresh partitions\nUse bounded refresh windows.\n## Unrelated appendix\nDo not inject globally.\n");
    const operation = buildStandardsContext("Review semantic model relationships, DAX measures, documentation, and incremental refresh", opts({ cwd: tmp, incrementalBiRoot: pattern }));
    assert.deepEqual(operation.domains, ["semantic_model", "dax", "documentation"]);
    assert.equal(operation.records.find((x) => x.resolution.domain === "documentation").resolution.state, "unavailable");
    assert.equal(operation.patterns[0].authority_class, "approved_pattern"); assert.equal(operation.patterns[0].selective, true);
    assert.match(operation.patterns[0].sections.map((x) => x.heading).join(" "), /Refresh partitions/);
    assert.doesNotMatch(operation.patterns[0].sections.map((x) => x.heading).join(" "), /Unrelated appendix/);
    assert.deepEqual([...new Set(operation.patterns[0].sections.map((x) => x.path.split(/[\\/]/).slice(-2).join("/")))], ["Semantic Model/Power BI Incremental Refresh.md"]);
  });

  test("STD-05", "contained project override wins canonical and preserves source provenance", () => {
    const project = join(tmp, "project"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "client"));
    writeFileSync(join(project, "client", "sql.md"), "# Client SQL\nClient rule.");
    writeFileSync(join(project, ".coop", "project.yml"), "custom_key: keep-me\nstandards:\n  sql: client/sql.md # v0.23.1 shape\n");
    const r = resolveStandard("sql", opts({ cwd: project }));
    assert.equal(r.state, "project_override"); assert.equal(r.source_path, resolve(project, "client", "sql.md")); assert.match(r.path, /snapshots/);
  });

  test("STD-06", "unavailable canonical uses verified stale, bundled, unavailable, and auth states", () => {
    const stale = resolveStandard("sql", opts({ now: () => now + 901_000 }));
    assert.equal(stale.state, "stale_last_known_good"); assert.equal(stale.revision, r1);
    assert.equal(resolveStandard("dax", none({ cwd: tmp })).state, "bundled_fallback");
    assert.equal(resolveStandard("semantic_model", none({ cwd: tmp })).state, "unavailable");
    assert.equal(resolveStandard("semantic_model", none({ cwd: tmp, authRequired: true })).state, "auth_required");
  });

  test("STD-07", "bundled SQL and DAX fixtures provide real bounded guidance and reviewer provenance", () => {
    for (const [domain, prompt, expected, reviewer] of [["sql", "Implement a SQL stored procedure", /schema-qualified/, sqlReviewer], ["dax", "Validate a DAX measure", /explicit measures/, daxReviewer]]) {
      const operation = buildStandardsContext(prompt, none({ cwd: tmp }));
      const record = operation.records.find((x) => x.resolution.domain === domain);
      assert.equal(record.resolution.state, "bundled_fallback"); assert.match(record.sections.map((x) => x.content).join("\n"), expected);
      const report = reviewerReport(reviewer, record.resolution);
      assert.deepEqual(verifyReviewerProvenance(record.resolution, report), { ok: true });
    }
  });

  test("STD-07P", "accepted bundled provenance is re-derived from each reviewer contract", () => {
    const outdir = join(tmp, "bundled-reviews"), entries = []; mkdirSync(outdir);
    for (const [domain, reviewer] of [["sql", sqlReviewer], ["dax", daxReviewer]]) {
      const resolution = resolveStandard(domain, none({ cwd: tmp }));
      const report = reviewerReport(reviewer, resolution), resolutionPath = join(tmp, `bundled-${domain}-resolution.json`), reportPath = join(tmp, `bundled-${domain}-report.json`);
      writeFileSync(resolutionPath, JSON.stringify(resolution)); writeFileSync(reportPath, JSON.stringify(report)); entries.push({ domain, resolutionPath, reportPath });
    }
    assert.equal(promoteReviewRun(outdir, entries, { reviewerBins }).ok, true);
    assert.equal(resolveAcceptedReviewRun(outdir, { reviewerBins }).ok, true);
    writeFileSync(daxBundled, readFileSync(sqlBundled));
    assert.equal(resolveAcceptedReviewRun(outdir, { reviewerBins }).ok, false);
    writeFileSync(daxBundled, "# DAX reviewer standard\n## Measures\nUse explicit measures and variables.\n");
  });

  test("STD-07F", "failed bundled discovery is truthful", () => {
    const reviewerScript = (name, body) => {
      const script = join(tmp, `${name}.mjs`);
      writeFileSync(script, body);
      return { command: process.execPath, args: [script], script };
    };
    const missing = { command: join(tmp, "does-not-exist") };
    const malformed = reviewerScript("malformed-reviewer", 'process.stdout.write("not-json")');
    const absent = reviewerScript("absent-provenance-reviewer", 'process.stdout.write(JSON.stringify({version:"1.0.0",findings:[]}))');
    const badHash = reviewerScript("bad-hash-reviewer", `process.stdout.write(JSON.stringify({version:"1.0.0",standards:{path:${JSON.stringify(sqlBundled)},sha256:"${"0".repeat(64)}"}}))`);
    for (const reviewer of [missing, malformed, absent, badHash]) {
      const r = resolveStandard("sql", none({ cwd: tmp, reviewerBins: { sql: reviewer } }));
      assert.equal(r.state, "unavailable");
      assert.equal(r.path, null); assert.equal(r.revision, null); assert.equal(r.sha256, null);
    }
    const auth = resolveStandard("sql", none({ cwd: tmp, reviewerBins: { sql: missing }, authRequired: true }));
    assert.equal(auth.state, "auth_required");

    const explicitRevision = reviewerScript("explicit-revision-reviewer", `import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; import {resolve} from "node:path"; const a=process.argv.slice(2), i=a.indexOf("--standards"), p=resolve(i>=0?a[i+1]:${JSON.stringify(sqlBundled)}), sha256=createHash("sha256").update(readFileSync(p)).digest("hex"); process.stdout.write(JSON.stringify({tool:"coop-sql-review",schema_version:4,version:"test",files_checked:0,standards:{path:p,sha256,revision:"standard-r7"},findings:[],diagnostics:[],agent_review:[],summary:{error:0,warning:0,info:0},verdict:{clean:true,highest_severity:null}}));`);
    const explicit = resolveStandard("sql", none({ cwd: tmp, reviewerBins: { sql: explicitRevision } }));
    assert.equal(explicit.state, "unavailable");

    const malformedRevision = reviewerScript("malformed-revision-reviewer", `import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; const p=${JSON.stringify(sqlBundled)}, sha256=createHash("sha256").update(readFileSync(p)).digest("hex"); process.stdout.write(JSON.stringify({standards:{path:p,sha256,revision:7},findings:[]}));`);
    assert.equal(resolveStandard("sql", none({ cwd: tmp, reviewerBins: { sql: malformedRevision } })).state, "unavailable");

    const discoveryOnly = reviewerScript("discovery-only-reviewer", `import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; const a=process.argv.slice(2), p=${JSON.stringify(sqlBundled)}, sha256=a.includes("--standards")?"${"0".repeat(64)}":createHash("sha256").update(readFileSync(p)).digest("hex"); process.stdout.write(JSON.stringify({version:"1.0.0",standards:{path:p,sha256},findings:[]}));`);
    const incompatibleOptions = none({ cwd: tmp, reviewerBins: { sql: discoveryOnly } });
    assert.equal(resolveStandard("sql", incompatibleOptions).state, "unavailable");
    assert.equal(sourceStatus(incompatibleOptions).domains.sql.state, "unavailable");

    const badBin = join(tmp, "bad-reviewer-bin"); mkdirSync(badBin);
    for (const [name, standardPath] of [["coop-sql-review", sqlBundled], ["coop-dax-review", daxBundled]]) {
      const script = join(badBin, name);
      writeFileSync(script, `#!/usr/bin/env node\nimport {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; const a=process.argv.slice(2), i=a.indexOf("--standards"), p=i>=0?a[i+1]:${JSON.stringify(standardPath)}, sha256=i>=0?"${"0".repeat(64)}":createHash("sha256").update(readFileSync(p)).digest("hex"); process.stdout.write(JSON.stringify({version:"1.0.0",standards:{path:p,sha256},findings:[]}));\n`);
      chmodSync(script, 0o755);
    }
    const env = { ...process.env, PATH: `${badBin}:${process.env.PATH}`, COOP_STANDARDS_ROOT: join(tmp, "none", "canonical"), COOP_STANDARDS_STATE: join(tmp, "none", "status.json"), COOP_STANDARDS_SNAPSHOT_ROOT: snapshots, COOP_DIR: join(tmp, "failed-support-home"), NO_COLOR: "1" };
    const lines = execFileSync(process.execPath, [join(ROOT, "lib", "standards-cli.mjs"), "doctor-lines", "", tmp], { encoding: "utf8", env });
    assert.match(lines, /domain\tsql\tformal_standard\/unavailable/);
    const doctor = spawnSync("bash", [join(ROOT, "scripts", "doctor.sh")], { cwd: tmp, encoding: "utf8", env });
    assert.match(`${doctor.stdout}\n${doctor.stderr}`, /domain sql: formal_standard\/unavailable/);
    const support = JSON.parse(execFileSync(process.execPath, [join(ROOT, "lib", "support-center-cli.mjs"), "--json"], { encoding: "utf8", env }));
    assert.equal(support.manifest.components.find((x) => x.component === "standards").status, "degraded");
  });

  test("STD-08", "v0.23.1 paths resolve without rewriting the contract", () => {
    const project = join(tmp, "legacy"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "docs", "standards"), { recursive: true });
    writeFileSync(join(project, "docs", "standards", "sql-standards.md"), "# legacy SQL");
    const yml = "# retained\nstandards:\n  sql: 'docs/standards/sql-standards.md' # old shape\nunknown: retained\n";
    const contract = join(project, ".coop", "project.yml"); writeFileSync(contract, yml);
    assert.deepEqual(projectStandardPaths(yml), { sql: "docs/standards/sql-standards.md" });
    const r = resolveStandard("sql", opts({ cwd: project }));
    assert.equal(r.state, "project_override"); assert.equal(readFileSync(contract, "utf8"), yml);
  });

  test("STD-08b", "nested standards.<domain>.path overrides resolve like the scalar shape", () => {
    const project = join(tmp, "nested"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "docs"), { recursive: true });
    writeFileSync(join(project, "docs", "client-sql.md"), "# client SQL");
    const yml = "standards:\n  sql:\n    path: \"docs/client-sql.md\"\n    section_refs: numeric\n  dax: # canonical\n# sql:\n#   path: ignored.md\n";
    writeFileSync(join(project, ".coop", "project.yml"), yml);
    assert.deepEqual(projectStandardPaths(yml), { sql: "docs/client-sql.md" });
    const r = resolveStandard("sql", opts({ cwd: project }));
    assert.equal(r.state, "project_override"); assert.equal(r.project_relative_path, "docs/client-sql.md");
  });

  test("STD-08c", "overrides indented by four spaces resolve like two (the first key sets the indent)", () => {
    const project = join(tmp, "four-space"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "docs"), { recursive: true });
    writeFileSync(join(project, "docs", "client-sql.md"), "# client SQL");
    const yml = "standards:\n    sql: docs/client-sql.md\n";
    writeFileSync(join(project, ".coop", "project.yml"), yml);
    assert.deepEqual(projectStandardPaths(yml), { sql: "docs/client-sql.md" });
    const r = resolveStandard("sql", opts({ cwd: project }));
    assert.equal(r.state, "project_override"); assert.equal(r.project_relative_path, "docs/client-sql.md");
    assert.deepEqual(projectStandardPaths("standards:\n    sql:\n        path: docs/client-sql.md\n    dax: docs/dax.md\n"), { sql: "docs/client-sql.md", dax: "docs/dax.md" });
  });

  test("STD-09", "authority classes remain closed and separate", () => {
    assert.deepEqual([...AUTHORITY_CLASSES], ["formal_standard", "approved_pattern", "team_knowledge", "project_local"]);
  });

  test("STD-10", "sync, Doctor lines, and Support independently report truthful canonical state", () => {
    assert.equal(refreshCanonical(opts({ force: true })).ok, true);
    const status = sourceStatus(opts({ cwd: tmp }));
    assert.equal(status.canonical_remote, CANONICAL_REMOTE_STATE); assert.equal(status.sources[0].revision, r1); assert.equal(status.sources[0].state, "available");
    // The CLI, doctor and Support use the committed production registry, which names
    // the private GitHub remote: this fixture's cache is not its authority.
    const env = { ...process.env, COOP_STANDARDS_ROOT: cache, COOP_STANDARDS_STATE: state, COOP_STANDARDS_SNAPSHOT_ROOT: snapshots, COOP_DIR: join(tmp, "support-home"), NO_COLOR: "1" };
    const lines = execFileSync(process.execPath, [join(ROOT, "lib", "standards-cli.mjs"), "doctor-lines", "", tmp], { encoding: "utf8", env });
    assert.match(lines, /canonical-remote\tconfigured\thttps:\/\/github\.com\/cooptimize\/coop-standards\.git\|main/);
    for (const domain of ["sql", "dax", "semantic_model"]) assert.match(lines, new RegExp(`domain\\t${domain}\\tformal_standard/unavailable`));
    const doctor = spawnSync("bash", [join(ROOT, "scripts", "doctor.sh")], { cwd: tmp, encoding: "utf8", env });
    assert.match(`${doctor.stdout}\n${doctor.stderr}`, /source canonical-remote: configured/);
    assert.match(`${doctor.stdout}\n${doctor.stderr}`, /domain sql: formal_standard\/unavailable/);
    const support = JSON.parse(execFileSync(process.execPath, [join(ROOT, "lib", "support-center-cli.mjs"), "--json"], { encoding: "utf8", env }));
    assert.equal(support.manifest.components.find((x) => x.component === "standards").status, "degraded");
    assert.equal(support.standards.canonical_remote, CANONICAL_REMOTE_STATE);
  });

  test("SECURITY", "project traversal, POSIX/Windows absolute paths, symlink escape, and non-files are rejected", () => {
    const project = join(tmp, "hostile-project"); mkdirSync(join(project, ".coop"), { recursive: true });
    const outside = join(tmp, "sensitive.md"); writeFileSync(outside, "SECRET-MUST-NOT-BE-READ");
    symlinkSync(outside, join(project, "escape.md")); mkdirSync(join(project, "directory.md"));
    for (const configured of ["../sensitive.md", "..\\sensitive.md", outside, "C:\\Users\\victim\\secret.md", "\\\\server\\share\\secret.md", "escape.md", "directory.md"]) {
      writeFileSync(join(project, ".coop", "project.yml"), `standards:\n  sql: '${configured.replaceAll("'", "''")}'\n`);
      const r = resolveStandard("sql", opts({ cwd: project }));
      assert.equal(r.state, "canonical", configured); assert.notEqual(r.source_path, outside);
      assert.equal(readFileSync(r.path, "utf8").includes("SECRET"), false, configured);
    }
  });

  test("IMMUTABLE", "source mutation after context resolution cannot change reviewer bytes", () => {
    const project = join(tmp, "mutation-project"); mkdirSync(join(project, ".coop"), { recursive: true });
    writeFileSync(join(project, "sql.md"), "# ORIGINAL\n## Security\nParameterize.");
    writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: sql.md\n");
    const record = buildStandardsContext("Inspect this SQL", opts({ cwd: project })).records[0];
    writeFileSync(record.resolution.source_path, "# MUTATED SECRET");
    assert.match(record.sections.map((x) => x.content).join("\n"), /Parameterize/); assert.equal(readFileSync(record.resolution.path, "utf8").includes("MUTATED"), false);
    const report = reviewerReport(sqlReviewer, record.resolution);
    assert.deepEqual(verifyReviewerProvenance(record.resolution, report), { ok: true });
  });

  test("IMMUTABLE", "snapshot mutation fails closed", () => {
    const project = join(tmp, "snapshot-attack"); mkdirSync(join(project, ".coop"), { recursive: true });
    writeFileSync(join(project, "sql.md"), "# UNIQUE SNAPSHOT ATTACK"); writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: sql.md\n");
    const r = resolveStandard("sql", opts({ cwd: project }));
    chmodSync(r.path, 0o600); writeFileSync(r.path, "changed");
    assert.match(verifyReviewerProvenance(r, {}).error, /snapshot hash mismatch/);
  });

  test("CANONICAL", "a checkout without active articles, and a dirty checkout, never resolve as current authority", () => {
    const empty = join(tmp, "empty-remote"); mkdirSync(empty); writeFileSync(join(empty, "README.md"), "no articles\n"); gitInit(empty, "empty");
    const emptyRegistry = join(tmp, "empty-registry.json");
    writeFileSync(emptyRegistry, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: empty, authoritative_branch: "main", freshness_seconds: 900, timeout_seconds: 2 } }));
    const emptyOptions = opts({ canonicalRoot: join(tmp, "empty-cache", "canonical"), statePath: join(tmp, "empty-cache", "status.json"), registryPath: emptyRegistry, remote: empty });
    const refreshed = refreshCanonical({ ...emptyOptions, force: true });
    assert.equal(refreshed.ok, false); assert.match(refreshed.detail || "", /no active articles/);
    assert.notEqual(resolveStandard("sql", { ...emptyOptions, cwd: tmp }).state, "canonical");

    const active = activeCanonicalGeneration(opts()); assert.equal(active.ok, true);
    writeFileSync(join(active.checkout, "dirty.txt"), "preserve");
    try {
      assert.notEqual(resolveStandard("sql", opts({ cwd: tmp })).state, "canonical");
      assert.notEqual(sourceStatus(opts({ cwd: tmp })).sources[0].state, "available");
      assert.equal(readFileSync(join(active.checkout, "dirty.txt"), "utf8"), "preserve");
    } finally {
      rmSync(join(active.checkout, "dirty.txt"), { force: true });
    }
    assert.equal(resolveStandard("sql", opts({ cwd: tmp })).state, "canonical");
  });

  test("CLASSIFIER", "ordinary SQL, DAX, model, Fabric, and documentation work is automatic", () => {
    assert.deepEqual(identifyTaskDomains("Implement a SQL stored procedure"), ["sql"]);
    assert.deepEqual(identifyTaskDomains("Validate a DAX measure"), ["dax"]);
    assert.deepEqual(identifyTaskDomains("Assess semantic model relationships"), ["semantic_model", "dax"]);
    assert.deepEqual(identifyTaskDomains("Analyze a Fabric lakehouse architecture"), ["fabric"]);
    assert.deepEqual(identifyTaskDomains("Update README documentation"), ["documentation"]);
  });

  test("CLASSIFIER", "adjacent technical tasks do not collide with standards domains", () => {
    assert.deepEqual(identifyTaskDomains("Review this Power Query transformation"), []);
    assert.deepEqual(identifyTaskDomains("Design a lakehouse architecture"), ["fabric"]);
    assert.deepEqual(identifyTaskDomains("Optimize a search query"), []);
    assert.deepEqual(identifyTaskDomains("What time is the meeting?"), []);
    assert.deepEqual(identifyTaskDomains("Fix this regular expression in the JavaScript parser"), []);
  });

  console.log(`  standards Revision 9: ${count} tests passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
