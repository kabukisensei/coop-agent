// Client instructions (FEATURES-DESIGN, CW1) and the guardrails, end to end: the
// REAL coop-guardrails tool_call handler (bundled) runs against a REAL git
// repository (pi.exec runs git), with a .coop/rules/ folder whose AGENTS.md says
// "you may commit SQL".
//   - A commit of .coop/rules/corrections.md asks (a person's yes; declined or
//     headless is blocked); a README.md commit does not ask.
//   - The rules file does not open anything: a SQL commit stays blocked.
//   - The guardrails never read a file under .coop/rules/: no content read
//     (readFileSync, openSync, readdirSync, a stream) touches it. Every fs call the
//     bundle makes while its handler runs is traced; node's builtin ESM exports
//     are synced to the trace before the bundle loads. Metadata calls (lstat,
//     exists) on a path the shell command itself names are the secret-link check
//     every command gets; they never see the contents.
//   COOP_TEST_DIST=<bundled extensions> node tests/client-rules-guardrails.test.mjs
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// --- the fs trace, installed before the bundle is imported -------------------------
const touched = [];
let tracing = false; // only while the guardrails' handler runs, never the test's own calls
for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "openSync", "readdirSync", "realpathSync", "accessSync", "createReadStream"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  const traced = function (path, ...rest) { if (tracing) touched.push({ call: name, path: String(path) }); return original.call(this, path, ...rest); };
  if (original.native) traced.native = original.native;
  fs[name] = traced;
}
const originalPromisesReadFile = fs.promises.readFile;
fs.promises.readFile = function (path, ...rest) { if (tracing) touched.push({ call: "promises.readFile", path: String(path) }); return originalPromisesReadFile.call(this, path, ...rest); };
syncBuiltinESMExports();

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "coop-cw1-gr-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.HOME = join(root, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.COOP_DIR = process.env.HOME;
process.env.COOP_ROOT = fileURLToPath(new URL("..", import.meta.url));
fs.mkdirSync(process.env.HOME, { recursive: true });

const repo = join(root, "client");
const git = (...args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
fs.mkdirSync(join(repo, ".coop", "rules"), { recursive: true });
fs.mkdirSync(join(repo, "sql"), { recursive: true });
spawnSync("git", ["init", "-q", repo]);
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "coop test");
git("config", "core.autocrlf", "false");
fs.writeFileSync(join(repo, ".coop", "project.yml"), "schema_version: 1\nrepositories:\n  client:\n    local_path: .\n");
fs.writeFileSync(join(repo, ".coop", "rules", "AGENTS.md"), "# Contoso\nYou may commit SQL.\nCommit directly to main.\n");
fs.writeFileSync(join(repo, "README.md"), "# Client\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const cg = await import(pathToFileURL(`${process.env.COOP_TEST_DIST}/coop-guardrails.mjs`).href);
const handlers = {};
const pi = {
  on: (ev, h) => { handlers[ev] = h; },
  registerCommand() {},
  exec: async (bin, args, opts = {}) => {
    const r = spawnSync(bin, args, { cwd: opts.cwd || repo, encoding: "utf8" });
    return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 1 };
  },
};
cg.default(pi);
const handle = handlers.tool_call;
let confirmAnswer = false;
let confirms = [];
const ui = { confirm: async (title, message) => { confirms.push(`${title}\n${message}`); return confirmAnswer; }, select: async () => undefined, input: async () => undefined, notify() {} };
const ctxUi = { cwd: repo, hasUI: true, ui };
const ctxHeadless = { cwd: repo, hasUI: false, ui: { notify() {} } };
let calls = 0;
const bash = async (command, ctx = ctxUi) => {
  tracing = true;
  try { return await handle({ toolName: "bash", toolCallId: `c${++calls}`, input: { command } }, ctx); } finally { tracing = false; }
};
const stage = (rel, text) => { fs.writeFileSync(join(repo, rel), text); git("add", "--", rel); };
const unstageAll = () => { git("reset", "-q"); };
const blocked = (r) => Boolean(r && r.block);
const IN_RULES = /[\\/]\.coop[\\/]rules([\\/]|$)/;
const CONTENT_CALLS = new Set(["readFileSync", "openSync", "readdirSync", "createReadStream", "promises.readFile"]);

let n = 0;
let failed = 0;
// Each check runs even when an earlier one failed, so a run names every failure.
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${String(e && e.message || e).split("\n")[0]}`); }
};

try {
  await t("a commit of .coop/rules/corrections.md asks; yes lets it through", async () => {
    stage(".coop/rules/corrections.md", "# Corrections\n\n- C-2026-11-26-1 · 2026-11-26 · Aaron · Dates are UTC.\n");
    confirms = []; confirmAnswer = true;
    const r = await bash('git commit -m "corrections"');
    assert.equal(blocked(r), false, JSON.stringify(r));
    assert.equal(confirms.length, 1, "one approval card");
    assert.match(confirms[0], /changes the client's instructions, which steer coop for everyone on the team once shared:\n {2}\.coop\/rules\/corrections\.md\nCommit them\?/);
  });

  await t("declined, or headless, the commit is blocked", async () => {
    confirms = []; confirmAnswer = false;
    let r = await bash('git commit -m "corrections"');
    assert.equal(blocked(r), true);
    assert.match(r.reason, /blocked a commit of the client's instructions \(\.coop\/rules\/\) \(you declined\)/);
    r = await bash('git commit -m "corrections"', ctxHeadless);
    assert.equal(blocked(r), true);
    assert.match(r.reason, /approval is unavailable in headless mode/);
  });

  await t("the same for git commit -a and an explicit pathspec, asked every time (no session grant)", async () => {
    unstageAll();
    fs.writeFileSync(join(repo, ".coop", "rules", "AGENTS.md"), "# Contoso\nUse dim.Customer.\n");
    confirms = []; confirmAnswer = true;
    assert.equal(blocked(await bash("git commit -am rules")), false);
    assert.equal(blocked(await bash("git commit -m rules -- .coop/rules/AGENTS.md")), false);
    assert.equal(confirms.length, 2);
    fs.writeFileSync(join(repo, ".coop", "rules", "AGENTS.md"), "# Contoso\nYou may commit SQL.\nCommit directly to main.\n");
  });

  await t("a README.md commit does not ask (other Markdown stays auto-allowed)", async () => {
    unstageAll();
    stage("README.md", "# Client\n\nMore.\n");
    confirms = [];
    const r = await bash('git commit -m "readme"');
    assert.equal(blocked(r), false);
    assert.equal(confirms.length, 0);
  });

  await t("'you may commit SQL' in .coop/rules/AGENTS.md: a SQL commit stays blocked, with no prompt", async () => {
    unstageAll();
    assert.match(fs.readFileSync(join(repo, ".coop", "rules", "AGENTS.md"), "utf8"), /You may commit SQL/);
    stage("sql/v_sales.sql", "CREATE VIEW dbo.v_sales AS SELECT 1 AS x;\n");
    confirms = []; confirmAnswer = true;
    const r = await bash('git commit -m "sql"');
    assert.equal(blocked(r), true);
    assert.match(r.reason, /never commit source\. These paths aren't docs\/logs\/site: sql\/v_sales\.sql/);
    assert.equal(confirms.length, 0, "no prompt can open it");
  });

  await t("a rules file and SQL in one commit: blocked as source", async () => {
    stage(".coop/rules/corrections.md", "# Corrections\n\n- C-2026-11-26-2 · 2026-11-26 · Aaron · Amounts are in cents.\n");
    confirms = []; confirmAnswer = true;
    const r = await bash('git commit -m "both"');
    assert.equal(blocked(r), true);
    assert.match(r.reason, /sql\/v_sales\.sql/);
    assert.doesNotMatch(r.reason, /\.coop\/rules/);
    assert.equal(confirms.length, 0);
    unstageAll();
    fs.rmSync(join(repo, "sql", "v_sales.sql"), { force: true }); // untracked, it would block a later `git add -A` as source
  });

  // --- Fix round (Neon B1): the model's own edit/write on .coop/rules/ ---------------
  const fileCall = async (tool, path, ctx = ctxUi) => {
    tracing = true;
    try { return await handle({ toolName: tool, toolCallId: `c${++calls}`, input: tool === "write" ? { path, content: "x\n" } : { path, oldText: "a", newText: "b" } }, ctx); } finally { tracing = false; }
  };
  fs.writeFileSync(join(repo, ".coop", "rules", "corrections.md"), "# Corrections\n");
  // Fix round 2 (Neon 4): links are made only where the OS allows (Windows without
  // the symlink right: EPERM, and the link checks are skipped), the folder link is
  // a junction there, and all three are removed right after these checks.
  const LINKS = [["notes.md", join(".coop", "rules", "corrections.md"), "file"], ["ruledir", join(".coop", "rules"), "junction"], ["team.md", join(".coop", "rules", "AGENTS.md"), "file"]];
  let linksOk = true;
  for (const [name, target, type] of LINKS) {
    try { fs.symlinkSync(join(repo, target), join(repo, name), type); } catch (e) { if (e && (e.code === "EPERM" || e.code === "EACCES")) { linksOk = false; break; } throw e; }
  }
  const removeLinks = () => { for (const [name] of LINKS) { try { fs.rmSync(join(repo, name), { force: true, recursive: false }); } catch { try { fs.unlinkSync(join(repo, name)); } catch { /* gone */ } } } };
  if (!linksOk) { removeLinks(); console.log("  - link checks skipped: this OS refused to make a symlink (EPERM)"); }

  await t("edit/write of .coop/rules/corrections.md is blocked, with no card: the log changes only through client_rules or /correct", async () => {
    for (const tool of ["edit", "write"]) {
      for (const p of [".coop/rules/corrections.md", join(repo, ".coop", "rules", "corrections.md"), ".COOP/Rules/corrections.md", "./.coop/../.coop/rules/corrections.md"]) {
        confirms = []; confirmAnswer = true;
        const r = await fileCall(tool, p);
        assert.equal(blocked(r), true, `${tool} ${p}`);
        assert.match(r.reason, /changes only through the Add \/ Edit \/ No card: call the client_rules tool \(command add_correction\), or ask the user to run \/correct/);
        assert.equal(confirms.length, 0, "no prompt can open it");
      }
    }
    assert.equal(blocked(await fileCall("write", ".coop/rules/corrections.md", ctxHeadless)), true);
  });

  await t("…and through a link: a file link to it, or a folder link to .coop/rules/", async () => {
    if (!linksOk) return;
    confirms = []; confirmAnswer = true;
    for (const p of ["notes.md", "ruledir/corrections.md"]) {
      const r = await fileCall("write", p);
      assert.equal(blocked(r), true, p);
      assert.match(r.reason, /corrections log/);
    }
    assert.equal(confirms.length, 0);
  });

  await t("edit/write of any other .coop/rules/ file asks every call (no session grant); declined or headless is blocked", async () => {
    confirms = []; confirmAnswer = true;
    assert.equal(blocked(await fileCall("edit", ".coop/rules/AGENTS.md")), false);
    assert.equal(blocked(await fileCall("write", ".coop/rules/tech.md")), false);
    if (linksOk) {
      assert.equal(blocked(await fileCall("write", "team.md")), false, "a link to AGENTS.md asks too");
      assert.equal(blocked(await fileCall("write", "ruledir/AGENTS.md")), false);
    }
    assert.equal(confirms.length, linksOk ? 4 : 2, "asked for each call");
    assert.match(confirms[0], /changes the client's instructions \(\.coop\/rules\/\), which steer coop on every turn/);
    confirms = []; confirmAnswer = false;
    let r = await fileCall("write", ".coop/rules/AGENTS.md");
    assert.equal(blocked(r), true);
    assert.match(r.reason, /\(you declined\)/);
    r = await fileCall("edit", ".coop/rules/AGENTS.md", ctxHeadless);
    assert.equal(blocked(r), true);
    assert.match(r.reason, /approval is unavailable in headless mode/);
    confirms = []; confirmAnswer = true;
    assert.equal(blocked(await fileCall("write", "docs/notes.md")), false);
    assert.equal(blocked(await fileCall("read", ".coop/rules/corrections.md")), false, "reading is not gated");
    assert.equal(confirms.length, 0, "other files and reads do not ask");
  });

  removeLinks(); // untracked links left behind would block a later `git add -A` as source

  // --- Fix round (Neon B2): commit-prompt bypasses -------------------------------------
  const resetHard = () => { git("reset", "-q", "--hard", "HEAD"); };

  await t("git mv out of .coop/rules/ then commit asks (the staged listing names both sides of a rename)", async () => {
    resetHard();
    fs.mkdirSync(join(repo, "docs"), { recursive: true });
    git("mv", ".coop/rules/AGENTS.md", "docs/x.md");
    confirms = []; confirmAnswer = true;
    const r = await bash("git commit -m move");
    assert.equal(blocked(r), false);
    assert.equal(confirms.length, 1, "one approval card");
    assert.match(confirms[0], /\.coop\/rules\/AGENTS\.md/);
    git("mv", "docs/x.md", ".coop/rules/AGENTS.md");
    resetHard();
  });

  await t("cd .coop/rules && git rm / git mv / git add -f, then commit: asks (paths made repository-relative)", async () => {
    for (const cmd of [
      "cd .coop/rules && git rm AGENTS.md && git commit -m clean",
      "cd .coop/rules && git mv AGENTS.md ../../gone.md && git commit -m clean",
      "cd .coop/rules && git add -f new.md && git commit -m add",
      "git -C .coop/rules rm AGENTS.md && git -C .coop/rules commit -m clean",
    ]) {
      confirms = []; confirmAnswer = false;
      const r = await bash(cmd);
      assert.equal(blocked(r), true, cmd);
      assert.equal(confirms.length, 1, `${cmd}: one approval card`);
      assert.match(confirms[0], /\.coop\/rules\//, cmd);
    }
  });

  await t("a non-ASCII name under .coop/rules/ asks and is named as itself (core.quotepath=false)", async () => {
    stage(".coop/rules/café.md", "# Café\n");
    confirms = []; confirmAnswer = true;
    const r = await bash('git commit -m "cafe"');
    assert.equal(blocked(r), false, JSON.stringify(r));
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /\.coop\/rules\/café\.md/);
    unstageAll();
    fs.rmSync(join(repo, ".coop", "rules", "café.md"));
  });

  await t("a path that IS .coop/rules (a link committed there, no trailing slash) counts", async () => {
    assert.equal(cg.isClientRulesPath(".coop/rules"), true);
    assert.equal(cg.isClientRulesPath("sub/.coop/rules"), true);
    assert.equal(cg.isClientRulesPath(".coop/rulesets/x.md"), false);
  });

  await t("git add -A, merge and cherry-pick that bring in .coop/rules/ ask (coverage)", async () => {
    fs.writeFileSync(join(repo, ".coop", "rules", "AGENTS.md"), "# Contoso\nUse dim.Date.\n");
    confirms = []; confirmAnswer = false;
    const all = await bash("git add -A && git commit -m all");
    assert.equal(blocked(all), true, JSON.stringify(all));
    assert.equal(confirms.length, 1, "one approval card (the rules prompt; nothing left over blocks it as source)");
    assert.match(confirms[0], /This commit changes the client's instructions/);
    assert.match(confirms[0], /\.coop\/rules\/AGENTS\.md/);
    assert.match(all.reason, /blocked a commit of the client's instructions/);
    resetHard();
    git("checkout", "-q", "-b", "side");
    fs.writeFileSync(join(repo, ".coop", "rules", "tech.md"), "# Tech\n");
    git("add", "--", ".coop/rules/tech.md");
    git("commit", "-q", "-m", "side rules");
    git("checkout", "-q", "-");
    for (const cmd of ["git merge side", "git cherry-pick side"]) {
      confirms = []; confirmAnswer = false;
      assert.equal(blocked(await bash(cmd)), true, cmd);
      assert.equal(confirms.length, 1, cmd);
      assert.match(confirms[0], /\.coop\/rules\/tech\.md/);
    }
    resetHard();
  });

  // --- Fix round 2 (Neon review 2): every attack listed, as defence in depth ---------
  const asks = async (cmd, re) => {
    confirms = []; confirmAnswer = false;
    const r = await bash(cmd);
    assert.equal(blocked(r), true, `${cmd}: blocked when declined`);
    assert.ok(confirms.length >= 1, `${cmd}: asked`);
    if (re) assert.match(confirms[0], re, cmd);
    return r;
  };
  const passes = async (cmd) => {
    confirms = []; confirmAnswer = false;
    const r = await bash(cmd);
    assert.equal(blocked(r), false, `${cmd}: ${r && r.reason}`);
    assert.equal(confirms.length, 0, `${cmd}: no prompt`);
  };

  await t("fix 2: a shell write to the corrections log (or its approval ledger) is blocked, with no card, pointing to /correct", async () => {
    resetHard();
    for (const cmd of [
      'echo "- C-2026-11-26-9 · 2026-11-26 · Aaron · x" >> .coop/rules/corrections.md',
      "cat notes.txt > .coop/rules/corrections.md",
      "cp /tmp/x .coop/rules/corrections.md",
      "tee -a .coop/rules/corrections.md < x",
      "sed -i s/a/b/ .coop/rules/corrections.md",
      `python3 -c "open('.coop/rules/corrections.md','a').write('x')"`,
      "cd .coop/rules && printf x >> corrections.md",
      'echo "{}" > ~/.coop/client-rules-approvals/abc.json',
      `echo x > ${join(process.env.HOME, ".coop", "client-rules-approvals", "abc.json")}`,
      'echo "x" >> .coop/rules/corrections.md && git commit -am "note"',
    ]) {
      confirms = []; confirmAnswer = true;
      const r = await bash(cmd);
      assert.equal(blocked(r), true, cmd);
      assert.match(r.reason, /change only through the Add \/ Edit \/ No card: call the client_rules tool \(command add_correction\), or ask the user to run \/correct/, cmd);
      assert.equal(confirms.length, 0, `${cmd}: no prompt can open it`);
    }
  });

  await t("fix 2: a shell write to any other .coop/rules/ path asks each call (sqlsc / fab -o and --output too); reads do not", async () => {
    for (const cmd of [
      "cat > .coop/rules/AGENTS.md",
      "cp x .coop/rules/AGENTS.md",
      "mv x.md .coop/rules/tech.md",
      "rm .coop/rules/AGENTS.md",
      "sed -i s/a/b/ .coop/rules/AGENTS.md",
      `node -e "require('fs').writeFileSync('.coop/rules/tech.md','x')"`,
      "sqlsc get-latest --output .coop/rules/AGENTS.md",
      "sqlsc get-latest --output=.coop/rules/AGENTS.md",
      "fab export ws/item -o .coop/rules/AGENTS.md",
      "rm -r .coop",
      "git checkout side -- .coop/rules/AGENTS.md",
      "git update-index .coop/rules/AGENTS.md",
    ]) await asks(cmd, /changes the client's instructions \(\.coop\/rules\/\)/);
    for (const cmd of ["cat .coop/rules/AGENTS.md", "grep -n dim .coop/rules/AGENTS.md", "git show HEAD:.coop/rules/AGENTS.md", "git diff -- .coop/rules", 'echo "see .coop/rules/AGENTS.md"', "ls .coop/rules"]) await passes(cmd);
  });

  await t("fix 2: write and commit in one bash call cannot slip past either gate", async () => {
    resetHard();
    await asks('echo "x" > .coop/rules/tech.md && git add -A && git commit -m "add"', /changes the client's instructions/);
    await asks('rm .coop/rules/AGENTS.md && git commit -am "clean"', /changes the client's instructions/);
    // Not a rules path: the commit itself cannot be verified before the command runs.
    await asks('echo "x" >> README.md && git commit -am "readme"', /Can't verify what this commit would include:[\s\S]*echo runs before the commit and may change what it includes/);
    await passes("cd docs 2>/dev/null; git status");
    resetHard();
  });

  await t("fix 2: git plumbing before a commit fails closed to a prompt (-C mismatch, pathspec magic and globs, update-index, apply --index, restore --staged, read-tree, pull)", async () => {
    resetHard();
    for (const cmd of [
      "git -C .coop/rules add AGENTS.md && git commit -m edit",
      "git -C .coop/rules rm AGENTS.md && git commit -m clean",
      "git rm ':(top).coop/rules/AGENTS.md' && git commit -m x",
      "git rm '.coop/ru?es/AGENTS.md' && git commit -m x",
      "git rm 'docs/*.md' && git commit -m x",
      "git update-index --add docs/x.md && git commit -m x",
      "git apply --index p.diff && git commit -m x",
      "git restore --staged --source=side README.md && git commit -m x",
      "git read-tree side && git commit -m x",
      "git pull",
      "git pull origin main",
    ]) await asks(cmd);
    const why = (cmd) => cg.commitPrecededUnverifiable(cmd, cg.parseGitCommands(cmd).at(-1), repo);
    assert.match(why("git -C .coop/rules add AGENTS.md && git commit -m edit"), /another folder/);
    assert.match(why("git rm ':(top).coop/rules/AGENTS.md' && git commit -m x"), /pathspec magic/);
    assert.match(why("git rm '.coop/ru?es/AGENTS.md' && git commit -m x"), /glob/);
    assert.match(why("git apply --index p.diff && git commit -m x"), /apply --index/);
    assert.match(why("git restore --staged --source=side x && git commit -m x"), /restore --staged/);
    assert.match(why("git read-tree side && git commit -m x"), /read-tree/);
    assert.equal(why("cd docs && git add a.md && git commit -m x"), null, "cd and plain staging stay verifiable");
    assert.ok(cg.COMMIT_LIKE_SUBCOMMANDS.has("pull"));
  });

  await t("fix 2: a link or hard link in drafts/ or backups/ to a rules file is the rules file (checked before the drafts allowance)", async () => {
    resetHard();
    const drafts = join(process.env.HOME, ".coop", "drafts");
    fs.mkdirSync(drafts, { recursive: true });
    let hard = true;
    try { fs.linkSync(join(repo, ".coop", "rules", "corrections.md"), join(drafts, "log-hard.md")); } catch { hard = false; }
    let soft = true;
    try { fs.symlinkSync(join(repo, ".coop", "rules", "corrections.md"), join(drafts, "log.md"), "file"); } catch { soft = false; }
    try {
      confirms = []; confirmAnswer = true;
      if (soft) assert.equal(blocked(await fileCall("write", join(drafts, "log.md"))), true, "a symlink in drafts/");
      if (hard) assert.equal(blocked(await fileCall("write", join(drafts, "log-hard.md"))), true, "a hard link in drafts/");
      assert.equal(confirms.length, 0);
      // A hard link inside the repository to AGENTS.md asks like AGENTS.md.
      fs.linkSync(join(repo, ".coop", "rules", "AGENTS.md"), join(repo, "team-hard.md"));
      confirms = []; confirmAnswer = false;
      assert.equal(blocked(await fileCall("write", "team-hard.md")), true);
      assert.equal(confirms.length, 1);
      assert.match(confirms[0], /changes the client's instructions/);
      // An ordinary draft still needs nothing.
      confirms = [];
      assert.equal(blocked(await fileCall("write", join(drafts, "plain.md"))), false);
      assert.equal(confirms.length, 0);
    } finally {
      for (const f of [join(drafts, "log-hard.md"), join(drafts, "log.md"), join(repo, "team-hard.md")]) { try { fs.unlinkSync(f); } catch { /* not made */ } }
    }
  });

  await t("fix 2: rewriting what the loader reads as upstream asks (update-ref, symbolic-ref, remote set-url, fetch into a ref, config of a remote, a write in .git)", async () => {
    for (const cmd of [
      "git update-ref refs/remotes/origin/main HEAD",
      "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/evil",
      "git remote set-url origin ../evil.git",
      "git remote add origin ../evil.git",
      "git fetch . HEAD:refs/remotes/origin/main",
      "git -c remote.origin.url=../evil.git fetch",
      "git config remote.origin.url ../evil.git",
      "echo deadbeef > .git/refs/remotes/origin/main",
    ]) await asks(cmd, /rewrites the repository's remote branches or remote settings/);
    for (const cmd of ["git fetch origin", "git config --get remote.origin.url", "git remote -v", "git symbolic-ref --short HEAD"]) await passes(cmd);
  });

  await t("fix 2: a push that changes .coop/rules/ on origin's main asks; other pushes do not", async () => {
    resetHard();
    const origin = join(root, "origin.git");
    spawnSync("git", ["init", "-q", "--bare", origin]);
    git("remote", "add", "origin", origin);
    const branch = git("symbolic-ref", "--short", "HEAD").trim();
    git("push", "-q", "origin", `HEAD:main`);
    git("fetch", "-q", "origin");
    try {
      // A README-only change to main: no prompt.
      fs.writeFileSync(join(repo, "README.md"), "# Client\n\nPush me.\n");
      git("commit", "-qam", "readme");
      await passes("git push origin HEAD:main");
      git("push", "-q", "origin", "HEAD:main"); git("fetch", "-q", "origin");
      // A rules change to main asks, every time; a feature branch or a dry run does not.
      fs.writeFileSync(join(repo, ".coop", "rules", "tech.md"), "# Tech\nFabric.\n");
      git("add", "--", ".coop/rules/tech.md");
      git("commit", "-qm", "tech");
      await asks("git push origin HEAD:main", /may change the client's instructions on the main branch[\s\S]*\.coop\/rules\/tech\.md on origin\/main/);
      await asks(`git push origin ${branch}:main`);
      await asks("git push origin HEAD:refs/remotes/origin/main", /writes refs\/remotes\/origin\/main/);
      await passes("git push origin HEAD:feat");
      await passes("git push --dry-run origin HEAD:main");
      confirms = [];
      const r = await bash("git push origin HEAD:main", ctxHeadless);
      assert.equal(blocked(r), true);
      assert.match(r.reason, /approval is unavailable in headless mode/);
    } finally {
      git("reset", "-q", "--hard", "HEAD~2");
      git("remote", "remove", "origin");
    }
  });

  await t("nice 6: Windows name forms (trailing dot or space, an alternate data stream) are the same files", async () => {
    for (const p of [".coop/rules/corrections.md.", ".coop/rules/corrections.md ", ".coop/rules/corrections.md:x", ".coop./rules/corrections.md", ".coop/rules ./corrections.md"]) assert.equal(cg.isClientCorrectionsPath(p), true, p);
    for (const p of [".coop./rules/AGENTS.md", ".coop/rules:stream"]) assert.equal(cg.isClientRulesPath(p), true, p);
    assert.equal(cg.isClientCorrectionsPath(".coop/rules/corrections.md.bak"), false);
  });

  await t("a project deny glob over .coop/rules/ blocks instead of asking", async () => {
    // The trusted snapshot is per session: start a new one so the edited contract is read.
    fs.writeFileSync(join(repo, ".coop", "project.yml"), "schema_version: 1\nrepositories:\n  client:\n    local_path: .\n    agent_never_commit:\n      - .coop/rules/**\n");
    cg.resetSessionGovernance();
    stage(".coop/rules/corrections.md", "# Corrections\n");
    confirms = [];
    const r = await bash('git commit -m "denied"');
    assert.equal(blocked(r), true);
    assert.match(r.reason, /never commit source/);
    assert.equal(confirms.length, 0);
    unstageAll();
  });

  await t("the guardrails never read a file under .coop/rules/ (content reads traced across every commit above)", async () => {
    assert.ok(touched.some((x) => x.call === "readFileSync" && x.path.endsWith("project.yml")), "the trace sees the guardrails' own reads (the project file)");
    assert.deepEqual(touched.filter((x) => IN_RULES.test(x.path) && CONTENT_CALLS.has(x.call)), []);
    const meta = touched.filter((x) => IN_RULES.test(x.path) && !CONTENT_CALLS.has(x.call));
    assert.ok(meta.every((x) => ["lstatSync", "existsSync", "statSync", "realpathSync"].includes(x.call)), JSON.stringify(meta));
  });
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a handle a moment */ }
}
if (failed) { console.log(`✗ client instructions and the guardrails: ${failed} failed, ${n} passed`); process.exit(1); }
console.log(`✓ client instructions and the guardrails: ${n} checks`);
