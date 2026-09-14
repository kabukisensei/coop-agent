import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const root = mkdtempSync(join(tmpdir(), "coop-std-runtime-"));
process.env.COOP_STANDARDS_SNAPSHOT_ROOT = join(root, "snapshots");
process.env.COOP_STANDARDS_STATE = join(root, "status.json");
const maliciousRegistry = join(root, "malicious-registry.json");
writeFileSync(maliciousRegistry, JSON.stringify({ schema_version: 1, canonical: { repository: "https://attacker.invalid/standards.git", authoritative_branch: "main", manifest: "standards.yml", freshness_seconds: 1, timeout_seconds: 1, domains: {} } }));
process.env.COOP_STANDARDS_REGISTRY = maliciousRegistry;
writeFileSync(process.env.COOP_STANDARDS_STATE, JSON.stringify({ ok: true, last_successful_check_ms: Date.now(), last_successful_sync_ms: Date.now(), revision: "fixture" }));
const mod = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const project = join(root, "project");
mkdirSync(join(project, ".coop"), { recursive: true });
mkdirSync(join(project, "standards"));
const sqlSource = join(project, "standards", "sql.md");
writeFileSync(sqlSource, "# SQL\n## Stored procedures\nSchema qualify names.\n");
writeFileSync(join(project, "standards", "dax.md"), "# DAX\n## Measures\nUse explicit measures.\n");
writeFileSync(join(project, "standards", "semantic-model.md"), "# Semantic Model\n## Relationships\nUse one-to-many relationships.\n");
writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: standards/sql.md\n  dax: standards/dax.md\n  semantic_model: standards/semantic-model.md\nrepositories:\n  source:\n    local_path: .\n");

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
    const reviewDomain = String(bin).includes("dax") ? "dax" : "sql";
    const stdout = reportMode === "malformed" ? "not-json" : JSON.stringify({ tool: `coop-${reviewDomain}-review`, schema_version: reviewDomain === "dax" ? 3 : 4, version: "test", [reviewDomain === "dax" ? "models_checked" : "files_checked"]: 0, standards: reportMode === "missing" ? undefined : standards, findings: [], diagnostics: [], agent_review: [], summary: { error: 0, warning: 0, info: 0 }, verdict: { clean: true, highest_severity: null } });
    return { stdout, stderr: "reviewer diagnostic", code: 0 };
  },
};
const ctx = { cwd: project, hasUI: false, mode: "rpc", ui: { setStatus() {}, notify() {} } };

try {
  mod.default(pi);
  const sqlContext = await handlers.get("before_agent_start")({ prompt: "Implement a stored SQL procedure", systemPrompt: "base" }, ctx);
  assert.equal(sqlContext.message.customType, "coop-standards");
  assert.match(sqlContext.message.content, /Stored procedures/);
  assert.equal(sqlContext.message.details.domains.join("|"), "sql");
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
  assert.match(daxContext.message.content, /explicit measures/);
  const daxResult = await tools.get("dax_review").execute("2", { paths: ["measure.dax"] }, undefined, undefined, ctx);
  assert.deepEqual(daxResult.details.standards, daxRecord);
  assert.deepEqual(daxResult.details.args.slice(-2), ["--standards", daxRecord.path]);

  const semantic = await handlers.get("before_agent_start")({ prompt: "Assess semantic model relationships", systemPrompt: "base" }, ctx);
  assert.deepEqual(semantic.message.details.domains, ["semantic_model", "dax"]);
  assert.match(semantic.message.content, /one-to-many relationships/);
  assert.match(semantic.message.content, /explicit measures/);
  const semanticModel = semantic.message.details.records.find((x) => x.resolution.domain === "semantic_model").resolution;
  const semanticDax = semantic.message.details.records.find((x) => x.resolution.domain === "dax").resolution;
  assert.equal(semanticModel.immutable, true); assert.equal(semanticDax.immutable, true);
  const semanticReview = await tools.get("dax_review").execute("3", { paths: ["model.tmdl"] }, undefined, undefined, ctx);
  assert.deepEqual(semanticReview.details.standards, semanticDax);
  assert.deepEqual(semanticReview.details.args.slice(-2), ["--standards", semanticDax.path]);

  // The prompts above intentionally never mention standards. Optional TeamAI
  // presence/configuration must not affect the normal Terminal standards path.
  const baselineWithoutTeamAi = await handlers.get("before_agent_start")({ prompt: "Check this SQL query", systemPrompt: "base" }, ctx);
  const baselineSql = baselineWithoutTeamAi.message.details.records.find((x) => x.resolution.domain === "sql").resolution;
  const fakeBin = join(root, "fake-teamai"), sentinel = join(fakeBin, "invoked"); mkdirSync(fakeBin);
  const fakeTeamAi = join(fakeBin, "teamai"); writeFileSync(fakeTeamAi, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\n`); chmodSync(fakeTeamAi, 0o755);
  const coopHome = join(root, "coop-home"); mkdirSync(join(coopHome, ".coop"), { recursive: true });
  writeFileSync(join(coopHome, ".coop", "config"), JSON.stringify({ knowledge: { enabled: false, repos: [] } }));
  const savedPath = process.env.PATH, savedCoopDir = process.env.COOP_DIR;
  process.env.PATH = `${fakeBin}:${savedPath}`; process.env.COOP_DIR = coopHome;
  const withoutTeamAi = await handlers.get("before_agent_start")({ prompt: "Check this SQL query", systemPrompt: "base" }, ctx);
  process.env.PATH = savedPath;
  if (savedCoopDir === undefined) delete process.env.COOP_DIR; else process.env.COOP_DIR = savedCoopDir;
  const independentSql = withoutTeamAi.message.details.records.find((x) => x.resolution.domain === "sql").resolution;
  assert.equal(independentSql.revision, baselineSql.revision); assert.equal(independentSql.sha256, baselineSql.sha256); assert.equal(independentSql.path, baselineSql.path);
  assert.equal(existsSync(sentinel), false, "standards path invoked TeamAI");

  for (const [mode, error] of [["bad_hash", /hash mismatch/], ["bad_path", /path mismatch|cannot be verified/], ["malformed_revision", /revision claim is malformed|provenance schema is invalid/], ["missing", /provenance is missing|unknown or missing fields/], ["malformed", /envelope is missing|provenance is missing/]]) {
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
