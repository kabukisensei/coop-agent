// Runtime tests for the shared project file in coop-tools (master plan C1):
// /project-share and /project-get, the wizard's "Get the team's project file"
// offer, and the session-start note. Real git with a local bare origin; the
// bundle under COOP_TEST_DIST (tests/run.sh builds it).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "coop-project-share-rt-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.COOP_DIR = join(tmp, "profile-home");
delete process.env.COOP_PROJECT_YML;
const { default: coopTools, projectFileNote, runProjectWizard } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

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
// Fixture identity, and LF in the working tree: Git for Windows defaults core.autocrlf to true,
// which would hand the assertions CRLF after a pull.
const identity = (cwd) => { git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test User"); git(cwd, "config", "core.autocrlf", "false"); };
// The fetch is throttled on .git/FETCH_HEAD's age; a test that needs origin's
// latest state removes it first, as a fresh clone has none.
const unthrottle = (cwd) => rmSync(join(cwd, ".git", "FETCH_HEAD"), { force: true });
const CONTRACT = "profile:\n  organization: 'Cooptimize'\n  client: 'Contoso'\n  default_branch: 'main'\nrepositories:\n  a:\n    description: 'Project source and docs'\n    role: 'generic'\n    local_path: '.'\n    remote_name: 'origin'\n    default_branch: 'main'\ntools:\n  fabric_cli:\n    enabled: false\n  tabular_editor_cli:\n    enabled: false\n";

const commands = new Map();
const handlers = new Map();
const pi = {
  registerTool: () => {},
  registerCommand: (name, config) => commands.set(name, config),
  on: (name, handler) => handlers.set(name, handler),
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  sendUserMessage: () => {},
  sendMessage: () => {},
};
coopTools(pi);

const makeCtx = (cwd, answers = []) => {
  const notes = [];
  const titles = [];
  return {
    notes,
    titles,
    cwd,
    hasUI: true,
    mode: "tui",
    ui: {
      input: async (_label, def) => def,
      confirm: async (title, message) => { titles.push(`${title}\n${message}`); return answers.shift() ?? false; },
      notify: (message) => notes.push(message),
      select: async () => "Not now",
    },
  };
};

if (spawnSync("git", ["--version"]).status !== 0) {
  console.log("  – git not available; skipping project-share runtime tests");
  process.exit(0);
}

try {
  const origin = join(tmp, "origin.git");
  git(tmp, "init", "--bare", "--initial-branch=main", "origin.git");
  const a = join(tmp, "a");
  git(tmp, "clone", "-c", "core.autocrlf=false", "--quiet", origin, "a");
  identity(a);
  writeFileSync(join(a, "README.md"), "# a\n");
  git(a, "add", "README.md");
  git(a, "commit", "--quiet", "-m", "init");
  git(a, "push", "--quiet", "origin", "main");

  await t("/project-share and /project-get are registered; /project-share without a contract explains /setup-project", async () => {
    assert.ok(commands.has("project-share") && commands.has("project-get"));
    const ctx = makeCtx(a);
    await commands.get("project-share").handler("", ctx);
    assert.ok(ctx.notes.some((m) => m.includes("No .coop/project.yml here") && m.includes("/setup-project")), ctx.notes.join("\n"));
  });

  await t("/project-share commits only .coop/project.yml after the yes and pushes it", async () => {
    mkdirSync(join(a, ".coop"));
    writeFileSync(join(a, ".coop", "project.yml"), CONTRACT);
    writeFileSync(join(a, "notes.txt"), "never shared\n");
    const declined = makeCtx(a, [false]);
    await commands.get("project-share").handler("", declined);
    assert.ok(declined.notes.some((m) => m.startsWith("Not shared. Nothing was committed")), declined.notes.join("\n"));
    assert.ok(git(a, "status", "--porcelain").includes("?? .coop/"), "declining leaves the file uncommitted");
    const ctx = makeCtx(a, [true]);
    await commands.get("project-share").handler("", ctx);
    assert.ok(ctx.titles[0].startsWith("Share with the team"), ctx.titles.join("\n"));
    assert.ok(ctx.notes.some((m) => m.startsWith("Shared .coop/project.yml with the team") && m.includes("pushed to main")), ctx.notes.join("\n"));
    assert.equal(git(a, "log", "-1", "--format=%s"), "coop: project file updated by Test User");
    assert.equal(git(a, "show", "--name-only", "--format=", "HEAD"), ".coop/project.yml");
    assert.equal(git(a, "status", "--porcelain").trim(), "?? notes.txt", "the other file stays untouched");
    assert.equal(git(a, "rev-parse", "HEAD"), git(a, "rev-parse", "origin/main"));
    const audit = readFileSync(join(tmp, "agent", "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(audit.some((row) => row.kind === "project-share" && row.decision === "allowed" && row.detail === "push main"), JSON.stringify(audit));
    const again = makeCtx(a, [true]);
    await commands.get("project-share").handler("", again);
    assert.ok(again.notes.some((m) => m.includes("already matches the team's")), again.notes.join("\n"));
  });

  const b = join(tmp, "b");
  git(tmp, "clone", "-c", "core.autocrlf=false", "--quiet", origin, "b");
  identity(b);
  // b was cloned before the share: the team has the file, this checkout does not.
  git(b, "reset", "--quiet", "--hard", "HEAD~1");

  await t("the session-start note says the team has a project file this checkout lacks", async () => {
    unthrottle(b);
    const note = projectFileNote(b);
    assert.equal(note && note.state, "team-has-it", JSON.stringify(note));
    assert.ok(note.text.includes("/project-get"));
    const ctx = makeCtx(b);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    assert.ok(ctx.notes.some((m) => m.includes("The team already has .coop/project.yml")), ctx.notes.join("\n"));
    process.env.COOP_PROJECT_SYNC = "0";
    assert.equal(projectFileNote(b), null, "COOP_PROJECT_SYNC=0 silences the note");
    delete process.env.COOP_PROJECT_SYNC;
  });

  await t("/project-get brings the team's file in with a fast-forward pull when nothing else would move", async () => {
    const ctx = makeCtx(b);
    await commands.get("project-get").handler("", ctx);
    assert.ok(ctx.notes.some((m) => m.startsWith("Got the team's project file (fast-forward pull)") && m.includes("/new")), ctx.notes.join("\n"));
    assert.equal(readFileSync(join(b, ".coop", "project.yml"), "utf8"), CONTRACT);
    assert.equal(git(b, "rev-parse", "HEAD"), git(b, "rev-parse", "origin/main"));
    assert.equal(projectFileNote(b), null, "shared: nothing to say");
    const again = makeCtx(b);
    await commands.get("project-get").handler("", again);
    assert.ok(again.notes.some((m) => m.includes("already matches the team's")), again.notes.join("\n"));
  });

  await t("local edits: the note says not shared; /project-get asks before replacing and keeps a backup", async () => {
    writeFileSync(join(b, ".coop", "project.yml"), CONTRACT.replace("'Contoso'", "'Fabrikam'"));
    const note = projectFileNote(b);
    assert.equal(note && note.state, "not-shared", JSON.stringify(note));
    const kept = makeCtx(b, [false]);
    await commands.get("project-get").handler("", kept);
    assert.ok(kept.titles[0].startsWith("Replace your edits?"), kept.titles.join("\n"));
    assert.ok(kept.notes.some((m) => m === "Kept your version."), kept.notes.join("\n"));
    assert.ok(readFileSync(join(b, ".coop", "project.yml"), "utf8").includes("Fabrikam"));
    const replaced = makeCtx(b, [true]);
    await commands.get("project-get").handler("", replaced);
    assert.ok(replaced.notes.some((m) => m.startsWith("Got the team's project file (only .coop/project.yml changed)") && m.includes("backup:")), replaced.notes.join("\n"));
    assert.equal(readFileSync(join(b, ".coop", "project.yml"), "utf8"), CONTRACT);
    assert.ok(existsSync(join(b, ".coop")), "backup kept beside the file");
    assert.equal(git(b, "diff", "--name-only", "--", ".coop/project.yml"), "", "the file is back to the committed content");
  });

  await t("a newer team copy: the note warns and /project-get moves only that file on a dirty checkout", async () => {
    git(a, "pull", "--quiet", "--ff-only", "origin", "main");
    writeFileSync(join(a, ".coop", "project.yml"), CONTRACT.replace("America", "Europe").replace("'Contoso'", "'Contoso Europe'"));
    const share = makeCtx(a, [true]);
    await commands.get("project-share").handler("", share);
    assert.ok(share.notes.some((m) => m.startsWith("Shared .coop/project.yml")), share.notes.join("\n"));
    writeFileSync(join(b, "README.md"), "# b, edited and uncommitted\n"); // dirty checkout: no pull
    unthrottle(b);
    const note = projectFileNote(b);
    assert.equal(note && note.state, "team-newer", JSON.stringify(note));
    const ctx = makeCtx(b);
    await commands.get("project-get").handler("", ctx);
    assert.ok(ctx.notes.some((m) => m.startsWith("Got the team's project file (only .coop/project.yml changed)")), ctx.notes.join("\n"));
    assert.ok(readFileSync(join(b, ".coop", "project.yml"), "utf8").includes("Contoso Europe"));
    assert.ok(readFileSync(join(b, "README.md"), "utf8").includes("edited and uncommitted"), "the dirty file is untouched");
    assert.notEqual(git(b, "rev-parse", "HEAD"), git(b, "rev-parse", "origin/main"), "no pull on a dirty checkout");
  });

  await t("/setup-project in a fresh clone offers the team's project file before creating one", async () => {
    const c = join(tmp, "c");
    git(tmp, "clone", "-c", "core.autocrlf=false", "--quiet", origin, "c");
    identity(c);
    git(c, "reset", "--quiet", "--hard", "HEAD~2");
    assert.equal(existsSync(join(c, ".coop", "project.yml")), false);
    // get the team's file yes; then the wizard edits it in place: edit repo no, add repo no, Fabric no, TE no, write no
    const ctx = makeCtx(c, [true, false, false, false, false, false]);
    await runProjectWizard(pi, ctx);
    assert.ok(ctx.titles[0].startsWith("The team's project file"), ctx.titles.join("\n---\n"));
    assert.ok(ctx.notes.some((m) => m.startsWith("Got the team's project file")), ctx.notes.join("\n"));
    assert.ok(readFileSync(join(c, ".coop", "project.yml"), "utf8").includes("Contoso Europe"));
    assert.ok(ctx.notes.some((m) => m.startsWith("Edit this Coop project")), "the wizard then edits the team's file, never a second copy: " + ctx.notes.join("\n"));
    const declined = join(tmp, "d");
    git(tmp, "clone", "-c", "core.autocrlf=false", "--quiet", origin, "d");
    identity(declined);
    git(declined, "reset", "--quiet", "--hard", "HEAD~2");
    const ctx2 = makeCtx(declined, [false]);
    await runProjectWizard(pi, ctx2);
    assert.equal(existsSync(join(declined, ".coop", "project.yml")), false, "declining the get creates nothing by itself");
    assert.ok(ctx2.notes.some((m) => m.startsWith("Set up this Coop project")), ctx2.notes.join("\n"));
  });

  console.log(`project-share runtime: ${n} passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
