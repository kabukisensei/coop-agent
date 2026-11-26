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
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

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
console.log(`✓ client instructions and the guardrails: ${n} checks`);
