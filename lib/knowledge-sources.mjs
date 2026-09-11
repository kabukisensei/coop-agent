/** Canonical, side-effect-free knowledge source registry. */

export const SCHEMA_VERSION = 2;

const CAPABILITIES = ["browse", "agent-read"];
const HEALTH_STATES = new Set([
  "ready",
  "cached-offline",
  "disabled",
  "unconfigured",
  "authentication-required",
  "inaccessible",
  "dirty",
  "diverged",
  "failed",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function repositoryIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let identity = value.trim().replace(/[\\/]$/, "");
  identity = identity.replace(/\.git$/, "");
  identity = identity.replace(/^git@([^:]+):/, "$1/");
  identity = identity.replace(/^[a-z]+:\/\//i, "").replace(/^[^/]+@/, "");
  return identity.toLowerCase().replace(/\/+$/, "");
}

function slugFor(identity) {
  const tail = identity.split("/").filter(Boolean).pop() || "source";
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

function binding(source) {
  return repositoryIdentity(source.repository || source.url || source.repo || source.local_path);
}

function diagnostic(code, message, source) {
  return `${code}: ${message}${source ? ` (${source})` : ""}`;
}

function normalizeRecord(raw, legacy, warnings, errors) {
  if (!isObject(raw)) {
    errors.push(diagnostic("invalid-source", "source definition must be an object"));
    return null;
  }

  const identity = binding(raw);
  if (!identity) {
    errors.push(diagnostic("missing-repository", "source must define repository, url, repo, or local_path"));
    return null;
  }

  const kind = typeof raw.kind === "string" && raw.kind ? raw.kind : "learnings";
  const id = typeof raw.id === "string" && raw.id.trim()
    ? raw.id
    : (legacy ? slugFor(identity) : `${kind}.${slugFor(identity)}`);
  const result = {
    ...raw,
    id,
    kind,
    repository: raw.repository || raw.url || raw.repo || undefined,
    scope: raw.scope || "team",
    sensitivity: raw.sensitivity || "internal",
    agent_read: raw.agent_read === undefined ? true : raw.agent_read,
    activate_skills: raw.activate_skills === undefined ? false : raw.activate_skills,
    publication: raw.publication || "disabled",
    capabilities: Array.isArray(raw.capabilities) ? [...raw.capabilities] : [...CAPABILITIES],
  };
  if (result.repository === undefined) delete result.repository;
  if (result.scope !== "team" && result.scope !== "project") {
    errors.push(diagnostic("invalid-scope", `scope must be team or project`, id));
  }
  if (!Array.isArray(result.capabilities)) {
    errors.push(diagnostic("invalid-capabilities", "capabilities must be an array", id));
    result.capabilities = [...CAPABILITIES];
  }
  if (legacy) warnings.push(diagnostic("legacy-source", "normalized knowledge.repos entry", id));
  return { record: result, identity };
}

/** Normalize either a full config object or its knowledge block. */
export function normalizeSources(config) {
  const root = isObject(config) && isObject(config.knowledge) ? config.knowledge : (isObject(config) ? config : {});
  const warnings = [];
  const errors = [];
  const legacy = Array.isArray(root.repos) ? root.repos : [];
  const explicit = Array.isArray(root.sources) ? root.sources : [];
  const records = new Map();
  const explicitIdentities = new Set();

  for (const raw of explicit) {
    const normalized = normalizeRecord(raw, false, warnings, errors);
    if (!normalized) continue;
    const prior = records.get(normalized.identity);
    if (prior) {
      errors.push(diagnostic("conflicting-binding", "multiple explicit definitions bind the same repository", normalized.record.id));
      if (prior.record.scope === "team" && normalized.record.scope === "project") {
        records.set(normalized.identity, normalized);
      }
      continue;
    }
    explicitIdentities.add(normalized.identity);
    records.set(normalized.identity, normalized);
  }

  for (const raw of legacy) {
    const normalized = normalizeRecord(raw, true, warnings, errors);
    if (!normalized) continue;
    const prior = records.get(normalized.identity);
    if (explicitIdentities.has(normalized.identity)) {
      const explicitRecord = prior.record;
      if (explicitRecord.scope === "team" && raw.scope === "project") {
        errors.push(diagnostic("scope-conflict", "legacy binding cannot broaden project scope to team", explicitRecord.id));
      }
      if (repositoryIdentity(explicitRecord.repository) !== normalized.identity ||
          (raw.local_path && explicitRecord.local_path && raw.local_path !== explicitRecord.local_path)) {
        errors.push(diagnostic("conflicting-binding", "explicit source definition wins over legacy binding", explicitRecord.id));
      }
      continue;
    }
    if (prior) {
      errors.push(diagnostic("conflicting-binding", "duplicate legacy bindings were collapsed", normalized.record.id));
      continue;
    }
    records.set(normalized.identity, normalized);
  }

  return {
    sources: [...records.values()].map((entry) => entry.record),
    warnings,
    errors,
  };
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
  else if (meta.offline === true || meta.cached === true || meta.cache_available === true || meta.cacheAvailable === true || meta.searched === false) status = "cached-offline";
  else if (meta.searched === true || meta.searchable === true || meta.ready === true) status = "ready";
  else if (HEALTH_STATES.has(meta.status)) status = meta.status;
  else status = "unconfigured";

  return {
    status: HEALTH_STATES.has(status) ? status : "failed",
    searched: meta.searched === true || meta.searchable === true,
    ...(meta.error ? { error: meta.error } : {}),
  };
}
