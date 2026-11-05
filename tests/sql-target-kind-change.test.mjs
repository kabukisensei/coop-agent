// A SQL target whose kind changes between Azure SQL and Fabric (issue #514):
// the save clears the other engine's fields, keeps unrelated settings, and the
// written entry is ready in the real Python parser (lib/sql_targets.py). Covers
// dev, the answered test and prod entries and a named target set, both ways.
// All input is synthetic and in memory: no project file, no service.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = await import(pathToFileURL(join(ROOT, "lib", "project-contract.mjs")).href);
const { settingsFromForm } = await import(pathToFileURL(join(ROOT, "desktop", "lib", "project-form.mjs")).href);
const { applyProjectWizardSettings, parseProjectWizardSettings, projectSettingsProblems, writtenSqlTargetProblems, removeProjectYamlKey, sqlTargetEntryProblem } = lib;

const PY = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0);
assert.ok(PY, "python3 is needed for the SQL target parser");
const PARSE = `import sys, json
sys.path.insert(0, ${JSON.stringify(join(ROOT, "lib"))})
from _yaml import loads
from sql_targets import parse_sql_targets
r = parse_sql_targets(loads(sys.stdin.read()))
out = {k: {"state": v.state, "reason": v.reason} for k, v in r.targets.items()}
for name, entries in r.named.items():
    for env, v in entries.items():
        out[env + "@" + name] = {"state": v.state, "reason": v.reason}
print(json.dumps(out))`;
function parse(yml) {
  const p = spawnSync(PY, ["-I", "-c", PARSE], { input: yml, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}

let n = 0;
function test(name, fn) {
  try { fn(); n += 1; } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const W = "11111111-1111-1111-1111-111111111111";
const I = "22222222-2222-2222-2222-222222222222";
const E = "33333333-3333-3333-3333-333333333333";
const W2 = "44444444-4444-4444-4444-444444444444";
const I2 = "55555555-5555-5555-5555-555555555555";

const head = "profile:\n  client: Fixture\nrepositories: {}\n";
const azureFile = head + [
  "sql_targets:",
  "  default_environment: dev",
  "  dev:",
  "    kind: azure_sql",
  "    server: demo-dev.database.windows.net",
  "    database: Demo",
  "    read_scale_replicas: true",
  "    description: 'synthetic dev'",
  "  test:",
  "    kind: azure_sql",
  "    server: demo-test.database.windows.net",
  "    database: DemoTest",
  "  prod:",
  "    kind: azure_sql",
  "    server: demo-prod.database.windows.net  # the live one",
  "    database: DemoProd",
  "    read_scale_replicas: true",
  "  named:",
  "    second:",
  "      dev:",
  "        kind: azure_sql",
  "        server: second-dev.database.windows.net",
  "        database: Second",
  "",
].join("\n");
const fabricFile = head + [
  "sql_targets:",
  "  default_environment: dev",
  "  dev:",
  "    kind: fabric_lakehouse",
  `    workspace_id: '${W}'`,
  `    item_id: '${I}'`,
  `    sql_endpoint_id: '${E}'`,
  "    database: DemoLake",
  "    description: 'synthetic dev'",
  "  test:",
  "    kind: fabric_lakehouse",
  `    workspace_id: '${W2}'`,
  `    item_id: '${I2}'`,
  `    sql_endpoint_id: '${E}'`,
  "    database: DemoLakeTest",
  "  prod:",
  "    kind: fabric_lakehouse",
  `    workspace_id: '${W2}'`,
  `    item_id: '${I}'`,
  `    sql_endpoint_id: '${E}'`,
  "    database: DemoLakeProd",
  "  named:",
  "    second:",
  "      dev:",
  "        kind: fabric_warehouse",
  `        workspace_id: '${W}'`,
  `        item_id: '${I2}'`,
  "        database: SecondWh",
  "",
].join("\n");

function save(original, input) {
  const base = { ...parseProjectWizardSettings(original, "/synthetic/client"), repositories: [] };
  const settings = settingsFromForm(input, base, []);
  assert.deepEqual(projectSettingsProblems(settings), []);
  const text = applyProjectWizardSettings(original, settings);
  return { settings, text, after: parse(text) };
}

const READY = ["dev", "test", "prod", "dev@second"];

test("both fixtures start ready", () => {
  for (const file of [azureFile, fabricFile]) {
    const before = parse(file);
    for (const key of READY) assert.equal(before[key].state, "ready", `${key}: ${before[key].reason}`);
  }
});

test("Azure SQL -> Fabric Warehouse/Lakehouse: dev, test, prod and a named set", () => {
  for (const kind of ["fabric_warehouse", "fabric_lakehouse"]) {
    const ep = kind === "fabric_lakehouse" ? { sqlEndpointPropertiesId: E, sqlTargetTestEndpointId: E, sqlTargetProdEndpointId: E } : {};
    const { settings, text, after } = save(azureFile, {
      fabricEnabled: true, fabricWorkspaceId: W, sqlEndpointItemId: I, sqlEndpointItemType: kind === "fabric_lakehouse" ? "Lakehouse" : "Warehouse",
      ...ep,
      sqlTargetKind: kind, sqlTargetDatabase: "DemoFabric",
      sqlTargetTestDatabase: "DemoFabricTest", sqlTargetTestWorkspaceId: W2, sqlTargetTestItemId: I2,
      sqlTargetProdDatabase: "DemoFabricProd", sqlTargetProdWorkspaceId: W2, sqlTargetProdItemId: I,
      namedTargets: [{ name: "second", kind, dev: { database: "SecondFabric", workspaceId: W, itemId: I2, endpointId: kind === "fabric_lakehouse" ? E : "" } }],
    });
    for (const key of READY) assert.equal(after[key].state, "ready", `${kind} ${key}: ${after[key].reason}`);
    assert.doesNotMatch(text, /server:/, "no Azure server is left behind");
    assert.doesNotMatch(text, /read_scale_replicas/, "the Azure-only switch goes with the server");
    assert.match(text, /description: 'synthetic dev'/, "an unrelated field stays");
    assert.deepEqual(writtenSqlTargetProblems(text, settings), []);
  }
});

test("Fabric -> Azure SQL: dev, test, prod and a named set", () => {
  const { settings, text, after } = save(fabricFile, {
    fabricEnabled: false, sqlTargetKind: "azure_sql",
    sqlTargetServer: "Demo-Dev.database.windows.net", sqlTargetDatabase: "Demo",
    sqlTargetTestServer: "demo-test.database.windows.net", sqlTargetTestDatabase: "DemoTest",
    sqlTargetProdServer: "demo-prod.database.windows.net", sqlTargetProdDatabase: "DemoProd",
    namedTargets: [{ name: "second", kind: "azure_sql", dev: { database: "Second", server: "second-dev.database.windows.net" } }],
  });
  for (const key of READY) assert.equal(after[key].state, "ready", `${key}: ${after[key].reason}`);
  assert.doesNotMatch(text, /workspace_id|item_id|sql_endpoint_id/, "no Fabric id is left in an Azure SQL target");
  assert.match(text, /description: 'synthetic dev'/);
  assert.deepEqual(writtenSqlTargetProblems(text, settings), []);
});

test("Lakehouse -> Warehouse drops the endpoint id; same-kind saves keep everything", () => {
  const { text, after } = save(fabricFile, {
    fabricEnabled: true, fabricWorkspaceId: W, sqlEndpointItemId: I, sqlEndpointItemType: "Warehouse",
    sqlTargetKind: "fabric_warehouse", sqlTargetDatabase: "DemoWh",
  });
  assert.equal(after.dev.state, "ready", after.dev.reason);
  const dev = text.slice(text.indexOf("  dev:"), text.indexOf("  test:"));
  assert.doesNotMatch(dev, /sql_endpoint_id/);
  // test and prod were left unanswered: they stay exactly as written.
  assert.match(text, /database: DemoLakeTest/);
  assert.equal(after.test.state, "ready");

  const same = save(azureFile, { sqlTargetKind: "azure_sql", sqlTargetServer: "demo-dev.database.windows.net", sqlTargetDatabase: "Demo" });
  const targets = (t) => t.slice(t.indexOf("sql_targets:"), t.indexOf("\n\n", t.indexOf("sql_targets:")) >>> 0).trimEnd();
  assert.equal(targets(same.text), targets(azureFile), "a same-kind save with the same answers keeps every target line");
});

test("an environment left blank in the form keeps its own fields", () => {
  const { text } = save(azureFile, {
    fabricEnabled: true, fabricWorkspaceId: W, sqlEndpointItemId: I, sqlEndpointItemType: "Warehouse",
    sqlTargetKind: "fabric_warehouse", sqlTargetDatabase: "DemoFabric",
    sqlTargetTestDatabase: "", sqlTargetProdDatabase: "",
  });
  assert.match(text, /server: demo-prod\.database\.windows\.net {2}# the live one/, "prod (left blank in the form) is untouched");
});

test("the rendered-target check catches a mix the writer did not produce", () => {
  const bad = azureFile.replace("    kind: azure_sql\n    server: demo-dev", "    kind: fabric_warehouse\n    server: demo-dev");
  assert.equal(parse(bad).dev.state, "invalid");
  const problems = writtenSqlTargetProblems(bad, { sqlTargetKind: "fabric_warehouse" });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /takes no server/);
  assert.match(sqlTargetEntryProblem({ kind: "azure_sql", server: "x.database.windows.net", item_id: I }), /takes no Fabric ids/);
  assert.match(sqlTargetEntryProblem({ kind: "fabric_sql_database", server: "x.database.fabric.microsoft.com", read_scale_replicas: "true" }), /azure_sql only/);
  assert.equal(sqlTargetEntryProblem({ kind: "azure_sql", server: "x.database.windows.net", read_scale_replicas: "true" }), "");
});

test("removeProjectYamlKey removes one key and keeps the rest", () => {
  const text = "a:\n  b: 1\n  c:\n    d: 2\n  e: 3\n";
  assert.equal(removeProjectYamlKey(text, ["a", "c"]), "a:\n  b: 1\n  e: 3\n");
  assert.equal(removeProjectYamlKey(text, ["a", "x"]), text);
  assert.equal(removeProjectYamlKey(text, ["z", "b"]), text);
});

console.log(`  ${n} SQL target kind-change tests passed`);
