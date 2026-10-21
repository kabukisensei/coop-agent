// SQL source control (master plan SQ12): the sql_source tool's argv and text
// (lib/sqlsc.mjs), the tool itself over a stubbed coop-sqlsc, and the
// guardrails: sqlsc's commit verbs are hard-blocked from the shell, database
// changes ask, and the tool's get_latest apply asks.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const AUDIT_DIR = mkdtempSync(join(tmpdir(), "coop-sqlsrc-audit-"));
process.env.PI_CODING_AGENT_DIR = AUDIT_DIR;
// The per-user switch lives in <COOP_DIR>/.coop/config: a fresh one per run.
const USER_DIR = mkdtempSync(join(tmpdir(), "coop-sqlsrc-user-"));
process.env.COOP_DIR = USER_DIR;

const lib = await import(new URL("../lib/sqlsc.mjs", import.meta.url).href);
const dist = process.env.COOP_TEST_DIST;
const tools = dist ? await import(pathToFileURL(`${dist}/coop-tools.mjs`).href) : null;
const guards = dist ? await import(pathToFileURL(`${dist}/coop-guardrails.mjs`).href) : null;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

// --- lib: input, argv, finding sqlsc.yml -----------------------------------------
await t("input defaults to status and rejects unknown commands and flags in the wrong place", async () => {
  assert.equal(lib.sqlSourceInput({}).command, "status");
  assert.ok(lib.sqlSourceInput({ command: "commit" }).error);
  assert.ok(lib.sqlSourceInput({ command: "checkin" }).error);
  assert.ok(lib.sqlSourceInput({ command: "deploy" }).error, "deploy needs dev or test");
  assert.ok(lib.sqlSourceInput({ command: "deploy", environment: "prod" }).error, "production is a person's release");
  assert.ok(lib.sqlSourceInput({ command: "deploy", environment: "test", objects: ["dbo.v"] }).error, "a deploy takes no objects");
  assert.ok(lib.sqlSourceInput({ command: "deploy", environment: "test", ref: "--allow-drops" }).error, "a ref is never an option");
  assert.equal(lib.sqlSourceInput({ command: "deploy", environment: "test" }).ref, "HEAD");
  assert.ok(lib.sqlSourceInput({ command: "status", ref: "v1" }).error, "ref is deploy only");
  assert.ok(lib.sqlSourceInput({ command: "checkout" }).error, "checkout needs objects");
  assert.ok(lib.sqlSourceInput({ command: "status", apply: true }).error, "apply is get_latest/deploy only");
  assert.ok(lib.sqlSourceInput({ command: "script", environment: "prod" }).error, "writes never take an environment");
  assert.ok(lib.sqlSourceInput({ command: "diff", objects: ["--force"] }).error, "an option is not an object name");
  assert.equal(lib.sqlSourceInput({ command: "diff", environment: "prod" }).environment, "prod");
});

await t("the per-user switch: off by default, /sql-source on writes ~/.coop/config and keeps other keys", async () => {
  const file = join(USER_DIR, ".coop", "config");
  assert.equal(lib.sqlSourceEnabled(file), false, "no config: off");
  mkdirSync(join(USER_DIR, ".coop"), { recursive: true });
  writeFileSync(file, JSON.stringify({ client: { platform: "fabric" } }));
  assert.equal(lib.sqlSourceEnabled(file), false, "no key: off");
  assert.equal(lib.setSqlSourceEnabled(true, file, new Date("2026-10-20T22:00:00Z")), true);
  assert.equal(lib.sqlSourceEnabled(file), true);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.client.platform, "fabric", "other keys stay");
  assert.equal(raw.sql_source_control.changed_at, "2026-10-20T22:00:00.000Z");
  assert.equal(lib.setSqlSourceEnabled(false, file), false);
  assert.equal(lib.sqlSourceEnabled(file), false);
  writeFileSync(file, "{not json");
  assert.equal(lib.sqlSourceEnabled(file), false, "unreadable: off");
  assert.equal(lib.setSqlSourceEnabled(true, file), true, "unreadable is replaced");
  assert.match(lib.sqlSourceSwitchText(true), /ON for this Windows user/);
  assert.match(lib.sqlSourceSwitchText(false), /OFF for this Windows user/);
});

await t("a write is classified by the project file, never by the target's name alone", async () => {
  const entries = { dev: { kind: "azure_sql", server: "contoso-dev.database.windows.net", database: "Sales" }, test: { kind: "fabric_warehouse", server: "", database: "WH_Test" } };
  const none = () => false;
  const dev = { name: "dev", kind: "azure_sql", server: "contoso-dev.database.windows.net", database: "sales", protected: false, source: "coop project.yml" };
  assert.equal(lib.classifySqlscWrite({ environment: "dev", targets: [dev], entries, namesProduction: none }).ok, true);
  assert.match(lib.classifySqlscWrite({ environment: "prod", targets: [dev], entries, namesProduction: none }).reason, /person/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [], entries, namesProduction: none }).reason, /no target named dev/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [{ ...dev, protected: true }], entries, namesProduction: none }).reason, /protected/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [{ ...dev, server: "contoso-prod.database.windows.net" }], entries, namesProduction: none }).reason, /named like production/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [{ ...dev, server: "contoso-live.database.windows.net" }], entries, namesProduction: none }).reason, /named like production/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [dev], entries, namesProduction: () => true }).reason, /production server or database in the project file/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [dev], entries: {}, namesProduction: none }).reason, /unlabelled/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [{ ...dev, server: "other.database.windows.net" }], entries, namesProduction: none }).reason, /conflicting/);
  assert.match(lib.classifySqlscWrite({ environment: "dev", targets: [{ ...dev, database: "Other" }], entries, namesProduction: none }).reason, /conflicting/);
  const test = { name: "test", kind: "fabric_warehouse", server: "abc.datawarehouse.fabric.microsoft.com", database: "WH_Test", protected: false, source: "coop project.yml" };
  assert.equal(lib.classifySqlscWrite({ environment: "test", targets: [test], entries, namesProduction: none }).ok, true, "a Fabric target taken from the contract's ids");
  assert.match(lib.classifySqlscWrite({ environment: "test", targets: [{ ...test, source: "coop project.yml + sqlsc.yml" }], entries, namesProduction: none }).reason, /sqlsc\.yml/, "an sqlsc.yml override of a Fabric target is not vouched for");
  assert.match(lib.classifySqlscWrite({ environment: "test", targets: [{ name: "test", problem: "no database" }], entries, namesProduction: none }).reason, /not ready/);
});

await t("commit: needs a one-line message; script refuses objects changed on both sides", async () => {
  assert.match(lib.sqlSourceInput({ command: "commit" }).error, /needs a message/);
  assert.match(lib.sqlSourceInput({ command: "commit", message: "--amend" }).error, /dash/);
  assert.match(lib.sqlSourceInput({ command: "status", message: "x" }).error, /only for commit/);
  assert.equal(lib.sqlSourceInput({ command: "commit", message: " add\n Region  column " }).message, "add Region column");
  const status = { ok: true, changes: [
    { action: "changed", origin: "both", type: "view", object: "[dbo].[v]" },
    { action: "changed", origin: "database", type: "procedure", object: "[dbo].[p]" },
    { action: "new", origin: "unknown", type: "table", object: "[dbo].[t]" },
  ] };
  assert.deepEqual(lib.scriptConflicts(status).map((c) => c.object), ["[dbo].[v]"]);
  assert.deepEqual(lib.scriptConflicts(status, ["dbo.p"]), [], "an object named by the user that changed in dev only scripts");
  assert.equal(lib.scriptConflicts(status, ["dbo.V"]).length, 1);
  assert.equal(lib.scriptConflicts({ ok: true, changes: [] }).length, 0);
  const text = lib.scriptConflictText(lib.scriptConflicts(status));
  assert.match(text.head, /STOP.*both sides.*cannot apply either side/);
  assert.match(text.head, /sqlsc get-latest -t dev --force <object>` keeps the file's version.*sqlsc script -t dev <object>` keeps the database's/);
  assert.doesNotMatch(text.head, /get_latest \(apply\) keeps/, "get_latest never forces, so it cannot keep the file's version");
  assert.match(lib.sqlSourceText({ command: "get_latest" }, { ok: true, steps: [], kept: [{ object: "[dbo].[v]", reason: "changed in the database and in the repo" }] }).lines[0], /kept \[dbo\]\.\[v\].*coop never forces/);
  assert.deepEqual(lib.committedObjects({ commit: "abc", files: [{ object: "[dbo].[v]" }, { path: "x.sql" }] }), ["[dbo].[v]"]);
  assert.deepEqual(lib.committedObjects({ commit: null, files: [{ object: "[dbo].[v]" }] }), [], "nothing committed, nothing released");
  assert.deepEqual(lib.commitReleaseLines(["[dbo].[v]", "[dbo].[w]"], { ok: false, released: [{ object: "[dbo].[v]" }], refused: [{ object: "[dbo].[w]", locked_by: "bob@example.com" }] }),
    ["- released coop's checkout of [dbo].[v]", "- [dbo].[w] stays checked out by bob@example.com"]);
  assert.match(lib.commitReleaseLines(["[dbo].[v]"], null)[0], /checkout of \[dbo\]\.\[v\] stays.*sql_source release/);
  const root = mkdtempSync(join(tmpdir(), "coop-sqlsrc-folder-"));
  writeFileSync(join(root, "sqlsc.yml"), "folder: 'sql\\objects'\ntarget: dev\n");
  assert.equal(lib.sqlscFolder(join(root, "sqlsc.yml")), "sql/objects");
  writeFileSync(join(root, "sqlsc.yml"), "target: dev\n");
  assert.equal(lib.sqlscFolder(join(root, "sqlsc.yml")), "database");
});

await t("argv: coop acts as coop-agent:<person>, writes only to dev, never pushes or forces", async () => {
  const agent = lib.agentIdentity("ada@example.com");
  assert.equal(agent, "coop-agent:ada@example.com");
  const args = (p) => lib.sqlSourceArgs(lib.sqlSourceInput(p), "/r/sqlsc.yml", agent);
  assert.deepEqual(args({ command: "checkout", objects: ["dbo.v"], note: "task" }),
    ["--json", "--config", "/r/sqlsc.yml", "checkout", "--as", agent, "--message", "task", "--", "dbo.v"]);
  assert.deepEqual(args({ command: "release", objects: ["dbo.v"] }), ["--json", "--config", "/r/sqlsc.yml", "unlock", "--as", agent, "--", "dbo.v"]);
  assert.deepEqual(args({ command: "get_latest" }), ["--json", "--config", "/r/sqlsc.yml", "get-latest", "--target", "dev", "--dry-run"]);
  assert.deepEqual(args({ command: "get_latest", apply: true }), ["--json", "--config", "/r/sqlsc.yml", "get-latest", "--target", "dev"]);
  assert.deepEqual(args({ command: "script" }), ["--json", "--config", "/r/sqlsc.yml", "script", "--target", "dev"]);
  assert.deepEqual(args({ command: "deploy", environment: "test", ref: "v1.4" }), ["--json", "--config", "/r/sqlsc.yml", "deploy", "--target", "test", "--ref", "v1.4", "--dry-run"]);
  assert.deepEqual(args({ command: "deploy", environment: "dev", apply: true }), ["--json", "--config", "/r/sqlsc.yml", "deploy", "--target", "dev", "--ref", "HEAD"]);
  assert.deepEqual(args({ command: "commit", message: "add Region", objects: ["dbo.v"] }), ["--json", "--config", "/r/sqlsc.yml", "commit", "--target", "dev", "--as", agent, "--message", "add Region", "--", "dbo.v"]);
  for (const p of [{ command: "status" }, { command: "checkout", objects: ["x"] }, { command: "get_latest", apply: true }, { command: "release", objects: ["x"] }, { command: "deploy", environment: "test", apply: true }, { command: "commit", message: "m" }]) {
    const a = args(p);
    for (const word of ["checkin", "--force", "--allow-drops", "--push", "--confirm", "prod"]) assert.ok(!a.includes(word), `${p.command} has no ${word}`);
    if (p.command !== "commit") assert.ok(!a.includes("commit"), `${p.command} has no commit`);
  }
});

await t("finds sqlsc.yml above the folder, or in the project's only SQL repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-sqlsrc-"));
  mkdirSync(join(root, "sql", "database"), { recursive: true });
  writeFileSync(join(root, "sql", "sqlsc.yml"), "folder: database\n");
  assert.equal(lib.findSqlscConfig(join(root, "sql", "database")), join(root, "sql", "sqlsc.yml"));
  mkdirSync(join(root, "home", ".coop"), { recursive: true });
  const contract = join(root, "home", ".coop", "project.yml");
  writeFileSync(contract, "repositories:\n  warehouse:\n    role: sql\n    local_path: ../sql\n  docs:\n    role: data_docs\n    local_path: ../docs\n");
  assert.equal(lib.findSqlscConfig(join(root, "home"), contract), join(root, "sql", "sqlsc.yml"));
  assert.equal(lib.findSqlscConfig(join(root, "home"), null), null);
});

await t("text: a clash says stop and who has it; a checkout says the person checks in", async () => {
  const clash = lib.sqlSourceText({ command: "checkout" }, { ok: false, user: "coop-agent:ada@example.com", checked_out: [], conflicts: [{ object: "[dbo].[v]", locked_by: "bob@example.com", locked_at: "2026-10-20T10:00:00+00:00", note: "fixing totals" }] });
  assert.match(clash.head, /STOP/);
  assert.match(clash.lines[0], /bob@example\.com/);
  const got = lib.sqlSourceText({ command: "checkout" }, { ok: true, user: "coop-agent:ada@example.com", checked_out: [{ object: "[dbo].[v]" }], conflicts: [] });
  assert.match(got.head, /commit with a message/);
  assert.match(got.head, /user approves/);
  const committed = lib.sqlSourceText({ command: "commit" }, { ok: true, command: "commit", commit: "abc123def4567890", pushed: null, files: [{ action: "changed", path: "dbo/Views/v.sql" }], skipped: [{ object: "[dbo].[t]", locked_by: "bob@example.com" }], held_back: [] });
  assert.match(committed.head, /committed 1 file\(s\) as abc123def456 .*not pushed/);
  assert.match(committed.lines[1], /left \[dbo\]\.\[t\]: checked out by bob/);
  assert.match(lib.sqlSourceText({ command: "commit" }, { ok: true, commit: null, files: [] }).head, /nothing committed/);
  const err = lib.sqlSourceText({ command: "status" }, { ok: false, error: { kind: "connect", message: "cannot reach dev" } });
  assert.match(err.head, /failed \(connect\): cannot reach dev/);
});

await t("init: a schema filter only for init; it sets up the project's SQL repository and names the commit line", async () => {
  const init = lib.sqlSourceInput({ command: "init", schemas: ["sales", " Finance "], exclude: ["staging"] });
  assert.deepEqual([init.schemas, init.exclude], [["sales", "Finance"], ["staging"]]);
  assert.deepEqual(lib.sqlSourceArgs(init, "/r/sqlsc.yml", ""), ["--json", "--config", "/r/sqlsc.yml", "init", "--schema", "sales", "--schema", "Finance", "--exclude-schema", "staging"]);
  assert.deepEqual(lib.sqlSourceArgs(lib.sqlSourceInput({ command: "init" }), "/r/sqlsc.yml", ""), ["--json", "--config", "/r/sqlsc.yml", "init"], "no filter: sqlsc 1.0.1 flags only");
  assert.match(lib.sqlSourceInput({ command: "status", schemas: ["sales"] }).error, /only for init/);
  assert.match(lib.sqlSourceInput({ command: "init", schemas: ["[x]; drop"] }).error, /schema names/);
  assert.match(lib.sqlSourceInput({ command: "init", objects: ["dbo.v"] }).error, /no objects/);
  assert.match(lib.sqlSourceText({ command: "init" }, { ok: true, command: "init", config: "/r/sqlsc.yml", folder: "database", target: "dev" }).head, /wrote \/r\/sqlsc\.yml.*status.*script the whole dev database.*"baseline from dev"/);
  const root = mkdtempSync(join(tmpdir(), "coop-sqlsrc-init-"));
  mkdirSync(join(root, ".coop"));
  mkdirSync(join(root, "sql"));
  const contract = join(root, ".coop", "project.yml");
  writeFileSync(contract, "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n");
  assert.deepEqual(lib.sqlscInitRoot(join(root, "elsewhere"), contract), { root: join(root, "sql"), name: "warehouse" });
  assert.match(lib.sqlscInitRoot(mkdtempSync(join(tmpdir(), "coop-sqlsrc-nogit-")), null).error, /no SQL repository here/);
  writeFileSync(join(root, "sql", "sqlsc.yml"), "folder: database\n");
  assert.deepEqual(lib.commitLine(join(root, "sql", "sqlsc.yml"), contract), { line: 'agent_allowed_to_commit: ["database/**"] under repositories.warehouse in .coop/project.yml', covered: false });
  writeFileSync(contract, "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit:\n      - \"database/**\"\n");
  assert.equal(lib.commitLine(join(root, "sql", "sqlsc.yml"), contract).covered, true);
  writeFileSync(contract, "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n    agent_allowed_to_commit: [\"docs/**\"]\n");
  assert.equal(lib.commitLine(join(root, "sql", "sqlsc.yml"), contract).covered, false, "docs/** does not cover database/");
});

// --- the tool, over a stubbed coop-sqlsc -------------------------------------------
if (tools) {
  const registered = new Map();
  const execs = [];
  let sqlsc = () => ({ code: 0, stdout: "{}", stderr: "" });
  const pi = {
    registerTool: (tool) => registered.set(tool.name, tool),
    registerCommand: () => {},
    on: () => {},
    sendUserMessage: () => {},
    getThinkingLevel: () => "off",
    exec: async (bin, args) => {
      execs.push([bin, ...args]);
      if (bin === "git") return { code: 0, stdout: "ada@example.com\n", stderr: "" };
      if (bin === "coop-sqlsc") return sqlsc(args);
      return { code: 1, stdout: "", stderr: "" };
    },
  };
  lib.setSqlSourceEnabled(false);
  tools.default(pi);
  let tool = registered.get("sql_source");
  const repo = mkdtempSync(join(tmpdir(), "coop-sqlsrc-tool-"));
  const run = (params, cwd = repo) => tool.execute("id", params, undefined, undefined, { cwd });

  await t("the tool is not even registered while the switch is off; on, it says when source control is not set up", async () => {
    assert.equal(tool, undefined, "off (the default): no sql_source tool, no fixed context");
    lib.setSqlSourceEnabled(true);
    tools.default(pi);
    tool = registered.get("sql_source");
    assert.ok(tool, "on: sql_source is registered");
    lib.setSqlSourceEnabled(false);
    const off = await run({ command: "status" });
    assert.equal(off.details.state, "off", "switched off mid-session: the loaded tool says so");
    assert.match(off.content[0].text, /\/sql-source on/);
    assert.equal(execs.length, 0, "off: nothing runs");
    lib.setSqlSourceEnabled(true);
    const r = await run({ command: "status" });
    assert.equal(r.details.state, "not_set_up");
    assert.match(r.content[0].text, /not set up/);
  });

  writeFileSync(join(repo, "sqlsc.yml"), "folder: database\n");

  await t("checkout runs as coop-agent:<git user.email> and reports a teammate's checkout", async () => {
    sqlsc = () => ({ code: 1, stderr: "", stdout: JSON.stringify({ ok: false, command: "checkout", user: "coop-agent:ada@example.com", checked_out: [], conflicts: [{ object: "[dbo].[v]", locked_by: "bob@example.com", locked_at: "2026-10-20T10:00:00+00:00" }] }) });
    const r = await run({ command: "checkout", objects: ["dbo.v"], note: "task 12" });
    const call = execs.findLast((e) => e[0] === "coop-sqlsc");
    assert.ok(call.includes("coop-agent:ada@example.com"));
    assert.equal(r.details.state, "refused");
    assert.match(r.content[0].text, /STOP[\s\S]*bob@example\.com/);
  });

  await t("a missing coop-sqlsc reads as not installed, and coop carries on", async () => {
    sqlsc = () => { throw Object.assign(new Error("spawn coop-sqlsc ENOENT"), { code: "ENOENT" }); };
    const r = await run({ command: "status" });
    assert.equal(r.details.state, "not_installed");
    assert.match(r.content[0].text, /not installed/);
  });

  await t("script reads status first and stops on an object changed on both sides; commit never pushes", async () => {
    sqlsc = (args) => args.includes("status")
      ? { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "status", changes: [{ action: "changed", origin: "both", type: "view", object: "[dbo].[v]" }, { action: "changed", origin: "database", type: "view", object: "[dbo].[w]" }] }) }
      : { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "script", target: { name: "dev", kind: "azure_sql", database: "Sales" }, files: [{ action: "changed", path: "dbo/Views/w.sql" }] }) };
    execs.length = 0;
    const stop = await run({ command: "script" });
    assert.equal(stop.details.state, "conflict");
    assert.match(stop.content[0].text, /STOP[\s\S]*\[dbo\]\.\[v\]/);
    assert.ok(!execs.some((e) => e[0] === "coop-sqlsc" && e.includes("script")), "nothing was written");
    const one = await run({ command: "script", objects: ["dbo.w"] });
    assert.equal(one.details.state, "ok");
    assert.match(one.content[0].text, /wrote 1 file\(s\)[\s\S]*commit with a message/);
    sqlsc = (args) => args.includes("unlock")
      ? { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "unlock", released: [{ object: "[dbo].[w]" }], refused: [], not_checked_out: [] }) }
      : { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "commit", commit: "abc123def456789", pushed: null, files: [{ action: "changed", object: "[dbo].[w]", path: "dbo/Views/w.sql" }], skipped: [], held_back: [] }) };
    execs.length = 0;
    const c = await run({ command: "commit", message: "add Region to w" });
    const calls = execs.filter((e) => e[0] === "coop-sqlsc");
    const call = calls.find((e) => e.includes("commit"));
    assert.ok(call.includes("--message") && !call.includes("--push") && !call.includes("--force"));
    const unlock = calls.find((e) => e.includes("unlock"));
    assert.ok(unlock && unlock.includes("coop-agent:ada@example.com") && unlock.at(-1) === "[dbo].[w]" && !unlock.includes("--force"), "the commit releases coop's own checkout of what it committed");
    assert.match(c.content[0].text, /committed 1 file\(s\) as abc123def456[\s\S]*released coop's checkout of \[dbo\]\.\[w\]/);
  });

  await t("deploy: a dry run shows the script and names the person for production", async () => {
    sqlsc = () => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "deploy", target: { name: "test", kind: "azure_sql", database: "Sales" }, commit: "abc123def456789", steps: [{ action: "alter", type: "view", object: "[dbo].[v]" }], script: "ALTER VIEW dbo.v AS SELECT 1;", applied: false }) });
    const r = await run({ command: "deploy", environment: "test", ref: "v1.4" });
    const call = execs.findLast((e) => e[0] === "coop-sqlsc");
    assert.ok(call.includes("--dry-run") && call.includes("test") && !call.includes("--confirm"));
    assert.match(r.content[0].text, /dry run.*v1\.4.*Production is released by a person/);
    assert.match(r.content[0].text, /ALTER VIEW/);
    const bad = await run({ command: "deploy", environment: "prod", apply: true });
    assert.equal(bad.details.state, "input_invalid");
  });

  await t("init: git init when needed, then sqlsc init in the project's SQL repository; the first status names the missing commit line once", async () => {
    const home = mkdtempSync(join(tmpdir(), "coop-sqlsrc-home-"));
    mkdirSync(join(home, ".coop"));
    mkdirSync(join(home, "sql"));
    writeFileSync(join(home, ".coop", "project.yml"), "repositories:\n  warehouse:\n    role: sql\n    local_path: sql\n");
    const starts = [];
    tools.default({ ...pi, on: (event, fn) => { if (event === "session_start") starts.push(fn); } });
    const fresh = registered.get("sql_source");
    const go = (params) => fresh.execute("id", params, undefined, undefined, { cwd: home });
    sqlsc = (args) => args.includes("init")
      ? { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "init", config: join(home, "sql", "sqlsc.yml"), folder: "database", target: "dev" }) }
      : { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, command: "status", target: { name: "dev", kind: "azure_sql", database: "Sales" }, changes: [], sides: {} }) };
    execs.length = 0;
    const r = await go({ command: "init", schemas: ["sales"] });
    assert.equal(r.details.state, "ok", r.content[0].text);
    assert.deepEqual(execs[0], ["git", "init", join(home, "sql")], "not a repository yet: git init first");
    assert.deepEqual(execs[1], ["coop-sqlsc", "--json", "--config", join(home, "sql", "sqlsc.yml"), "init", "--schema", "sales"]);
    assert.match(r.content[0].text, /baseline from dev[\s\S]*new git repository[\s\S]*agent_allowed_to_commit: \["database\/\*\*"\] under repositories\.warehouse/);
    writeFileSync(join(home, "sql", "sqlsc.yml"), "folder: database\n");
    assert.equal((await go({ command: "init" })).details.state, "already_set_up");
    const first = await go({ command: "status" });
    assert.match(first.content[0].text, /coop can commit these files only once the project file has agent_allowed_to_commit/);
    const second = await go({ command: "status" });
    assert.doesNotMatch(second.content[0].text, /agent_allowed_to_commit/, "once per session");
    // A new session in the same process (/new, the window) names it again.
    for (const fn of starts) { try { await fn({}, { cwd: home, hasUI: false, ui: { notify: () => {}, setStatus: () => {} }, sessionManager: { getSessionId: () => "s2", getSessionFile: () => "" } }); } catch { /* other session_start work needs more of Pi */ } }
    const third = await go({ command: "status" });
    assert.match(third.content[0].text, /coop can commit these files only once/, "session_start forgets the shown hint");
  });

  await t("the /sql-source command turns the switch on and off for this Windows user", async () => {
    const commands = new Map();
    const notices = [];
    const pi2 = { ...pi, registerCommand: (name, cmd) => commands.set(name, cmd), registerTool: () => {} };
    tools.default(pi2);
    const cmd = commands.get("sql-source");
    assert.ok(cmd, "/sql-source is registered");
    const ctx = { cwd: repo, ui: { notify: (m) => notices.push(m) } };
    await cmd.handler("off", ctx);
    assert.equal(lib.sqlSourceEnabled(), false);
    await cmd.handler("on", ctx);
    assert.equal(lib.sqlSourceEnabled(), true);
    await cmd.handler("", ctx);
    assert.match(notices.at(-1), /ON for this Windows user/);
    await cmd.handler("maybe", ctx);
    assert.match(notices.at(-1), /Usage/);
  });
}

// --- guardrails --------------------------------------------------------------------
if (guards) {
  const { sqlscShellRisk, decideSqlSource } = guards;
  await t("shell: sqlsc commit, checkin and any write without -t dev|test are hard-blocked; reads and coop's own checkouts pass", async () => {
    for (const cmd of ["sqlsc commit -m x", "coop-sqlsc --json checkin", "sqlsc --config a/sqlsc.yml checkin dbo.v -m done", "cd sql && sqlsc commit --push", "coop-sqlsc.exe commit",
      "sqlsc deploy --ref v1", "sqlsc deploy -t prod --ref v1 --confirm prod", "sqlsc deploy -t gold", "sqlsc get-latest", "sqlsc get-latest -t prod", "sqlsc --target live get-latest", "sqlsc get-latest -t dev --force dbo.v"]) {
      assert.equal(sqlscShellRisk(cmd)?.hard, true, cmd);
    }
    for (const cmd of ["sqlsc status", "coop-sqlsc --json diff dbo.v", "sqlsc locks", "sqlsc checkin --no-commit", "sqlsc get-latest --dry-run", "sqlsc deploy -t prod --ref v1 -o r.sql", "sqlsc deploy --dry-run", "sqlsc checkout dbo.v --as coop-agent:ada@example.com", "echo sqlsc commit", "sqlsc history -t prod"]) {
      assert.equal(sqlscShellRisk(cmd), null, cmd);
    }
  });
  await t("shell: dev/test writes are classified then ask; forced unlocks, the guard and acting as someone else ask", async () => {
    for (const cmd of ["sqlsc get-latest -t dev", "sqlsc -t test get-latest", "sqlsc deploy -t test --ref v1", "sqlsc --config x/sqlsc.yml deploy --target=dev", "sqlsc unlock dbo.v --force", "sqlsc guard install", "sqlsc checkout dbo.v --as bob@example.com"]) {
      const risk = sqlscShellRisk(cmd);
      assert.ok(risk && !risk.hard, cmd);
    }
    assert.deepEqual(sqlscShellRisk("sqlsc get-latest -t dev").write, { verb: "get-latest", target: "dev", config: "" });
    assert.deepEqual(sqlscShellRisk("sqlsc --config x/sqlsc.yml deploy --target=test --ref v2").write, { verb: "deploy", target: "test", config: "x/sqlsc.yml" });
    assert.equal(sqlscShellRisk("sqlsc get-latest -t dev").sessionKey, "sqlsc:get-latest:dev");
    assert.equal(sqlscShellRisk("sqlsc deploy -t test").sessionKey, null, "a release asks every time");
  });
  await t("tool: get_latest and deploy with apply ask; commit asks every time", async () => {
    assert.equal(decideSqlSource({ input: { command: "get_latest", apply: true } }).action, "ask");
    assert.deepEqual(decideSqlSource({ input: { command: "commit", message: "m" } }).write, { verb: "commit", environment: "repo" });
    assert.deepEqual(decideSqlSource({ input: { command: "deploy", environment: "test", apply: true } }).write, { verb: "deploy", environment: "test" });
    assert.deepEqual(decideSqlSource({ input: { command: "init" } }).write, { verb: "init", environment: "repo" });
    for (const input of [{ command: "get_latest" }, { command: "deploy", environment: "test" }, { command: "checkout", objects: ["x"] }, { command: "script" }, {}]) {
      assert.equal(decideSqlSource({ input }).action, "allow", JSON.stringify(input));
    }
  });

  // The real handler over a client folder: a contract naming the dev target and
  // an sqlsc.yml; a stubbed coop-sqlsc answers `targets`.
  const client = mkdtempSync(join(tmpdir(), "coop-sqlsrc-client-"));
  mkdirSync(join(client, ".coop"));
  writeFileSync(join(client, ".coop", "project.yml"), `profile:
  client: 'Contoso'
sql_targets:
  default_environment: dev
  dev:
    kind: azure_sql
    server: contoso-dev.database.windows.net
    database: Sales
  prod:
    kind: azure_sql
    server: contoso-prod.database.windows.net
    database: Sales
`);
  writeFileSync(join(client, "sqlsc.yml"), "folder: database\ntarget: dev\n");
  let targets = [
    { name: "dev", kind: "azure_sql", server: "contoso-dev.database.windows.net", database: "Sales", protected: false, source: "coop project.yml" },
    { name: "test", kind: "azure_sql", server: "contoso-prod.database.windows.net", database: "Sales", protected: false, source: "sqlsc.yml" },
  ];
  const handlers = {};
  guards.default({
    on: (ev, h) => (handlers[ev] = h),
    registerCommand: () => {},
    exec: async (bin, args) => (bin === "coop-sqlsc" && args.includes("targets") ? { stdout: JSON.stringify({ ok: true, targets }), code: 0, stderr: "" } : { stdout: "", code: 0, stderr: "" }),
  });
  guards.resetSessionGovernance();
  let confirms = 0;
  const ctx = { cwd: client, hasUI: true, ui: { confirm: async () => { confirms++; return false; }, notify: () => {} } };
  await t("handler: commits and unnamed writes are blocked without asking; a vouched-for dev write asks", async () => {
    const commit = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc commit -m wip" } }, ctx);
    assert.ok(commit?.block && /never commit source/.test(commit.reason) && /Check in/.test(commit.reason));
    const deploy = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc deploy --ref v1" } }, ctx);
    assert.ok(deploy?.block && /-t dev or -t test/.test(deploy.reason) && /--output/.test(deploy.reason));
    const prod = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc deploy -t prod --ref v1 --confirm prod" } }, ctx);
    assert.ok(prod?.block, "a production release is a person's");
    assert.equal(confirms, 0, "blocked, never asked");
    const apply = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc get-latest -t dev" } }, ctx);
    assert.ok(apply?.block && /declined/.test(apply.reason));
    assert.equal(confirms, 1, "dev matched the project file: asked");
    const tool = await handlers.tool_call({ toolName: "sql_source", input: { command: "get_latest", apply: true } }, ctx);
    assert.ok(tool?.block && /declined/.test(tool.reason));
    assert.equal(confirms, 2);
    assert.equal(await handlers.tool_call({ toolName: "sql_source", input: { command: "status" } }, ctx), undefined);
    assert.equal(await handlers.tool_call({ toolName: "sql_source", input: { command: "deploy", environment: "test" } }, ctx), undefined, "a dry run passes");
    const headless = await handlers.tool_call({ toolName: "sql_source", input: { command: "get_latest", apply: true } }, { cwd: client, hasUI: false });
    assert.ok(headless?.block && /headless/.test(headless.reason));
  });
  await t("handler: a target the project file does not vouch for is blocked, whatever its name", async () => {
    // sqlsc.yml's "test" points at the production server.
    const shell = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc deploy -t test --ref v1" } }, ctx);
    assert.ok(shell?.block && /production/.test(shell.reason), shell?.reason);
    const tool = await handlers.tool_call({ toolName: "sql_source", input: { command: "deploy", environment: "test", ref: "v1", apply: true } }, ctx);
    assert.ok(tool?.block && /production/.test(tool.reason), tool?.reason);
    // The contract has no test entry at all: unlabelled counts as production.
    targets = [{ name: "test", kind: "azure_sql", server: "contoso-test.database.windows.net", database: "Sales", protected: false, source: "sqlsc.yml" }];
    const unlabelled = await handlers.tool_call({ toolName: "sql_source", input: { command: "deploy", environment: "test", apply: true } }, ctx);
    assert.ok(unlabelled?.block && /unlabelled/.test(unlabelled.reason), unlabelled?.reason);
    // sqlsc not answering: fail closed.
    targets = null;
    const silent = await handlers.tool_call({ toolName: "sql_source", input: { command: "get_latest", apply: true } }, ctx);
    assert.ok(silent?.block && /no target named dev/.test(silent.reason), silent?.reason);
    assert.equal(confirms, 2, "none of these asked");
  });
  await t("handler: a commit asks only where the project file lets coop commit the sqlsc folder, and the shell form points to the tool", async () => {
    const shell = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc commit -m wip" } }, ctx);
    assert.ok(shell?.block && /sql_source tool \(command commit/.test(shell.reason), shell?.reason);
    const refused = await handlers.tool_call({ toolName: "sql_source", input: { command: "commit", message: "add Region" } }, ctx);
    assert.ok(refused?.block && /agent_allowed_to_commit/.test(refused.reason) && /database\/\*\*/.test(refused.reason), refused?.reason);
    assert.equal(confirms, 2, "not asked: the project file does not allow it");
    writeFileSync(join(client, ".coop", "project.yml"), `${readFileSync(join(client, ".coop", "project.yml"), "utf8")}repositories:
  warehouse:
    role: sql
    local_path: .
    agent_allowed_to_commit:
      - "database/**"
`);
    guards.resetSessionGovernance();
    const asked = await handlers.tool_call({ toolName: "sql_source", input: { command: "commit", message: "add Region" } }, ctx);
    assert.ok(asked?.block && /declined/.test(asked.reason), asked?.reason);
    assert.equal(confirms, 3, "asked once the folder is allowed");
    const headless = await handlers.tool_call({ toolName: "sql_source", input: { command: "commit", message: "add Region" } }, { cwd: client, hasUI: false });
    assert.ok(headless?.block && /headless/.test(headless.reason));
    assert.equal(await handlers.before_agent_start?.(), undefined, "no unscripted dev write: no note");
  });
  await t("handler: init asks once where there is something to set up, and is blocked headlessly", async () => {
    assert.equal(await handlers.tool_call({ toolName: "sql_source", input: { command: "init" } }, ctx), undefined, "already set up: the tool says so, nothing to ask");
    const fresh = mkdtempSync(join(tmpdir(), "coop-sqlsrc-fresh-"));
    mkdirSync(join(fresh, ".git"));
    const before = confirms;
    const asked = await handlers.tool_call({ toolName: "sql_source", input: { command: "init" } }, { ...ctx, cwd: fresh });
    assert.ok(asked?.block && /declined/.test(asked.reason), asked?.reason);
    assert.equal(confirms, before + 1);
    const headless = await handlers.tool_call({ toolName: "sql_source", input: { command: "init" } }, { cwd: fresh, hasUI: false });
    assert.ok(headless?.block && /headless/.test(headless.reason));
  });
}

await t("pull before commit: fetch + fast-forward check before the prompt, the pull after it; no upstream skips with a note", async () => {
  const fake = (script) => async (bin, args) => {
    assert.equal(bin, "git");
    assert.equal(args[2], "-c"); assert.equal(args[3], "credential.interactive=never");
    const sub = args[4] === "rev-parse" ? "upstream" : args[4] === "rev-list" ? "behind" : args[4] === "merge-base" ? "ancestor" : args[4];
    const r = script[sub];
    if (r === undefined) throw new Error(`unexpected git ${sub}`);
    return typeof r === "function" ? r(args) : r;
  };
  const ok = { code: 0, stdout: "", stderr: "" };
  const main = { ...ok, stdout: "origin/main\n" };
  const none = await lib.checkUpstream(fake({ upstream: { code: 128, stdout: "", stderr: "no upstream" } }), "/r");
  assert.ok(none.ok && none.behind === 0 && /no upstream branch/.test(none.note));
  const current = await lib.checkUpstream(fake({ upstream: main, fetch: ok, behind: { ...ok, stdout: "0\n" } }), "/r");
  assert.ok(current.ok && /up to date with origin\/main/.test(current.note));
  const ahead = await lib.checkUpstream(fake({ upstream: main, fetch: ok, behind: { ...ok, stdout: "2\n" }, ancestor: ok }), "/r");
  assert.ok(ahead.ok && ahead.behind === 2 && /pulls 2 commit\(s\) from origin\/main first/.test(ahead.note), "the prompt says what the pull will do");
  const diverged = await lib.checkUpstream(fake({ upstream: main, fetch: ok, behind: { ...ok, stdout: "1\n" }, ancestor: { code: 1, stdout: "", stderr: "" } }), "/r");
  assert.ok(!diverged.ok && /cannot fast-forward/.test(diverged.reason) && /pulls or rebases by hand/.test(diverged.reason), "stops before any prompt");
  const offline = await lib.checkUpstream(fake({ upstream: main, fetch: { code: 128, stdout: "", stderr: "fatal: unable to access" } }), "/r");
  assert.ok(!offline.ok && /could not fetch origin/.test(offline.reason));
  let pulled = 0;
  const ff = await lib.pullBeforeCommit(fake({ upstream: main, fetch: ok, behind: { ...ok, stdout: "2\n" }, ancestor: ok, pull: (a) => { pulled++; assert.ok(a.includes("--ff-only")); return ok; } }), "/r");
  assert.ok(ff.ok && ff.pulled === 2 && pulled === 1 && /pulled 2 commit/.test(ff.note));
  const dirty = await lib.pullBeforeCommit(fake({ upstream: main, fetch: ok, behind: { ...ok, stdout: "1\n" }, ancestor: ok, pull: { code: 1, stdout: "", stderr: "error: Your local changes to the following files would be overwritten by merge:\n\tdatabase/dbo/Views/v.sql" } }), "/r");
  assert.ok(!dirty.ok && /did not fast-forward/.test(dirty.reason), dirty.reason);
  assert.match(lib.pullRefusalText(dirty), /not committed; 1 commit\(s\) behind origin\/main/);
  const local = await lib.pullBeforeCommit(fake({ upstream: { code: 128, stdout: "", stderr: "no upstream" } }), "/r");
  assert.ok(local.ok && local.pulled === 0, "no upstream: no pull, the commit goes ahead");
  const nogit = await lib.pullBeforeCommit(async () => { throw new Error("spawn git ENOENT"); }, "/r");
  assert.ok(nogit.ok && /no upstream/.test(nogit.note), "no git at all: commit as before (sqlsc reports)");
});

console.log(`✓ sql-source tests passed (${n})${dist ? "" : " (lib only: set COOP_TEST_DIST for the tool and guardrails)"}`);
