import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeCanonicalGeneration, fsyncDirectory, pinStandardsTask, promoteReviewRun, refreshCanonical, resolveAcceptedReviewRun, resolveStandard, sourceStatus, standardsRegistry } from "../lib/standards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "coop-standards-live-"));
const remote = join(tmp, "remote"), cache = join(tmp, "cache", "canonical"), state = join(tmp, "cache", "status.json"), snapshots = join(tmp, "snapshots");
const registryPath = join(tmp, "registry.json");
let now = 1_000_000, count = 0;
let r3;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const git = (args, cwd = remote) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const writeCanonical = (suffix) => {
  mkdirSync(join(remote, "standards"), { recursive: true });
  for (const [name, title] of [["sql", "SQL"], ["dax", "DAX"], ["semantic-model", "Model"]]) writeFileSync(join(remote, "standards", `${name}.md`), `# ${title} ${suffix}\n## Security\n${title} ${suffix}\n`);
  writeFileSync(join(remote, "standards.yml"), "schema_version: 1\nauthority: formal_standard\nauthoritative_ref: default_branch\ncontent_mode: markdown_only\nprecedence:\n  - project_override\n  - canonical_standard\n  - last_known_good\n  - bundled_fallback\nrefresh:\n  startup: true\n  task_freshness_minutes: 15\n  force_command: coop sync\n  failure_mode: last_known_good\n  pin_revision_per_task: true\n  invalidate_index_on_revision_change: true\nstandards:\n  sql:\n    path: standards/sql.md\n  dax:\n    path: standards/dax.md\n  semantic_model:\n    path: standards/semantic-model.md\n");
};
const commit = (message) => { git(["add", "."]); git(["commit", "-q", "-m", message]); return git(["rev-parse", "HEAD"]); };
const options = (more = {}) => ({ canonicalRoot: cache, statePath: state, snapshotRoot: snapshots, registryPath, fixtureRegistry: true, remote, now: () => now, staleRoot: join(tmp, "none"), reviewerBins: { sql: join(tmp, "none-sql"), dax: join(tmp, "none-dax") }, ...more });
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };
const resetStorage = () => { rmSync(join(tmp, "cache"), { recursive: true, force: true }); rmSync(snapshots, { recursive: true, force: true }); };

try {
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  git(["config", "user.email", "standards@test.invalid"]); git(["config", "user.name", "Standards Test"]);
  writeCanonical("r1"); const r1 = commit("r1");
  writeFileSync(registryPath, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: remote, authoritative_branch: "main", manifest: "standards.yml", initial_verified_commit: r1, initial_archive_sha256: "0".repeat(64), freshness_seconds: 900, timeout_seconds: 2, domains: { sql: "standards/sql.md", dax: "standards/dax.md", semantic_model: "standards/semantic-model.md" } } }));

  test("directory durability suppresses only explicit Windows unsupported errors", () => {
    const error = (code) => { const value = new Error(code); value.code = code; return value; };
    assert.throws(() => fsyncDirectory(tmp, { platform: "linux", fsync: () => { throw error("EIO"); } }), /EIO/);
    assert.throws(() => fsyncDirectory(tmp, { platform: "win32", fsync: () => { throw error("ENOSPC"); } }), /ENOSPC/);
    assert.doesNotThrow(() => fsyncDirectory(tmp, { platform: "win32", fsync: () => { throw error("EINVAL"); } }));
  });
  test("production registry pins private main and verified anchor", () => {
    const r = standardsRegistry();
    assert.equal(r.canonical.repository, "https://github.com/cooptimize/coop-standards.git"); assert.equal(r.canonical.authoritative_branch, "main"); assert.equal(r.canonical.initial_verified_commit, "fa109f11129742358ff1e078cd4c4433e356afb4");
  });
  test("production registry ignores inherited redirection and source/status/refresh retain committed authority", () => {
    const old = process.env.COOP_STANDARDS_REGISTRY;
    process.env.COOP_STANDARDS_REGISTRY = registryPath;
    try {
      const r = standardsRegistry();
      assert.equal(r.canonical.repository, "https://github.com/cooptimize/coop-standards.git");
      assert.equal(Object.isFrozen(r) && Object.isFrozen(r.canonical) && Object.isFrozen(r.canonical.domains), true);
      assert.throws(() => { r.canonical.repository = remote; }, TypeError);
      assert.throws(() => standardsRegistry({ registryPath }), /explicit fixture/);
      const productionRoot = join(tmp, "production-cache", "canonical");
      const productionState = join(tmp, "production-cache", "status.json");
      const status = sourceStatus({ canonicalRoot: productionRoot, statePath: productionState, snapshotRoot: join(tmp, "production-snapshots"), refresh: false });
      assert.equal(status.sources[0].repository, r.canonical.repository);
      let clone = null;
      const refreshed = refreshCanonical({ canonicalRoot: productionRoot, statePath: productionState, snapshotRoot: join(tmp, "production-snapshots"), force: true, runner: (args) => { if (args[0] === "clone") clone = args; return { status: 1, stdout: "", stderr: "offline fixture" }; } });
      assert.equal(refreshed.ok, false);
      assert.equal(clone.includes(r.canonical.repository), true);
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
    git(["reset", "--hard", r1]); resetStorage(); now += 1; assert.equal(refreshCanonical(options({ force: true })).ok, true);
    const old = activeCanonicalGeneration(options()); git(["reset", "--hard", r2]);
    const failed = refreshCanonical(options({ force: true, fault: step })); assert.equal(failed.ok, false);
    const active = activeCanonicalGeneration(options()); assert.equal(active.ok, true, JSON.stringify(active));
    assert.equal(active.revision, beforePointer.includes(step) ? old.revision : r2);
    assert.equal(JSON.parse(readFileSync(active.index)).revision, active.revision);
  });

  for (const [artifact, relativePath] of [
    ["index", "retrieval-index.json"],
    ["metadata", "generation.json"],
    ["authority", join("checkout", "standards", "sql.md")],
  ]) test(`final-location ${artifact} corruption cannot activate a canonical generation`, () => {
    git(["reset", "--hard", r1]); resetStorage(); now += 1; assert.equal(refreshCanonical(options({ force: true })).ok, true);
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
      git(["reset", "--hard", r1]); resetStorage(); now += 1; assert.equal(refreshCanonical(options({ force: true })).ok, true);
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
    assert.equal(refreshCanonical(options({ force: true })).ok, true);
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
    assert.equal(refreshCanonical(options({ force: true })).ok, true);
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
    writeFileSync(join(active.checkout, "standards", "sql.md"), "# locally invented\n"); git(["add", "."], active.checkout); git(["commit", "-q", "-m", "invented"], active.checkout);
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
  test("legacy self-authored manifests require explicit fixture injection", () => {
    const fixture = join(tmp, "legacy"); mkdirSync(fixture); writeFileSync(join(fixture, "sql.md"), "# fixture"); writeFileSync(join(fixture, "manifest.json"), JSON.stringify({ schema_version: 1, revision: "fixture", domains: { sql: { path: "sql.md", sha256: hash("# fixture") } } }));
    assert.notEqual(resolveStandard("sql", options({ canonicalRoot: fixture })).state, "canonical"); assert.equal(resolveStandard("sql", options({ fixtureRoot: fixture })).revision, "fixture");
  });
  assert.match(readFileSync(join(ROOT, "bin", "coop"), "utf8"), /resolve-many sql,dax/);
  console.log(`standards live sync: ${count} tests passed`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
