/**
 * The coop window's side pane (master plan D1b2): the changes panel, the
 * standards pane, the project form and the docs setup form.
 *
 * The two forms must write exactly what the terminal wizards write for the
 * same answers: the project form through the /setup-project writer (checked
 * against runProjectWizard), the docs form through coop-data-doc's own wizard
 * (checked against runJsonlSetup with a fake coop-data-doc). Everything else
 * is read-only and checked from fixtures: a temporary git repository, canned
 * standards-cli output, built docs on disk.
 *
 * Gate lane: no Electron, no network; the only child processes are git and
 * the fake coop-data-doc, each answering at once. Needs COOP_TEST_DIST (the
 * bundled coop-tools) like the other wizard tests.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "coop-desktop-panes-"));

// Hermetic: git, the profile (user.json) and the client platform all resolve
// inside the temp folder, never the real home.
const home = join(temp, "home");
const coopDir = join(temp, "coop-home");
mkdirSync(home, { recursive: true });
mkdirSync(join(coopDir, ".coop"), { recursive: true });
writeFileSync(join(coopDir, ".coop", "user.json"), JSON.stringify({ schema_version: 1, name: "Tester" }));
Object.assign(process.env, { HOME: home, USERPROFILE: home, COOP_DIR: coopDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_TERMINAL_PROMPT: "0" });

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST must name the bundled extensions (tests/run.sh sets it)");
const tools = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);

const { parseUnifiedDiff, pairAndEmphasize, buildSplitRows, computeMatches, hunkStats } = await import("../desktop/renderer/unified-diff.mjs");
const { unifiedDiff } = await import("../desktop/lib/text-diff.mjs");
const { listChanges, listDrafts, fileDiff, parseNameStatus, parseNumstat, newFileDiff, changeRepos, defaultChangeRepo } = await import("../desktop/lib/changes.mjs");
const { readStandards, readSnapshot, readNote, listNotes, knowledgeView, domainView, sourceDomainView, keepArticles, DOMAINS, KNOWLEDGE_LABELS } = await import("../desktop/lib/standards-view.mjs");
const { loadProject, previewProject, saveProject, settingsFromForm } = await import("../desktop/lib/project-form.mjs");
const docs = await import("../desktop/lib/docs-setup.mjs");
const { normalizePath, relativePath, repoForPath, fixLinePrompt, splitPath, commentsOn, reviewPath, extendSelection, canComment, commentContext, reanchorComment, reviewPrompt, sideLines, COMMENT_STATUS } = await import("../desktop/renderer/pane-changes.mjs");
const { diffModel, diffRows, renderDiff, MAX_ROWS } = await import("../desktop/renderer/diff-view.mjs");
const editors = await import("../desktop/lib/editors.mjs");
const { loadSettings } = await import("../desktop/lib/settings.mjs");
const { articleOutline, sourceLine, noteLabel, isKnowledgeId, STATE_LABELS, KNOWLEDGE_STATE_LABELS } = await import("../desktop/renderer/pane-standards.mjs");
const { initialValues, formInput, platformHint, folderRows, sectionStatus, ROLE_LABELS } = await import("../desktop/renderer/pane-project.mjs");
const { resolvePage, isDocsLink, stripFrontMatter, answerLabel, typeLabel, readAgo, liveActions, liveKey } = await import("../desktop/renderer/pane-docs.mjs");
const { paneLinksForTool, paneLinksForText } = await import("../desktop/renderer/view.mjs");
const { parseMarkdown } = await import("../desktop/renderer/markdown.mjs");
const { KEYS } = await import("../desktop/renderer/commands.mjs");
const { projectYamlScalar } = await import("../lib/project-contract.mjs");

let passed = 0;
let failed = 0;
const skipped = [];
async function check(name, fn) {
  try {
    const result = await fn();
    if (result && result.skip) { skipped.push(name); console.log(`  ↷ SKIP ${name}: ${result.skip}`); return; }
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${String(error && error.stack || error).split("\n").slice(0, 8).join("\n    ")}`);
    failed += 1;
  }
}

// A marker above the temp folder (a .git or a contract) would capture the
// wizards' upward walk; those checks skip, as tests/project-wizard.test.mjs does.
function foreignMarkerAbove(dir) {
  for (let cur = resolve(dir, ".."); ; ) {
    if (existsSync(join(cur, ".git"))) return join(cur, ".git");
    if (existsSync(join(cur, ".coop", "project.yml"))) return join(cur, ".coop", "project.yml");
    const parent = resolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
}

// --- The diff model ---------------------------------------------------------

await check("diff model: hunks, CRLF, no-newline marker, binary and intraline emphasis", () => {
  const text = [
    "diff --git a/x.sql b/x.sql",
    "index 1..2 100644",
    "--- a/x.sql",
    "+++ b/x.sql",
    "@@ -1,3 +1,3 @@ SELECT",
    " SELECT a\r",
    "-FROM dbo.Sales\r",
    "+FROM dbo.SalesFact\r",
    " WHERE 1 = 1",
    "\\ No newline at end of file",
    "@@ -10 +10,2 @@",
    "+added",
    "+again",
  ].join("\n");
  const model = parseUnifiedDiff(text);
  assert.equal(model.binary, false);
  assert.equal(model.hunks.length, 2);
  const [first, second] = model.hunks;
  assert.deepEqual(first.lines.map((l) => [l.type, l.oldNo, l.newNo, l.text]), [
    ["ctx", 1, 1, "SELECT a"], ["del", 2, null, "FROM dbo.Sales"], ["add", null, 2, "FROM dbo.SalesFact"], ["ctx", 3, 3, "WHERE 1 = 1"],
  ]);
  assert.equal(first.lines[3].noNewline, true);
  assert.deepEqual(second.lines.map((l) => l.newNo), [10, 11]);
  pairAndEmphasize(model.hunks);
  assert.deepEqual(first.lines[1].em, [14, 14], "nothing removed: an empty emphasis on the old line");
  assert.deepEqual(first.lines[2].em, [14, 18], "the added 'Fact' is emphasised");
  assert.equal(first.lines[1].pair, 2);
  const rows = buildSplitRows(model.hunks);
  assert.deepEqual(rows.map((r) => r.kind), ["hunk", "ctx", "pair", "ctx", "hunk", "pair", "pair"]);
  assert.equal(rows[5].left, null);
  assert.deepEqual(computeMatches(model.hunks, "sales").map((m) => [m.hunkIdx, m.lineIdx, m.start]), [[0, 1, 9], [0, 2, 9]]);
  assert.deepEqual(computeMatches(model.hunks, ""), []);
  assert.deepEqual(hunkStats(model.hunks), { added: 3, removed: 1 });
  assert.equal(parseUnifiedDiff("diff --git a/b b/b\nBinary files a/b and b/b differ\n").binary, true);
  // A rewrite reads better without emphasis.
  const rewrite = parseUnifiedDiff("@@ -1 +1 @@\n-abcdefgh\n+zyxwvuts\n");
  pairAndEmphasize(rewrite.hunks);
  assert.equal(rewrite.hunks[0].lines[0].em, undefined);
});

await check("text diff: the project form's review diff round-trips to the saved text", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 5\n", "line five\n").replace("line 25\n", "") + "line 31\n";
  const diff = unifiedDiff(before, after);
  const model = parseUnifiedDiff(diff);
  assert.equal(model.hunks.length, 2, "changes far apart make two hunks");
  assert.match(model.hunks[0].header, /^@@ -2,7 \+2,7 @@$/);
  assert.deepEqual(hunkStats(model.hunks), { added: 2, removed: 2 });
  // Every changed and context line lands on its own number on each side.
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  for (const line of model.hunks.flatMap((h) => h.lines)) {
    if (line.oldNo !== null) assert.equal(oldLines[line.oldNo - 1], line.text);
    if (line.newNo !== null) assert.equal(newLines[line.newNo - 1], line.text);
  }
  // A new file is one hunk of additions.
  assert.equal(unifiedDiff("", "x\ny\n"), "@@ -0,0 +1,2 @@\n+x\n+y");
});

// --- The changes panel --------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=coop test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

await check("changes: git name-status and numstat parsing (renames, binaries)", () => {
  assert.deepEqual(parseNameStatus("M\0a.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0"), [
    { status: "modified", path: "a.txt" }, { status: "renamed", oldPath: "old.txt", path: "new.txt" }, { status: "deleted", path: "gone.txt" },
  ]);
  const stats = parseNumstat("3\t1\ta.txt\0-\t-\tbin.dat\0" + "0\t0\t\0old.txt\0new.txt\0");
  assert.deepEqual(stats.get("a.txt"), { added: 3, removed: 1, binary: false });
  assert.deepEqual(stats.get("bin.dat"), { added: 0, removed: 0, binary: true });
  assert.deepEqual(stats.get("new.txt"), { added: 0, removed: 0, binary: false });
  assert.equal(newFileDiff("a\nb"), "@@ -0,0 +1,2 @@\n+a\n+b");
  assert.equal(newFileDiff(""), "");
});

await check("changes: a real repository's edits, new, deleted, renamed and binary files", async () => {
  const repo = join(temp, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "c.txt"), "gone\n");
  writeFileSync(join(repo, "r.txt"), Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n") + "\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, "sub", "s.txt"), "inside\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
  rmSync(join(repo, "c.txt"));
  git(repo, "mv", "r.txt", "r2.txt");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 9, 9, 9]));
  writeFileSync(join(repo, "n.txt"), "new\nfile\n");
  writeFileSync(join(repo, "ignored.log"), "noise\n");
  writeFileSync(join(repo, "sub", "s.txt"), "inside\nmore\n");

  const result = await listChanges(repo);
  assert.equal(result.repo, true);
  assert.equal(result.truncated, false);
  const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath), ["a.txt", "bin.dat", "c.txt", "n.txt", "r2.txt", "sub/s.txt"], "sorted, ignored files left out");
  assert.equal(byPath["a.txt"].status, "modified");
  assert.deepEqual([byPath["a.txt"].added, byPath["a.txt"].removed], [1, 1]);
  assert.equal(byPath["bin.dat"].binary, true);
  assert.equal(byPath["c.txt"].status, "deleted");
  assert.equal(byPath["n.txt"].status, "new");
  assert.equal(byPath["r2.txt"].status, "renamed");
  assert.equal(byPath["r2.txt"].oldPath, "r.txt");

  const a = await fileDiff(repo, byPath["a.txt"]);
  const model = parseUnifiedDiff(a.diff);
  assert.deepEqual(model.hunks[0].lines.filter((l) => l.type !== "ctx").map((l) => `${l.type}:${l.text}`), ["del:two", "add:TWO"]);
  assert.equal((await fileDiff(repo, byPath["bin.dat"])).binary, true);
  assert.equal((await fileDiff(repo, byPath["n.txt"])).diff, "@@ -0,0 +1,2 @@\n+new\n+file");
  assert.match((await fileDiff(repo, byPath["c.txt"])).diff, /^-gone$/m);
  assert.equal((await fileDiff(repo, byPath["r2.txt"])).diff.includes("rename from r.txt"), true);
  // A file gone since the list was read.
  rmSync(join(repo, "n.txt"));
  assert.equal((await fileDiff(repo, byPath["n.txt"])).gone, true);

  // From a subfolder, only its changes, relative to it (like Pi's edit paths).
  const sub = await listChanges(join(repo, "sub"));
  assert.deepEqual(sub.files.map((f) => f.path), ["s.txt"]);

  // Not a repository; a repository with no commit yet.
  const plain = join(temp, "plain");
  mkdirSync(plain);
  if (!foreignMarkerAbove(plain)) assert.deepEqual(await listChanges(plain), { repo: false, files: [], truncated: false });
  const fresh = join(temp, "fresh");
  mkdirSync(fresh);
  git(fresh, "init", "-q");
  writeFileSync(join(fresh, "x.txt"), "x\n");
  git(fresh, "add", "x.txt");
  const first = await listChanges(fresh);
  assert.deepEqual(first.files.map((f) => [f.path, f.status]), [["x.txt", "added"]]);
  assert.match((await fileDiff(fresh, first.files[0])).diff, /^\+x$/m);
});

await check("drafts (F2): the repository's drafts folder lists newest first, read-only; the Project pane names the three places", () => {
  const drafts = join(temp, "drafts-home", ".coop", "drafts", "acme-sql");
  assert.deepEqual(listDrafts(drafts), [], "no folder yet: nothing, no error");
  assert.deepEqual(listDrafts(""), []);
  mkdirSync(join(drafts, "proposals"), { recursive: true });
  writeFileSync(join(drafts, "vw_Old.sql"), "SELECT 1\n");
  writeFileSync(join(drafts, "proposals", "usp_New.sql"), "SELECT 2\n");
  utimesSync(join(drafts, "vw_Old.sql"), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(join(drafts, "proposals", "usp_New.sql"), new Date(2026, 5, 1), new Date(2026, 5, 1));
  const listed = listDrafts(drafts);
  assert.deepEqual(listed.map((d) => d.path), ["proposals/usp_New.sql", "vw_Old.sql"]);
  assert.equal(listed[0].name, "usp_New.sql");
  // A draft opens as a new file (the same reader the changes list uses).
  return fileDiff(drafts, { status: "new", path: listed[0].path }).then((diff) => {
    assert.equal(diff.diff, "@@ -0,0 +1,1 @@\n+SELECT 2");
    const rows = folderRows({ machine: "C:\\ProgramData\\coop", client: "C:\\Users\\acme\\.coop", repository: "C:\\Work\\acme-coop\\.coop", standards: "C:\\ProgramData\\coop\\standards", standardsTier: "machine", backups: "C:\\Users\\acme\\.coop\\backups\\acme-sql", drafts: "C:\\Users\\acme\\.coop\\drafts\\acme-sql" });
    assert.deepEqual(rows.map((r) => r.label), ["this machine", "this client", "the repository", "standards", "backups", "drafts"]);
    assert.equal(rows[0].holds, "the program, the standards, your name and preferences");
    assert.equal(rows[1].holds, "sessions, memory, backups, drafts");
    assert.equal(rows[2].holds, "the team's project file, client skills and prompts");
    assert.equal(rows[3].holds, "(this machine)");
    assert.equal(folderRows({ standardsTier: "client" })[3].holds, "(this client)");
    // Each folded part of the form says what it holds, from the form's values.
    const empty = { repositories: [], namedTargets: [] };
    assert.deepEqual(Object.keys(sectionStatus).map((key) => sectionStatus[key](empty)), ["not named yet", "none: discovery mode", "off", "off", "none", "none", "defaults", "off", "off"]);
    const filled = { client: "Contoso", organization: "Cooptimize", repositories: [{}, {}], namedTargets: [{}], fabricEnabled: true, fabricWorkspaceName: "Contoso Dev", powerBiEnabled: true, powerBiWorkspaceName: "", sqlTargetKind: "fabric_warehouse", sqlTargetDatabase: "ContosoDW", schemaCompareExclude: "stage", tabularEditorEnabled: true, warehouseManagerEnabled: true };
    assert.deepEqual(Object.keys(sectionStatus).map((key) => sectionStatus[key](filled)), ["Contoso", "2 repositories", "Contoso Dev", "on", "Fabric Warehouse: ContosoDW", "1 set", "customised", "on", "on"]);
    assert.equal(sectionStatus.repositories({ repositories: [{}] }), "1 repository");
    // The renderer shows the group only when there are drafts, and the main process reads a draft from the drafts folder.
    const pane = readFileSync(join(ROOT, "desktop", "renderer", "pane-changes.mjs"), "utf8");
    assert.match(pane, /if \(!state\.drafts\.length\) return \[\];/);
    const main = readFileSync(join(ROOT, "desktop", "main.mjs"), "utf8");
    assert.match(main, /path\.startsWith\("draft:"\)/);
  });
});

await check("changes: a tool call's path finds its file in the list", () => {
  assert.equal(normalizePath("C:\\Work\\Repo\\src\\a.sql", "c:\\work\\repo"), "src/a.sql");
  // The changed-files list keeps a file's name in view and shortens its folders.
  assert.deepEqual(splitPath("warehouse/Tables/fact.OrderLine.sql"), { dir: "warehouse/Tables/", name: "fact.OrderLine.sql" });
  assert.deepEqual(splitPath("C:\\drafts\\a b.sql"), { dir: "C:\\drafts\\", name: "a b.sql" });
  assert.deepEqual(splitPath("README.md"), { dir: "", name: "README.md" });
  assert.deepEqual(splitPath(""), { dir: "", name: "" });
  assert.equal(normalizePath("/w/repo/docs/x.md", "/w/repo/"), "docs/x.md");
  assert.equal(normalizePath("./sql/b.sql", "/w/repo"), "sql/b.sql");
  assert.equal(normalizePath("@sql/b.sql", "/w/repo"), "sql/b.sql");
  assert.equal(normalizePath("/elsewhere/x.md", "/w/repo"), "", "outside the folder: not in the list");
});

await check("changes: the repository picker lists the folder's repository and those one level down", async () => {
  // A folder that holds the client's repositories (devops\\fabric style).
  const holder = join(temp, "holder");
  for (const name of ["alpha", "beta"]) {
    const dir = join(holder, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    writeFileSync(join(dir, "f.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
  }
  mkdirSync(join(holder, "notes"));
  mkdirSync(join(holder, ".hidden", ".git"), { recursive: true });
  if (!foreignMarkerAbove(holder)) {
    assert.deepEqual(changeRepos(holder).map((r) => [r.id, r.label]), [["alpha", "alpha"], ["beta", "beta"]]);
    // No changes anywhere: the first; then the one with changes.
    assert.equal((await defaultChangeRepo(changeRepos(holder))).id, "alpha");
    writeFileSync(join(holder, "beta", "f.txt"), "two\n");
    const beta = await defaultChangeRepo(changeRepos(holder));
    assert.equal(beta.id, "beta");
    assert.deepEqual((await listChanges(beta.dir)).files.map((f) => f.path), ["f.txt"]);
    assert.equal(await defaultChangeRepo([]), null);
  }
  // A repository with a nested one: its own first, and it always wins the default.
  const outer = join(temp, "outer");
  mkdirSync(join(outer, "inner"), { recursive: true });
  git(outer, "init", "-q");
  git(join(outer, "inner"), "init", "-q");
  const repos = changeRepos(outer);
  assert.deepEqual(repos.map((r) => r.id), ["", "inner"]);
  assert.equal(repos[0].label, "outer");
  assert.equal((await defaultChangeRepo(repos)).id, "");

  // A tool card's path picks the repository that holds it.
  const listed = [{ id: "" }, { id: "inner" }, { id: "inner2" }];
  assert.deepEqual(repoForPath(listed, "inner/sql/a.sql"), { id: "inner", path: "sql/a.sql" });
  assert.deepEqual(repoForPath(listed, "inner2/x.md"), { id: "inner2", path: "x.md" });
  assert.deepEqual(repoForPath(listed, "innerx/y.md"), { id: "", path: "innerx/y.md" });
  assert.equal(repoForPath([{ id: "alpha" }], "notes/n.md"), null, "outside every repository: keep the current one");
  assert.equal(repoForPath(listed, ""), null);
});

await check("changes: the picker adds the repositories the project file lists", async () => {
  // A client folder: the open repository holds the project file, which also
  // lists a warehouse repository beside it and one not cloned here.
  const client = join(temp, "client");
  const open = join(client, "fabric");
  const dw = join(client, "fabric-dw");
  for (const dir of [open, dw]) { mkdirSync(dir, { recursive: true }); git(dir, "init", "-q"); }
  mkdirSync(join(open, ".coop"), { recursive: true });
  writeFileSync(join(open, ".coop", "project.yml"), "profile:\n  client: Contoso\nrepositories:\n  fabric:\n    local_path: .\n  fabric-dw:\n    local_path: ../fabric-dw\n  missing:\n    local_path: ../not-cloned\n  later:\n    local_path: TODO\n");
  if (foreignMarkerAbove(client)) return;
  const repos = changeRepos(open);
  assert.deepEqual(repos.map((r) => [r.id, r.label, r.rel]), [["", "fabric", ""], ["project:fabric-dw", "fabric-dw", "../fabric-dw"]], "the open repository once, then the listed one beside it");
  writeFileSync(join(dw, "v.sql"), "select 1\n");
  const dwRepo = repos.find((r) => r.id === "project:fabric-dw");
  assert.deepEqual((await listChanges(dwRepo.dir)).files.map((f) => f.path), ["v.sql"]);
  // A tool card's absolute path beside the folder picks that repository.
  assert.equal(relativePath(join(dw, "v.sql"), open), "../fabric-dw/v.sql");
  assert.equal(relativePath("C:\\work\\client\\fabric-dw\\v.sql", "c:\\work\\client\\fabric"), "../fabric-dw/v.sql");
  assert.equal(relativePath("D:\\other\\x.sql", "C:\\work\\client\\fabric"), "", "another drive");
  assert.equal(relativePath("sql/a.sql", "/w/repo"), "sql/a.sql");
  const listed = repos.map(({ id, label, rel }) => ({ id, label, rel }));
  assert.deepEqual(repoForPath(listed, "../fabric-dw/v.sql"), { id: "project:fabric-dw", path: "v.sql" });
  assert.equal(repoForPath(listed, "../elsewhere/x.sql"), null, "outside every repository: keep the current one");
});

// --- The standards pane ---------------------------------------------------------

await check("standards: resolve-many then status, paths stay in the main process", async () => {
  const calls = [];
  const snapshot = join(temp, "sql-snapshot.md");
  writeFileSync(snapshot, "<!-- coop standards snapshot domain=sql revision=abc -->\n# SQL style\nUse aliases.\n# Naming\nPascalCase.\n");
  const execFileImpl = (file, args, options, callback) => {
    calls.push(args.slice(1));
    const out = args[1] === "resolve-many"
      ? { sql: { state: "canonical", authority_class: "formal_standard", revision: "0123456789abcdef", path: snapshot, articles: [{ id: "a", title: "SQL style", file: "SQL/style.md" }] }, dax: { state: "unavailable", path: null } }
      : { repository: "https://github.com/cooptimize/coop-standards.git", authoritative_branch: "main", freshness: "fresh", last_successful_check_ms: Date.now() - 120_000, last_attempt_ok: true, bundle: { state: "available", revision: "fedcba9876543210" } };
    setImmediate(() => callback(null, JSON.stringify(out), ""));
  };
  const result = await readStandards({ node: process.execPath, repoRoot: ROOT, cwd: temp, env: process.env, execFileImpl });
  assert.deepEqual(calls.map((c) => c[0]), ["resolve-many", "status", "source-systems"]);
  assert.equal(calls[0][1], DOMAINS.join(","));
  assert.ok(DOMAINS.includes("source"), "the D365 source articles have a tab");
  assert.equal(calls[2][1], temp);
  assert.equal(calls[0][2], temp);
  assert.equal(result.domains.length, DOMAINS.length);
  const sql = result.domains.find((d) => d.domain === "sql");
  assert.deepEqual([sql.state, sql.available, sql.revision, sql.articles.length], ["canonical", true, "0123456789ab", 1]);
  assert.equal(result.domains.find((d) => d.domain === "dax").available, false);
  assert.equal(JSON.stringify(result.domains).includes(snapshot), false, "no path crosses to the window");
  assert.equal(result.snapshots.get("sql"), snapshot);
  assert.match(sourceLine(result.source), /^cooptimize\/coop-standards \(main\) · up to date · checked 2 min ago · shipped copy fedcba987654$/);
  const text = await readSnapshot(snapshot);
  assert.equal(text.text.startsWith("# SQL style"), true, "the provenance comment is not an article");
  assert.deepEqual(articleOutline(parseMarkdown(text.text)).map((a) => a.title), ["SQL style", "Naming"]);
  assert.equal(domainView("fabric", undefined).state, "unavailable");
  for (const state of ["canonical", "project_override", "stale_last_known_good", "bundled", "auth_required", "unavailable", "off"]) assert.ok(STATE_LABELS[state], state);
  // A resolver failure is an error the pane shows, not a crash.
  await assert.rejects(readStandards({ node: process.execPath, repoRoot: ROOT, cwd: temp, env: process.env, execFileImpl: (f, a, o, cb) => cb(new Error("x"), "", "registry unreadable\n") }), /registry unreadable/);
});

await check("standards: the D365 source tab lists what a task gets for the project's source systems", async () => {
  const snapshot = join(temp, "source-snapshot.md");
  writeFileSync(snapshot, "<!-- coop standards snapshot for source -->\n# D365 Dataverse Source Tables\nDataverse.\n\n# D365 Exports\n```powershell\n# not an article\n```\n\n# D365 Finance and Operations Source Tables\nF&O.\n");
  const articles = [
    { id: "source_d365_dataverse", title: "D365 Dataverse Source Tables", technology: "d365_dataverse" },
    { id: "source_d365_exports", title: "D365 Exports", technology: "d365" },
    { id: "source_d365_fo", title: "D365 Finance and Operations Source Tables", technology: "d365_fo" },
  ];
  const run = (systems) => readStandards({ node: process.execPath, repoRoot: ROOT, cwd: temp, env: process.env, execFileImpl: (file, args, options, callback) => {
    const out = args[1] === "resolve-many" ? { source: { state: "canonical", authority_class: "formal_standard", revision: "0123456789abcdef", path: snapshot, articles } }
      : args[1] === "source-systems" ? systems : {};
    setImmediate(() => (out === undefined ? callback(new Error("unknown command"), "", "usage: standards-cli.mjs\n") : callback(null, JSON.stringify(out), "")));
  } });
  // No source_systems key: both D365 systems, all three articles, labelled D365.
  let result = await run(["d365_fo", "d365_dataverse"]);
  let source = result.domains.find((d) => d.domain === "source");
  assert.deepEqual([source.label, source.available, source.articles.length], ["D365 source", true, 3]);
  assert.equal(result.keep.has("source"), false, "every article fits: the snapshot reads whole");
  assert.equal(result.snapshots.get("source"), snapshot);
  // F&O only: the Dataverse article is left out of the list and the text.
  result = await run(["d365_fo"]);
  source = result.domains.find((d) => d.domain === "source");
  assert.deepEqual(source.articles.map((a) => a.id), ["source_d365_exports", "source_d365_fo"]);
  const text = await readSnapshot(result.snapshots.get("source"), { titles: result.keep.get("source") });
  assert.deepEqual(articleOutline(parseMarkdown(text.text)).map((a) => a.title), ["D365 Exports", "D365 Finance and Operations Source Tables"]);
  assert.match(text.text, /# not an article/, "a heading in a code fence stays inside its article");
  // source_systems: [] turns the tab off.
  result = await run([]);
  source = result.domains.find((d) => d.domain === "source");
  assert.deepEqual([source.state, source.available, source.articles.length, result.snapshots.has("source")], ["off", false, 0, false]);
  // An older resolver with no source-systems command: shown unfiltered, generic label.
  result = await run(undefined);
  source = result.domains.find((d) => d.domain === "source");
  assert.deepEqual([source.label, source.available, source.articles.length], ["Source systems", true, 3]);
  assert.equal(sourceDomainView({ label: "Source systems", articles }, ["sap"]).label, "Source systems");
  assert.equal(keepArticles("# A\nx\n", ["missing"]), "# A\nx\n", "no match: the whole text, never an empty pane");
});

await check("standards: the team knowledge repositories from status, one note at a time, paths stay in the main process", async () => {
  // Mirrors cooptimize/incremental-bi: layer folders, `title:` front matter, an unlayered guide, a non-Markdown file.
  const clone = join(temp, "knowledge", "incremental-bi");
  mkdirSync(join(clone, "Gold"), { recursive: true });
  mkdirSync(join(clone, ".obsidian"), { recursive: true });
  writeFileSync(join(clone, "AGENTS.md"), "# Writing and editing this wiki\nEditing guide.\n");
  writeFileSync(join(clone, "Gold", "Fact Partition Rebuild.md"), "\uFEFF---\ntitle: \"Fact partition rebuild\"\nlayer: gold\n---\n## Rebuild the partition\nDrop and reload the window.\n");
  writeFileSync(join(clone, "Gold", "notes.txt"), "not a note");
  writeFileSync(join(clone, ".obsidian", "hidden.md"), "# Hidden\n");
  const listing = listNotes(clone);
  assert.deepEqual(listing.notes.map((n) => [n.path, n.title, n.folder]), [["AGENTS.md", "Writing and editing this wiki", ""], ["Gold/Fact Partition Rebuild.md", "Fact partition rebuild", "Gold"]]);
  assert.equal(listing.truncated, false);
  assert.equal(noteLabel(listing.notes[1]), "Gold / Fact partition rebuild");
  const execFileImpl = (file, args, options, callback) => {
    const out = args[1] === "resolve-many"
      ? { sql: { state: "unavailable", path: null } }
      : { repository: "https://github.com/cooptimize/coop-standards.git", authoritative_branch: "main", freshness: "fresh", sources: [
        { id: "cooptimize-formal-standards", authority_class: "formal_standard", state: "available", path: join(temp, "canonical") },
        { id: "cooptimize/incremental-bi", authority_class: "approved_pattern", state: "dirty_preserved", revision: "0123456789abcdef0123", path: clone },
        { id: "cooptimize/coop-team-knowledge", authority_class: "team_knowledge", state: "unavailable", revision: null, path: null },
      ] };
    setImmediate(() => callback(null, JSON.stringify(out), ""));
  };
  const result = await readStandards({ node: process.execPath, repoRoot: ROOT, cwd: temp, env: process.env, execFileImpl });
  assert.deepEqual(result.knowledge.map((k) => [k.id, k.label, k.state, k.available, k.revision, k.notes.length]), [
    ["cooptimize/incremental-bi", "Incremental BI", "dirty_preserved", true, "0123456789ab", 2],
    ["cooptimize/coop-team-knowledge", "Team knowledge", "unavailable", false, "", 0],
  ]);
  assert.equal(JSON.stringify(result.knowledge).includes(temp), false, "no clone path crosses to the window");
  assert.deepEqual([...result.roots.keys()], ["cooptimize/incremental-bi"]);
  const note = await readNote(result.roots.get("cooptimize/incremental-bi"), "Gold/Fact Partition Rebuild.md");
  assert.equal(note.text, "## Rebuild the partition\nDrop and reload the window.\n", "front matter and BOM dropped");
  assert.equal(note.truncated, false);
  await assert.rejects(readNote(clone, "../outside.md"), /not in the knowledge repository/);
  await assert.rejects(readNote(clone, ""), /not in the knowledge repository/);
  await assert.rejects(readNote(clone, join(temp, "canonical", "x.md")), /not in the knowledge repository/);
  // A symlink inside the clone that points outside it reads nothing (both ends resolved, as the docs pages are).
  writeFileSync(join(temp, "outside-note.md"), "secret\n");
  let linked = false;
  try { symlinkSync(join(temp, "outside-note.md"), join(clone, "Gold", "link.md")); linked = true; } catch { /* no symlinks here */ }
  if (linked) await assert.rejects(readNote(clone, "Gold/link.md"), /not in the knowledge repository/);
  await assert.rejects(readNote(clone, "Gold/missing.md"), /not in the knowledge repository/);
  assert.equal(knowledgeView({ id: "cooptimize/other-kb", authority_class: "team_knowledge", state: "available", path: clone }, listing).label, "other-kb");
  assert.ok(isKnowledgeId("knowledge:cooptimize/incremental-bi") && !isKnowledgeId("sql"));
  for (const id of Object.keys(KNOWLEDGE_LABELS)) assert.ok(KNOWLEDGE_LABELS[id], id);
  for (const state of ["available", "dirty_preserved", "unavailable"]) assert.ok(KNOWLEDGE_STATE_LABELS[state], state);
  // No status at all (an older resolver): no knowledge row, no crash.
  const bare = await readStandards({ node: process.execPath, repoRoot: ROOT, cwd: temp, env: process.env, execFileImpl: (f, a, o, cb) => setImmediate(() => cb(a[1] === "status" ? new Error("x") : null, a[1] === "status" ? "" : "{}", "")) });
  assert.deepEqual(bare.knowledge, []);
});

// --- The project form -------------------------------------------------------------

const ORIGINAL = `# keep this client comment
profile:
  organization: 'Cooptimize'
  client: 'Old Client'
  timezone: 'America/Chicago'
  default_branch: 'main'
  custom_profile_key: 'keep-me'
agent_allowed_to_commit:
  - 'docs/**'
repositories:
  analytics:
    description: 'Warehouse'
    role: 'sql'
    local_path: '.'
    remote_name: 'origin'
    default_branch: 'main'
    agent_allowed_to_commit:
      - 'special-docs/**'
    agent_never_commit: ['secrets/**', 'bin/**']
estate:
  live_discovery:
    enabled: true
mcp:
  fabric:
    allowed_default_actions:
      - 'list_workspaces'
    requires_approval_actions:
      - 'run_query'
custom_section:
  future_setting: 42
`;

function projectFixture(name, text) {
  const root = join(mkdtempSync(join(temp, `${name}-`)), "work");
  mkdirSync(join(root, ".git"), { recursive: true });
  if (text !== undefined) {
    mkdirSync(join(root, ".coop"));
    writeFileSync(join(root, ".coop", "project.yml"), text);
  }
  return root;
}

// powerBiWorkspaceId is the Fabric workspace id: the terminal wizard proposes it
// for a same-named Power BI workspace (a Fabric workspace is one), and a blank
// terminal answer means "keep the proposal", so the form answers the same id.
const ANSWERS = {
  client: "Contoso",
  analytics: { description: "Warehouse SQL", role: "mixed", localPath: ".", remoteName: "origin", defaultBranch: "main" },
  added: { name: "Reports Repo", description: "Power BI reports", role: "powerbi", localPath: "../reports", remoteName: "origin", defaultBranch: "release" },
  fabric: { tenantId: "11111111-1111-1111-1111-111111111111", fabricWorkspaceName: "Contoso WS", fabricWorkspaceId: "22222222-2222-2222-2222-222222222222", sqlEndpointItemType: "Warehouse", sqlEndpointItemName: "ContosoDW", sqlEndpointItemId: "33333333-3333-3333-3333-333333333333", sqlEndpointPropertiesId: "", powerBiWorkspaceName: "Contoso WS", powerBiWorkspaceId: "22222222-2222-2222-2222-222222222222", fabricLayout: "warehouse", tableMappingRule: "prefix", tableMappingSchema: "dbo", tableMappingPrefix: "v_" },
  target: { sqlTargetKind: "azure_sql", sqlTargetServer: "Contoso-Dev.Database.Windows.Net", sqlTargetDatabase: "ContosoDW", sqlTargetProdServer: "Contoso-Prod.Database.Windows.Net", sqlTargetProdDatabase: "ContosoDW", sqlTargetTestDatabase: "", schemaCompareExclude: "stage, audit", schemaCompareRebuild: "dim, fact", schemaCompareDestructive: "commented" },
  te: { tabularEditorPath: "te", bpaRulesPath: "rules/bpa.json" },
  wm: { warehouseManagerPlatform: "fabric", warehouseManagerBronzeDatabase: "Bronze LH", warehouseManagerBronzeRawSchema: "d365", warehouseManagerViewSchemas: "d365_fo=d365fo", warehouseManagerSilverDatabase: "ContosoDW", warehouseManagerSilverSchema: "", warehouseManagerCreatePipeline: "PL Create Silver Table", warehouseManagerLoadPipeline: "PL Load Silver Table", warehouseManagerNeverRun: "PL Load All", warehouseManagerNotes: "", warehouseManagerDevWorkspace: "Contoso WS", warehouseManagerTestWorkspace: "" },
};

// The terminal wizard, answered with ANSWERS through fake Pi dialogs.
function wizardCtx(root, { fresh = false, localSource = true } = {}) {
  const repoFor = (label) => (label.startsWith("analytics:") ? ANSWERS.analytics : fresh ? null : ANSWERS.added);
  let addCount = 0;
  return {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      notify: () => {},
      input: async (label, def) => {
        if (label.startsWith("Client / engagement")) return ANSWERS.client;
        if (label.startsWith("Repository short name")) return fresh ? def : ANSWERS.added.name;
        const repo = repoFor(label);
        if (repo && !fresh) {
          if (label.endsWith(": description  ·  Enter = " + (def || "(blank)"))) return repo.description;
          if (/: Git remote name/.test(label)) return repo.remoteName;
          if (/: default branch/.test(label)) return repo.defaultBranch;
          if (/: choose its local folder$/.test(label)) return repo.localPath;
        }
        for (const [key, value] of Object.entries({ ...ANSWERS.fabric, ...ANSWERS.target, ...ANSWERS.te, ...ANSWERS.wm })) {
          const prompts = {
            tenantId: "Azure tenant ID", fabricWorkspaceName: "Default Fabric workspace name", fabricWorkspaceId: "Default Fabric workspace ID",
            sqlEndpointItemType: "Default SQL endpoint item type", sqlEndpointItemName: "Default SQL endpoint item name", sqlEndpointItemId: "Default SQL endpoint item ID",
            sqlEndpointPropertiesId: "Lakehouse sqlEndpointProperties.id", powerBiWorkspaceName: "Default Power BI workspace name", powerBiWorkspaceId: "Default Power BI workspace ID",
            fabricLayout: "Fabric layout", tableMappingRule: "Semantic-model table to SQL object rule", tableMappingSchema: "Default schema for a model table", tableMappingPrefix: "View prefix the model table names drop",
            sqlTargetKind: "Dev SQL target kind", sqlTargetServer: "Dev SQL server host", sqlTargetDatabase: "Dev database name",
            sqlTargetProdServer: "Prod SQL server host", sqlTargetProdDatabase: "Prod database name", sqlTargetTestDatabase: "Test database name",
            schemaCompareExclude: "Schema compare: schemas never compared", schemaCompareRebuild: "Schema compare: schemas whose changed tables", schemaCompareDestructive: "Schema compare: destructive statements",
            tabularEditorPath: "Tabular Editor CLI command or path", bpaRulesPath: "BPA rules file path",
            warehouseManagerPlatform: "Schema Manager platform", warehouseManagerBronzeDatabase: "Bronze database", warehouseManagerBronzeRawSchema: "Bronze raw schema", warehouseManagerViewSchemas: "Bronze view schema per source system",
            warehouseManagerSilverDatabase: "Silver database", warehouseManagerSilverSchema: "Silver schema", warehouseManagerCreatePipeline: "Pipeline that regenerates ONE", warehouseManagerLoadPipeline: "Pipeline that fully reloads ONE",
            warehouseManagerNeverRun: "Parent pipelines that process every table", warehouseManagerNotes: "How this client's Schema Manager differs", warehouseManagerDevWorkspace: "Dev Fabric workspace where the pipelines run", warehouseManagerTestWorkspace: "Test Fabric workspace where the pipelines run",
          };
          if (!fresh && label.startsWith(prompts[key])) return value;
        }
        return def;
      },
      confirm: async (title) => {
        if (title === "Local source folders") return localSource;
        if (title.startsWith("Repository: ")) return !fresh;
        if (title === "Repositories") return !fresh && addCount++ === 0;
        if (title === "Microsoft Fabric") return !fresh;
        if (title === "Power BI") return !fresh;
        if (title === "Tabular Editor") return !fresh;
        if (title === "Schema Manager") return !fresh;
        return true; // the final "Create/Update .coop/project.yml?"
      },
      select: async (label, options) => {
        if (/what kind of repository is this\?$/.test(label)) {
          const repo = label.startsWith("analytics:") ? ANSWERS.analytics : fresh ? { role: "generic" } : ANSWERS.added;
          return options.find((o) => o === ROLE_LABELS[repo.role]);
        }
        if (/choose its local folder/.test(label)) {
          const repo = label.startsWith("analytics:") ? ANSWERS.analytics : fresh ? { localPath: "." } : ANSWERS.added;
          if (repo.localPath === ".") return options.find((o) => o.startsWith("✓ Use this folder:"));
          return options.find((o) => o.startsWith("⌨"));
        }
        if (label === "What do you want to change?") return options[options.length - 1]; // everything
        // The fixed-choice questions are picks: the row that stands for the answer.
        const picks = [
          ["Default SQL endpoint:", { Warehouse: "Warehouse", Lakehouse: "Lakehouse" }[ANSWERS.fabric.sqlEndpointItemType]],
          ["Fabric layout:", { warehouse: "Warehouse", lakehouse: "Lakehouse", sql_database: "SQL database", mixed: "Mixed" }[ANSWERS.fabric.fabricLayout]],
          ["How does a semantic-model table map", options.find((o) => o.toLowerCase().startsWith(String(ANSWERS.fabric.tableMappingRule || "same_name").replace("_", " ")))],
          ["Dev SQL target:", { azure_sql: "Azure SQL" }[ANSWERS.target.sqlTargetKind]],
          ["Schema compare:", { runnable: "Runnable", commented: "Commented out" }[ANSWERS.target.schemaCompareDestructive]],
          ["Schema Manager:", { fabric: "Fabric pipelines", adf: "Azure Data Factory" }[ANSWERS.wm.warehouseManagerPlatform]],
        ];
        const pick = fresh ? null : picks.find(([prefix]) => label.startsWith(prefix));
        if (pick) { assert.ok(options.includes(pick[1]), `${label}: ${pick[1]} is a row of ${options.join(" | ")}`); return pick[1]; }
        return options[0];
      },
    },
  };
}

const formAnswers = (data) => {
  const values = initialValues(data);
  values.client = ANSWERS.client;
  values.repositories[0] = { ...values.repositories[0], ...ANSWERS.analytics };
  values.repositories.push({ ...ANSWERS.added, isNew: true });
  Object.assign(values, ANSWERS.fabric, ANSWERS.target, ANSWERS.te, ANSWERS.wm, { fabricEnabled: true, powerBiEnabled: true, tabularEditorEnabled: true, warehouseManagerEnabled: true });
  return formInput(values);
};

await check("project form: loads the wizard's fields; dropped fields never reach the window", () => {
  const root = projectFixture("load", ORIGINAL);
  const data = loadProject(root, { env: process.env });
  assert.equal(data.exists, true);
  assert.equal(data.path, join(root, ".coop", "project.yml"));
  assert.equal(data.settings.client, "Old Client");
  assert.deepEqual(data.settings.repositories.map((r) => r.name), ["analytics"]);
  assert.deepEqual(data.commitLists.top, ["docs/**"]);
  assert.deepEqual(data.commitLists.repositories.analytics, { allowed: ["special-docs/**"], never: ["secrets/**", "bin/**"] });
  assert.equal(data.profileMissing, false);
  assert.match(data.locationNote, /A contract already covers this folder/);
  const fresh = loadProject(projectFixture("fresh-note"), { env: process.env });
  assert.deepEqual([fresh.exists, fresh.path], [false, join(fresh.root, ".coop", "project.yml")]);
  assert.match(fresh.locationNote, /Coop proposes this repository's root/);
  assert.deepEqual(data.guardrailFields.sort(), ["client", "commitLists", "repositories.localPath", "sqlTargetDatabase", "sqlTargetKind", "sqlTargetProdDatabase", "sqlTargetProdEndpointId", "sqlTargetProdItemId", "sqlTargetProdServer", "sqlTargetProdWorkspaceId", "sqlTargetServer", "tenantId"]);
  const shown = JSON.stringify(data);
  for (const dropped of ["live_discovery", "allowed_default_actions", "requires_approval_actions", "list_workspaces", "run_query", "future_setting", "custom_profile_key"]) {
    assert.equal(shown.includes(dropped), false, `${dropped} reaches the window`);
  }
  const input = formInput(initialValues(data));
  assert.deepEqual(Object.keys(input).sort(), ["bpaRulesPath", "client", "defaultBranch", "fabricEnabled", "fabricLayout", "fabricWorkspaceId", "fabricWorkspaceName", "namedTargets", "organization", "powerBiEnabled", "powerBiWorkspaceId", "powerBiWorkspaceName", "profileName", "repositories", "schemaCompareDestructive", "schemaCompareExclude", "schemaCompareRebuild", "sqlEndpointItemId", "sqlEndpointItemName", "sqlEndpointItemType", "sqlEndpointPropertiesId", "sqlTargetDatabase", "sqlTargetKind", "sqlTargetProdDatabase", "sqlTargetProdEndpointId", "sqlTargetProdItemId", "sqlTargetProdServer", "sqlTargetProdWorkspaceId", "sqlTargetServer", "sqlTargetTestDatabase", "sqlTargetTestEndpointId", "sqlTargetTestItemId", "sqlTargetTestServer", "sqlTargetTestWorkspaceId", "tableMappingPrefix", "tableMappingRule", "tableMappingSchema", "tabularEditorEnabled", "tabularEditorPath", "tenantId", "timezone",
    "warehouseManagerBronzeDatabase", "warehouseManagerBronzeRawSchema", "warehouseManagerCreatePipeline", "warehouseManagerDevDataFactory", "warehouseManagerDevResourceGroup", "warehouseManagerDevSubscriptionId", "warehouseManagerDevWorkspace", "warehouseManagerEnabled", "warehouseManagerLoadPipeline", "warehouseManagerNeverRun", "warehouseManagerNotes", "warehouseManagerPlatform", "warehouseManagerSilverDatabase", "warehouseManagerSilverSchema", "warehouseManagerTestDataFactory", "warehouseManagerTestResourceGroup", "warehouseManagerTestSubscriptionId", "warehouseManagerTestWorkspace", "warehouseManagerViewSchemas"].sort());
  assert.equal(platformHint("azure_sql"), "This machine is set up as an Azure SQL client, so No is the usual answer.");
  assert.equal(platformHint(""), "");
});

await check("project form: the same answers write the same file as /setup-project (existing contract)", async () => {
  const viaWizard = projectFixture("wizard", ORIGINAL);
  const viaForm = projectFixture("form", ORIGINAL);
  if (foreignMarkerAbove(dirname(viaWizard))) return { skip: `foreign marker above ${temp}` };
  assert.equal(await tools.runProjectWizard({}, wizardCtx(viaWizard)), true);
  const expected = readFileSync(join(viaWizard, ".coop", "project.yml"), "utf8");

  const data = loadProject(viaForm, { env: process.env });
  const input = formAnswers(data);
  const preview = previewProject(viaForm, input, { env: process.env });
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.changed, true);
  assert.equal(preview.mode, "connected");
  assert.equal(readFileSync(join(viaForm, ".coop", "project.yml"), "utf8"), ORIGINAL, "a preview writes nothing");
  const saved = saveProject(viaForm, input, preview.token, { env: process.env });
  assert.equal(saved.created, false);
  // F2: the old file is backed up in this client's backups folder, never beside the project file.
  const { backupDirFor } = await import("../lib/paths.mjs");
  assert.equal(dirname(dirname(saved.backup)), backupDirFor(join(viaForm, ".coop", "project.yml")), "backups go to <profile dir>/backups/<repository>");
  assert.equal(dirname(dirname(saved.backup)), join(coopDir, ".coop", "backups", "analytics"), "the repository is named by the project file's repositories key");
  assert.match(basename(saved.backup), /^project\.yml\.\d{8}_\d{6}\.bak$/);
  assert.equal(existsSync(join(viaForm, ".coop", "project.yml.bak")), false, "nothing is written inside the repository");
  assert.equal(readFileSync(saved.backup, "utf8"), ORIGINAL, "the old file is backed up");
  const written = readFileSync(join(viaForm, ".coop", "project.yml"), "utf8");
  assert.equal(written, expected, "the form and /setup-project write the same contract");

  // What the guardrails read, and what neither owns.
  assert.equal(projectYamlScalar(written, ["profile", "client"]), "Contoso");
  assert.equal(projectYamlScalar(written, ["repositories", "Reports-Repo", "local_path"]), "../reports");
  assert.equal(projectYamlScalar(written, ["sql_targets", "dev", "server"]), "contoso-dev.database.windows.net");
  assert.equal(projectYamlScalar(written, ["sql_targets", "prod", "server"]), "contoso-prod.database.windows.net", "A1: the prod entry is written by both paths");
  assert.equal(projectYamlScalar(written, ["sql_targets", "prod", "database"]), "ContosoDW");
  assert.equal(projectYamlScalar(written, ["sql_targets", "test", "database"]), "", "a blank test answer writes no test entry");
  assert.match(written, /^schema_compare:\n  exclude_schemas: \[stage, audit\]\n  rebuild_tables_in: \[dim, fact\]\n  destructive: 'commented'/m);
  assert.equal(projectYamlScalar(written, ["fabric", "layout"]), "warehouse");
  assert.equal(projectYamlScalar(written, ["power_bi", "table_mapping", "rule"]), "prefix");
  assert.equal(projectYamlScalar(written, ["power_bi", "table_mapping", "view_prefix"]), "v_");
  assert.deepEqual(data.mappingOverrides, {});
  assert.deepEqual(data.layouts, ["warehouse", "lakehouse", "sql_database", "mixed"]);
  for (const kept of ["# keep this client comment", "custom_profile_key: 'keep-me'", "- 'special-docs/**'", "agent_never_commit: ['secrets/**', 'bin/**']", "live_discovery:", "allowed_default_actions:", "future_setting: 42"]) {
    assert.ok(written.includes(kept), `unowned text kept: ${kept}`);
  }
  // The review diff is exactly the change.
  const model = parseUnifiedDiff(preview.diff);
  assert.ok(model.hunks.flatMap((h) => h.lines).some((l) => l.type === "add" && l.text.includes("Contoso")));
});

await check("project form: saving a Power BI-only project keeps Fabric off (#499)", async () => {
  const lib = await import("../lib/project-contract.mjs");
  const text = lib.renderProjectWizardSettings({
    ...lib.parseProjectWizardSettings("", "/synthetic/analytics"),
    fabricEnabled: false, powerBiEnabled: true, powerBiWorkspaceName: "Demo Dev",
    powerBiWorkspaceId: "11111111-1111-1111-1111-111111111111",
    sqlTargetKind: "azure_sql", sqlTargetServer: "demo.database.windows.net", sqlTargetDatabase: "Demo",
    tableMappingRule: "same_name",
  });
  const root = projectFixture("pbi-only", text);
  const data = loadProject(root, { env: process.env });
  const values = initialValues(data);
  assert.equal(values.fabricEnabled, false, "the pane opens with Fabric off");
  assert.equal(values.powerBiEnabled, true);
  values.timezone = "UTC";
  const input = formInput(values);
  const preview = previewProject(root, input, { env: process.env });
  assert.deepEqual(preview.problems, []);
  saveProject(root, input, preview.token, { env: process.env });
  const written = readFileSync(join(root, ".coop", "project.yml"), "utf8");
  assert.doesNotMatch(written, /^fabric:/m, "no fabric: block appears");
  assert.equal(projectYamlScalar(written, ["mcp", "fabric_sqlendpoint", "enabled"]), "false");
  assert.equal(projectYamlScalar(written, ["tools", "fabric_cicd", "enabled"]), "false");
  assert.equal(projectYamlScalar(written, ["tools", "fabric_cli", "enabled"]), "true", "fab stays on for Power BI");
  assert.equal(loadProject(root, { env: process.env }).settings.fabricEnabled, false);
});

await check("project form: named target sets and the destructive setting round-trip through the pane", () => {
  const root = projectFixture("named", ORIGINAL);
  const data = loadProject(root, { env: process.env });
  assert.deepEqual(data.namedEnvironments, ["dev", "test", "prod"]);
  assert.deepEqual(data.destructiveChoices, ["runnable", "commented"]);
  assert.deepEqual(data.settings.namedTargets, []);
  const values = initialValues(data);
  Object.assign(values, ANSWERS.target, { schemaCompareDestructive: "commented" });
  values.namedTargets.push({ name: "lakehouse", kind: "fabric_lakehouse", isNew: true,
    dev: { database: "LH", server: "", workspaceId: "44444444-4444-4444-4444-444444444444", itemId: "55555555-5555-5555-5555-555555555555", endpointId: "66666666-6666-6666-6666-666666666666" },
    test: { database: "", server: "", workspaceId: "", itemId: "", endpointId: "" },
    prod: { database: "LH", server: "", workspaceId: "44444444-4444-4444-4444-444444444444", itemId: "77777777-7777-7777-7777-777777777777", endpointId: "88888888-8888-8888-8888-888888888888" } });
  const input = formInput(values);
  assert.deepEqual(Object.keys(input.namedTargets[0]).sort(), ["dev", "kind", "name", "prod", "test"]);
  const preview = previewProject(root, input, { env: process.env });
  assert.deepEqual(preview.problems, []);
  const saved = saveProject(root, input, preview.token, { env: process.env });
  const written = readFileSync(join(root, ".coop", "project.yml"), "utf8");
  assert.equal(projectYamlScalar(written, ["sql_targets", "named", "lakehouse", "dev", "kind"]), "fabric_lakehouse");
  assert.equal(projectYamlScalar(written, ["sql_targets", "named", "lakehouse", "dev", "sql_endpoint_id"]), "66666666-6666-6666-6666-666666666666");
  assert.equal(projectYamlScalar(written, ["sql_targets", "named", "lakehouse", "prod", "item_id"]), "77777777-7777-7777-7777-777777777777");
  assert.equal(projectYamlScalar(written, ["sql_targets", "named", "lakehouse", "test", "kind"]), "", "a blank environment is not written");
  assert.equal(projectYamlScalar(written, ["schema_compare", "destructive"]), "commented");
  assert.ok(saved.backup);
  // Reloading shows the set, not new, with its environments; a half entry is a problem.
  const again = loadProject(root, { env: process.env });
  assert.equal(again.settings.namedTargets.length, 1);
  assert.equal(again.settings.namedTargets[0].prod.database, "LH");
  assert.equal(initialValues(again).namedTargets[0].isNew, false);
  const bad = formInput(Object.assign(initialValues(again), ANSWERS.target));
  bad.namedTargets.push({ name: "Bad Name", kind: "azure_sql", dev: { database: "D", server: "", workspaceId: "", itemId: "", endpointId: "" }, test: {}, prod: {} });
  const problems = previewProject(root, bad, { env: process.env }).problems.map((p) => p.field);
  assert.deepEqual(problems, ["namedTargets.1.name", "namedTargets.1.dev.database"]);
});

await check("project form: a new contract and discovery mode match /setup-project", async () => {
  for (const localSource of [true, false]) {
    const viaWizard = projectFixture(`new-wizard-${localSource}`);
    const viaForm = projectFixture(`new-form-${localSource}`);
    if (foreignMarkerAbove(dirname(viaWizard))) return { skip: `foreign marker above ${temp}` };
    assert.equal(await tools.runProjectWizard({}, wizardCtx(viaWizard, { fresh: true, localSource })), true);
    const expected = readFileSync(join(viaWizard, ".coop", "project.yml"), "utf8");
    const data = loadProject(viaForm, { env: process.env });
    assert.equal(data.exists, false);
    assert.deepEqual(data.settings.repositories.map((r) => [r.name, r.isNew]), [["work", true]]);
    const values = initialValues(data);
    values.client = ANSWERS.client;
    if (!localSource) values.repositories = [];
    const input = formInput(values);
    const preview = previewProject(viaForm, input, { env: process.env });
    assert.deepEqual(preview.problems, []);
    assert.equal(preview.exists, false);
    assert.equal(preview.mode, localSource ? "partial" : "discovery");
    const saved = saveProject(viaForm, input, preview.token, { env: process.env });
    assert.deepEqual([saved.created, saved.backup], [true, null]);
    assert.match(saved.next, /^Share \.coop\/project\.yml with the team/);
    assert.equal(readFileSync(join(viaForm, ".coop", "project.yml"), "utf8"), expected, `new contract, local source ${localSource}`);
  }
});

await check("project form: the wizard's checks, a stale preview and repositories that can't be dropped", () => {
  const root = projectFixture("checks", ORIGINAL);
  const data = loadProject(root, { env: process.env });
  const base = formInput(initialValues(data));
  const problems = (overrides) => previewProject(root, { ...base, ...overrides }, { env: process.env }).problems.map((p) => p.field);
  assert.deepEqual(problems({ fabricEnabled: true, fabricWorkspaceId: "NOT-A-UUID" }), ["fabricWorkspaceId"]);
  assert.deepEqual(problems({ fabricEnabled: true, sqlEndpointItemType: "warehouse" }), ["sqlEndpointItemType"]);
  assert.deepEqual(problems({ fabricEnabled: true, sqlEndpointItemType: "Lakehouse" }), ["sqlEndpointPropertiesId"]);
  assert.deepEqual(problems({ sqlTargetKind: "oracle" }), ["sqlTargetKind"]);
  assert.deepEqual(problems({ sqlTargetKind: "azure_sql", sqlTargetServer: "x.database.windows.net,1433" }), ["sqlTargetServer"]);
  assert.deepEqual(problems({ sqlTargetKind: "fabric_warehouse", sqlTargetServer: "ignored for a discovered kind,1433" }), []);
  assert.deepEqual(problems({ repositories: [...base.repositories, { name: "analytics", description: "dup" }] }), ["repositories.1.name"]);
  // Fabric off: its fields are not taken, so a bad ID there is no problem.
  assert.deepEqual(problems({ fabricEnabled: false, fabricWorkspaceId: "NOT-A-UUID" }), []);
  // Existing repositories stay even when the window leaves them out.
  const settings = settingsFromForm({ repositories: [] }, data.settings, ["analytics"]);
  assert.deepEqual(settings.repositories.map((r) => r.name), ["analytics"]);
  // Hostile input: unknown keys and roles are ignored, control characters removed.
  const odd = settingsFromForm({ client: "Con\u0007toso\u009b", role: "admin", repositories: [{ name: "analytics", role: "root" }], live_discovery: true }, data.settings, ["analytics"]);
  assert.equal(odd.client, "Contoso");
  assert.equal(odd.repositories[0].role, "sql");
  assert.equal("live_discovery" in odd, false);
  // A file changed on disk after the preview is not overwritten.
  const preview = previewProject(root, { ...base, client: "Fresh" }, { env: process.env });
  writeFileSync(join(root, ".coop", "project.yml"), `${ORIGINAL}# edited elsewhere\n`);
  assert.throws(() => saveProject(root, { ...base, client: "Fresh" }, preview.token, { env: process.env }), /changed on disk/);
  assert.match(readFileSync(join(root, ".coop", "project.yml"), "utf8"), /# edited elsewhere/);
});

await check("project form: the missing profile name is saved like /setup-project saves it", () => {
  const profileHome = join(temp, "no-profile");
  const env = { ...process.env, COOP_DIR: profileHome };
  const root = projectFixture("profile", ORIGINAL);
  assert.equal(loadProject(root, { env }).profileMissing, true);
  const base = formInput(initialValues(loadProject(root, { env })));
  assert.deepEqual(previewProject(root, { ...base, profileName: "A<b" }, { env }).problems.map((p) => p.field), ["profileName"]);
  const preview = previewProject(root, { ...base, profileName: "  Avery  " }, { env });
  const saved = saveProject(root, { ...base, profileName: "  Avery  " }, preview.token, { env });
  assert.equal(saved.profileSaved, "Avery");
  assert.equal(JSON.parse(readFileSync(join(profileHome, ".coop", "user.json"), "utf8")).name, "Avery");
  assert.equal(readFileSync(join(root, ".coop", "project.yml"), "utf8").includes("Avery"), false, "the name never goes into project.yml");
});

// --- The docs setup form ---------------------------------------------------------

await check("docs form: answers become exactly what /setup-docs's dialogs send", () => {
  const { normalizeAnswer, AnswerError } = docs;
  const text = { id: "t", kind: "text", default: "demo" };
  assert.equal(normalizeAnswer(text, "  My Project \u0007 "), "My Project");
  assert.equal(normalizeAnswer(text, "   "), "demo");
  assert.throws(() => normalizeAnswer(text, 5), AnswerError);
  const path = { kind: "path", default: "../sql" };
  assert.equal(normalizeAnswer(path, " ../warehouse "), "../warehouse");
  assert.equal(normalizeAnswer(path, ""), "../sql");
  assert.equal(normalizeAnswer({ kind: "confirm" }, false), false);
  assert.throws(() => normalizeAnswer({ kind: "confirm" }, "yes"), AnswerError);
  const select = { kind: "select", choices: [{ label: "A", value: "a" }, { label: "B", value: "b" }] };
  assert.equal(normalizeAnswer(select, "b"), "b");
  assert.throws(() => normalizeAnswer(select, "c"), AnswerError);
  const box = { kind: "checkbox", choices: [{ value: "a" }, { value: "b" }, { value: "c" }] };
  assert.deepEqual(normalizeAnswer(box, ["c", "a", "c"]), ["a", "c"], "the wizard's order, once each");
  assert.deepEqual(normalizeAnswer(box, []), []);
  assert.throws(() => normalizeAnswer(box, ["z"]), AnswerError);
  // What the form draws: only known kinds and bounded text.
  const shown = docs.formPrompt({ id: "x", kind: "evil", message: "m".repeat(9000), default: { a: 1 }, choices: [{ label: 1, value: "v" }] });
  assert.deepEqual([shown.kind, shown.message.length, shown.default, shown.choices[0].label], ["text", 4000, null, ""]);
  assert.equal(answerLabel({ kind: "confirm" }, true), "Yes");
  assert.equal(answerLabel(select, "b"), "B");
  assert.equal(answerLabel({ ...box, choices: [{ label: "A", value: "a" }, { label: "C", value: "c" }] }, ["a", "c"]), "A, C");
  assert.equal(docs.pickedPathAnswer("/w/proj", "/w/sql", "../x"), "../sql");
  assert.equal(docs.pickedPathAnswer("/w/proj", "/w/proj", ""), ".");
  assert.equal(docs.pickedPathAnswer("/w/proj", "/w/sql", "/abs/default"), "/w/sql");
});

// A fake coop-data-doc: `setup --help`, the JSONL wizard (it saves its answers
// as the config) and `build` (writes one page).
const FAKE = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (args.includes("--help")) { console.log("usage: coop-data-doc setup [--transport {jsonl}]"); process.exit(0); }
if (args[0] === "build") {
  if (process.env.COOP_FIXTURE_BUILD === "fail") { console.error("Repo 'sql' path does not exist"); process.exit(2); }
  console.log("Scanning 2 repos"); console.error("warning: one view has no lineage");
  fs.mkdirSync("data-docs/table", { recursive: true });
  fs.writeFileSync("data-docs/index.md", "# Overview\\n\\n- [Sales](table/sales.md)\\n");
  fs.writeFileSync("data-docs/table/sales.md", "---\\nid: 'dbo.Sales'\\n---\\n# dbo.Sales\\n\\n[Back](../index.md)\\n");
  fs.writeFileSync("data-docs/manifest.json", "{}");
  console.log("Wrote 2 pages"); process.exit(0);
}
const it = require("node:readline").createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const answers = {};
const ask = async (o) => { line({ type: "prompt", choices: [], ...o }); const r = await it.next(); const a = JSON.parse(r.value); if (a.cancelled) { line({ type: "cancelled", message: "Setup cancelled." }); process.exit(130); } answers[o.id] = a.answer; };
(async () => {
  line({ type: "hello", protocol_version: "1.1" });
  await ask({ id: "project_name", kind: "text", message: "Project name:", default: "demo" });
  await ask({ id: "sql_path", kind: "path", message: "SQL repo path - the folder with your SQL:", default: "../sql-missing" });
  await ask({ id: "local_sources", kind: "select", message: "Sources", default: "sql", choices: [{ label: "SQL only", value: "sql" }, { label: "SQL and Power BI", value: "both" }] });
  await ask({ id: "folders", kind: "checkbox", message: "Folders", choices: [{ label: "A", value: "a" }, { label: "B", value: "b", checked: true }, { label: "C", value: "c" }] });
  await ask({ id: "tests", kind: "confirm", message: "Include tests?", default: false });
  fs.writeFileSync("coop-data-doc.yml", "# answers\\n" + JSON.stringify(answers, null, 2) + "\\n");
  line({ type: "notice", message: "Saved coop-data-doc.yml" });
  line({ type: "complete", message: "Setup complete." });
  process.exit(0);
})();
`;

const fakeDir = join(temp, "fake-bin");
mkdirSync(fakeDir);
const fakeExe = join(fakeDir, "coop-data-doc");
writeFileSync(fakeExe, FAKE);
chmodSync(fakeExe, 0o755);
const canExec = process.platform !== "win32" && !spawnSync(fakeExe, ["--help"], { encoding: "utf8" }).error;
const fakeEnv = { ...process.env, PATH: `${fakeDir}${delimiter}${process.env.PATH}` };

function docsRun(cwd, answer) {
  return new Promise((resolveRun) => {
    const events = [];
    const run = new docs.DocsSetupRun({
      cwd,
      env: fakeEnv,
      send: (event) => {
        events.push(event);
        if (event.type === "prompt") setImmediate(() => answer(run, event.prompt));
        if (event.type === "done") resolveRun({ events, done: event });
      },
    });
    run.start();
  });
}

const FORM_ANSWERS = { project_name: "  Demo Project ", sql_path: " ../sql-repo ", local_sources: "both", folders: ["c", "a"], tests: true };

await check("docs form: the same answers write the same coop-data-doc.yml as /setup-docs", async () => {
  if (!canExec) return { skip: "the fake coop-data-doc needs direct exec (not on Windows or in this sandbox)" };
  const viaDialogs = join(mkdtempSync(join(temp, "docs-dialogs-")), "proj");
  const viaForm = join(mkdtempSync(join(temp, "docs-form-")), "proj");
  mkdirSync(viaDialogs);
  mkdirSync(viaForm);
  // /setup-docs: Pi dialogs (renderPrompt, the folder browser and the checkbox loop).
  const savedPath = process.env.PATH;
  process.env.PATH = fakeEnv.PATH;
  try {
    const plan = ["☐ A", "☑ B", "☐ C", "✓ Done"];
    const ctx = { cwd: viaDialogs, hasUI: true, ui: {
      notify: () => {},
      input: async (label) => (label.startsWith("Project name:") ? FORM_ANSWERS.project_name : label.startsWith("SQL repo path") ? FORM_ANSWERS.sql_path : ""),
      select: async (label, options) => {
        if (label === "Sources") return "SQL and Power BI";
        if (label === "Folders") return plan.shift();
        if (label === "Include tests?") return "Yes";
        return options.find((o) => o.startsWith("⌨"));
      },
      confirm: async () => true,
    } };
    assert.equal(await tools.runJsonlSetup({}, ctx), true);
  } finally {
    process.env.PATH = savedPath;
  }
  const expected = readFileSync(join(viaDialogs, "coop-data-doc.yml"), "utf8");
  assert.deepEqual(JSON.parse(expected.replace(/^# answers\n/, "")), { project_name: "Demo Project", sql_path: "../sql-repo", local_sources: "both", folders: ["a", "c"], tests: true });

  // The form: each prompt answered with the window's raw values.
  const { events, done } = await docsRun(viaForm, (run, prompt) => run.answer(prompt.id, FORM_ANSWERS[prompt.id]));
  assert.equal(done.ok, true);
  assert.equal(readFileSync(join(viaForm, "coop-data-doc.yml"), "utf8"), expected, "the form and /setup-docs write the same config");
  assert.deepEqual(events.filter((e) => e.type === "prompt").map((e) => e.prompt.kind), ["text", "path", "select", "checkbox", "confirm"]);
  assert.ok(events.some((e) => e.type === "notice" && e.message === "Saved coop-data-doc.yml"));
});

await check("docs form: cancel, a wrong answer, and the home folder", async () => {
  if (!canExec) return { skip: "the fake coop-data-doc needs direct exec (not on Windows or in this sandbox)" };
  const cwd = join(mkdtempSync(join(temp, "docs-cancel-")), "proj");
  mkdirSync(cwd);
  let wrong = null;
  const { done } = await docsRun(cwd, (run, prompt) => {
    if (prompt.id === "project_name") {
      try { run.answer("project_name", 42); } catch (error) { wrong = error; }
      assert.throws(() => run.answer("other", "x"), /already answered/);
      run.answer("project_name", "ok");
    } else run.cancel();
  });
  assert.ok(wrong instanceof docs.AnswerError);
  assert.equal(done.ok, false);
  assert.equal(existsSync(join(cwd, "coop-data-doc.yml")), false, "a cancelled setup writes nothing");
  // The home folder is refused before coop-data-doc runs.
  const atHome = await docsRun(home, () => assert.fail("no prompt in the home folder"));
  assert.deepEqual([atHome.done.ok, atHome.done.message], [false, docs.MESSAGES.homeFolder]);
});

await check("docs pane: Build streams output; the built pages open only from the docs folder", async () => {
  const cwd = join(mkdtempSync(join(temp, "docs-build-")), "proj");
  mkdirSync(cwd);
  assert.deepEqual(docs.docsLocation(cwd, process.env), { config: join(cwd, "coop-data-doc.yml"), exists: false, outputDir: join(cwd, "data-docs"), built: false, portal: "", live: false, devTarget: false, snapshotAt: "" });
  writeFileSync(join(cwd, "coop-data-doc.yml"), "project: demo\noutput:\n  dir: ./docs-out # built Markdown\n  site_dir: './portal'\n");
  // A fake spawn: the build's output, line by line, split across chunks.
  const spawnImpl = (exe, args, options) => {
    assert.deepEqual(args, ["build"]);
    assert.equal(options.cwd, cwd);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.write("Scan");
      child.stdout.write("ning 2 repos\r\nWrote 2 pages\n");
      child.stderr.write("\u001b[33mwarning\u001b[0m: one view\n");
      mkdirSync(join(cwd, "docs-out", "table"), { recursive: true });
      writeFileSync(join(cwd, "docs-out", "index.md"), "# Overview\n- [Sales](table/sales.md)\n");
      writeFileSync(join(cwd, "docs-out", "table", "sales.md"), "---\nid: 'dbo.Sales'\n---\n# dbo.Sales\n[Back](../index.md)\n");
      mkdirSync(join(cwd, "portal"));
      writeFileSync(join(cwd, "portal", "index.html"), "<html></html>");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
  const lines = [];
  const result = await docs.runDocsBuild({ cwd, env: process.env, platform: "linux", spawnImpl, onLine: (l) => lines.push(l) });
  assert.equal(result.code, 0);
  assert.deepEqual(lines.sort(), ["Scanning 2 repos", "Wrote 2 pages", "warning: one view"].sort());
  const where = docs.docsLocation(cwd, process.env);
  assert.deepEqual([where.exists, where.outputDir, where.built, where.portal], [true, join(cwd, "docs-out"), true, join(cwd, "portal", "index.html")]);

  const index = docs.readDocsPage(where.outputDir, "");
  assert.equal(index.page, "index.md");
  const page = docs.readDocsPage(where.outputDir, resolvePage(index.page, "table/sales.md"));
  assert.equal(stripFrontMatter(page.text), "# dbo.Sales\n[Back](../index.md)\n");
  assert.equal(resolvePage(page.page, "../index.md#top"), "index.md");
  writeFileSync(join(cwd, "secret.md"), "outside");
  for (const bad of ["../secret.md", "table/../../secret.md", "manifest.json", "index.txt"]) {
    assert.throws(() => docs.readDocsPage(where.outputDir, bad), /only the built Markdown docs/, bad);
  }
  let linked = false;
  try { symlinkSync(join(cwd, "secret.md"), join(where.outputDir, "link.md")); linked = true; } catch { /* no symlinks here */ }
  if (linked) assert.throws(() => docs.readDocsPage(where.outputDir, "link.md"), /only the built Markdown docs/);

  // The page list: coop-data-doc's overview does not link its object pages.
  mkdirSync(join(where.outputDir, "view"));
  writeFileSync(join(where.outputDir, "view", "dbo-vsales-1.md"), '---\nid: "view:dbo.vsales"\ntype: "view"\n---\n\n# dbo.vSales\n');
  writeFileSync(join(where.outputDir, "estate_map.md"), "# Estate Map\n<div><svg></svg></div>\n<script src=\"assets/x.js\"></script>\n");
  writeFileSync(join(where.outputDir, "notes.md"), "no heading here\n");
  for (const skipped of ["assets", ".cache"]) { mkdirSync(join(where.outputDir, skipped)); writeFileSync(join(where.outputDir, skipped, "x.md"), "# x\n"); }
  assert.deepEqual(docs.listDocsPages(where.outputDir), [
    { page: "view/dbo-vsales-1.md", id: "view:dbo.vsales", type: "view", title: "dbo.vSales", portalOnly: false },
    { page: "table/sales.md", id: "dbo.Sales", type: "page", title: "dbo.Sales", portalOnly: false },
    { page: "estate_map.md", id: "", type: "page", title: "Estate Map", portalOnly: true },
    { page: "notes.md", id: "", type: "page", title: "notes", portalOnly: false },
  ], "object types first, loose pages last; assets, dot folders and links are skipped");

  // A failed build: its last lines, not a crash.
  const failing = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); setImmediate(() => { c.stderr.end("Repo 'sql' path does not exist\n"); c.stdout.end(); setImmediate(() => c.emit("close", 2)); }); return c; };
  assert.deepEqual(await docs.runDocsBuild({ cwd, env: process.env, platform: "linux", spawnImpl: failing }), { code: 2, tail: ["Repo 'sql' path does not exist"] });
  const missing = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); setImmediate(() => c.emit("error", new Error("spawn ENOENT"))); return c; };
  assert.match((await docs.runDocsBuild({ cwd, env: process.env, platform: "linux", spawnImpl: missing })).tail[0], /Is it installed/);
});

await check("docs pane: the live dev database buttons follow the project file and the config", () => {
  const cwd = join(temp, "docs-live");
  mkdirSync(join(cwd, ".coop"), { recursive: true });
  const env = { ...process.env, COOP_PROJECT_YML: "" };
  // No dev SQL target: nothing about the live database is offered.
  writeFileSync(join(cwd, ".coop", "project.yml"), "profile:\n  client: 'Contoso'\n");
  let where = docs.docsLocation(cwd, env);
  assert.deepEqual([where.live, where.devTarget, where.snapshotAt], [false, false, ""]);
  assert.deepEqual(liveActions(where, true), { setUp: false, refresh: false });
  // A dev target and docs made from files (or none yet): the live choice is offered.
  writeFileSync(join(cwd, ".coop", "project.yml"), "sql_targets:\n  default_environment: dev\n  dev:\n    kind: 'azure_sql'\n    server: 'contoso-dev.database.windows.net'\n    database: 'ContosoDW'\n");
  where = docs.docsLocation(cwd, env);
  assert.deepEqual([where.live, where.devTarget], [false, true]);
  assert.deepEqual(liveActions(where, true), { setUp: true, refresh: false });
  assert.deepEqual(liveActions(where, false), { setUp: false, refresh: false }, "no way to send the command, no button");
  // Live sources in the config, dev not read yet.
  writeFileSync(join(cwd, "coop-data-doc.yml"), 'project_name: "x"\nrepos:\n  sql:\n    path: "./live/dev"\nlive_sources:\n  "dev":\n    server: "h"\n    database: "d"\n    repo: "sql"\n    environment: "dev"\n');
  where = docs.docsLocation(cwd, env);
  assert.deepEqual([where.live, where.snapshotAt], [true, ""]);
  assert.deepEqual(liveActions(where, true), { setUp: false, refresh: true });
  // Two sources read on different days: the docs are as old as the older one;
  // a folder with no manifest or a broken one is not a read.
  for (const [name, body] of [["dev", '{"taken_at":"2026-11-20T06:00:00Z"}'], ["dev_lake", '{"taken_at":"2026-11-12T06:00:00Z"}'], ["broken", "{not json"], ["dateless", '{"taken_at":"soon"}']]) {
    mkdirSync(join(cwd, "live", name), { recursive: true });
    writeFileSync(join(cwd, "live", name, ".coop-data-doc-snapshot.json"), body);
  }
  mkdirSync(join(cwd, "live", "empty"), { recursive: true });
  const before = liveKey(where);
  where = docs.docsLocation(cwd, env);
  assert.equal(where.snapshotAt, "2026-11-12T06:00:00Z");
  assert.notEqual(liveKey(where), before, "a read changes what the pane is waiting on");
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.equal(readAgo(where.snapshotAt, now), "12 days ago");
  assert.equal(readAgo("2026-11-24T06:00:00Z", now), "today");
  assert.equal(readAgo("2026-11-23T06:00:00Z", now), "yesterday");
  assert.equal(readAgo("2026-11-25T06:00:00Z", now), "today", "a clock a little ahead is not a negative age");
  assert.equal(readAgo("", now), "");
  assert.equal(readAgo("soon", now), "");
});

await check("docs pane: which links the pane opens itself", () => {
  assert.equal(isDocsLink("../table/x.md"), true);
  assert.equal(isDocsLink("x.md#columns"), true);
  assert.equal(isDocsLink("https://example.com/x.md"), false);
  assert.equal(isDocsLink("javascript:alert(1)//.md"), false);
  assert.equal(isDocsLink("C:/x.md"), false);
  assert.equal(isDocsLink("notes.txt"), false);
  assert.equal(resolvePage("table/a.md", "../view/b%20c.md"), "view/b c.md");
  assert.equal(resolvePage("index.md", "../outside.md"), "", "leaving the docs folder opens nothing");
  assert.equal(resolvePage("table/a.md", "#cols"), "table/a.md");
  assert.equal(stripFrontMatter("no front matter\n---\nx"), "no front matter\n---\nx");
  assert.deepEqual(["bronze_table", "view", "measures", "page", ""].map(typeLabel), ["Bronze tables", "Views", "Measures", "Other pages", "Other pages"]);
});

// --- Wiring: entry points, the bridge, styles, parity ------------------------------

await check("timeline: edits, the contract, the docs config and setup notices open the pane", () => {
  assert.deepEqual(paneLinksForTool("edit", { path: "sql/a.sql" }, "done").map((l) => [l.pane, l.options.path]), [["changes", "sql/a.sql"]]);
  assert.deepEqual(paneLinksForTool("write", { file_path: "C:\\w\\.coop\\project.yml" }, "done").map((l) => l.pane), ["project", "changes"]);
  assert.deepEqual(paneLinksForTool("edit", { path: "coop-data-doc.yml" }, "done").map((l) => l.pane), ["docs", "changes"]);
  assert.deepEqual(paneLinksForTool("data_doc", { command: "lineage" }, "done").map((l) => l.pane), ["docs"]);
  assert.deepEqual(paneLinksForTool("edit", { path: "a.sql" }, "error"), []);
  assert.deepEqual(paneLinksForTool("read", { path: "a.sql" }, "done"), []);
  assert.deepEqual(paneLinksForText("Run /setup-project, then /setup-docs.").map((l) => l.pane), ["project", "docs"]);
  assert.deepEqual(paneLinksForText("Run /setup-projects"), []);
});

await check("bridge: every pane call in preload.cjs has a handler in main.mjs", () => {
  const preload = readFileSync(join(ROOT, "desktop", "preload.cjs"), "utf8");
  const main = readFileSync(join(ROOT, "desktop", "main.mjs"), "utf8");
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("(coop:[a-z-]+)"/g)].map((m) => m[1]);
  // handle(...) for a window, pickerHandle(...) for the project picker (D1m).
  const handled = new Set([...main.matchAll(/[hH]andle\("(coop:[a-z-]+)"/g)].map((m) => m[1]));
  for (const channel of ["coop:changes", "coop:change-diff", "coop:folders", "coop:standards", "coop:standards-text", "coop:knowledge-note", "coop:project-load", "coop:project-preview", "coop:project-save", "coop:pick-folder", "coop:docs-start", "coop:docs-answer", "coop:docs-cancel", "coop:docs-build", "coop:docs-page", "coop:docs-portal"]) {
    assert.ok(invoked.includes(channel), `preload exposes ${channel}`);
  }
  for (const channel of invoked) assert.ok(handled.has(channel), `main handles ${channel}`);
  // Only the two forms write, and only through their writers.
  for (const lib of ["changes.mjs", "editors.mjs", "standards-view.mjs", "text-diff.mjs"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, "desktop", "lib", lib), "utf8"), /writeFile|renameSync|rename\(|unlink|rmSync|mkdir/, `${lib} is read-only`);
  }
  const form = readFileSync(join(ROOT, "desktop", "lib", "project-form.mjs"), "utf8");
  assert.doesNotMatch(form, /writeFileSync|renameSync/, "the project form writes only through writeProjectContract");
  const setup = readFileSync(join(ROOT, "desktop", "lib", "docs-setup.mjs"), "utf8");
  assert.doesNotMatch(setup, /writeFile|renameSync/, "coop-data-doc is the only writer of its config");
});

await check("styles: the pane draws in all four themes", () => {
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  const themes = readFileSync(join(ROOT, "desktop", "renderer", "styles", "themes.css"), "utf8");
  const start = css.indexOf("/* ---------- side pane (D1b2)");
  const retroStart = css.indexOf("/* Retro panes");
  assert.ok(start > 0 && retroStart > start, "the pane's modern and retro blocks exist");
  const modern = css.slice(start, css.indexOf("::-webkit-scrollbar {", start));
  const retro = css.slice(retroStart);
  for (const selector of [".pane", ".pane-tab.active", ".change-list", ".diff-view.unified", ".diff-split-row", ".domain-chips", ".form-section", ".chip.guard", ".docs-setup", "::highlight(coop-pane-find)"]) {
    assert.ok(modern.includes(selector), `modern styles ${selector}`);
  }
  for (const selector of ['[data-style="retro"] .pane', '[data-style="retro"] .pane-head', '[data-style="retro"] .pane-tab.active', '[data-style="retro"] .change-list', '[data-style="retro"] .form-section']) {
    assert.ok(retro.includes(selector), `retro styles ${selector}`);
  }
  const tokens = (block) => [...new Set([...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const themeBody = (name) => { const i = themes.indexOf(`[data-theme="${name}"]`); return themes.slice(i, themes.indexOf("}", i)); };
  const colours = tokens(modern).filter((t) => !/^--(pane-width|sidebar-width|change-list-height|font|radius|shadow)/.test(t));
  for (const theme of ["modern-dark", "modern-light", "retro-dark", "retro-light"]) {
    const body = themeBody(theme);
    for (const token of colours) assert.match(body, new RegExp(`${token}\\s*:`), `${theme} defines ${token}`);
  }
  for (const theme of ["retro-dark", "retro-light"]) {
    for (const token of tokens(retro).filter((t) => /^--(bevel|titlebar)/.test(t))) assert.match(themeBody(theme), new RegExp(`${token}\\s*:`), `${theme} defines ${token}`);
  }
  // The pane's shortcuts are the window's own: Pi's keybinding list is unchanged.
  const app = readFileSync(join(ROOT, "desktop", "renderer", "app.mjs"), "utf8");
  assert.match(app, /changes: \{ label: "Changes since the last commit", keys: "Ctrl\+Shift\+D", pane: true/);
  assert.equal(Object.values(KEYS).some((k) => /Ctrl\+Shift\+[DS]\b|Ctrl\+\\/.test(k.keys)), false);
});

await check("render: no stray text or borrowed layout in the panes", () => {
  // replaceChildren() writes a null child as the text "null"; panes use fill().
  for (const name of readdirSync(join(ROOT, "desktop", "renderer")).filter((f) => /^pane-.*\.mjs$/.test(f))) {
    const source = readFileSync(join(ROOT, "desktop", "renderer", name), "utf8");
    assert.equal(/\.replaceChildren\(/.test(source), false, `${name} uses fill(), not replaceChildren()`);
  }
  // .empty is the timeline's empty state (12vh of padding), so no pane part may carry it.
  const diffView = readFileSync(join(ROOT, "desktop", "renderer", "diff-view.mjs"), "utf8");
  assert.equal(/class: "[^"]*\bempty\b/.test(diffView), false, "the split diff's blank cell is not .empty");
  assert.equal(docs.MESSAGES.notRunnable("output.dir overlaps source repo 'sql'.").includes(".."), false);
});

await check("resize: every pane drags, within limits that keep the conversation readable", async () => {
  const resize = await import(pathToFileURL(join(ROOT, "desktop", "renderer", "resize.mjs")).href);
  assert.equal(resize.clampSize(100, 200, 480), 200);
  assert.equal(resize.clampSize(900, 200, 480), 480);
  assert.equal(resize.clampSize(300.6, 200, 480), 301);
  assert.equal(resize.clampSize(300, 320, 100), 320, "a max below the min yields the min");
  assert.equal(resize.clampSize(5000, 36, Infinity), 5000, "no layout yet: a saved size is kept");
  // Wide window: the pane stops at 70% of it; narrow: the conversation keeps MIN_MAIN.
  assert.equal(resize.paneMaxWidth(3000, 264), 2100);
  assert.equal(resize.paneMaxWidth(1200, 264), 1200 - 264 - resize.MIN_MAIN);
  assert.equal(resize.sidebarMaxWidth(2000, 0), resize.SIDEBAR_MAX);
  assert.equal(resize.sidebarMaxWidth(1200, 520), 1200 - 520 - resize.MIN_MAIN);
  // Each handle is in the markup or the pane, labelled, and keyboard reachable.
  const html = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
  for (const id of ["sidebarResize", "paneResize"]) assert.match(html, new RegExp(`id="${id}"[^>]*role="separator"[^>]*aria-label="[^"]+"[^>]*tabindex="0"`), id);
  const changes = readFileSync(join(ROOT, "desktop", "renderer", "pane-changes.mjs"), "utf8");
  assert.match(changes, /class: "split-resize", role: "separator", "aria-orientation": "horizontal"/);
  // A "View in Changes" click during a load is kept and run after it, not dropped.
  assert.match(changes, /if \(state\.loading\) \{ state\.queued = /);
  assert.match(changes, /if \(state\.queued\) \{ const next = state\.queued; state\.queued = null; await load\(next\.want, next\.repo\); \}/);
  // The team line arriving after the form updates its own slot, so typing keeps its focus.
  const project = readFileSync(join(ROOT, "desktop", "renderer", "pane-project.mjs"), "utf8");
  assert.match(project, /el\("div", \{ class: "team-slot" \}, teamLine\(\)\)/);
  assert.match(project, /const slot = body\.querySelector\("\.team-slot"\);\s*if \(state\.view === "form"\) \{ if \(slot\) fill\(slot, teamLine\(\)\); else renderForm\(\); \}/);
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  for (const variable of ["--sidebar-width", "--pane-width", "--change-list-height"]) assert.ok(css.includes(`var(${variable}`), `app.css sizes with ${variable}`);
  assert.equal(/grid-template-columns: 264px/.test(css), false, "the sidebar column follows --sidebar-width");
});

await check("styles: one page's rules never restyle the window's dialogs, and every colour token exists", () => {
  // 2026-11-11: the client-folder page's bare `.picker { min-height: 100vh }`
  // also matched every picker dialog (model, thinking, theme, questions) and
  // stretched each one to the window's height.
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  const themes = readFileSync(join(ROOT, "desktop", "renderer", "styles", "themes.css"), "utf8");
  for (const rule of css.matchAll(/\n([^\n{}]*)\{([^}]*min-height: 100vh[^}]*)\}/g)) {
    assert.match(rule[1], /-body\b/, `a full-height rule is scoped to its own page: ${rule[1].trim()}`);
  }
  const defined = new Set([...`${themes}\n${css}`.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const set = new Set(["--sidebar-width", "--pane-width", "--change-list-height"]); // set from script (resize.mjs)
  for (const use of css.matchAll(/var\((--[a-z0-9-]+)\s*[,)]/g)) {
    assert.ok(defined.has(use[1]) || set.has(use[1]), `${use[1]} is defined in themes.css or app.css`);
  }
  assert.match(css, /\.md a, \.md-link \{[^}]*text-decoration: underline/, "links are told from text by more than colour");
});

await check("window: extension emoji become line icons, and the composer lines up with the conversation", async () => {
  const { splitGlyph } = await import("../desktop/renderer/ui.mjs");
  assert.deepEqual(splitGlyph("\u{1F50C} MCP: 4 servers enabled"), { icon: "plug", text: "MCP: 4 servers enabled" });
  assert.deepEqual(splitGlyph("\u{1F9E0} Memory saved"), { icon: "book", text: "Memory saved" });
  assert.deepEqual(splitGlyph("Ready"), { icon: "", text: "Ready" });
  assert.deepEqual(splitGlyph(undefined), { icon: "", text: "" });
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  // The conversation keeps room for its scrollbar; the composer leaves the same room on the right.
  assert.match(css, /\n\.timeline \{[^}]*scrollbar-gutter: stable/);
  assert.match(css, /\n\.dock \{ padding: 0 calc\(24px \+ var\(--scrollbar, 10px\)\) 10px 24px; \}/);
  assert.match(css, /\[data-style="retro"\] \.dock \{ padding: 0 calc\(6px \+ var\(--scrollbar\)\) 6px 6px; \}/);
  assert.match(css, /body\.finding \.banner \{/, "the Find bar never covers a banner");
  const app = readFileSync(join(ROOT, "desktop", "renderer", "app.mjs"), "utf8");
  assert.match(app, /class: "switch", role: "switch"/, "a setting's toggle is announced as a switch");
});

await check("styles: a long session list never pushes the window past its height", () => {
  // 2026-10-05: the sidebar grew with its list, the composer sat below the fold
  // and focusing it scrolled the whole document (top bar and sidebar head gone).
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  const sidebar = css.match(/\n\.sidebar \{([^}]*)\}/);
  assert.ok(sidebar, ".sidebar rule");
  assert.match(sidebar[1], /min-height: 0/, "the sidebar keeps to its grid row");
  assert.match(sidebar[1], /overflow: hidden/, "the sidebar clips instead of growing");
  const body = css.match(/\nbody \{([^}]*)\}/);
  assert.ok(body, "body rule");
  assert.match(body[1], /overflow: clip/, "the document can never scroll");
  assert.match(css, /\.session-list \{[^}]*overflow-y: auto/, "the session list scrolls on its own");
});

await check("styles: the unified diff wraps long lines instead of scrolling sideways", () => {
  // 2026-10-05: a wide unified diff ran past the pane's right edge; Aaron asked
  // for word wrap in unified mode (side by side already wraps per cell).
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  assert.ok(!/\.diff-view\.unified \{[^}]*max-content/.test(css), "the unified view no longer forces its content width");
  const row = css.match(/\n\.diff-view\.unified \.diff-row \{([^}]*)\}/);
  assert.ok(row, ".diff-view.unified .diff-row rule");
  assert.match(row[1], /white-space: pre-wrap/, "unified rows wrap");
  assert.match(row[1], /minmax\(0, 1fr\)/, "the text column can shrink below its content");
  assert.match(css, /\.diff-view\.unified \.diff-text \{[^}]*overflow-wrap: anywhere/, "long tokens break too");
  assert.match(css, /\n\.diff-cell \{[^}]*white-space: pre-wrap/, "side by side keeps wrapping");
});

await check("changes: Open in editor picks SSMS for SQL, Tabular Editor for DAX by default, Power BI on request", () => {
  const { editorKind, editorPlan, pbipFor, modelTarget } = editors;
  assert.equal(editorKind("Views/dbo.v.sql"), "sql");
  assert.equal(editorKind("Sales.SemanticModel/definition/tables/Fact.tmdl"), "model");
  assert.equal(editorKind("model/Model.bim"), "model");
  assert.equal(editorKind("Sales.SemanticModel/definition.pbism"), "model");
  assert.equal(editorKind("Sales.Report/definition.pbir"), "other");
  assert.equal(editorKind("README.md"), "other");
  const te3 = "C:\\Program Files\\Tabular Editor 3\\TabularEditor3.exe";
  const ssms = "C:\\Program Files\\Microsoft SQL Server Management Studio 21\\Release\\Common7\\IDE\\SSMS.exe";
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" };
  const on = (...paths) => (path) => paths.includes(path);
  // The repo root in the platform's own separators: editors.mjs walks up with
  // node:path, so on Windows join() yields "\r\..." and a "/r" root never matches.
  const r = join("/r");
  const fact = join(r, "Sales.SemanticModel", "definition", "tables", "Fact.tmdl");
  const definition = join(r, "Sales.SemanticModel", "definition");
  const exists = on(te3, ssms, join(definition, "database.tmdl"), join(r, "Sales.pbip"));
  // SQL: SSMS when installed, else Windows' app with a fallback note.
  const sql = editorPlan(join(r, "a.sql"), { env, exists, platform: "win32" });
  assert.deepEqual([sql.editor, sql.exe, sql.args], ["SSMS", ssms, [join(r, "a.sql")]]);
  const noSsms = editorPlan(join(r, "a.sql"), { env, exists: on(), platform: "win32" });
  assert.deepEqual([noSsms.exe, noSsms.target, noSsms.fallback], ["", join(r, "a.sql"), "SSMS"]);
  // DAX: Tabular Editor is the default and opens the TMDL folder.
  const te = editorPlan(fact, { env, exists, root: r, platform: "win32" });
  assert.deepEqual([te.editor, te.exe, te.args], ["Tabular Editor", te3, [definition]]);
  assert.equal(modelTarget(join(r, "m", "Model.bim"), r, on(join(r, "m", "Model.bim"))), join(r, "m", "Model.bim"));
  assert.equal(modelTarget(fact, r, on()), fact, "no model root: the file itself");
  // Power BI Desktop: the .pbip beside the model folder, with the overwrite warning.
  const pbi = editorPlan(fact, { env, exists, root: r, platform: "win32", daxEditor: "power-bi", list: () => [] });
  assert.deepEqual([pbi.editor, pbi.exe, pbi.target], ["Power BI Desktop", "", join(r, "Sales.pbip")]);
  assert.match(pbi.warn, /close it first without saving/);
  assert.equal(pbipFor(fact, { exists: on(), list: () => ["Other.pbip"] }), join(r, "Other.pbip"), "the only .pbip there");
  assert.equal(pbipFor(fact, { exists: on(), list: () => ["A.pbip", "B.pbip"] }), "", "never guesses between two");
  assert.match(editorPlan(fact, { env, exists: on(), daxEditor: "power-bi", list: () => [] }).fallback, /no \.pbip/);
  // Off Windows nothing is looked up; Windows' app (xdg here) opens the file.
  assert.equal(editorPlan(join(r, "a.sql"), { env, exists, platform: "linux" }).exe, "");
  // Anything else: the default app.
  assert.deepEqual(editorPlan(join(r, "notes.md"), { env, exists, platform: "win32" }).editor, "the default app");
  // The setting: Tabular Editor unless Power BI Desktop is picked.
  const settingsFile = join(temp, "editor-settings.json");
  writeFileSync(settingsFile, JSON.stringify({ daxEditor: "power-bi" }));
  assert.equal(loadSettings(settingsFile).daxEditor, "power-bi");
  writeFileSync(settingsFile, JSON.stringify({ daxEditor: "notepad" }));
  assert.equal(loadSettings(settingsFile).daxEditor, "tabular-editor");
  // main opens only a path from this tab's list (or its drafts), never the renderer's own.
  const main = readFileSync(join(ROOT, "desktop", "main.mjs"), "utf8");
  const handler = main.slice(main.indexOf('handle("coop:open-in-editor"'), main.indexOf("// F2: the three places"));
  assert.match(handler, /state\.changes \|\| \[\]\)\.find\(\(change\) => change\.path === path\)/);
  assert.match(handler, /entry\.status !== "deleted"/);
  assert.match(handler, /editorPlan\(file, \{ daxEditor: settings\.daxEditor/);
  assert.match(main, /key === "daxEditor"/);
});

await check("changes: Fix this line puts a note in the prompt, never sends it", () => {
  assert.equal(fixLinePrompt({ path: "Views/dbo.v.sql", line: 12, text: "  INNER JOIN `x`  ON a = b", note: " make it a LEFT JOIN " }),
    "Fix Views/dbo.v.sql line 12 (`INNER JOIN 'x' ON a = b`): make it a LEFT JOIN");
  assert.equal(fixLinePrompt({ path: "a.sql", line: 3, text: "", note: "drop this" }), "Fix a.sql line 3: drop this");
  const pane = readFileSync(join(ROOT, "desktop", "renderer", "pane-changes.mjs"), "utf8");
  assert.match(pane, /setPrompt\(fixLinePrompt\(/, "the note goes to the composer");
  assert.ok(!/coop\.command\(/.test(pane), "the panel never sends a prompt itself");
  const view = readFileSync(join(ROOT, "desktop", "renderer", "diff-view.mjs"), "utf8");
  assert.match(view, /"data-line": String\(line\.newNo\)/, "unified rows carry their new line number");
  assert.match(view, /side\(row\.right, "add", row\.right \? row\.right\.newNo : null, true\)/, "side by side: only the new side");
});

// --- Diff review comments (FEATURES-DESIGN CW3) ------------------------------
// The renderer's DOM is drawn with a tiny fake document (tests/fixtures/diff-render-cases.mjs);
// tests/fixtures/ed1-diff-golden.json pins ED1 (6e64add8) for the off state.
const reviewCases = await import("./fixtures/diff-render-cases.mjs");
const ed1Golden = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "ed1-diff-golden.json"), "utf8"));
const { unifiedDiff: textDiff } = await import("../desktop/lib/text-diff.mjs");
const PROCS = ["CREATE PROC a AS", "BEGIN", "  SELECT 1", "END", "GO", "CREATE PROC b AS", "BEGIN", "  SELECT 2", "END", "GO", "CREATE PROC c AS", "BEGIN", "  SELECT 3", "END", "GO"];
const modelOf = (before, after) => diffModel(textDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`));

await check("review comments: off (or an unreadable setting) is ED1 byte for byte: the Fix this line prompt and the diff DOM", async () => {
  for (const view of [undefined, null, {}, { ok: false, features: [{ key: "comments", on: true }] }, { ok: true, features: [] }, { ok: true, features: [{ key: "comments", on: "true" }] }, { ok: true, features: [{ key: "comments", on: false }] }]) {
    assert.equal(commentsOn(view), false, `off: ${JSON.stringify(view)}`);
  }
  assert.equal(commentsOn({ ok: true, features: [{ key: "comments", on: true }] }), true);
  for (const { input, prompt } of ed1Golden.fixLinePrompt) assert.equal(fixLinePrompt(input), prompt, "the Fix this line prompt is ED1's");
  assert.deepEqual(await reviewCases.renderAll(join(ROOT, "desktop", "renderer")), ed1Golden.renderDiff, "renderDiff draws ED1's DOM when comments are off");
  assert.deepEqual(await reviewCases.renderAll(join(ROOT, "desktop", "renderer"), { comments: false }), ed1Golden.renderDiff);
  // The pane keeps ED1's click path whenever the setting is not on.
  const pane = readFileSync(join(ROOT, "desktop", "renderer", "pane-changes.mjs"), "utf8");
  assert.match(pane, /if \(reviewing\(\)\) \{ commentClick\(event\); return; \}\n    const selection = window\.getSelection \? String\(window\.getSelection\(\)\) : "";\n    if \(selection\) return;\n    const row = event\.target\.closest\("\[data-line\]"\);\n    if \(row && diffBox\.contains\(row\)\) openFixForm\(row\);/);
  assert.match(pane, /if \(event\.shiftKey && reviewing\(\) && event\.target\.closest/, "a shift-click is a range only while comments are on");
  assert.match(pane, /try \{ return typeof isCommentsOn === "function" && isCommentsOn\(\) === true; \} catch \{ return false; \}/, "a failing read is off");
});

await check("review comments: on, removed lines carry their old number and every commentable line its hunk", () => {
  reviewCases.installFakeDom();
  const model = diffModel(reviewCases.CASES[0].diff);
  const unified = renderDiff(model, { mode: "unified", comments: true }).node.all();
  const del = unified.filter((n) => /diff-row del/.test(n.className));
  assert.deepEqual(del.map((n) => [n.getAttribute("data-old-line"), n.getAttribute("data-hunk"), n.getAttribute("data-line")]), [["2", "0", null], ["4", "0", null]]);
  const added = unified.filter((n) => /diff-row add/.test(n.className));
  assert.deepEqual(added.map((n) => [n.getAttribute("data-line"), n.getAttribute("data-hunk")]), [["2", "0"], ["5", "0"], ["41", "1"]]);
  const split = renderDiff(model, { mode: "split", comments: true }).node.all();
  assert.deepEqual(split.filter((n) => n.getAttribute("data-old-line")).map((n) => [n.className, n.getAttribute("data-old-line"), n.getAttribute("data-hunk")]), [["diff-cell del", "2", "0"], ["diff-cell del", "4", "0"]], "side by side: only removed cells get the old number");
  assert.ok(split.filter((n) => /diff-cell ctx/.test(n.className) && n.getAttribute("data-old-line")).length === 0, "an unchanged line is commented on its new side only");
});

await check("review comments: new, removed and range comments make one numbered prompt (the design's example)", () => {
  const before = ["CREATE VIEW dbo.vw_Sales AS", ...Array.from({ length: 8 }, (_, i) => `-- note ${i + 2}`), "WHERE s.Date >= '2026-01-01'", "  AND s.Date < '2027-01-01'", "  AND s.Kind = 'S'", "  AND s.Void = 0", "  AND s.Test = 0", ...Array.from({ length: 27 }, (_, i) => `-- more ${i + 15}`), "FROM fact.Sales s", "JOIN dim.Customer c", "GO"];
  const after = before.filter((_, i) => i < 9 || i > 13);
  after.splice(after.indexOf("JOIN dim.Customer c"), 1, "JOIN stg.Customer c");
  const model = modelOf(before, after);
  const newLine = after.indexOf("JOIN stg.Customer c") + 1;
  assert.ok(canComment(model, "new", newLine) && canComment(model, "old", 10) && canComment(model, "old", 14));
  assert.equal(canComment(model, "old", newLine), false, "an unchanged line has no removed-side comment");
  const path = reviewPath({ rel: "sql", selected: "dbo/Views/vw_Sales.sql" });
  const range = extendSelection({ key: "k", side: "old", hunk: 0, line: 14 }, { key: "k", side: "old", hunk: 0, line: 10 });
  assert.deepEqual(range, { side: "old", hunk: 0, from: 10, to: 14 });
  const comments = [
    { repoLabel: "sql", path, side: "new", from: newLine, to: newLine, ...commentContext(model, "new", newLine, newLine), note: " use dim.Customer " },
    { repoLabel: "sql", path, side: "old", from: 10, to: 14, ...commentContext(model, "old", 10, 14), note: "keep the date filter" },
  ];
  assert.deepEqual(comments[1].text, ["WHERE s.Date >= '2026-01-01'", "  AND s.Date < '2027-01-01'", "  AND s.Kind = 'S'", "  AND s.Void = 0", "  AND s.Test = 0"]);
  assert.equal(reviewPrompt(comments).replace(` line ${newLine} `, " line 42 "), [
    "Review comments on the Changes pane (repo sql):",
    "1. sql/dbo/Views/vw_Sales.sql line 42 (new) `JOIN stg.Customer c`: use dim.Customer",
    "2. sql/dbo/Views/vw_Sales.sql lines 10-14 (removed): keep the date filter",
    "Revise under the usual rules; answer each by number.",
  ].join("\n"));
  const odd = { repoLabel: "sql", path: "a.sql", side: "old", from: 3, to: 3, text: ["  SELECT `x`,\t y  "], note: "keep" };
  assert.equal(reviewPrompt([odd]).split("\n")[1], "1. a.sql line 3 (removed) `SELECT 'x', y`: keep", "a removed line names its text like ED1 does");
  assert.match(reviewPrompt([odd, { ...odd, repoLabel: "pbi" }]), /^Review comments on the Changes pane \(repos sql, pbi\):/);
  const pane = readFileSync(join(ROOT, "desktop", "renderer", "pane-changes.mjs"), "utf8");
  assert.match(pane, /state\.lastPrompt = reviewPrompt\(batch\);\n    setPrompt\(state\.lastPrompt\);/, "the batch goes to the composer");
  assert.ok(!/coop\.command\(/.test(pane), "the pane never sends a prompt itself");
  assert.match(pane, /`Send to coop \(\$\{waiting\} \$\{waiting === 1 \? "comment" : "comments"\}\)`/);
});

await check("review comments: the repository's rel prefix (a non-root repository) and draft: entries", () => {
  assert.equal(reviewPath({ rel: "", selected: "dbo/v.sql" }), "dbo/v.sql", "the open folder's own repository: no prefix");
  assert.equal(reviewPath({ rel: "sql", selected: "dbo/v.sql" }), "sql/dbo/v.sql");
  assert.equal(reviewPath({ rel: "sql/", selected: "dbo/v.sql" }), "sql/dbo/v.sql");
  assert.equal(reviewPath({ rel: "../warehouse", selected: "dbo/v.sql" }), "../warehouse/dbo/v.sql", "a project-file repository beside the folder");
  assert.equal(reviewPath({ rel: "sql", selected: "draft:fix_sales.sql" }), "draft fix_sales.sql", "a draft gets no prefix");
  assert.equal(reviewPrompt([{ repoLabel: "sql", path: reviewPath({ rel: "sql", selected: "draft:fix.sql" }), side: "new", from: 1, to: 1, text: ["SELECT 1"], note: "ok?" }]).split("\n")[1], "1. draft fix.sql line 1 (new) `SELECT 1`: ok?");
});

await check("review comments: a shift-click across hunks or sides starts a new single-line comment", () => {
  const a = { key: "r\0v.sql", side: "new", hunk: 0, line: 5 };
  assert.deepEqual(extendSelection(a, { ...a, line: 2 }), { side: "new", hunk: 0, from: 2, to: 5 }, "same hunk and side: a range");
  assert.deepEqual(extendSelection(a, { ...a, hunk: 1, line: 41 }), { side: "new", hunk: 1, from: 41, to: 41 }, "another hunk: a single comment");
  assert.deepEqual(extendSelection(a, { ...a, side: "old", line: 4 }), { side: "old", hunk: 0, from: 4, to: 4 }, "the other side: a single comment");
  assert.deepEqual(extendSelection(a, { ...a, key: "r\0w.sql", line: 7 }), { side: "new", hunk: 0, from: 7, to: 7 }, "another file: a single comment");
  assert.deepEqual(extendSelection(null, a), { side: "new", hunk: 0, from: 5, to: 5 });
});

await check("review comments: after a revision each comment re-anchors by its line and the two lines either side (repeated END and GO)", () => {
  const v1 = PROCS.slice(); v1[7] = "  SELECT 22"; v1[12] = "  SELECT 33";
  const m1 = modelOf(PROCS, v1);
  // The END of proc b (new line 9); procs a and c end in the same END and GO.
  const comment = { side: "new", from: 9, to: 9, ...commentContext(m1, "new", 9, 9) };
  assert.deepEqual(comment.text, ["END"]);
  const header = ["-- one", "-- two", "-- three"];
  assert.deepEqual(reanchorComment(comment, modelOf(PROCS, [...header, ...v1])), { status: "unchanged", from: 12, to: 12, hunk: 1 }, "three lines added above: the same END, three lines down");
  const edited = [...header, ...v1]; edited[11] = "END; -- b";
  assert.equal(reanchorComment(comment, modelOf(PROCS, edited)).status, "changed", "the commented END itself was edited");
  assert.equal(reanchorComment(comment, modelOf(PROCS, edited)).from, 12);
  const neighbour = [...header, ...v1]; neighbour[10] = "  SELECT 222";
  assert.equal(reanchorComment(comment, modelOf(PROCS, neighbour)).status, "unchanged", "a neighbour edited, the line itself not");
  const gone = v1.slice(); gone.splice(8, 1);
  assert.equal(reanchorComment(comment, modelOf(PROCS, gone)).status, "moved", "the commented END removed: not proc c's END");
  assert.equal(COMMENT_STATUS.moved, "moved or gone, check it");
  // A removed line: the old side is the last commit.
  const removed = { side: "old", from: 8, to: 8, ...commentContext(m1, "old", 8, 8) };
  assert.equal(reanchorComment(removed, m1).status, "unchanged");
  const restored = PROCS.slice(); restored[12] = "  SELECT 33";
  assert.equal(reanchorComment(removed, modelOf(PROCS, restored)).status, "changed", "coop put the removed line back");
  // A range keeps its length when it moves.
  const span = { side: "new", from: 8, to: 9, ...commentContext(m1, "new", 8, 9) };
  assert.deepEqual(reanchorComment(span, modelOf(PROCS, [...header, ...v1])), { status: "unchanged", from: 11, to: 12, hunk: 1 });
});

await check("review comments: past MAX_ROWS the diff is cut and comment controls stop there, with a note", () => {
  reviewCases.installFakeDom();
  assert.equal(MAX_ROWS, 4000);
  const model = diffModel(reviewCases.CASES[1].diff);
  const { rows, cut } = diffRows(model, "unified");
  assert.equal(cut, true);
  assert.equal(rows.length, MAX_ROWS);
  const last = [...rows].reverse().find((r) => r.kind === "line" && r.line.newNo !== null).line.newNo;
  assert.equal(canComment(model, "new", last), true, "the last line drawn takes a comment");
  assert.equal(canComment(model, "new", last + 1), false, "the first line past the cut does not");
  assert.equal(canComment(model, "new", 4400), false);
  const on = renderDiff(model, { mode: "unified", comments: true }).node.all();
  assert.match(on[on.length - 1].textContent, /^Showing the first 4000 lines\. Review comments stop here/);
  const off = renderDiff(model, { mode: "unified" }).node.all();
  assert.equal(off[off.length - 1].textContent, "Showing the first 4000 lines.", "off: ED1's note");
  assert.ok(!on.some((n) => Number(n.getAttribute("data-line")) > last), "no control past the cut");
});

await check("review comments: the window wiring (one writer in-process, applies at once, nothing written by the pane)", () => {
  const main = readFileSync(join(ROOT, "desktop", "main.mjs"), "utf8");
  assert.match(main, /import \{ changedText, featureFor, listFeatures, setFeature \} from "\.\.\/lib\/features\.mjs";/, "main imports the one writer from the bundled coop folder");
  assert.ok(!/powershell|coop\.ps1.*settings/i.test(main.slice(main.indexOf('handle("coop:feature-set"'), main.indexOf('handle("coop:copy"'))), "no PowerShell start per click");
  assert.match(main, /broadcast\("coop:features", view\)/, "every tab hears a change at once");
  assert.match(main, /features: featureView\(state\)/);
  const preload = readFileSync(join(ROOT, "desktop", "preload.cjs"), "utf8");
  assert.match(preload, /setFeature: \(key, on\) => ipcRenderer\.invoke\("coop:feature-set", String\(key \|\| ""\), on === true\)/);
  assert.match(preload, /onFeatures: listen\("coop:features"\)/);
  const app = readFileSync(join(ROOT, "desktop", "renderer", "app.mjs"), "utf8");
  assert.match(app, /"Features \(this client\)"/);
  assert.match(app, /commentsOn: \(\) => commentsOn\(app\.info && app\.info\.features\)/);
  assert.match(app, /window\.dispatchEvent\(new CustomEvent\("coop:features"\)\)/);
  const pane = readFileSync(join(ROOT, "desktop", "renderer", "pane-changes.mjs"), "utf8");
  assert.match(pane, /window\.addEventListener\("coop:features"/, "the pane follows a change at once");
});

// --- The Changes pane itself, mounted on a small live DOM ---------------------
// tests/fixtures/fake-dom.mjs: clicks, shift-clicks, the comment form, Send to
// coop, two revisions in a row, side by side, a live Settings toggle, and a
// repository switch racing a slow diff. Each diff comes from a fake coop.changes /
// coop.changeDiff, as the main process would answer.
const liveDom = await import("./fixtures/fake-dom.mjs");
const { mountChanges } = await import("../desktop/renderer/pane-changes.mjs");
const diffOf = (before, after) => textDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`);

function changesPane({ repos = [{ id: "", label: "w", rel: "" }], files = { "": ["v.sql"] }, diff, on = true } = {}) {
  const dom = liveDom.installLiveDom();
  const box = new liveDom.FakeElement("div");
  dom.body.append(box);
  const h = {
    dom, box, on, prompt: "", prompts: [], repo: repos[0].id,
    // diff for (repo, path): a string, or a function returning a Promise for a slow answer
    diff: typeof diff === "function" ? diff : () => diff,
  };
  const coop = {
    changes: async (pick) => {
      if (typeof pick === "string") h.repo = pick;
      return { success: true, data: { repos, current: h.repo, repo: true, files: (files[h.repo] || []).map((path) => ({ path, status: "modified", added: 1, removed: 1 })), drafts: [], draftsDir: "" } };
    },
    changeDiff: async (path) => ({ success: true, data: { diff: await h.diff(h.repo, path) } }),
    openInEditor: async () => ({ success: true, data: {} }),
  };
  h.api = mountChanges(box, {}, { coop, cwd: () => "/w", setPrompt: (text) => { h.prompt = text; h.prompts.push(text); }, getPrompt: () => h.prompt, commentsOn: () => h.on });
  const q = (sel) => box.querySelector(sel);
  Object.assign(h, {
    q,
    newRow: (n) => q(`[data-line="${n}"]`),
    oldRow: (n) => q(`[data-old-line="${n}"]`),
    form: () => q(".review-form"),
    markers: () => box.querySelectorAll(".review-marker"),
    bar: () => q(".review-bar"),
    sendButton: () => { const bar = q(".review-bar"); return bar ? bar.querySelector(".primary") : null; },
    async comment(row, note, shift = false) {
      dom.click(row, { shiftKey: shift });
      const form = q(".review-form");
      assert.ok(form, "a click opens the comment form");
      form.querySelector("input").value = note;
      dom.click(form.querySelector(".primary"));
    },
    async refresh() { h.api.refresh(); await dom.settle(); },
    toggle(value) { h.on = value; dom.window.dispatchEvent(new CustomEvent("coop:features")); },
  });
  return h;
}

await check("review comments (mounted): click, shift-click range, markers, Send fills one prompt and can fill it again", async () => {
  const v1 = PROCS.slice(); v1[7] = "  SELECT 22"; v1[12] = "  SELECT 33";
  const h = changesPane({ diff: diffOf(PROCS, v1) });
  await h.dom.settle();
  assert.ok(h.newRow(8), "the diff is drawn");
  await h.comment(h.newRow(8), "why 22?");
  assert.equal(h.markers().length, 1);
  assert.match(h.sendButton().textContent, /^Send to coop \(1 comment\)$/);
  // A shift-click from line 8 to line 9 on the new side: one range comment.
  h.dom.click(h.newRow(9), { shiftKey: true });
  assert.equal(h.form().querySelector("input").getAttribute("placeholder"), "Comment on lines 8-9 (new)");
  h.form().querySelector("input").value = "and the END";
  h.dom.click(h.form().querySelector(".primary"));
  assert.equal(h.markers().length, 2);
  h.dom.click(h.sendButton());
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0], ["Review comments on the Changes pane (repo w):", "1. v.sql line 8 (new) `SELECT 22`: why 22?", "2. v.sql lines 8-9 (new): and the END", "Revise under the usual rules; answer each by number."].join("\n"));
  // The person closed the prompt without sending: Send fills it again (7.4).
  assert.equal(h.sendButton().disabled, false, "Send stays available after filling the prompt");
  h.prompt = "";
  h.dom.click(h.sendButton());
  assert.equal(h.prompts.length, 2);
  assert.equal(h.prompts[1], h.prompts[0], "the same batch, the same numbers");
  // A comment added while that prompt still waits in the composer joins its batch.
  await h.comment(h.oldRow(13), "keep SELECT 3");
  h.dom.click(h.sendButton());
  assert.match(h.prompts[2], /^1\. v\.sql line 8 \(new\)/m);
  assert.match(h.prompts[2], /^3\. v\.sql line 13 \(removed\) `SELECT 3`: keep SELECT 3$/m);
  // Once the person sent it (the composer moved on), the next batch is only what is new.
  h.prompt = "";
  await h.comment(h.newRow(7), "fine");
  h.dom.click(h.sendButton());
  assert.equal(h.prompts[3].split("\n").length, 3, "one numbered line");
  assert.match(h.prompts[3], /^1\. v\.sql line 7 \(new\) `BEGIN`: fine$/m);
});

await check("review comments (mounted): a shift-click over removed lines with an unchanged line between starts a single comment (7.1)", async () => {
  const h = changesPane({ diff: reviewCases.CASES[0].diff });
  await h.dom.settle();
  await h.comment(h.oldRow(2), "keep b");
  h.dom.click(h.oldRow(4), { shiftKey: true });
  assert.equal(h.form().querySelector("input").getAttribute("placeholder"), "Comment on line 4 (removed)", "old lines 2 and 4 have an unchanged line 3 between: not a range");
  // A removed line looks clickable like a new one (7.3).
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  assert.match(css, /\.diff-view \[data-old-line\][^{]*\{ cursor: pointer; \}/);
  assert.match(css, /\.diff-view \[data-old-line\]:hover[^{]*\{ outline:/);
});

await check("review comments (mounted): a changed comment stays changed through a second revision, and keeps its code (3.1)", async () => {
  const v1 = PROCS.slice(); v1[7] = "  SELECT 22"; v1[12] = "  SELECT 33";
  let current = v1;
  const h = changesPane({ diff: () => diffOf(PROCS, current) });
  await h.dom.settle();
  await h.comment(h.newRow(8), "why 22?");
  await h.comment(h.oldRow(13), "keep SELECT 3");
  h.dom.click(h.sendButton());
  // Revision 1: coop edits the commented new line and puts the removed line back.
  const v2 = PROCS.slice(); v2[7] = "  SELECT 222";
  current = v2;
  await h.refresh();
  const status = () => h.markers().map((m) => m.className);
  assert.deepEqual(status(), ["review-marker changed sent", "review-marker changed sent"]);
  // Revision 2: an edit somewhere else (proc c's GO, so old line 13 is context now).
  const v3 = v2.slice(); v3[14] = "GO -- c";
  current = v3;
  await h.refresh();
  assert.deepEqual(status(), ["review-marker changed sent", "review-marker changed sent"], "still changed, not unchanged or moved");
  h.prompt = "";
  for (const m of h.markers()) h.dom.click(m.querySelector(".btn"));
  h.form().querySelector("input").value = "keep SELECT 3, again";
  h.dom.click(h.form().querySelector(".primary"));
  h.dom.click(h.sendButton());
  assert.match(h.prompts.at(-1), /line 13 \(removed\) `SELECT 3`: keep SELECT 3, again/, "the removed line's code is kept");
});

await check("review comments (mounted): side by side past the unified cut, a comment keeps its code and its place (3.2)", async () => {
  const n = 2500;
  const lines = (tag) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
  const big = (first) => [`@@ -1,${n} +1,${n} @@`, ...lines("-old"), `+${first}`, ...lines("+new").slice(1)].join("\n");
  let current = big("new 1");
  const h = changesPane({ diff: () => current });
  await h.dom.settle();
  assert.equal(h.newRow(2400), null, "unified: line 2400 is past the cut");
  h.dom.click(h.box.querySelectorAll("button").find((b) => b.textContent === "Side by side"));
  assert.ok(h.newRow(2400), "side by side draws it");
  await h.comment(h.newRow(2400), "rename");
  h.dom.click(h.sendButton());
  assert.match(h.prompts[0], /^1\. v\.sql line 2400 \(new\) `new 2400`: rename$/m, "the comment carries its line's code");
  current = big("new 1 changed");
  await h.refresh();
  assert.equal(h.markers()[0].className, "review-marker unchanged sent", "re-anchored in place, not moved or gone");
});

await check("review comments (mounted): Settings turns the feature off and on at once; off is the ED1 click", async () => {
  const v1 = PROCS.slice(); v1[7] = "  SELECT 22";
  const h = changesPane({ diff: diffOf(PROCS, v1) });
  await h.dom.settle();
  await h.comment(h.newRow(8), "why 22?");
  assert.equal(h.markers().length, 1);
  h.toggle(false);
  assert.equal(h.markers().length, 0, "off: no markers");
  assert.equal(h.bar(), null, "off: no review bar");
  assert.equal(h.oldRow(8), null, "off: removed lines carry no control");
  h.dom.click(h.newRow(8));
  assert.ok(h.q(".fix-line") && !h.q(".review-form"), "off: a click opens ED1's Fix this line");
  h.toggle(true);
  assert.equal(h.markers().length, 1, "on again: the comment is still there");
});

await check("review comments (mounted): a repository switch while a diff is still loading shows the new repository's diff (7.2)", async () => {
  let releaseA;
  let slowA = false;
  const h = changesPane({
    repos: [{ id: "a", label: "A", rel: "a" }, { id: "b", label: "B", rel: "b" }],
    files: { a: ["v.sql"], b: ["v.sql"] },
    diff: (repo) => {
      const text = diffOf(["x"], [`from ${repo}`]);
      if (repo === "a" && slowA) return new Promise((done) => { releaseA = () => done(text); });
      return text;
    },
  });
  await h.dom.settle();
  assert.match(h.box.textContent, /from a/);
  slowA = true;
  h.dom.click(h.box.querySelectorAll("li.change-file")[0]);
  await h.dom.settle();
  const picker = h.q("select");
  h.dom.fire(picker, "change", { target: { value: "b" } });
  await h.dom.settle();
  assert.match(h.box.textContent, /from b/);
  releaseA();
  await h.dom.settle();
  assert.match(h.box.textContent, /from b/, "the late answer for repository a is dropped");
  assert.doesNotMatch(h.box.textContent, /from a/);
});

await check("review comments: a deleted commented line is moved or gone, even when END and GO repeat below (3.3)", () => {
  // Proc c is edited too, so its END and GO are inside the diff, within 20 lines.
  const v1 = PROCS.slice(); v1[7] = "  SELECT 22"; v1[12] = "  SELECT 33";
  const m1 = modelOf(PROCS, v1);
  const comment = { side: "new", from: 8, to: 8, ...commentContext(m1, "new", 8, 8) };
  assert.deepEqual(comment.after, ["END", "GO"]);
  const gone = v1.slice(); gone.splice(7, 1);
  const m2 = modelOf(PROCS, gone);
  assert.ok([12, 13].every((line) => sideLines(m2, "new").has(line)), "proc c's END and GO are in the new diff");
  assert.equal(reanchorComment(comment, m2).status, "moved", "not 'changed' over proc c's lines");
});

rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} desktop pane tests passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
if (failed) process.exit(1);
