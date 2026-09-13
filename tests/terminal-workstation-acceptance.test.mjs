import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "acceptance", "windows-terminal-workstation.ps1");
const SCHEMA = join(ROOT, "acceptance", "terminal-workstation-receipt.schema.json");
const WORKFLOW = join(ROOT, ".github", "workflows", "windows-terminal-workstation-acceptance.yml");
const DOC = join(ROOT, "docs", "terminal-workstation-acceptance.md");
const CANDIDATE = "295693a3eb08e9988594971d87bc4de751e6b551";
const BASELINE = "d60300780b565aabf15b172b2bc32abad12b9ca6";
const HARNESS = "1111111111111111111111111111111111111111";
const statuses = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_REACHED", "NOT_AVAILABLE", "CAPABILITY_SKIP", "BETA_LIMITATION"];
const operatorIds = [
  "fresh-candidate-install", "real-provider-auth", "real-model-response", "copied-repo-workflow",
  "decline-no-partial-write", "stop-and-continue", "reopen-resume", "teamai-failure-isolation",
  "rollback-instructions", "snapshot-recovery",
];

const pwshProbe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
const havePwsh = pwshProbe.status === 0 && !pwshProbe.error;

function runPs(args) {
  return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-File", SCRIPT, ...args], { encoding: "utf8" });
}

function evidence(observed = "redacted observation") {
  return { kind: "OPERATOR_OBSERVATION", observed, command: "human interaction", exit_code: null, identity: "operator", path: "", sha256: "" };
}

function claim(id, { status = "PASS", automated = true, human = false, phase = "PRECHECK" } = {}) {
  return { id, phase, status, required: true, automated, human_required: human, summary: `${id} observed`, evidence: [evidence()] };
}

function receipt({ ready = false, layer = "AUTOMATED_WINDOWS", humanStatus = "NOT_REACHED" } = {}) {
  return {
    schema_version: 1,
    candidate: { sha: CANDIDATE, version: "0.23.1-candidate" },
    baseline: { sha: BASELINE, version: "v0.23.1-source" },
    harness: { sha: HARNESS, version: "workstation-acceptance-harness" },
    execution: { layer, runner: "disposable-test", started_utc: "2026-09-13T00:00:00Z", finished_utc: "2026-09-13T00:01:00Z", owned_root: "C:\\owned" },
    claims: [claim("automated-core")],
    operator_evidence: operatorIds.map((id) => claim(id, { status: humanStatus, automated: false, human: true, phase: "OPERATOR" })),
    terminal_workstation_ready: ready,
  };
}

function writeReceipt(dir, value, name = "receipt.json") {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

test("receipt schema exposes only the exact evidence status vocabulary and strict identities", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  assert.deepEqual(schema.$defs.status.enum, statuses);
  assert.equal(schema.$defs.identity.properties.sha.pattern, "^[0-9a-f]{40}$");
  assert.ok(schema.required.includes("terminal_workstation_ready"));
  assert.ok(schema.allOf.length > 0, "schema must condition readiness");
  assert.equal(schema.allOf[0].then.allOf.length, 10, "schema must require every operator journey for readiness");
});

test("PowerShell parser accepts the harness", { skip: !havePwsh }, () => {
  const code = `$e=$null; [Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replaceAll("'", "''")}',[ref]$null,[ref]$e)|Out-Null; if($e){$e|%{Write-Error $_};exit 1}`;
  const r = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("strict SHA probe rejects abbreviations and accepts exact lowercase SHA", { skip: !havePwsh }, () => {
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "ValidateSha", "-Value", CANDIDATE]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "ValidateSha", "-Value", "295693a"]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "ValidateSha", "-Value", CANDIDATE.toUpperCase()]).status, 0);
});

test("owned-root probe creates an absent root and refuses an occupied root", { skip: !havePwsh }, () => {
  const parent = mkdtempSync(join(tmpdir(), "coop-acceptance-roots-"));
  const absent = join(parent, "owned");
  const first = runPs(["-Mode", "Probe", "-Probe", "AssertEmptyRoot", "-Root", absent]);
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(join(absent, "sentinel"), "occupied");
  const second = runPs(["-Mode", "Probe", "-Probe", "AssertEmptyRoot", "-Root", absent]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /refusing occupied owned root/i);
});

test("tree hashing is content-sensitive, deterministic, and ignores .git metadata", { skip: !havePwsh }, () => {
  const tree = mkdtempSync(join(tmpdir(), "coop-acceptance-hash-"));
  mkdirSync(join(tree, ".git"));
  writeFileSync(join(tree, "state.txt"), "preserved\n");
  writeFileSync(join(tree, ".git", "FETCH_HEAD"), "first");
  const one = runPs(["-Mode", "Probe", "-Probe", "HashTree", "-Root", tree]);
  assert.equal(one.status, 0, one.stderr);
  writeFileSync(join(tree, ".git", "FETCH_HEAD"), "changed metadata");
  const two = runPs(["-Mode", "Probe", "-Probe", "HashTree", "-Root", tree]);
  assert.equal(two.stdout.trim(), one.stdout.trim());
  writeFileSync(join(tree, "state.txt"), "mutated\n");
  const three = runPs(["-Mode", "Probe", "-Probe", "HashTree", "-Root", tree]);
  assert.notEqual(three.stdout.trim(), one.stdout.trim());
});

test("exact canary scan passes sanitized evidence and fails closed on a planted value", { skip: !havePwsh }, () => {
  const tree = mkdtempSync(join(tmpdir(), "coop-acceptance-canary-"));
  const canary = "PLANTED-CANARY-for-behavior-test";
  writeFileSync(join(tree, "clean.json"), '{"api_key":"[REDACTED]"}');
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "ScanCanary", "-Root", tree, "-Canary", canary]).status, 0);
  writeFileSync(join(tree, "bad.log"), `leaked=${canary}`);
  const leaked = runPs(["-Mode", "Probe", "-Probe", "ScanCanary", "-Root", tree, "-Canary", canary]);
  assert.notEqual(leaked.status, 0);
  assert.match(leaked.stderr, /credential canary found/i);
});

test("automated receipts remain non-ready and preserve distinct fixed identities", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-acceptance-receipt-"));
  const path = writeReceipt(dir, receipt());
  const valid = runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", path]);
  assert.equal(valid.status, 0, valid.stderr);
  const evaluated = runPs(["-Mode", "Probe", "-Probe", "EvaluateReadiness", "-ReceiptPath", path]);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.stdout.trim(), "false");
});

test("readiness is rejected for automated layer or missing human evidence", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-acceptance-gate-"));
  const automatedReady = writeReceipt(dir, receipt({ ready: true, layer: "AUTOMATED_WINDOWS", humanStatus: "PASS" }), "automated.json");
  assert.notEqual(runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", automatedReady]).status, 0);

  const incomplete = receipt({ ready: true, layer: "DISPOSABLE_VM_OPERATOR", humanStatus: "PASS" });
  incomplete.operator_evidence.find((x) => x.id === "real-model-response").status = "INCONCLUSIVE";
  const incompletePath = writeReceipt(dir, incomplete, "incomplete.json");
  const r = runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", incompletePath]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /real-model-response/);
});

test("readiness requires and accepts all ten redacted disposable-VM observations", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-acceptance-human-"));
  const path = writeReceipt(dir, receipt({ ready: true, layer: "DISPOSABLE_VM_OPERATOR", humanStatus: "PASS" }));
  const r = runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", path]);
  assert.equal(r.status, 0, r.stderr);
});

test("candidate and baseline identities cannot be swapped or abbreviated", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-acceptance-identity-"));
  const bad = receipt();
  bad.candidate.sha = BASELINE;
  bad.baseline.sha = "d603007";
  const r = runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", writeReceipt(dir, bad)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SHA mismatch/);
});

test("strict receipt handling rejects unknown properties", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-acceptance-strict-"));
  const bad = receipt();
  bad.unreviewed_claim = true;
  const r = runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", writeReceipt(dir, bad)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown property/);
});

test("workflow is manual, read-only, credential-free, immutable, and records dynamic harness SHA", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /permissions:\s*write|contents:\s*write|pull-requests:\s*write/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 3);
  assert.match(workflow, new RegExp(`ref: ${CANDIDATE}`));
  assert.match(workflow, new RegExp(`ref: ${BASELINE}`));
  assert.match(workflow, /ExpectedHarnessSha '\$\{\{ github\.sha \}\}'/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.doesNotMatch(workflow, /secrets\.|GITHUB_TOKEN|repository_dispatch|workflow_run|\bgit push\b/);
});

test("harness uses actual product paths and separates automated claims from operator evidence", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /scripts\\install\.ps1/);
  assert.match(script, /scripts\\doctor\.ps1/);
  assert.match(script, /bin\\coop\.ps1.*support/s);
  assert.match(script, /bin\\coop\.ps1.*data-doc/s);
  assert.match(script, /terminal_workstation_ready = \$false/);
  assert.match(script, /AUTOMATED_WINDOWS/);
  assert.match(script, /DISPOSABLE_VM_OPERATOR/);
  assert.doesNotMatch(script, /coop auth --json|real model response.*PASS/i);
});

test("operator runbook requires VM snapshot isolation and every human journey", () => {
  const doc = readFileSync(DOC, "utf8");
  for (const id of operatorIds) assert.ok(doc.includes(`\`${id}\``), `missing ${id}`);
  assert.match(doc, /Never run this on Aaron's working installation/);
  assert.match(doc, /snapshot-capable/);
  assert.match(doc, /coop auth --json/);
  assert.match(doc, /checklist or template[\s\S]*not acceptance/i);
  assert.match(doc, new RegExp(CANDIDATE));
  assert.match(doc, new RegExp(BASELINE));
});
