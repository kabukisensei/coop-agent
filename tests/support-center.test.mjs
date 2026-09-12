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
  const ok = normalizeComponentHealth({ component: "fabric", status: "OK", detail: "reachable" });
  assert.equal(ok.ok, true); assert.equal(ok.value.status, "ok"); assert.equal(ok.value.component, "fabric");
  const degraded = normalizeComponentHealth({ component: "pbi", status: "Degraded" });
  assert.equal(degraded.value.status, "degraded");
  const down = normalizeComponentHealth({ component: "git", status: "DOWN", checkedAt: "2026-09-12T00:00:00Z" });
  assert.equal(down.value.status, "down"); assert.equal(down.value.checkedAt, "2026-09-12T00:00:00Z");
});

await t("component health: rejects unknown status and bad input with diagnostics", async () => {
  assert.equal(normalizeComponentHealth({ component: "x", status: "weird" }).ok, false);
  assert.equal(normalizeComponentHealth(null).ok, false);
  assert.equal(normalizeComponentHealth({ status: "ok" }).ok, false); // component required
});

await t("run/incident IDs: scheme is stable and round-trips", async () => {
  const run = makeRunId("2026-09-12", "deadbeef");
  assert.match(run, /^run-2026-09-12-[0-9a-f]{8}$/);
  const incident = makeIncidentId("2026-09-12", "cafebabe");
  assert.match(incident, /^incident-2026-09-12-[0-9a-f]{8}$/);
  const parsed = parseSupportId(run);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.kind, "run");
  assert.equal(parsed.value.date, "2026-09-12");
  assert.equal(parseSupportId("nope-2026-09-12-deadbeef").ok, false);
  assert.equal(parseSupportId("run-2026-09-12-deadbeef").ok, true);
});

await t("build fingerprint: stable, order-independent, content-bound", async () => {
  const a = fingerprintBuild({ version: "1.2.3", commit: "abc123", channel: "dev" });
  const b = fingerprintBuild({ channel: "dev", commit: "abc123", version: "1.2.3" });
  assert.equal(a, b);
  assert.match(a, /^build-[0-9a-f]{8}$/);
  assert.notEqual(fingerprintBuild({ version: "1.2.4", commit: "abc123", channel: "dev" }), a);
  assert.equal(fingerprintBuild(null).startsWith("build-unavailable"), true);
});

await t("event sanitization: defaults redact tokens/passwords/authorization", async () => {
  const clean = sanitizeSupportEvent({ event: "login", token: "secret-token-123", password: "hunter2", Authorization: "Bearer xyz", note: "ok" });
  assert.equal(clean.ok, true);
  assert.equal(clean.value.token, "[REDACTED]");
  assert.equal(clean.value.password, "[REDACTED]");
  assert.equal(clean.value.Authorization, "[REDACTED]");
  assert.equal(clean.value.note, "ok");
});

await t("event sanitization: custom patterns + nested + non-string values", async () => {
  const clean = sanitizeSupportEvent(
    { inner: { ssn: "123-45-6789", keep: "yes" }, count: 7 },
    { extraPatterns: ["ssn"] }
  );
  assert.equal(clean.value.inner.ssn, "[REDACTED]");
  assert.equal(clean.value.inner.keep, "yes");
  assert.equal(clean.value.count, 7);
  assert.equal(sanitizeSupportEvent(null).ok, false);
});

await t("default redaction list is non-empty and includes token/password/authorization", async () => {
  assert.ok(DEFAULT_REDACT_PATTERNS.length >= 3);
  for (const p of ["token", "password", "authorization"]) assert.ok(DEFAULT_REDACT_PATTERNS.includes(p));
});

await t("bundle manifest: normalizes components, carries redaction list, diagnostics preserved", async () => {
  const m = supportBundleManifest({
    components: [
      { component: "fabric", status: "ok" },
      { component: "broken", status: "weird" },   // becomes a diagnostic
      { component: "git", status: "down" },
    ],
    generatedAt: "2026-09-12T01:00:00Z",
  });
  assert.equal(m.ok, true);
  assert.equal(m.value.components.length, 2);
  assert.equal(m.value.components[1].status, "down");
  assert.equal(m.value.componentDiagnostics.length, 1);
  assert.deepEqual(m.value.redact, DEFAULT_REDACT_PATTERNS);
  assert.equal(m.value.generatedAt, "2026-09-12T01:00:00Z");
  assert.equal(supportBundleManifest({ components: "nope" }).ok, false);
});

await t("no I/O or time imports in the contract module", async () => {
  const src = readFileSync(new URL("../lib/support-center.mjs", import.meta.url), "utf8");
  assert.ok(!/node:(fs|os|path|child_process|crypto)/.test(src), "pure contracts must not import I/O modules");
});

console.log(`  ${n} support-center tests passed`);
