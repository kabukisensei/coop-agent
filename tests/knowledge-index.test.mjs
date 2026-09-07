import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnowledgeIndex, knowledgeIndexDigest, parseKnowledgeMarkdown, searchKnowledgeIndex } from "../lib/knowledge-index.mjs";

let count = 0;
const test = (name, fn) => {
  fn();
  count++;
  console.log(`  ✓ ${name}`);
};

function repo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

function markdown({ id = "knowledge.sql.fabric-joins.001", scope = "team", status = "approved", projectId = null, title = "Avoid implicit conversion on Fabric joins" } = {}) {
  const team = scope === "team";
  return `---
schemaVersion: 1
id: ${id}
title: ${title}
kind: antipattern
scope: ${scope}
sensitivity: ${team ? "internal" : "client-confidential"}
status: ${status}
confidence: high
tags: ["fabric-warehouse", "sql"]
appliesTo: ["coop-sql-review", "stored-procedures"]
source:
  type: reviewed-incident
  references:
    - sanitized-incident-42
createdAt: 2026-09-04T20:00:00.000Z
createdBy: consultant@example.test
review:
  reviewedAt: 2026-09-04T21:00:00.000Z
  reviewedBy: reviewer@example.test
project:
  organizationId: ${team ? "null" : "client-org"}
  projectId: ${projectId || "null"}
sanitization:
  clientData: ${team ? "none" : "present"}
  checkedAt: ${team ? "2026-09-04T20:30:00.000Z" : "null"}
  checkedBy: ${team ? "reviewer@example.test" : "null"}
supersedes: null
supersededBy: null
---
## Context

Fabric Warehouse joins across curated tables.

## Problem

Mismatched join-key types cause conversion.

## Why it happens

Sources use inconsistent key types.

## Approved pattern

Align key types at the curated boundary.

## Anti-pattern

Cast the indexed side in every join.

## Detection method

Inspect schemas and execution plans.

## Example

Use one canonical integer key type.

## Exceptions

Document unavoidable boundary conversion.

## Sources

Sanitized incident evidence.
`;
}

test("strict Markdown/YAML parsing produces the governed normalized record", () => {
  const record = parseKnowledgeMarkdown(markdown());
  assert.equal(record.id, "knowledge.sql.fabric-joins.001");
  assert.deepEqual(record.tags, ["fabric-warehouse", "sql"]);
  assert.match(record.body.approvedPattern, /Align key types/);
});

test("only approved records enter the disposable index", () => {
  const root = repo("coop-knw-team-");
  writeFileSync(join(root, "approved.md"), markdown());
  writeFileSync(join(root, "draft.md"), markdown({ id: "knowledge.sql.draft.001", status: "proposed" }).replace("reviewedAt: 2026-09-04T21:00:00.000Z", "reviewedAt: null").replace("reviewedBy: reviewer@example.test", "reviewedBy: null"));
  const index = buildKnowledgeIndex([{ id: "team-main", scope: "team", root, projectId: null }]);
  assert.equal(index.status, "complete");
  assert.deepEqual(index.records.map((item) => item.id), ["knowledge.sql.fabric-joins.001"]);
  assert.deepEqual(index.coverage, { attempted: 2, parsed: 2, approved: 1, ignored: 1, failed: 0, complete: true });
});

test("configured source scope and project identity are enforced", () => {
  const root = repo("coop-knw-project-");
  writeFileSync(join(root, "wrong.md"), markdown());
  writeFileSync(join(root, "right.md"), markdown({ id: "knowledge.project.keys.001", scope: "project", projectId: "project-a", title: "Project key convention" }));
  const index = buildKnowledgeIndex([{ id: "project-a", scope: "project", root, projectId: "project-a" }]);
  assert.equal(index.status, "partial");
  assert.deepEqual(index.records.map((item) => item.id), ["knowledge.project.keys.001"]);
  assert.equal(index.diagnostics[0].code, "record-invalid");
});

test("invalid files are diagnostic and cannot produce a clean index", () => {
  const root = repo("coop-knw-invalid-");
  writeFileSync(join(root, "bad.md"), "# not a record\n");
  const index = buildKnowledgeIndex([{ id: "team-main", scope: "team", root, projectId: null }]);
  assert.equal(index.status, "failed");
  assert.equal(index.coverage.complete, false);
  assert.equal(index.diagnostics[0].relativePath, "bad.md");
});

test("a configured source must be Git-backed", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-knw-not-git-"));
  assert.throws(() => buildKnowledgeIndex([{ id: "team-main", scope: "team", root, projectId: null }]), /Git repository/);
});

test("duplicate approved IDs are all withheld rather than silently selected", () => {
  const root = repo("coop-knw-duplicate-");
  writeFileSync(join(root, "one.md"), markdown());
  writeFileSync(join(root, "two.md"), markdown({ title: "Conflicting title" }));
  const index = buildKnowledgeIndex([{ id: "team-main", scope: "team", root, projectId: null }]);
  assert.equal(index.status, "failed");
  assert.equal(index.records.length, 0);
  assert.equal(index.diagnostics.filter((item) => item.code === "duplicate-id").length, 2);
});

test("symlinks and hidden control directories are not indexed", () => {
  const root = repo("coop-knw-jail-");
  const outside = mkdtempSync(join(tmpdir(), "coop-knw-outside-"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, ".hidden", "hidden.md"), markdown({ id: "knowledge.hidden.001" }));
  writeFileSync(join(outside, "outside.md"), markdown({ id: "knowledge.outside.001" }));
  try { symlinkSync(join(outside, "outside.md"), join(root, "escape.md")); } catch { /* Windows may deny symlink creation. */ }
  const index = buildKnowledgeIndex([{ id: "team-main", scope: "team", root, projectId: null }]);
  assert.equal(index.coverage.attempted, 0);
  assert.equal(index.records.length, 0);
});

test("search is deterministic, scope-aware, bounded, and provenance-preserving", () => {
  const teamRoot = repo("coop-knw-search-team-");
  const projectRoot = repo("coop-knw-search-project-");
  writeFileSync(join(teamRoot, "joins.md"), markdown());
  writeFileSync(join(projectRoot, "keys.md"), markdown({ id: "knowledge.project.keys.001", scope: "project", projectId: "project-a", title: "Client warehouse join keys" }));
  const sources = [
    { id: "team-main", scope: "team", root: teamRoot, projectId: null },
    { id: "project-a", scope: "project", root: projectRoot, projectId: "project-a" },
  ];
  const first = buildKnowledgeIndex(sources);
  const second = buildKnowledgeIndex([...sources].reverse());
  assert.equal(knowledgeIndexDigest(first), knowledgeIndexDigest(second));
  assert.deepEqual(searchKnowledgeIndex(first, "warehouse joins", { scopes: ["team"] }).map((item) => item.id), ["knowledge.sql.fabric-joins.001"]);
  assert.equal(searchKnowledgeIndex(first, "warehouse", { limit: 1 }).length, 1);
  assert.ok(searchKnowledgeIndex(first, "join")[0].sourceId);
});

test("the checked-in index schema is versioned and embeds governed records", () => {
  const schema = JSON.parse(readFileSync(new URL("../config/knowledge-index.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.status.enum, ["complete", "partial", "failed", "not-applicable"]);
  assert.equal(schema.properties.records.items.properties.record.$ref, "knowledge-record.schema.json");
});

console.log(`knowledge index: ${count} tests passed`);
