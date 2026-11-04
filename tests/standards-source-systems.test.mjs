import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildStandardsContext, DEFAULT_SOURCE_SYSTEMS, projectSourceSystems, refreshCanonical, sourceArticleFits } from "../lib/standards.mjs";

// Source-system articles (the wiki's `domain: source`, Source Systems/): every
// Cooptimize client's source is Dynamics 365, so the D365 articles ride on every SQL,
// DAX and model task whatever the prompt says, chosen by the project file's
// `source_systems` (both D365 systems when the key is absent, none for `[]`).
// The wiki is a local git repo refreshed once into temp storage, like the golden suite.

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "coop-std-source-")));
const wiki = join(tmp, "wiki");
const registryPath = join(tmp, "registry.json");
const projectFile = (name, body) => {
  const path = join(tmp, name, ".coop", "project.yml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const options = (more = {}) => ({
  canonicalRoot: join(tmp, "cache", "canonical"), statePath: join(tmp, "cache", "status.json"), snapshotRoot: join(tmp, "snapshots"),
  registryPath, fixtureRegistry: true, remote: wiki, cwd: tmp, now: () => 1_000_000, refresh: false, bundleRoot: false,
  ...more,
});
const article = (path, fields) => {
  const front = ["id", "title", "domain", "layer", "artifact", "technology"].map((key) => `${key}: ${fields[key]}`).join("\n");
  mkdirSync(dirname(join(wiki, path)), { recursive: true });
  writeFileSync(join(wiki, path), `---\n${front}\nstatus: active\n---\n# ${fields.title}\nStub body for ${fields.id}.\n`);
};
const git = (args) => execFileSync("git", ["-C", wiki, ...args], { encoding: "utf8" }).trim();

const FO = "D365 Finance and Operations Source Tables";
const DATAVERSE = "D365 Dataverse Source Tables";
const EXPORTS = "D365 Exports";

try {
  article("SQL/SQL Conventions.md", { id: "sql_conventions", title: "SQL Conventions", domain: "sql", layer: "agnostic", artifact: "conventions", technology: "agnostic" });
  article("SQL/Gold/Dimension Tables.md", { id: "sql_gold_dimension_tables", title: "Gold Dimension Tables", domain: "sql", layer: "gold", artifact: "dimension_table", technology: "agnostic" });
  article("Power BI/Semantic Model/DAX.md", { id: "powerbi_semantic_model_dax", title: "Power BI DAX", domain: "powerbi", layer: "semantic_model", artifact: "dax_expression", technology: "power_bi" });
  article("Source Systems/D365 FO Source Tables.md", { id: "source_d365_fo", title: FO, domain: "source", layer: "agnostic", artifact: "source_table", technology: "d365_fo" });
  article("Source Systems/D365 Dataverse Source Tables.md", { id: "source_d365_dataverse", title: DATAVERSE, domain: "source", layer: "agnostic", artifact: "source_table", technology: "d365_dataverse" });
  article("Source Systems/D365 Exports.md", { id: "source_d365_exports", title: EXPORTS, domain: "source", layer: "agnostic", artifact: "export", technology: "d365" });
  execFileSync("git", ["init", "-q", "-b", "main", wiki]);
  git(["config", "user.email", "standards@test.invalid"]); git(["config", "user.name", "Standards Test"]);
  git(["add", "."]); git(["commit", "-q", "-m", "source-system fixture"]);
  writeFileSync(registryPath, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: wiki, authoritative_branch: "main", freshness_seconds: 900, timeout_seconds: 60 } }));
  const refreshed = refreshCanonical(options({ force: true, refresh: undefined }));
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));

  const standardsFor = (prompt, file) => {
    const context = buildStandardsContext(prompt, options({ projectFile: file }));
    const source = context.records.find((r) => r.resolution.domain === "source");
    return { domains: [...context.domains], source: source ? source.sections.filter((s) => s.file).map((s) => s.heading).sort() : null };
  };

  // No source_systems key: both D365 systems, so all three articles, on a prompt that
  // never names D365.
  const plain = projectFile("plain", "profile:\n  client: 'Example'\n");
  let got = standardsFor("Build a gold customer dimension table", plain);
  assert.deepEqual(got.domains, ["sql", "source"]);
  assert.deepEqual(got.source, [DATAVERSE, EXPORTS, FO].sort());

  // DAX and model tasks get them too.
  got = standardsFor("Write a DAX measure for open opportunities in the semantic model", plain);
  assert.ok(got.domains.includes("dax") && got.domains.includes("source"), JSON.stringify(got));
  assert.deepEqual(got.source, [DATAVERSE, EXPORTS, FO].sort());

  // F&O only: the F&O article and the shared exports article, not Dataverse.
  const fo = projectFile("fo", "source_systems:\n  - d365_fo\n");
  got = standardsFor("Fix the sales line SQL view", fo);
  assert.deepEqual(got.source, [EXPORTS, FO].sort());

  // Dataverse only, flow style.
  const dv = projectFile("dv", "source_systems: [d365_dataverse]\n");
  got = standardsFor("Review the opportunity stored procedure", dv);
  assert.deepEqual(got.source, [DATAVERSE, EXPORTS].sort());

  // Opted out: no source domain at all.
  const none = projectFile("none", "source_systems: []\n");
  got = standardsFor("Build a gold customer dimension table", none);
  assert.deepEqual(got.domains, ["sql"]);
  assert.equal(got.source, null);

  // A system with no fitting article adds nothing (never an empty domain).
  const other = projectFile("other", "source_systems: [netsuite]\n");
  got = standardsFor("Build a gold customer dimension table", other);
  assert.deepEqual(got.domains, ["sql"]);

  // Non-coding prompts get no standards, source included.
  got = standardsFor("Plan the team offsite agenda", plain);
  assert.deepEqual(got.domains, []);

  // Parsing.
  assert.deepEqual(projectSourceSystems(""), [...DEFAULT_SOURCE_SYSTEMS]);
  assert.deepEqual(projectSourceSystems("source_systems: d365_fo, D365_Dataverse\n"), ["d365_fo", "d365_dataverse"]);
  assert.deepEqual(projectSourceSystems("source_systems: none\n"), []);
  assert.deepEqual(projectSourceSystems("source_systems: []\n"), []);
  assert.deepEqual(projectSourceSystems("source_systems:\n  - d365_fo\n  - 'bad value!'\n"), ["d365_fo"]);
  assert.equal(sourceArticleFits({ technology: "d365" }, ["d365_dataverse"]), true);
  assert.equal(sourceArticleFits({ technology: "d365_fo" }, ["d365_dataverse"]), false);
  assert.equal(sourceArticleFits({ technology: "d36" }, ["d365_fo"]), false);

  console.log("✓ standards source systems: D365 articles ride on SQL, DAX and model tasks per source_systems");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
