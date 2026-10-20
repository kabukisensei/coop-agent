// SQL source control (master plan SQ12): the sql_source tool's argv and text
// (lib/sqlsc.mjs), the tool itself over a stubbed coop-sqlsc, and the
// guardrails: sqlsc's commit verbs are hard-blocked from the shell, database
// changes ask, and the tool's get_latest apply asks.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const AUDIT_DIR = mkdtempSync(join(tmpdir(), "coop-sqlsrc-audit-"));
process.env.PI_CODING_AGENT_DIR = AUDIT_DIR;

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
  assert.ok(lib.sqlSourceInput({ command: "deploy" }).error);
  assert.ok(lib.sqlSourceInput({ command: "checkout" }).error, "checkout needs objects");
  assert.ok(lib.sqlSourceInput({ command: "status", apply: true }).error, "apply is get_latest only");
  assert.ok(lib.sqlSourceInput({ command: "script", environment: "prod" }).error, "writes never take an environment");
  assert.ok(lib.sqlSourceInput({ command: "diff", objects: ["--force"] }).error, "an option is not an object name");
  assert.equal(lib.sqlSourceInput({ command: "diff", environment: "prod" }).environment, "prod");
});

await t("argv: coop acts as coop-agent:<person>, writes only to dev, never commits or forces", async () => {
  const agent = lib.agentIdentity("ada@example.com");
  assert.equal(agent, "coop-agent:ada@example.com");
  const args = (p) => lib.sqlSourceArgs(lib.sqlSourceInput(p), "/r/sqlsc.yml", agent);
  assert.deepEqual(args({ command: "checkout", objects: ["dbo.v"], note: "task" }),
    ["--json", "--config", "/r/sqlsc.yml", "checkout", "--as", agent, "--message", "task", "--", "dbo.v"]);
  assert.deepEqual(args({ command: "release", objects: ["dbo.v"] }), ["--json", "--config", "/r/sqlsc.yml", "unlock", "--as", agent, "--", "dbo.v"]);
  assert.deepEqual(args({ command: "get_latest" }), ["--json", "--config", "/r/sqlsc.yml", "get-latest", "--target", "dev", "--dry-run"]);
  assert.deepEqual(args({ command: "get_latest", apply: true }), ["--json", "--config", "/r/sqlsc.yml", "get-latest", "--target", "dev"]);
  assert.deepEqual(args({ command: "script" }), ["--json", "--config", "/r/sqlsc.yml", "script", "--target", "dev"]);
  for (const p of [{ command: "status" }, { command: "checkout", objects: ["x"] }, { command: "get_latest", apply: true }, { command: "release", objects: ["x"] }]) {
    const a = args(p);
    for (const word of ["commit", "checkin", "deploy", "--force", "--allow-drops", "--push"]) assert.ok(!a.includes(word), `${p.command} has no ${word}`);
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
  assert.match(got.head, /checks it in/);
  assert.match(got.head, /never commits/);
  const err = lib.sqlSourceText({ command: "status" }, { ok: false, error: { kind: "connect", message: "cannot reach dev" } });
  assert.match(err.head, /failed \(connect\): cannot reach dev/);
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
  tools.default(pi);
  const tool = registered.get("sql_source");
  const repo = mkdtempSync(join(tmpdir(), "coop-sqlsrc-tool-"));
  const run = (params, cwd = repo) => tool.execute("id", params, undefined, undefined, { cwd });

  await t("the tool is registered and says when source control is not set up", async () => {
    assert.ok(tool, "sql_source is registered");
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
}

// --- guardrails --------------------------------------------------------------------
if (guards) {
  const { sqlscShellRisk, decideSqlSource } = guards;
  await t("shell: sqlsc commit and checkin are hard-blocked; reads and coop's own checkouts pass", async () => {
    for (const cmd of ["sqlsc commit -m x", "coop-sqlsc --json checkin", "sqlsc --config a/sqlsc.yml checkin dbo.v -m done", "cd sql && sqlsc commit --push", "coop-sqlsc.exe commit"]) {
      assert.equal(sqlscShellRisk(cmd)?.hard, true, cmd);
    }
    for (const cmd of ["sqlsc status", "coop-sqlsc --json diff dbo.v", "sqlsc locks", "sqlsc checkin --no-commit", "sqlsc get-latest --dry-run", "sqlsc deploy -t prod --ref v1 -o r.sql", "sqlsc checkout dbo.v --as coop-agent:ada@example.com", "echo sqlsc commit", "sqlsc history -t prod"]) {
      assert.equal(sqlscShellRisk(cmd), null, cmd);
    }
  });
  await t("shell: database changes, forced unlocks, the guard and acting as someone else ask", async () => {
    for (const cmd of ["sqlsc get-latest", "sqlsc deploy -t test --ref v1", "sqlsc unlock dbo.v --force", "sqlsc guard install", "sqlsc checkout dbo.v --as bob@example.com"]) {
      const risk = sqlscShellRisk(cmd);
      assert.ok(risk && !risk.hard, cmd);
    }
    assert.equal(sqlscShellRisk("sqlsc get-latest").sessionKey, "sqlsc:get-latest");
    assert.equal(sqlscShellRisk("sqlsc deploy -t test").sessionKey, null, "a release asks every time");
  });
  await t("tool: only get_latest with apply asks", async () => {
    assert.equal(decideSqlSource({ input: { command: "get_latest", apply: true } }).action, "ask");
    for (const input of [{ command: "get_latest" }, { command: "checkout", objects: ["x"] }, { command: "script" }, {}]) {
      assert.equal(decideSqlSource({ input }).action, "allow", JSON.stringify(input));
    }
  });

  // The real handler: a hard block names the user's way to check in.
  const handlers = {};
  guards.default({ on: (ev, h) => (handlers[ev] = h), registerCommand: () => {}, exec: async () => ({ stdout: "", code: 0, stderr: "" }) });
  let confirms = 0;
  const ctx = { cwd: "/tmp/no-such-repo-sqlsrc", hasUI: true, ui: { confirm: async () => { confirms++; return false; }, notify: () => {} } };
  await t("handler: sqlsc commit is blocked without asking; get-latest asks; the tool's apply asks", async () => {
    const commit = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc commit -m wip" } }, ctx);
    assert.ok(commit?.block && /never commit source/.test(commit.reason) && /Check in/.test(commit.reason));
    assert.equal(confirms, 0);
    const apply = await handlers.tool_call({ toolName: "bash", input: { command: "sqlsc get-latest" } }, ctx);
    assert.ok(apply?.block, "declined");
    assert.equal(confirms, 1);
    const tool = await handlers.tool_call({ toolName: "sql_source", input: { command: "get_latest", apply: true } }, ctx);
    assert.ok(tool?.block, "declined");
    assert.equal(confirms, 2);
    assert.equal(await handlers.tool_call({ toolName: "sql_source", input: { command: "status" } }, ctx), undefined);
    const headless = await handlers.tool_call({ toolName: "sql_source", input: { command: "get_latest", apply: true } }, { cwd: ctx.cwd, hasUI: false });
    assert.ok(headless?.block && /headless/.test(headless.reason));
  });
}

console.log(`✓ sql-source tests passed (${n})${dist ? "" : " (lib only: set COOP_TEST_DIST for the tool and guardrails)"}`);
