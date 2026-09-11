import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeService, renderKnowledgeMarkdown } from "../lib/knowledge-service.mjs";
import { parseKnowledgeMarkdown } from "../lib/knowledge-index.mjs";

let count = 0;
const test = (name, fn) => {
  fn();
  count++;
  console.log(`  ✓ ${name}`);
};

function teamRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "knowledge.sql.fabric-joins.001",
    title: "Avoid implicit conversion on Fabric joins",
    kind: "antipattern",
    scope: "team",
    sensitivity: "internal",
    status: "proposed",
    confidence: "high",
    tags: ["fabric-warehouse", "sql"],
    appliesTo: ["coop-sql-review"],
    source: { type: "reviewed-incident", references: ["sanitized-incident-42"] },
    createdAt: "2026-09-04T20:00:00.000Z",
    createdBy: "consultant@example.test",
    review: { reviewedAt: null, reviewedBy: null },
    project: { organizationId: null, projectId: null },
    sanitization: { clientData: "none", checkedAt: "2026-09-04T20:30:00.000Z", checkedBy: "sanitizer@example.test" },
    supersedes: null,
    supersededBy: null,
    body: {
      context: "Fabric Warehouse joins.", problem: "Mismatched join-key types.",
      why: "Sources use inconsistent types.", approvedPattern: "Align types at the curated boundary.",
      antiPattern: "Cast every indexed key.", detection: "Inspect schemas and plans.",
      example: "Use one canonical integer type.", exceptions: "Document unavoidable conversions.",
      sources: "Sanitized incident evidence.",
    },
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "coop-knowledge-service-"));
  const stateDir = mkdtempSync(join(tmpdir(), "coop-knowledge-state-"));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
  let id = 0;
  const service = new KnowledgeService({ sources: [{ id: "team-main", scope: "team", root, projectId: null }], stateDir, createId: () => `p${++id}` });
  return { root, stateDir, service };
}

test("renderer-safe proposal preview does not write source", () => {
  const { root, service } = fixture();
  const proposal = service.previewCreate({ sourceId: "team-main", record: teamRecord() });
  assert.equal(proposal.operation, "knowledge.propose");
  assert.equal(proposal.preview.before, null);
  assert.match(proposal.preview.after, /status: proposed/);
  assert.equal(Object.hasOwn(proposal, "targetPath"), false);
  assert.equal(existsSync(join(root, proposal.relativePath)), false);
});

test("creating a proposed source record requires a second explicit approval", () => {
  const { root, service } = fixture();
  const proposal = service.previewCreate({ sourceId: "team-main", record: teamRecord() });
  assert.throws(() => service.apply({ proposalId: proposal.proposalId, approved: false }), /Explicit approval/);
  const result = service.apply({ proposalId: proposal.proposalId, approved: true });
  assert.equal(result.state, "applied");
  assert.equal(result.gitCommitCreated, false);
  assert.equal(parseKnowledgeMarkdown(readFileSync(join(root, proposal.relativePath), "utf8")).status, "proposed");
  assert.match(execFileSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" }), /^\?\?/);
});

test("approval is a previewed human lifecycle change and produces an auditable Git diff", () => {
  const { root, stateDir, service } = fixture();
  const path = join(root, "knowledge.sql.fabric-joins.001.md");
  writeFileSync(path, renderKnowledgeMarkdown(teamRecord()));
  execFileSync("git", ["-C", root, "add", "--", "knowledge.sql.fabric-joins.001.md"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture draft"]);
  const approved = teamRecord({ status: "approved", review: { reviewedAt: "2026-09-04T22:00:00.000Z", reviewedBy: "reviewer@example.test" } });
  const proposal = service.previewTransition({ sourceId: "team-main", recordId: approved.id, record: approved });
  assert.equal(proposal.operation, "knowledge.approve");
  assert.equal(readFileSync(path, "utf8"), proposal.preview.before);
  const result = service.apply({ proposalId: proposal.proposalId, approved: true });
  assert.equal(result.backupId, `${proposal.proposalId}.md`);
  assert.equal(existsSync(join(stateDir, "knowledge-backups", "v1", result.backupId)), true);
  assert.equal(parseKnowledgeMarkdown(readFileSync(path, "utf8")).status, "approved");
  assert.match(execFileSync("git", ["-C", root, "diff", "--", "knowledge.sql.fabric-joins.001.md"], { encoding: "utf8" }), /status: approved/);
});

test("source changes after preview fail stale instead of overwriting", () => {
  const { root, service } = fixture();
  const path = join(root, "knowledge.sql.fabric-joins.001.md");
  writeFileSync(path, renderKnowledgeMarkdown(teamRecord()));
  const approved = teamRecord({ status: "approved", review: { reviewedAt: "2026-09-04T22:00:00.000Z", reviewedBy: "reviewer@example.test" } });
  const proposal = service.previewTransition({ sourceId: "team-main", recordId: approved.id, record: approved });
  writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
  assert.equal(service.apply({ proposalId: proposal.proposalId, approved: true }).state, "stale");
  assert.equal(parseKnowledgeMarkdown(readFileSync(path, "utf8")).status, "proposed");
});

test("supersession requires an existing approved replacement with a back-reference", () => {
  const { root, service } = fixture();
  const current = teamRecord({ status: "approved", review: { reviewedAt: "2026-09-04T21:00:00.000Z", reviewedBy: "reviewer" } });
  writeFileSync(join(root, `${current.id}.md`), renderKnowledgeMarkdown(current));
  const retired = { ...current, status: "superseded", supersededBy: "knowledge.sql.fabric-joins.002", review: { reviewedAt: "2026-09-04T22:00:00.000Z", reviewedBy: "reviewer" } };
  assert.throws(() => service.previewTransition({ sourceId: "team-main", recordId: current.id, record: retired }), /does not exist/);
  const replacement = teamRecord({ id: "knowledge.sql.fabric-joins.002", title: "Replacement join guidance", status: "approved", supersedes: current.id, review: { reviewedAt: "2026-09-04T21:30:00.000Z", reviewedBy: "reviewer" } });
  writeFileSync(join(root, `${replacement.id}.md`), renderKnowledgeMarkdown(replacement));
  assert.equal(service.previewTransition({ sourceId: "team-main", recordId: current.id, record: retired }).operation, "knowledge.supersede");
});

test("scope policy is enforced before a team proposal can exist", () => {
  const { service } = fixture();
  assert.throws(() => service.previewCreate({ sourceId: "team-main", record: teamRecord({ sanitization: { clientData: "present", checkedAt: "2026-09-04T20:30:00.000Z", checkedBy: "reviewer" } }) }), /declare no client data/);
});

test("catalog and search expose current guidance plus source provenance", () => {
  const { root, service } = fixture();
  const approved = teamRecord({ status: "approved", review: { reviewedAt: "2026-09-04T22:00:00.000Z", reviewedBy: "reviewer@example.test" } });
  writeFileSync(join(root, `${approved.id}.md`), renderKnowledgeMarkdown(approved));
  assert.equal(service.catalog().records[0].record.status, "approved");
  assert.deepEqual(service.search("implicit conversion").map((item) => item.id), [approved.id]);
  assert.equal(service.search("implicit conversion")[0].sourceId, "team-main");
});

console.log(`knowledge service: ${count} tests passed`);
