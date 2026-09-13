#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_PROTOCOL_VERSION } from "../web/protocol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVISION = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const PLATFORMS = new Set(["windows", "macos"]);
const KINDS = new Set(["test-suite", "journey", "manual-interoperability", "distribution", "quality"]);
const STATUSES = new Set(["pass", "fail", "skipped"]);

function fail(message) { throw new Error(message); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(`${label} fields are invalid.`);
}
function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail(`${label} is missing or invalid.`); }
}
function isoTime(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(`${label} is invalid.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(`${label} is invalid.`);
  return time;
}

export function validateReleaseRequirements(value) {
  exactKeys(value, ["schemaVersion", "evidenceMaxAgeHours", "requirements"], "Release requirements");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.evidenceMaxAgeHours) || value.evidenceMaxAgeHours < 1 || value.evidenceMaxAgeHours > 168 || !Array.isArray(value.requirements) || value.requirements.length < 1) fail("Release requirements contract is invalid.");
  const seen = new Set();
  for (const requirement of value.requirements) {
    exactKeys(requirement, ["id", "kind", "platforms"], "Release requirement");
    if (!ID.test(requirement.id || "") || seen.has(requirement.id) || !KINDS.has(requirement.kind) || !Array.isArray(requirement.platforms) || requirement.platforms.length < 1 || new Set(requirement.platforms).size !== requirement.platforms.length || requirement.platforms.some((platform) => !PLATFORMS.has(platform))) fail(`Release requirement ${requirement.id || "<missing>"} is invalid.`);
    seen.add(requirement.id);
  }
  return structuredClone(value);
}

export function validateReleaseEvidence(value, { revision, now, maxAgeHours, requirementsById } = {}) {
  exactKeys(value, ["schemaVersion", "revision", "platform", "generatedAt", "runId", "results"], "Release evidence");
  if (value.schemaVersion !== 1 || !REVISION.test(value.revision || "") || value.revision !== revision || !PLATFORMS.has(value.platform) || typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.runId) || !Array.isArray(value.results)) fail("Release evidence identity is invalid or stale.");
  const generatedAt = isoTime(value.generatedAt, "Release evidence generatedAt");
  if (generatedAt > now + 5 * 60 * 1000 || now - generatedAt > maxAgeHours * 60 * 60 * 1000) fail("Release evidence is expired or from the future.");
  const seen = new Set();
  for (const result of value.results) {
    exactKeys(result, ["id", "status", "evidence", "sha256"], "Release evidence result");
    const requirement = requirementsById.get(result.id);
    if (!requirement || !requirement.platforms.includes(value.platform) || seen.has(result.id) || !STATUSES.has(result.status) || typeof result.evidence !== "string" || result.evidence.length < 1 || result.evidence.length > 1000 || !HASH.test(result.sha256 || "")) fail(`Release evidence result ${result.id || "<missing>"} is invalid.`);
    seen.add(result.id);
  }
  return structuredClone(value);
}

export function buildDesktopReleaseReport({ revision, evidence = [], now = Date.now(), requirements, parity, releaseManifest, protocolVersion = PI_PROTOCOL_VERSION } = {}) {
  if (!REVISION.test(revision || "")) fail("Release revision must be an exact 40-character lowercase Git object ID.");
  const requirementContract = validateReleaseRequirements(requirements);
  if (!parity || parity.schemaVersion !== 1 || !Array.isArray(parity.entries) || !releaseManifest?.pi?.version) fail("Parity or release manifest is invalid.");
  const requirementsById = new Map(requirementContract.requirements.map((item) => [item.id, item]));
  const documents = evidence.map((document) => validateReleaseEvidence(document, { revision, now, maxAgeHours: requirementContract.evidenceMaxAgeHours, requirementsById }));
  const evidenceByPlatform = new Map();
  for (const document of documents) {
    if (evidenceByPlatform.has(document.platform)) fail(`Duplicate release evidence for ${document.platform}.`);
    evidenceByPlatform.set(document.platform, document);
  }

  const checks = [];
  const blockers = [];
  const protocolPass = protocolVersion === releaseManifest.pi.version;
  checks.push({ id: "protocol.pi-version", status: protocolPass ? "pass" : "blocked", expected: releaseManifest.pi.version, actual: protocolVersion });
  if (!protocolPass) blockers.push({ kind: "protocol", id: "protocol.pi-version", message: "Pinned Pi and verified protocol versions differ." });

  for (const entry of parity.entries) {
    if (!entry.releaseGate) continue;
    const satisfied = entry.desktopState === "implemented" || entry.desktopState === "not-applicable" || entry.fallback?.approved === true;
    checks.push({ id: `parity.${entry.capabilityId}`, status: satisfied ? "pass" : "blocked", platforms: entry.requiredPlatforms });
    if (!satisfied) blockers.push({ kind: "parity", id: entry.capabilityId, message: `Desktop state is ${entry.desktopState}.` });
  }

  for (const requirement of requirementContract.requirements) {
    for (const platform of requirement.platforms) {
      const document = evidenceByPlatform.get(platform);
      const result = document?.results.find((candidate) => candidate.id === requirement.id);
      const passed = result?.status === "pass";
      checks.push({ id: requirement.id, platform, kind: requirement.kind, status: passed ? "pass" : "blocked", runId: document?.runId || null, evidence: result?.evidence || null, sha256: result?.sha256 || null });
      if (!passed) blockers.push({ kind: "evidence", id: requirement.id, platform, message: result ? `Result is ${result.status}.` : "No current revision-bound evidence." });
    }
  }

  const parityPass = !blockers.some((item) => item.kind === "parity");
  const evidencePass = !blockers.some((item) => item.kind === "evidence");
  return Object.freeze({
    schemaVersion: 1,
    revision,
    generatedAt: new Date(now).toISOString(),
    ready: blockers.length === 0,
    summary: Object.freeze({ parity: parityPass ? "pass" : "blocked", protocol: protocolPass ? "pass" : "blocked", evidence: evidencePass ? "pass" : "blocked" }),
    checks: Object.freeze(checks),
    blockers: Object.freeze(blockers),
  });
}

function parseArgs(argv) {
  const result = { evidence: [], enforce: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--enforce") { result.enforce = true; continue; }
    if (!new Set(["--revision", "--evidence"]).has(key) || !argv[index + 1]) fail(`Unknown or incomplete argument: ${key || "<missing>"}.`);
    if (key === "--revision") result.revision = argv[++index];
    else result.evidence.push(resolve(argv[++index]));
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = buildDesktopReleaseReport({
      revision: options.revision,
      evidence: options.evidence.map((path) => readJson(path, `Release evidence ${path}`)),
      requirements: readJson(resolve(ROOT, "config", "desktop-release-requirements.json"), "Release requirements"),
      parity: readJson(resolve(ROOT, "config", "desktop-parity.json"), "Desktop parity manifest"),
      releaseManifest: readJson(resolve(ROOT, "config", "release-manifest.json"), "Release manifest"),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.enforce && !report.ready) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`desktop-release-gate: ${error.message}\n`);
    process.exitCode = 1;
  }
}
