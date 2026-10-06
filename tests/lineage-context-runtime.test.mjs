// Tests for the session lineage context (SQ8) as extensions/coop-tools runs it:
// the tool_call hook fills the store before an edit of a .sql file (snapshot,
// then the built docs through coop-data-doc), the tool_result hook records
// sql_impact and data_doc lineage answers and appends the summary line to the
// edit's result, /impact prints the detail, and a session switch starts empty.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const standardsFixture = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-rt-standards-")));
process.env.COOP_STANDARDS_ROOT = join(standardsFixture, "canonical");
process.env.COOP_STANDARDS_STATE = join(standardsFixture, "status.json");
process.env.COOP_STANDARDS_SNAPSHOT_ROOT = join(standardsFixture, "snapshots");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-rt-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
const { default: coopTools } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

function boot(execResult = () => ({ code: 0, stdout: "", stderr: "" })) {
  const tools = new Map();
  const handlers = {};
  const commands = {};
  const execs = [];
  const sent = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, opts) => { commands[name] = opts; },
    on: (name, handler) => { (handlers[name] ||= []).push(handler); },
    sendUserMessage: () => {},
    sendMessage: (message) => { sent.push(message); },
    exec: async (bin, args, opts) => {
      execs.push({ bin, args, cwd: opts?.cwd });
      const r = execResult(bin, args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  coopTools(pi);
  const fire = async (name, event, ctx) => {
    let out;
    for (const h of handlers[name] || []) {
      const r = await h(event, ctx);
      if (r !== undefined) out = r;
    }
    return out;
  };
  return { tools, commands, execs, sent, fire };
}
const ctxFor = (cwd) => ({ cwd, hasUI: true, mode: "tui", ui: { notify: () => {}, setStatus: () => {} } });

function contract(dir) {
  mkdirSync(join(dir, ".coop"), { recursive: true });
  writeFileSync(join(dir, ".coop", "project.yml"), "profile:\n  client: Contoso\nsql_targets:\n  default_environment: dev\n  dev:\n    kind: azure_sql\n    server: contoso-dev.database.windows.net\n    database: ContosoDW\n");
}
function snapshot(folder) {
  mkdirSync(join(folder, "dbo"), { recursive: true });
  mkdirSync(join(folder, "rpt"), { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ coop_catalog_snapshot: true, schema_version: 1, taken_at: new Date().toISOString(), target: { environment: "dev" }, objects: {}, files: [] }));
  writeFileSync(join(folder, "dbo", "Orders.sql"), "-- coop catalog snapshot: table dbo.Orders\nCREATE TABLE [dbo].[Orders] (\n  [OrderId] int NOT NULL,\n  [Region] nvarchar(50) NULL\n);\n");
  writeFileSync(join(folder, "rpt", "vw_SalesByRegion.sql"), "-- coop catalog snapshot: view rpt.vw_SalesByRegion\nCREATE VIEW rpt.vw_SalesByRegion AS SELECT [Region] FROM dbo.Orders;\n");
}
function docs(root) {
  writeFileSync(join(root, "coop-data-doc.yml"), 'project_name: "x"\nrepos:\n  sql:\n    path: "./sql"\noutput:\n  dir: "./data-docs"\n');
  mkdirSync(join(root, "data-docs"), { recursive: true });
  writeFileSync(join(root, "data-docs", "manifest.json"), "{}");
  writeFileSync(join(root, "data-docs", "graph.json"), "{}");
}
const SLICE = {
  object: { name: "dbo.Orders", kind: "table" },
  upstream: [],
  downstream: [{ name: "rpt.vw_SalesByRegion", type: "view" }],
  loaded_by: [{ table: { name: "Sales.Orders", type: "pbi_table" }, source: "dbo.Orders", linked: true }],
};

try {
  await t("before an edit of a .sql file the context fills from the snapshot, then the built docs; the result gets the summary line", async () => {
    const repo = join(tmp, "estate");
    contract(repo);
    snapshot(join(repo, ".coop", "catalog", "dev"));
    docs(repo);
    mkdirSync(join(repo, "sql", "dbo"), { recursive: true });
    const file = join(repo, "sql", "dbo", "Orders.sql");
    writeFileSync(file, "CREATE TABLE dbo.Orders ([OrderId] int NOT NULL, [Region] nvarchar(50) NULL)");
    const { execs, fire, commands, sent } = boot(() => ({ code: 0, stdout: JSON.stringify(SLICE), stderr: "" }));
    const ctx = ctxFor(repo);
    await fire("session_start", { reason: "new" }, ctx);
    const edit = { toolName: "edit", toolCallId: "e1", input: { path: "sql/dbo/Orders.sql", oldText: "a", newText: "b" } };
    assert.equal(await fire("tool_call", edit, ctx), undefined, "the hook never blocks; the guardrails decide");
    assert.deepEqual(execs, [{ bin: "coop-data-doc", args: ["lineage", "--", "dbo.orders"], cwd: repo }]);
    const result = await fire("tool_result", { ...edit, content: [{ type: "text", text: "Edited sql/dbo/Orders.sql" }], isError: false }, ctx);
    assert.ok(result?.content, "the edit's result is extended");
    assert.equal(result.content[0].text, "Edited sql/dbo/Orders.sql");
    assert.match(result.content[1].text, /^Downstream of dbo\.orders: rpt\.vw_SalesByRegion \(view, uses Region\); Sales\.Orders \(power bi table, loads it by name\)\./);
    assert.match(result.content[1].text, /\/impact shows the detail\.$/);
    // A second edit of the same object: no new lookup, same line.
    const again = { ...edit, toolCallId: "e2" };
    await fire("tool_call", again, ctx);
    assert.equal(execs.length, 1, "held for the session: coop-data-doc is not asked again");
    const second = await fire("tool_result", { ...again, content: [{ type: "text", text: "ok" }], isError: false }, ctx);
    assert.match(second.content[1].text, /^Downstream of dbo\.orders:/);
    // A failed edit gets no line; a non-SQL file is never touched.
    assert.equal(await fire("tool_result", { ...edit, toolCallId: "e3", content: [], isError: true }, ctx), undefined);
    assert.equal(await fire("tool_call", { toolName: "edit", toolCallId: "e4", input: { path: "README.md" } }, ctx), undefined);
    assert.equal(await fire("tool_result", { toolName: "edit", toolCallId: "e4", content: [{ type: "text", text: "x" }], isError: false }, ctx), undefined);
    // /impact prints the detail without a model turn.
    await commands.impact.handler("dbo.Orders", ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "coop-lineage-context");
    assert.equal(sent[0].display, true);
    assert.match(sent[0].content, /^Lineage context \(this session\):\ndbo\.orders \(table\)\nsources: snapshot hit, built docs hit, live catalog absent\ncolumns: OrderId, Region\n- rpt\.vw_SalesByRegion \(view\): uses Region\n- Sales\.Orders \(power bi table\) \(loads it by name\)$/);
    await commands.impact.handler("", ctx);
    assert.match(sent[1].content, /^Lineage context \(this session\):\nDownstream of dbo\.orders:/);
    await commands.impact.handler("dbo.Nope", ctx);
    assert.match(sent[2].content, /holds no lineage for dbo\.Nope this session/);
    // A session switch starts empty.
    await fire("session_shutdown", {}, ctx);
    await fire("session_start", { reason: "new" }, ctx);
    await commands.impact.handler("", ctx);
    assert.match(sent[3].content, /holds no lineage context yet this session/);
  });

  await t("sql_impact and data_doc lineage results land in the context; a write carries its own content", async () => {
    const repo = join(tmp, "live");
    contract(repo);
    const { fire, commands, sent, execs } = boot();
    const ctx = ctxFor(repo);
    await fire("session_start", { reason: "new" }, ctx);
    await fire("tool_result", {
      toolName: "sql_impact", toolCallId: "s1", input: { object: "vw_Sales" }, isError: false, content: [],
      details: {
        ok: true, state: "ok", object: { schema: "dbo", name: "vw_Sales", type: "VIEW" },
        downstream: { state: "ok", items: [{ schema: "rpt", name: "vw_SalesByRegion", type: "VIEW", columns: ["Region"] }], column_references: "ok" },
        columns: { state: "ok", items: [{ name: "Region" }, { name: "Amount" }] },
      },
    }, ctx);
    await fire("tool_result", {
      toolName: "data_doc", toolCallId: "d1", input: { command: "lineage", object: "dbo.vw_Sales" }, isError: false, content: [],
      details: { tool: "coop-data-doc", command: "lineage", object: "dbo.vw_Sales", exitCode: 0, lineage: { object: { name: "dbo.vw_Sales", kind: "view" }, downstream: [{ name: "Sales.Total", type: "measure" }] } },
    }, ctx);
    // A sql_impact that could not reach the target still counts as asked.
    await fire("tool_result", { toolName: "sql_impact", toolCallId: "s2", input: { object: "dbo.Unreachable" }, isError: true, content: [], details: { ok: false, state: "connection_failed" } }, ctx);
    await commands.impact.handler("dbo.vw_Sales", ctx);
    assert.match(sent[0].content, /sources: snapshot absent, built docs hit, live catalog hit\ncolumns: Region, Amount\n- rpt\.vw_SalesByRegion \(view\): uses Region\n- Sales\.Total \(measure\)$/);
    await commands.impact.handler("dbo.Unreachable", ctx);
    assert.match(sent[1].content, /sources: snapshot absent, built docs absent, live catalog miss\ndownstream: none found/);
    // A write of a new file: the object comes from the content, no docs here, and
    // the summary says nothing was found rather than claiming zero impact.
    const write = { toolName: "write", toolCallId: "w1", input: { path: join(repo, "sql", "usp_New.sql"), content: "CREATE PROCEDURE dbo.usp_New AS SELECT 1" } };
    await fire("tool_call", write, ctx);
    assert.deepEqual(execs, [], "no built docs: coop-data-doc is never run");
    const out = await fire("tool_result", { ...write, content: [{ type: "text", text: "Wrote" }], isError: false }, ctx);
    assert.equal(out.content[1].text, "Downstream of dbo.usp_new: none found (no lineage source); an empty result is not proof of zero impact.");
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(standardsFixture, { recursive: true, force: true });
}
console.log(`lineage-context-runtime: ${n} test(s) passed`);
