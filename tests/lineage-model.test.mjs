import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildExecutionEnvelope } from "../web/execution-envelope.mjs";
import "../web/public/lineage-model.js";

const data = JSON.parse(await readFile(new URL("fixtures/lineage/focused-lineage-v1.json", import.meta.url), "utf8"));
const event = {
  toolName: "data_doc",
  isError: false,
  result: { content: [{ type: "text", text: "Focused lineage ready" }], details: { lineage: data } },
};
const envelope = buildExecutionEnvelope(event, { runId: "lineage-run", artifactId: "lineage-raw" });
const model = globalThis.CoopLineage.build(envelope);

assert.equal(envelope.capabilityId, "coop.lineage.explorer");
assert.equal(envelope.evidenceStatus, "partial");
assert.equal(model.complete, false);
assert.equal(model.focus.id, data.object.id);
assert.deepEqual(model.upstream.map((item) => item.id), data.upstream.map((item) => item.id));
assert.deepEqual(model.downstream.map((item) => item.id), data.downstream.map((item) => item.id));
assert.deepEqual(model.edges.map((item) => item.evidence), data.edges.map((item) => item.evidence));
assert.deepEqual(model.edges.map((item) => [item.upstreamId, item.downstreamId]), data.edges.map((item) => [item.flow.upstream_id, item.flow.downstream_id]));
assert.deepEqual(model.relationships, data.relationships);
assert.deepEqual(model.coverage, data.coverage);
assert.deepEqual(model.diagnostics, data.diagnostics);
assert.equal(model.danglingEdges.length, 0);
assert.equal(globalThis.CoopLineage.search(model, "semanticmodel").length, 1);
assert.equal(globalThis.CoopLineage.search(model, "gold").length, 2);
assert.equal(model.artifacts[0].id, "lineage-raw");
assert.equal(model.raw, envelope);

const ambiguousEnvelope = {
  ...envelope,
  evidenceStatus: "complete",
  results: { ...envelope.results, data: { schema_version: 1, query: "fact_sales", ambiguous: true, matches: [data.object, data.downstream[0]] } },
};
const ambiguous = globalThis.CoopLineage.build(ambiguousEnvelope);
assert.equal(ambiguous.ambiguous, true);
assert.equal(ambiguous.complete, false);
assert.deepEqual(ambiguous.matches.map((item) => item.id), [data.object.id, data.downstream[0].id]);
assert.equal(globalThis.CoopLineage.build({ ...envelope, capabilityId: "coop.review.sql" }), null);

console.log("lineage model: 20 assertions passed");
