import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORITY_CLASSES, CANONICAL_REMOTE_STATE, buildStandardsContext, identifyTaskDomains,
  projectStandardPaths, resolveStandard, reviewStandardsArgs, sourceStatus,
  syncCanonicalLocal, validateManifest,
} from "../lib/standards.mjs";

const tmp = mkdtempSync(join(tmpdir(), "coop-std-rev9-"));
let count = 0;
const test = (id, name, fn) => { fn(); count++; console.log(`  ✓ ${id} ${name}`); };
const hash = (text) => createHash("sha256").update(text).digest("hex");
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
const gitInit = (root) => {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "standards@test.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Standards Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
};

try {
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

  test("STD-01", "fresh canonical bootstrap uses a local fake remote", () => {
    const result = syncCanonicalLocal(remote, canonical);
    assert.equal(result.ok, true);
    assert.equal(result.state, "canonical");
    assert.equal(resolveStandard("sql", { cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none") }).revision, "fixture-r1");
  });

  test("STD-02", "SQL task context and reviewer share exact path/hash/revision", () => {
    const operation = buildStandardsContext("Write a stored procedure for customer sales", { cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none") });
    assert.deepEqual(operation.domains, ["sql"]);
    const record = operation.records[0];
    assert.match(record.sections.map((x) => x.heading).join(" "), /Stored procedures/);
    assert.deepEqual(reviewStandardsArgs(record.resolution), ["--standards", record.resolution.path]);
    const reread = resolveStandard("sql", { cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none") });
    assert.equal(record.resolution.sha256, reread.sha256);
    assert.equal(record.resolution.revision, reread.revision);
  });

  test("STD-03", "DAX repair context and reviewer share exact path/hash/revision", () => {
    const operation = buildStandardsContext("Repair this DAX measure expression", { cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none") });
    assert.deepEqual(operation.domains, ["dax"]);
    const r = operation.records[0].resolution;
    assert.deepEqual(reviewStandardsArgs(r), ["--standards", r.path]);
    assert.equal(r.sha256, hash(readFileSync(r.path)));
    assert.equal(r.revision, "fixture-r1");
  });

  test("STD-04", "semantic model, DAX, documentation and optional pattern stay separate", () => {
    const pattern = join(tmp, "incremental-bi"); mkdirSync(pattern);
    writeFileSync(join(pattern, "incremental-refresh.md"), "# Incremental BI\n## Refresh partitions\nUse bounded refresh windows.\n## Unrelated appendix\nDo not inject globally.\n");
    const operation = buildStandardsContext("Review semantic model relationships, DAX measures, documentation, and incremental refresh", { cwd: tmp, canonicalRoot: canonical, staleRoot: join(tmp, "none"), incrementalBiRoot: pattern });
    assert.deepEqual(operation.domains, ["semantic_model", "dax", "documentation"]);
    assert.deepEqual(operation.records.map((x) => x.resolution.authority_class), ["formal_standard", "formal_standard", "formal_standard"]);
    assert.equal(operation.patterns[0].authority_class, "approved_pattern");
    assert.equal(operation.patterns[0].selective, true);
    assert.match(operation.patterns[0].sections.map((x) => x.heading).join(" "), /Refresh partitions/);
    assert.doesNotMatch(operation.patterns[0].sections.map((x) => x.heading).join(" "), /Unrelated appendix/);
  });

  test("STD-05", "project/client override wins canonical", () => {
    const project = join(tmp, "project"); mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "client"));
    writeFileSync(join(project, "client", "sql.md"), "# Client SQL\nClient rule.");
    writeFileSync(join(project, ".coop", "project.yml"), "custom_key: keep-me\nstandards:\n  sql: client/sql.md # v0.23.1 shape\n");
    const r = resolveStandard("sql", { cwd: project, canonicalRoot: canonical, staleRoot: join(tmp, "none") });
    assert.equal(r.state, "project_override"); assert.equal(r.authority_class, "project_local"); assert.match(r.path, /client\/sql\.md$/);
  });

  test("STD-06", "unavailable canonical uses verified stale, bundled, unavailable, auth", () => {
    const stale = join(tmp, "lkg"); writeAuthority(stale, { sql: "# Stale SQL" }, "lkg-r1");
    assert.equal(resolveStandard("sql", { cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: stale }).state, "stale_last_known_good");
    assert.equal(resolveStandard("dax", { cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2") }).state, "bundled_fallback");
    assert.equal(resolveStandard("semantic_model", { cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2") }).state, "unavailable");
    assert.equal(resolveStandard("semantic_model", { cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2"), authRequired: true }).state, "auth_required");
  });

  test("STD-07", "bundled SQL/DAX remain functional without external flags", () => {
    for (const domain of ["sql", "dax"]) {
      const r = resolveStandard(domain, { cwd: tmp, canonicalRoot: join(tmp, "missing"), staleRoot: join(tmp, "missing2") });
      assert.equal(r.state, "bundled_fallback"); assert.deepEqual(reviewStandardsArgs(r), []);
    }
  });

  test("STD-08", "v0.23.1 project-local standards paths parse without rewriting", () => {
    const yml = "# retained\nstandards:\n  sql: 'docs/standards/sql-standards.md' # old shape\n  dax: \"docs/standards/dax-standards.md\"\nunknown: retained\n";
    assert.deepEqual(projectStandardPaths(yml), { sql: "docs/standards/sql-standards.md", dax: "docs/standards/dax-standards.md" });
    assert.match(yml, /unknown: retained/);
  });

  test("STD-09", "authority classes are closed and never flattened", () => {
    assert.deepEqual([...AUTHORITY_CLASSES], ["formal_standard", "approved_pattern", "team_knowledge", "project_local"]);
    const statuses = sourceStatus({ cwd: tmp, canonicalRoot: canonical, incrementalBiRoot: join(tmp, "incremental-bi"), teamKnowledgeRoot: join(tmp, "teamai") });
    assert.equal(statuses.sources[0].authority_class, "formal_standard");
    assert.equal(statuses.sources[1].authority_class, "approved_pattern");
    assert.equal(statuses.sources[2].authority_class, "team_knowledge");
  });

  test("STD-10", "status independently reports canonical, Incremental BI and TeamAI", () => {
    const ib = join(tmp, "ib-status"), tk = join(tmp, "tk-status"); mkdirSync(ib); mkdirSync(tk); writeFileSync(join(ib, "x"), "x"); writeFileSync(join(tk, "x"), "x"); gitInit(ib); gitInit(tk);
    const status = sourceStatus({ cwd: tmp, canonicalRoot: canonical, incrementalBiRoot: ib, teamKnowledgeRoot: tk });
    assert.equal(status.canonical_remote, CANONICAL_REMOTE_STATE);
    assert.deepEqual(status.sources.map((x) => x.id), ["cooptimize-formal-standards", "cooptimize/incremental-bi", "cooptimize/coop-team-knowledge"]);
    assert.ok(status.sources.every((x) => x.revision));
  });

  test("NEGATIVE", "invalid manifest, traversal, symlink escape and hash mismatch fail soft", () => {
    assert.ok(validateManifest({ schema_version: 9 }).length);
    const outside = join(tmp, "outside.md"); writeFileSync(outside, "outside");
    for (const [name, entry] of [
      ["traversal", { path: "../outside.md", sha256: hash("outside") }],
      ["hash", { path: "sql.md", sha256: "0".repeat(64) }],
    ]) {
      const root = join(tmp, name); mkdirSync(root); if (name === "hash") writeFileSync(join(root, "sql.md"), "actual");
      writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema_version: 1, revision: "bad", domains: { sql: entry } }));
      assert.equal(resolveStandard("sql", { cwd: tmp, canonicalRoot: root, staleRoot: join(tmp, "none") }).state, "bundled_fallback");
    }
    const root = join(tmp, "symlink"); mkdirSync(root); symlinkSync(outside, join(root, "sql.md"));
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema_version: 1, revision: "bad", domains: { sql: { path: "sql.md", sha256: hash("outside") } } }));
    assert.equal(resolveStandard("sql", { cwd: tmp, canonicalRoot: root, staleRoot: join(tmp, "none") }).state, "bundled_fallback");
  });

  test("NEGATIVE", "dirty canonical checkout is preserved", () => {
    writeFileSync(join(canonical, "dirty.txt"), "do not delete");
    const before = readFileSync(join(canonical, "dirty.txt"), "utf8");
    const result = syncCanonicalLocal(remote, canonical);
    assert.equal(result.state, "dirty_preserved"); assert.equal(readFileSync(join(canonical, "dirty.txt"), "utf8"), before);
  });

  test("CONTEXT", "unrelated prompts get no dump and broad retrieval is opt-in", () => {
    assert.deepEqual(identifyTaskDomains("What time is the meeting?"), []);
    assert.equal(buildStandardsContext("What time is the meeting?", { canonicalRoot: canonical }).records.length, 0);
    const bounded = buildStandardsContext("Explain this SQL stored procedure", { canonicalRoot: canonical });
    assert.ok(bounded.records[0].sections.length < 4);
    const broad = buildStandardsContext("Explain SQL using the full standard document", { canonicalRoot: canonical });
    assert.equal(broad.records[0].sections[0].heading, "FULL AUTHORITY");
  });

  console.log(`standards Revision 9: ${count} tests passed`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
