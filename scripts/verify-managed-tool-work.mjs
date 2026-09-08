import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURES = fileURLToPath(new URL("../tests/fixtures/findings/", import.meta.url));

export function validateReviewWork(report, tool, version, rule) {
  if (report?.tool !== tool || report.version !== version || !Array.isArray(report.diagnostics) || report.diagnostics.length ||
      !Array.isArray(report.findings) || !report.findings.some(finding => finding.rule_id === rule)) {
    throw new Error(`Managed tool did not analyze its fixture successfully: ${tool}.`);
  }
  return { version, findings: report.findings.length, expectedRule: rule };
}

export function validateLineageWork(graph) {
  const nodes = ["view:silver.dim_customer", "semantic_model:legacy", "measure:legacy.total rev", "pbi_table:legacy.factsales"];
  if (!graph?.nodes || !nodes.every(id => graph.nodes[id]?.id === id) || !Array.isArray(graph.edges) ||
      !graph.edges.some(edge => edge.source_id === "measure:legacy.total rev" && edge.target_id === "pbi_table:legacy.factsales" && edge.edge_type === "references") ||
      !graph.edges.some(edge => edge.source_id === "view:silver.dim_customer" && edge.edge_type === "reads" && graph.nodes[edge.target_id]?.name === "raw_erp_contact")) {
    throw new Error("Managed data-doc did not generate the expected SQL and semantic-model lineage.");
  }
  return { nodes: Object.keys(graph.nodes).length, edges: graph.edges.length };
}

// Execute installed entrypoints with bundled Python, without user configuration,
// credentials, host Python packages or writes inside the signed application.
export function verifyManagedToolWork(bundle) {
  const root = mkdtempSync(join(tmpdir(), "coop-managed-tool-work-"));
  try {
    for (const name of ["home", "sql", "powerbi"]) mkdirSync(join(root, name));
    copyFileSync(join(FIXTURES, "select-star.sql"), join(root, "sql", "select-star.sql"));
    copyFileSync(join(FIXTURES, "legacy.bim"), join(root, "powerbi", "legacy.bim"));
    const home = join(root, "home");
    const env = { PATH: dirname(bundle.python), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      TMPDIR: home, TEMP: home, TMP: home, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" };
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC"]) if (process.env[key]) env[key] = process.env[key];
    const run = (tool, args) => {
      const result = spawnSync(bundle.python, ["-I", "-B", "-X", "utf8", join(bundle.root, "python", "entrypoints", `${tool}.py`), ...args],
        { cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Managed tool work failed: ${tool} (${result.error?.code || result.signal || result.status}). ${result.stderr || ""}`);
      return result.stdout;
    };
    const results = {};
    for (const [tool, file, rule] of [["coop-sql-review", "sql/select-star.sql", "SQL-NO-SELECT-STAR"],
      ["coop-dax-review", "powerbi/legacy.bim", "DAX-BIDI-RELATIONSHIP"]]) {
      results[tool] = validateReviewWork(JSON.parse(run(tool, ["check", file, "--format", "json"])), tool, bundle.versions.pythonTools[tool], rule);
    }
    writeFileSync(join(root, "coop-data-doc.yml"), "project_name: Managed Runtime Acceptance\nrepos:\n  sql:\n    path: ./sql\n    include: [\"**/*.sql\"]\n  powerbi:\n    path: ./powerbi\n    include: [\"**/*.bim\"]\noutput:\n  dir: ./data-docs\n  site_dir: ./data-docs-site\nsql_dialect: tsql\n");
    run("coop-data-doc", ["scan", "--config", "coop-data-doc.yml", "--non-interactive", "--jobs", "1"]);
    results["coop-data-doc"] = validateLineageWork(JSON.parse(readFileSync(join(root, "data-docs", "graph.json"), "utf8")));
    return results;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Run serially in the dedicated verification CLI before starting runtime children.
// The actual Pi loader must see only the disposable profile when it is imported.
export async function verifyManagedExtensionWork(bundle, { tempRoot = tmpdir() } = {}) {
  const root = realpathSync(mkdtempSync(join(tempRoot, "coop-extension-work-é & ")));
  const originalEnv = { ...process.env };
  try {
    for (const name of ["home", "sql", "powerbi"]) mkdirSync(join(root, name));
    const home = join(root, "home");
    const env = { PATH: dirname(bundle.node), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      TMPDIR: home, TEMP: home, TMP: home, PI_CODING_AGENT_DIR: join(home, "agent"),
      COOP_ROOT: bundle.coopRoot, COOP_DESKTOP_MANAGED_RUNTIME: "1", COOP_WORKSPACE_ACCESS_MODE: "writable",
      COOP_SKIP_AZ: "1", COOP_NO_ONBOARD: "1", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (originalEnv[key]) env[key] = originalEnv[key];
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    copyFileSync(join(FIXTURES, "select-star.sql"), join(root, "sql", "é & select-star.sql"));
    copyFileSync(join(FIXTURES, "legacy.bim"), join(root, "powerbi", "legacy.bim"));
    writeFileSync(join(root, "coop-data-doc.yml"), "project_name: Managed Extension Acceptance\nrepos:\n  sql:\n    path: ./sql\n    include: [\"**/*.sql\"]\n  powerbi:\n    path: ./powerbi\n    include: [\"**/*.bim\"]\noutput:\n  dir: ./data-docs\n  site_dir: ./data-docs-site\nsql_dialect: tsql\n");
    const loader = join(bundle.root, "npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
    const { loadExtensions } = await import(pathToFileURL(loader));
    const loaded = await loadExtensions([join(bundle.coopRoot, "extensions/coop-tools/index.ts")], root);
    if (loaded.errors.length || loaded.extensions.length !== 1) throw new Error(`Packaged Pi could not load the Coop tool extension: ${JSON.stringify(loaded.errors).slice(0, 4000)}`);
    const registered = loaded.extensions[0].tools;
    const context = { cwd: root, hasUI: false, ui: { notify() {} } };
    const call = async (name, params) => {
      const definition = registered.get(name)?.definition;
      if (typeof definition?.execute !== "function") throw new Error(`Packaged Coop tool is missing: ${name}.`);
      const result = await definition.execute(`acceptance-${name}`, params, AbortSignal.timeout(60000), () => {}, context);
      if (result?.isError || result?.details?.exitCode !== 0) throw new Error(`Packaged Coop tool failed through Pi: ${name}. ${String(result?.details?.error || result?.details?.stderr || "Missing successful exit result").slice(0, 2000)}`);
      return result.details;
    };
    const results = {};
    for (const [name, command, file, rule] of [["sql_review", "coop-sql-review", "sql/é & select-star.sql", "SQL-NO-SELECT-STAR"],
      ["dax_review", "coop-dax-review", "powerbi/legacy.bim", "DAX-BIDI-RELATIONSHIP"]]) {
      const result = await call(name, { paths: [join(root, file)] });
      results[name] = validateReviewWork(result.report, command, bundle.versions.pythonTools[command], rule);
    }
    await call("data_doc", { command: "scan" });
    results.data_doc = validateLineageWork(JSON.parse(readFileSync(join(root, "data-docs/graph.json"), "utf8")));
    const lineage = await call("data_doc", { command: "lineage", object: "silver.dim_customer" });
    if (lineage.lineage?.object?.name !== "silver.dim_customer") throw new Error("Packaged Data Doc did not return the requested lineage object.");
    results.lineage = { object: lineage.lineage.object.name };
    return { piVersion: bundle.versions.pi, loader: "packaged Pi loadExtensions", results };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
}
