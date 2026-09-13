import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KNOWLEDGE_RECORD_MAX_BYTES,
  KNOWLEDGE_RECORD_SCHEMA_VERSION,
  authorizeKnowledgeTransition,
  validateKnowledgeRecord,
} from "../lib/knowledge-policy.mjs";

let count = 0;
const test = (name, fn) => {
  fn();
  count++;
  console.log(`  ✓ ${name}`);
};

function projectRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "knowledge.sql.join-keys.001",
    title: "Use matching types for warehouse join keys",
    kind: "antipattern",
    scope: "project",
    sensitivity: "client-confidential",
    status: "proposed",
    confidence: "high",
    tags: ["sql", "fabric-warehouse"],
    appliesTo: ["coop-sql-review"],
    source: { type: "reviewed-incident", references: ["project-incident-42"] },
    createdAt: "2026-09-04T20:00:00.000Z",
    createdBy: "consultant@example.test",
    review: { reviewedAt: null, reviewedBy: null },
    project: { organizationId: "client-org", projectId: "client-project" },
    sanitization: { clientData: "present", checkedAt: null, checkedBy: null },
    supersedes: null,
    supersededBy: null,
    body: {
      context: "Warehouse joins in this project.",
      problem: "Join keys use mismatched types.",
      why: "Implicit conversion impairs plans.",
      approvedPattern: "Align key types before joining.",
      antiPattern: "Casting the indexed side in every join.",
      detection: "Review join predicates and schemas.",
      example: "Use the canonical warehouse key type.",
      exceptions: "Document any unavoidable source-boundary conversion.",
      sources: "Project incident and review evidence.",
    },
    ...overrides,
  };
}

function teamRecord(overrides = {}) {
  return projectRecord({
    id: "knowledge.sql.fabric-implicit-conversion.001",
    scope: "team",
    sensitivity: "internal",
    source: { type: "reviewed-incident", references: ["sanitized-lesson-42"] },
    project: { organizationId: null, projectId: null },
    sanitization: { clientData: "none", checkedAt: "2026-09-04T20:30:00.000Z", checkedBy: "reviewer@example.test" },
    ...overrides,
  });
}

test("project and sanitized team records preserve mandatory provenance and scope", () => {
  assert.equal(validateKnowledgeRecord(projectRecord()).scope, "project");
  assert.equal(validateKnowledgeRecord(teamRecord()).scope, "team");
});

test("private memory cannot masquerade as a Git-backed shared record", () => {
  assert.throws(() => validateKnowledgeRecord(projectRecord({ scope: "private" })), /private memory/);
});

test("client data and client identifiers cannot target team-general storage", () => {
  assert.throws(() => validateKnowledgeRecord(teamRecord({ sanitization: { clientData: "present", checkedAt: "2026-09-04T20:30:00.000Z", checkedBy: "reviewer" } })), /declare no client data/);
  assert.throws(() => validateKnowledgeRecord(teamRecord({ project: { organizationId: "client-org", projectId: null } })), /cannot carry client or project identifiers/);
  assert.throws(() => validateKnowledgeRecord(teamRecord({ sensitivity: "client-confidential" })), /must be internal/);
});

test("team records require an attributable sanitization check before draft storage", () => {
  assert.throws(() => validateKnowledgeRecord(teamRecord({ sanitization: { clientData: "none", checkedAt: null, checkedBy: null } })), /sanitization review/);
  assert.throws(() => validateKnowledgeRecord(teamRecord({ sanitization: { clientData: "none", checkedAt: "2026-09-04T20:30:00.000Z", checkedBy: null } })), /set together/);
});

test("approved and retired states require attributable human review metadata", () => {
  assert.throws(() => validateKnowledgeRecord(teamRecord({ status: "approved" })), /human review/);
  assert.throws(() => validateKnowledgeRecord(teamRecord({ status: "rejected" })), /human review/);
  const approved = teamRecord({ status: "approved", review: { reviewedAt: "2026-09-04T21:00:00.000Z", reviewedBy: "reviewer@example.test" } });
  assert.equal(validateKnowledgeRecord(approved).status, "approved");
});

test("lifecycle and scope transitions require an explicit human action", () => {
  const draft = teamRecord();
  const approved = teamRecord({ status: "approved", review: { reviewedAt: "2026-09-04T21:00:00.000Z", reviewedBy: "reviewer@example.test" } });
  assert.throws(() => authorizeKnowledgeTransition(draft, approved, { actorType: "agent" }), /human action/);
  assert.equal(authorizeKnowledgeTransition(draft, approved, { actorType: "human" }).status, "approved");
  assert.throws(() => authorizeKnowledgeTransition(draft, projectRecord({ id: draft.id }), { actorType: "human" }), /scope is immutable/);
  assert.throws(() => authorizeKnowledgeTransition(approved, draft, { actorType: "human" }), /cannot transition/);
});

test("supersession is attributable, directional, and cannot target itself", () => {
  const approved = teamRecord({ status: "approved", review: { reviewedAt: "2026-09-04T21:00:00.000Z", reviewedBy: "reviewer@example.test" } });
  const superseded = teamRecord({ status: "superseded", supersededBy: "knowledge.sql.fabric-implicit-conversion.002", review: { reviewedAt: "2026-09-04T22:00:00.000Z", reviewedBy: "reviewer@example.test" } });
  assert.equal(authorizeKnowledgeTransition(approved, superseded, { actorType: "human" }).supersededBy, "knowledge.sql.fabric-implicit-conversion.002");
  assert.throws(() => validateKnowledgeRecord(teamRecord({ status: "superseded", supersededBy: null, review: { reviewedAt: "2026-09-04T22:00:00.000Z", reviewedBy: "reviewer" } })), /replacement/);
  assert.throws(() => validateKnowledgeRecord(teamRecord({ supersedes: "knowledge.sql.fabric-implicit-conversion.001" })), /supersede itself/);
});

test("the contract rejects unknown fields and oversized records", () => {
  assert.throws(() => validateKnowledgeRecord({ ...teamRecord(), rendererCallback: "run-me" }), /unsupported field/);
  const oversized = teamRecord({ body: { ...teamRecord().body, example: "x".repeat(KNOWLEDGE_RECORD_MAX_BYTES) } });
  assert.throws(() => validateKnowledgeRecord(oversized), /128 KiB/);
});

test("checked-in schema pins mandatory governance fields and vocabularies", () => {
  const schema = JSON.parse(readFileSync(new URL("../config/knowledge-record.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, KNOWLEDGE_RECORD_SCHEMA_VERSION);
  for (const field of ["scope", "sensitivity", "status", "source", "review", "sanitization"]) assert.ok(schema.required.includes(field));
  assert.deepEqual(schema.properties.scope.enum, ["project", "team"]);
  assert.deepEqual(schema.properties.status.enum, ["proposed", "approved", "rejected", "deprecated", "superseded"]);
});

console.log(`knowledge policy: ${count} tests passed`);
