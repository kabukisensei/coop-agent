import assert from "node:assert/strict";
import "../web/public/findings-model.js";

const { build, compare, filter } = globalThis.CoopFindings;
const envelope = {
  schemaVersion: 1, runId: "r1", capabilityId: "coop.review.dax", capabilityVersion: "0.22.0",
  executionStatus: "completed", evidenceStatus: "partial", verdict: "findings",
  coverage: { pbir: { status: "partial", attempted: 2, parsed: 1 } },
  results: {
    summary: { error: 1, warning: 1, info: 0 },
    findings: [
      { rule_id: "DAX-1", severity: "error", file: "Model/a.tmdl", line: 7, object: "[Revenue]", model: "Sales", table: "Fact", measure: "Revenue", snippet: "measure Revenue =", message: "Broken", remediation: "Repair it", standard_ref: "§14", fingerprint: "f1" },
      { ruleId: "DAX-2", severity: "warning", location: { path: "Report/b.json", line: 9 }, note: "Slow", fingerprint: "f2" },
    ],
    agentReview: [{ id: "JUDGE-1", message: "Review naming" }],
  },
  diagnostics: [{ severity: "error", message: "One PBIR file failed" }],
  artifacts: [{ id: "raw-1", kind: "raw-tool-output" }], markdownSummary: null,
};

const model = build(envelope, { toolName: "dax_review" });
assert.equal(model.complete, false);
assert.deepEqual(model.counts, { error: 1, warning: 1, info: 0, total: 2 });
assert.equal(model.findings[1].file, "Report/b.json");
assert.deepEqual(model.findings[0].context, { model: "Sales", table: "Fact", measure: "Revenue" });
assert.equal(model.findings[0].code, "measure Revenue =");
assert.equal(model.findings[0].standardRef, "§14");
assert.equal(model.agentReview[0].kind, "agent-review");
assert.deepEqual(filter(model, { severity: "error" }).visibleFindings.map((item) => item.fingerprint), ["f1"]);
assert.deepEqual(filter(model, { changedOnly: true, changedFiles: new Set(["Report/b.json"]) }).visibleFindings.map((item) => item.fingerprint), ["f2"]);
const delta = compare(model, { ...model, findings: [model.findings[0], { ...model.findings[1], fingerprint: "fixed" }] });
assert.deepEqual(delta.new.map((item) => item.fingerprint), ["f2"]);
assert.deepEqual(delta.persisting.map((item) => item.fingerprint), ["f1"]);
assert.deepEqual(delta.fixed.map((item) => item.fingerprint), ["fixed"]);
assert.equal(build({ schemaVersion: 99 }), null);
console.log("findings model: 13 assertions passed");
