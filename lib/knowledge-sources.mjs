/** Canonical, side-effect-free knowledge source registry. */

export const SCHEMA_VERSION = 2;

const CAPABILITIES = ["browse", "agent-read"];
const HEALTH_STATES = new Set([
  "ready", "cached-offline", "disabled", "unconfigured", "authentication-required",
  "inaccessible", "dirty", "diverged", "failed",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function repositoryIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let identity = value.trim().replace(/[\\/]$/, "").replace(/\.git$/, "");
  identity = identity.replace(/^git@([^:]+):/, "$1/");
  identity = identity.replace(/^[a-z]+:\/\//i, "").replace(/^[^/]+@/, "").replace(/^www\./i, "");
  const parts = identity.split("/").filter(Boolean);
  if (parts[0] && parts[0].toLowerCase() === "github.com") parts.shift();
  return parts.join("/").toLowerCase() || null;
}

function slugFor(identity) {
  return identity.split("/").filter(Boolean).join("-").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

function binding(source) {
  return repositoryIdentity(source.repository || source.url || source.repo) ||
    (typeof source.local_path === "string" && source.local_path.trim() ? `local:${source.local_path.trim()}` : null);
}

function diagnostic(code, message, source) { return `${code}: ${message}${source ? ` (${source})` : ""}`; }

function normalizeRecord(raw, legacy, warnings, errors) {
  if (!isObject(raw)) { errors.push(diagnostic("invalid-source", "source definition must be an object")); return null; }
  const identity = binding(raw);
  if (!identity) { errors.push(diagnostic("missing-repository", "source must define repository, url, repo, or local_path")); return null; }
  const kind = raw.kind === undefined ? "learnings" : raw.kind;
  const scope = raw.scope === undefined ? "team" : raw.scope;
  const agentRead = raw.agent_read === undefined ? true : raw.agent_read;
  const activateSkills = raw.activate_skills === undefined ? false : raw.activate_skills;
  const capabilities = raw.capabilities === undefined ? [...CAPABILITIES] : raw.capabilities;
  let valid = true;
  if (typeof kind !== "string" || !kind.trim()) { errors.push(diagnostic("invalid-kind", "kind must be a non-empty string", raw.id)); valid = false; }
  if (scope !== "team" && scope !== "project") { errors.push(diagnostic("invalid-scope", "scope must be team or project", raw.id)); valid = false; }
  if (typeof agentRead !== "boolean") { errors.push(diagnostic("invalid-agent-read", "agent_read must be boolean", raw.id)); valid = false; }
  if (typeof activateSkills !== "boolean") { errors.push(diagnostic("invalid-activate-skills", "activate_skills must be boolean", raw.id)); valid = false; }
  if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string" || !capability.trim())) {
    errors.push(diagnostic("invalid-capabilities", "capabilities must be an array of non-empty strings", raw.id)); valid = false;
  }
  if (!valid) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : (legacy ? slugFor(identity.split("/").pop() || identity.replace(/^local:/, "")) : `${kind}.${slugFor(identity.replace(/^local:/, ""))}`);
  const result = {
    ...raw, id, kind,
    ...(raw.repository || raw.url || raw.repo ? { repository: raw.repository || raw.url || raw.repo } : {}),
    scope,
    sensitivity: raw.sensitivity === undefined ? "internal" : raw.sensitivity,
    agent_read: agentRead, activate_skills: activateSkills,
    publication: raw.publication === undefined ? "disabled" : raw.publication,
    capabilities: [...capabilities],
  };
  if (legacy) warnings.push(diagnostic("legacy-source", "normalized knowledge.repos entry", id));
  return { record: result, identity, generatedId: !(typeof raw.id === "string" && raw.id.trim()) };
}

function keys(entry) { return [`identity:${entry.identity}`, `id:${entry.record.id}`]; }

/** Normalize either a full config object or its knowledge block. */
export function normalizeSources(config) {
  const root = isObject(config) && isObject(config.knowledge) ? config.knowledge : (isObject(config) ? config : {});
  const warnings = [], errors = [], records = new Map();
  const add = (entry, isExplicit) => {
    let existing = keys(entry).map((key) => records.get(key)).find(Boolean);
    // Keep the historical short legacy slug when possible, but make generated
    // IDs unique if two owners use the same repository basename.
    if (existing && existing.identity !== entry.identity && entry.generatedId && !isExplicit && records.get(`id:${entry.record.id}`)) {
      entry = { ...entry, record: { ...entry.record, id: slugFor(entry.identity) } };
      existing = keys(entry).map((key) => records.get(key)).find(Boolean);
    }
    if (!existing) { keys(entry).forEach((key) => records.set(key, entry)); return; }
    errors.push(diagnostic("conflicting-binding", isExplicit ? "multiple definitions bind the same source identity" : "explicit source definition wins over legacy binding", entry.record.id));
    // A project restriction always wins, even when it came from a legacy entry.
    if (existing.record.scope === "team" && entry.record.scope === "project") {
      const replacement = isExplicit ? entry : { ...existing, record: { ...existing.record, scope: "project" } };
      keys(existing).forEach((key) => records.set(key, replacement));
      keys(replacement).forEach((key) => records.set(key, replacement));
    }
  };
  (Array.isArray(root.sources) ? root.sources : []).forEach((raw) => { const entry = normalizeRecord(raw, false, warnings, errors); if (entry) add(entry, true); });
  (Array.isArray(root.repos) ? root.repos : []).forEach((raw) => { const entry = normalizeRecord(raw, true, warnings, errors); if (entry) add(entry, false); });
  return { sources: [...new Set(records.values())].map((entry) => entry.record), warnings, errors };
}

/** Classify a source without probing it. syncMeta is metadata supplied by an adapter. */
export function getSourceHealth(source, syncMeta = {}) {
  const meta = isObject(syncMeta) ? syncMeta : {};
  let status;
  if (!isObject(source) || source.enabled === false || source.disabled === true || meta.disabled === true) status = "disabled";
  else if (meta.authentication_required || meta.auth_required || meta.auth === "required") status = "authentication-required";
  else if (meta.diverged === true || meta.state === "diverged") status = "diverged";
  else if (meta.dirty === true || meta.state === "dirty") status = "dirty";
  else if (meta.failed === true || meta.state === "failed" || meta.error) status = "failed";
  else if (meta.inaccessible === true || meta.accessible === false || meta.state === "inaccessible") status = "inaccessible";
  else if (meta.configured === false || meta.unconfigured === true) status = "unconfigured";
  else if ((meta.offline === true || meta.searched === false || meta.status === "cached-offline") && (meta.cached === true || meta.cache_available === true || meta.cacheAvailable === true)) status = "cached-offline";
  else if (meta.offline === true || meta.searched === false || meta.status === "cached-offline") status = "inaccessible";
  else if (meta.searched === true || meta.searchable === true || meta.ready === true) status = "ready";
  else if (HEALTH_STATES.has(meta.status)) status = meta.status;
  else status = "unconfigured";
  return { status: HEALTH_STATES.has(status) ? status : "failed", searched: meta.searched === true || meta.searchable === true, ...(meta.error ? { error: meta.error } : {}) };
}
