import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStandardsContext, refreshCanonical, resolveStandard, sourceStatus, standardsRegistry } from "../lib/standards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "coop-standards-live-"));
const remote = join(tmp, "remote"), cache = join(tmp, "cache", "canonical"), state = join(tmp, "cache", "status.json"), snapshots = join(tmp, "snapshots");
const registryPath = join(tmp, "registry.json");
let now = 1_000_000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const git = (args, cwd = remote) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const writeCanonical = (suffix) => {
  mkdirSync(join(remote, "standards"), { recursive: true });
  writeFileSync(join(remote, "standards", "sql.md"), `# SQL ${suffix}\n## Security\nSQL ${suffix}\n`);
  writeFileSync(join(remote, "standards", "dax.md"), `# DAX ${suffix}\n## Measures\nDAX ${suffix}\n`);
  writeFileSync(join(remote, "standards", "semantic-model.md"), `# Model ${suffix}\n## Relationships\nModel ${suffix}\n`);
  writeFileSync(join(remote, "standards.yml"), "schema_version: 1\nauthority: formal_standard\nauthoritative_ref: default_branch\ncontent_mode: markdown_only\nprecedence:\n  - project_override\n  - canonical_standard\n  - last_known_good\n  - bundled_fallback\nrefresh:\n  startup: true\n  task_freshness_minutes: 15\n  force_command: coop sync\n  failure_mode: last_known_good\n  pin_revision_per_task: true\n  invalidate_index_on_revision_change: true\nstandards:\n  sql:\n    path: standards/sql.md\n    section_refs: numeric\n  dax:\n    path: standards/dax.md\n    section_refs: numeric\n  semantic_model:\n    path: standards/semantic-model.md\n    section_refs: numeric\n");
};
const commit = (message) => { git(["add", "."]); git(["commit", "-q", "-m", message]); return git(["rev-parse", "HEAD"]); };
const options = (more = {}) => ({ canonicalRoot: cache, statePath: state, snapshotRoot: snapshots, registryPath, remote, now: () => now, refresh: true, staleRoot: join(tmp, "none"), reviewerBins: { sql: join(tmp, "none-sql"), dax: join(tmp, "none-dax") }, ...more });
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };

try {
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  git(["config", "user.email", "standards@test.invalid"]); git(["config", "user.name", "Standards Test"]);
  writeCanonical("r1"); const r1 = commit("r1");
  writeFileSync(registryPath, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: remote, authoritative_branch: "main", manifest: "standards.yml", initial_verified_commit: r1, initial_archive_sha256: "0".repeat(64), freshness_seconds: 900, timeout_seconds: 2, domains: { sql: "standards/sql.md", dax: "standards/dax.md", semantic_model: "standards/semantic-model.md" } } }));

  test("managed production registry binds private repo, main, verified initial provenance and 15-minute freshness", () => {
    const r = standardsRegistry();
    assert.equal(r.canonical.repository, "https://github.com/cooptimize/coop-standards.git"); assert.equal(r.canonical.authoritative_branch, "main");
    assert.equal(r.canonical.initial_verified_commit, "fa109f11129742358ff1e078cd4c4433e356afb4"); assert.equal(r.canonical.initial_archive_sha256, "07820c5dcd912551554bb801c5fb4bd699ebdf9c126af9f558444f1651305104"); assert.equal(r.canonical.freshness_seconds, 900);
  });
  test("initial verified refresh builds canonical cache and retrieval index with exact provenance", () => {
    const synced = refreshCanonical(options()); assert.equal(synced.ok, true, JSON.stringify(synced)); assert.equal(synced.revision, r1); assert.equal(synced.changed, true);
    const r = resolveStandard("sql", options({ refresh: false }));
    assert.equal(r.repository, remote); assert.equal(r.branch, "main"); assert.equal(r.commit, r1); assert.equal(r.file, "standards/sql.md"); assert.equal(r.sha256, hash(readFileSync(join(remote, "standards/sql.md"))));
    const index = JSON.parse(readFileSync(join(tmp, "cache", "retrieval-index.json"))); assert.equal(index.revision, r1); assert.equal(index.domains.sql.sha256, r.sha256);
  });
  test("fresh applicable tasks do not fetch repeatedly", () => {
    const a = refreshCanonical(options()), b = refreshCanonical(options()); assert.equal(a.skipped, true); assert.equal(b.skipped, true);
  });
  test("non-authoritative branch changes are not consumed", () => {
    git(["checkout", "-q", "-b", "feature"]); writeCanonical("feature"); commit("feature"); git(["checkout", "-q", "main"]);
    now += 901_000; const result = refreshCanonical(options()); assert.equal(result.revision, r1); assert.equal(readFileSync(join(cache, "standards", "sql.md"), "utf8").includes("feature"), false);
  });
  let pinned;
  test("merged main change is discovered after staleness while the current task stays pinned", () => {
    pinned = buildStandardsContext("Implement a SQL stored procedure", options()).records[0].resolution;
    writeCanonical("r2"); const r2 = commit("r2"); now += 901_000;
    const sync = refreshCanonical(options()); assert.equal(sync.revision, r2); assert.equal(readFileSync(pinned.path, "utf8").includes("r1"), true);
  });
  test("next task adopts newer SQL/DAX/model revision and SQL/DAX reviewer paths remain pinned", () => {
    const task = buildStandardsContext("Review semantic model relationships and DAX measures", options());
    assert.deepEqual(task.domains, ["semantic_model", "dax"]); assert.equal(task.records.every((x) => x.resolution.commit === git(["rev-parse", "main"])), true);
    assert.equal(task.records.every((x) => x.resolution.immutable), true);
  });
  test("offline refresh preserves LKG and reports truthful stale/degraded domain status", () => {
    renameSync(remote, `${remote}.offline`); now += 901_000; const failed = refreshCanonical(options()); assert.equal(failed.ok, false); assert.equal(failed.state, "stale_last_known_good");
    const status = sourceStatus(options({ refresh: false })); assert.equal(status.degraded, true); assert.equal(status.domains.sql.state, "stale_last_known_good"); assert.equal(status.domains.sql.fallback, true);
    renameSync(`${remote}.offline`, remote);
  });
  test("invalid canonical update cannot replace LKG", () => {
    writeCanonical("malicious"); rmSync(join(remote, "standards", "sql.md")); commit("invalid"); now += 901_000;
    const before = readFileSync(join(cache, "standards", "sql.md")); const failed = refreshCanonical(options()); assert.equal(failed.ok, false); assert.deepEqual(readFileSync(join(cache, "standards", "sql.md")), before);
  });
  test("forced refresh bypasses freshness and remains bounded/nonfatal on failure", () => {
    const result = refreshCanonical(options({ force: true, runner: () => ({ status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }) }));
    assert.equal(result.ok, false); assert.match(result.detail, /timed out/); assert.equal(existsSync(cache), true);
    assert.match(readFileSync(join(ROOT, "scripts", "sync.sh"), "utf8"), /standards-cli\.mjs" refresh --force/);
    assert.match(readFileSync(join(ROOT, "scripts", "sync.ps1"), "utf8"), /standards-cli\.mjs'[\s\S]*refresh --force/);
    assert.match(readFileSync(join(ROOT, "bin", "coop"), "utf8"), /standards-cli\.mjs" refresh[^-]/);
    assert.match(readFileSync(join(ROOT, "bin", "coop.ps1"), "utf8"), /standards-cli\.mjs'\) refresh/);
  });
  console.log(`standards live sync: ${count} tests passed`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
