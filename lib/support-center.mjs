/** Support Center pure contracts — normalized shapes only, no I/O.
 *
 * Every function validates its input and returns a result envelope
 * ({ok:true, value} | {ok:false, errors}) instead of throwing, so a
 * partially-broken host can still emit a sanitized support bundle. Dates,
 * entropy, and hashes are injected by the caller; nothing here reads the
 * clock, randomness, or the filesystem.
 */

const ok = (value) => ({ ok: true, value });
const diag = (errors) => ({ ok: false, errors });
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNonEmptyString = (x) => typeof x === "string" && x.length > 0;
const isPrimitive = (x) => x === null || ["string", "number", "boolean"].includes(typeof x);

/** Safe string for diagnostics: never throws, even on hostile objects whose
 *  toJSON / Symbol.toStringTag getters throw. */
const describe = (x) => {
  if (isPrimitive(x)) return JSON.stringify(x) ?? String(x);
  try { return JSON.stringify(x); } catch { /* fall through */ }
  try { return Object.prototype.toString.call(x); } catch { return "[unprintable value]"; }
};

const HEALTH_STATUSES = new Set(["ok", "degraded", "down"]);

export const normalizeComponentHealth = (input) => {
  if (!isObject(input)) return diag(["component-health: input must be an object"]);
  const errors = [];
  if (!isNonEmptyString(input.component)) errors.push("component-health: component is required");
  const status = typeof input.status === "string" ? input.status.toLowerCase() : "";
  if (!HEALTH_STATUSES.has(status)) errors.push(`component-health: status must be one of ok|degraded|down (got ${describe(input.status)})`);
  if (errors.length) return diag(errors);
  const value = { component: input.component, status };
  if (isNonEmptyString(input.detail)) value.detail = input.detail;
  if (isNonEmptyString(input.checkedAt)) value.checkedAt = input.checkedAt;
  return ok(value);
};

const ID_KINDS = { run: "run", incident: "incident" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX8_RE = /^[0-9a-f]{8}$/;

/** Run/incident ID constructors: validate format, return envelopes.
 *  The module never generates entropy; hex is caller-supplied. */
const makeSupportId = (kind) => (date, hex) => {
  const errors = [];
  // typeof guards BEFORE RegExp.test: coercing exotic values (Symbol,
  // null-prototype objects) through .test can throw (F2).
  if (typeof date !== "string" || !DATE_RE.test(date)) errors.push(`${kind}-id: date must be YYYY-MM-DD (got ${describe(date)})`);
  if (typeof hex !== "string" || !HEX8_RE.test(hex)) errors.push(`${kind}-id: hex must be 8 lowercase hex chars (got ${describe(hex)})`);
  if (errors.length) return diag(errors);
  return ok(`${ID_KINDS[kind]}-${date}-${hex}`);
};
export const makeRunId = makeSupportId("run");
export const makeIncidentId = makeSupportId("incident");

export const parseSupportId = (id) => {
  if (!isNonEmptyString(id)) return diag(["support-id: must be a non-empty string"]);
  const match = /^(run|incident)-(\d{4}-\d{2}-\d{2})-([0-9a-f]{8})$/.exec(id);
  if (!match) return diag([`support-id: malformed ${describe(id)}`]);
  return ok({ kind: match[1], date: match[2], hex: match[3] });
};

/** Build fingerprint: stable content hash over primitive identifying fields,
 *  order-independent. Missing/non-primitive identifying fields are a
 *  diagnostic (never a guessed fingerprint). */
export const fingerprintBuild = (build) => {
  if (!isObject(build)) return { ok: false, errors: ["build-fingerprint: input must be an object"], value: "build-unavailable" };
  if (!isNonEmptyString(build.version)) return { ok: false, errors: ["build-fingerprint: version is required"], value: "build-unavailable" };
  if (!isNonEmptyString(build.commit)) return { ok: false, errors: ["build-fingerprint: commit is required"], value: "build-unavailable" };
  const keys = Object.keys(build).filter((k) => build[k] !== undefined).sort();
  for (const k of keys) {
    if (!isPrimitive(build[k])) return diag([`build-fingerprint: field ${describe(k)} must be a string, number, boolean, or null (nested content is not hashed)`]);
  }
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
  return ok(`build-${h1.toString(16).padStart(8, "0")}`);
};

/** Frozen default redaction list — callers cannot weaken mandatory redaction. */
export const DEFAULT_REDACT_PATTERNS = Object.freeze(["token", "password", "authorization", "secret", "apikey", "api_key", "credential"]);

const matchesPattern = (key, patterns) => {
  const lower = key.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
};

/** Prototype-safe assignment: an own "__proto__" key becomes data, not a
 *  prototype mutation. */
const setOwn = (obj, key, value) => {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
};

const sanitizeValue = (value, patterns, seen) => {
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CYCLE]";
    seen.add(value);
    const out = value.map((v) => sanitizeValue(v, patterns, seen));
    seen.delete(value);
    return out;
  }
  if (isObject(value)) {
    if (seen.has(value)) return "[CYCLE]";
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      setOwn(out, k, matchesPattern(k, patterns) ? "[REDACTED]" : sanitizeValue(v, patterns, seen));
    }
    seen.delete(value);
    return out;
  }
  return describe(value); // functions/symbols/bigint: inert string form
};

/** Sanitized event record: deep copy with any key matching the redaction
 *  list (defaults + caller extras) replaced by [REDACTED]. Cyclic structures
 *  are cut with [CYCLE]; the input object is never mutated. */
export const sanitizeSupportEvent = (event, options) => {
  if (!isObject(event)) return diag(["support-event: input must be an object"]);
  const opts = isObject(options) ? options : {};
  const extras = Array.isArray(opts.extraPatterns) ? opts.extraPatterns.filter(isNonEmptyString) : [];
  return ok(sanitizeValue(event, [...DEFAULT_REDACT_PATTERNS, ...extras], new Set()));
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
