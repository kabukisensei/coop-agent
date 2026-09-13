import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const mod = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const root = mkdtempSync(join(tmpdir(), "coop-std-runtime-"));
const project = join(root, "project");
mkdirSync(join(project, ".coop"), { recursive: true });
mkdirSync(join(project, "standards"));
writeFileSync(join(project, "standards", "sql.md"), "# SQL\n## Stored procedures\nSchema qualify names.\n");
writeFileSync(join(project, "standards", "dax.md"), "# DAX\n## Measures\nUse explicit measures.\n");
writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: standards/sql.md\n  dax: standards/dax.md\nrepositories:\n  source:\n    local_path: .\n");

const handlers = new Map();
const tools = new Map();
const executions = [];
const pi = {
  on(name, fn) { handlers.set(name, fn); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {},
  sendUserMessage() {},
  async exec(bin, args) { executions.push({ bin, args }); return { stdout: '{"findings":[]}', stderr: "", code: 0 }; },
};
const ctx = { cwd: project, hasUI: false, mode: "rpc", ui: { setStatus() {}, notify() {} } };

try {
  mod.default(pi);
  const sqlContext = await handlers.get("before_agent_start")({ prompt: "Write a stored procedure", systemPrompt: "base" }, ctx);
  assert.equal(sqlContext.message.customType, "coop-standards");
  assert.match(sqlContext.message.content, /Stored procedures/);
  const sqlRecord = sqlContext.message.details.records.find((x) => x.resolution.domain === "sql").resolution;
  const sqlResult = await tools.get("sql_review").execute("1", { paths: ["query.sql"] }, undefined, undefined, ctx);
  assert.deepEqual(sqlResult.details.standards, sqlRecord);
  assert.deepEqual(sqlResult.details.args.slice(-2), ["--standards", sqlRecord.path]);

  const daxContext = await handlers.get("before_agent_start")({ prompt: "Repair this DAX measure", systemPrompt: "base" }, ctx);
  const daxRecord = daxContext.message.details.records.find((x) => x.resolution.domain === "dax").resolution;
  const daxResult = await tools.get("dax_review").execute("2", { paths: ["measure.dax"] }, undefined, undefined, ctx);
  assert.deepEqual(daxResult.details.standards, daxRecord);
  assert.deepEqual(daxResult.details.args.slice(-2), ["--standards", daxRecord.path]);

  const unrelated = await handlers.get("before_agent_start")({ prompt: "What time is the meeting?", systemPrompt: "base" }, ctx);
  assert.equal(unrelated, undefined);
  console.log("  ✓ automatic prompt context and native SQL/DAX reviewer same-source runtime wiring");
} finally {
  rmSync(root, { recursive: true, force: true });
}
