import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { normalizeImpactAnalysis } from "../web/impact-analysis.mjs";
import { buildExecutionEnvelope } from "../web/execution-envelope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "impact", "impact-analysis-v1.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(ROOT, "config", "impact-analysis.schema.json"), "utf8"));
const context = vm.createContext({ console });
context.globalThis = context;
vm.runInContext(readFileSync(join(ROOT, "web", "public", "impact-model.js"), "utf8"), context);
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };

test("checked-in impact artifact schema is versioned and evidence-aware", () => {
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.evidenceStatus.enum, ["complete", "partial", "failed", "not-applicable"]);
  assert.deepEqual(schema.$defs.evidenceSource.properties.kind.enum, ["data-doc", "fabric", "powerbi", "source", "microsoft-learn", "agent-inference"]);
});

test("the existing skill remains the reasoning owner and publishes through the advisory tool", () => {
  const skill = readFileSync(join(ROOT, "skills", "power-bi-impact-analysis", "SKILL.md"), "utf8");
  const prompt = readFileSync(join(ROOT, "prompts", "impact-analysis.md"), "utf8");
  const tools = readFileSync(join(ROOT, "extensions", "coop-tools", "index.ts"), "utf8");
  assert.match(skill, /Run inside the `coop-workflow` skill/);
  assert.match(skill, /calling `impact_analysis_result`/);
  assert.match(prompt, /focused lineage/);
  assert.match(tools, /name: "impact_analysis_result"/);
  assert.match(tools, /normalizeImpactAnalysis/);
});

test("normalizer preserves attributable paths, risk, gaps, and approval state", () => {
  const result = normalizeImpactAnalysis(fixture);
  assert.equal(result.analysisId, "impact-sales-margin-1");
  assert.equal(result.paths[1].evidenceSourceIds.join(","), "data-doc-1,pbi-1");
  assert.equal(result.impacts.reports[0].classification, "breaking");
  assert.equal(result.evidenceGaps[0].id, "gap-apps");
  assert.equal(result.risk.level, "high");
  assert.deepEqual(result.approval, { required: true, status: "pending" });
});

test("complete claims are downgraded when sources or gaps are partial", () => {
  const result = normalizeImpactAnalysis({ ...fixture, evidenceStatus: "complete" });
  assert.equal(result.evidenceStatus, "partial");
});

test("unknown evidence references and oversized artifacts fail closed", () => {
  const bad = structuredClone(fixture);
  bad.paths[0].evidenceSourceIds = ["missing-source"];
  assert.throws(() => normalizeImpactAnalysis(bad), /unknown evidence source/);
  assert.throws(() => normalizeImpactAnalysis({ ...fixture, plan: { ...fixture.plan, summary: "x".repeat(600_000) } }), /512 KiB/);
  assert.throws(() => normalizeImpactAnalysis({ ...fixture, evidenceSources: [] }), /at least one evidence source/);
  assert.throws(() => normalizeImpactAnalysis({ ...fixture, approval: { required: false, status: "pending" } }), /must be not-required/);
});

test("execution envelope carries the typed artifact and preserves raw fallback", () => {
  const report = normalizeImpactAnalysis(fixture);
  const envelope = buildExecutionEnvelope({
    toolName: "impact_analysis_result",
    isError: false,
    result: { content: [{ type: "text", text: "Impact ready." }], details: { version: "1", report } },
  }, { runId: "impact-run-1", artifactId: "impact-raw-1" });
  assert.equal(envelope.capabilityId, "coop.impact.guided");
  assert.equal(envelope.evidenceStatus, "partial");
  assert.equal(envelope.results.data.risk.level, "high");
  assert.deepEqual(envelope.artifacts, [{ id: "impact-raw-1", kind: "raw-tool-output", mediaType: "application/json" }]);
});

test("browser projection keeps observed evidence separate from inference", () => {
  const report = normalizeImpactAnalysis(fixture);
  const envelope = buildExecutionEnvelope({ toolName: "impact_analysis_result", isError: false, result: { details: { version: "1", report } } }, { runId: "impact-run-2", artifactId: "impact-raw-2" });
  const model = context.CoopImpact.build(JSON.parse(JSON.stringify(envelope)));
  assert.equal(model.complete, false);
  assert.equal(model.paths[0].evidence[0].kind, "data-doc");
  assert.equal(model.impacts.consumers[0].evidence[0].kind, "agent-inference");
  assert.equal(model.plan.steps.length, 2);
});

test("guided prompt captures permissions and requires the existing skill/tool contract", () => {
  const prompt = context.CoopImpact.guidedPrompt({
    target: "Sales[Margin]",
    changeIntent: "redefine",
    intendedOutcome: "Exclude internal transfers",
    environment: "QE Dev",
    deploymentScope: "development",
    refreshLineage: false,
    allowLiveReads: true,
  });
  assert.match(prompt, /power-bi-impact-analysis skill under coop-workflow/);
  assert.match(prompt, /Live Fabric\/Power BI reads permitted: yes, read-only/);
  assert.match(prompt, /Refresh Data Doc graph if needed: no/);
  assert.match(prompt, /calling impact_analysis_result/);
  assert.match(prompt, /Do not edit source/);
});

console.log(`guided impact analysis contracts: ${count} tests passed`);
