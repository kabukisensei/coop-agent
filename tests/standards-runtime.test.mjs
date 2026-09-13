import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const root = mkdtempSync(join(tmpdir(), "coop-std-runtime-"));
process.env.COOP_STANDARDS_SNAPSHOT_ROOT = join(root, "snapshots");
const mod = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const project = join(root, "project");
mkdirSync(join(project, ".coop"), { recursive: true });
mkdirSync(join(project, "standards"));
const sqlSource = join(project, "standards", "sql.md");
writeFileSync(sqlSource, "# SQL\n## Stored procedures\nSchema qualify names.\n");
writeFileSync(join(project, "standards", "dax.md"), "# DAX\n## Measures\nUse explicit measures.\n");
writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: standards/sql.md\n  dax: standards/dax.md\nrepositories:\n  source:\n    local_path: .\n");

const handlers = new Map();
const tools = new Map();
const executions = [];
let reportMode = "valid";
const pi = {
  on(name, fn) { handlers.set(name, fn); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {},
  sendUserMessage() {},
  async exec(bin, args, options) {
    executions.push({ bin, args, optionKeys: Object.keys(options).sort() });
    const index = args.indexOf("--standards");
    const path = index >= 0 ? args[index + 1] : null;
    const sha256 = path ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
    const standards = path ? { path, sha256 } : undefined;
    if (reportMode === "bad_hash" && standards) standards.sha256 = "0".repeat(64);
    if (reportMode === "bad_path" && standards) standards.path = join(root, "wrong.md");
    if (reportMode === "malformed_revision" && standards) standards.revision = 7;
    const stdout = reportMode === "malformed" ? "not-json" : JSON.stringify({ standards: reportMode === "missing" ? undefined : standards, findings: [] });
    return { stdout, stderr: "reviewer diagnostic", code: 0 };
  },
};
const ctx = { cwd: project, hasUI: false, mode: "rpc", ui: { setStatus() {}, notify() {} } };

try {
  mod.default(pi);
  const sqlContext = await handlers.get("before_agent_start")({ prompt: "Implement a stored SQL procedure", systemPrompt: "base" }, ctx);
  assert.equal(sqlContext.message.customType, "coop-standards");
  assert.match(sqlContext.message.content, /Stored procedures/);
  const sqlRecord = sqlContext.message.details.records.find((x) => x.resolution.domain === "sql").resolution;
  assert.equal(sqlRecord.immutable, true); assert.notEqual(sqlRecord.path, sqlRecord.source_path);
  writeFileSync(sqlSource, "# MUTATED AFTER CONTEXT");
  const sqlResult = await tools.get("sql_review").execute("1", { paths: ["query.sql"] }, undefined, undefined, ctx);
  assert.deepEqual(sqlResult.details.standards, sqlRecord);
  assert.deepEqual(sqlResult.details.args.slice(-2), ["--standards", sqlRecord.path]);
  assert.deepEqual(executions.at(-1).optionKeys, ["cwd", "signal"]);
  assert.deepEqual(sqlResult.details.standardsBinding, { owner: "coop", path: sqlRecord.path, sha256: sqlRecord.sha256, revision: sqlRecord.revision });
  assert.equal(sqlResult.details.reportRejected, undefined);
  assert.match(readFileSync(sqlRecord.path, "utf8"), /Schema qualify names/);

  const daxContext = await handlers.get("before_agent_start")({ prompt: "Validate this DAX measure", systemPrompt: "base" }, ctx);
  const daxRecord = daxContext.message.details.records.find((x) => x.resolution.domain === "dax").resolution;
  const daxResult = await tools.get("dax_review").execute("2", { paths: ["measure.dax"] }, undefined, undefined, ctx);
  assert.deepEqual(daxResult.details.standards, daxRecord);
  assert.deepEqual(daxResult.details.args.slice(-2), ["--standards", daxRecord.path]);

  const semantic = await handlers.get("before_agent_start")({ prompt: "Assess semantic model relationships and DAX measures", systemPrompt: "base" }, ctx);
  assert.deepEqual(semantic.message.details.domains, ["semantic_model", "dax"]);
  const semanticDax = semantic.message.details.records.find((x) => x.resolution.domain === "dax").resolution;
  const semanticReview = await tools.get("dax_review").execute("3", { paths: ["model.tmdl"] }, undefined, undefined, ctx);
  assert.deepEqual(semanticReview.details.standards, semanticDax);

  for (const [mode, error] of [["bad_hash", /hash mismatch/], ["bad_path", /path mismatch|cannot be verified/], ["malformed_revision", /revision claim is malformed/], ["missing", /provenance is missing/], ["malformed", /provenance is missing/]]) {
    reportMode = mode;
    const rejected = await tools.get("dax_review").execute("4", { paths: ["measure.dax"] }, undefined, undefined, ctx);
    assert.equal(rejected.details.reportRejected, true, mode);
    assert.match(rejected.details.provenanceError, error, mode);
    assert.equal(rejected.details.stderr, "reviewer diagnostic", mode);
    assert.equal(Object.hasOwn(rejected.details, "report"), false, mode);
  }

  const unrelated = await handlers.get("before_agent_start")({ prompt: "Review this Power Query transformation", systemPrompt: "base" }, ctx);
  assert.equal(unrelated, undefined);
  console.log("  ✓ automatic SQL/DAX/semantic-model context uses immutable reviewer-verified snapshots and rejects mismatches");
} finally {
  rmSync(root, { recursive: true, force: true });
}
