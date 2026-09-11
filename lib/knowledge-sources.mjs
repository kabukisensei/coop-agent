/** Canonical, side-effect-free knowledge source registry. */

export const SCHEMA_VERSION = 2;

const DEFAULT_CAPABILITIES = ["browse", "agent-read"];
const HEALTH_STATES = new Set([
  "ready", "cached-offline", "disabled", "unconfigured", "authentication-required",
  "inaccessible", "dirty", "diverged", "failed",
]);
const TERMINAL_STATES = new Set([
  "failed", "inaccessible", "authentication-required", "diverged", "dirty", "disabled", "unconfigured",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

/* All source locators pass through this function. */
function canonicalIdentity(value, type) {
  if (!isNonEmptyString(value)) return null;
  let identity = value.trim().replace(/\\/g, "/");

  if (type === "local") {
    const prefix = identity.startsWith("/") ? "/" : "";
    const parts = [];
    for (const part of identity.split("/")) {
      if (!part || part === ".") continue;
      if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (part === ".." && !prefix) parts.push(part);
      else if (part !== "..") parts.push(part);
    }
    return `local:${prefix}${parts.join("/") || (prefix ? "" : ".")}`;
  }

  identity = identity.replace(/[?#].*$/, "").replace(/\/+$/, "");
  identity = identity.replace(/^([^/@]+)@([^/:]+):/, "$2/");
  identity = identity.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  identity = identity.replace(/^[^/@]+@/, "").replace(/^www\./i, "");
  identity = identity.replace(/^github\.com\//i, "").replace(/\.git$/i, "");
  return identity.split("/").filter(Boolean).join("/").toLowerCase() || null;
}

function slugFor(identity) {
  return identity.replace(/^local:/, "local-").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

function diagnostic(code, message, source) {
  return `${code}: ${message}${source ? ` (${source})` : ""}`;
}

function validateString(raw, field, errors, label) {
  if (raw[field] !== undefined && !isNonEmptyString(raw[field])) {
    errors.push(diagnostic(`invalid-${field.replaceAll("_", "-")}`, `${field} must be a non-empty string`, label));
    return false;
  }
  return true;
}

function validateStringArray(raw, field, errors, label) {
  if (raw[field] !== undefined && (!Array.isArray(raw[field]) || raw[field].some((item) => !isNonEmptyString(item)))) {
    errors.push(diagnostic(`invalid-${field.replaceAll("_", "-")}`, `${field} must be an array of non-empty strings`, label));
    return false;
  }
  return true;
}

function normalizeRecord(raw, legacy, warnings, errors) {
  if (!isObject(raw)) {
    errors.push(diagnostic("invalid-source", "source definition must be an object"));
    return null;
  }

  const label = isNonEmptyString(raw.id) ? raw.id.trim() : undefined;
  let valid = true;
  if (raw.id !== undefined && !isNonEmptyString(raw.id)) {
    errors.push(diagnostic("invalid-id", "id must be a non-empty string"));
    valid = false;
  }
  for (const field of ["kind", "adapter", "sensitivity", "classification", "publication"]) {
    valid = validateString(raw, field, errors, label) && valid;
  }
  if (raw.scope !== undefined && raw.scope !== "team" && raw.scope !== "project") {
    errors.push(diagnostic("invalid-scope", "scope must be team or project", label));
    valid = false;
  }
  for (const field of ["agent_read", "activate_skills"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "boolean") {
      errors.push(diagnostic(`invalid-${field.replaceAll("_", "-")}`, `${field} must be boolean`, label));
      valid = false;
    }
  }
  valid = validateStringArray(raw, "capabilities", errors, label) && valid;
  valid = validateStringArray(raw, "content_paths", errors, label) && valid;

  const remoteLocators = ["repository", "url", "repo"]
    .filter((field) => raw[field] !== undefined)
    .map((field) => ({ field, identity: canonicalIdentity(raw[field], "repository") }));
  const localLocator = raw.local_path === undefined ? null : canonicalIdentity(raw.local_path, "local");
  for (const locator of remoteLocators) {
    if (!locator.identity) {
      errors.push(diagnostic(`invalid-${locator.field}`, `${locator.field} must be a non-empty repository locator`, label));
      valid = false;
    }
  }
  if (raw.local_path !== undefined && !localLocator) {
    errors.push(diagnostic("invalid-local-path", "local_path must be a non-empty path", label));
    valid = false;
  }
  const remoteIdentities = new Set(remoteLocators.map((locator) => locator.identity).filter(Boolean));
  if (remoteIdentities.size > 1) {
    errors.push(diagnostic("conflicting-binding", "repository, url, and repo identify different sources", label));
    valid = false;
  }

  const identities = new Set([...remoteIdentities, ...(localLocator ? [localLocator] : [])]);
  if (!identities.size) {
    errors.push(diagnostic("missing-repository", "source must define repository, url, repo, or local_path", label));
    valid = false;
  }
  if (!valid) return null;

  const identity = remoteIdentities.values().next().value || localLocator;
  const kind = raw.kind === undefined ? "learnings" : raw.kind.trim();
  const id = label || (legacy ? slugFor(identity) : `${kind}.${slugFor(identity)}`);
  const capabilities = raw.capabilities === undefined ? DEFAULT_CAPABILITIES : raw.capabilities;
  const result = {
    ...raw,
    id,
    kind,
    ...(remoteLocators.length ? { repository: raw.repository || raw.url || raw.repo } : {}),
    scope: raw.scope === undefined ? "team" : raw.scope,
    sensitivity: raw.sensitivity === undefined ? "internal" : raw.sensitivity.trim(),
    agent_read: raw.agent_read === undefined ? true : raw.agent_read,
    activate_skills: raw.activate_skills === undefined ? false : raw.activate_skills,
    publication: raw.publication === undefined ? "disabled" : raw.publication.trim(),
    capabilities: [...capabilities],
    ...(raw.content_paths === undefined ? {} : { content_paths: [...raw.content_paths] }),
  };
  if (legacy) warnings.push(diagnostic("legacy-source", "normalized knowledge.repos entry", id));
  return { record: result, identities, explicit: !legacy };
}

function winnerOf(entries) {
  return entries.reduce((winner, candidate) => {
    const winnerProject = winner.record.scope === "project";
    const candidateProject = candidate.record.scope === "project";
    if (candidateProject !== winnerProject) return candidateProject ? candidate : winner;
    if (candidate.explicit !== winner.explicit) return candidate.explicit ? candidate : winner;
    return winner;
  });
}

/** Normalize either a full config object or its knowledge block. */
export function normalizeSources(config) {
  const root = isObject(config) && isObject(config.knowledge) ? config.knowledge : (isObject(config) ? config : {});
  const warnings = [];
  const errors = [];
  const entries = [];

  const add = (entry) => {
    const conflicts = entries.filter((existing) =>
      existing.record.id === entry.record.id || [...entry.identities].some((identity) => existing.identities.has(identity))
    );
    if (!conflicts.length) {
      entries.push(entry);
      return;
    }

    errors.push(diagnostic("conflicting-binding", "source definitions resolve to the same id or locator", entry.record.id));
    const winner = winnerOf([...conflicts, entry]);
    const combinedIdentities = new Set([...entry.identities, ...conflicts.flatMap((item) => [...item.identities])]);
    const firstIndex = Math.min(...conflicts.map((item) => entries.indexOf(item)));
    for (let index = entries.length - 1; index >= 0; index--) {
      if (conflicts.includes(entries[index])) entries.splice(index, 1);
    }
    winner.identities = combinedIdentities;
    entries.splice(Math.min(firstIndex, entries.length), 0, winner);
  };

  for (const raw of Array.isArray(root.sources) ? root.sources : []) {
    const entry = normalizeRecord(raw, false, warnings, errors);
    if (entry) add(entry);
  }
  for (const raw of Array.isArray(root.repos) ? root.repos : []) {
    const entry = normalizeRecord(raw, true, warnings, errors);
    if (entry) add(entry);
  }

  return { sources: entries.map((entry) => entry.record), warnings, errors };
}

function hasCacheRevision(meta) {
  const revisions = [meta.cache_revision, meta.cached_revision, meta.cacheRevision, meta.cache?.revision];
  return revisions.some((revision) => isNonEmptyString(revision) || Number.isFinite(revision));
}

/** Classify a source without probing it. syncMeta is metadata supplied by an adapter. */
export function getSourceHealth(source, syncMeta = {}) {
  const meta = isObject(syncMeta) ? syncMeta : {};
  const declaredState = TERMINAL_STATES.has(meta.status) ? meta.status : (TERMINAL_STATES.has(meta.state) ? meta.state : null);
  let status;
  if (declaredState) status = declaredState;
  else if (meta.failed === true || meta.error) status = "failed";
  else if (meta.inaccessible === true || meta.accessible === false) status = "inaccessible";
  else if (meta.authentication_required === true || meta.auth_required === true || meta.auth === "required") status = "authentication-required";
  else if (meta.diverged === true) status = "diverged";
  else if (meta.dirty === true) status = "dirty";
  else if (!isObject(source) || source.enabled === false || source.disabled === true || meta.disabled === true) status = "disabled";
  else if (meta.configured === false || meta.unconfigured === true) status = "unconfigured";
  else if ((meta.offline === true || meta.searched === false || meta.status === "cached-offline" || meta.state === "cached-offline") && hasCacheRevision(meta)) status = "cached-offline";
  else if (meta.offline === true || meta.searched === false || meta.status === "cached-offline" || meta.state === "cached-offline") status = "inaccessible";
  else if (meta.searched === true || meta.searchable === true || meta.ready === true || meta.status === "ready" || meta.state === "ready") status = "ready";
  else status = "unconfigured";

  return {
    status: HEALTH_STATES.has(status) ? status : "failed",
    searched: meta.searched === true || meta.searchable === true,
    ...(meta.error ? { error: meta.error } : {}),
  };
}
