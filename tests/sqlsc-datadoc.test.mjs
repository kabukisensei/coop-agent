// Tests for lineage docs over a coop-sql-source-control (sqlsc) repo: /setup-docs
// and the coop window's docs setup point coop-data-doc at the object scripts,
// check the object folders, and link the database's own dependency list
// (Dependencies.json) through coop-data-doc's config-set. lib/data-doc-setup.mjs only.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setup = await import(pathToFileURL(join(REPO_ROOT, "lib", "data-doc-setup.mjs")).href);

let n = 0;
const fixtures = [];
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};
const fixture = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
};

/** A repo sqlsc keeps: sqlsc.yml at the root, scripts under `folder`. */
function sqlscRepo(root, folder = "database") {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sqlsc.yml"), `folder: ${folder}      # object scripts live here\ntarget: dev\n`);
  for (const name of ["Tables", "Views", "Stored Procedures", "Data", "Migrations"]) {
    mkdirSync(join(root, folder, name), { recursive: true });
  }
  return join(root, folder);
}

await t("sqlscScriptsFolder reads sqlsc.yml's folder, and is empty for any other repo", () => {
  const root = fixture("coop-sqlsc-folder-");
  assert.equal(setup.sqlscScriptsFolder(root), "");
  const scripts = sqlscRepo(root, "db");
  assert.equal(setup.sqlscScriptsFolder(root), scripts);
});

await t("the contract's SQL repository prefills its sqlsc scripts folder, not the repo root", () => {
  const root = fixture("coop-sqlsc-contract-");
  mkdirSync(join(root, ".coop"));
  mkdirSync(join(root, "warehouse"));
  sqlscRepo(join(root, "warehouse"));
  writeFileSync(join(root, ".coop", "project.yml"), `profile:
  client: 'Contoso'
repositories:
  warehouse:
    role: 'sql'
    local_path: './warehouse'
`);
  assert.equal(setup.dataDocPrefillFromProject(root).sqlPath, "warehouse/database");
});

await t("setup run inside an sqlsc repo with no contract prefills its scripts folder", () => {
  const root = fixture("coop-sqlsc-bare-");
  sqlscRepo(root);
  const prefill = setup.setupDocsPrefill(root, {});
  assert.equal(prefill.sqlPath, "database");
  assert.equal(prefill.sourceMode, "sql");
});

await t("the SQL folders prompt checks the object folders on a first run and keeps a re-run's choice", () => {
  const choices = ["Data", "Functions", "Migrations", "Security", "Stored Procedures", "Tables", "Triggers", "Views"]
    .map((name) => ({ label: name, value: name, checked: false }));
  const prompt = { type: "prompt", id: "SQL_folders", kind: "checkbox", message: "SQL — pick the folders", choices };
  const checked = setup.prefilledPrompt(prompt).choices.filter((c) => c.checked).map((c) => c.value);
  assert.deepEqual(checked, ["Functions", "Stored Procedures", "Tables", "Triggers", "Views"]);
  const rerun = { ...prompt, choices: choices.map((c) => ({ ...c, checked: c.value === "Views" })) };
  assert.deepEqual(setup.prefilledPrompt(rerun).choices.filter((c) => c.checked).map((c) => c.value), ["Views"]);
  // any other repo's folders are left alone
  const other = { ...prompt, choices: [{ label: "procs", value: "procs" }, { label: "views", value: "views" }] };
  assert.equal(setup.prefilledPrompt(other).choices.some((c) => c.checked), false);
});

/** A fake execFile: records the call and the JSON patch written to stdin. */
function fakeExec(fail = false) {
  const calls = [];
  const impl = (file, args, _opts, callback) => {
    const call = { file, args, stdin: "" };
    calls.push(call);
    const child = { stdin: { end: (text) => { call.stdin = text; setImmediate(() => callback(fail ? new Error("exit 2") : null)); } } };
    return child;
  };
  return { calls, impl };
}

await t("a Dependencies.json beside the scripts is linked through coop-data-doc config-set", async () => {
  const root = fixture("coop-sqlsc-link-");
  const scripts = sqlscRepo(join(root, "warehouse"));
  const configPath = join(root, "coop-data-doc.yml");
  writeFileSync(configPath, 'project_name: "Contoso"\nrepos:\n  sql:\n    path: "warehouse/database"\n    include: ["Tables/**/*.sql"]\n');
  const none = fakeExec();
  assert.equal(await setup.linkCatalogDependencies({ executable: "coop-data-doc", configPath, execFileImpl: none.impl }), "");
  assert.equal(none.calls.length, 0, "no Dependencies.json: nothing to link");

  writeFileSync(join(scripts, "Dependencies.json"), '{"version": 1, "dependencies": []}\n');
  const exec = fakeExec();
  const message = await setup.linkCatalogDependencies({ executable: "coop-data-doc", configPath, execFileImpl: exec.impl });
  assert.match(message, /dependency list \(warehouse\/database\/Dependencies\.json\)/);
  assert.deepEqual(exec.calls[0].args, ["config-set", "--config", configPath, "--from-json", "-"]);
  assert.deepEqual(JSON.parse(exec.calls[0].stdin), { catalog_dependencies: ["warehouse/database/Dependencies.json"] });

  const old = fakeExec(true);
  assert.match(await setup.linkCatalogDependencies({ executable: "coop-data-doc", configPath, execFileImpl: old.impl }), /older than coop's pin.*coop update.*setup-docs/);

  writeFileSync(configPath, `${'project_name: "Contoso"\nrepos:\n  sql:\n    path: "warehouse/database"\n'}catalog_dependencies:\n  - "x"\n`);
  const again = fakeExec();
  assert.equal(await setup.linkCatalogDependencies({ executable: "coop-data-doc", configPath, execFileImpl: again.impl }), "");
  assert.equal(again.calls.length, 0, "already listed: left to the person");
});

for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
console.log(`✓ sqlsc lineage setup tests passed (${n})`);
