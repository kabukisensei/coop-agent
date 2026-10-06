// Tests for the in-Coop /setup-project wizard's contract rendering and safe merge.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  default: coopTools,
  applyProjectWizardSettings,
  parseProjectWizardSettings,
  projectYamlScalar,
  renderProjectWizardSettings,
  runProjectWizard,
  contractCreatedNote,
  contractLocationNote,
  findSiblingContract,
  proposeContractRoot,
  siblingRepositoryEntries,
  estateMode,
  dataDocPrefillFromProject,
  proposedSqlTargetKind,
  sqlTargetsBlock,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const { findProjectContract } = await import(pathToFileURL(join(REPO_ROOT, "lib", "standards.mjs")).href);
// The contract module itself, for the C2 mapping helpers the bundle does not re-export.
const lib = await import(pathToFileURL(join(REPO_ROOT, "lib", "project-contract.mjs")).href);

let n = 0;
const skips = [];
const t = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    if (e && e.__skip === true) {
      skips.push(`${name} — ${e.detail}`);
      console.log(`  ↷ SKIP ${name} — ${e.detail}`);
      return;
    }
    cleanupFixtures();
    throw e;
  }
  n++;
  console.log(`  ✓ ${name}`);
};

// --- Hermetic, test-owned fixture trees (r8-test-hygiene) -------------------
// The wizard resolves a fixture's project root by walking UP the filesystem
// (findProjectYml / findGitRoot in extensions/coop-tools). That production
// behavior is intentional and preserved. Wizard tests therefore SKIP — loudly,
// naming the foreign marker — when a foreign `.git` or `.coop/project.yml`
// exists between the fixture and the tmp root. Sandbox session scaffolding
// seeds exactly such markers into TMPDIR; see tests/repro-tmp-contamination.sh
// for a deterministic reproducer. Fixtures are tracked and removed afterward:
// this file never deletes anything it did not create.
const fixtureRoots = [];
const trackFixture = (dir) => { fixtureRoots.push(dir); return dir; };
const cleanupFixtures = () => {
  while (fixtureRoots.length) {
    const d = fixtureRoots.pop();
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};
process.on("uncaughtException", (e) => {
  cleanupFixtures();
  console.error(e);
  process.exit(1);
});

const foreignMarkerAbove = (dir) => {
  // Mirror production's unbounded upward walk (findProjectYml/findGitRoot walk
  // to the filesystem root), so the skip fires whenever production discovery
  // could actually misresolve — scaffolding may sit ABOVE os.tmpdir().
  let cur = resolve(dir, "..");
  for (;;) {
    if (existsSync(join(cur, ".git"))) return join(cur, ".git");
    if (existsSync(join(cur, ".coop", "project.yml"))) return join(cur, ".coop", "project.yml");
    const parent = resolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
};

// A fixture repository alone in its own tracked parent: the C1 root proposal looks
// at the repository's parent for sibling repositories, and os.tmpdir() holds other
// fixtures' .git markers while this file runs.
const isolatedRoot = (prefix) => {
  const root = join(trackFixture(mkdtempSync(join(tmpdir(), prefix))), "work");
  mkdirSync(root);
  return root;
};

const skipIfContaminated = (root) => {
  const foreign = foreignMarkerAbove(root);
  if (foreign) {
    throw { __skip: true, detail: `foreign marker above fixture: ${foreign}` };
  }
};

const settings = {
  organization: "Cooptimize",
  client: "Contoso",
  timezone: "America/Chicago",
  defaultBranch: "main",
  repositories: [{
    name: "analytics",
    description: "Warehouse and Power BI",
    role: "sql",
    localPath: ".",
    remoteName: "origin",
    defaultBranch: "main",
  }],
  fabricEnabled: true,
  tenantId: "tenant-123",
  fabricWorkspaceName: "Contoso Dev",
  fabricWorkspaceId: "11111111-1111-1111-1111-111111111111",
  sqlEndpointItemType: "Warehouse",
  sqlEndpointItemName: "Contoso Warehouse",
  sqlEndpointItemId: "22222222-2222-2222-2222-222222222222",
  sqlEndpointPropertiesId: "33333333-3333-3333-3333-333333333333",
  powerBiWorkspaceName: "Contoso Dev",
  powerBiWorkspaceId: "pbi-123",
  tabularEditorEnabled: false,
  tabularEditorPath: "te",
  bpaRulesPath: "",
  sqlTargetKind: "fabric_warehouse",
  sqlTargetServer: "",
  sqlTargetDatabase: "Contoso Warehouse",
  fabricLayout: "warehouse",
  tableMappingRule: "same_name",
  tableMappingSchema: "dbo",
  tableMappingPrefix: "",
};

await t("new-project renderer produces a parseable, governed contract", () => {
  const text = renderProjectWizardSettings(settings);
  assert.equal(projectYamlScalar(text, ["profile", "client"]), "Contoso");
  assert.equal(projectYamlScalar(text, ["repositories", "analytics", "local_path"]), ".");
  assert.equal(projectYamlScalar(text, ["tools", "fabric_cli", "enabled"]), "true");
  assert.equal(projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_type"]), "Warehouse");
  assert.equal(projectYamlScalar(text, ["fabric", "default_sql_endpoint", "item_id"]), "22222222-2222-2222-2222-222222222222");
  assert.equal(projectYamlScalar(text, ["fabric", "default_sql_endpoint", "sqlEndpointProperties", "id"]), "33333333-3333-3333-3333-333333333333");
  assert.equal(projectYamlScalar(text, ["mcp", "fabric_sqlendpoint", "enabled"]), "true");
  assert.equal(projectYamlScalar(text, ["fabric_skills", "policy"]), "baseline");
  assert.doesNotMatch(text, /fabric_skills:\n(?:.*\n){0,4}\s+allow:\s*\[\]/);
  assert.doesNotMatch(text, /(?:microsoft_skills|fabric_skills):\n(?:.*\n){0,4}\s+(?:source|load_dir):/);
  assert.equal(projectYamlScalar(text, ["logging", "require_task_log"]), "true");
  assert.doesNotMatch(text, /^standards:/m, "new projects must use canonical standards by default");
  assert.match(text, /^# standards:\n#   sql:\n#     path: /m, "the in-app wizard documents the nested override shape");
  assert.equal(projectYamlScalar(text, ["estate", "mode"]), "partial");
  // #98: the guardrails hard-code these rules; contracts no longer carry policy nothing reads.
  assert.doesNotMatch(text, /live_discovery|allowed_default_actions|requires_approval_actions/);
  assert.equal((text.match(/^  environment_names:$/gm) || []).length, 2);
  assert.match(text, /# Warehouse \/ Lakehouse workspace for each deployment environment\./);
  assert.match(text, /# Semantic-model workspace for each deployment environment\./);
  assert.match(text, /- 'update markdown docs, html site, logs'/);
  assert.match(text, /agent_never_commit:/);
  assert.match(text, /never_without_explicit_instruction:/);
  // #93: powerbi-mcp-server is retired; contracts declare no `powerbi` MCP policy.
  assert.doesNotMatch(text, /^  powerbi:|readonly_flag/m);
  const parsed = parseProjectWizardSettings(text, "/work/analytics");
  assert.equal(parsed.repositories[0].role, "sql");
  assert.equal(parsed.tenantId, "tenant-123");
  assert.equal(parsed.sqlEndpointItemName, "Contoso Warehouse");
  assert.equal(parsed.sqlEndpointPropertiesId, "33333333-3333-3333-3333-333333333333");
  // SQ1: a Fabric Warehouse dev target carries the Fabric ids, never a server.
  assert.equal(projectYamlScalar(text, ["sql_targets", "default_environment"]), "dev");
  assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "kind"]), "fabric_warehouse");
  assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "workspace_id"]), "11111111-1111-1111-1111-111111111111");
  assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "item_id"]), "22222222-2222-2222-2222-222222222222");
  assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "database"]), "Contoso Warehouse");
  assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "server"]), "");
  assert.equal(projectYamlScalar(text, ["sql_targets", "prod", "kind"]), "fabric_warehouse");
  assert.equal(parsed.sqlTargetKind, "fabric_warehouse");
  assert.equal(parsed.sqlTargetDatabase, "Contoso Warehouse");
  // The Python module is the authority for the contract; the renderer must only
  // emit what lib/sql_targets.py reads back as a ready default.
  const probe = trackFixture(mkdtempSync(join(tmpdir(), "coop-sql-targets-")));
  mkdirSync(join(probe, ".coop"));
  writeFileSync(join(probe, ".coop", "project.yml"), text);
  const shown = spawnSync("python3", [join(REPO_ROOT, "lib", "sql_targets.py"), "--project", join(probe, ".coop", "project.yml"), "show"], { encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  const targets = JSON.parse(shown.stdout);
  assert.deepEqual(targets.errors, []);
  assert.equal(targets.targets.dev.state, "ready");
  assert.equal(targets.targets.prod.state, "unconfigured");
});

await t("sql_targets: the dev kind follows the machine platform and an Azure SQL entry names a server", () => {
  assert.equal(proposedSqlTargetKind("azure_sql", true), "azure_sql");
  assert.equal(proposedSqlTargetKind("azure_sql", false), "azure_sql");
  assert.equal(proposedSqlTargetKind("both", true), "fabric_warehouse");
  assert.equal(proposedSqlTargetKind("both", false), "azure_sql");
  assert.equal(proposedSqlTargetKind("fabric", false), "");
  assert.equal(proposedSqlTargetKind("", true), "fabric_warehouse");
  assert.deepEqual(sqlTargetsBlock({ ...settings, sqlTargetKind: "" }), []);
  const azure = renderProjectWizardSettings({ ...settings, fabricEnabled: false, sqlTargetKind: "azure_sql", sqlTargetServer: "contoso-dev.database.windows.net", sqlTargetDatabase: "ContosoDW" });
  assert.equal(projectYamlScalar(azure, ["sql_targets", "dev", "kind"]), "azure_sql");
  assert.equal(projectYamlScalar(azure, ["sql_targets", "dev", "server"]), "contoso-dev.database.windows.net");
  assert.equal(projectYamlScalar(azure, ["sql_targets", "dev", "workspace_id"]), "");
  assert.doesNotMatch(azure, /^fabric:/m);
  assert.equal(projectYamlScalar(azure, ["fabric_skills", "policy"]), "disabled");
  const lakehouse = renderProjectWizardSettings({ ...settings, sqlTargetKind: "fabric_lakehouse" });
  assert.equal(projectYamlScalar(lakehouse, ["sql_targets", "dev", "sql_endpoint_id"]), "33333333-3333-3333-3333-333333333333");
  // Editing an existing contract adds only the dev entry and keeps a chosen default.
  const existing = "profile:\n  client: 'Contoso'\nsql_targets:\n  default_environment: test\n  test:\n    kind: azure_sql\n    server: 't.database.windows.net'\n    database: 'T'\n";
  const parsed = parseProjectWizardSettings(existing, "/work");
  assert.equal(parsed.sqlTargetKind, "");
  const merged = applyProjectWizardSettings(existing, { ...parsed, repositories: [], sqlTargetKind: "azure_sql", sqlTargetServer: "d.database.windows.net", sqlTargetDatabase: "D" });
  assert.equal(projectYamlScalar(merged, ["sql_targets", "default_environment"]), "test");
  assert.equal(projectYamlScalar(merged, ["sql_targets", "test", "server"]), "t.database.windows.net");
  assert.equal(projectYamlScalar(merged, ["sql_targets", "dev", "server"]), "d.database.windows.net");
  assert.equal(projectYamlScalar(merged, ["sql_targets", "dev", "kind"]), "azure_sql");
  const untouched = applyProjectWizardSettings(existing, { ...parsed, repositories: [] });
  assert.equal(projectYamlScalar(untouched, ["sql_targets", "dev", "kind"]), "", "no kind chosen: sql_targets is left alone");
});

await t("native wizard proposes the Azure SQL dev target on an Azure SQL machine", async () => {
  const root = isolatedRoot("coop-project-azure-");
  mkdirSync(join(root, ".git"));
  skipIfContaminated(root);
  const coopDir = trackFixture(mkdtempSync(join(tmpdir(), "coop-azure-home-")));
  mkdirSync(join(coopDir, ".coop"));
  writeFileSync(join(coopDir, ".coop", "config"), JSON.stringify({ schema_version: 1, client: { platform: "azure_sql" } }));
  const savedCoopDir = process.env.COOP_DIR;
  process.env.COOP_DIR = coopDir;
  try {
    const confirms = [true, false, false, false, true]; // local source, add repo, Fabric, TE, write
    const labels = [];
    const ctx = {
      cwd: root,
      hasUI: true,
      mode: "tui",
      ui: {
        input: async (label, def) => {
          labels.push(label);
          if (label.startsWith("Dev SQL server host")) return "Contoso-Dev.database.windows.net";
          if (label.startsWith("Dev database name")) return "ContosoDW";
          return def;
        },
        confirm: async (_title, message) => {
          if (_title === "Microsoft Fabric / Power BI") assert.match(message, /Azure SQL client/);
          return confirms.shift() ?? false;
        },
        select: async (_label, options) => options.find((x) => x.includes("General project")) ?? options.find((x) => x.startsWith("✓ Use this folder:")),
        notify: () => {},
      },
    };
    assert.equal(await runProjectWizard({}, ctx), true);
    const text = readFileSync(join(root, ".coop", "project.yml"), "utf8");
    assert.ok(labels.some((l) => l.startsWith("Dev SQL target kind")), "the wizard asks for the dev SQL target kind");
    assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "kind"]), "azure_sql");
    assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "server"]), "contoso-dev.database.windows.net");
    assert.equal(projectYamlScalar(text, ["sql_targets", "dev", "database"]), "ContosoDW");
    assert.equal(projectYamlScalar(text, ["sql_targets", "default_environment"]), "dev");
    assert.doesNotMatch(text, /^fabric:/m);
  } finally {
    if (savedCoopDir === undefined) delete process.env.COOP_DIR; else process.env.COOP_DIR = savedCoopDir;
  }
});

await t("estate modes preserve discovery, partial, mixed, and connected options", () => {
  const sql = { ...settings.repositories[0], role: "sql" };
  const powerbi = { ...settings.repositories[0], name: "reports", role: "powerbi" };
  const mixed = { ...settings.repositories[0], role: "mixed" };
  assert.equal(estateMode([]), "discovery");
  assert.equal(estateMode([sql]), "partial");
  assert.equal(estateMode([powerbi]), "partial");
  assert.equal(estateMode([mixed]), "connected");
  assert.equal(estateMode([sql, powerbi]), "connected");
});

await t("existing-project merge preserves comments, custom keys, and commit policy", () => {
  const original = `# keep this client comment
profile:
  organization: 'Old Org'
  client: 'Old Client'
  custom_profile_key: 'keep-me'
repositories:
  analytics:
    description: 'Old description'
    role: 'generic'
    local_path: '.'
    remote_name: 'upstream'
    default_branch: 'master'
    custom_repo_key: 'keep-this-too'
    agent_allowed_to_commit:
      - 'special-docs/**'
custom_section:
  future_setting: 42
tools:
  tabular_editor_cli:
    enabled: false
`;
  const parsed = parseProjectWizardSettings(original, "/work/analytics");
  parsed.organization = "Cooptimize";
  parsed.client = "Contoso";
  parsed.repositories[0].description = "Updated description";
  parsed.repositories[0].defaultBranch = "main";
  parsed.repositories.push({
    name: "warehouse",
    description: "Warehouse SQL",
    role: "sql",
    localPath: "../warehouse",
    remoteName: "origin",
    defaultBranch: "main",
    isNew: true,
  });
  const merged = applyProjectWizardSettings(original, parsed);
  assert.match(merged, /# keep this client comment/);
  assert.match(merged, /custom_profile_key: 'keep-me'/);
  assert.match(merged, /custom_repo_key: 'keep-this-too'/);
  assert.match(merged, /- 'special-docs\/\*\*'/);
  assert.match(merged, /future_setting: 42/);
  assert.equal(projectYamlScalar(merged, ["profile", "client"]), "Contoso");
  assert.equal(projectYamlScalar(merged, ["repositories", "analytics", "default_branch"]), "main");
  assert.equal(projectYamlScalar(merged, ["repositories", "warehouse", "local_path"]), "../warehouse");
});

await t("coop init contract round-trips through /setup-project with a nested standards override intact", () => {
  const root = trackFixture(mkdtempSync(join(tmpdir(), "coop-init-roundtrip-")));
  const py = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0);
  const answers = ["Cooptimize", "Test Client", "", "", "", "", "", "n", "no", "no", "n"].join("\n") + "\n";
  const init = spawnSync(py, [join(REPO_ROOT, "lib", "init_wizard.py"), join(root, "repo")], { input: answers, encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root } });
  assert.equal(init.status, 0, init.stderr);
  // Python writes CRLF on Windows; the round-trip, not the line ending, is under test.
  const generated = readFileSync(join(root, "repo", ".coop", "project.yml"), "utf8").replace(/\r\n/g, "\n");
  assert.match(generated, /^# standards:\n#   sql:\n#     path: /m, "coop init documents the nested override shape");
  // A deliberate project override, written the way the generated comment shows.
  const override = "standards:\n  sql:\n    path: \"docs/standards/client-sql.md\"\n    section_refs: numeric\n";
  const original = generated.replace(/^backup:$/m, `${override}\nbackup:`);
  const parsed = parseProjectWizardSettings(original, join(root, "repo"));
  parsed.client = "Contoso";
  const merged = applyProjectWizardSettings(original, parsed);
  assert.equal(projectYamlScalar(merged, ["profile", "client"]), "Contoso");
  assert.ok(merged.includes(override), "setup-project must preserve the unowned standards block");
  // #93: neither wizard writes the retired `powerbi` MCP policy block.
  assert.doesNotMatch(generated, /^  powerbi:|readonly_flag/m, "coop init must not write mcp.powerbi");
  assert.doesNotMatch(merged, /^  powerbi:|readonly_flag/m, "setup-project must not add mcp.powerbi");
  // #98: neither wizard writes contract policy fields that nothing enforces.
  assert.doesNotMatch(generated, /live_discovery|allowed_default_actions|requires_approval_actions/, "coop init must not write unenforced policy fields");
  assert.doesNotMatch(merged, /live_discovery|allowed_default_actions|requires_approval_actions/, "setup-project must not add unenforced policy fields");
  assert.equal(projectYamlScalar(merged, ["standards", "sql", "path"]), "docs/standards/client-sql.md");
});

await t("native wizard is reachable inside Coop and creates the contract", async () => {
  const root = isolatedRoot("coop-project-wizard-");
  mkdirSync(join(root, ".git"));
  skipIfContaminated(root);
  const confirms = [true, false, false, false, true]; // local source, add repo, Fabric, TE, write
  const confirmTitles = [];
  let selectCount = 0;
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      input: async (label, def) => label.startsWith("Client / engagement") ? "Contoso" : def,
      confirm: async (title) => {
        confirmTitles.push(title);
        return confirms.shift() ?? false;
      },
      select: async (_label, options) => {
        selectCount++;
        if (selectCount === 1) return options.find((x) => x.includes("General project"));
        return options.find((x) => x.startsWith("✓ Use this folder:"));
      },
      notify: () => {},
    },
  };
  assert.equal(await runProjectWizard({}, ctx), true);
  const contract = join(root, ".coop", "project.yml");
  assert.ok(existsSync(contract));
  const text = readFileSync(contract, "utf8");
  assert.equal(projectYamlScalar(text, ["profile", "client"]), "Contoso");
  assert.doesNotMatch(text, /^standards:/m, "in-app wizard must omit default standards overrides");
  assert.equal(projectYamlScalar(text, ["repositories", root.split(/[\\/]/).pop(), "local_path"]), ".");
  assert.ok(!confirmTitles.includes("Lineage documentation"), "project setup must not launch data-doc setup");
});

await t("native wizard can create a repository-free discovery project", async () => {
  const root = trackFixture(mkdtempSync(join(tmpdir(), "coop-project-discovery-")));
  skipIfContaminated(root);
  const confirms = [false, false, false, false, true]; // no local source, add repo, Fabric, TE, write
  const notices = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      input: async (_label, def) => def,
      confirm: async () => confirms.shift() ?? false,
      notify: (message) => notices.push(message),
    },
  };
  assert.equal(await runProjectWizard({}, ctx), true);
  const text = readFileSync(join(root, ".coop", "project.yml"), "utf8");
  assert.equal(projectYamlScalar(text, ["estate", "mode"]), "discovery");
  assert.match(text, /repositories: \{\}/);
  assert.ok(notices.some((message) => message.includes("Discovery mode is ready")));
});

await t("data-doc setup reuses source roles and paths from the project contract", () => {
  const root = trackFixture(mkdtempSync(join(tmpdir(), "coop-project-prefill-")));
  mkdirSync(join(root, ".coop"));
  mkdirSync(join(root, "warehouse"));
  mkdirSync(join(root, "analytics"));
  const nested = join(root, "analytics");
  writeFileSync(join(root, ".coop", "project.yml"), `profile:
  client: 'Contoso'
repositories:
  warehouse:
    role: 'sql'
    local_path: './warehouse'
  future_reports:
    role: 'powerbi'
    local_path: 'TODO: add later'
`);
  assert.deepEqual(dataDocPrefillFromProject(nested), {
    sourceMode: "sql",
    sqlPath: "../warehouse",
    outputDir: "../data-docs",
    projectName: "Contoso",
  });
});

await t("a mixed repository prefills both data-doc source slots", () => {
  const root = trackFixture(mkdtempSync(join(tmpdir(), "coop-project-mixed-")));
  mkdirSync(join(root, ".coop"));
  writeFileSync(join(root, ".coop", "project.yml"), `profile:
  client: 'Fabrikam'
repositories:
  platform:
    role: 'mixed'
    local_path: '.'
`);
  assert.deepEqual(dataDocPrefillFromProject(root), {
    sourceMode: "both",
    sqlPath: ".",
    pbiPath: ".",
    outputDir: "data-docs",
    projectName: "Fabrikam",
  });
});

await t("DR1: the lineage docs live beside the project file, and the home repository's CI template runs coop-data-doc check", async () => {
  const setup = await import(pathToFileURL(join(REPO_ROOT, "lib", "data-doc-setup.mjs")).href);
  assert.equal(setup.DATA_DOCS_FOLDER, "data-docs");
  const client = trackFixture(mkdtempSync(join(tmpdir(), "coop-dr1-home-")));
  skipIfContaminated(client);
  for (const name of ["contoso-coop", "analytics"]) mkdirSync(join(client, name, ".git"), { recursive: true });
  mkdirSync(join(client, "contoso-coop", ".coop"));
  writeFileSync(join(client, "contoso-coop", ".coop", "project.yml"), `profile:
  client: 'Contoso'
repositories:
  analytics:
    role: 'sql'
    local_path: '../analytics'
`);
  // From the client's source repository, the contract comes from the home
  // repository beside it and the build is proposed there, not in the source tree.
  assert.equal(findProjectContract(join(client, "analytics")), join(client, "contoso-coop", ".coop", "project.yml"));
  assert.deepEqual(dataDocPrefillFromProject(join(client, "analytics")), { sourceMode: "sql", sqlPath: ".", outputDir: "../contoso-coop/data-docs", projectName: "Contoso" });
  assert.deepEqual(dataDocPrefillFromProject(join(client, "contoso-coop")), { sourceMode: "sql", sqlPath: "../analytics", outputDir: "data-docs", projectName: "Contoso" });
  assert.equal(setup.prefilledPrompt({ id: "output_dir", kind: "path", message: "Output dir" }, { outputDir: "../contoso-coop/data-docs" }).default, "../contoso-coop/data-docs");
  assert.equal(setup.prefilledPrompt({ id: "x", kind: "path", message: "Where should the docs output folder go?" }, { outputDir: "../d" }).default, "../d");
  assert.equal(setup.prefilledPrompt({ id: "x", kind: "path", message: "SQL repo path" }, { outputDir: "../d" }).default, undefined, "only the output prompt takes the output dir");

  const workflow = readFileSync(join(REPO_ROOT, "templates", "client-home", "github-workflow-data-docs-check.yml"), "utf8");
  assert.match(workflow, /run: coop-data-doc check/);
  const pin = JSON.parse(readFileSync(join(REPO_ROOT, "config", "release-manifest.json"), "utf8")).python_tools["coop-data-doc"];
  assert.ok(workflow.includes(`pipx install coop-data-doc==${pin}`), "the template pins the manifest's coop-data-doc");
  assert.match(readFileSync(join(REPO_ROOT, "templates", "client-home", "README.md"), "utf8"), /data-docs-check\.yml/);
});

await t("normal startup goes straight to the prompt while setup commands remain available", async () => {
  const root = isolatedRoot("coop-direct-start-");
  mkdirSync(join(root, ".git"));
  const handlers = new Map();
  const commands = new Map();
  let dialogs = 0;
  let execs = 0;
  const pi = {
    registerTool: () => {},
    registerCommand: (name, config) => commands.set(name, config),
    on: (name, handler) => handlers.set(name, handler),
    exec: async () => { execs++; return { code: 0, stdout: "", stderr: "" }; },
    sendUserMessage: () => {},
  };
  coopTools(pi);
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      select: async () => { dialogs++; return "Not now"; },
      notify: () => {},
    },
  };
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(dialogs, 0, "startup should not display project, menu, or data-doc dialogs");
  assert.equal(execs, 0, "startup should not invoke setup subprocesses");
  for (const name of ["start", "setup-project", "setup-docs"]) {
    assert.ok(commands.has(name), `manual /${name} command remains available`);
  }
});

await t("C1: proposeContractRoot names the client home repository beside several repositories, the repository when alone", () => {
  const client = trackFixture(mkdtempSync(join(tmpdir(), "coop-c1-root-")));
  skipIfContaminated(client);
  for (const name of ["analytics", "reports"]) mkdirSync(join(client, name, ".git"), { recursive: true });
  mkdirSync(join(client, "analytics", "src"));
  mkdirSync(join(client, "notes"));
  const pending = proposeContractRoot(join(client, "analytics", "src"));
  assert.deepEqual([pending.kind, pending.root, pending.repos, pending.parent, pending.pending], ["home-repo", join(client, "<client>-coop"), ["analytics", "reports"], client, true]);
  assert.match(contractLocationNote(pending), /is one of 2 side by side \(analytics, reports\)/);
  assert.match(contractLocationNote(pending), /The folder between the repositories is never used/);
  const named = proposeContractRoot(join(client, "analytics", "src"), { existing: null, client: "Contoso Retail" });
  assert.deepEqual([named.kind, named.root, named.path, named.pending], ["home-repo", join(client, "contoso-retail-coop"), join(client, "contoso-retail-coop", ".coop", "project.yml"), false]);
  assert.deepEqual(siblingRepositoryEntries(named.repos, "main").map((r) => [r.name, r.role, r.localPath]), [["analytics", "generic", "../analytics"], ["reports", "generic", "../reports"]]);
  const alone = proposeContractRoot(join(client, "analytics", "src"), { existing: null, repository: true });
  assert.deepEqual([alone.kind, alone.root], ["git-root", join(client, "analytics")]);
  const single = isolatedRoot("coop-c1-single-");
  mkdirSync(join(single, ".git"));
  mkdirSync(join(single, "sub"));
  assert.deepEqual([proposeContractRoot(join(single, "sub")).kind, proposeContractRoot(join(single, "sub")).root], ["git-root", single]);
  const plain = proposeContractRoot(join(client, "notes"));
  assert.deepEqual([plain.kind, plain.root], ["folder", join(client, "notes")]);
  // A home repository beside the repositories whose contract lists this one: found from inside it.
  mkdirSync(join(client, "contoso-coop", ".coop"), { recursive: true });
  mkdirSync(join(client, "contoso-coop", ".git"));
  writeFileSync(join(client, "contoso-coop", ".coop", "project.yml"), "profile:\n  client: 'Contoso'\nrepositories:\n  analytics:\n    role: 'sql'\n    local_path: '../analytics'\n");
  assert.equal(findSiblingContract(join(client, "analytics", "src")), join(client, "contoso-coop", ".coop", "project.yml"));
  assert.equal(findSiblingContract(join(client, "reports")), null, "a repository the home does not list is not covered");
  assert.equal(findSiblingContract(join(client, "notes")), null, "outside Git there is no sibling");
  const viaHome = proposeContractRoot(join(client, "analytics", "src"));
  assert.deepEqual([viaHome.kind, viaHome.root, viaHome.sibling], ["existing", join(client, "contoso-coop"), true]);
  assert.match(contractLocationNote(viaHome), /the client home repository beside it lists this folder/);
  assert.equal(findProjectContract(join(client, "analytics", "src"), {}), join(client, "contoso-coop", ".coop", "project.yml"), "the standards finder takes the sibling home too");
  // The launcher's answer wins for the other finders.
  assert.equal(findProjectContract(join(client, "reports"), { COOP_PROJECT_YML: join(client, "contoso-coop", ".coop", "project.yml") }), join(client, "contoso-coop", ".coop", "project.yml"));
  // A contract above cwd still wins over everything.
  mkdirSync(join(client, ".coop"));
  writeFileSync(join(client, ".coop", "project.yml"), "profile:\n  client: 'Contoso'\n");
  const existing = proposeContractRoot(join(client, "reports"));
  assert.deepEqual([existing.kind, existing.root, existing.path, existing.sibling], ["existing", client, join(client, ".coop", "project.yml"), false]);
  assert.match(contractLocationNote(existing), /never writes a second copy/);
  assert.match(contractCreatedNote(client), /Share \.coop\/project\.yml with the team .*Open coop at or below /);
});

await t("C1: opened in the folder that holds the repositories, the one repository inside it with a contract is used", async () => {
  const client = trackFixture(mkdtempSync(join(tmpdir(), "coop-c1-child-")));
  skipIfContaminated(client);
  for (const name of ["analytics", "reports"]) mkdirSync(join(client, name, ".git"), { recursive: true });
  mkdirSync(join(client, "notes"));
  assert.equal(lib.findChildContract(client), null, "no repository inside has a contract");
  mkdirSync(join(client, "analytics", ".coop"));
  const contract = join(client, "analytics", ".coop", "project.yml");
  writeFileSync(contract, "profile:\n  client: 'Contoso'\n");
  assert.equal(lib.findChildContract(client), contract);
  assert.equal(findProjectContract(client, {}), contract, "the standards finder (the window's) looks one level down too");
  const where = proposeContractRoot(client);
  assert.deepEqual([where.kind, where.root, where.path, where.child, where.sibling], ["existing", join(client, "analytics"), contract, true, false]);
  assert.match(contractLocationNote(where), /in the repository analytics inside it\. Coop edits it and never writes a second copy here/);
  // Inside a repository coop never looks down: a nested folder is not a client folder.
  assert.equal(lib.findChildContract(join(client, "reports")), null);
  // A folder that is not a repository (no .git) does not count.
  mkdirSync(join(client, "notes", ".coop"));
  writeFileSync(join(client, "notes", ".coop", "project.yml"), "profile:\n  client: 'Notes'\n");
  assert.equal(lib.findChildContract(client), contract);
  // Several repositories with a contract: none is picked, and the note names them.
  mkdirSync(join(client, "reports", ".coop"));
  writeFileSync(join(client, "reports", ".coop", "project.yml"), "profile:\n  client: 'Contoso'\n");
  assert.equal(lib.findChildContract(client), null);
  assert.equal(findProjectContract(client, {}), null);
  const several = proposeContractRoot(client);
  assert.deepEqual([several.kind, several.children], ["folder", ["analytics", "reports"]]);
  assert.match(contractLocationNote(several), /Several repositories inside this folder have a project file \(analytics, reports\)\. Open coop in the repository you mean/);
});

await t("C1: opened in the folder above that (the user folder over devops/fabric), the one repository two levels down is used", () => {
  const user = trackFixture(mkdtempSync(join(tmpdir(), "coop-c1-two-")));
  skipIfContaminated(user);
  const fabric = join(user, "devops", "fabric");
  mkdirSync(join(fabric, ".git"), { recursive: true });
  mkdirSync(join(fabric, ".coop"));
  const contract = join(fabric, ".coop", "project.yml");
  writeFileSync(contract, "profile:\n  client: 'Contoso'\n");
  // AppData is never searched, and neither is the inside of a repository.
  for (const repo of [join(user, "AppData", "tool"), join(user, "outer", "nested")]) {
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".coop"));
    writeFileSync(join(repo, ".coop", "project.yml"), "profile:\n  client: 'Other'\n");
  }
  mkdirSync(join(user, "outer", ".git"));
  assert.equal(lib.findChildContract(user), contract);
  assert.equal(findProjectContract(user, {}), contract, "the standards finder (the window's) looks two levels down too");
  const where = proposeContractRoot(user);
  assert.deepEqual([where.kind, where.path, where.child, where.childPath], ["existing", contract, true, join("devops", "fabric")]);
  assert.match(contractLocationNote(where), /in the repository devops.fabric inside it\./);
  // A second client repository two levels down: none is picked, and the note names both by path.
  const other = join(user, "clients", "reports");
  mkdirSync(join(other, ".git"), { recursive: true });
  mkdirSync(join(other, ".coop"));
  writeFileSync(join(other, ".coop", "project.yml"), "profile:\n  client: 'Contoso'\n");
  assert.equal(lib.findChildContract(user), null);
  assert.deepEqual(proposeContractRoot(user).children, [join("clients", "reports"), join("devops", "fabric")]);
});

await t("C1: coop's own checkout is never the team project (home folder, sibling, proposal)", () => {
  const home = trackFixture(mkdtempSync(join(tmpdir(), "coop-c1-home-")));
  skipIfContaminated(home);
  const coop = join(home, "coop-agent");
  for (const sub of [".git", ".coop", "bin", "lib"]) mkdirSync(join(coop, sub), { recursive: true });
  writeFileSync(join(coop, "bin", "coop.ps1"), "");
  writeFileSync(join(coop, "lib", "common.ps1"), "");
  writeFileSync(join(coop, ".coop", "project.yml"), "repositories:\n  fabric:\n    local_path: \"../fabric\"\n");
  mkdirSync(join(home, "fabric", ".git"), { recursive: true });
  assert.equal(lib.isCoopCheckout(coop), true);
  assert.equal(lib.findChildContract(home), null, "opened from the home folder, coop's checkout is not the project");
  assert.deepEqual(lib.childRepositories(home), ["fabric"]);
  assert.equal(findSiblingContract(join(home, "fabric")), null, "a repository beside coop's checkout never takes its sample");
  assert.equal(proposeContractRoot(join(home, "fabric")).kind, "git-root");
});

await t("C1: /setup-project below a committed root contract edits that contract and writes no copy", async () => {
  const client = trackFixture(mkdtempSync(join(tmpdir(), "coop-c1-edit-")));
  skipIfContaminated(client);
  mkdirSync(join(client, "analytics", ".git"), { recursive: true });
  mkdirSync(join(client, "analytics", "sql"));
  mkdirSync(join(client, ".coop"));
  const contract = join(client, ".coop", "project.yml");
  writeFileSync(contract, `profile:\n  organization: 'Cooptimize'\n  client: 'Contoso'\n  default_branch: 'main'\nrepositories:\n  analytics:\n    description: 'Warehouse'\n    role: 'sql'\n    local_path: 'analytics'\n    remote_name: 'origin'\n    default_branch: 'main'\ntools:\n  fabric_cli:\n    enabled: false\n  tabular_editor_cli:\n    enabled: false\n`);
  const confirms = [false, false, false, false, true]; // edit repo, add repo, Fabric, TE, write
  const titles = [];
  const notes = [];
  const ctx = {
    cwd: join(client, "analytics", "sql"),
    hasUI: true,
    mode: "tui",
    ui: {
      input: async (label, def) => label.startsWith("Client / engagement") ? "Fabrikam" : def,
      confirm: async (title, message) => { titles.push(`${title}\n${message}`); return confirms.shift() ?? false; },
      notify: (message) => notes.push(message),
    },
  };
  assert.equal(await runProjectWizard({}, ctx), true);
  assert.equal(projectYamlScalar(readFileSync(contract, "utf8"), ["profile", "client"]), "Fabrikam");
  assert.equal(existsSync(join(client, "analytics", ".coop")), false, "no second contract below the root");
  assert.equal(existsSync(join(client, "analytics", "sql", ".coop")), false);
  assert.ok(titles.some((text) => text.startsWith("Where the project file goes")) === false, "an existing contract is never re-located");
  assert.ok(titles.some((text) => text.includes(`Update ${contract} for Fabrikam?`)), titles.join("\n---\n"));
  assert.ok(notes.some((text) => text.includes("A contract already covers this folder") && text.includes(contract)), notes.join("\n"));
  assert.ok(notes.some((text) => text.includes("not shared yet") && text.includes("is not a Git repository")), "outside Git the share is explained, never attempted: " + notes.join("\n"));
});

await t("C1: with no contract beside other repositories, /setup-project creates the client home repository and lists the siblings", async () => {
  const client = trackFixture(mkdtempSync(join(tmpdir(), "coop-c1-new-")));
  skipIfContaminated(client);
  for (const name of ["analytics", "reports"]) mkdirSync(join(client, name, ".git"), { recursive: true });
  // home repo yes, local source yes, edit analytics no, edit reports no, add repo no, Fabric no, TE no, write yes
  const confirms = [true, true, false, false, false, false, false, true];
  const titles = [];
  const notes = [];
  const ctx = {
    cwd: join(client, "analytics"),
    hasUI: true,
    mode: "tui",
    ui: {
      input: async (label, def) => label.startsWith("Client / engagement") ? "Contoso" : def,
      confirm: async (title, message) => { titles.push(`${title}\n${message}`); return confirms.shift() ?? false; },
      notify: (message) => notes.push(message),
    },
  };
  assert.equal(await runProjectWizard({}, ctx), true);
  const home = join(client, "contoso-coop");
  const contract = join(home, ".coop", "project.yml");
  assert.ok(existsSync(contract), "the contract goes in the client home repository beside the repositories");
  assert.ok(existsSync(join(home, ".git")), "the home repository is initialized");
  assert.match(readFileSync(join(home, "README.md"), "utf8"), /^# contoso-coop\n/);
  assert.equal(existsSync(join(client, ".coop")), false, "the folder between the repositories is never used");
  assert.equal(existsSync(join(client, "analytics", ".coop")), false);
  assert.match(titles[0], /^Where the project file goes\nCreate the client home repository .*contoso-coop beside analytics, reports/);
  assert.ok(titles.some((text) => text.includes(`Create ${contract} for Contoso?`)), titles.join("\n---\n"));
  const text = readFileSync(contract, "utf8");
  assert.equal(projectYamlScalar(text, ["repositories", "analytics", "local_path"]), "../analytics");
  assert.equal(projectYamlScalar(text, ["repositories", "reports", "local_path"]), "../reports");
  assert.match(text, /^# One committed team file per client/m);
  assert.ok(notes.some((text) => text.startsWith("Created the client home repository") && text.includes(home)), notes.join("\n"));
  assert.ok(notes.some((text) => text.startsWith("Share .coop/project.yml with the team") && text.includes(home)), notes.join("\n"));
  // From inside a listed repository the home's contract is the one coop finds.
  assert.equal(findSiblingContract(join(client, "reports")), contract);

  // Declining the home repository keeps the contract to the repository.
  const other = trackFixture(mkdtempSync(join(tmpdir(), "coop-c1-decline-")));
  skipIfContaminated(other);
  for (const name of ["analytics", "reports"]) mkdirSync(join(other, name, ".git"), { recursive: true });
  const declined = [false, false, false, false, false, true];
  const ctx2 = { ...ctx, cwd: join(other, "reports"), ui: { ...ctx.ui, confirm: async () => declined.shift() ?? false } };
  assert.equal(await runProjectWizard({}, ctx2), true);
  assert.ok(existsSync(join(other, "reports", ".coop", "project.yml")));
  assert.equal(existsSync(join(other, ".coop")), false);
  assert.equal(existsSync(join(other, "contoso-coop")), false);
});

await t("editing through /setup-project writes a backup and keeps custom settings", async () => {
  const root = isolatedRoot("coop-project-edit-");
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".coop"));
  const contract = join(root, ".coop", "project.yml");
  const original = `profile:\n  organization: 'Cooptimize'\n  client: 'Contoso'\n  default_branch: 'main'\nrepositories:\n  app:\n    description: 'App'\n    role: 'generic'\n    local_path: '.'\n    remote_name: 'origin'\n    default_branch: 'main'\ncustom_section:\n  keep: 'yes'\ntools:\n  fabric_cli:\n    enabled: false\n  tabular_editor_cli:\n    enabled: false\n`;
  writeFileSync(contract, original);
  const confirms = [false, false, false, false, true]; // edit repo, add repo, Fabric, TE, write
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      input: async (_label, def) => def,
      confirm: async () => confirms.shift() ?? false,
      notify: () => {},
    },
  };
  assert.equal(await runProjectWizard({}, ctx), true);
  assert.ok(existsSync(`${contract}.bak`));
  assert.equal(readFileSync(`${contract}.bak`, "utf8"), original);
  assert.match(readFileSync(contract, "utf8"), /custom_section:\n  keep: 'yes'/);
});

// --- C2: the declared layout and the semantic-model-to-SQL mapping -----------------

await t("C2: a new contract declares fabric.layout and power_bi.table_mapping; parse and apply round-trip", () => {
  const { FABRIC_LAYOUTS, TABLE_MAPPING_RULES, proposedFabricLayout, tableMappingFromContract, projectYamlMapping, projectSettingsProblems, PROJECT_MESSAGES } = lib;
  assert.deepEqual([...FABRIC_LAYOUTS], ["warehouse", "lakehouse", "sql_database", "mixed"]);
  assert.deepEqual([...TABLE_MAPPING_RULES], ["same_name", "prefix"]);
  assert.equal(proposedFabricLayout("Warehouse", ""), "warehouse");
  assert.equal(proposedFabricLayout("", "fabric_lakehouse"), "lakehouse");
  assert.equal(proposedFabricLayout("", "fabric_sql_database"), "sql_database");
  assert.equal(proposedFabricLayout("", "azure_sql"), "");

  const text = renderProjectWizardSettings(settings);
  assert.equal(projectYamlScalar(text, ["fabric", "layout"]), "warehouse");
  assert.match(text, /^  warehouse_names: \['Contoso Warehouse'\]$/m, "the default endpoint item seeds warehouse_names");
  assert.match(text, /^  lakehouse_names: \[\]$/m);
  assert.equal(projectYamlScalar(text, ["power_bi", "table_mapping", "rule"]), "same_name");
  assert.equal(projectYamlScalar(text, ["power_bi", "table_mapping", "default_schema"]), "dbo");
  assert.match(text, /^    overrides: \{\}$/m);
  const parsed = parseProjectWizardSettings(text, "/p");
  assert.equal(parsed.fabricLayout, "warehouse");
  assert.equal(parsed.tableMappingRule, "same_name");
  assert.equal(parsed.tableMappingSchema, "dbo");
  assert.equal(parsed.tableMappingPrefix, "");
  const mapping = tableMappingFromContract(text);
  assert.equal(mapping.declared, true);
  assert.deepEqual(mapping.overrides, {});

  // An older contract without the block: applying the wizard adds it once, and
  // hand-written overrides survive a later edit.
  const older = text.split("\n").filter((line) => !/table_mapping|^    (rule|default_schema|view_prefix|overrides):|^  layout:/.test(line)).join("\n");
  assert.equal(tableMappingFromContract(older).declared, false, "no block, nothing declared");
  const applied = applyProjectWizardSettings(older, { ...parsed, repositories: [], tableMappingRule: "prefix", tableMappingPrefix: "v_", fabricLayout: "mixed" });
  assert.equal(projectYamlScalar(applied, ["fabric", "layout"]), "mixed");
  assert.equal(projectYamlScalar(applied, ["power_bi", "table_mapping", "rule"]), "prefix");
  assert.equal(projectYamlScalar(applied, ["power_bi", "table_mapping", "view_prefix"]), "v_");
  assert.match(applied, /^    overrides: \{\}$/m, "an empty overrides mapping is written as a flow mapping, not a quoted string");
  const withOverrides = applied.replace("    overrides: {}", "    overrides:\n      Sales: 'dbo.vFactSales'\n      'Date Table': 'dim.vDate'");
  assert.deepEqual(projectYamlMapping(withOverrides, ["power_bi", "table_mapping", "overrides"]), { Sales: "dbo.vFactSales", "Date Table": "dim.vDate" });
  const reapplied = applyProjectWizardSettings(withOverrides, { ...parsed, repositories: [], tableMappingRule: "same_name" });
  assert.deepEqual(tableMappingFromContract(reapplied).overrides, { Sales: "dbo.vFactSales", "Date Table": "dim.vDate" }, "overrides are never rewritten");
  assert.equal(projectYamlScalar(reapplied, ["power_bi", "table_mapping", "view_prefix"]), "", "a same_name rule drops the prefix");

  // The wizard's checks, the same words in the terminal and the form.
  const bad = projectSettingsProblems({ ...settings, fabricLayout: "onelake", tableMappingRule: "regex", tableMappingSchema: "1dbo" });
  assert.deepEqual(bad.map((p) => p.field), ["fabricLayout", "tableMappingRule", "tableMappingSchema"]);
  assert.equal(bad[0].message, PROJECT_MESSAGES.fabricLayout);
  assert.deepEqual(projectSettingsProblems({ ...settings, tableMappingRule: "prefix", tableMappingPrefix: "v-" }).map((p) => p.field), ["tableMappingPrefix"]);
  assert.deepEqual(projectSettingsProblems({ ...settings, tableMappingRule: "prefix", tableMappingPrefix: "v_" }), []);
  assert.deepEqual(projectSettingsProblems({ ...settings, fabricEnabled: false, fabricLayout: "onelake" }), [], "the Fabric block is checked only when Fabric is on");
});

await t("C2: the mapping predicts model tables and SQL objects, and names a mismatch instead of 'no dependents'", () => {
  const { expectedModelTables, expectedSqlObject, mappingCheckLines, mappingExpectationLine } = lib;
  const same = { declared: true, rule: "same_name", defaultSchema: "dbo", viewPrefix: "", overrides: { Calendar: "dim.vDate" } };
  assert.deepEqual(expectedModelTables(same, "dbo", "vSales"), ["vSales", "dbo.vSales"]);
  assert.deepEqual(expectedModelTables(same, "fin", "vGL"), ["fin.vGL"], "another schema needs the qualified name");
  assert.deepEqual(expectedModelTables(same, "dim", "vDate"), ["Calendar"], "an override wins over the rule");
  assert.equal(expectedSqlObject(same, "vSales"), "dbo.vSales");
  assert.equal(expectedSqlObject(same, "fin.vGL"), "fin.vGL");
  assert.equal(expectedSqlObject(same, "calendar"), "dim.vDate", "overrides match case-insensitively");

  const prefix = { declared: true, rule: "prefix", defaultSchema: "dbo", viewPrefix: "v_", overrides: {} };
  assert.deepEqual(expectedModelTables(prefix, "dbo", "v_Sales"), ["Sales"]);
  assert.deepEqual(expectedModelTables(prefix, "dbo", "FactSales"), [], "no prefix, no predicted table");
  assert.equal(expectedSqlObject(prefix, "Sales"), "dbo.v_Sales");

  assert.deepEqual(mappingCheckLines({ declared: false }, "dbo.vSales", []), [], "nothing declared, nothing said");
  const [holds] = mappingCheckLines(same, "dbo.vSales", ["vSales"]);
  assert.match(holds, /^Declared mapping holds .*'vSales' loads dbo\.vSales/);
  const [none] = mappingCheckLines(same, "dbo.vSales", []);
  assert.match(none, /^Declared mapping does not match/);
  assert.match(none, /'vSales' or 'dbo\.vSales' would load dbo\.vSales, and none is documented/);
  assert.match(none, /do not read this as "no Power BI dependents"/);
  const [other] = mappingCheckLines(same, "dbo.vSales", ["Sales Facts"]);
  assert.match(other, /^Declared mapping does not match .*loaded by 'Sales Facts', which rule same_name.*does not predict \(expected 'vSales' or 'dbo\.vSales'\)/);
  const [noPrefix] = mappingCheckLines(prefix, "dbo.FactSales", []);
  assert.match(noPrefix, /does not carry the prefix 'v_'/);
  const [withExtra] = mappingCheckLines(same, "dbo.vSales", ["vSales", "Budget"]);
  assert.match(withExtra, /Also loaded by 'Budget', outside the rule/);

  assert.equal(mappingExpectationLine({ declared: false }, "dbo", "vSales"), "");
  assert.match(mappingExpectationLine(same, "dbo", "vSales"), /a semantic-model table named 'vSales' or 'dbo\.vSales' is expected to load dbo\.vSales; .*confirm with data_doc lineage/);
  assert.match(mappingExpectationLine(prefix, "dbo", "FactSales"), /no semantic-model table is expected to load dbo\.FactSales/);
});

cleanupFixtures();
for (const s of skips) console.log(`  skipped: ${s}`);
console.log(`  ${n} project-wizard tests passed${skips.length ? ` (${skips.length} skipped)` : ""}`);
