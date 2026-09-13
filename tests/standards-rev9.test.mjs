import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTHORITY_CLASSES, CANONICAL_REMOTE_STATE, buildStandardsContext, identifyTaskDomains,
  projectStandardPaths, resolveStandard, reviewStandardsArgs, sourceStatus,
  syncCanonicalLocal, validateManifest, verifyReviewerProvenance,
} from "../lib/standards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "coop-std-rev9-"));
const snapshots = join(tmp, "snapshots");
let count = 0;
const test = (id, name, fn) => { fn(); count++; console.log(`  ✓ ${id} ${name}`); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const writeAuthority = (root, contents, revision = "rev-test") => {
  mkdirSync(root, { recursive: true });
  const domains = {};
  for (const [domain, text] of Object.entries(contents)) {
    const path = `${domain}.md`;
    writeFileSync(join(root, path), text);
    domains[domain] = { path, sha256: hash(text) };
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema_version: 1, revision, domains }, null, 2));
};
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const gitInit = (root, message = "fixture") => {
  execFileSync("git", ["init", "-q", root]);
  git(root, ["config", "user.email", "standards@test.invalid"]);
  git(root, ["config", "user.name", "Standards Test"]);
  git(root, ["add", "."]); git(root, ["commit", "-q", "-m", message]);
};
const makeReviewer = (domain, standardPath, version) => {
  const script = join(tmp, `${domain}-reviewer.mjs`);
  writeFileSync(script, `import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; import {resolve} from "node:path";\nconst a=process.argv.slice(2), i=a.indexOf("--standards"), p=resolve(i>=0?a[i+1]:${JSON.stringify(standardPath)}), h=createHash("sha256").update(readFileSync(p)).digest("hex"); process.stdout.write(JSON.stringify({tool:${JSON.stringify(`coop-${domain}-review`)},version:${JSON.stringify(version)},standards:{path:p,sha256:h},findings:[]}));\n`);
  return { command: process.execPath, args: [script], script };
};

try {
  const bundledDir = join(tmp, "reviewer-bundles"); mkdirSync(bundledDir);
  const sqlBundled = join(bundledDir, "sql.md"), daxBundled = join(bundledDir, "dax.md");
  writeFileSync(sqlBundled, "# SQL reviewer standard\n## Stored procedures\nUse schema-qualified names and parameterized inputs.\n");
  writeFileSync(daxBundled, "# DAX reviewer standard\n## Measures\nUse explicit measures and variables.\n");
  const sqlReviewer = makeReviewer("sql", sqlBundled, "0.15.2");
  const daxReviewer = makeReviewer("dax", daxBundled, "0.22.0");
  const reviewerBins = { sql: sqlReviewer, dax: daxReviewer };
  const opts = (more = {}) => ({ snapshotRoot: snapshots, reviewerBins, ...more });

  const remote = join(tmp, "fake-remote");
  writeAuthority(remote, {
    sql: "# SQL\n## Stored procedures\nUse schema-qualified names.\n## Security\nParameterize inputs.",
    dax: "# DAX\n## Measures\nUse explicit measures.\n## Formatting\nFormat expressions.",
    semantic_model: "# Model\n## Relationships and cardinality\nPrefer one-to-many relationships.\n## Technical column visibility\nHide technical columns.",
    documentation: "# Docs\n## Metadata descriptions\nDescribe business meaning.",
    fabric: "# Fabric\n## Workspaces\nSeparate environments.",
  }, "fixture-r1");
  gitInit(remote);
  const canonical = join(tmp, "cache", "canonical");

  test("STD-01", "fresh canonical bootstrap is verified from a local Git source", () => {
    const result = syncCanonicalLocal(remote, canonical);
    assert.equal(result.ok, true); assert.equal(result.state, "canonical");
    assert.equal(resolveStandard("sql", opts({ cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none") })).revision, "fixture-r1");
  });

  test("STD-02", "SQL context and reviewer-returned provenance use one immutable snapshot", () => {
    const operation = buildStandardsContext("Write a stored procedure for customer sales", opts({ cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none") }));
    const record = operation.records[0];
    assert.deepEqual(operation.domains, ["sql"]); assert.match(record.sections.map((x) => x.heading).join(" "), /Stored procedures/);
    assert.equal(record.resolution.immutable, true); assert.notEqual(record.resolution.path, record.resolution.source_path);
    const report = JSON.parse(execFileSync(process.execPath, [sqlReviewer.script, "check", tmp, "--format", "json", ...reviewStandardsArgs(record.resolution)], { encoding: "utf8" }));
    assert.deepEqual(verifyReviewerProvenance(record.resolution, report), { ok: true });
  });

  test("STD-03", "DAX provenance mismatch is rejected", () => {
    const operation = buildStandardsContext("Repair this DAX measure expression", opts({ cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none") }));
    const r = operation.records[0].resolution;
    const report = JSON.parse(execFileSync(process.execPath, [daxReviewer.script, "check", tmp, "--format", "json", ...reviewStandardsArgs(r)], { encoding: "utf8" }));
    assert.deepEqual(verifyReviewerProvenance(r, report), { ok: true });
    report.standards.sha256 = "0".repeat(64);
    assert.match(verifyReviewerProvenance(r, report).error, /hash mismatch/);
  });

  test("STD-04", "semantic model, DAX, documentation and selective Incremental BI stay separate", () => {
    const pattern = join(tmp, "incremental-bi"); mkdirSync(pattern);
    writeFileSync(join(pattern, "incremental-refresh.md"), "# Incremental BI\n## Refresh partitions\nUse bounded refresh windows.\n## Unrelated appendix\nDo not inject globally.\n");
    const operation = buildStandardsContext("Review semantic model relationships, DAX measures, documentation, and incremental refresh", opts({ cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none"), incrementalBiRoot: pattern }));
    assert.deepEqual(operation.domains, ["semantic_model", "dax", "documentation"]);
    assert.equal(operation.patterns[0].authority_class, "approved_pattern"); assert.equal(operation.patterns[0].selective, true);
    assert.match(operation.patterns[0].sections.map((x) => x.heading).join(" "), /Refresh partitions/);
    assert.doesNotMatch(operation.patterns[0].sections.map((x) => x.heading).join(" "), /Unrelated appendix/);
  });

  test("STD-05", "contained project override wins canonical and preserves source provenance", () => {
    const project = join(tmp, "project"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "client"));
    writeFileSync(join(project, "client", "sql.md"), "# Client SQL\nClient rule.");
    writeFileSync(join(project, ".coop", "project.yml"), "custom_key: keep-me\nstandards:\n  sql: client/sql.md # v0.23.1 shape\n");
    const r = resolveStandard("sql", opts({ cwd: project, canonicalRoot: canonical, staleRoot: join(tmp, "none") }));
    assert.equal(r.state, "project_override"); assert.match(r.source_path, /client\/sql\.md$/); assert.match(r.path, /snapshots/);
  });

  test("STD-06", "unavailable canonical uses verified stale, bundled, unavailable, and auth states", () => {
    const stale = join(tmp, "lkg"); writeAuthority(stale, { sql: "# Stale SQL" }, "lkg-r1");
    assert.equal(resolveStandard("sql", opts({ cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: stale })).state, "stale_last_known_good");
    assert.equal(resolveStandard("dax", opts({ cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2") })).state, "bundled_fallback");
    assert.equal(resolveStandard("semantic_model", opts({ cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2") })).state, "unavailable");
    assert.equal(resolveStandard("semantic_model", opts({ cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2"), authRequired: true })).state, "auth_required");
  });

  test("STD-07", "bundled SQL and DAX fixtures provide real bounded guidance and reviewer provenance", () => {
    for (const [domain, prompt, expected, reviewer] of [["sql", "Implement a SQL stored procedure", /schema-qualified/, sqlReviewer], ["dax", "Validate a DAX measure", /explicit measures/, daxReviewer]]) {
      const operation = buildStandardsContext(prompt, opts({ cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2") }));
      const record = operation.records.find((x) => x.resolution.domain === domain);
      assert.equal(record.resolution.state, "bundled_fallback"); assert.match(record.sections.map((x) => x.content).join("\n"), expected);
      const report = JSON.parse(execFileSync(process.execPath, [reviewer.script, "check", tmp, "--format", "json", ...reviewStandardsArgs(record.resolution)], { encoding: "utf8" }));
      assert.deepEqual(verifyReviewerProvenance(record.resolution, report), { ok: true });
    }
  });

  test("STD-08", "v0.23.1 paths resolve without rewriting the contract", () => {
    const project = join(tmp, "legacy"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "docs", "standards"), { recursive: true });
    writeFileSync(join(project, "docs", "standards", "sql-standards.md"), "# legacy SQL");
    const yml = "# retained\nstandards:\n  sql: 'docs/standards/sql-standards.md' # old shape\nunknown: retained\n";
    const contract = join(project, ".coop", "project.yml"); writeFileSync(contract, yml);
    assert.deepEqual(projectStandardPaths(yml), { sql: "docs/standards/sql-standards.md" });
    const r = resolveStandard("sql", opts({ cwd: project, canonicalRoot: canonical }));
    assert.equal(r.state, "project_override"); assert.equal(readFileSync(contract, "utf8"), yml);
  });

  test("STD-09", "authority classes remain closed and separate", () => {
    assert.deepEqual([...AUTHORITY_CLASSES], ["formal_standard", "approved_pattern", "team_knowledge", "project_local"]);
  });

  test("STD-10", "sync, Doctor lines, and Support independently report truthful canonical state", () => {
    assert.equal(syncCanonicalLocal(remote, canonical).ok, true);
    const status = sourceStatus(opts({ cwd: tmp, canonicalRoot: canonical }));
    assert.equal(status.canonical_remote, CANONICAL_REMOTE_STATE); assert.equal(status.sources[0].state, "available");
    const env = { ...process.env, COOP_STANDARDS_ROOT: canonical, COOP_STANDARDS_LKG_ROOT: join(tmp, "none"), COOP_STANDARDS_SNAPSHOT_ROOT: snapshots, COOP_DIR: join(tmp, "support-home"), NO_COLOR: "1" };
    const lines = execFileSync(process.execPath, [join(ROOT, "lib", "standards-cli.mjs"), "doctor-lines", "", tmp], { encoding: "utf8", env });
    assert.match(lines, /canonical-remote\tPENDING_OWNER_PROVISIONING/); assert.match(lines, /cooptimize-formal-standards\tavailable/);
    const doctor = spawnSync("bash", [join(ROOT, "scripts", "doctor.sh")], { cwd: tmp, encoding: "utf8", env });
    assert.match(`${doctor.stdout}\n${doctor.stderr}`, /source canonical-remote: PENDING_OWNER_PROVISIONING/);
    assert.match(`${doctor.stdout}\n${doctor.stderr}`, /source cooptimize-formal-standards: available/);
    const support = JSON.parse(execFileSync(process.execPath, [join(ROOT, "lib", "support-center-cli.mjs"), "--json"], { encoding: "utf8", env }));
    assert.equal(support.manifest.components.find((x) => x.component === "standards").status, "ok");
    assert.equal(support.standards.canonical_remote, CANONICAL_REMOTE_STATE);
  });

  test("SECURITY", "project traversal, POSIX/Windows absolute paths, symlink escape, and non-files are rejected", () => {
    const project = join(tmp, "hostile-project"); mkdirSync(join(project, ".coop"), { recursive: true });
    const outside = join(tmp, "sensitive.md"); writeFileSync(outside, "SECRET-MUST-NOT-BE-READ");
    symlinkSync(outside, join(project, "escape.md")); mkdirSync(join(project, "directory.md"));
    for (const configured of ["../sensitive.md", "..\\sensitive.md", outside, "C:\\Users\\victim\\secret.md", "\\\\server\\share\\secret.md", "escape.md", "directory.md"]) {
      writeFileSync(join(project, ".coop", "project.yml"), `standards:\n  sql: '${configured.replaceAll("'", "''")}'\n`);
      const r = resolveStandard("sql", opts({ cwd: project, canonicalRoot: canonical, staleRoot: join(tmp, "none") }));
      assert.equal(r.state, "canonical", configured); assert.notEqual(r.source_path, outside);
    }
  });

  test("SCHEMA", "runtime follows schema for exact keys, paths, types, enums, and hashes", () => {
    const valid = { schema_version: 1, revision: "r1", domains: { sql: { path: "nested/sql.md", sha256: "a".repeat(64) } } };
    assert.deepEqual(validateManifest(valid), []);
    const mutations = [
      { ...valid, extra: true }, { ...valid, revision: "" }, { ...valid, schema_version: 2 },
      { ...valid, domains: { python: valid.domains.sql } },
      { ...valid, domains: { sql: { ...valid.domains.sql, extra: true } } },
      { ...valid, domains: { sql: { path: "", sha256: "a".repeat(64) } } },
      { ...valid, domains: { sql: { path: "../sql.md", sha256: "a".repeat(64) } } },
      { ...valid, domains: { sql: { path: "/etc/passwd", sha256: "a".repeat(64) } } },
      { ...valid, domains: { sql: { path: "C:\\secret.md", sha256: "a".repeat(64) } } },
      { ...valid, domains: { sql: { path: "sql.md", sha256: "A".repeat(64) } } },
    ];
    for (const mutation of mutations) assert.ok(validateManifest(mutation).length, JSON.stringify(mutation));
  });

  test("IMMUTABLE", "source mutation after context resolution cannot change reviewer bytes", () => {
    const project = join(tmp, "mutation-project"); mkdirSync(join(project, ".coop"), { recursive: true });
    writeFileSync(join(project, "sql.md"), "# ORIGINAL\n## Security\nParameterize.");
    writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: sql.md\n");
    const record = buildStandardsContext("Inspect this SQL", opts({ cwd: project, canonicalRoot: canonical })).records[0];
    writeFileSync(record.resolution.source_path, "# MUTATED SECRET");
    assert.match(record.sections.map((x) => x.content).join("\n"), /Parameterize/); assert.equal(readFileSync(record.resolution.path, "utf8").includes("MUTATED"), false);
    const report = JSON.parse(execFileSync(process.execPath, [sqlReviewer.script, "check", tmp, "--format", "json", ...reviewStandardsArgs(record.resolution)], { encoding: "utf8" }));
    assert.deepEqual(verifyReviewerProvenance(record.resolution, report), { ok: true });
  });

  test("IMMUTABLE", "snapshot mutation fails closed", () => {
    const project = join(tmp, "snapshot-attack"); mkdirSync(join(project, ".coop"), { recursive: true });
    writeFileSync(join(project, "sql.md"), "# UNIQUE SNAPSHOT ATTACK"); writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: sql.md\n");
    const r = resolveStandard("sql", opts({ cwd: project, canonicalRoot: canonical }));
    chmodSync(r.path, 0o600); writeFileSync(r.path, "changed");
    assert.match(verifyReviewerProvenance(r, {}).error, /snapshot hash mismatch/);
  });

  test("CANONICAL", "missing manifest, invalid manifest, and dirty canonical never resolve as current authority", () => {
    for (const [name, setup] of [["missing", (r) => writeFileSync(join(r, "README"), "x")], ["invalid", (r) => writeFileSync(join(r, "manifest.json"), "{}")]]) {
      const root = join(tmp, `canonical-${name}`); mkdirSync(root); setup(root); gitInit(root);
      assert.notEqual(sourceStatus(opts({ canonicalRoot: root })).sources[0].state, "available");
      assert.notEqual(resolveStandard("sql", opts({ cwd: tmp, canonicalRoot: root, staleRoot: join(tmp, "none") })).state, "canonical");
    }
    const dirty = join(tmp, "canonical-dirty"); execFileSync("git", ["clone", "-q", canonical, dirty]); writeFileSync(join(dirty, "dirty.txt"), "preserve");
    assert.equal(sourceStatus(opts({ canonicalRoot: dirty })).sources[0].state, "dirty_preserved");
    assert.notEqual(resolveStandard("sql", opts({ cwd: tmp, canonicalRoot: dirty, staleRoot: join(tmp, "none") })).state, "canonical");
    assert.equal(readFileSync(join(dirty, "dirty.txt"), "utf8"), "preserve");
  });

  test("SYNC", "post-update bad hash is rejected and a valid clean update succeeds", () => {
    const badRemote = join(tmp, "bad-update-remote"); execFileSync("git", ["clone", "-q", remote, badRemote]);
    git(badRemote, ["config", "user.email", "standards@test.invalid"]); git(badRemote, ["config", "user.name", "Standards Test"]);
    const badDest = join(tmp, "bad-update-dest"); assert.equal(syncCanonicalLocal(badRemote, badDest).ok, true);
    const manifest = JSON.parse(readFileSync(join(badRemote, "manifest.json"), "utf8")); manifest.domains.sql.sha256 = "0".repeat(64);
    writeFileSync(join(badRemote, "manifest.json"), JSON.stringify(manifest)); git(badRemote, ["add", "."]); git(badRemote, ["commit", "-q", "-m", "bad hash"]);
    const bad = syncCanonicalLocal(badRemote, badDest); assert.equal(bad.ok, false); assert.equal(bad.state, "invalid_preserved");

    const goodRemote = join(tmp, "good-update-remote"); execFileSync("git", ["clone", "-q", remote, goodRemote]);
    git(goodRemote, ["config", "user.email", "standards@test.invalid"]); git(goodRemote, ["config", "user.name", "Standards Test"]);
    const goodDest = join(tmp, "good-update-dest"); assert.equal(syncCanonicalLocal(goodRemote, goodDest).ok, true);
    writeAuthority(goodRemote, { sql: "# SQL v2" }, "fixture-r2"); git(goodRemote, ["add", "."]); git(goodRemote, ["commit", "-q", "-m", "valid update"]);
    const good = syncCanonicalLocal(goodRemote, goodDest); assert.equal(good.ok, true); assert.equal(good.state, "canonical");
    assert.equal(resolveStandard("sql", opts({ canonicalRoot: goodDest, staleRoot: join(tmp, "none") })).revision, "fixture-r2");
  });

  test("CLASSIFIER", "ordinary SQL, DAX, model, Fabric, and documentation work is automatic", () => {
    assert.deepEqual(identifyTaskDomains("Implement a SQL stored procedure"), ["sql"]);
    assert.deepEqual(identifyTaskDomains("Validate a DAX measure"), ["dax"]);
    assert.deepEqual(identifyTaskDomains("Assess semantic model relationships"), ["semantic_model", "dax"]);
    assert.deepEqual(identifyTaskDomains("Analyze a Fabric lakehouse architecture"), ["fabric"]);
    assert.deepEqual(identifyTaskDomains("Update README documentation"), ["documentation"]);
  });

  test("CLASSIFIER", "adjacent technical tasks do not become SQL", () => {
    assert.deepEqual(identifyTaskDomains("Review this Power Query transformation"), []);
    assert.deepEqual(identifyTaskDomains("Design a lakehouse architecture"), ["fabric"]);
    assert.deepEqual(identifyTaskDomains("Optimize a search query"), []);
    assert.deepEqual(identifyTaskDomains("What time is the meeting?"), []);
  });

  test("CONTEXT", "retrieval is bounded and full authority remains opt-in", () => {
    const bounded = buildStandardsContext("Explain this SQL stored procedure", opts({ canonicalRoot: canonical }));
    assert.ok(bounded.records[0].sections.length < 4);
    const broad = buildStandardsContext("Explain SQL using the full standard document", opts({ canonicalRoot: canonical }));
    assert.equal(broad.records[0].sections[0].heading, "FULL AUTHORITY");
  });

  console.log(`standards Revision 9: ${count} tests passed`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
