import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console });
context.globalThis = context;
vm.runInContext(readFileSync(join(ROOT, "web", "public", "knowledge-model.js"), "utf8"), context);
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };

const base = {
  schemaVersion: 1,
  status: "partial",
  coverage: { attempted: 3, parsed: 3, approved: 1, ignored: 2, failed: 1, complete: false },
  sources: [{ id: "team-main", scope: "team", projectId: null }],
  diagnostics: [{ code: "duplicate-id", message: "conflict", sourceId: "team-main", relativePath: "duplicate.md" }],
  records: [
    { id: "knowledge.sql.current.001", title: "Current SQL pattern", scope: "team", kind: "pattern", confidence: "high", tags: ["sql"], appliesTo: ["coop-sql-review"], sourceId: "team-main", relativePath: "current.md", record: { status: "approved", sensitivity: "internal", review: { reviewedAt: "2025-01-01T00:00:00.000Z", reviewedBy: "reviewer" } } },
    { id: "knowledge.sql.draft.001", title: "Draft SQL pattern", scope: "team", kind: "pattern", confidence: "medium", tags: ["sql"], appliesTo: [], sourceId: "team-main", relativePath: "draft.md", record: { status: "proposed", sensitivity: "internal", review: { reviewedAt: null, reviewedBy: null } } },
    { id: "knowledge.sql.old.001", title: "Old SQL pattern", scope: "team", kind: "pattern", confidence: "low", tags: ["sql"], appliesTo: [], sourceId: "team-main", relativePath: "old.md", record: { status: "superseded", sensitivity: "internal", review: { reviewedAt: "2024-01-01T00:00:00.000Z", reviewedBy: "reviewer" } } },
  ],
};

test("projection keeps current guidance, history, completeness, and diagnostics distinct", () => {
  const model = context.CoopKnowledge.build(JSON.parse(JSON.stringify(base)), { now: Date.parse("2026-09-04T00:00:00.000Z") });
  assert.equal(model.complete, false);
  assert.deepEqual(model.current.map((row) => row.id), ["knowledge.sql.current.001"]);
  assert.deepEqual(Array.from(model.history, (row) => row.status).sort(), ["proposed", "superseded"]);
  assert.equal(model.diagnostics[0].code, "duplicate-id");
  assert.equal(model.current[0].stale, true);
});

test("only proposed records expose approve/reject and only current records can be used", () => {
  const model = context.CoopKnowledge.build(JSON.parse(JSON.stringify(base)));
  const draft = model.rows.find((row) => row.status === "proposed");
  assert.equal(draft.canApprove, true);
  assert.equal(draft.canUse, false);
  assert.throws(() => context.CoopKnowledge.usePrompt(draft), /Only approved/);
  assert.match(context.CoopKnowledge.usePrompt(model.current[0]), /cite it by ID\/path/);
});

test("filtering is scope/status aware and does not hide source provenance", () => {
  const model = context.CoopKnowledge.build(JSON.parse(JSON.stringify(base)));
  const rows = context.CoopKnowledge.filter(model, { query: "draft", scopes: ["team"], statuses: ["proposed"] });
  assert.deepEqual(Array.from(rows, (row) => row.id), ["knowledge.sql.draft.001"]);
  assert.equal(rows[0].sourceId, "team-main");
});

console.log(`knowledge model: ${count} tests passed`);
