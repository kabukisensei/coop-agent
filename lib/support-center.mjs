/** Support Center pure contracts — normalized shapes only, no I/O.
 *
 * Every function validates its input and returns diagnostics instead of
 * throwing, so a partially-broken host can still emit a sanitized support
 * bundle. Dates/times are injected by the caller; nothing here reads the
 * clock or the filesystem.
 */

const ok = (value) => ({ ok: true, value });
const diag = (errors) => ({ ok: false, errors });
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNonEmptyString = (x) => typeof x === "string" && x.length > 0;

const HEALTH_STATUSES = new Set(["ok", "degraded", "down"]);

export const normalizeComponentHealth = (input) => {
  if (!isObject(input)) return diag(["component-health: input must be an object"]);
  const errors = [];
  if (!isNonEmptyString(input.component)) errors.push("component-health: component is required");
  const status = typeof input.status === "string" ? input.status.toLowerCase() : "";
  if (!HEALTH_STATUSES.has(status)) errors.push(`component-health: status must be one of ok|degraded|down (got ${JSON.stringify(input.status)})`);
  if (errors.length) return diag(errors);
  const value = { component: input.component, status };
  if (isNonEmptyString(input.detail)) value.detail = input.detail;
  if (isNonEmptyString(input.checkedAt)) value.checkedAt = input.checkedAt;
  return ok(value);
};

/** Run/incident ID scheme: <kind>-<YYYY-MM-DD>-<8 lowercase hex>.
 *  Hex is caller-supplied (e.g. from a hash or sequence); this module never
 *  reads the clock or random sources. */
export const makeRunId = (date, hex) => `run-${date}-${hex}`;
export const makeIncidentId = (date, hex) => `incident-${date}-${hex}`;

export const parseSupportId = (id) => {
  if (!isNonEmptyString(id)) return diag(["support-id: must be a non-empty string"]);
  const match = /^(run|incident)-(\d{4}-\d{2}-\d{2})-([0-9a-f]{8})$/.exec(id);
  if (!match) return diag([`support-id: malformed ${JSON.stringify(id)}`]);
  return ok({ kind: match[1], date: match[2], hex: match[3] });
};

/** Build fingerprint: stable content hash of the identifying fields,
 *  order-independent. Unavailable inputs fingerprint as build-unavailable
 *  (never a guessed value). */
export const fingerprintBuild = (build) => {
  if (!isObject(build) || !isNonEmptyString(build.version) || !isNonEmptyString(build.commit)) {
    return "build-unavailable";
  }
  const keys = Object.keys(build).filter((k) => build[k] !== undefined).sort();
  let h1 = 0x811c9dc5 >>> 0;
  const feed = (str) => {
    for (let i = 0; i < str.length; i++) {
      h1 ^= str.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    h1 ^= 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  };
  for (const k of keys) feed(`${k}=${String(build[k])}`);
  return `build-${h1.toString(16).padStart(8, "0")}`;
};

export const DEFAULT_REDACT_PATTERNS = ["token", "password", "authorization", "secret", "apikey", "api_key", "credential"];

const matchesPattern = (key, patterns) => {
  const lower = key.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
};

const sanitizeValue = (value, patterns) => {
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, patterns));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = matchesPattern(k, patterns) ? "[REDACTED]" : sanitizeValue(v, patterns);
    }
    return out;
  }
  return value;
};

/** Sanitized event record: deep-copies the event with any key matching the
 *  redaction list (defaults + caller extras) replaced by [REDACTED].
 *  Non-matching values (numbers, booleans, nested objects) pass through. */
export const sanitizeSupportEvent = (event, options = {}) => {
  if (!isObject(event)) return diag(["support-event: input must be an object"]);
  const extras = Array.isArray(options.extraPatterns) ? options.extraPatterns.filter(isNonEmptyString) : [];
  return ok(sanitizeValue(event, [...DEFAULT_REDACT_PATTERNS, ...extras]));
};

/** Bundle manifest: normalized component list + default redaction list,
 *  with per-component diagnostics preserved (a broken component never
 *  breaks the bundle). */
export const supportBundleManifest = (input) => {
  if (!isObject(input) || !Array.isArray(input.components)) {
    return diag(["bundle-manifest: components must be an array"]);
  }
  const components = [];
  const componentDiagnostics = [];
  for (const entry of input.components) {
    const normalized = normalizeComponentHealth(entry);
    if (normalized.ok) components.push(normalized.value);
    else componentDiagnostics.push({ input: entry, errors: normalized.errors });
  }
  const manifest = { components, componentDiagnostics, redact: [...DEFAULT_REDACT_PATTERNS] };
  if (isNonEmptyString(input.generatedAt)) manifest.generatedAt = input.generatedAt;
  if (isNonEmptyString(input.build)) manifest.build = input.build;
  return ok(manifest);
};
