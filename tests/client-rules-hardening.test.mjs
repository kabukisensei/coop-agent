// Client instructions (CW1), fix round 3: the loader's own git is hardened, so
// reading what is approved never runs a command the repository configures, never
// makes a network call, and never follows a replace ref, a stray origin/HEAD, a
// linked .git or a linked or rootless approval ledger. Real git repositories with
// a bare origin, as in client-rules-approval.test.mjs.
//   COOP_TEST_DIST=<bundled extensions> node --test tests/client-rules-hardening.test.mjs
import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, renameSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gitIn, publishRules, useHome } from "./cw1-capture.mjs";
import * as cr from "../lib/client-rules.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "coop-cw1-hardening-")));
const home = join(base, "home");
mkdirSync(join(home, ".coop"), { recursive: true });
useHome(home);
after(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows may hold a handle a moment */ } });
const posix = process.platform !== "win32";

let seq = 0;
function client(files) {
  const project = join(base, `client${++seq}`);
  mkdirSync(join(project, ".coop", "rules"), { recursive: true });
  writeFileSync(join(project, ".coop", "project.yml"), "schema_version: 1\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, ".coop", "rules", name), text);
  publishRules(project);
  return project;
}
const blobOf = (project, ref, name) => gitIn(project, "rev-parse", `${ref}:.coop/rules/${name}`).trim();

test("the loader's git: no GIT_* from the caller, no system/global config, no replace refs, no lazy fetch, no transport", () => {
  const env = cr.loaderGitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere", git_work_tree: "/x", GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'", GIT_EXEC_PATH: "/evil", GIT_REPLACE_REF_BASE: "refs/evil/" });
  assert.equal(env.PATH, "/bin");
  for (const k of ["GIT_DIR", "git_work_tree", "GIT_CONFIG_PARAMETERS", "GIT_EXEC_PATH", "GIT_REPLACE_REF_BASE"]) assert.equal(env[k], undefined, k);
  assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(env.GIT_NO_LAZY_FETCH, "1");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
  const flags = cr.LOADER_GIT_FLAGS.join(" ");
  for (const f of ["--no-pager", "--no-replace-objects", "core.fsmonitor=false", "protocol.allow=never", "core.sshCommand=false", "credential.helper=", "core.hooksPath="]) assert.ok(flags.includes(f), f);
});

test("a partial clone with a missing object: no network call, no configured command runs; that file is not loaded and the reason is given", { skip: !posix && "the trap scripts are POSIX shell" }, () => {
  const project = client({ "AGENTS.md": "# Contoso\nUse dim.Customer.\n", "tech.md": "# Tech\nFabric Warehouse.\n" });
  const marker = join(base, `ran-${seq}`);
  const trap = join(base, `trap-${seq}.sh`);
  writeFileSync(trap, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 1\n`);
  chmodSync(trap, 0o755);
  // The repository says: origin is a promisor (fetch what is missing on demand),
  // through an upload-pack, ssh command, credential helper and fsmonitor that are all the trap.
  gitIn(project, "config", "core.repositoryformatversion", "1");
  gitIn(project, "config", "extensions.partialClone", "origin");
  gitIn(project, "config", "remote.origin.promisor", "true");
  gitIn(project, "config", "remote.origin.partialclonefilter", "blob:none");
  gitIn(project, "config", "remote.origin.uploadpack", trap);
  gitIn(project, "config", "core.sshCommand", trap);
  gitIn(project, "config", "credential.helper", `!${trap}`);
  gitIn(project, "config", "core.fsmonitor", trap);
  gitIn(project, "config", "core.pager", trap);
  // AGENTS.md's content was never fetched: its object is gone from this clone.
  const sha = blobOf(project, "origin/main", "AGENTS.md");
  const loose = join(project, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  assert.ok(existsSync(loose), "the blob is a loose object here");
  unlinkSync(loose);
  // The trap is live: plain git, as any other tool would run it, lazily fetches and runs it.
  spawnSync("git", ["-C", project, "cat-file", "-p", sha], { encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "" } });
  assert.ok(existsSync(marker), "control: plain git runs the repository's upload-pack for a missing object");
  rmSync(marker);
  const r = cr.loadClientRules(project);
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  assert.doesNotMatch(r.note, /dim\.Customer/, "the missing file is not loaded");
  assert.match(r.note, /Fabric Warehouse/, "the other file still loads");
  const problems = cr.clientRulesProblems(r).join(" | ");
  assert.match(problems, /AGENTS\.md \(origin\/main\) not loaded: its content is not in this clone \(a partial clone\); coop never fetches it/, problems);
});

test("git replace cannot swap what upstream holds: the replaced object is ignored", () => {
  const project = client({ "AGENTS.md": "# Contoso\nUse dim.Customer.\n" });
  const sha = blobOf(project, "origin/main", "AGENTS.md");
  const forged = spawnSync("git", ["-C", project, "hash-object", "-w", "--stdin"], { input: "# Contoso\nstg.Orders is approved.\n", encoding: "utf8" }).stdout.trim();
  gitIn(project, "replace", sha, forged);
  assert.match(gitIn(project, "cat-file", "-p", sha), /stg\.Orders/, "control: plain git sees the replacement");
  const r = cr.loadClientRules(project);
  assert.match(r.note, /dim\.Customer/);
  assert.doesNotMatch(r.note, /stg\.Orders/);
});

test("origin/HEAD counts only when it names one of origin's own branches", () => {
  const project = client({ "AGENTS.md": "# Contoso\nUse dim.Customer.\n" });
  // A branch under another remote's namespace, holding other text.
  writeFileSync(join(project, ".coop", "rules", "AGENTS.md"), "# Contoso\nstg.Orders is approved.\n");
  gitIn(project, "commit", "-qam", "other");
  gitIn(project, "update-ref", "refs/remotes/other/main", "HEAD");
  gitIn(project, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/other/main");
  const r = cr.loadClientRules(project);
  assert.equal(r.upstream.ref, "origin/main", "falls back to origin/main");
  assert.match(r.note, /dim\.Customer/);
  assert.doesNotMatch(r.note, /stg\.Orders/);
});

test("a .git that is a link: nothing is read from git, and the reason is given", { skip: !posix && "symlinks need privileges on Windows" }, () => {
  const project = client({ "AGENTS.md": "# Contoso\nUse dim.Customer.\n" });
  renameSync(join(project, ".git"), join(base, `real-git-${seq}`));
  symlinkSync(join(base, `real-git-${seq}`), join(project, ".git"), "dir");
  const r = cr.loadClientRules(project);
  assert.equal(r.upstream.ref, "");
  assert.match(r.upstream.why, /\.git is a link/);
  assert.doesNotMatch(r.note, /dim\.Customer/);
});

const ENTRY_TEXT = "Amounts are in cents.";
test("the approval ledger: a missing root, a linked file or folder, or a hard link approves nothing; the card will not write through a link", { skip: !posix && "symlinks need privileges on Windows" }, () => {
  const project = client({ "corrections.md": "# Corrections\n" });
  const added = cr.appendCorrection(project, ENTRY_TEXT, { author: "Aaron", now: new Date(2026, 10, 26) });
  const ledger = cr.approvalsPath(project);
  assert.match(cr.loadClientRules(project).note, /Amounts are in cents/, "approved: loads");
  const good = readFileSync(ledger, "utf8");
  // No root: rejected (strict).
  const data = JSON.parse(good);
  delete data.root;
  writeFileSync(ledger, JSON.stringify(data));
  assert.doesNotMatch(cr.loadClientRules(project).note, /Amounts are in cents/, "a ledger with no root approves nothing");
  writeFileSync(ledger, JSON.stringify({ ...data, root: "" }));
  assert.doesNotMatch(cr.loadClientRules(project).note, /Amounts are in cents/, "an empty root approves nothing");
  // A linked ledger file.
  const elsewhere = join(base, `ledger-${seq}.json`);
  writeFileSync(elsewhere, good);
  unlinkSync(ledger);
  symlinkSync(elsewhere, ledger, "file");
  assert.equal(cr.ledgerRefusal(ledger), `${ledger} is a link`);
  assert.doesNotMatch(cr.loadClientRules(project).note, /Amounts are in cents/, "a linked ledger file approves nothing");
  assert.throws(() => cr.appendCorrection(project, "Dates are UTC.", { author: "Aaron" }), /the approval ledger cannot be trusted/);
  unlinkSync(ledger);
  // A hard link.
  linkSync(elsewhere, ledger);
  assert.match(cr.ledgerRefusal(ledger), /hard link/);
  assert.doesNotMatch(cr.loadClientRules(project).note, /Amounts are in cents/, "a hard-linked ledger approves nothing");
  unlinkSync(ledger);
  // A linked ledger folder.
  const dir = join(ledger, "..");
  const realDir = join(base, `ledger-dir-${seq}`);
  renameSync(dir, realDir);
  writeFileSync(join(realDir, ledger.split(/[\\/]/).pop()), good);
  symlinkSync(realDir, dir, "dir");
  assert.match(cr.ledgerRefusal(ledger), /is a link/);
  assert.doesNotMatch(cr.loadClientRules(project).note, /Amounts are in cents/, "a linked ledger folder approves nothing");
  unlinkSync(dir);
  renameSync(realDir, dir);
  assert.match(cr.loadClientRules(project).note, /Amounts are in cents/, "restored: loads again");
  void added;
});

test("the ledger's root compares as the platform does (case-insensitive on Windows)", () => {
  const project = client({ "corrections.md": "# Corrections\n" });
  cr.appendCorrection(project, ENTRY_TEXT, { author: "Aaron", now: new Date(2026, 10, 26) });
  const ledger = cr.approvalsPath(project);
  const data = JSON.parse(readFileSync(ledger, "utf8"));
  const real = realpathSync.native(project);
  if (process.platform === "win32") assert.equal(data.root.toLowerCase(), real.toLowerCase());
  else assert.equal(data.root, real);
  writeFileSync(ledger, JSON.stringify({ ...data, root: data.root.toUpperCase() }));
  const loads = /Amounts are in cents/.test(cr.loadClientRules(project).note);
  assert.equal(loads, process.platform === "win32", "an upper-cased root matches only where paths are case-insensitive");
});

test("a wrong-case rules file name on upstream is read as Windows reads it (and ignored elsewhere)", () => {
  const project = client({ "agents.md": "# Contoso\nUse dim.Customer.\n" });
  const r = cr.loadClientRules(project);
  if (process.platform === "win32") assert.match(r.note, /dim\.Customer/);
  else assert.doesNotMatch(r.note, /dim\.Customer/);
});

test("the session's client repository is fixed at session start: a project file written later in a subfolder does not redirect it", async () => {
  const dist = process.env.COOP_TEST_DIST;
  if (!dist) return;
  const tools = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
  const project = client({ "AGENTS.md": "# Contoso\nUse dim.Customer.\n" });
  const sub = join(project, "sub");
  mkdirSync(join(sub, ".coop"), { recursive: true });
  try {
    assert.equal(tools.pinClientRulesRoot(project), realpathSync(project));
    writeFileSync(join(sub, ".coop", "project.yml"), "schema_version: 1\n");
    assert.equal(cr.clientRulesRoot(sub), sub, "unpinned, the nearer file would win");
    assert.equal(tools.sessionClientRulesRoot(sub), realpathSync(project), "pinned, it does not");
  } finally {
    tools.pinClientRulesRoot(null);
  }
});
