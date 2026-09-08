import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildExecutionEnvelope } from "../web/execution-envelope.mjs";
import "../web/public/findings-model.js";

const fixtureUrl = (name) => new URL(`fixtures/findings/${name}`, import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(fixtureUrl(name), "utf8"));
const { build } = globalThis.CoopFindings;

function projectReport(report, toolName, runId) {
  const envelope = buildExecutionEnvelope({
    toolName,
    isError: false,
    result: { content: [{ type: "text", text: `${report.tool} completed` }], details: { report } },
  }, { runId, artifactId: `artifact-${runId}` });
  return { envelope, model: build(envelope, { toolName }) };
}

function stableFinding(item) {
  return {
    rule_id: item.ruleId,
    severity: item.severity,
    file: item.file,
    line: item.line,
    object: item.object,
    message: item.message,
    standard_ref: item.standardRef,
    fingerprint: item.fingerprint,
  };
}

function stableSource(item) {
  return {
    rule_id: item.rule_id,
    severity: item.severity || "info",
    file: item.file,
    line: item.line,
    object: item.object,
    message: item.message || item.note,
    standard_ref: item.standard_ref,
    fingerprint: item.fingerprint,
  };
}

const sql = await readJson("sql-review-0.15.2.json");
const sqlProjection = projectReport(sql, "sql_review", "sql-golden");
assert.equal(sqlProjection.envelope.capabilityId, "coop.review.sql");
assert.equal(sqlProjection.envelope.capabilityVersion, "0.15.2");
assert.equal(sqlProjection.envelope.evidenceStatus, "complete");
assert.equal(sqlProjection.model.counts.total, sql.findings.length);
assert.deepEqual(sqlProjection.model.counts, { error: 0, warning: 1, info: 0, total: 1 });
assert.deepEqual(sqlProjection.model.findings.map(stableFinding), sql.findings.map(stableSource));
assert.deepEqual(sqlProjection.model.agentReview, []);
assert.equal(sqlProjection.model.artifacts[0].id, "artifact-sql-golden");

const dax = await readJson("dax-review-0.22.0.json");
const daxProjection = projectReport(dax, "dax_review", "dax-golden");
assert.equal(daxProjection.envelope.capabilityId, "coop.review.dax");
assert.equal(daxProjection.envelope.capabilityVersion, "0.22.0");
assert.equal(daxProjection.envelope.evidenceStatus, "complete");
assert.equal(daxProjection.model.counts.total, dax.findings.length);
assert.deepEqual(daxProjection.model.counts, { error: 0, warning: 4, info: 1, total: 5 });
assert.deepEqual(daxProjection.model.findings.map(stableFinding), dax.findings.map(stableSource));
assert.equal(daxProjection.model.agentReview.length, dax.agent_review.length);
assert.deepEqual(stableFinding(daxProjection.model.agentReview[0]), stableSource(dax.agent_review[0]));
assert.equal(daxProjection.model.agentReview[0].kind, "agent-review");
assert.equal(daxProjection.model.artifacts[0].id, "artifact-dax-golden");

const bpa = await readJson("bpa-review-v1.json");
const bpaProjection = projectReport(bpa, "bpa_review", "bpa-golden");
assert.equal(bpaProjection.envelope.capabilityId, "coop.review.bpa");
assert.equal(bpaProjection.envelope.evidenceStatus, "complete");
assert.deepEqual(bpaProjection.model.counts, { error: 0, warning: 0, info: 1, total: 1 });
assert.equal(bpaProjection.model.findings[0].ruleId, bpa.findings[0].rule);
assert.equal(bpaProjection.model.findings[0].object, "Revenue");
assert.equal(bpaProjection.model.artifacts[0].id, "artifact-bpa-golden");

// Keep the fixture source paths reviewable and platform-neutral. These reports
// were captured from the pinned CLIs with:
//   coop-sql-review check tests/fixtures/findings/select-star.sql --format json
//   coop-dax-review check tests/fixtures/findings/legacy.bim --format json
assert.equal(fileURLToPath(fixtureUrl("select-star.sql")).endsWith(join("tests", "fixtures", "findings", "select-star.sql")), true);
assert.equal(fileURLToPath(fixtureUrl("legacy.bim")).endsWith(join("tests", "fixtures", "findings", "legacy.bim")), true);

console.log("findings golden parity: 25 assertions passed");
