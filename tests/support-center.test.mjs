// Tests for lib/support-center.mjs — Support Center pure contracts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeComponentHealth,
  makeRunId,
  makeIncidentId,
  parseSupportId,
  fingerprintBuild,
  DEFAULT_REDACT_PATTERNS,
  sanitizeSupportEvent,
  supportBundleManifest,
} from "../lib/support-center.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

await t("component health: normalizes valid shapes", async () => {
  const okRes = normalizeComponentHealth({ component: "fabric", status: "OK", detail: "reachable" });
  assert.equal(okRes.ok, true); assert.equal(okRes.value.status, "ok"); assert.equal(okRes.value.component, "fabric");
  assert.equal(normalizeComponentHealth({ component: "pbi", status: "Degraded" }).value.status, "degraded");
  const down = normalizeComponentHealth({ component: "git", status: "DOWN", checkedAt: "2026-09-12T00:00:00Z" });
  assert.equal(down.value.status, "down"); assert.equal(down.value.checkedAt, "2026-09-12T00:00:00Z");
});

await t("component health: rejects unknown status and bad input with diagnostics (F1: never throws)", async () => {
  assert.equal(normalizeComponentHealth({ component: "x", status: "weird" }).ok, false);
  assert.equal(normalizeComponentHealth(null).ok, false);
  assert.equal(normalizeComponentHealth({ status: "ok" }).ok, false);
  const cyclic = { component: "c", status: undefined }; cyclic.self = cyclic;
  const r = normalizeComponentHealth({ component: "x", status: cyclic });
  assert.equal(r.ok, false); // describe() must not throw on cycles
  // a malformed component never breaks the bundle (diagnostic preserved)
  const m = supportBundleManifest({ components: [cyclic] });
  assert.equal(m.ok, true); assert.equal(m.value.componentDiagnostics.length, 1);
});

await t("run/incident IDs: validated constructors in envelopes (F2)", async () => {
  const run = makeRunId("2026-09-12", "deadbeef");
  assert.equal(run.ok, true);
  assert.match(run.value, /^run-2026-09-12-[0-9a-f]{8}$/);
  const incident = makeIncidentId("2026-09-12", "cafebabe");
  assert.equal(incident.ok, true);
  assert.match(incident.value, /^incident-2026-09-12-[0-9a-f]{8}$/);
  assert.equal(makeRunId("12-09-2026", "deadbeef").ok, false);
  assert.equal(makeRunId("2026-09-12", "DEADBEEF").ok, false);
  assert.equal(makeIncidentId(null, "cafebabe").ok, false);
  const parsed = parseSupportId(run.value);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.kind, "run");
  assert.equal(parsed.value.date, "2026-09-12");
  assert.equal(parseSupportId("nope-2026-09-12-deadbeef").ok, false);
});

await t("build fingerprint: stable, order-independent, content-bound, validated (F3)", async () => {
  const a = fingerprintBuild({ version: "1.2.3", commit: "abc123", channel: "dev" });
  const b = fingerprintBuild({ channel: "dev", commit: "abc123", version: "1.2.3" });
  assert.equal(a.ok, true); assert.equal(a.value, b.value);
  assert.match(a.value, /^build-[0-9a-f]{8}$/);
  assert.notEqual(fingerprintBuild({ version: "1.2.4", commit: "abc123", channel: "dev" }).value, a.value);
  assert.equal(fingerprintBuild(null).ok, false);
  assert.equal(fingerprintBuild({ version: "1.2.3" }).ok, false);          // commit required
  assert.equal(fingerprintBuild({ version: "1.2.3", commit: "abc", extra: { nested: 1 } }).ok, false); // no nested content hashing
});

await t("event sanitization: defaults redact tokens/passwords/authorization; input not mutated", async () => {
  const input = { event: "login", token: "secret-token-123", password: "hunter2", Authorization: "Bearer xyz", note: "ok" };
  const clean = sanitizeSupportEvent(input);
  assert.equal(clean.ok, true);
  assert.equal(clean.value.token, "[REDACTED]");
  assert.equal(clean.value.password, "[REDACTED]");
  assert.equal(clean.value.Authorization, "[REDACTED]");
  assert.equal(clean.value.note, "ok");
  assert.equal(input.token, "secret-token-123"); // untouched
});

await t("event sanitization: null options, custom patterns, nested, non-strings (F4)", async () => {
  const clean = sanitizeSupportEvent({ inner: { ssn: "123-45-6789", keep: "yes" }, count: 7 }, null);
  assert.equal(clean.ok, true); // null options tolerated
  const withExtra = sanitizeSupportEvent({ ssn: "123-45-6789" }, { extraPatterns: ["ssn"] });
  assert.equal(withExtra.value.ssn, "[REDACTED]");
  assert.equal(clean.value.inner.keep, "yes");
  assert.equal(clean.value.count, 7);
  assert.equal(sanitizeSupportEvent(null).ok, false);
  // cyclic input is cut, not a crash
  const cyclic = { a: 1 }; cyclic.self = cyclic;
  const c = sanitizeSupportEvent(cyclic);
  assert.equal(c.ok, true);
  assert.equal(c.value.self, "[CYCLE]");
});

await t("own __proto__ key stays data (F5)", async () => {
  const event = JSON.parse('{ "__proto__": { "token": "x" }, "safe": 1 }');
  const clean = sanitizeSupportEvent(event);
  assert.equal(clean.ok, true);
  assert.equal(Object.getPrototypeOf(clean.value), Object.prototype); // prototype not mutated
  assert.deepEqual(Object.getOwnPropertyDescriptor(clean.value, "__proto__").value.token, "[REDACTED]");
  assert.equal(clean.value.safe, 1);
});

await t("default redaction list is frozen; manifests cannot be weakened (F6)", async () => {
  assert.ok(Object.isFrozen(DEFAULT_REDACT_PATTERNS));
  const before = DEFAULT_REDACT_PATTERNS.length;
  try { DEFAULT_REDACT_PATTERNS.push("never-added"); } catch { /* strict-mode throw is fine too */ }
  assert.equal(DEFAULT_REDACT_PATTERNS.length, before);
  const m = supportBundleManifest({ components: [{ component: "c", status: "ok" }] });
  assert.equal(m.value.redact.length, before);
  assert.notEqual(m.value.redact, DEFAULT_REDACT_PATTERNS); // a copy, not the frozen list
});

await t("bundle manifest: normalizes components, carries redaction list, diagnostics preserved", async () => {
  const m = supportBundleManifest({
    components: [
      { component: "fabric", status: "ok" },
      { component: "broken", status: "weird" },
      { component: "git", status: "down" },
    ],
    generatedAt: "2026-09-12T01:00:00Z",
  });
  assert.equal(m.ok, true);
  assert.equal(m.value.components.length, 2);
  assert.equal(m.value.components[1].status, "down");
  assert.equal(m.value.componentDiagnostics.length, 1);
  assert.equal(m.value.generatedAt, "2026-09-12T01:00:00Z");
  assert.equal(supportBundleManifest({ components: "nope" }).ok, false);
  assert.equal(supportBundleManifest(null).ok, false);
});

await t("no I/O or time imports in the contract module", async () => {
  const src = readFileSync(new URL("../lib/support-center.mjs", import.meta.url), "utf8");
  assert.ok(!/node:(fs|os|path|child_process|crypto)/.test(src), "pure contracts must not import I/O modules");
});

console.log(`  ${n} support-center tests passed`);
