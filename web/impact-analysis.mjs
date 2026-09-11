export const IMPACT_ANALYSIS_SCHEMA_VERSION = 1;

const EVIDENCE_STATES = new Set(["complete", "partial", "failed", "not-applicable"]);
const SOURCE_KINDS = new Set(["data-doc", "fabric", "powerbi", "source", "microsoft-learn", "agent-inference"]);
const CHANGE_INTENTS = new Set(["add", "remove", "rename", "retype", "redefine", "move", "deprecate", "investigate"]);
const CLASSIFICATIONS = new Set(["breaking", "non-breaking", "cosmetic", "unknown"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "unknown"]);
const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_ITEMS = 500;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function text(value, label, { optional = false, max = 4000 } = {}) {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || (!optional && !value.trim())) throw new TypeError(`${label} must be non-empty text.`);
  if (value.length > max) throw new TypeError(`${label} exceeds ${max} characters.`);
  return value.trim();
}

function nullableText(value, label, max = 4000) {
  if (value === null || value === undefined || value === "") return null;
  return text(value, label, { max });
}

function isoDate(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const result = text(value, label, { max: 100 });
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${label} must be an ISO date-time.`);
  return result;
}

function list(value, label, max = MAX_ITEMS) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (value.length > max) throw new TypeError(`${label} exceeds ${max} items.`);
  return value;
}

function stringList(value, label) {
  const values = list(value, label).map((item, index) => text(item, `${label}[${index}]`, { max: 500 }));
  return [...new Set(values)];
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new TypeError(`${label} has an unsupported value.`);
  return value;
}

function objectRef(value, label, sourceIds) {
  const item = object(value, label);
  const evidenceSourceIds = stringList(item.evidenceSourceIds, `${label}.evidenceSourceIds`);
  if (!evidenceSourceIds.length) throw new TypeError(`${label} must cite at least one evidence source.`);
  for (const id of evidenceSourceIds) if (!sourceIds.has(id)) throw new TypeError(`${label} references unknown evidence source ${id}.`);
  return {
    id: text(item.id, `${label}.id`, { max: 500 }),
    name: text(item.name, `${label}.name`, { max: 500 }),
    type: text(item.type, `${label}.type`, { max: 200 }),
    path: nullableText(item.path, `${label}.path`, 2000),
    classification: enumValue(item.classification, CLASSIFICATIONS, `${label}.classification`),
    evidenceSourceIds,
  };
}

function uniqueById(values, label) {
  const ids = new Set();
  for (const value of values) {
    if (ids.has(value.id)) throw new TypeError(`${label} contains duplicate ID ${value.id}.`);
    ids.add(value.id);
  }
  return values;
}

export function normalizeImpactAnalysis(value) {
  const root = object(value, "Impact analysis");
  let encoded;
  try { encoded = JSON.stringify(root); } catch { throw new TypeError("Impact analysis must be JSON serializable."); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_ARTIFACT_BYTES) throw new TypeError("Impact analysis exceeds the 512 KiB limit.");
  if (root.schemaVersion !== IMPACT_ANALYSIS_SCHEMA_VERSION) throw new TypeError("Unsupported impact-analysis schema version.");

  const rawSources = list(root.evidenceSources, "evidenceSources");
  if (!rawSources.length) throw new TypeError("Impact analysis requires at least one evidence source.");
  const evidenceSources = uniqueById(rawSources.map((value, index) => {
    const item = object(value, `evidenceSources[${index}]`);
    return {
      id: text(item.id, `evidenceSources[${index}].id`, { max: 500 }),
      kind: enumValue(item.kind, SOURCE_KINDS, `evidenceSources[${index}].kind`),
      label: text(item.label, `evidenceSources[${index}].label`, { max: 1000 }),
      observedAt: isoDate(item.observedAt, `evidenceSources[${index}].observedAt`, { nullable: true }),
      status: enumValue(item.status, EVIDENCE_STATES, `evidenceSources[${index}].status`),
      reference: nullableText(item.reference, `evidenceSources[${index}].reference`, 2000),
    };
  }), "evidenceSources");
  const sourceIds = new Set(evidenceSources.map((source) => source.id));

  const target = object(root.target, "target");
  const impacts = object(root.impacts, "impacts");
  const normalizeRefs = (name) => uniqueById(list(impacts[name], `impacts.${name}`).map((item, index) => objectRef(item, `impacts.${name}[${index}]`, sourceIds)), `impacts.${name}`);
  const normalizedImpacts = {
    upstream: normalizeRefs("upstream"),
    downstream: normalizeRefs("downstream"),
    reports: normalizeRefs("reports"),
    apps: normalizeRefs("apps"),
    rls: normalizeRefs("rls"),
    refresh: normalizeRefs("refresh"),
    consumers: normalizeRefs("consumers"),
  };

  const paths = uniqueById(list(root.paths, "paths").map((value, index) => {
    const item = object(value, `paths[${index}]`);
    const evidenceSourceIds = stringList(item.evidenceSourceIds, `paths[${index}].evidenceSourceIds`);
    if (!evidenceSourceIds.length) throw new TypeError(`paths[${index}] must cite at least one evidence source.`);
    for (const id of evidenceSourceIds) if (!sourceIds.has(id)) throw new TypeError(`paths[${index}] references unknown evidence source ${id}.`);
    return {
      id: text(item.id, `paths[${index}].id`, { max: 500 }),
      direction: enumValue(item.direction, new Set(["upstream", "downstream", "cross-artifact"]), `paths[${index}].direction`),
      nodes: (() => {
        const nodes = list(item.nodes, `paths[${index}].nodes`, 100);
        if (nodes.length < 2) throw new TypeError(`paths[${index}] must contain at least two nodes.`);
        return nodes.map((node, nodeIndex) => objectRef(node, `paths[${index}].nodes[${nodeIndex}]`, sourceIds));
      })(),
      evidenceSourceIds,
      confidence: enumValue(item.confidence, new Set(["high", "medium", "low", "unknown"]), `paths[${index}].confidence`),
      explanation: text(item.explanation ?? "", `paths[${index}].explanation`, { optional: true, max: 4000 }),
    };
  }), "paths");

  const evidenceGaps = uniqueById(list(root.evidenceGaps, "evidenceGaps").map((value, index) => {
    const item = object(value, `evidenceGaps[${index}]`);
    return {
      id: text(item.id, `evidenceGaps[${index}].id`, { max: 500 }),
      severity: enumValue(item.severity, new Set(["error", "warning", "info"]), `evidenceGaps[${index}].severity`),
      message: text(item.message, `evidenceGaps[${index}].message`),
      affects: stringList(item.affects, `evidenceGaps[${index}].affects`),
    };
  }), "evidenceGaps");

  const risk = object(root.risk, "risk");
  const plan = object(root.plan, "plan");
  const approval = object(root.approval, "approval");
  const approvalRequired = approval.required === true;
  const approvalStatus = enumValue(approval.status, new Set(["pending", "approved", "declined", "not-required"]), "approval.status");
  if (approvalRequired && approvalStatus === "not-required") throw new TypeError("approval.status cannot be not-required when approval is required.");
  if (!approvalRequired && approvalStatus !== "not-required") throw new TypeError("approval.status must be not-required when approval is not required.");
  const requestedEvidence = enumValue(root.evidenceStatus, EVIDENCE_STATES, "evidenceStatus");
  const sourceIncomplete = evidenceSources.some((source) => ["partial", "failed"].includes(source.status));
  const onlyInference = evidenceSources.length > 0 && evidenceSources.every((source) => source.kind === "agent-inference");
  const evidenceStatus = requestedEvidence === "complete" && (sourceIncomplete || onlyInference || evidenceGaps.length > 0 || evidenceSources.length === 0)
    ? "partial"
    : requestedEvidence;

  return {
    schemaVersion: IMPACT_ANALYSIS_SCHEMA_VERSION,
    analysisId: text(root.analysisId, "analysisId", { max: 500 }),
    evidenceStatus,
    generatedAt: isoDate(root.generatedAt, "generatedAt"),
    target: {
      id: text(target.id, "target.id", { max: 500 }),
      name: text(target.name, "target.name", { max: 500 }),
      type: text(target.type, "target.type", { max: 200 }),
      changeIntent: enumValue(target.changeIntent, CHANGE_INTENTS, "target.changeIntent"),
      intendedOutcome: text(target.intendedOutcome ?? "", "target.intendedOutcome", { optional: true }),
      environment: text(target.environment ?? "", "target.environment", { optional: true, max: 500 }),
      deploymentScope: text(target.deploymentScope ?? "", "target.deploymentScope", { optional: true, max: 1000 }),
    },
    evidenceSources,
    paths,
    impacts: normalizedImpacts,
    evidenceGaps,
    risk: {
      level: enumValue(risk.level, RISK_LEVELS, "risk.level"),
      rationale: text(risk.rationale, "risk.rationale"),
      drivers: stringList(risk.drivers, "risk.drivers"),
    },
    saferAlternatives: list(root.saferAlternatives, "saferAlternatives", 100).map((value, index) => {
      const item = object(value, `saferAlternatives[${index}]`);
      return { title: text(item.title, `saferAlternatives[${index}].title`), rationale: text(item.rationale, `saferAlternatives[${index}].rationale`) };
    }),
    plan: {
      summary: text(plan.summary, "plan.summary"),
      steps: uniqueById((() => {
        const steps = list(plan.steps, "plan.steps", 100);
        if (!steps.length) throw new TypeError("plan.steps must contain at least one step.");
        return steps;
      })().map((value, index) => {
        const item = object(value, `plan.steps[${index}]`);
        return {
          id: text(item.id, `plan.steps[${index}].id`, { max: 500 }),
          title: text(item.title, `plan.steps[${index}].title`),
          description: text(item.description, `plan.steps[${index}].description`),
          approvalRequired: item.approvalRequired === true,
          affectedObjects: stringList(item.affectedObjects, `plan.steps[${index}].affectedObjects`),
        };
      }), "plan.steps"),
    },
    approval: {
      required: approvalRequired,
      status: approvalStatus,
    },
  };
}
