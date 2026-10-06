// Tests for lib/lineage-context.mjs (master plan SQ8): the per-session store,
// the SQL object a file edit is about, the committed snapshot as a lineage
// source, the other sources normalized, the summary line and the edit gate.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const lc = await import(pathToFileURL(join(ROOT, "lib", "lineage-context.mjs")).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

const tmp = mkdtempSync(join(tmpdir(), "coop-lineage-context-"));
const agent = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
const NOW = Date.parse("2026-10-05T22:00:00Z");
const DAY = 86_400_000;

function contract(dir, extra = "") {
  mkdirSync(join(dir, ".coop"), { recursive: true });
  writeFileSync(join(dir, ".coop", "project.yml"), ["profile:", "  client: Contoso", "sql_targets:", "  default_environment: dev", "  dev:", "    kind: azure_sql", "    server: contoso-dev.database.windows.net", "    database: ContosoDW", extra].join("\n") + "\n");
}
function snapshot(folder, takenAt = "2026-10-05T22:00:00Z") {
  mkdirSync(join(folder, "dbo"), { recursive: true });
  mkdirSync(join(folder, "rpt"), { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ coop_catalog_snapshot: true, schema_version: 1, taken_at: takenAt, target: { environment: "dev" }, objects: {}, files: [] }));
  writeFileSync(join(folder, "dbo", "Orders.sql"), "-- coop catalog snapshot: table dbo.Orders\nCREATE TABLE [dbo].[Orders] (\n  [OrderId] int NOT NULL,\n  [Region] nvarchar(50) NULL,\n  [Amount] decimal(18, 2) NULL\n);\n");
  writeFileSync(join(folder, "rpt", "vw_SalesByRegion.sql"), "-- coop catalog snapshot: view rpt.vw_SalesByRegion\nCREATE VIEW [rpt].[vw_SalesByRegion] AS\nSELECT o.[Region], SUM(o.[Amount]) AS Total FROM [dbo].[Orders] AS o GROUP BY o.[Region];\n");
  writeFileSync(join(folder, "dbo", "usp_Refresh.sql"), "-- coop catalog snapshot: procedure dbo.usp_Refresh\nCREATE PROCEDURE dbo.usp_Refresh AS\nBEGIN\n  DELETE FROM Orders WHERE OrderId < 0;\nEND;\n");
  writeFileSync(join(folder, "dbo", "vw_Unrelated.sql"), "-- coop catalog snapshot: view dbo.vw_Unrelated\nCREATE VIEW dbo.vw_Unrelated AS SELECT 1 AS One;\n");
}

try {
  await t("object names normalize to lower-case schema.name, dbo by default", () => {
    assert.equal(lc.normalizeObject("dbo.vw_Sales"), "dbo.vw_sales");
    assert.equal(lc.normalizeObject("[Finance].[Ledger]"), "finance.ledger");
    assert.equal(lc.normalizeObject("Orders"), "dbo.orders");
    assert.equal(lc.normalizeObject("OtherDb.dbo.X"), "dbo.x");
    assert.equal(lc.normalizeObject(""), "");
  });

  await t("the SQL object a file defines: its CREATE statement, else the snapshot layout, else dbo.<stem>", () => {
    assert.deepEqual(lc.sqlObjectFromFile("/x/anything.sql", "CREATE OR ALTER VIEW [rpt].[vw_Sales] AS SELECT 1"), { object: "rpt.vw_sales", kind: "view" });
    assert.deepEqual(lc.sqlObjectFromFile("/x/p.sql", "create proc dbo.usp_Load as select 1"), { object: "dbo.usp_load", kind: "procedure" });
    assert.deepEqual(lc.sqlObjectFromFile("/x/f.sql", "CREATE FUNCTION fn_Tax() RETURNS int AS BEGIN RETURN 1 END"), { object: "dbo.fn_tax", kind: "function" });
    assert.deepEqual(lc.sqlObjectFromFile(join(tmp, "sales", "Orders.sql"), ""), { object: "sales.orders", kind: "unknown" });
    // The temp folder's name has hyphens, so it is no schema: dbo.<stem>.
    assert.deepEqual(lc.sqlObjectFromFile(join(tmp, "migration_001.sql"), "-- a script\nINSERT INTO x VALUES (1)"), { object: "dbo.migration_001", kind: "unknown" });
    assert.equal(lc.sqlObjectFromFile("/x/notes.md", "CREATE VIEW v AS SELECT 1"), null);
    const onDisk = join(tmp, "disk", "vw_Disk.sql");
    mkdirSync(join(tmp, "disk"), { recursive: true });
    writeFileSync(onDisk, "CREATE VIEW dbo.vw_Disk AS SELECT 1");
    assert.deepEqual(lc.sqlObjectFromFile(onDisk), { object: "dbo.vw_disk", kind: "view" }, "an edit reads the file on disk");
  });

  await t("the store is one file per Pi process under the agent dir; entries merge by dependent", () => {
    const path = lc.contextPath();
    assert.equal(path, join(agent, "lineage-context", `${process.pid}.json`));
    assert.equal(lc.getEntry("dbo.Orders"), null);
    const first = lc.recordLineage("dbo.Orders", "snapshot", { kind: "table", columns: ["OrderId", "Region"], downstream: [{ name: "rpt.vw_SalesByRegion", kind: "view", columns: ["Region"] }] });
    assert.equal(first.object, "dbo.orders");
    assert.deepEqual(first.sources, { snapshot: "hit", docs: "absent", live: "absent" });
    const second = lc.recordLineage("Orders", "live", { kind: "table", columns: ["OrderId", "Region", "Amount"], downstream: [{ name: "rpt.vw_SalesByRegion", kind: "view", columns: ["Amount"] }, { name: "dbo.usp_Refresh", kind: "procedure" }] });
    assert.deepEqual(second.sources, { snapshot: "hit", docs: "absent", live: "hit" });
    assert.deepEqual(second.downstream.map((d) => [d.name, d.kind, d.columns]), [["rpt.vw_SalesByRegion", "view", ["Region", "Amount"]], ["dbo.usp_Refresh", "procedure", undefined]]);
    assert.deepEqual(second.columns, ["OrderId", "Region", "Amount"]);
    const missed = lc.recordLineage("dbo.Orders", "docs", null);
    assert.equal(missed.sources.docs, "miss");
    assert.equal(missed.downstream.length, 2, "a miss never erases what another source found");
    assert.equal(lc.recordLineage("dbo.Orders", "snapshot", null, { status: "stale" }).sources.snapshot, "stale");
    assert.ok(existsSync(path));
    lc.clearContext();
    assert.equal(lc.getEntry("dbo.Orders"), null);
    assert.deepEqual(lc.readContext(), { entries: {} });
  });

  await t("pruneContexts drops the files of Pi processes that are gone, never this one's", () => {
    const dir = join(agent, "lineage-context");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "424242.json"), "{}");
    writeFileSync(join(dir, "424243.json"), "{}");
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ entries: {} }));
    lc.pruneContexts(process.env, (pid) => pid === 424243);
    assert.equal(existsSync(join(dir, "424242.json")), false);
    assert.equal(existsSync(join(dir, "424243.json")), true, "a live process keeps its file");
    assert.equal(existsSync(join(dir, `${process.pid}.json`)), true);
    lc.clearContext();
  });

  await t("the committed snapshot answers with the object's columns and every definition that names it", () => {
    const repo = join(tmp, "snap");
    contract(repo);
    assert.deepEqual(lc.snapshotLineage(repo, "dbo.Orders", NOW), { found: null, state: "absent" }, "no snapshot folder yet");
    snapshot(join(repo, ".coop", "catalog", "dev"));
    const hit = lc.snapshotLineage(join(repo, "sub"), "Orders", NOW + DAY);
    assert.equal(hit.state, "ok");
    assert.equal(hit.ageDays, 1);
    assert.deepEqual(hit.found.columns, ["OrderId", "Region", "Amount"]);
    assert.equal(hit.found.kind, "table");
    const names = hit.found.downstream.map((d) => d.name).sort();
    assert.deepEqual(names, ["dbo.usp_Refresh", "rpt.vw_SalesByRegion"]);
    const view = hit.found.downstream.find((d) => d.name === "rpt.vw_SalesByRegion");
    assert.deepEqual(view.columns, ["Region", "Amount"]);
    const proc = hit.found.downstream.find((d) => d.name === "dbo.usp_Refresh");
    assert.deepEqual(proc.columns, ["OrderId"], "a bare dbo name counts; only the columns the definition mentions");
    const miss = lc.snapshotLineage(repo, "dbo.NotThere", NOW);
    assert.equal(miss.found, null);
    assert.equal(miss.state, "ok", "the snapshot exists but lacks the object");
    const stale = lc.snapshotLineage(repo, "dbo.Orders", NOW + 9 * DAY);
    assert.equal(stale.state, "stale");
    assert.ok(stale.found, "a stale snapshot still answers; the state says a live lookup is owed");
    assert.deepEqual(lc.snapshotLineage(join(tmp, "nowhere"), "dbo.Orders", NOW), { found: null, state: "absent" });
  });

  await t("sql_impact and data_doc lineage results normalize to the same shape", () => {
    const live = lc.lineageFromSqlImpact({
      ok: true, state: "ok", object: { schema: "dbo", name: "Orders", type: "USER_TABLE" },
      downstream: { state: "ok", items: [{ schema: "rpt", name: "vw_SalesByRegion", type: "VIEW", columns: ["Region"] }, { schema: "dbo", name: "usp_Refresh", type: "SQL_STORED_PROCEDURE" }] },
      columns: { state: "ok", items: [{ name: "OrderId" }, { name: "Region" }] },
    });
    assert.deepEqual(live, { kind: "table", columns: ["OrderId", "Region"], downstream: [{ name: "rpt.vw_SalesByRegion", kind: "view", columns: ["Region"] }, { name: "dbo.usp_Refresh", kind: "procedure" }] });
    assert.equal(lc.lineageFromSqlImpact({ ok: false, state: "connection_failed" }), null);
    assert.equal(lc.lineageFromSqlImpact({ ok: true, object: { type: "SQL_TABLE_VALUED_FUNCTION", schema: "dbo", name: "f" }, downstream: { items: [] }, columns: { items: [] } }).kind, "function");
    const docs = lc.lineageFromDocs({
      object: { id: "sql:dbo.orders", name: "dbo.Orders", type: "table" },
      downstream: [{ id: "sql:rpt.vw_salesbyregion", name: "rpt.vw_SalesByRegion", type: "view" }],
      loaded_by: [{ table: { name: "Sales.Orders", type: "pbi_table" }, source: "dbo.Orders", linked: true }],
    });
    assert.deepEqual(docs, { kind: "table", columns: [], downstream: [{ name: "rpt.vw_SalesByRegion", kind: "view" }, { name: "Sales.Orders", kind: "power bi table", via: "loads it by name" }] });
    assert.equal(lc.lineageFromDocs({ ambiguous: true, matches: [] }), null);
    assert.equal(lc.lineageFromDocs({ object: null, undocumented_source: true, loaded_by: [] }), null);
    const byName = lc.lineageFromDocs({ object: null, undocumented_source: true, loaded_by: [{ table: { name: "Sales.vSales", type: "pbi_table" }, source: "dbo.vsales", linked: false }] });
    assert.deepEqual(byName.downstream, [{ name: "Sales.vSales", kind: "power bi table", via: "loads it by name" }], "an undocumented object a partition names still has a Power BI blast radius");
  });

  await t("the summary line names each downstream object and the follow-on edit; /impact lines carry the detail", () => {
    lc.clearContext();
    const entry = lc.recordLineage("dbo.Orders", "snapshot", { kind: "table", columns: ["OrderId", "Region", "Amount"], downstream: [{ name: "rpt.vw_SalesByRegion", kind: "view", columns: ["Region", "Amount"] }, { name: "Sales.Orders", kind: "power bi table", via: "loads it by name" }] });
    const line = lc.summaryLine(entry);
    assert.match(line, /^Downstream of dbo\.orders: rpt\.vw_SalesByRegion \(view, uses Region, Amount\); Sales\.Orders \(power bi table, loads it by name\)\. A renamed or removed column breaks each one that uses it; an added column reaches them only when each is updated\. \/impact shows the detail\.$/);
    const empty = lc.recordLineage("dbo.Lonely", "snapshot", null);
    assert.equal(lc.summaryLine(empty), "Downstream of dbo.lonely: none found (snapshot checked); an empty result is not proof of zero impact.");
    assert.equal(lc.summaryLine(null), "");
    const lines = lc.detailLines(entry);
    assert.equal(lines[0], "dbo.orders (table)");
    assert.equal(lines[1], "sources: snapshot hit, built docs absent, live catalog absent");
    assert.equal(lines[2], "columns: OrderId, Region, Amount");
    assert.deepEqual(lines.slice(3), ["- rpt.vw_SalesByRegion (view): uses Region, Amount", "- Sales.Orders (power bi table) (loads it by name)"]);
    lc.clearContext();
  });

  await t("entryCoversEdit: a hit anywhere, or every existing source tried; a live target never asked is not enough", () => {
    const e = (sources) => ({ object: "dbo.x", downstream: [], sources });
    assert.equal(lc.entryCoversEdit(null, { liveTarget: true }), false);
    assert.equal(lc.entryCoversEdit(e({ snapshot: "hit", docs: "absent", live: "absent" }), { liveTarget: true }), true);
    assert.equal(lc.entryCoversEdit(e({ snapshot: "miss", docs: "miss", live: "absent" }), { liveTarget: true }), false);
    assert.equal(lc.entryCoversEdit(e({ snapshot: "stale", docs: "absent", live: "absent" }), { liveTarget: true }), false, "a stale snapshot owes a live lookup");
    assert.equal(lc.entryCoversEdit(e({ snapshot: "stale", docs: "absent", live: "absent" }), { liveTarget: false }), true);
    assert.equal(lc.entryCoversEdit(e({ snapshot: "miss", docs: "absent", live: "miss" }), { liveTarget: true }), true, "asked and missed everywhere");
    assert.equal(lc.entryCoversEdit(e({ snapshot: "absent", docs: "absent", live: "absent" }), { liveTarget: false }), true);
  });

  await t("prepareEditContext fills from the snapshot once; the edit gate blocks only an owed live lookup", () => {
    lc.clearContext();
    const repo = join(tmp, "gate");
    contract(repo);
    snapshot(join(repo, ".coop", "catalog", "dev"));
    const file = join(repo, "sql", "dbo", "Orders.sql");
    mkdirSync(join(repo, "sql", "dbo"), { recursive: true });
    writeFileSync(file, "CREATE TABLE dbo.Orders ([OrderId] int)");
    const first = lc.prepareEditContext(repo, file, "", { now: NOW });
    assert.equal(first.object, "dbo.orders");
    assert.equal(first.entry.sources.snapshot, "hit");
    assert.equal(first.entry.downstream.length, 2);
    rmSync(join(repo, ".coop", "catalog"), { recursive: true, force: true });
    const again = lc.prepareEditContext(repo, file, "", { now: NOW });
    assert.equal(again.entry.sources.snapshot, "hit", "held for the session: no second scan");
    assert.deepEqual(lc.editGateDecision(repo, file, "", { liveTarget: true, now: NOW }), { action: "allow", object: "dbo.orders" });
    // An object no source holds, with a live target: the edit waits for sql_impact.
    const unknownView = join(repo, "sql", "rpt", "vw_New.sql");
    mkdirSync(join(repo, "sql", "rpt"), { recursive: true });
    writeFileSync(unknownView, "CREATE VIEW rpt.vw_New AS SELECT 1 AS One");
    const blocked = lc.editGateDecision(repo, unknownView, "", { liveTarget: true, now: NOW });
    assert.equal(blocked.action, "block");
    assert.equal(blocked.object, "rpt.vw_new");
    assert.match(blocked.reason, /does not yet hold the downstream of rpt\.vw_new \(snapshot none, built docs none, live catalog not asked\)\. Call sql_impact with object "rpt\.vw_new" first/);
    assert.deepEqual(lc.editGateDecision(repo, unknownView, "", { liveTarget: false, now: NOW }), { action: "allow", object: "rpt.vw_new" }, "no live target: nothing left to ask");
    lc.recordLineage("rpt.vw_New", "live", null);
    assert.equal(lc.editGateDecision(repo, unknownView, "", { liveTarget: true, now: NOW }).action, "allow", "asked and missed: the edit goes through");
    // A script that defines no object coop can name is not gated.
    const script = join(repo, "scripts", "backfill.sql");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    const scriptBody = "UPDATE dbo.Orders SET Amount = 0 WHERE Amount IS NULL;";
    writeFileSync(script, scriptBody);
    assert.equal(lc.editGateDecision(repo, script, scriptBody, { liveTarget: true, now: NOW }).action, "allow");
    // A write carries its content: the object comes from the new text.
    const written = join(repo, "sql", "dbo", "usp_New.sql");
    const blockedWrite = lc.editGateDecision(repo, written, "CREATE PROCEDURE dbo.usp_New AS SELECT 1", { liveTarget: true, now: NOW });
    assert.equal(blockedWrite.action, "block");
    assert.equal(blockedWrite.object, "dbo.usp_new");
    assert.equal(lc.editGateDecision(repo, join(repo, "README.md"), "", { liveTarget: true }).action, "allow");
    // A stale snapshot hit with a live target: the lookup is still owed, and the
    // snapshot's answer is kept so the summary already names what it found.
    lc.clearContext();
    snapshot(join(repo, ".coop", "catalog", "dev"), "2026-09-01T00:00:00Z");
    const stale = lc.editGateDecision(repo, file, "", { liveTarget: true, now: NOW });
    assert.equal(stale.action, "block");
    assert.match(stale.reason, /snapshot stale/);
    assert.equal(lc.getEntry("dbo.Orders").downstream.length, 2);
    assert.equal(lc.editGateDecision(repo, file, "", { liveTarget: false, now: NOW }).action, "allow");
    lc.clearContext();
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`lineage-context: ${n} test(s) passed`);
