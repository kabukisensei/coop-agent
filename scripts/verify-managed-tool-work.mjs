import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
