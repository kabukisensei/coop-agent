import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WorkflowService, validateWorkflowRegistry } from "../web/workflow-service.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(ROOT, "config", "workflows.json"), "utf8"));
const definitionSchema = JSON.parse(readFileSync(join(ROOT, "config", "workflow-definition.schema.json"), "utf8"));
const runSchema = JSON.parse(readFileSync(join(ROOT, "config", "workflow-run.schema.json"), "utf8"));
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };

const result = (evidenceStatus = "complete", artifacts = []) => ({
  executionStatus: "completed",
  evidenceStatus,
  summary: "stage complete",
  output: {},
  artifacts,
  diagnostics: [],
});

function service() {
  let tick = 0;
  return new WorkflowService(registry, {
    createId: () => "review-1",
    now: () => new Date(Date.UTC(2026, 8, 4, 20, 0, tick++)),
  });
}

test("checked-in workflow definition and checkpoint schemas are versioned", () => {
  assert.equal(definitionSchema.properties.schemaVersion.const, 1);
  assert.equal(runSchema.properties.schemaVersion.const, 1);
  assert.deepEqual(runSchema.properties.state.enum, ["active", "awaiting-approval", "blocked", "completed", "failed", "cancelled"]);
  assert.equal(validateWorkflowRegistry(registry), true);
});

test("Review changes composes existing capabilities rather than commands or callbacks", () => {
  const workflow = registry.workflows.find((item) => item.id === "coop-workflow.review-changes");
  assert.equal(workflow.capabilityId, "coop.workflow.review-changes");
  assert.ok(workflow.stages.some((stage) => stage.execution.capabilityId === "coop.review.sql"));
  assert.ok(workflow.stages.some((stage) => stage.execution.capabilityId === "coop.review.dax"));
  assert.ok(workflow.stages.some((stage) => stage.execution.capabilityId === "coop.review.bpa"));
  assert.ok(workflow.stages.every((stage) => !Object.hasOwn(stage.execution, "command") && !Object.hasOwn(stage.execution, "callback")));
});

test("run checkpoints survive client reconnect and revisions are monotonic", () => {
  const manager = service();
  const started = manager.start("coop-workflow.review-changes", { changedFilesOnly: true });
  assert.equal(started.state, "active");
  assert.equal(started.currentStageId, "scope-changes");
  assert.equal(started.revision, 1);
  const running = manager.transition(started.runId, "start-stage");
  assert.equal(running.stages[0].status, "running");
  const reconnected = manager.get(started.runId);
  assert.deepEqual(reconnected, running);
  assert.equal(reconnected.revision, 2);
});

test("a workspace-write stage cannot start without its named approval", () => {
  const manager = service();
  let run = manager.start("coop-workflow.review-changes", {});
  run = manager.transition(run.runId, "start-stage");
  run = manager.transition(run.runId, "complete-stage", { result: result() });
  for (const stageId of ["review-sql", "review-dax", "review-bpa"]) {
    assert.equal(run.currentStageId, stageId);
    run = manager.transition(run.runId, "skip-stage");
  }
  run = manager.transition(run.runId, "start-stage");
  run = manager.transition(run.runId, "complete-stage", { result: result("partial") });
  assert.equal(run.currentStageId, "approve-fixes");
  run = manager.transition(run.runId, "start-stage");
  assert.equal(run.state, "awaiting-approval");
  assert.throws(() => manager.transition(run.runId, "start-stage"), /Only a ready/);
  run = manager.transition(run.runId, "resolve-approval", { approved: true, actor: "consultant" });
  assert.equal(run.currentStageId, "apply-approved-fixes");
  run = manager.transition(run.runId, "start-stage");
  assert.equal(run.stages.find((stage) => stage.id === "apply-approved-fixes").status, "running");
  assert.ok(run.approvals.some((approval) => approval.operationId === "workspace.write" && approval.approved));
});

test("review-only path can decline mutation and still completes with explicit partial evidence", () => {
  const manager = service();
  let run = manager.start("coop-workflow.review-changes", {});
  const complete = (evidence = "complete", artifacts = []) => {
    run = manager.transition(run.runId, "start-stage");
    run = manager.transition(run.runId, "complete-stage", { result: result(evidence, artifacts) });
  };
  complete();
  run = manager.transition(run.runId, "skip-stage");
  run = manager.transition(run.runId, "skip-stage");
  run = manager.transition(run.runId, "skip-stage");
  complete("partial");
  run = manager.transition(run.runId, "start-stage");
  run = manager.transition(run.runId, "resolve-approval", { approved: false });
  run = manager.transition(run.runId, "skip-stage");
  complete();
  complete("partial", [{ id: "handoff-1", kind: "review-handoff", mediaType: "application/json" }]);
  assert.equal(run.state, "completed");
  assert.equal(run.currentStageId, null);
  assert.equal(run.evidenceStatus, "partial");
  assert.ok(run.approvals.some((approval) => approval.approved === false));
});

test("failed evidence fails closed and unsupported result fields are rejected", () => {
  const manager = service();
  let run = manager.start("coop-workflow.review-changes", {});
  run = manager.transition(run.runId, "start-stage");
  assert.throws(() => manager.transition(run.runId, "complete-stage", { result: { ...result(), command: "rm" } }), /unsupported field command/);
  assert.throws(() => manager.transition(run.runId, "complete-stage", { result: result("failed") }), /does not accept failed evidence/);
});

console.log(`workflow extension contracts: ${count} tests passed`);
