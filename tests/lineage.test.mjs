// Tests for the data_doc tool's `lineage` branch and the before_agent_start
// lineage note in extensions/coop-tools. Drives the REAL registered tool and
// handler with a fake pi (exec is faked; no coop-data-doc binary is needed).
// Imports the bundled extension (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
// before_agent_start may refresh standards; keep that storage in a fixture, never
// the developer's real ~/.coop/standards (#87). Roots are real paths: macOS keeps
// tmpdir() under the /var -> /private/var symlink, which the storage check rejects.
const standardsFixture = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-standards-")));
process.env.COOP_STANDARDS_ROOT = join(standardsFixture, "canonical");
process.env.COOP_STANDARDS_STATE = join(standardsFixture, "status.json");
process.env.COOP_STANDARDS_SNAPSHOT_ROOT = join(standardsFixture, "snapshots");
const { default: coopTools, builtLineageDir, impactFileArgs, modelText, sqlImpactLines, sqlRowLines } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

/** Boot the extension with a fake pi; `execResult(bin, args)` answers pi.exec. */
function boot(execResult = () => ({ code: 0, stdout: "", stderr: "" })) {
  const tools = new Map();
  const handlers = new Map();
  const execs = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (name, handler) => handlers.set(name, handler),
    sendUserMessage: () => {},
    exec: async (bin, args, opts) => {
      execs.push({ bin, args, cwd: opts?.cwd });
      const r = execResult(bin, args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  coopTools(pi);
  return { tools, handlers, execs };
}

const ctxFor = (cwd) => ({
  cwd,
  hasUI: true,
  mode: "tui",
  ui: { notify: () => {}, setStatus: () => {} },
});

const lineage = (tools, params, cwd = "/estate") =>
  tools.get("data_doc").execute("call-1", params, undefined, () => {}, ctxFor(cwd));

const SLICE = {
  object: { name: "dbo.fact_sales", kind: "table" },
  upstream: [{ name: "dbo.stg_sales" }, { name: "dbo.dim_date" }],
  downstream: [{ name: "Sales.Total Sales" }],
  relationships: [{ from: "dbo.fact_sales", to: "dbo.dim_date" }],
};

await t("lineage without an object asks for one and never runs coop-data-doc", async () => {
  const { tools, execs } = boot();
  const r = await lineage(tools, { command: "lineage" });
  assert.match(r.content[0].text, /needs an 'object'/);
  assert.deepEqual(r.details, { tool: "coop-data-doc", command: "lineage" });
  const blank = await lineage(tools, { command: "lineage", object: "   " });
  assert.match(blank.content[0].text, /needs an 'object'/);
  assert.deepEqual(execs, []);
});

await t("lineage runs `coop-data-doc lineage [--depth N] -- <object>` in the session cwd and summarizes the slice", async () => {
  const { tools, execs } = boot(() => ({ code: 0, stdout: JSON.stringify(SLICE), stderr: "" }));
  const r = await lineage(tools, { command: "lineage", object: " dbo.fact_sales ", depth: 2.7 }, "/work/estate");
  assert.deepEqual(execs, [{ bin: "coop-data-doc", args: ["lineage", "--depth", "2", "--", "dbo.fact_sales"], cwd: "/work/estate" }]);
  // Pi gives the model the text only (never details), so the names are in it.
  assert.equal(r.content[0].text, [
    "Observed lineage for dbo.fact_sales: 2 upstream, 1 downstream, 1 relationship(s). Evidence confidence: unknown; states: unknown. Empty results do not prove zero impact.",
    "Upstream:",
    "- dbo.stg_sales",
    "- dbo.dim_date",
    "Downstream:",
    "- Sales.Total Sales",
    "Relationships:",
    '- {"from":"dbo.fact_sales","to":"dbo.dim_date"}',
  ].join("\n"));
  assert.equal(r.details.tool, "coop-data-doc");
  assert.equal(r.details.command, "lineage");
  assert.equal(r.details.exitCode, 0);
  assert.deepEqual(r.details.lineage, SLICE, "the parsed slice travels in details");
});

await t("lineage passes an object that starts with '-' after `--`, never as a flag", async () => {
  const { tools, execs } = boot(() => ({ code: 0, stdout: JSON.stringify(SLICE), stderr: "" }));
  await lineage(tools, { command: "lineage", object: "--depth", depth: 0 });
  assert.deepEqual(execs[0].args, ["lineage", "--", "--depth"]);
});

await t("lineage reports an ambiguous name and keeps the candidates in details", async () => {
  const out = { ambiguous: true, matches: [{ name: "Sales.Total" }, { name: "Finance.Total" }] };
  const { tools } = boot(() => ({ code: 0, stdout: JSON.stringify(out), stderr: "" }));
  const r = await lineage(tools, { command: "lineage", object: "Total" });
  assert.match(r.content[0].text, /'Total' is ambiguous — 2 matches/);
  assert.match(r.content[0].text, /\n- Sales\.Total\n- Finance\.Total$/, "the candidates are in the text");
  assert.deepEqual(r.details.lineage, out);
});

await t("lineage with no built graph degrades to the /setup-docs hint", async () => {
  const { tools } = boot(() => ({ code: 1, stdout: "", stderr: "error: no built graph at ./data-docs/graph.json\n" }));
  const r = await lineage(tools, { command: "lineage", object: "dbo.fact_sales" });
  assert.match(r.content[0].text, /^No built lineage graph yet/);
  assert.match(r.content[0].text, /\/setup-docs/);
  assert.match(r.content[0].text, /still work without it/);
  assert.equal(r.details.exitCode, 1);
  assert.equal(r.details.lineage, "", "unparseable stdout is passed through raw");
});

await t("other lineage failures surface the exit code and the tool's message", async () => {
  const { tools } = boot(() => ({ code: 2, stdout: "", stderr: "Error: config invalid\n" }));
  const r = await lineage(tools, { command: "lineage", object: "dbo.fact_sales" });
  assert.equal(r.content[0].text, "lineage failed (exit 2): Error: config invalid");
  assert.equal(r.details.stderr, "Error: config invalid\n");
});

await t("lineage explains a coop-data-doc that cannot run", async () => {
  const { tools } = boot(() => new Error("spawn coop-data-doc ENOENT"));
  const r = await lineage(tools, { command: "lineage", object: "dbo.fact_sales" });
  assert.match(r.content[0].text, /^coop-data-doc could not run: spawn coop-data-doc ENOENT/);
  assert.match(r.content[0].text, /coop install/);
  assert.equal(r.details.error, "spawn coop-data-doc ENOENT");
});

// --- before_agent_start: the agent-visible, human-hidden lineage note ----------

function estate(built, outputDir = "./data-docs") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-estate-")));
  writeFileSync(join(root, "coop-data-doc.yml"), `project_name: "x"\nrepos:\n  sql:\n    path: "./sql"\noutput:\n  dir: "${outputDir}"\n`);
  if (built) {
    mkdirSync(join(root, outputDir), { recursive: true });
    writeFileSync(join(root, outputDir, "manifest.json"), "{}");
    writeFileSync(join(root, outputDir, "graph.json"), "{}");
  }
  return root;
}

const before = (handlers, cwd) => handlers.get("before_agent_start")({ systemPrompt: "BASE", prompt: "hi" }, ctxFor(cwd));
const lineageNote = (r) => (r?.message?.customType === "coop-lineage" ? r.message : null);

await t("built docs inject one hidden lineage note per folder that points at data_doc lineage", async () => {
  const root = estate(true, "./docs/lineage");
  const { handlers } = boot();
  const first = await before(handlers, root);
  const note = lineageNote(first);
  assert.ok(note, `expected a coop-lineage message, got ${JSON.stringify(first)}`);
  assert.equal(note.display, false, "agent-visible, human-hidden");
  assert.match(note.content, /^An observed lineage graph is available/);
  assert.ok(note.content.includes(`under ${join("docs", "lineage")}:`), "names the output dir relative to cwd");
  assert.match(note.content, /data_doc tool \(command="lineage", object="<name>"\)/);
  assert.match(note.content, /BEFORE analyzing or changing any SQL object, DAX measure, or semantic model/);
  assert.deepEqual(note.details, { outputDir: join("docs", "lineage") });
  const again = await before(handlers, root);
  assert.equal(lineageNote(again), null, "announced once per session folder");
  assert.ok(!(again?.message?.content || "").includes("lineage docs ARE available"));
});

await t("a config without built docs, or no config at all, injects no lineage note", async () => {
  const unbuilt = estate(false);
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "coop-lineage-bare-")));
  const { handlers } = boot();
  for (const cwd of [unbuilt, bare]) {
    const r = await before(handlers, cwd);
    assert.equal(lineageNote(r), null, `no coop-lineage message for ${cwd}`);
    assert.ok(!(r?.message?.content || "").includes("lineage docs ARE available"));
  }
  // The same folder is retried: once docs are built, the note appears.
  mkdirSync(join(unbuilt, "data-docs"), { recursive: true });
  writeFileSync(join(unbuilt, "data-docs", "index.md"), "# docs");
  assert.equal(lineageNote(await before(handlers, unbuilt)), null, "index-only output never claims graph availability");
  writeFileSync(join(unbuilt, "data-docs", "graph.json"), "{}");
  const r = await before(handlers, unbuilt);
  const note = lineageNote(r);
  assert.doesNotMatch(note.content, /manifest.json/);
  assert.ok(note, "an unbuilt folder is not marked as announced");
  assert.deepEqual(note.details, { outputDir: "data-docs" });
});

await t("built-docs detection follows the companion's config discovery from a subfolder", async () => {
  const root = estate(true, "./docs/lineage");
  const sub = join(root, "models", "sales");
  mkdirSync(sub, { recursive: true });
  const outAbs = join(root, "docs", "lineage");
  assert.equal(builtLineageDir(sub, {}), outAbs, "a parent's coop-data-doc.yml is found, output.dir resolves against its folder");
  assert.equal(builtLineageDir(root, { COOP_DATA_DOC_CONFIG: join(sub, "missing.yml") }), null, "an explicit config path wins, even when missing");
  assert.equal(builtLineageDir(sub, { COOP_DATA_DOC_CONFIG: join(root, "coop-data-doc.yml") }), outAbs);
  const indexOnly = estate(false);
  mkdirSync(join(indexOnly, "data-docs"), { recursive: true });
  writeFileSync(join(indexOnly, "data-docs", "index.md"), "# docs");
  assert.equal(builtLineageDir(indexOnly, {}), null, "Markdown without graph.json is not a lineage graph");
  const { handlers } = boot();
  const note = lineageNote(await before(handlers, sub));
  assert.ok(note, "the session-start note appears in a subfolder of the estate");
  assert.deepEqual(note.details, { outputDir: join("..", "..", "docs", "lineage") });
});

await t("lineage names the object's type and doc page, and says when a side is empty", async () => {
  const slice = {
    object: { name: "dbo.vw_sales", type: "view", doc: "view/dbo-vw-sales.md" },
    upstream: [{ id: "table:dbo.sales", name: "dbo.sales", type: "silver_table" }],
    downstream: [],
    relationships: [],
    evidence: { state: "partial", states: ["partial", "unresolved"] },
  };
  const { tools } = boot(() => ({ code: 0, stdout: JSON.stringify(slice), stderr: "" }));
  const text = (await lineage(tools, { command: "lineage", object: "vw_sales" })).content[0].text;
  assert.match(text, /^Observed lineage for dbo\.vw_sales \(view\): 1 upstream, 0 downstream/);
  assert.match(text, /Evidence confidence: partial; states: partial, unresolved\./);
  assert.match(text, /\nDoc: view\/dbo-vw-sales\.md\n/);
  assert.match(text, /\nUpstream:\n- dbo\.sales \(silver_table\)\nDownstream: none observed$/);
});

await t("lineage lists the Power BI tables that load the object, and says when only the name links them", async () => {
  const slice = {
    object: { name: "sales.v_orders_star", type: "view", doc: "view/sales-v-orders-star.md" },
    upstream: [],
    downstream: [{ id: "pbi_table:sales.orders_native", name: "Sales.Orders Native", type: "pbi_table" }],
    relationships: [],
    loaded_by: [
      { table: { id: "pbi_table:sales.orders_native", name: "Sales.Orders Native", type: "pbi_table" }, source: "sales.v_orders_star", linked: true },
      { table: { id: "pbi_table:finance.orders", name: "Finance.Orders", type: "pbi_table" }, source: ["sales.v_orders_star", "dbo.v_orders_star"], linked: false },
    ],
    evidence: { state: "partial", states: ["partial"] },
  };
  const { tools } = boot(() => ({ code: 0, stdout: JSON.stringify(slice), stderr: "" }));
  const text = (await lineage(tools, { command: "lineage", object: "v_orders_star" })).content[0].text;
  assert.match(text, /\nDownstream:\n- Sales\.Orders Native \(pbi_table\)\nLoaded by \(Power BI tables whose partition names this object\):\n/);
  assert.match(text, /\n- Sales\.Orders Native \(pbi_table\) loads sales\.v_orders_star\n/);
  assert.match(text, /\n- Finance\.Orders \(pbi_table\) loads sales\.v_orders_star, dbo\.v_orders_star \(by name only; SQL object not documented or not linked\)$/);
});

await t("lineage of a view the docs do not hold names the Power BI tables that load it instead of failing", async () => {
  // coop-data-doc 1.3.2+: the SQL repo is not a documented source, but a model's
  // partition names the view, so `lineage` answers with object: null + loaded_by.
  const slice = {
    query: "dbo.vSales",
    object: null,
    undocumented_source: true,
    loaded_by: [{ table: { id: "pbi_table:sales.vsales", name: "Sales.vSales", type: "pbi_table" }, source: "dbo.vsales", linked: false }],
    upstream: [],
    downstream: [{ id: "pbi_table:sales.vsales", name: "Sales.vSales", type: "pbi_table" }],
    evidence: { state: "missing", states: ["missing", "unresolved"] },
  };
  const { tools } = boot(() => ({ code: 0, stdout: JSON.stringify(slice), stderr: "" }));
  const r = await lineage(tools, { command: "lineage", object: "dbo.vSales" });
  assert.equal(r.content[0].text, [
    "'dbo.vSales' is not a documented object, but 1 Power BI table(s) load it by name (the SQL side is not in the docs; use sql_impact for its SQL dependents). Evidence confidence: missing; states: missing, unresolved. Empty results do not prove zero impact.",
    "Loaded by (Power BI tables whose partition names this object):",
    "- Sales.vSales (pbi_table) loads dbo.vsales (by name only; SQL object not documented or not linked)",
  ].join("\n"));
  assert.deepEqual(r.details.lineage, slice);
});

await t("an ambiguous lineage answer still names the tables that load the object", async () => {
  const out = {
    ambiguous: true,
    matches: [{ name: "sales.dim_customer", type: "view" }, { name: "Sales.dim_customer", type: "pbi_table" }],
    loaded_by: [{ table: { name: "Sales.dim_customer", type: "pbi_table" }, source: "sales.dim_customer", linked: true }],
  };
  const { tools } = boot(() => ({ code: 0, stdout: JSON.stringify(out), stderr: "" }));
  const text = (await lineage(tools, { command: "lineage", object: "dim_customer" })).content[0].text;
  assert.match(text, /^'dim_customer' is ambiguous — 2 matches/);
  assert.match(text, /\nLoaded by \(Power BI tables whose partition names this object\):\n- Sales\.dim_customer \(pbi_table\) loads sales\.dim_customer$/);
});

// --- impact: what the changed files feed ------------------------------------

const IMPACT = {
  schema_version: 2,
  impacts: { "view:dbo.vw_sales": ["model:Sales.Total Sales", "report:Sales Overview"], "table:dbo.dim_date": [] },
  evidence: { state: "partial", states: ["partial"] },
  baseline_evidence: { state: "partial", states: ["partial"] },
};

await t("impact without files or a ref asks for them and never runs coop-data-doc", async () => {
  const { tools, execs } = boot();
  const r = await lineage(tools, { command: "impact" });
  assert.match(r.content[0].text, /needs `files`/);
  const bad = await lineage(tools, { command: "impact", against: "--output=x" });
  assert.match(bad.content[0].text, /is not a git ref name/);
  assert.deepEqual(execs, []);
});

await t("impact with files uses the built graph as its own baseline and lists every downstream object", async () => {
  const root = estate(true);
  const { tools, execs } = boot(() => ({ code: 0, stdout: JSON.stringify(IMPACT), stderr: "" }));
  const r = await lineage(tools, { command: "impact", files: ["views/vw_sales.sql", " ", "-odd.sql"] }, root);
  assert.equal(execs.length, 1);
  assert.equal(execs[0].bin, "coop-data-doc");
  assert.deepEqual(execs[0].args.slice(0, 4), ["impact", "--format=json", "--evidence", `--baseline=${join(root, "data-docs", "graph.json")}`]);
  assert.ok(execs[0].args.includes("--files=views/vw_sales.sql"), JSON.stringify(execs[0].args));
  assert.ok(execs[0].args.includes("--files=-odd.sql"), "a leading '-' stays a value with --files=");
  assert.equal(execs[0].cwd, root);
  const text = r.content[0].text;
  assert.match(text, /^Observed downstream impact of 2 changed file\(s\): 2 changed object\(s\) feed 2 downstream object\(s\)\. Evidence confidence: partial/);
  assert.match(text, /\n- view:dbo\.vw_sales feeds 2:\n  - model:Sales\.Total Sales\n  - report:Sales Overview\n- table:dbo\.dim_date: no observed downstream$/);
  assert.deepEqual(r.details.impact, IMPACT);
});

await t("impact against a git ref diffs the rebuilt graph and needs no built-graph lookup", async () => {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "coop-impact-bare-")));
  const { tools, execs } = boot(() => ({ code: 0, stdout: JSON.stringify({ ...IMPACT, impacts: {} }), stderr: "" }));
  const r = await lineage(tools, { command: "impact", against: "origin/main" }, bare);
  assert.deepEqual(execs[0].args, ["impact", "--format=json", "--evidence", "--git=origin/main"]);
  assert.match(r.content[0].text, /^No documented object matched the rebuilt graph against origin\/main\./);
  assert.match(r.content[0].text, /zero impact/);
});

await t("impact with no built graph points at build and /setup-docs", async () => {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "coop-impact-nograph-")));
  const { tools, execs } = boot();
  const r = await lineage(tools, { command: "impact", files: ["a.sql"] }, bare);
  assert.match(r.content[0].text, /^No built lineage graph yet/);
  assert.deepEqual(execs, []);
  const failing = boot(() => ({ code: 1, stdout: "", stderr: "Error: Could not read data-docs/graph.json from git ref main\n" }));
  const f = await lineage(failing.tools, { command: "impact", against: "main" }, bare);
  assert.equal(f.content[0].text, "impact failed (exit 1): Error: Could not read data-docs/graph.json from git ref main");
});

await t("impact file paths also go to the companion relative to each documented repo root", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-impact-roots-")));
  const docs = join(root, "docs");
  mkdirSync(join(root, "sql-repo", "Views"), { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "coop-data-doc.yml"), 'repos:\n  sql:\n    path: "../sql-repo"\n  powerbi:\n    path: "../pbi"\noutput:\n  dir: "./data-docs"\n');
  const abs = join(root, "sql-repo", "Views", "vw_sales.sql");
  assert.deepEqual(impactFileArgs([join("..", "sql-repo", "Views", "vw_sales.sql")], docs, {}), ["../sql-repo/Views/vw_sales.sql", "Views/vw_sales.sql"]);
  assert.deepEqual(impactFileArgs([abs], docs, {}), [abs.replace(/\\/g, "/"), "Views/vw_sales.sql"]);
  assert.deepEqual(impactFileArgs(["./Views/x.sql"], join(root, "sql-repo"), {}), ["Views/x.sql"], "no config: the path as given, POSIX, without ./");
});

await t("daily logging treats impact like lineage (read-only)", async () => {
  const { dailyLogToolEffect } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
  assert.equal(dailyLogToolEffect("data_doc", { command: "impact" }, "/w", "/w/log.md"), "none");
  assert.equal(dailyLogToolEffect("data_doc", { command: "build" }, "/w", "/w/log.md"), "meaningful");
});

// --- the text the model sees for the SQL tools --------------------------------

await t("modelText caps the text and says how many lines were left out", async () => {
  assert.equal(modelText("head", ["a", "b"], "hint"), "head\na\nb");
  const capped = modelText("head", ["aaaa", "bbbb", "cccc"], "narrow it", 12);
  assert.equal(capped, "head\naaaa\n… 2 more line(s) not shown: narrow it");
});

await t("sql_impact and fabric_sql_query render their items and rows as text", async () => {
  const lines = sqlImpactLines({
    downstream: { state: "ok", count: 1, truncated: false, items: [{ schema: "dbo", name: "vw_top", type: "VIEW" }] },
    upstream: { state: "ok", count: 2, truncated: true, items: [
      { schema: "dbo", name: "sales", type: "USER_TABLE", resolved: true },
      { schema: "dbo", name: "gone", type: "unknown", resolved: false, mentioned_in_definition: false, database: "old" },
    ] },
    columns: { state: "unavailable", reason: "INFORMATION_SCHEMA.COLUMNS query failed", items: [], count: 0, truncated: false },
  });
  assert.deepEqual(lines, [
    "Downstream (1):",
    "- dbo.vw_top (VIEW)",
    "Upstream (2+, capped):",
    "- dbo.sales (USER_TABLE)",
    "- old.dbo.gone (unknown, unresolved, not named in the definition)",
    "Columns: unavailable (INFORMATION_SCHEMA.COLUMNS query failed)",
  ]);
  assert.deepEqual(sqlRowLines({ columns: ["id", "name"], rows: [[1, "a"], [2, null]] }), ['Columns: ["id","name"]', '[1,"a"]', "[2,null]"]);
});

console.log(`  ${n} lineage tests passed`);
