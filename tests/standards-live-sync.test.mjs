import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeCanonicalGeneration, buildStandardsContext, fsyncDirectory, fsyncFile, pinStandardsTask, promoteReviewRun, provenanceText, refreshCanonical, resolveAcceptedReviewRun, resolveStandard, retrieveRelevantSections, sourceStatus, standardsRegistry } from "../lib/standards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "coop-standards-live-"));
const remote = join(tmp, "remote"), cache = join(tmp, "cache", "canonical"), state = join(tmp, "cache", "status.json"), snapshots = join(tmp, "snapshots");
const registryPath = join(tmp, "registry.json");
let now = 1_000_000, count = 0;
let r3;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const git = (args, cwd = remote) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
// coop-standards is an Obsidian wiki: articles with front matter. The fixture also
// carries the repo's v1 shim for older clients (standards.yml + standards/*.md),
// a retired article, a draft, and a note without front matter; coop reads none of them.
const article = (fields, body) => `---\n${Object.entries({ layer: "agnostic", technology: "agnostic", status: "active", ...fields }).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
const put = (rel, text) => { mkdirSync(dirname(join(remote, rel)), { recursive: true }); writeFileSync(join(remote, rel), text); };
const writeCanonical = (suffix) => {
  put("SQL/SQL Conventions.md", article({ id: "sql_conventions", title: "SQL Conventions", domain: "sql", artifact: "conventions" }, `# SQL Conventions ${suffix}\n## Security\nSQL ${suffix}\n`));
  put("SQL/Gold/Stored Procedures.md", article({ id: "sql_gold_stored_procedures", title: "Gold Stored Procedures", domain: "sql", layer: "gold", artifact: "stored_procedure" }, `# Gold Stored Procedures ${suffix}\n## Procedure standards\nProcedures ${suffix}\n`));
  put("Power BI/Semantic Model/DAX.md", article({ id: "powerbi_dax", title: "Power BI DAX", domain: "powerbi", layer: "semantic_model", artifact: "dax_expression", technology: "power_bi" }, `# DAX ${suffix}\n## Security\nDAX ${suffix}\n`));
  put("Power BI/Semantic Model/Relationships.md", article({ id: "powerbi_relationships", title: "Power BI Relationships", domain: "powerbi", layer: "semantic_model", artifact: "relationship", technology: "power_bi" }, `# Relationships ${suffix}\n## Security\nModel ${suffix}\n`));
  put("standards.yml", "schema_version: 1\nauthority: formal_standard\nstandards:\n  sql:\n    path: standards/sql.md\n");
  put("standards/sql.md", `# SHIM ASSEMBLED ${suffix}\n`);
  put("deprecation/tech/old.md", article({ id: "retired", title: "RETIRED Rules", domain: "sql" }, "# RETIRED\n"));
  put("SQL/Draft.md", article({ id: "draft", title: "DRAFT Rules", domain: "sql", status: "draft" }, "# DRAFT\n"));
  put("SQL/Notes.md", "# NOFRONT notes\n");
  put(".obsidian/app.json", "{}\n");
};
const commit = (message) => { git(["add", "."]); git(["commit", "-q", "-m", message]); return git(["rev-parse", "HEAD"]); };
const options = (more = {}) => ({ canonicalRoot: cache, statePath: state, snapshotRoot: snapshots, registryPath, fixtureRegistry: true, remote, now: () => now, reviewerBins: { sql: join(tmp, "none-sql"), dax: join(tmp, "none-dax") }, ...more });
// A forced refresh that fails must say why (issue #100: a bare `false !== true`
// hid the cause of a Windows-only failure).
const assertRefreshed = (opts) => { const r = refreshCanonical(opts); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };
const resetStorage = () => { rmSync(join(tmp, "cache"), { recursive: true, force: true }); rmSync(snapshots, { recursive: true, force: true }); };

try {
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  git(["config", "user.email", "standards@test.invalid"]); git(["config", "user.name", "Standards Test"]);
  writeCanonical("r1"); const r1 = commit("r1");
  writeFileSync(registryPath, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: remote, authoritative_branch: "main", freshness_seconds: 900, timeout_seconds: 30 } }));

  test("directory durability suppresses only explicit Windows unsupported errors", () => {
    const error = (code) => { const value = new Error(code); value.code = code; return value; };
    assert.throws(() => fsyncDirectory(tmp, { platform: "linux", fsync: () => { throw error("EIO"); } }), /EIO/);
    assert.throws(() => fsyncDirectory(tmp, { platform: "win32", fsync: () => { throw error("ENOSPC"); } }), /ENOSPC/);
    assert.throws(() => fsyncDirectory(tmp, { platform: "linux", fsync: () => { throw error("EPERM"); } }), /EPERM/);
    assert.throws(() => fsyncDirectory(tmp, { platform: "win32", open: () => { throw error("EPERM"); } }), /EPERM/);
    assert.throws(() => fsyncDirectory(tmp, { platform: "win32", open: () => 123, fsync: () => {}, close: () => { throw error("EPERM"); } }), /EPERM/);
    for (const code of ["EINVAL", "EPERM"]) {
      assert.doesNotThrow(() => fsyncDirectory(tmp, { platform: "win32", fsync: () => { throw error(code); } }));
    }
  });
  test("file durability uses a write-capable Windows handle without suppressing errors", () => {
    const calls = [];
    fsyncFile("ignored", { platform: "win32", open: (_path, mode) => { calls.push(mode); return 123; }, fsync: () => calls.push("fsync"), close: () => calls.push("close") });
    assert.deepEqual(calls, ["r+", "fsync", "close"]);
    assert.throws(() => fsyncFile("ignored", { platform: "win32", open: () => 123, fsync: () => { const error = new Error("EPERM"); error.code = "EPERM"; throw error; }, close: () => {} }), /EPERM/);
  });
  test("production registry pins private main but not the repo's layout or history", () => {
    const r = standardsRegistry();
    assert.equal(r.canonical.repository, "https://github.com/cooptimize/coop-standards.git"); assert.equal(r.canonical.authoritative_branch, "main");
    assert.equal(Object.hasOwn(r.canonical, "domains"), false); assert.equal(Object.hasOwn(r.canonical, "initial_verified_commit"), false);
    assert.equal(Object.hasOwn(r.canonical, "manifest"), false);
  });
  test("production registry ignores inherited redirection and source/status/refresh retain committed authority", () => {
    const old = process.env.COOP_STANDARDS_REGISTRY;
    process.env.COOP_STANDARDS_REGISTRY = registryPath;
    try {
      const r = standardsRegistry();
      assert.equal(r.canonical.repository, "https://github.com/cooptimize/coop-standards.git");
      assert.equal(Object.isFrozen(r) && Object.isFrozen(r.canonical), true);
      assert.throws(() => { r.canonical.repository = remote; }, TypeError);
      assert.throws(() => standardsRegistry({ registryPath }), /explicit fixture/);
      assert.throws(() => standardsRegistry({ remote }), /explicit fixture/);
      const registryUrl = new URL("../config/standards-registry.json", import.meta.url).href;
      const standardsUrl = new URL("../lib/standards.mjs", import.meta.url).href;
      const mutationProbe = `const m=await import(${JSON.stringify(standardsUrl)}+"?mutated-authority");const r=(await import(${JSON.stringify(registryUrl)},{with:{type:"json"}})).default;r.canonical.repository="https://attacker.invalid/standards.git";if(m.standardsRegistry().canonical.repository!=="https://github.com/cooptimize/coop-standards.git")process.exit(9)`;
      const mutationResult = spawnSync(process.execPath, ["--input-type=module", "-e", mutationProbe], { encoding: "utf8" });
      assert.equal(mutationResult.status, 0, mutationResult.stderr || mutationResult.stdout);
      const productionRoot = join(tmp, "production-cache", "canonical");
      const productionState = join(tmp, "production-cache", "status.json");
      const status = sourceStatus({ canonicalRoot: productionRoot, statePath: productionState, snapshotRoot: join(tmp, "production-snapshots"), refresh: false });
      assert.equal(status.sources[0].repository, r.canonical.repository);
      let clone = null;
      const refreshed = refreshCanonical({ canonicalRoot: productionRoot, statePath: productionState, snapshotRoot: join(tmp, "production-snapshots"), force: true, runner: (args) => { if (args[0] === "clone") clone = args; return { status: 1, stdout: "", stderr: "offline fixture" }; } });
      assert.equal(refreshed.ok, false);
      assert.equal(clone.includes(r.canonical.repository), true);
      let toctouClone = null;
      const mutableOptions = {
        canonicalRoot: join(tmp, "production-toctou-cache", "canonical"),
        statePath: join(tmp, "production-toctou-cache", "status.json"),
        snapshotRoot: join(tmp, "production-toctou-snapshots"),
        force: true,
        now: () => { mutableOptions.remote = remote; return now; },
        runner: (args) => { if (args[0] === "clone") toctouClone = args; return { status: 1, stdout: "", stderr: "offline fixture" }; },
      };
      const toctou = refreshCanonical(mutableOptions);
      assert.equal(toctou.ok, false);
      assert.equal(toctouClone.includes(r.canonical.repository), true);
      assert.equal(toctouClone.includes(remote), false);
    } finally {
      if (old === undefined) delete process.env.COOP_STANDARDS_REGISTRY; else process.env.COOP_STANDARDS_REGISTRY = old;
    }
  });
  test("complete generation activates cache, index, metadata and pointer together", () => {
    const synced = refreshCanonical(options()); assert.equal(synced.ok, true, JSON.stringify(synced));
    const active = activeCanonicalGeneration(options()); assert.equal(active.ok, true, JSON.stringify(active)); assert.equal(active.revision, r1);
    const index = JSON.parse(readFileSync(active.index)); const r = resolveStandard("sql", options({ refresh: false }));
    assert.equal(index.revision, r1); assert.equal(index.domains.sql.sha256, r.sha256); assert.equal(r.repository, remote); assert.equal(r.branch, "main");
  });
  test("healthy fresh generation skips repeated fetch", () => { assert.equal(refreshCanonical(options()).skipped, true); assert.equal(refreshCanonical(options()).skipped, true); });

  writeCanonical("r2"); const r2 = commit("r2");
  const beforePointer = ["canonical:clone", "canonical:verified", "canonical:index", "canonical:metadata", "canonical:generation", "canonical:before-pointer"];
  for (const step of [...beforePointer, "canonical:after-pointer", "canonical:before-state", "canonical:after-state"]) test(`fault ${step} never exposes an incomplete generation or destroys LKG`, () => {
    git(["reset", "--hard", r1]); resetStorage(); now += 1; assertRefreshed(options({ force: true }));
    const old = activeCanonicalGeneration(options()); git(["reset", "--hard", r2]);
    const failed = refreshCanonical(options({ force: true, fault: step })); assert.equal(failed.ok, false);
    const active = activeCanonicalGeneration(options()); assert.equal(active.ok, true, JSON.stringify(active));
    assert.equal(active.revision, beforePointer.includes(step) ? old.revision : r2);
    assert.equal(JSON.parse(readFileSync(active.index)).revision, active.revision);
  });

  for (const [artifact, relativePath] of [
    ["index", "retrieval-index.json"],
    ["metadata", "generation.json"],
    ["authority", join("checkout", "SQL", "SQL Conventions.md")],
  ]) test(`final-location ${artifact} corruption cannot activate a canonical generation`, () => {
    git(["reset", "--hard", r1]); resetStorage(); now += 1; assertRefreshed(options({ force: true }));
    const old = activeCanonicalGeneration(options()); git(["reset", "--hard", r2]);
    const failed = refreshCanonical(options({ force: true, fault(step) {
      if (step !== "canonical:generation") return;
      const generations = join(tmp, "cache", "canonical-generations");
      const candidate = readdirSync(generations).find((name) => !name.startsWith(".") && name !== old.generation_id);
      writeFileSync(join(generations, candidate, relativePath), "{}\n");
    } }));
    assert.equal(failed.ok, false, artifact);
    const active = activeCanonicalGeneration(options()); assert.equal(active.ok, true, JSON.stringify(active));
    assert.equal(active.generation_id, old.generation_id); assert.equal(active.revision, old.revision);
    assert.equal(resolveStandard("sql", options({ refresh: false })).revision, old.revision);
  });

  test("process death at every build/pointer/state step preserves one complete generation", () => {
    for (const step of [...beforePointer, "canonical:after-pointer", "canonical:before-state", "canonical:after-state"]) {
      git(["reset", "--hard", r1]); resetStorage(); now += 1; assertRefreshed(options({ force: true }));
      git(["reset", "--hard", r2]);
      const childOptions = { canonicalRoot: cache, statePath: state, snapshotRoot: snapshots, registryPath, fixtureRegistry: true, remote, force: true };
      const script = `import {refreshCanonical} from ${JSON.stringify(new URL("../lib/standards.mjs", import.meta.url).href)}; refreshCanonical({...${JSON.stringify(childOptions)},fault:(s)=>{if(s===${JSON.stringify(step)})process.exit(77)}});`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script]); assert.equal(child.status, 77, step);
      const abandonedLock = join(tmp, "cache", ".canonical-storage.lock");
      const degraded = activeCanonicalGeneration(options({ lockTimeoutMs: 25 })); assert.equal(degraded.ok, true, step); assert.equal(degraded.degraded, true, step);
      assert.equal(existsSync(abandonedLock), true, `${step}: crash-abandoned lock was removed`);
      rmSync(abandonedLock, { recursive: true }); // explicit fixture/manual cleanup
      const active = activeCanonicalGeneration(options()); assert.equal(active.ok, true, step);
      assert.equal(active.revision, ["canonical:after-pointer", "canonical:before-state", "canonical:after-state"].includes(step) ? r2 : r1, step);
      assert.equal(JSON.parse(readFileSync(active.index)).revision, active.revision, step);
    }
  });

  test("restart reconciles lagging state from the verified pointer", () => {
    const active = activeCanonicalGeneration(options());
    writeFileSync(state, JSON.stringify({ ok: true, revision: r1, generation_id: "old", last_successful_check_ms: 1, last_successful_sync_ms: 1 }));
    const result = refreshCanonical(options()); assert.equal(result.skipped, true);
    const reconciled = JSON.parse(readFileSync(state)); assert.equal(reconciled.generation_id, active.generation_id); assert.equal(reconciled.reconciled, true);
  });
  test("same-revision missing or mismatched index is rebuilt instead of skipped", () => {
    const broken = activeCanonicalGeneration(options()); writeFileSync(broken.index, "{}\n");
    const repaired = refreshCanonical(options()); assert.equal(repaired.ok, true, JSON.stringify(repaired)); assert.equal(repaired.revision, r2); assert.equal(activeCanonicalGeneration(options()).ok, true);
  });
  test("recent failed refresh cannot trigger the freshness shortcut", () => {
    const failed = refreshCanonical(options({ force: true, runner: () => ({ status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }) })); assert.equal(failed.ok, false);
    const repaired = refreshCanonical(options()); assert.equal(repaired.ok, true); assert.notEqual(repaired.skipped, true);
  });
  test("newer degraded state is never healed from an older verified pointer", () => {
    const active = activeCanonicalGeneration(options());
    writeFileSync(state, JSON.stringify({ ok: false, degraded: true, revision: "old", generation_id: "old", last_successful_check_ms: 1, last_attempt_ms: active.remote_verified_ms + 1 }));
    let fetches = 0;
    const failed = refreshCanonical(options({ runner: (args, run) => {
      if (args[0] === "clone") { fetches++; return { status: 1, stdout: "", stderr: "" }; }
      return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: run.cwd || undefined, encoding: "utf8", timeout: run.timeout });
    } }));
    assert.equal(failed.ok, false); assert.equal(failed.skipped, undefined); assert.equal(fetches, 1);
    assert.equal(refreshCanonical(options()).ok, true);
  });
  test("one task pin constrains every domain and late reviewer resolution", () => {
    const pinned = pinStandardsTask(["sql", "dax"], options({ refresh: false })); assert.equal(pinned.resolutions.every((r) => r.revision === r2), true);
    writeCanonical("r3"); r3 = commit("r3"); now += 901_000; assert.equal(refreshCanonical(options()).revision, r3);
    assert.equal(pinned.resolve("semantic_model").revision, r2); assert.equal(pinned.resolutions.every((r) => readFileSync(r.path, "utf8").includes("r2")), true);
    const forged = { verified: true, revision: r3, resolutions: { sql: pinned.resolve("sql") } };
    assert.equal(resolveStandard("sql", options({ taskPin: forged, refresh: false })).state, "unavailable");
  });
  test("initially unclassified task refreshes once lazily and memoizes every domain", () => {
    now += 901_000; let fetches = 0;
    const runner = (args, run) => { if (args[0] === "clone") fetches++; return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: run.cwd || undefined, encoding: "utf8", timeout: run.timeout }); };
    const lazy = pinStandardsTask([], options({ refresh: true, runner }));
    assert.equal(lazy.taskPin, null); assert.equal(fetches, 0);
    const sql = lazy.resolve("sql"); assert.equal(fetches, 1); assert.equal(lazy.taskPin.revision, r3);
    writeCanonical("r4"); commit("r4");
    const dax = lazy.resolve("dax"); assert.equal(fetches, 1); assert.equal(dax.revision, r3); assert.match(readFileSync(sql.path, "utf8"), /r3/); assert.match(readFileSync(dax.path, "utf8"), /r3/);
  });
  test("canonical generations are never pruned by the Monday refresh path", () => {
    writeCanonical("retained-old"); commit("retained-old"); now += 1;
    assertRefreshed(options({ force: true }));
    const old = activeCanonicalGeneration(options()); assert.equal(old.ok, true);
    for (const tag of ["retained-new-1", "retained-new-2", "retained-new-3"]) {
      writeCanonical(tag); commit(tag); now += 1;
      assert.equal(refreshCanonical(options({ force: true, retainGenerations: 1, canonicalRetentionMinAgeMs: 0 })).ok, true);
    }
    assert.equal(existsSync(old.checkout), true); assert.equal(existsSync(old.index), true);
    assert.equal(existsSync(join(old.generation, ".consumption-lease.json")), false);
    assert.equal(readdirSync(join(tmp, "cache", "canonical-generations")).filter((name) => !name.startsWith(".")).length >= 4, true);
  });
  test("uncertain or abandoned canonical lock returns degraded LKG without touching the lock", () => {
    const old = activeCanonicalGeneration(options()); assert.equal(old.ok, true);
    const lock = join(tmp, "cache", ".canonical-storage.lock"), owner = "{}\n";
    mkdirSync(lock); writeFileSync(join(lock, "owner.json"), owner);
    const failed = refreshCanonical(options({ force: true, lockTimeoutMs: 25 }));
    assert.equal(failed.ok, false); assert.equal(failed.state, "stale_last_known_good"); assert.equal(failed.degraded, true); assert.equal(failed.uncertain, true);
    assert.equal(failed.revision, old.revision); assert.equal(failed.generation_id, old.generation_id);
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), owner);
    const status = sourceStatus(options({ lockTimeoutMs: 25 }));
    assert.equal(status.degraded, true); assert.equal(status.freshness, "uncertain");
    assert.equal(status.sources[0].revision, old.revision); assert.equal(status.sources[0].state, "stale_last_known_good");
    assert.equal(status.domains.sql.revision, old.revision); assert.equal(status.domains.sql.sha256, old.domains.sql.sha256); assert.equal(status.domains.sql.state, "stale_last_known_good");
    const pin = pinStandardsTask(["sql"], options({ refresh: false, lockTimeoutMs: 25 }));
    assert.equal(pin.resolutions[0].revision, old.revision); assert.equal(pin.resolutions[0].sha256, old.domains.sql.sha256);
    assert.equal(pin.resolutions[0].state, "stale_last_known_good"); assert.equal(pin.resolutions[0].degraded, true);
    rmSync(lock, { recursive: true });
  });
  test("accepted canonical provenance maps to its retained immutable generation", () => {
    const outdir = join(tmp, "canonical-reviews"); mkdirSync(outdir);
    const entries = [];
    for (const domain of ["sql", "dax"]) {
      const resolution = resolveStandard(domain, options({ cwd: tmp, refresh: false }));
      const report = { tool: `coop-${domain}-review`, schema_version: domain === "sql" ? 4 : 3, version: "canonical-test", [domain === "sql" ? "files_checked" : "models_checked"]: 0,
        standards: { path: resolution.path, sha256: resolution.sha256 }, findings: [], diagnostics: [], agent_review: [], summary: { error: 0, warning: 0, info: 0 }, verdict: { clean: true, highest_severity: null } };
      const resolutionPath = join(tmp, `canonical-${domain}-resolution.json`), reportPath = join(tmp, `canonical-${domain}-report.json`);
      writeFileSync(resolutionPath, JSON.stringify(resolution)); writeFileSync(reportPath, JSON.stringify(report)); entries.push({ domain, resolutionPath, reportPath });
    }
    assert.equal(promoteReviewRun(outdir, entries, options()).ok, true);
    writeCanonical("after-canonical-review"); commit("after-canonical-review"); now += 1;
    assertRefreshed(options({ force: true }));
    const accepted = resolveAcceptedReviewRun(outdir, options()); assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(JSON.parse(readFileSync(accepted.reports.sql)).version, "canonical-test");
    const acceptedMetadata = JSON.parse(readFileSync(join(accepted.generation, "generation.json")));
    const authority = JSON.parse(readFileSync(join(accepted.generation, acceptedMetadata.files.sql_authority.file)));
    writeFileSync(join(dirname(authority.source_root), "generation.json"), "{}\n");
    assert.equal(resolveAcceptedReviewRun(outdir, options()).ok, false);
  });
  test("remote-main binding rejects a clean local descendant and missing authoritative ref", () => {
    const active = activeCanonicalGeneration(options()); assert.equal(active.ok, true);
    git(["config", "user.email", "standards@test.invalid"], active.checkout); git(["config", "user.name", "Standards Test"], active.checkout);
    writeFileSync(join(active.checkout, "SQL", "SQL Conventions.md"), "# locally invented\n"); git(["add", "."], active.checkout); git(["commit", "-q", "-m", "invented"], active.checkout);
    assert.equal(activeCanonicalGeneration(options()).ok, false);
    git(["reset", "--hard", active.revision], active.checkout);
    git(["update-ref", "-d", "refs/remotes/origin/main"], active.checkout); assert.equal(activeCanonicalGeneration(options()).ok, false);
    git(["update-ref", "refs/remotes/origin/main", active.revision], active.checkout); assert.equal(activeCanonicalGeneration(options()).ok, true);
  });
  test("invalid pointer, symlink pointer/root, unrelated repo and feature branch fail authority", () => {
    const pointer = join(tmp, "cache", "active-generation.json"), saved = readFileSync(pointer);
    writeFileSync(pointer, "{}\n"); assert.equal(activeCanonicalGeneration(options()).ok, false); writeFileSync(pointer, saved);
    const realPointer = `${pointer}.real`; writeFileSync(realPointer, saved); rmSync(pointer); symlinkSync(realPointer, pointer); assert.equal(activeCanonicalGeneration(options()).ok, false); rmSync(pointer); writeFileSync(pointer, saved);
    const active = activeCanonicalGeneration(options()); git(["checkout", "-q", "-b", "feature-local"], active.checkout); assert.equal(activeCanonicalGeneration(options()).ok, false); git(["checkout", "-q", "main"], active.checkout);
    const unrelated = join(tmp, "unrelated"); execFileSync("git", ["init", "-q", "-b", "main", unrelated]); git(["config", "user.email", "x@y"], unrelated); git(["config", "user.name", "x"], unrelated); writeFileSync(join(unrelated, "x"), "x"); git(["add", "."], unrelated); git(["commit", "-q", "-m", "x"], unrelated);
    const metaPath = join(active.generation, "generation.json"), meta = JSON.parse(readFileSync(metaPath)); meta.repository = unrelated; writeFileSync(metaPath, JSON.stringify(meta)); assert.equal(activeCanonicalGeneration(options()).ok, false);
  });
  test("coop reads only active wiki articles: not the v1 shim, retired, draft, or unfielded notes", () => {
    resetStorage(); now += 1; git(["reset", "--hard", "HEAD"]);
    assertRefreshed(options({ force: true }));
    const sql = resolveStandard("sql", options({ refresh: false }));
    assert.deepEqual(sql.articles.map((a) => a.file), ["SQL/Gold/Stored Procedures.md", "SQL/SQL Conventions.md"]);
    assert.equal(sql.file, "wiki:sql");
    const input = readFileSync(sql.path, "utf8");
    for (const decoy of ["SHIM", "RETIRED", "DRAFT", "NOFRONT"]) assert.equal(input.includes(decoy), false, decoy);
    assert.match(input, /coop reviewer-input cache for sql/); assert.equal(/^---/m.test(input), false);
  });
  test("powerbi articles split into coop's dax and semantic_model domains by artifact", () => {
    assert.deepEqual(resolveStandard("dax", options({ refresh: false })).articles.map((a) => a.file), ["Power BI/Semantic Model/DAX.md"]);
    assert.deepEqual(resolveStandard("semantic_model", options({ refresh: false })).articles.map((a) => a.file), ["Power BI/Semantic Model/Relationships.md"]);
  });
  test("a task gets whole wiki articles with per-article provenance", () => {
    const context = buildStandardsContext("create a gold stored procedure for customers", options({ refresh: false }));
    const [record] = context.records;
    assert.equal(record.resolution.domain, "sql");
    assert.deepEqual(record.sections.map((s) => s.file), ["SQL/SQL Conventions.md", "SQL/Gold/Stored Procedures.md"]);
    const stored = record.resolution.articles.find((a) => a.file === "SQL/Gold/Stored Procedures.md");
    const text = provenanceText(record);
    assert.match(text, new RegExp(`coop-standards wiki article: SQL/Gold/Stored Procedures.md sha256=${stored.sha256} revision=${record.resolution.revision}`));
    assert.equal(text.includes("stored_procedure"), false); // front matter is not injected
  });
  test("a generation cached before the wiki reader (schema-1 index) is re-fetched cleanly", () => {
    const active = activeCanonicalGeneration(options()); assert.equal(active.ok, true);
    const indexPath = active.index, metadataPath = join(active.generation, "generation.json");
    const legacy = { schema_version: 1, revision: active.revision, domains: { sql: { file: "standards/sql.md", sha256: hash("x"), headings: ["SQL"] } } };
    writeFileSync(indexPath, JSON.stringify(legacy, null, 2) + "\n");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")); metadata.domains = legacy.domains; metadata.index_sha256 = hash(readFileSync(indexPath));
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
    const pointerPath = join(tmp, "cache", "active-generation.json"), pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    pointer.metadata_sha256 = hash(readFileSync(metadataPath)); writeFileSync(pointerPath, JSON.stringify(pointer));
    assert.equal(activeCanonicalGeneration(options()).ok, false);
    now += 1; const repaired = refreshCanonical(options());
    assert.equal(repaired.ok, true, JSON.stringify(repaired)); assert.equal(resolveStandard("sql", options({ refresh: false })).state, "canonical");
  });
  test("a domain the wiki adds resolves and shows in status without a coop-agent change", () => {
    resetStorage(); now += 1;
    put("Fabric/Workspaces.md", article({ id: "fabric_workspaces", title: "Fabric Workspaces", domain: "fabric_platform", artifact: "workspace", technology: "fabric" }, "# Fabric Workspaces\n## Workspace naming\nName workspaces by layer.\n"));
    const added = commit("add fabric_platform domain");
    assertRefreshed(options({ force: true }));
    const r = resolveStandard("fabric_platform", options({ refresh: false }));
    assert.equal(r.state, "canonical"); assert.equal(r.revision, added); assert.equal(r.file, "wiki:fabric_platform");
    assert.deepEqual(r.articles.map((a) => a.file), ["Fabric/Workspaces.md"]);
    assert.equal(sourceStatus(options()).domains.fabric_platform.sha256, r.sha256);
    assert.equal(pinStandardsTask(["fabric_platform"], options({ refresh: false })).resolutions[0].sha256, r.sha256);
  });
  test("unsafe or invalid articles are skipped and never followed", () => {
    const good = git(["rev-parse", "HEAD"]);
    writeFileSync(join(tmp, "outside.md"), article({ id: "outside", title: "Outside", domain: "sql" }, "# OUTSIDE\n"));
    symlinkSync(join(tmp, "outside.md"), join(remote, "SQL", "Linked.md"));
    put("SQL/Bad Domain.md", article({ id: "bad", title: "BADNAME", domain: "Bad-Name" }, "# BADNAME\n"));
    put("SQL/Missing Field.md", "---\nid: partial\ntitle: PARTIAL\ndomain: sql\nstatus: active\n---\n# PARTIAL\n");
    commit("unsafe articles"); now += 1;
    assertRefreshed(options({ force: true }));
    const sql = resolveStandard("sql", options({ refresh: false }));
    assert.deepEqual(sql.articles.map((a) => a.file), ["SQL/Gold/Stored Procedures.md", "SQL/SQL Conventions.md"]);
    for (const decoy of ["OUTSIDE", "BADNAME", "PARTIAL"]) assert.equal(readFileSync(sql.path, "utf8").includes(decoy), false, decoy);
    git(["reset", "--hard", good]);
  });
  test("a model task no article matches gets semantic-model-layer articles, never path order", () => {
    // Mirrors the real wiki's Power BI folder: File Types (layer agnostic) and the
    // Reports articles sort before the semantic-model layer by path.
    const good = git(["rev-parse", "HEAD"]);
    for (const [file, layer, artifact, title] of [
      ["File Types", "agnostic", "file_type", "Power BI File Types"], ["Reports/App Deployment", "report", "app_deployment", "Power BI App Deployment"],
      ["Reports/Page Formatting", "report", "page_formatting", "Power BI Report Page Formatting"], ["Reports/Visuals", "report", "visual", "Power BI Report Visuals"],
      ["Semantic Model/Composite Models", "semantic_model", "composite_model", "Power BI Composite Models"], ["Semantic Model/Fact Tables", "semantic_model", "fact_table", "Power BI Fact Tables"],
      ["Semantic Model/M Query", "semantic_model", "m_query", "Power BI M Query"], ["Semantic Model/Organizing Tables", "semantic_model", "table", "Organizing Power BI Tables"],
    ]) put(`Power BI/${file}.md`, article({ id: `powerbi_${artifact}`, title, domain: "powerbi", layer, artifact, technology: "power_bi" }, `# ${title}\nBody.\n`));
    commit("power bi wiki"); now += 1;
    assertRefreshed(options({ force: true }));
    for (const prompt of ["Add a measure to the Power BI model for total sales", "Review the Power BI semantic model"]) {
      const record = buildStandardsContext(prompt, options({ refresh: false })).records.find((r) => r.resolution.domain === "semantic_model");
      const files = record.sections.map((s) => s.file);
      assert.ok(files.length > 0, prompt);
      for (const file of files) assert.equal(record.resolution.articles.find((a) => a.file === file)?.layer, "semantic_model", `${prompt}: ${file}`);
      for (const decoy of ["Power BI/File Types.md", "Power BI/Reports/App Deployment.md"]) assert.equal(files.includes(decoy), false, `${prompt}: ${decoy}`);
    }
    // dax is carved out of the semantic_model layer, so it has no layer of its own:
    // a DAX task that matches no title word still gets the whole (small) domain.
    for (const [file, artifact, title] of [["Semantic Model/DAX", "dax_expression", "Power BI DAX"], ["Semantic Model/Measures", "measure", "Power BI Measures"]]) {
      put(`Power BI/${file}.md`, article({ id: `powerbi_${artifact}`, title, domain: "powerbi", layer: "semantic_model", artifact, technology: "power_bi" }, `# ${title}\n${artifact.toUpperCase()} BODY\n`));
    }
    commit("dax articles"); now += 1;
    assertRefreshed(options({ force: true }));
    const daxContext = buildStandardsContext("Add a calculated column for margin", options({ refresh: false }));
    assert.deepEqual(daxContext.domains, ["dax"]);
    assert.deepEqual(daxContext.records[0].sections.map((s) => s.file).sort(), ["Power BI/Semantic Model/DAX.md", "Power BI/Semantic Model/Measures.md"]);
    // A one-article domain with no core layer gets that article's body.
    const single = retrieveRelevantSections(resolveStandard("fabric_platform", options({ refresh: false })), "Review the lakehouse");
    assert.deepEqual(single.map((s) => s.file), ["Fabric/Workspaces.md"]);
    // Too many articles and no core layer: a listing with paths the agent can open, no bodies.
    for (let i = 1; i <= 7; i += 1) put(`Fabric/Topic ${i}.md`, article({ id: `fabric_topic_${i}`, title: `Fabric Topic ${i}`, domain: "fabric_platform", artifact: `topic_${i}`, technology: "fabric" }, `# Fabric Topic ${i}\nTOPIC BODY\n`));
    commit("large fabric_platform domain"); now += 1;
    assertRefreshed(options({ force: true }));
    const listing = retrieveRelevantSections(resolveStandard("fabric_platform", options({ refresh: false })), "Review the lakehouse");
    assert.equal(listing.length, 1); assert.equal(listing[0].file, undefined);
    assert.equal(listing[0].content.includes("TOPIC BODY") || listing[0].content.includes("Name workspaces by layer"), false);
    const listed = listing[0].content.split("\n").map((line) => line.replace(/^- [^:]+: /, ""));
    assert.equal(listed.length, 8);
    for (const path of listed) assert.ok(isAbsolute(path) && existsSync(path), `listed path is openable: ${path}`);
    git(["reset", "--hard", good]);
  });
  test("an article saved with a byte-order mark is still read", () => {
    const good = git(["rev-parse", "HEAD"]);
    put("SQL/Gold/Views.md", `\uFEFF${article({ id: "sql_gold_views", title: "Gold Views", domain: "sql", layer: "gold", artifact: "view" }, "# Gold Views\nBOMVIEWS\n")}`);
    commit("bom article"); now += 1;
    assertRefreshed(options({ force: true }));
    const sql = resolveStandard("sql", options({ refresh: false }));
    assert.deepEqual(sql.articles.map((a) => a.file), ["SQL/Gold/Stored Procedures.md", "SQL/Gold/Views.md", "SQL/SQL Conventions.md"]);
    assert.match(readFileSync(sql.path, "utf8"), /BOMVIEWS/);
    git(["reset", "--hard", good]);
  });
  test("a duplicate article id keeps both files and is reported with both paths", () => {
    // Obsidian "Make a copy": same front matter, and the copy sorts first by path.
    const good = git(["rev-parse", "HEAD"]);
    const views = article({ id: "sql_gold_views", title: "Gold Views", domain: "sql", layer: "gold", artifact: "view" }, "# Gold Views\nORIGINAL views\n");
    put("SQL/Gold/Views.md", views); put("SQL/Gold/Views 1.md", views.replace("ORIGINAL", "COPY"));
    commit("make a copy"); now += 1;
    assertRefreshed(options({ force: true }));
    const sql = resolveStandard("sql", options({ refresh: false }));
    assert.equal(sql.state, "canonical");
    assert.deepEqual(sql.articles.map((a) => a.file), ["SQL/Gold/Stored Procedures.md", "SQL/Gold/Views 1.md", "SQL/Gold/Views.md", "SQL/SQL Conventions.md"]);
    const [record] = buildStandardsContext("Create a SQL gold view for customer sales", options({ refresh: false })).records;
    assert.ok(record.sections.some((s) => s.file === "SQL/Gold/Views.md" && s.content.includes("ORIGINAL")), "the original is not dropped for the copy");
    assert.deepEqual(sourceStatus(options()).sources[0].warnings, ["duplicate article id sql_gold_views: SQL/Gold/Views 1.md and SQL/Gold/Views.md"]);
    git(["reset", "--hard", good]);
  });
  test("a wiki with no active articles fails closed and keeps the last known good", () => {
    const good = git(["rev-parse", "HEAD"]); now += 1;
    assertRefreshed(options({ force: true }));
    git(["rm", "-q", "-r", "SQL", "Power BI", "Fabric"]); git(["commit", "-q", "-m", "empty wiki"]); now += 1;
    const failed = refreshCanonical(options({ force: true }));
    assert.equal(failed.ok, false); assert.match(failed.detail, /no active articles/);
    assert.equal(activeCanonicalGeneration(options()).revision, good);
    git(["reset", "--hard", good]);
  });
  test("prompts in the wiki's own vocabulary get the articles they need (#88)", () => {
    // Front matter of every active coop-standards article at its real path, from the
    // golden set's wiki mirror, with stub bodies: selection reads only front matter.
    const good = git(["rev-parse", "HEAD"]);
    const mirror = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "standards-golden-corpus.json"), "utf8")).wiki.articles;
    for (const { path, id, title, domain, layer, artifact, technology } of mirror) put(path, article({ id, title, domain, layer, artifact, technology }, `# ${title}\nBody.\n`));
    commit("mirror the coop-standards wiki front matter"); now += 1;
    assert.equal(refreshCanonical(options({ force: true })).ok, true);
    const rows = [
      ["fix the silver indexing on the fabric warehouse table", ["Silver Indexing", "Fabric Warehouse Target"], ["Organizing Power BI Tables", "Power BI Fact Tables", "Power BI Relationships"]],
      ["Fix the T-SQL merge statement in the gold fact table load", ["Gold Stored Procedures", "Gold Fact Tables"], ["Power BI Fact Tables", "Organizing Power BI Tables", "Power BI DAX"]],
      ["Write the silver to gold load for the fact table", ["Gold Stored Procedures", "Gold Fact Tables"], ["Power BI Fact Tables", "Organizing Power BI Tables", "Power BI DAX"]],
      ["Create a Fabric warehouse table for the gold customer dimension", ["Gold Dimension Tables", "Fabric Warehouse Target"], ["Organizing Power BI Tables", "Power BI Relationships"]],
      ["Format the report page visuals", ["Power BI Report Page Formatting", "Power BI Report Visuals"], ["SQL Layout", "Power BI DAX", "Power BI M Query"]],
      ["Add a custom index on silver.custtable in the Azure SQL database - the gold customer load keeps scanning on dataareaid and accountnum", ["Silver Indexing"], ["Fabric Warehouse Target", "Organizing Power BI Tables"]],
      ["Add inventtransorigin to the Schema Manager metadata so the silver table gets generated on the next run", ["Silver Schema Manager"], ["Power BI M Query", "Power BI Report Visuals"]],
      ["This measure nests CALCULATE inside CALCULATE and uses AVERAGEX - rewrite it with variables", ["Power BI DAX"], ["SQL Conventions", "Gold Stored Procedures"]],
      ["Create a measure for invoice amount by due date using the inactive FKDueDate relationship", ["Power BI DAX", "Power BI Measures", "Power BI Relationships"], ["SQL Conventions", "Gold Fact Tables"]],
      ["Write the Power Query for the Customer dimension using the SQLServer and SQLDB parameters", ["Power BI M Query"], ["SQL Conventions", "SQL Layout", "Gold Dimension Tables"]],
      ["Rename the tables in the Direct Lake model to PascalCase", ["Organizing Power BI Tables"], ["SQL Layout", "Silver Schema Manager"]],
      ["Create dim.Item in the Fabric warehouse, its sales.Item view, and add Item to the semantic model with a relationship to Sales", ["Gold Dimension Tables", "Gold Views", "Fabric Warehouse Target", "Power BI Relationships"], ["Silver Schema Derivation", "Power BI App Deployment"]],
      ["Explain what a lakehouse is in Microsoft Fabric", [], null],
      ["Rebase my branch onto main and fix the merge conflicts in CHANGELOG.md", [], null],
      ["Write a PowerShell script that renames the exported CSV files in Downloads by date", [], null],
      // Gold SQL work gets the gold articles, not the Power BI table articles.
      ["Create the gold customer dimension table", ["Gold Dimension Tables"], ["Power BI Fact Tables", "Organizing Power BI Tables"]],
      // "reporting" is not the report layer: the model's core articles, not the report ones.
      ["Review the reporting semantic model", ["Power BI Relationships", "Organizing Power BI Tables"], ["Power BI Report Visuals", "Power BI Report Page Formatting", "Power BI App Deployment"]],
      // Power BI work on a gold dim./fact. source keeps the Power BI table articles.
      ["Create a Power BI dimension table from the gold customer view", ["Organizing Power BI Tables", "Gold Dimension Tables"], ["Silver Indexing"]],
      ["Fix the sort by on the dim.Date date table so Month Name sorts by Month Number", ["Organizing Power BI Tables", "Gold Dimension Tables"], ["Power BI Report Visuals"]],
      ["Write a DAX measure for sales from the gold fact table", ["Power BI Fact Tables", "Power BI DAX", "Gold Fact Tables"], ["Silver Indexing"]],
      // Everyday "measures" and pkg/PKCE get no standards.
      ["Document the preventive measures we took after the outage", [], null],
      ["Write a test that measures API latency", [], null],
      ["Explain the relationship between pkg and npm", [], null],
      // #95 widened the classifier from wiki layer words; the classifier covers what it
      // was for (#101): Schema Manager work is SQL, and model, lakehouse and non-task
      // prompts stay as they were.
      ["update the silver schema manager for the customer table", ["Silver Schema Manager"], ["Power BI M Query", "Organizing Power BI Tables"]],
      ["Add a table to the semantic model", ["Organizing Power BI Tables"], ["SQL Conventions", "Silver Indexing", "Gold Dimension Tables"]],
      ["Design a lakehouse architecture", [], null],
      ["what is silver in the medallion architecture?", [], null],
      // ...and a bare "report", "silver" or "gold" outside BI work gets nothing (#101).
      ["Write a status report for the client on this week's progress", [], null],
      ["Fix the bug in the report generator script", [], null],
      ["Add a silver badge to the website header", [], null],
      ["Update the README with the gold customer tiers", [], null],
    ];
    const wrong = [];
    for (const [prompt, must, mustNot] of rows) {
      const titles = buildStandardsContext(prompt, options({ refresh: false })).records.flatMap((r) => r.sections.filter((s) => s.file).map((s) => s.heading));
      const bad = mustNot === null ? titles.map((t) => `injected ${t}`)
        : [...must.filter((t) => !titles.includes(t)).map((t) => `missing ${t}`), ...mustNot.filter((t) => titles.includes(t)).map((t) => `forbidden ${t}`)];
      if (bad.length) wrong.push({ prompt, bad });
    }
    assert.deepEqual(wrong, []);
    git(["reset", "--hard", good]);
  });
  assert.match(readFileSync(join(ROOT, "bin", "coop"), "utf8"), /resolve-many sql,dax/);
  console.log(`standards live sync: ${count} tests passed`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
