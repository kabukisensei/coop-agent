// Tests for the contract-driven Fabric target note: a simple read must be
// pointed straight at the contract's Warehouse ids at session start.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const { fabricTargetNote } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

const tmp = mkdtempSync(join(tmpdir(), "coop-fabric-target-"));
const WS = "af41fe4c-18c6-4940-b196-e8374cf88b35";
const WH = "f78a2da2-dc76-44bb-9d7d-5e4bee630992";
const EP = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

function contract(dir, yaml) {
  mkdirSync(join(dir, ".coop"), { recursive: true });
  writeFileSync(join(dir, ".coop", "project.yml"), yaml);
}

try {
  await t("warehouse contract yields a direct-read note with the contract ids", () => {
    const repo = join(tmp, "warehouse");
    contract(repo, [
      "fabric:",
      "  default_sql_endpoint:",
      `    item_id: ${WH}`,
      "    item_type: Warehouse",
      "    item_name: QE_WH",
      '  default_workspace_name: "Dev Data Warehouse"',
      `  default_workspace_id: "${WS}"`,
      "  environment_names:",
      '    dev: "Dev Data Warehouse"',
      '    prod: "Prod Data Warehouse"',
      "",
    ].join("\n"));
    const note = fabricTargetNote(repo);
    assert.ok(note);
    assert.equal(note.contractPath, join(repo, ".coop", "project.yml"));
    assert.match(note.content, /^Fabric target from the project contract \(\.coop\/project\.yml\)/);
    assert.ok(note.content.includes(`"Dev Data Warehouse" (${WS})`));
    assert.ok(note.content.includes("environment dev"));
    assert.ok(note.content.includes(`Warehouse "QE_WH" item ${WH}`));
    assert.ok(note.content.includes(`workspaceId ${WS} and itemId ${WH}`));
    assert.match(note.content, /fabric-sqlendpoint execute_query tool DIRECTLY/);
    assert.match(note.content, /Do not search team knowledge, memory, or the Fabric catalog/);
    assert.match(note.content, /approval prompt before Warehouse SQL still applies/);
    assert.ok(!note.content.includes("SQL endpoint "), "a Warehouse has no separate endpoint id");
  });

  await t("note is found from a nested folder and names the contract relative to cwd", () => {
    const repo = join(tmp, "warehouse");
    const nested = join(repo, "Semantic Model", "Finance.SemanticModel");
    mkdirSync(nested, { recursive: true });
    const note = fabricTargetNote(nested);
    assert.ok(note);
    assert.equal(note.contractPath, join(repo, ".coop", "project.yml"));
    assert.ok(note.content.includes("../../.coop/project.yml"));
  });

  await t("lakehouse contract points execute_query at the SQL endpoint id", () => {
    const repo = join(tmp, "lakehouse");
    contract(repo, [
      "fabric:",
      "  default_sql_endpoint:",
      `    item_id: ${WH}`,
      "    item_type: Lakehouse",
      "    item_name: QE_LH",
      "    sqlEndpointProperties:",
      `      id: ${EP}`,
      `  default_workspace_id: ${WS}`,
      "",
    ].join("\n"));
    const note = fabricTargetNote(repo);
    assert.ok(note);
    assert.ok(note.content.includes(`Lakehouse "QE_LH" item ${WH} (SQL endpoint ${EP})`));
    assert.ok(note.content.includes(`itemId ${EP}`));
    assert.ok(!note.content.includes("environment "), "no environment without a matching name");
  });

  await t("lakehouse contract without an endpoint id stays silent", () => {
    const repo = join(tmp, "lakehouse-no-endpoint");
    contract(repo, [
      "fabric:",
      "  default_sql_endpoint:",
      `    item_id: ${WH}`,
      "    item_type: Lakehouse",
      `  default_workspace_id: ${WS}`,
      "",
    ].join("\n"));
    assert.equal(fabricTargetNote(repo), null);
  });

  await t("placeholder or malformed ids stay silent", () => {
    const repo = join(tmp, "todo");
    contract(repo, [
      "fabric:",
      "  default_sql_endpoint:",
      "    item_id: TODO",
      "    item_type: Warehouse",
      `  default_workspace_id: ${WS}`,
      "",
    ].join("\n"));
    assert.equal(fabricTargetNote(repo), null);
    const repo2 = join(tmp, "unknown-type");
    contract(repo2, [
      "fabric:",
      "  default_sql_endpoint:",
      `    item_id: ${WH}`,
      "    item_type: KQLDatabase",
      `  default_workspace_id: ${WS}`,
      "",
    ].join("\n"));
    assert.equal(fabricTargetNote(repo2), null);
  });

  await t("no contract or no fabric section stays silent", () => {
    const bare = join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
    assert.equal(fabricTargetNote(bare), null);
    const repo = join(tmp, "no-fabric");
    contract(repo, "profile:\n  client: \"Example\"\n");
    assert.equal(fabricTargetNote(repo), null);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`fabric target note: ${n} passed`);
