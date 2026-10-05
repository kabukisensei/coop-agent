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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { listChanges, fileDiff, parseNameStatus, parseNumstat, newFileDiff } = await import("../desktop/lib/changes.mjs");
const { readStandards, readSnapshot, readNote, listNotes, knowledgeView, domainView, DOMAINS, KNOWLEDGE_LABELS } = await import("../desktop/lib/standards-view.mjs");
const { loadProject, previewProject, saveProject, settingsFromForm } = await import("../desktop/lib/project-form.mjs");
const docs = await import("../desktop/lib/docs-setup.mjs");
const { normalizePath } = await import("../desktop/renderer/pane-changes.mjs");
const { articleOutline, sourceLine, noteLabel, isKnowledgeId, STATE_LABELS, KNOWLEDGE_STATE_LABELS } = await import("../desktop/renderer/pane-standards.mjs");
const { initialValues, formInput, platformHint, ROLE_LABELS } = await import("../desktop/renderer/pane-project.mjs");
const { resolvePage, isDocsLink, stripFrontMatter, answerLabel, typeLabel } = await import("../desktop/renderer/pane-docs.mjs");
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

await check("changes: a tool call's path finds its file in the list", () => {
  assert.equal(normalizePath("C:\\Work\\Repo\\src\\a.sql", "c:\\work\\repo"), "src/a.sql");
  assert.equal(normalizePath("/w/repo/docs/x.md", "/w/repo/"), "docs/x.md");
  assert.equal(normalizePath("./sql/b.sql", "/w/repo"), "sql/b.sql");
  assert.equal(normalizePath("@sql/b.sql", "/w/repo"), "sql/b.sql");
  assert.equal(normalizePath("/elsewhere/x.md", "/w/repo"), "", "outside the folder: not in the list");
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
  assert.deepEqual(calls.map((c) => c[0]), ["resolve-many", "status"]);
  assert.equal(calls[0][1], DOMAINS.join(","));
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
  for (const state of ["canonical", "project_override", "stale_last_known_good", "bundled", "auth_required", "unavailable"]) assert.ok(STATE_LABELS[state], state);
  // A resolver failure is an error the pane shows, not a crash.
  await assert.rejects(readStandards({ node: process.execPath, repoRoot: ROOT, cwd: temp, env: process.env, execFileImpl: (f, a, o, cb) => cb(new Error("x"), "", "registry unreadable\n") }), /registry unreadable/);
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

const ANSWERS = {
  client: "Contoso",
  analytics: { description: "Warehouse SQL", role: "mixed", localPath: ".", remoteName: "origin", defaultBranch: "main" },
  added: { name: "Reports Repo", description: "Power BI reports", role: "powerbi", localPath: "../reports", remoteName: "origin", defaultBranch: "release" },
  fabric: { tenantId: "11111111-1111-1111-1111-111111111111", fabricWorkspaceName: "Contoso WS", fabricWorkspaceId: "22222222-2222-2222-2222-222222222222", sqlEndpointItemType: "Warehouse", sqlEndpointItemName: "ContosoDW", sqlEndpointItemId: "33333333-3333-3333-3333-333333333333", sqlEndpointPropertiesId: "", powerBiWorkspaceName: "Contoso WS", powerBiWorkspaceId: "" },
  target: { sqlTargetKind: "azure_sql", sqlTargetServer: "Contoso-Dev.Database.Windows.Net", sqlTargetDatabase: "ContosoDW" },
  te: { tabularEditorPath: "te", bpaRulesPath: "rules/bpa.json" },
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
        for (const [key, value] of Object.entries({ ...ANSWERS.fabric, ...ANSWERS.target, ...ANSWERS.te })) {
          const prompts = {
            tenantId: "Azure tenant ID", fabricWorkspaceName: "Default Fabric workspace name", fabricWorkspaceId: "Default Fabric workspace ID",
            sqlEndpointItemType: "Default SQL endpoint item type", sqlEndpointItemName: "Default SQL endpoint item name", sqlEndpointItemId: "Default SQL endpoint item ID",
            sqlEndpointPropertiesId: "Lakehouse sqlEndpointProperties.id", powerBiWorkspaceName: "Default Power BI workspace name", powerBiWorkspaceId: "Default Power BI workspace ID",
            sqlTargetKind: "Dev SQL target kind", sqlTargetServer: "Dev SQL server host", sqlTargetDatabase: "Dev database name",
            tabularEditorPath: "Tabular Editor CLI command or path", bpaRulesPath: "BPA rules file path",
          };
          if (!fresh && label.startsWith(prompts[key])) return value;
        }
        return def;
      },
      confirm: async (title) => {
        if (title === "Local source folders") return localSource;
        if (title.startsWith("Repository: ")) return !fresh;
        if (title === "Repositories") return !fresh && addCount++ === 0;
        if (title === "Microsoft Fabric / Power BI") return !fresh;
        if (title === "Tabular Editor") return !fresh;
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
  Object.assign(values, ANSWERS.fabric, ANSWERS.target, ANSWERS.te, { fabricEnabled: true, tabularEditorEnabled: true });
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
  assert.deepEqual(data.guardrailFields.sort(), ["client", "commitLists", "repositories.localPath", "sqlTargetDatabase", "sqlTargetKind", "sqlTargetServer", "tenantId"]);
  const shown = JSON.stringify(data);
  for (const dropped of ["live_discovery", "allowed_default_actions", "requires_approval_actions", "list_workspaces", "run_query", "future_setting", "custom_profile_key"]) {
    assert.equal(shown.includes(dropped), false, `${dropped} reaches the window`);
  }
  const input = formInput(initialValues(data));
  assert.deepEqual(Object.keys(input).sort(), ["bpaRulesPath", "client", "defaultBranch", "fabricEnabled", "fabricWorkspaceId", "fabricWorkspaceName", "organization", "powerBiWorkspaceId", "powerBiWorkspaceName", "profileName", "repositories", "sqlEndpointItemId", "sqlEndpointItemName", "sqlEndpointItemType", "sqlEndpointPropertiesId", "sqlTargetDatabase", "sqlTargetKind", "sqlTargetServer", "tabularEditorEnabled", "tabularEditorPath", "tenantId", "timezone"]);
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
  assert.equal(saved.backup, join(viaForm, ".coop", "project.yml.bak"));
  assert.equal(readFileSync(saved.backup, "utf8"), ORIGINAL, "the old file is backed up");
  const written = readFileSync(join(viaForm, ".coop", "project.yml"), "utf8");
  assert.equal(written, expected, "the form and /setup-project write the same contract");

  // What the guardrails read, and what neither owns.
  assert.equal(projectYamlScalar(written, ["profile", "client"]), "Contoso");
  assert.equal(projectYamlScalar(written, ["repositories", "Reports-Repo", "local_path"]), "../reports");
  assert.equal(projectYamlScalar(written, ["sql_targets", "dev", "server"]), "contoso-dev.database.windows.net");
  for (const kept of ["# keep this client comment", "custom_profile_key: 'keep-me'", "- 'special-docs/**'", "agent_never_commit: ['secrets/**', 'bin/**']", "live_discovery:", "allowed_default_actions:", "future_setting: 42"]) {
    assert.ok(written.includes(kept), `unowned text kept: ${kept}`);
  }
  // The review diff is exactly the change.
  const model = parseUnifiedDiff(preview.diff);
  assert.ok(model.hunks.flatMap((h) => h.lines).some((l) => l.type === "add" && l.text.includes("Contoso")));
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
  assert.deepEqual(docs.docsLocation(cwd, process.env), { config: join(cwd, "coop-data-doc.yml"), exists: false, outputDir: join(cwd, "data-docs"), built: false, portal: "" });
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
  const handled = new Set([...main.matchAll(/handle\("(coop:[a-z-]+)"/g)].map((m) => m[1]));
  for (const channel of ["coop:changes", "coop:change-diff", "coop:standards", "coop:standards-text", "coop:knowledge-note", "coop:project-load", "coop:project-preview", "coop:project-save", "coop:pick-folder", "coop:docs-start", "coop:docs-answer", "coop:docs-cancel", "coop:docs-build", "coop:docs-page", "coop:docs-portal"]) {
    assert.ok(invoked.includes(channel), `preload exposes ${channel}`);
  }
  for (const channel of invoked) assert.ok(handled.has(channel), `main handles ${channel}`);
  // Only the two forms write, and only through their writers.
  for (const lib of ["changes.mjs", "standards-view.mjs", "text-diff.mjs"]) {
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
  const css = readFileSync(join(ROOT, "desktop", "renderer", "styles", "app.css"), "utf8");
  for (const variable of ["--sidebar-width", "--pane-width", "--change-list-height"]) assert.ok(css.includes(`var(${variable}`), `app.css sizes with ${variable}`);
  assert.equal(/grid-template-columns: 264px/.test(css), false, "the sidebar column follows --sidebar-width");
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

rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} desktop pane tests passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
if (failed) process.exit(1);
