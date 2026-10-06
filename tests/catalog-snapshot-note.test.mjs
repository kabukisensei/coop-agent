// Tests for the committed catalog snapshot (SQ9) as coop-tools sees it: the
// folder rule, the status read from manifest.json, the session-start note and
// the catalog_snapshot tool's status command (no Python, no connection).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const { default: coopTools, catalogSnapshotFolder, catalogSnapshotNote, catalogSnapshotStatus } =
  await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

const tmp = mkdtempSync(join(tmpdir(), "coop-catalog-note-"));
const NOW = Date.parse("2026-10-05T22:00:00Z");
const DAY = 86_400_000;

function contract(dir, extra = "") {
  mkdirSync(join(dir, ".coop"), { recursive: true });
  const text = ["profile:", "  client: Contoso", "sql_targets:", "  default_environment: dev", "  dev:", "    kind: azure_sql", "    server: contoso-dev.database.windows.net", "    database: ContosoDW", extra].join("\n") + "\n";
  writeFileSync(join(dir, ".coop", "project.yml"), text);
  return text;
}
function manifest(folder, takenAt = "2026-10-05T22:00:00Z") {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({
    coop_catalog_snapshot: true, schema_version: 1, taken_at: takenAt,
    target: { environment: "dev", kind: "azure_sql", database: "ContosoDW" },
    objects: { tables: 12, views: 3, procedures: 2, functions: 0 }, files: [],
  }));
}

try {
  await t("folder rule: catalog.path, else the data_docs repository, else .coop/catalog/<env>", () => {
    const a = join(tmp, "a");
    const textA = contract(a);
    assert.equal(catalogSnapshotFolder(join(a, ".coop", "project.yml"), textA).folder, join(a, ".coop", "catalog", "dev"));
    const b = join(tmp, "b");
    const textB = contract(b, "catalog:\n  path: catalog/warehouse\n  max_age_days: 3");
    const rb = catalogSnapshotFolder(join(b, ".coop", "project.yml"), textB);
    assert.equal(rb.folder, join(b, "catalog", "warehouse"));
    assert.equal(rb.maxAgeDays, 3);
    const c = join(tmp, "c");
    const textC = contract(c, "repositories:\n  docs:\n    role: data_docs\n    local_path: ../contoso-data-docs");
    assert.equal(catalogSnapshotFolder(join(c, ".coop", "project.yml"), textC).folder, join(tmp, "contoso-data-docs", "catalog", "dev"));
    const d = join(tmp, "d");
    const textD = contract(d).replace("default_environment: dev", "default_environment: test");
    writeFileSync(join(d, ".coop", "project.yml"), textD);
    assert.equal(catalogSnapshotFolder(join(d, ".coop", "project.yml"), textD).environment, "test");
  });

  await t("status: missing, fresh, stale; null outside a contract", () => {
    const repo = join(tmp, "status");
    contract(repo);
    const missing = catalogSnapshotStatus(repo, NOW);
    assert.deepEqual(missing, { state: "missing", path: ".coop/catalog/dev", environment: "dev", maxAgeDays: 7, sqlTarget: true });
    manifest(join(repo, ".coop", "catalog", "dev"));
    const fresh = catalogSnapshotStatus(join(repo, "sub"), NOW + 2 * DAY);
    assert.equal(fresh.state, "ok");
    assert.equal(fresh.ageDays, 2);
    assert.deepEqual(fresh.objects, { tables: 12, views: 3, procedures: 2, functions: 0 });
    const stale = catalogSnapshotStatus(repo, NOW + 8 * DAY);
    assert.equal(stale.state, "stale");
    assert.equal(catalogSnapshotStatus(join(tmp, "nowhere-" + n), NOW), null);
  });

  await t("the session-start note says what to read, what to refresh, or what to offer", () => {
    const repo = join(tmp, "note");
    contract(repo);
    assert.match(catalogSnapshotNote(repo, NOW), /No committed catalog snapshot exists yet .*\.coop\/catalog\/dev.*offer the catalog_snapshot tool/);
    manifest(join(repo, ".coop", "catalog", "dev"));
    const ok = catalogSnapshotNote(repo, NOW + DAY);
    assert.match(ok, /committed catalog snapshot of the dev target is under \.coop\/catalog\/dev \(12 tables, 3 views, 2 procedures, 0 functions; taken 2026-10-05T22:00:00Z, 1 day\(s\) old\)/);
    assert.match(ok, /BEFORE writing or changing SQL/);
    assert.match(ok, /never a file to edit or deploy/);
    assert.match(catalogSnapshotNote(repo, NOW + 9 * DAY), /is 9 day\(s\) old \(the contract allows 7\).*offer to refresh/);
    assert.equal(catalogSnapshotNote(join(tmp, "nowhere-" + n), NOW), null);
    const noSql = join(tmp, "nosql");
    mkdirSync(join(noSql, ".coop"), { recursive: true });
    writeFileSync(join(noSql, ".coop", "project.yml"), "profile:\n  client: Contoso\nrepositories:\n  source:\n    local_path: .\n");
    assert.equal(catalogSnapshotNote(noSql, NOW), null, "no SQL target: nothing to offer");
    manifest(join(noSql, ".coop", "catalog", "dev"));
    assert.match(catalogSnapshotNote(noSql, NOW), /committed catalog snapshot of the dev target/, "an existing snapshot is still announced");
  });

  await t("catalog_snapshot tool: status reads the folder without Python; the session note is injected once", async () => {
    const tools = new Map();
    const handlers = {};
    coopTools({
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand() {},
      on: (name, fn) => { handlers[name] = fn; },
      sendMessage() {},
      appendEntry() {},
    });
    const tool = tools.get("catalog_snapshot");
    assert.ok(tool, "catalog_snapshot is registered");
    const repo = join(tmp, "tool");
    contract(repo);
    manifest(join(repo, ".coop", "catalog", "dev"), new Date(Date.now() - DAY).toISOString());
    const ctx = { cwd: repo, ui: { setStatus() {}, notify() {} }, hasUI: false };
    const result = await tool.execute("1", { command: "status" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /catalog_snapshot status: ok \(\.coop\/catalog\/dev, dev, taken .*1 day\(s\) old, max 7; 12 tables, 3 views, 2 procedures, 0 functions\)/);
    assert.equal(result.details.state, "ok");
    const none = await tool.execute("2", {}, undefined, undefined, { ...ctx, cwd: join(tmp, "nowhere-" + n) });
    assert.match(none.content[0].text, /no \.coop\/project\.yml/);
    const start = handlers["before_agent_start"];
    assert.ok(start, "before_agent_start is registered");
    const first = await start({ prompt: "hello" }, ctx);
    const content = first?.message?.content || "";
    assert.match(content, /committed catalog snapshot of the dev target/);
    const second = await start({ prompt: "again" }, ctx);
    assert.equal(/committed catalog snapshot/.test(second?.message?.content || ""), false, "announced once per folder");
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`catalog-snapshot-note: ${n} test(s) passed`);
