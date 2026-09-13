// Coop Core knowledge policy. This module validates already-parsed, normalized
// records. KNW-002 owns Markdown/YAML parsing and indexing; private Pi memory is
// deliberately outside this contract.

export const KNOWLEDGE_RECORD_SCHEMA_VERSION = 1;
export const KNOWLEDGE_RECORD_MAX_BYTES = 128 * 1024;

const EXACT_FIELDS = Object.freeze([
  "schemaVersion", "id", "title", "kind", "scope", "sensitivity",
  "status", "confidence", "tags", "appliesTo", "source", "createdAt",
  "createdBy", "review", "project", "sanitization", "supersedes",
  "supersededBy", "body",
]);
const BODY_FIELDS = Object.freeze([
  "context", "problem", "why", "approvedPattern", "antiPattern", "detection",
  "example", "exceptions", "sources",
]);
const KINDS = new Set(["pattern", "antipattern", "decision", "runbook", "troubleshooting", "standard", "exception"]);
const STATUSES = new Set(["proposed", "approved", "rejected", "deprecated", "superseded"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const SOURCE_TYPES = new Set(["human-authored", "reviewed-incident", "implementation", "review", "finding", "external-source"]);
const REVIEWED_STATUSES = new Set(["approved", "rejected", "deprecated", "superseded"]);
const ALLOWED_TRANSITIONS = Object.freeze({
  proposed: new Set(["proposed", "approved", "rejected"]),
  approved: new Set(["approved", "deprecated", "superseded"]),
  rejected: new Set(["rejected"]),
  deprecated: new Set(["deprecated", "superseded"]),
  superseded: new Set(["superseded"]),
});
const KNOWLEDGE_ID = /^knowledge\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
}

function exactFields(value, fields, label) {
  assertObject(value, label);
  const expected = new Set(fields);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new TypeError(`${label} contains unsupported field ${key}.`);
  for (const key of fields) if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}.`);
}

function nonEmpty(value, label, max = 32768) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  if (value.length > max) throw new TypeError(`${label} exceeds ${max} characters.`);
}

function nullableText(value, label) {
  if (value !== null) nonEmpty(value, label, 500);
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  nonEmpty(value, label, 100);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp.`);
}

function stringArray(value, label, { required = false, max = 100 } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new TypeError(`${label} must be ${required ? "a non-empty" : "an"} array.`);
  if (new Set(value).size !== value.length) throw new TypeError(`${label} contains duplicates.`);
  for (const item of value) nonEmpty(item, label, max);
}

function validateLifecycle(record) {
  const reviewed = record.review.reviewedAt !== null || record.review.reviewedBy !== null;
  if ((record.review.reviewedAt === null) !== (record.review.reviewedBy === null)) {
    throw new TypeError("Knowledge review timestamp and reviewer must be set together.");
  }
  if (REVIEWED_STATUSES.has(record.status) && !reviewed) {
    throw new TypeError(`${record.status} knowledge requires a human review identity and timestamp.`);
  }
  if (record.status === "superseded" && record.supersededBy === null) {
    throw new TypeError("Superseded knowledge must identify its replacement.");
  }
  if (record.status !== "superseded" && record.supersededBy !== null) {
    throw new TypeError("Only superseded knowledge may identify a replacement.");
  }
  if (record.supersedes === record.id || record.supersededBy === record.id) {
    throw new TypeError("Knowledge cannot supersede itself.");
  }
}

function validateScope(record) {
  const sanitized = record.sanitization.checkedAt !== null || record.sanitization.checkedBy !== null;
  if ((record.sanitization.checkedAt === null) !== (record.sanitization.checkedBy === null)) {
    throw new TypeError("Knowledge sanitization timestamp and reviewer must be set together.");
  }
  if (record.scope === "project") {
    if (record.sensitivity !== "client-confidential" || record.sanitization.clientData !== "present") {
      throw new TypeError("Project knowledge must remain client-confidential and declare client data present.");
    }
    if (!record.project.projectId) throw new TypeError("Project knowledge requires a project ID.");
    return;
  }
  if (record.scope !== "team") throw new TypeError("Knowledge scope must be project or team; private memory is not a shared record.");
  if (record.sensitivity !== "internal" || record.sanitization.clientData !== "none") {
    throw new TypeError("Team knowledge must be internal, sanitized, and declare no client data.");
  }
  if (record.project.organizationId !== null || record.project.projectId !== null) {
    throw new TypeError("Team knowledge cannot carry client or project identifiers.");
  }
  if (!sanitized) throw new TypeError("Team knowledge requires an attributable sanitization review before storage.");
}

export function validateKnowledgeRecord(input) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input), "utf8"); } catch { throw new TypeError("Knowledge record must be JSON serializable."); }
  if (bytes > KNOWLEDGE_RECORD_MAX_BYTES) throw new TypeError("Knowledge record exceeds the 128 KiB limit.");
  exactFields(input, EXACT_FIELDS, "Knowledge record");
  if (input.schemaVersion !== KNOWLEDGE_RECORD_SCHEMA_VERSION) throw new TypeError("Unsupported knowledge record schema version.");
  if (typeof input.id !== "string" || !KNOWLEDGE_ID.test(input.id)) throw new TypeError("Knowledge record has an invalid ID.");
  nonEmpty(input.title, "Knowledge title", 160);
  if (!KINDS.has(input.kind)) throw new TypeError("Knowledge kind is invalid.");
  if (!STATUSES.has(input.status)) throw new TypeError("Knowledge status is invalid.");
  if (!CONFIDENCE.has(input.confidence)) throw new TypeError("Knowledge confidence is invalid.");
  stringArray(input.tags, "Knowledge tags");
  stringArray(input.appliesTo, "Knowledge appliesTo");
  exactFields(input.source, ["type", "references"], "Knowledge source");
  if (!SOURCE_TYPES.has(input.source.type)) throw new TypeError("Knowledge source type is invalid.");
  stringArray(input.source.references, "Knowledge source references", { required: true, max: 500 });
  timestamp(input.createdAt, "Knowledge createdAt");
  nonEmpty(input.createdBy, "Knowledge createdBy", 200);
  exactFields(input.review, ["reviewedAt", "reviewedBy"], "Knowledge review");
  timestamp(input.review.reviewedAt, "Knowledge reviewedAt", { nullable: true });
  nullableText(input.review.reviewedBy, "Knowledge reviewedBy");
  exactFields(input.project, ["organizationId", "projectId"], "Knowledge project");
  nullableText(input.project.organizationId, "Knowledge organizationId");
  nullableText(input.project.projectId, "Knowledge projectId");
  exactFields(input.sanitization, ["clientData", "checkedAt", "checkedBy"], "Knowledge sanitization");
  if (!new Set(["none", "present"]).has(input.sanitization.clientData)) throw new TypeError("Knowledge clientData state is invalid.");
  timestamp(input.sanitization.checkedAt, "Knowledge sanitization checkedAt", { nullable: true });
  nullableText(input.sanitization.checkedBy, "Knowledge sanitization checkedBy");
  for (const [field, value] of [["supersedes", input.supersedes], ["supersededBy", input.supersededBy]]) {
    if (value !== null && (typeof value !== "string" || !KNOWLEDGE_ID.test(value))) throw new TypeError(`Knowledge ${field} is invalid.`);
  }
  exactFields(input.body, BODY_FIELDS, "Knowledge body");
  for (const field of BODY_FIELDS) nonEmpty(input.body[field], `Knowledge body.${field}`);
  validateScope(input);
  validateLifecycle(input);
  return structuredClone(input);
}

export function authorizeKnowledgeTransition(previousInput, nextInput, { actorType } = {}) {
  const previous = validateKnowledgeRecord(previousInput);
  const next = validateKnowledgeRecord(nextInput);
  if (previous.id !== next.id) throw new TypeError("Knowledge ID is immutable.");
  if (previous.scope !== next.scope) throw new TypeError("Knowledge scope is immutable; create a separately reviewed record for another scope.");
  if (!ALLOWED_TRANSITIONS[previous.status].has(next.status)) throw new TypeError(`Knowledge cannot transition from ${previous.status} to ${next.status}.`);
  if (previous.status !== next.status && actorType !== "human") {
    throw new TypeError("Knowledge lifecycle changes require an explicit human action.");
  }
  return next;
}
