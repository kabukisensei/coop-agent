// Tests for lib/project-share.mjs (master plan C1, the shared project file):
// the comparison with the team's copy, "Get the team's project file", "Share
// with the team" (one file, fixed message, current branch, audited), the fetch
// throttle, the client home repository and the CLI. Real git, local bare origin.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "coop-project-share-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.COOP_DIR = join(tmp, "profile-home");
const ps = await import(pathToFileURL(join(ROOT, "lib", "project-share.mjs")).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
const identity = (cwd) => { git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test User"); };
const CONTRACT = "profile:\n  client: 'Contoso'\n";

if (spawnSync("git", ["--version"]).status !== 0) {
  console.log("  – git not available; skipping project-share tests");
  process.exit(0);
}

try {
  const origin = join(tmp, "origin.git");
  git(tmp, "init", "--bare", "--initial-branch=main", "origin.git");
  const a = join(tmp, "a");
  const b = join(tmp, "b");
  git(tmp, "clone", "--quiet", origin, "a");
  identity(a);
  writeFileSync(join(a, "README.md"), "# a\n");
  git(a, "add", "README.md");
  git(a, "commit", "--quiet", "-m", "init");
  git(a, "push", "--quiet", "origin", "main");
  git(tmp, "clone", "--quiet", origin, "b");
  identity(b);

  await t("status: none, not-shared; share commits only .coop/project.yml with the fixed message and audits it", () => {
    assert.equal(ps.teamFileStatus(join(tmp, "nowhere-" + n)).state, "no-git");
    assert.equal(ps.teamFileStatus(a).state, "none");
    mkdirSync(join(a, ".coop"));
    writeFileSync(join(a, ".coop", "project.yml"), CONTRACT);
    writeFileSync(join(a, "notes.txt"), "untracked, never shared\n");
    writeFileSync(join(a, "README.md"), "# a (modified, never shared)\n");
    git(a, "add", "README.md"); // even a staged other file stays out of the share commit
    const before = ps.teamFileStatus(a);
    assert.deepEqual([before.state, before.branch, before.defaultBranch, before.localExists, before.originExists], ["not-shared", "main", "main", true, false]);
    const shared = ps.shareContract(a, { name: "Aaron" });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    assert.deepEqual([shared.state, shared.branch, shared.by], ["shared", "main", "Aaron"]);
    assert.equal(git(a, "log", "-1", "--format=%s"), "coop: project file updated by Aaron");
    assert.deepEqual(git(a, "show", "--name-only", "--format=", "HEAD").split("\n"), [".coop/project.yml"], "only the project file is in the commit");
    assert.equal(git(a, "diff", "--cached", "--name-only"), "README.md", "the other staged file is still staged, uncommitted");
    assert.equal(git(a, "status", "--porcelain", "--", "notes.txt"), "?? notes.txt");
    assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "coop: project file updated by Aaron", "pushed");
    assert.equal(ps.teamFileStatus(a).state, "shared");
    assert.equal(ps.shareContract(a).state, "already-shared");
    const audit = readFileSync(join(tmp, "agent", "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].kind, audit[0].tool, audit[0].decision, audit[0].label, audit[0].detail], ["project-share", "project-share", "allowed", ".coop/project.yml", "push main"]);
  });

  await t("get: the team has it and this checkout does not: a fast-forward pull when nothing else would move", () => {
    const status = ps.teamFileStatus(b);
    assert.deepEqual([status.state, status.originExists, status.localExists], ["team-has-it", true, false]);
    const got = ps.getTeamContract(b);
    assert.deepEqual([got.ok, got.state, got.method], [true, "got", "pull"]);
    assert.equal(readFileSync(join(b, ".coop", "project.yml"), "utf8"), CONTRACT);
    assert.equal(ps.teamFileStatus(b).state, "shared");
    assert.equal(ps.getTeamContract(b).method, "none");
  });

  await t("get: a modified checkout gets only the file (with a backup); team-newer when the local copy is unmodified", () => {
    writeFileSync(join(a, ".coop", "project.yml"), CONTRACT + "  timezone: 'Europe/Amsterdam'\n");
    assert.equal(ps.shareContract(a, { name: "Aaron" }).ok, true);
    // b: unmodified local file, origin moved.
    assert.equal(ps.teamFileStatus(b, { fetch: true, now: Date.now() + ps.FETCH_MAX_AGE_MS + 1 }).state, "team-newer");
    // b with local edits: not-shared; get keeps a backup and touches nothing else.
    writeFileSync(join(b, ".coop", "project.yml"), CONTRACT + "  timezone: 'America/Chicago'\n");
    writeFileSync(join(b, "work.txt"), "in progress\n");
    assert.equal(ps.teamFileStatus(b).state, "not-shared");
    const got = ps.getTeamContract(b);
    assert.deepEqual([got.ok, got.method], [true, "file"]);
    assert.equal(got.backup, join(b, ".coop", "project.yml.bak"));
    assert.equal(readFileSync(join(b, ".coop", "project.yml"), "utf8"), CONTRACT + "  timezone: 'Europe/Amsterdam'\n");
    assert.equal(readFileSync(join(b, "work.txt"), "utf8"), "in progress\n", "nothing else moved");
    assert.equal(git(b, "rev-parse", "HEAD"), git(b, "rev-parse", "HEAD"), "no pull happened");
    assert.equal(ps.teamFileStatus(b).state, "shared");
  });

  await t("share: a branch that is not the default asks; force pushes there; a refused push is reported, not retried", () => {
    git(a, "checkout", "--quiet", "-b", "feature/x");
    writeFileSync(join(a, ".coop", "project.yml"), CONTRACT + "  timezone: 'Asia/Tokyo'\n");
    const asked = ps.shareContract(a, { name: "Aaron" });
    assert.deepEqual([asked.ok, asked.state, asked.branch, asked.defaultBranch], [false, "other-branch", "feature/x", "main"]);
    assert.equal(git(a, "status", "--porcelain", "--", ".coop/project.yml").trim(), "M .coop/project.yml", "nothing staged or committed before the yes");
    const forced = ps.shareContract(a, { name: "Aaron", force: true });
    assert.deepEqual([forced.ok, forced.state, forced.branch], [true, "shared", "feature/x"]);
    assert.equal(git(origin, "log", "-1", "--format=%s", "feature/x"), "coop: project file updated by Aaron");
    git(a, "checkout", "--quiet", "main");
    writeFileSync(join(a, ".coop", "project.yml"), CONTRACT + "  timezone: 'Africa/Cairo'\n");
    git(a, "remote", "set-url", "origin", join(tmp, "missing.git"));
    const refused = ps.shareContract(a, { name: "Aaron" });
    assert.deepEqual([refused.ok, refused.state, refused.committed], [false, "push-refused", true]);
    assert.ok(refused.reason && !refused.reason.includes(tmp), "the reason carries no local path: " + refused.reason);
    git(a, "remote", "set-url", "origin", origin);
    const audit = readFileSync(join(tmp, "agent", "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((x) => x.decision), ["allowed", "allowed", "allowed", "blocked"]);
  });

  await t("fetch throttle: one fetch per ten minutes per repository", () => {
    const now = Date.now();
    const first = ps.fetchOrigin(b, { now: now + ps.FETCH_MAX_AGE_MS + 1 });
    assert.equal(first.fetched, true);
    const second = ps.fetchOrigin(b, { now: Date.now() });
    assert.deepEqual([second.fetched, second.fresh], [false, true]);
  });

  await t("sharerName: the coop profile's name, else git's user.name", () => {
    assert.equal(ps.sharerName(a), "Test User");
    mkdirSync(join(tmp, "profile-home", ".coop"), { recursive: true });
    writeFileSync(join(tmp, "profile-home", ".coop", "user.json"), JSON.stringify({ schema_version: 1, name: "Joel" }));
    assert.equal(ps.sharerName(a), "Joel");
  });

  await t("createHomeRepository: folder, git init and README once; a repository that exists is left alone", () => {
    const home = join(tmp, "client", "contoso-coop");
    const made = ps.createHomeRepository(home, "Contoso Retail");
    assert.deepEqual([made.created, made.initialized, made.readme], [true, true, true]);
    assert.ok(existsSync(join(home, ".git")));
    const readme = readFileSync(join(home, "README.md"), "utf8");
    assert.match(readme, /^# contoso-retail-coop\n/);
    assert.match(readme, /home repository for \*\*Contoso Retail\*\*/);
    assert.equal(readme.includes("<client>"), false);
    writeFileSync(join(home, "README.md"), "mine\n");
    const again = ps.createHomeRepository(home, "Contoso Retail");
    assert.deepEqual([again.created, again.initialized, again.readme], [false, false, false]);
    assert.equal(readFileSync(join(home, "README.md"), "utf8"), "mine\n");
  });

  await t("CLI: status, get and share print JSON and exit 1 on a refusal", () => {
    const run = (...args) => spawnSync(process.execPath, [join(ROOT, "lib", "project-share.mjs"), ...args], { encoding: "utf8", env: process.env });
    const status = run("status", "--root", b);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, "shared");
    const nothing = run("share", "--root", join(tmp, "nowhere-" + n));
    assert.equal(nothing.status, 1);
    assert.equal(JSON.parse(nothing.stdout).state, "no-git");
    const unknown = run("bogus");
    assert.equal(unknown.status, 1);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`project-share: ${n} test(s) passed`);
