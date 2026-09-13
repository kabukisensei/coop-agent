import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesktopReleaseReport, validateReleaseEvidence, validateReleaseRequirements } from "../scripts/desktop-release-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const requirements = readJson("config/desktop-release-requirements.json");
const parity = readJson("config/desktop-parity.json");
const releaseManifest = readJson("config/release-manifest.json");
const revision = "a".repeat(40);
const now = Date.parse("2026-09-05T18:00:00.000Z");
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`  ✓ ${name}`); }
function evidence(platform, status = "pass", overrides = {}) {
  return {
    schemaVersion: 1,
    revision,
    platform,
    generatedAt: "2026-09-05T17:00:00.000Z",
    runId: `ci-${platform}-123`,
    results: requirements.requirements.filter((item) => item.platforms.includes(platform)).map((item) => ({
      id: item.id,
      status,
      evidence: `artifact://${platform}/${item.id}`,
      sha256: createHash("sha256").update(`${platform}:${item.id}`).digest("hex"),
    })),
    ...overrides,
  };
}

await test("release requirement, evidence, and report schemas are checked in and strict", () => {
  for (const path of ["config/desktop-release-requirements.schema.json", "config/desktop-release-evidence.schema.json", "config/desktop-release-report.schema.json"]) {
    const schema = readJson(path);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
  }
  assert.equal(validateReleaseRequirements(requirements).requirements.length, 20);
});

await test("the current honest parity manifest produces a machine-readable blocked report", () => {
  const report = buildDesktopReleaseReport({ revision, evidence: [], now, requirements, parity, releaseManifest });
  assert.equal(report.ready, false);
  assert.equal(report.summary.protocol, "pass");
  assert.equal(report.summary.parity, "blocked");
  assert.equal(report.summary.evidence, "blocked");
  assert.ok(report.blockers.some((item) => item.kind === "parity" && item.id === "coop.session.tree.checkout"));
  assert.ok(report.blockers.some((item) => item.kind === "evidence" && item.platform === "windows"));
});

await test("complete current-revision evidence passes only when protocol and parity also pass", () => {
  const implementedParity = structuredClone(parity);
  for (const entry of implementedParity.entries) entry.desktopState = "implemented";
  const report = buildDesktopReleaseReport({ revision, evidence: [evidence("windows"), evidence("macos")], now, requirements, parity: implementedParity, releaseManifest });
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  const drift = buildDesktopReleaseReport({ revision, evidence: [evidence("windows"), evidence("macos")], now, requirements, parity: implementedParity, releaseManifest, protocolVersion: "0.0.0" });
  assert.equal(drift.ready, false);
  assert.equal(drift.summary.protocol, "blocked");
});

await test("wrong revisions, expired evidence, duplicate platforms, and incomplete results fail closed", () => {
  const requirementsById = new Map(requirements.requirements.map((item) => [item.id, item]));
  assert.throws(() => validateReleaseEvidence(evidence("windows", "pass", { revision: "b".repeat(40) }), { revision, now, maxAgeHours: 72, requirementsById }), /stale/);
  assert.throws(() => validateReleaseEvidence(evidence("windows", "pass", { generatedAt: "2026-09-01T00:00:00.000Z" }), { revision, now, maxAgeHours: 72, requirementsById }), /expired/);
  const wrongPlatform = evidence("windows");
  wrongPlatform.results.push({ id: "journey.platform-limited-powerbi", status: "pass", evidence: "artifact://wrong-platform", sha256: "f".repeat(64) });
  assert.throws(() => validateReleaseEvidence(wrongPlatform, { revision, now, maxAgeHours: 72, requirementsById }), /invalid/);
  assert.throws(() => buildDesktopReleaseReport({ revision, evidence: [evidence("windows"), evidence("windows")], now, requirements, parity, releaseManifest }), /Duplicate/);
  const implementedParity = structuredClone(parity);
  for (const entry of implementedParity.entries) entry.desktopState = "implemented";
  const partial = evidence("windows");
  partial.results = partial.results.slice(1);
  const report = buildDesktopReleaseReport({ revision, evidence: [partial, evidence("macos")], now, requirements, parity: implementedParity, releaseManifest });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((item) => item.kind === "evidence" && item.platform === "windows"));
});

console.log(`desktop release gate: ${count} tests passed`);
