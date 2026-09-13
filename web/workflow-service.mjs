import { randomUUID } from "node:crypto";

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1;
export const WORKFLOW_RUN_SCHEMA_VERSION = 1;

const EVIDENCE_STATES = new Set(["complete", "partial", "failed", "not-applicable"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const INPUT_MAX_BYTES = 64 * 1024;

function clone(value) {
  return structuredClone(value);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
}

function validateDefinitions(registry) {
  assertObject(registry, "Workflow registry");
  if (registry.schemaVersion !== WORKFLOW_DEFINITION_SCHEMA_VERSION || !Array.isArray(registry.workflows)) {
    throw new TypeError("Unsupported workflow registry contract.");
  }
  const ids = new Set();
  for (const definition of registry.workflows) {
    assertObject(definition, "Workflow definition");
    if (typeof definition.id !== "string" || !definition.id || ids.has(definition.id)) throw new TypeError("Workflow IDs must be unique non-empty strings.");
    if (!Number.isInteger(definition.version) || definition.version < 1) throw new TypeError(`Workflow ${definition.id} has an invalid version.`);
    if (!Array.isArray(definition.stages) || definition.stages.length === 0) throw new TypeError(`Workflow ${definition.id} has no stages.`);
    const stageIds = new Set();
    for (const stage of definition.stages) {
      assertObject(stage, `Workflow ${definition.id} stage`);
      if (typeof stage.id !== "string" || !stage.id || stageIds.has(stage.id)) throw new TypeError(`Workflow ${definition.id} has invalid or duplicate stage IDs.`);
      if (!stage.execution || !["capability", "core-operation", "approval"].includes(stage.execution.kind)) throw new TypeError(`Workflow ${definition.id} stage ${stage.id} has an invalid execution kind.`);
      if (stage.execution.kind === "capability" && typeof stage.execution.capabilityId !== "string") throw new TypeError(`Workflow ${definition.id} stage ${stage.id} requires a capability ID.`);
      if (stage.execution.kind !== "capability" && stage.execution.capabilityId !== null) throw new TypeError(`Workflow ${definition.id} stage ${stage.id} cannot declare a capability ID.`);
      if (stage.execution.kind === "capability" && stage.execution.operationId !== null) throw new TypeError(`Workflow ${definition.id} stage ${stage.id} cannot declare an operation ID.`);
      if (stage.execution.kind !== "capability" && typeof stage.execution.operationId !== "string") throw new TypeError(`Workflow ${definition.id} stage ${stage.id} requires an operation ID.`);
      if (!Array.isArray(stage.dependsOn) || !Array.isArray(stage.acceptedEvidenceStates)) throw new TypeError(`Workflow ${definition.id} stage ${stage.id} has invalid dependency/evidence fields.`);
      if (stage.acceptedEvidenceStates.some((state) => !EVIDENCE_STATES.has(state))) throw new TypeError(`Workflow ${definition.id} stage ${stage.id} has an invalid evidence state.`);
      stageIds.add(stage.id);
    }
    for (const stage of definition.stages) {
      for (const dependency of stage.dependsOn) {
        if (!stageIds.has(dependency)) throw new TypeError(`Workflow ${definition.id} stage ${stage.id} has an unknown dependency.`);
      }
    }
    for (const required of definition.completionCriteria?.requiredStageIds || []) {
      if (!stageIds.has(required)) throw new TypeError(`Workflow ${definition.id} has an unknown required stage.`);
    }
    ids.add(definition.id);
  }
  return registry;
}

function validateInput(input) {
  assertObject(input, "Workflow input");
  let encoded;
  try { encoded = JSON.stringify(input); } catch { throw new TypeError("Workflow input must be JSON serializable."); }
  if (Buffer.byteLength(encoded, "utf8") > INPUT_MAX_BYTES) throw new TypeError("Workflow input exceeds the 64 KiB limit.");
  return clone(input);
}

function validateResult(result, stage) {
  assertObject(result, "Stage result");
  const allowed = new Set(["executionStatus", "evidenceStatus", "summary", "output", "artifacts", "diagnostics"]);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new TypeError(`Stage result contains unsupported field ${key}.`);
  if (!['completed', 'failed', 'cancelled'].includes(result.executionStatus)) throw new TypeError("Stage result has an invalid execution status.");
  if (!EVIDENCE_STATES.has(result.evidenceStatus)) throw new TypeError("Stage result has an invalid evidence status.");
  if (!stage.acceptedEvidenceStates.includes(result.evidenceStatus) && result.executionStatus === "completed") {
    throw new TypeError(`Stage ${stage.id} does not accept ${result.evidenceStatus} evidence.`);
  }
  if (result.summary !== null && typeof result.summary !== "string") throw new TypeError("Stage result summary must be text or null.");
  assertObject(result.output, "Stage result output");
  if (!Array.isArray(result.artifacts) || !Array.isArray(result.diagnostics)) throw new TypeError("Stage result artifacts and diagnostics must be arrays.");
  for (const artifact of result.artifacts) {
    assertObject(artifact, "Workflow artifact");
    if (typeof artifact.id !== "string" || !artifact.id || typeof artifact.kind !== "string" || !artifact.kind) throw new TypeError("Workflow artifacts require id and kind.");
  }
  return clone(result);
}

function rollupEvidence(stages) {
  const states = stages.map((stage) => stage.result?.evidenceStatus).filter(Boolean);
  if (states.includes("failed")) return "failed";
  if (states.includes("partial")) return "partial";
  if (states.includes("complete")) return "complete";
  return "not-applicable";
}

function publicDefinition(definition) {
  return clone(definition);
}

export class WorkflowService {
  constructor(registry, { now = () => new Date(), createId = () => randomUUID() } = {}) {
    validateDefinitions(registry);
    this.registry = clone(registry);
    this.definitions = new Map(this.registry.workflows.map((definition) => [definition.id, definition]));
    this.runs = new Map();
    this.now = now;
    this.createId = createId;
  }

  listDefinitions() {
    return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, workflows: this.registry.workflows.map(publicDefinition) };
  }

  start(workflowId, input = {}) {
    const definition = this.definitions.get(workflowId);
    if (!definition) throw new TypeError("Unknown workflow ID.");
    const at = this.now().toISOString();
    const run = {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      runId: `workflow-${this.createId()}`,
      workflowId: definition.id,
      workflowVersion: definition.version,
      state: "active",
      revision: 1,
      startedAt: at,
      updatedAt: at,
      input: validateInput(input),
      currentStageId: definition.stages[0].id,
      evidenceStatus: "not-applicable",
      stages: definition.stages.map((stage, index) => ({
        id: stage.id,
        status: index === 0 ? "ready" : "pending",
        attempt: 0,
        startedAt: null,
        completedAt: null,
        result: null,
      })),
      approvals: [],
      artifacts: [],
      diagnostics: [],
    };
    this.runs.set(run.runId, run);
    return clone(run);
  }

  get(runId) {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  transition(runId, operation, fields = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new TypeError("Unknown workflow run.");
    if (TERMINAL_STATES.has(run.state)) throw new TypeError(`Workflow run is already ${run.state}.`);
    const definition = this.definitions.get(run.workflowId);
    const stage = definition.stages.find((item) => item.id === run.currentStageId);
    const state = run.stages.find((item) => item.id === run.currentStageId);
    if (!stage || !state) throw new Error("Workflow checkpoint has no current stage.");
    const at = this.now().toISOString();

    if (operation === "start-stage") {
      if (state.status !== "ready") throw new TypeError("Only a ready workflow stage can start.");
      if (stage.requiresApprovalOperation && !run.approvals.some((item) => item.operationId === stage.requiresApprovalOperation && item.approved === true)) {
        throw new TypeError(`Stage ${stage.id} requires approval for ${stage.requiresApprovalOperation}.`);
      }
      state.attempt++;
      state.startedAt = at;
      if (stage.execution.kind === "approval") {
        state.status = "awaiting-approval";
        run.state = "awaiting-approval";
      } else {
        state.status = "running";
        run.state = "active";
      }
    } else if (operation === "complete-stage") {
      if (state.status !== "running") throw new TypeError("Only a running workflow stage can complete.");
      const result = validateResult(fields.result, stage);
      state.result = result;
      state.completedAt = at;
      if (result.executionStatus === "failed" || result.evidenceStatus === "failed") {
        state.status = "failed";
        run.state = "failed";
      } else if (result.executionStatus === "cancelled") {
        state.status = "cancelled";
        run.state = "cancelled";
      } else {
        state.status = "completed";
        for (const artifact of result.artifacts) {
          if (!run.artifacts.some((existing) => existing.id === artifact.id)) run.artifacts.push(clone(artifact));
        }
        run.diagnostics.push(...result.diagnostics.map((diagnostic) => ({ ...clone(diagnostic), stageId: stage.id })));
        this.#advance(run, definition, at);
      }
    } else if (operation === "skip-stage") {
      if (stage.required) throw new TypeError(`Required stage ${stage.id} cannot be skipped.`);
      if (!["ready", "awaiting-approval"].includes(state.status)) throw new TypeError("Only a ready or awaiting-approval optional stage can be skipped.");
      state.status = "skipped";
      state.completedAt = at;
      this.#advance(run, definition, at);
    } else if (operation === "resolve-approval") {
      if (stage.execution.kind !== "approval" || state.status !== "awaiting-approval") throw new TypeError("No workflow approval is awaiting a decision.");
      if (typeof fields.approved !== "boolean") throw new TypeError("Approval resolution requires an explicit boolean decision.");
      const approval = {
        stageId: stage.id,
        operationId: stage.execution.operationId,
        approved: fields.approved,
        decidedAt: at,
        actor: typeof fields.actor === "string" && fields.actor.trim() ? fields.actor.trim().slice(0, 200) : "user",
        note: typeof fields.note === "string" && fields.note.trim() ? fields.note.trim().slice(0, 2000) : null,
      };
      run.approvals.push(approval);
      state.completedAt = at;
      if (fields.approved) {
        state.status = "completed";
        run.state = "active";
      } else if (stage.required) {
        state.status = "blocked";
        run.state = "blocked";
      } else {
        state.status = "skipped";
        run.state = "active";
      }
      if (run.state === "active") this.#advance(run, definition, at);
    } else if (operation === "cancel-run") {
      if (!["active", "awaiting-approval", "blocked"].includes(run.state)) throw new TypeError("Workflow run cannot be cancelled from its current state.");
      if (!["completed", "skipped", "failed", "cancelled"].includes(state.status)) state.status = "cancelled";
      run.state = "cancelled";
      run.currentStageId = null;
    } else {
      throw new TypeError("Unknown workflow transition operation.");
    }

    run.evidenceStatus = rollupEvidence(run.stages);
    run.revision++;
    run.updatedAt = at;
    return clone(run);
  }

  #advance(run, definition, at) {
    const currentIndex = definition.stages.findIndex((stage) => stage.id === run.currentStageId);
    const nextDefinition = definition.stages[currentIndex + 1];
    if (nextDefinition) {
      const nextState = run.stages[currentIndex + 1];
      const dependenciesMet = nextDefinition.dependsOn.every((dependency) => {
        const dependencyState = run.stages.find((stage) => stage.id === dependency)?.status;
        return dependencyState === "completed" || dependencyState === "skipped";
      });
      if (!dependenciesMet) {
        nextState.status = "blocked";
        run.state = "blocked";
        run.currentStageId = nextDefinition.id;
        run.diagnostics.push({ severity: "error", code: "workflow.dependency-blocked", message: `Dependencies for ${nextDefinition.id} are incomplete.`, stageId: nextDefinition.id });
        return;
      }
      nextState.status = "ready";
      run.currentStageId = nextDefinition.id;
      run.state = "active";
      return;
    }

    const requiredComplete = definition.completionCriteria.requiredStageIds.every((id) => run.stages.find((stage) => stage.id === id)?.status === "completed");
    const allSettled = run.stages.every((stage) => ["completed", "skipped"].includes(stage.status));
    const artifactKinds = new Set(run.artifacts.map((artifact) => artifact.kind));
    const artifactsComplete = definition.completionCriteria.requiredArtifactKinds.every((kind) => artifactKinds.has(kind));
    const evidenceAllowed = definition.completionCriteria.allowPartialEvidence || rollupEvidence(run.stages) !== "partial";
    if (requiredComplete && allSettled && artifactsComplete && evidenceAllowed) {
      run.state = "completed";
      run.currentStageId = null;
    } else {
      run.state = "blocked";
      run.currentStageId = null;
      run.diagnostics.push({ severity: "error", code: "workflow.completion-criteria", message: "Workflow completion criteria were not satisfied.", stageId: null });
    }
  }
}

export function validateWorkflowRegistry(registry) {
  validateDefinitions(registry);
  return true;
}

export function listWorkflowExtensions(registry) {
  validateDefinitions(registry);
  return registry.workflows.map((workflow) => ({
    id: workflow.id,
    version: workflow.version,
    capabilityId: workflow.capabilityId,
    name: workflow.name,
    description: workflow.description,
    prerequisites: [...workflow.prerequisites],
    stageIds: workflow.stages.map((stage) => stage.id),
  }));
}
