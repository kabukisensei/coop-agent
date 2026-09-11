/** Canonical, side-effect-free knowledge source registry. */

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 2;

const DEFAULT_CAPABILITIES = ["browse", "agent-read"];
const HEALTH_STATES = new Set([
  "ready", "cached-offline", "disabled", "unconfigured", "authentication-required",
  "inaccessible", "dirty", "diverged", "failed",
]);
const TERMINAL_STATES = new Set([
  "failed", "inaccessible", "authentication-required", "diverged", "dirty", "disabled", "unconfigured",
]);
const SCOPE_RESTRICTION = new Map([["project", 0], ["team", 1], ["public", 2]]);

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

function hashFor(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function diagnostic(code, message, source) {
  return `${code}: ${message}${source ? ` (${source})` : ""}`;
}

function definitionIdentities(raw) {
  if (!isObject(raw)) return new Set();
  const identities = new Set();
  for (const field of ["repository", "url", "repo"]) {
    const identity = canonicalIdentity(raw[field], "repository");
    if (identity) identities.add(identity);
  }
  const localIdentity = canonicalIdentity(raw.local_path, "local");
  if (localIdentity) identities.add(localIdentity);
  return identities;
}

function narrowerScope(left, right) {
  return SCOPE_RESTRICTION.get(left) <= SCOPE_RESTRICTION.get(right) ? left : right;
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

function normalizeRecord(raw, legacy, configEnabled, warnings, errors, blockedIdentities) {
  if (!isObject(raw)) {
    errors.push(diagnostic("invalid-source", "source definition must be an object"));
    return null;
  }

  const label = isNonEmptyString(raw.id) ? raw.id.trim() : undefined;
  const rawIdentities = definitionIdentities(raw);
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
  for (const field of ["enabled", "disabled"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "boolean") {
      errors.push(diagnostic(`invalid-${field}`, `${field} must be a boolean; excluding source`, label));
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
  if (!valid) {
    if (!legacy && blockedIdentities) {
      for (const identity of rawIdentities) blockedIdentities.add(identity);
    }
    return null;
  }

  const identity = remoteIdentities.values().next().value || localLocator;
  const kind = raw.kind === undefined ? "learnings" : raw.kind.trim();
  const generatedSlug = legacy ? slugFor(identity) : `${kind}.${slugFor(identity)}`;
  const id = label || `${generatedSlug}--${hashFor(identity)}`;
  const capabilities = raw.capabilities === undefined ? DEFAULT_CAPABILITIES : raw.capabilities;
  const result = {
    ...raw,
    id,
    kind,
    configEnabled,
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
  return { record: result, identities, identityKey: identity, explicit: !legacy, explicitId: Boolean(label), generatedId: !label };
}

function claimIdentityKey(raw, index) {
  const remoteIdentity = ["repository", "url", "repo"]
    .map((field) => canonicalIdentity(raw[field], "repository"))
    .find(Boolean);
  return remoteIdentity || canonicalIdentity(raw.local_path, "local") || `invalid:${index}`;
}

function winnerOf(entries) {
  return entries.reduce((winner, candidate) => {
    if (candidate.explicit !== winner.explicit) return candidate.explicit ? candidate : winner;
    if (candidate.explicit) {
      const winnerDisabled = winner.record.enabled === false || winner.record.disabled === true;
      const candidateDisabled = candidate.record.enabled === false || candidate.record.disabled === true;
      if (candidateDisabled !== winnerDisabled) return candidateDisabled ? candidate : winner;
    }
    const winnerProject = winner.record.scope === "project";
    const candidateProject = candidate.record.scope === "project";
    if (candidateProject !== winnerProject) return candidateProject ? candidate : winner;
    return winner;
  });
}

/** Normalize either a full config object or its knowledge block.
 * Explicit v2 `sources` definitions are DISABLED by default for the
 * September 20 candidate (post-freeze hardening re-enables them via
 * { allowV2Definitions: true } after generalized review). */
export function normalizeSources(config, options = {}) {
  const root = isObject(config) && isObject(config.knowledge) ? config.knowledge : (isObject(config) ? config : {});
  const warnings = [];
  const errors = [];
  let configEnabled = true;
  if (root.enabled !== undefined) {
    if (typeof root.enabled === "boolean") {
      configEnabled = root.enabled;
    } else {
      errors.push(diagnostic("invalid-enabled", "knowledge.enabled must be a boolean; treating as disabled"));
      configEnabled = false;
    }
  }
  if (root.disabled !== undefined) {
    if (typeof root.disabled === "boolean") {
      configEnabled = configEnabled && !root.disabled;
    } else {
      errors.push(diagnostic("invalid-disabled", "knowledge.disabled must be a boolean; treating as disabled"));
      configEnabled = false;
    }
  }
  const entries = [];
  const blockedIdentities = new Set();
  const conflictBlockedIdentities = new Set();
  const identityRestrictions = new Map(); // keyed by union-find class root
  const v2DisabledIdentities = new Set();
  // Union-find over identities: every definition declares its identities as
  // aliases of ONE source, so restrictions and disabled marks propagate across
  // explicitly connected repository/local-path bindings — including bindings
  // declared only by gated (disabled-by-default) v2 definitions.
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== cur) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const v2Definitions = Array.isArray(root.sources) ? root.sources : [];
  const allowV2 = options.allowV2Definitions === true;
  const sourceDefinitions = allowV2 ? v2Definitions : [];
  if (!allowV2 && v2Definitions.length > 0) {
    errors.push(diagnostic("v2-definitions-disabled", "explicit v2 source definitions are disabled for the September 20 candidate; entries ignored"));
  }
  const legacyDefinitions = Array.isArray(root.repos) ? root.repos : [];

  // Scope restrictions belong to identities, not to whichever definition wins.
  // Record them before validation or reconciliation so malformed and excluded
  // definitions cannot be used to broaden an identity later in this pass.
  // Gated v2 definitions STILL contribute restrictions and disabled marks:
  // an identity declared project-scoped or disabled by any v2 definition keeps
  // those restrictions for legacy reconciliation (no reappearance widened).
  // Phase 1: build complete alias classes first. Unions must ALL happen before
  // any restriction/disabled writes, or a later union re-roots a class and
  // strands the restrictions accumulated under the old root.
  const allDefinitions = [...v2Definitions, ...legacyDefinitions];
  for (const raw of allDefinitions) {
    if (!isObject(raw)) continue;
    const identities = [...definitionIdentities(raw)];
    for (let i = 1; i < identities.length; i++) union(identities[0], identities[i]);
  }
  // Phase 2: contribute restrictions and disabled marks under final roots.
  for (const raw of allDefinitions) {
    const restriction = isObject(raw) && SCOPE_RESTRICTION.has(raw.scope) ? raw.scope : "team";
    const identities = isObject(raw) ? [...definitionIdentities(raw)] : [];
    for (const identity of identities) {
      const root = find(identity);
      const existing = identityRestrictions.get(root);
      identityRestrictions.set(root, existing === undefined ? restriction : narrowerScope(existing, restriction));
      if (isObject(raw) && (raw.enabled === false || raw.disabled === true)) v2DisabledIdentities.add(root);
      if (isObject(raw) && ((raw.enabled !== undefined && typeof raw.enabled !== "boolean") || (raw.disabled !== undefined && typeof raw.disabled !== "boolean"))) v2DisabledIdentities.add(root);
    }
  }

  // Explicit ids are claims, including claims made by malformed definitions.
  // Collect the complete claim set before reconciliation so a discarded entry
  // cannot make its id available to a definition encountered later.
  const explicitClaims = new Map();
  for (let index = 0; index < sourceDefinitions.length; index++) {
    const raw = sourceDefinitions[index];
    if (!isObject(raw) || !isNonEmptyString(raw.id)) continue;
    const id = raw.id.trim();
    const identities = explicitClaims.get(id) || new Set();
    identities.add(claimIdentityKey(raw, index));
    explicitClaims.set(id, identities);
  }
  const conflictingExplicitIds = new Set();
  for (const [id, identities] of explicitClaims) {
    if (identities.size < 2) continue;
    conflictingExplicitIds.add(id);
    errors.push(diagnostic("conflicting-binding", "explicit id is claimed by multiple source identities", id));
    for (const raw of sourceDefinitions) {
      if (isObject(raw) && isNonEmptyString(raw.id) && raw.id.trim() === id) {
        for (const identity of definitionIdentities(raw)) conflictBlockedIdentities.add(identity);
      }
    }
  }

  for (const field of ["sources", "repos"]) {
    if (root[field] !== undefined && !Array.isArray(root[field])) {
      errors.push(diagnostic(`invalid-${field}`, `${field} must be an array`));
    }
  }

  const add = (entry) => {
    const conflicts = entries.filter((existing) =>
      [...entry.identities].some((identity) => existing.identities.has(identity))
      // An explicit id is a binding too.  Compare it with every existing
      // record, including legacy records whose generated id happens to match.
      || ((existing.explicitId || entry.explicitId) && existing.record.id === entry.record.id)
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
    winner.identityRestriction = [...combinedIdentities]
      .map((identity) => identityRestrictions.get(find(identity)) || "team")
      .reduce(narrowerScope);
    entries.splice(Math.min(firstIndex, entries.length), 0, winner);
  };

  const prepare = (entry) => {
    if (!entry) return null;
    entry.identityRestriction = [...entry.identities]
      .map((identity) => identityRestrictions.get(find(identity)) || "team")
      .reduce(narrowerScope);
    return entry;
  };

  const isConflictBlocked = (entry) => {
    if (![...entry.identities].some((identity) => conflictBlockedIdentities.has(identity))) return false;
    errors.push(diagnostic("conflicting-binding", "source identity is blocked by a conflicting explicit id", entry.record.id));
    return true;
  };

  for (const raw of sourceDefinitions) {
    const entry = prepare(normalizeRecord(raw, false, configEnabled, warnings, errors, blockedIdentities));
    if (entry && conflictingExplicitIds.has(entry.record.id)) continue;
    if (entry && isConflictBlocked(entry)) continue;
    if (entry?.generatedId && explicitClaims.has(entry.record.id)) {
      errors.push(diagnostic("conflicting-binding", "generated id is reserved by an explicit claim", entry.record.id));
    } else if (entry) add(entry);
  }
  for (const raw of legacyDefinitions) {
    const entry = prepare(normalizeRecord(raw, true, configEnabled, warnings, errors, blockedIdentities));
    if (entry && explicitClaims.has(entry.record.id)) {
      errors.push(diagnostic("conflicting-binding", "generated id is reserved by an explicit claim", entry.record.id));
    } else if (entry && isConflictBlocked(entry)) {
      continue;
    } else if (entry && ![...entry.identities].some((identity) => blockedIdentities.has(identity))) add(entry);
    else if (entry) warnings.push(diagnostic("legacy-source-suppressed", "legacy source suppressed by invalid explicit definition", entry.record.id));
  }

  const sources = [];
  for (const entry of entries) {
    const disabledByIdentity = [...entry.identities].some((identity) => v2DisabledIdentities.has(find(identity)));
    if (entry.explicit) {
      sources.push({
        ...entry.record,
        ...(disabledByIdentity ? { enabled: false } : {}),
        scope: narrowerScope(entry.record.scope, entry.identityRestriction),
      });
      continue;
    }
    if (SCOPE_RESTRICTION.get(entry.record.scope) > SCOPE_RESTRICTION.get(entry.identityRestriction)) {
      errors.push(diagnostic("scope-broadening", `scope cannot broaden identity restriction ${entry.identityRestriction}`, entry.record.id));
      continue;
    }
    sources.push(disabledByIdentity ? { ...entry.record, enabled: false } : entry.record);
  }

  return { sources, warnings, errors };
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
  if (isObject(source) && source.configEnabled === false) status = "disabled";
  else if (declaredState) status = declaredState;
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
    searched: meta.searched === true,
    ...(meta.error ? { error: meta.error } : {}),
  };
}
