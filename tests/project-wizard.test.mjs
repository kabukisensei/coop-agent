// Tests for the in-Coop /setup-project wizard's contract rendering and safe merge.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const {
  default: coopTools,
  applyProjectWizardSettings,
  parseProjectWizardSettings,
  projectYamlScalar,
  renderProjectWizardSettings,
  runProjectWizard,
  estateMode,
  dataDocPrefillFromProject,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
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
  fabricWorkspaceId: "workspace-123",
  powerBiWorkspaceName: "Contoso Dev",
  powerBiWorkspaceId: "pbi-123",
  tabularEditorEnabled: false,
  tabularEditorPath: "te",
  bpaRulesPath: "",
};

await t("new-project renderer produces a parseable, governed contract", () => {
  const text = renderProjectWizardSettings(settings);
  assert.equal(projectYamlScalar(text, ["profile", "client"]), "Contoso");
  assert.equal(projectYamlScalar(text, ["repositories", "analytics", "local_path"]), ".");
  assert.equal(projectYamlScalar(text, ["tools", "fabric_cli", "enabled"]), "true");
  assert.equal(projectYamlScalar(text, ["logging", "require_task_log"]), "true");
  assert.equal(projectYamlScalar(text, ["estate", "mode"]), "partial");
  assert.equal(projectYamlScalar(text, ["estate", "live_discovery", "production_rows"]), "explicit_scope_and_approval");
  assert.equal((text.match(/^  environment_names:$/gm) || []).length, 2);
  assert.match(text, /# Warehouse \/ Lakehouse workspace for each deployment environment\./);
  assert.match(text, /# Semantic-model workspace for each deployment environment\./);
  assert.match(text, /- 'update markdown docs, html site, logs'/);
  assert.match(text, /agent_never_commit:/);
  assert.match(text, /never_without_explicit_instruction:/);
  const parsed = parseProjectWizardSettings(text, "/work/analytics");
  assert.equal(parsed.repositories[0].role, "sql");
  assert.equal(parsed.tenantId, "tenant-123");
  assert.equal(estateMode([]), "discovery");
  assert.equal(estateMode([{ ...settings.repositories[0], role: "mixed" }]), "connected");
  assert.equal(estateMode([{ ...settings.repositories[0], role: "powerbi" }, settings.repositories[0]]), "connected");
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

await t("native wizard is reachable inside Coop and creates the contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-project-wizard-"));
  mkdirSync(join(root, ".git"));
  const confirms = [true, false, false, false, true, false]; // local source, add repo, Fabric, TE, write, lineage
  let selectCount = 0;
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      input: async (label, def) => label.startsWith("Client / engagement") ? "Contoso" : def,
      confirm: async () => confirms.shift() ?? false,
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
  assert.equal(projectYamlScalar(text, ["repositories", root.split(/[\\/]/).pop(), "local_path"]), ".");
});

await t("native wizard can create a repository-free discovery project", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-project-discovery-"));
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
  const root = mkdtempSync(join(tmpdir(), "coop-project-prefill-"));
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
    projectName: "Contoso",
  });
});

await t("a mixed repository prefills both data-doc source slots", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-project-mixed-"));
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
    projectName: "Fabrikam",
  });
});

await t("startup offers project setup in an unconfigured Git repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-project-offer-"));
  mkdirSync(join(root, ".git"));
  const handlers = new Map();
  const commands = new Map();
  const prompts = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (name, config) => commands.set(name, config),
    on: (name, handler) => handlers.set(name, handler),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage: () => {},
  };
  coopTools(pi);
  assert.ok(commands.has("setup-project"), "/setup-project command should be registered");
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      select: async (title, options) => {
        prompts.push(title);
        return prompts.length === 1 ? "Not now" : options.find((x) => x.includes("type it myself"));
      },
      notify: () => {},
    },
  };
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.match(prompts[0], /Set up this Coop project\?/);
  assert.match(prompts[0], /no \.coop\/project\.yml/);
});

await t("editing through /setup-project writes a backup and keeps custom settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-project-edit-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".coop"));
  const contract = join(root, ".coop", "project.yml");
  const original = `profile:\n  organization: 'Cooptimize'\n  client: 'Contoso'\n  default_branch: 'main'\nrepositories:\n  app:\n    description: 'App'\n    role: 'generic'\n    local_path: '.'\n    remote_name: 'origin'\n    default_branch: 'main'\ncustom_section:\n  keep: 'yes'\ntools:\n  fabric_cli:\n    enabled: false\n  tabular_editor_cli:\n    enabled: false\n`;
  writeFileSync(contract, original);
  const confirms = [false, false, false, false, true, false]; // edit repo, add repo, Fabric, TE, write, lineage
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

console.log(`  ${n} project-wizard tests passed`);
