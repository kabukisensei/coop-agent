// SQL source control commit permissions (2026-11-11): the one shared check
// (lib/sqlsc.mjs sqlscCommitCheck) behind the guard, the readiness lines and the
// repair; the contract repair planner (lib/sqlsc-permissions.mjs); and the
// /sql-source permissions command and sql_source init over isolated temp
// folders. Nothing here runs SQL, sqlsc, git commit or git push: a stub records
// every process the tool starts.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const AUDIT_DIR = mkdtempSync(join(tmpdir(), "coop-sqlperm-audit-"));
process.env.PI_CODING_AGENT_DIR = AUDIT_DIR;
// The per-user folder (switch, remembered project file, contract backups): a fresh one.
const USER_DIR = mkdtempSync(join(tmpdir(), "coop-sqlperm-user-"));
process.env.COOP_DIR = USER_DIR;
delete process.env.COOP_PROJECT_YML;

const sqlsc = await import(new URL("../lib/sqlsc.mjs", import.meta.url).href);
const perm = await import(new URL("../lib/sqlsc-permissions.mjs", import.meta.url).href);
const contractLib = await import(new URL("../lib/project-contract.mjs", import.meta.url).href);
const dist = process.env.COOP_TEST_DIST;
const tools = dist ? await import(pathToFileURL(`${dist}/coop-tools.mjs`).href) : null;
const guards = dist ? await import(pathToFileURL(`${dist}/coop-guardrails.mjs`).href) : null;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

const REQUIRED = ["database/**", "sqlsc.yml", ".gitattributes", ".gitignore"];

/** A client folder: .coop/project.yml with `contract`, and SQL repositories
 *  (folders) each holding a sqlsc.yml with its `folder:`. */
function fixture(contract, repos = { sql: "database" }) {
  const root = mkdtempSync(join(tmpdir(), "coop-sqlperm-"));
  mkdirSync(join(root, ".coop"));
  writeFileSync(join(root, ".coop", "project.yml"), contract);
  for (const [dir, folder] of Object.entries(repos)) {
    mkdirSync(join(root, dir), { recursive: true });
    if (folder !== null) writeFileSync(join(root, dir, "sqlsc.yml"), `# sqlsc\nfolder: ${folder}\ntarget: dev\n`);
  }
  return { root, contract: join(root, ".coop", "project.yml"), config: (dir = "sql") => join(root, dir, "sqlsc.yml"), read: () => readFileSync(join(root, ".coop", "project.yml"), "utf8") };
}

const backups = () => {
  const out = [];
  const walk = (d) => { for (const name of (existsSync(d) ? readdirSync(d, { withFileTypes: true }) : [])) name.isDirectory() ? walk(join(d, name.name)) : out.push(join(d, name.name)); };
  walk(USER_DIR);
  return out.filter((p) => p.endsWith(".bak"));
};

const DB_ONLY = `# Client project file
profile:
  client: 'Sample'   # kept
repositories:
  warehouse:
    description: 'SQL'
    role: sql
    local_path: sql   # the SQL repo
    agent_allowed_to_commit:
      - 'database/**'   # baseline
    agent_never_commit:
      - '**/*.py'
  reports:
    role: powerbi
    local_path: reports
    agent_allowed_to_commit:
      - 'docs/**'
sql_targets:
  default_environment: dev
  dev:
    kind: azure_sql
    server: sample-dev.database.windows.net
    database: Sales
`;

// --- the shared check ------------------------------------------------------------
await t("one check: database/** alone misses the setup files; the four globs pass; deny rules are named", async () => {
  const dbOnly = sqlsc.sqlscCommitCheck({ folder: "database", allowed: ["database/**"] });
  assert.equal(dbOnly.ok, false);
  assert.deepEqual(dbOnly.missing, ["sqlsc.yml", ".gitattributes", ".gitignore"]);
  assert.equal(sqlsc.sqlscCommitCheck({ folder: "database", allowed: REQUIRED }).ok, true);
  assert.deepEqual(sqlsc.sqlscRequiredGlobs("sql/db"), ["sql/db/**", "sqlsc.yml", ".gitattributes", ".gitignore"]);
  const denied = sqlsc.sqlscCommitCheck({ folder: "database", allowed: REQUIRED, denied: ["**/*.sql"] });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.conflicts, ["**/*.sql"]);
  assert.deepEqual(sqlsc.sqlscCommitCheck({ folder: "database", allowed: REQUIRED, denied: ["database/Tables/dbo.Pay.sql"] }).conflicts, ["database/Tables/dbo.Pay.sql"]);
  assert.equal(sqlsc.sqlscCommitCheck({ folder: "database", allowed: [...REQUIRED, "database/*Sample*"].slice(1) }).ok, false, "a glob shaped like the sample names never covers real objects");
});

// --- the planner -----------------------------------------------------------------
await t("existing database/**-only contract: adds exactly the three setup files to that entry; everything else byte for byte", async () => {
  const f = fixture(DB_ONLY);
  const plan = perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract });
  assert.equal(plan.state, "missing");
  assert.equal(plan.repository, "warehouse");
  assert.deepEqual(plan.add, ["sqlsc.yml", ".gitattributes", ".gitignore"]);
  const added = plan.newText.split("\n").filter((l) => !DB_ONLY.split("\n").includes(l));
  assert.deepEqual(added, ["      - 'sqlsc.yml'", "      - '.gitattributes'", "      - '.gitignore'"]);
  assert.equal(plan.newText.replace(added.join("\n") + "\n", ""), DB_ONLY, "only lines were inserted");
  assert.ok(plan.newText.indexOf("'.gitignore'") < plan.newText.indexOf("agent_never_commit:"), "inserted inside the allow list");
  assert.match(plan.diff, /\+ {7}- '\.gitignore'/);
  assert.deepEqual(contractLib.projectYamlList(plan.newText, ["repositories", "reports", "agent_allowed_to_commit"]), ["docs/**"], "the sibling entry is untouched");
  const again = perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract });
  assert.equal(f.read(), DB_ONLY, "planning writes nothing");
  writeFileSync(f.contract, plan.newText);
  assert.equal(perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract }).state, "ok", "idempotent: a second run has nothing to add");
  assert.equal(again.state, "missing");
});

await t("fresh entry with no allow list, flow lists and CRLF files are extended in place", async () => {
  const fresh = fixture("repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n\n# next section\nprofile:\n  client: x\n");
  const p1 = perm.sqlscPermissionPlan({ configFile: fresh.config(), contractPath: fresh.contract });
  assert.deepEqual(p1.add, REQUIRED);
  assert.match(p1.newText, /local_path: sql\n {4}agent_allowed_to_commit:\n {6}- 'database\/\*\*'\n {6}- 'sqlsc\.yml'\n {6}- '\.gitattributes'\n {6}- '\.gitignore'\n\n# next section/);
  const flow = fixture("repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit: [\"database/**\"]  # set by hand\n");
  const p2 = perm.sqlscPermissionPlan({ configFile: flow.config(), contractPath: flow.contract });
  assert.match(p2.newText, /agent_allowed_to_commit: \["database\/\*\*", 'sqlsc\.yml', '\.gitattributes', '\.gitignore'\] {2}# set by hand\n/);
  const crlf = fixture(DB_ONLY.replace(/\n/g, "\r\n"));
  const p3 = perm.sqlscPermissionPlan({ configFile: crlf.config(), contractPath: crlf.contract });
  assert.equal(p3.state, "missing");
  assert.ok(!/[^\r]\n/.test(p3.newText), "CRLF kept on every line");
});

await t("alternate scripts folder comes from sqlsc.yml, never a hard-coded database/", async () => {
  const f = fixture("repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit:\n      - 'database/**'\n", { sql: "src/schema" });
  const plan = perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract });
  assert.equal(plan.folder, "src/schema");
  assert.deepEqual(plan.add, ["src/schema/**", "sqlsc.yml", ".gitattributes", ".gitignore"]);
  assert.match(sqlsc.commitLine(f.config(), f.contract).line, /\["src\/schema\/\*\*", "sqlsc\.yml"/);
});

await t("sibling SQL repositories: each sqlsc.yml maps to its own entry; one grant never covers the other", async () => {
  const f = fixture(`repositories:
  sales:
    role: sql
    local_path: sales-sql
    agent_allowed_to_commit: ['database/**', 'sqlsc.yml', '.gitattributes', '.gitignore']
  finance:
    role: sql
    local_path: finance-sql
`, { "sales-sql": "database", "finance-sql": "scripts" });
  assert.equal(perm.sqlscPermissionPlan({ configFile: f.config("sales-sql"), contractPath: f.contract }).state, "ok");
  const fin = perm.sqlscPermissionPlan({ configFile: f.config("finance-sql"), contractPath: f.contract });
  assert.equal(fin.repository, "finance");
  assert.deepEqual(fin.add, ["scripts/**", "sqlsc.yml", ".gitattributes", ".gitignore"]);
  assert.deepEqual(contractLib.projectYamlList(fin.newText, ["repositories", "sales", "agent_allowed_to_commit"]), REQUIRED, "the sibling entry is unchanged");
  const ready = perm.sqlSourceReadiness(f.contract, f.read());
  assert.deepEqual(Object.keys(ready).sort(), ["finance", "sales"]);
  assert.equal(ready.sales.state, "ok");
  assert.equal(ready.finance.state, "missing");
  assert.match(ready.finance.note, /\/sql-source permissions/);
});

await t("conflicting deny rules: no change offered, the rule is named, nothing removed", async () => {
  for (const deny of ["'**/*.sql'", "'database/**'", "'**/sqlsc.yml'", "'database/Tables/dbo.Pay.sql'"]) {
    const text = `repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit:\n      - 'database/**'\n    agent_never_commit:\n      - ${deny}\n`;
    const f = fixture(text);
    const plan = perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract });
    assert.equal(plan.state, "conflict", deny);
    assert.equal(plan.newText, "");
    assert.ok(plan.conflicts.includes(deny.slice(1, -1)), deny);
    assert.match(plan.reason, /never removes a deny rule/);
    assert.equal(sqlsc.commitLine(f.config(), f.contract).covered, false);
    assert.ok(sqlsc.commitLine(f.config(), f.contract).conflicts.length, "readiness names the conflict too");
  }
});

await t("no entry, two entries for one folder, and a missing contract: no change offered", async () => {
  const none = fixture("repositories:\n  other:\n    role: sql\n    local_path: elsewhere\n");
  assert.equal(perm.sqlscPermissionPlan({ configFile: none.config(), contractPath: none.contract }).state, "no_repository");
  const two = fixture("repositories:\n  a:\n    role: sql\n    local_path: sql\n  b:\n    role: mixed\n    local_path: ./sql\n");
  assert.equal(perm.sqlscPermissionPlan({ configFile: two.config(), contractPath: two.contract }).state, "ambiguous");
  assert.equal(perm.sqlscPermissionPlan({ configFile: two.config(), contractPath: join(two.root, "nope.yml") }).state, "no_contract");
});

await t("multi-line flow lists are not rewritten (a hand edit is asked for instead)", async () => {
  const f = fixture("repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit: [\n      'database/**' ]\n");
  assert.equal(perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract }).state, "unsupported");
});

// --- the command --------------------------------------------------------------------
await t("/sql-source permissions: headless and declined runs change nothing; yes writes one backup outside the repository", async () => {
  const f = fixture(DB_ONLY);
  const headless = await perm.sqlscPermissionsCommand({ cwd: join(f.root, "sql"), configFile: f.config(), contractPath: f.contract, confirm: null });
  assert.equal(headless.state, "headless");
  assert.equal(f.read(), DB_ONLY);
  let asked = "";
  const declined = await perm.sqlscPermissionsCommand({ cwd: join(f.root, "sql"), configFile: f.config(), contractPath: f.contract, confirm: async (_t, m) => { asked = m; return false; } });
  assert.equal(declined.state, "declined");
  assert.match(asked, /repositories\.warehouse\.agent_allowed_to_commit[\s\S]*\+ {7}- 'sqlsc\.yml'[\s\S]*backup/);
  const thrown = await perm.sqlscPermissionsCommand({ cwd: f.root, configFile: f.config(), contractPath: f.contract, confirm: async () => { throw new Error("dialog closed"); } });
  assert.equal(thrown.state, "declined");
  assert.equal(f.read(), DB_ONLY, "declined: the file is untouched");
  assert.equal(backups().length, 0, "declined: no backup either");
  const yes = await perm.sqlscPermissionsCommand({ cwd: f.root, configFile: f.config(), contractPath: f.contract, confirm: async () => true });
  assert.equal(yes.state, "written");
  assert.match(yes.text, /\/new/);
  assert.ok(yes.backup && existsSync(yes.backup) && relative(f.root, yes.backup).startsWith(".."), "the backup sits outside the client folder");
  assert.equal(readFileSync(yes.backup, "utf8"), DB_ONLY);
  assert.equal(perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract }).state, "ok");
  const twice = await perm.sqlscPermissionsCommand({ cwd: f.root, configFile: f.config(), contractPath: f.contract, confirm: async () => { throw new Error("must not ask"); } });
  assert.equal(twice.state, "ok", "idempotent: nothing to ask");
});

await t("a contract edited after the diff was shown is not overwritten", async () => {
  const f = fixture(DB_ONLY);
  const result = await perm.sqlscPermissionsCommand({ cwd: f.root, configFile: f.config(), contractPath: f.contract, confirm: async () => { writeFileSync(f.contract, DB_ONLY + "# edited meanwhile\n"); return true; } });
  assert.equal(result.state, "failed");
  assert.equal(f.read(), DB_ONLY + "# edited meanwhile\n");
});

await t("two entry points: the SQL repository's own project file and the client home one each name their own entry; the other is listed, not changed", async () => {
  // Client home repository beside the SQL repository, and the SQL repository's own project file.
  const parent = mkdtempSync(join(tmpdir(), "coop-sqlperm-two-"));
  const home = join(parent, "client-home");
  const sqlRepo = join(parent, "sql-repo");
  mkdirSync(join(home, ".coop"), { recursive: true });
  mkdirSync(join(sqlRepo, ".coop"), { recursive: true });
  mkdirSync(join(sqlRepo, ".git"));
  writeFileSync(join(sqlRepo, "sqlsc.yml"), "folder: db\n");
  const homeText = "repositories:\n  warehouse:\n    role: sql\n    local_path: ../sql-repo\n";
  const ownText = "repositories:\n  self:\n    role: sql\n    local_path: .\n    agent_allowed_to_commit:\n      - 'db/**'\n";
  writeFileSync(join(home, ".coop", "project.yml"), homeText);
  writeFileSync(join(sqlRepo, ".coop", "project.yml"), ownText);
  const cfg = join(sqlRepo, "sqlsc.yml");
  const fromHome = perm.sqlscPermissionPlan({ configFile: cfg, contractPath: join(home, ".coop", "project.yml") });
  assert.equal(fromHome.repository, "warehouse");
  assert.deepEqual(fromHome.add, ["db/**", "sqlsc.yml", ".gitattributes", ".gitignore"]);
  const fromRepo = perm.sqlscPermissionPlan({ configFile: cfg, contractPath: join(sqlRepo, ".coop", "project.yml") });
  assert.equal(fromRepo.repository, "self");
  assert.deepEqual(fromRepo.add, ["sqlsc.yml", ".gitattributes", ".gitignore"]);
  const others = perm.otherContractsFor(sqlRepo, join(sqlRepo, ".coop", "project.yml"), { cwd: sqlRepo, env: { COOP_DIR: USER_DIR } });
  assert.deepEqual(others, [join(home, ".coop", "project.yml")], "the home project file is named as not changed");
  assert.match(perm.permissionPlanText(fromRepo, others), /Not changed[\s\S]*client-home/);
  const done = await perm.sqlscPermissionsCommand({ cwd: sqlRepo, configFile: cfg, contractPath: join(sqlRepo, ".coop", "project.yml"), confirm: async () => true });
  assert.equal(done.state, "written");
  assert.equal(readFileSync(join(home, ".coop", "project.yml"), "utf8"), homeText, "the other project file is untouched");
});

await t("the wizard's new sql entry leaves **/*.sql out of never-commit; other roles keep it; existing entries are not rewritten", async () => {
  const settings = (repos) => ({ organization: "o", client: "c", timezone: "UTC", defaultBranch: "main", repositories: repos, fabricEnabled: false });
  const sqlRepo = { name: "warehouse", description: "d", role: "sql", localPath: "sql", remoteName: "origin", defaultBranch: "main", isNew: true };
  const pbiRepo = { ...sqlRepo, name: "reports", role: "powerbi", localPath: "reports" };
  const text = contractLib.renderProjectWizardSettings(settings([sqlRepo, pbiRepo]));
  assert.deepEqual(contractLib.projectYamlList(text, ["repositories", "warehouse", "agent_never_commit"]).includes("**/*.sql"), false);
  assert.ok(contractLib.projectYamlList(text, ["repositories", "reports", "agent_never_commit"]).includes("**/*.sql"));
  assert.ok(contractLib.projectYamlList(text, ["repositories", "warehouse", "agent_never_commit"]).includes("**/*.py"));
  const existing = "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_never_commit:\n      - '**/*.sql'\n";
  const updated = contractLib.applyProjectWizardSettings(existing, settings([{ ...sqlRepo, isNew: false }]));
  assert.ok(contractLib.projectYamlList(updated, ["repositories", "warehouse", "agent_never_commit"]).includes("**/*.sql"), "an existing deny rule stays");
  // A wizard-made SQL entry plus /sql-source permissions is commit-ready.
  const root = mkdtempSync(join(tmpdir(), "coop-sqlperm-wiz-"));
  mkdirSync(join(root, ".coop"));
  mkdirSync(join(root, "sql"));
  writeFileSync(join(root, ".coop", "project.yml"), text);
  writeFileSync(join(root, "sql", "sqlsc.yml"), "folder: database\n");
  const plan = perm.sqlscPermissionPlan({ configFile: join(root, "sql", "sqlsc.yml"), contractPath: join(root, ".coop", "project.yml") });
  assert.equal(plan.state, "missing");
  assert.deepEqual(plan.add, REQUIRED);
});

// --- guard parity, over the bundled guardrails ---------------------------------------
if (guards) {
  const { sqlscCommitRefusal, parseRepoEntries } = guards;
  await t("guard parity: the guard refuses exactly when the planner has work, and passes after the planned change", async () => {
    const cases = [
      DB_ONLY,
      "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n",
      "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit: ['database/**', 'sqlsc.yml', '.gitattributes', '.gitignore']\n",
      "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit: ['database/**']\n    agent_never_commit: ['**/*.sql']\n",
    ];
    for (const text of cases) {
      const f = fixture(text);
      const gov = (body) => ({ loaded: true, entries: parseRepoEntries(body, f.root) });
      const plan = perm.sqlscPermissionPlan({ configFile: f.config(), contractPath: f.contract });
      const refusal = sqlscCommitRefusal(f.config(), gov(text));
      assert.equal(refusal === null, plan.state === "ok", `${plan.state}: ${refusal}`);
      assert.equal(sqlsc.commitLine(f.config(), f.contract).covered, refusal === null, "the readiness line agrees with the guard");
      if (plan.state === "missing") assert.equal(sqlscCommitRefusal(f.config(), gov(plan.newText)), null, "the planned change satisfies the guard");
      if (plan.state === "conflict") assert.match(refusal, /agent_never_commit/);
    }
  });
}

// --- the tool and the command, over a stubbed coop-sqlsc --------------------------
if (tools) {
  const registered = new Map();
  const commands = new Map();
  const execs = [];
  const pi = {
    registerTool: (tool) => registered.set(tool.name, tool),
    registerCommand: (name, spec) => commands.set(name, spec),
    on: () => {},
    sendUserMessage: () => {},
    getThinkingLevel: () => "off",
    exec: async (bin, args) => {
      execs.push([bin, ...args]);
      if (bin === "git") return { code: 0, stdout: "", stderr: "" };
      if (bin === "coop-sqlsc") return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "init", folder: "database", target: "dev" }) };
      return { code: 1, stdout: "", stderr: "" };
    },
  };
  sqlsc.setSqlSourceEnabled(true);
  tools.default(pi);
  const tool = registered.get("sql_source");
  const ui = (answer, log) => ({ hasUI: true, ui: { confirm: async (title, message) => { log.push(message); return answer; }, notify: (m) => log.push(m), setStatus: () => {} } });
  // No process beyond sqlsc init and git init, and never a commit, push, script or SQL.
  const forbidden = (e) => (e[0] === "git" && ["commit", "push", "add"].some((v) => e.includes(v))) || (e[0] === "coop-sqlsc" && !e.includes("init"));

  await t("approved setup: sql_source init then shows the exact change; yes writes it (backup, /new), no or headless writes nothing", async () => {
    for (const [answer, hasUI] of [[true, true], [false, true], [true, false]]) {
      const f = fixture("repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n", { sql: null });
      mkdirSync(join(f.root, "sql", ".git"));
      const original = f.read();
      const log = [];
      execs.length = 0;
      const ctx = hasUI ? { cwd: f.root, ...ui(answer, log) } : { cwd: f.root, hasUI: false };
      const r = await tool.execute("id", { command: "init" }, undefined, undefined, ctx);
      assert.equal(r.details.state, "ok", r.content[0].text);
      assert.ok(!execs.some(forbidden), JSON.stringify(execs));
      if (answer && hasUI) {
        assert.match(log[0], /\+ {7}- 'database\/\*\*'[\s\S]*\+ {7}- '\.gitignore'/);
        assert.deepEqual(contractLib.projectYamlList(f.read(), ["repositories", "warehouse", "agent_allowed_to_commit"]), REQUIRED);
        assert.match(r.content[0].text, /Updated[\s\S]*\/new[\s\S]*baseline commit waits/);
      } else {
        assert.equal(f.read(), original, `answer ${answer}, UI ${hasUI}: unchanged`);
        assert.match(r.content[0].text, /baseline commit needs agent_allowed_to_commit/);
      }
    }
  });

  await t("/sql-source permissions over the registered command: repairs a database/**-only project, asks once, runs no process", async () => {
    const f = fixture(DB_ONLY);
    const cmd = commands.get("sql-source");
    assert.match(cmd.description, /permissions/);
    const log = [];
    execs.length = 0;
    await cmd.handler("permissions", { cwd: join(f.root, "sql"), ...ui(true, log) });
    assert.equal(execs.length, 0, "configuration repair starts no process");
    assert.deepEqual(contractLib.projectYamlList(f.read(), ["repositories", "warehouse", "agent_allowed_to_commit"]), REQUIRED);
    assert.equal(contractLib.projectYamlScalar(f.read(), ["sql_targets", "dev", "server"]), "sample-dev.database.windows.net", "targets untouched");
    assert.match(log.join("\n"), /Updated[\s\S]*\/new/);
    const quiet = [];
    await cmd.handler("permissions", { cwd: join(f.root, "sql"), hasUI: false, ui: { notify: (m) => quiet.push(m) } });
    assert.match(quiet.join("\n"), /already allowed/);
  });
  sqlsc.setSqlSourceEnabled(false);
}

console.log(`✓ sql-source permission tests passed (${n})${dist ? "" : " (lib only: set COOP_TEST_DIST for the tool and guardrails)"}`);
