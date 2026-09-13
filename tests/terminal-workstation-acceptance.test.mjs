import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const SUPPORT_BUILD = "build-24297cf9";
const statuses = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_REACHED", "NOT_AVAILABLE", "CAPABILITY_SKIP", "BETA_LIMITATION"];
const automatedIds = [
  "identity-and-isolation", "baseline-source-install", "candidate-upgrade-preservation",
  "candidate-health-and-tools", "same-candidate-reinstall", "baseline-rollback-preservation",
  "sanitized-read-only-evidence",
];
const operatorIds = [
  "fresh-candidate-install", "real-provider-auth", "real-model-response", "copied-repo-workflow",
  "decline-no-partial-write", "stop-and-continue", "reopen-resume", "teamai-failure-isolation",
  "rollback-instructions", "snapshot-recovery",
];
const phaseFor = {
  "identity-and-isolation": "PRECHECK", "baseline-source-install": "BASELINE",
  "candidate-upgrade-preservation": "UPGRADE", "candidate-health-and-tools": "UPGRADE",
  "same-candidate-reinstall": "REINSTALL", "baseline-rollback-preservation": "ROLLBACK",
  "sanitized-read-only-evidence": "SECURITY",
};

const pwshProbe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
const havePwsh = pwshProbe.status === 0 && !pwshProbe.error;
const schemaProbe = spawnSync("python3", ["-c", "import jsonschema"], { encoding: "utf8" });

function runPs(args, options = {}) {
  return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-File", SCRIPT, ...args], { encoding: "utf8", ...options });
}

function evidence(kind = "COMMAND", observed = "redacted observation") {
  return { kind, observed, command: kind === "OPERATOR_OBSERVATION" ? "human interaction" : "verified command", exit_code: kind === "COMMAND" ? 0 : null, identity: kind === "OPERATOR_OBSERVATION" ? "operator" : `candidate:${CANDIDATE}`, path: "", sha256: "" };
}

function claim(id, { status = "PASS", automated = true, human = false, phase = phaseFor[id] || "PRECHECK", observation = true } = {}) {
  return {
    id, phase, status, required: true, automated, human_required: human, summary: `${id} observed`,
    evidence: human && observation ? [evidence("OPERATOR_OBSERVATION")] : automated ? [evidence()] : [],
  };
}

function receipt({ ready = false, layer = "AUTOMATED_WINDOWS", humanStatus = "NOT_REACHED" } = {}) {
  return {
    schema_version: 1,
    candidate: { expected_sha: CANDIDATE, observed_sha: CANDIDATE, expected_version: "0.23.1", observed_version: "0.23.1" },
    baseline: { expected_sha: BASELINE, observed_sha: BASELINE, expected_version: "0.23.1", observed_version: "0.23.1" },
    harness: { observed_sha: HARNESS, observed_version: "0.23.1" },
    execution: { layer, runner: "disposable-test", started_utc: "2026-09-13T00:00:00Z", finished_utc: "2026-09-13T00:01:00Z", owned_root: "C:\\owned" },
    claims: automatedIds.map((id) => claim(id)),
    operator_evidence: operatorIds.map((id) => claim(id, { status: humanStatus, automated: false, human: true, phase: "OPERATOR" })),
    terminal_workstation_ready: ready,
  };
}

function writeReceipt(dir, value, name = "receipt.json") {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function schemaValidate(path) {
  const code = [
    "import json,sys,re,datetime", "from jsonschema import Draft202012Validator,FormatChecker",
    "s=json.load(open(sys.argv[1],encoding='utf-8'))", "d=json.load(open(sys.argv[2],encoding='utf-8'))",
    "f=FormatChecker()", "f.checks('date-time',raises=ValueError)(lambda v: bool(re.fullmatch(r'\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})',v)) and bool(datetime.datetime.fromisoformat(v.replace('Z','+00:00'))))",
    "e=list(Draft202012Validator(s,format_checker=f).iter_errors(d))",
    "[print(x.message,file=sys.stderr) for x in e]", "sys.exit(1 if e else 0)",
  ].join(";");
  return spawnSync("python3", ["-c", code, SCHEMA, path], { encoding: "utf8" });
}

function assertBoth(path, expected, label) {
  const schema = schemaValidate(path);
  const ps = runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", path]);
  assert.equal(schema.status === 0, expected, `${label}: schema: ${schema.stderr}`);
  assert.equal(ps.status === 0, expected, `${label}: PowerShell: ${ps.stderr}`);
}

function assertFinalizationContract(source) {
  const finallyAt = source.indexOf("} finally {");
  const scanAt = source.indexOf("Find-Canary $EvidenceRoot $canary", finallyAt);
  assert.ok(finallyAt >= 0 && scanAt > finallyAt, "evidence scan must execute from finalization");
  assert.match(source, /Remove-Item -LiteralPath \$EvidenceRoot -Recurse -Force/);
  assert.match(source, /\.evidence-uploadable/);
}

function assertProcessCleanupContract(source) {
  assert.match(source, /taskkill\.exe \/PID \$process\.Id \/T \/F/);
  assert.match(source, /WaitForExit\(10000\)/);
  assert.match(source, /-not \$process\.HasExited/);
}

test("committed Draft 2020-12 schema validator is available and enforces formats", () => {
  assert.equal(schemaProbe.status, 0, `python jsonschema is mandatory: ${schemaProbe.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "coop-schema-format-"));
  const bad = receipt(); bad.execution.started_utc = "not-a-date";
  assert.notEqual(schemaValidate(writeReceipt(dir, bad)).status, 0);
});

test("receipt schema exposes exact vocabularies and complete automated/operator gates", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  assert.deepEqual(schema.$defs.status.enum, statuses);
  assert.equal(schema.$defs.candidateIdentity.properties.expected_sha.const, CANDIDATE);
  assert.equal(schema.$defs.baselineIdentity.properties.expected_sha.const, BASELINE);
  assert.equal(schema.allOf[0].then.properties.claims.minItems, automatedIds.length);
  assert.equal(schema.allOf[0].then.properties.operator_evidence.minItems, operatorIds.length);
  assert.equal(schema.allOf[0].then.allOf.length, automatedIds.length + operatorIds.length);
});

test("PowerShell parser accepts the harness", { skip: !havePwsh }, () => {
  const code = `$e=$null; [Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replaceAll("'", "''")}',[ref]$null,[ref]$e)|Out-Null; if($e){$e|%{Write-Error $_};exit 1}`;
  const r = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("strict SHA probe rejects abbreviations and uppercase", { skip: !havePwsh }, () => {
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "ValidateSha", "-Value", CANDIDATE]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "ValidateSha", "-Value", "295693a"]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "ValidateSha", "-Value", CANDIDATE.toUpperCase()]).status, 0);
});

test("owned-root probe creates an absent root and refuses an occupied root", { skip: !havePwsh }, () => {
  const parent = mkdtempSync(join(tmpdir(), "coop-acceptance-roots-"));
  const absent = join(parent, "owned");
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "AssertEmptyRoot", "-Root", absent]).status, 0);
  writeFileSync(join(absent, "sentinel"), "occupied");
  const second = runPs(["-Mode", "Probe", "-Probe", "AssertEmptyRoot", "-Root", absent]);
  assert.notEqual(second.status, 0); assert.match(second.stderr, /refusing occupied owned root/i);
});

test("tree hashing is deterministic, content-sensitive, and ignores .git", { skip: !havePwsh }, () => {
  const tree = mkdtempSync(join(tmpdir(), "coop-acceptance-hash-")); mkdirSync(join(tree, ".git"));
  writeFileSync(join(tree, "state.txt"), "preserved\n"); writeFileSync(join(tree, ".git", "FETCH_HEAD"), "first");
  const one = runPs(["-Mode", "Probe", "-Probe", "HashTree", "-Root", tree]); assert.equal(one.status, 0, one.stderr);
  writeFileSync(join(tree, ".git", "FETCH_HEAD"), "metadata"); const two = runPs(["-Mode", "Probe", "-Probe", "HashTree", "-Root", tree]);
  assert.equal(two.stdout.trim(), one.stdout.trim()); writeFileSync(join(tree, "state.txt"), "mutated\n");
  const three = runPs(["-Mode", "Probe", "-Probe", "HashTree", "-Root", tree]); assert.notEqual(three.stdout.trim(), one.stdout.trim());
});

test("canary scan fails closed on planted leakage", { skip: !havePwsh }, () => {
  const tree = mkdtempSync(join(tmpdir(), "coop-acceptance-canary-")); const canary = "PLANTED-CANARY-for-behavior-test";
  writeFileSync(join(tree, "clean.json"), '{"api_key":"[REDACTED]"}'); assert.equal(runPs(["-Mode", "Probe", "-Probe", "ScanCanary", "-Root", tree, "-Canary", canary]).status, 0);
  writeFileSync(join(tree, "bad.log"), `leaked=${canary}`); const leaked = runPs(["-Mode", "Probe", "-Probe", "ScanCanary", "-Root", tree, "-Canary", canary]);
  assert.notEqual(leaked.status, 0); assert.match(leaked.stderr, /credential canary found/i);
});

test("schema and PowerShell accept the complete ready receipt", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-ready-")); assertBoth(writeReceipt(dir, receipt({ ready: true, layer: "DISPOSABLE_VM_OPERATOR", humanStatus: "PASS" })), true, "complete ready");
});

test("decisive receipt mutations are rejected equivalently", { skip: !havePwsh }, () => {
  const mutations = [
    ["omitted automated ID", (x) => x.claims.pop()],
    ["duplicate automated ID", (x) => { x.claims[x.claims.length - 1] = structuredClone(x.claims[0]); }],
    ["invented automated substitute", (x) => { x.claims[0].id = "automated-core"; }],
    ["duplicate operator ID", (x) => { x.operator_evidence[9] = structuredClone(x.operator_evidence[0]); }],
    ["missing observation", (x) => { x.operator_evidence[0].evidence = []; }],
    ["invalid date-time", (x) => { x.execution.finished_utc = "yesterday"; }],
    ["timezone-less date-time", (x) => { x.execution.started_utc = "2026-09-13T00:00:00"; }],
    ["missing expected version", (x) => { x.candidate.expected_version = null; }],
    ["invalid claim ID", (x) => { x.claims[0].id = "Bad_ID"; }],
    ["invalid automated flags", (x) => { x.claims[0].human_required = true; }],
    ["candidate observation mismatch", (x) => { x.candidate.observed_sha = BASELINE; }],
    ["harness aliases product", (x) => { x.harness.observed_sha = CANDIDATE; }],
  ];
  const dir = mkdtempSync(join(tmpdir(), "coop-mutations-"));
  for (const [name, mutate] of mutations) { const value = receipt({ ready: true, layer: "DISPOSABLE_VM_OPERATOR", humanStatus: "PASS" }); mutate(value); assertBoth(writeReceipt(dir, value, `${name.replaceAll(" ", "-")}.json`), false, name); }
});

test("automated layer can never claim readiness", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-layer-")); assertBoth(writeReceipt(dir, receipt({ ready: true, layer: "AUTOMATED_WINDOWS", humanStatus: "PASS" })), false, "automated ready");
});

test("early native-precheck failure emits a schema-valid honest receipt", { skip: !havePwsh || process.platform === "win32" }, () => {
  const owned = join(mkdtempSync(join(tmpdir(), "coop-early-")), "owned"); const evidenceRoot = join(owned, "evidence"); const receiptPath = join(owned, "receipt.json");
  const r = runPs(["-Mode", "Run", "-HarnessRoot", join(owned, "missing-harness"), "-CandidateRoot", join(owned, "missing-candidate"), "-BaselineRoot", join(owned, "missing-baseline"), "-EvidenceRoot", evidenceRoot, "-ReceiptPath", receiptPath, "-ExpectedHarnessSha", HARNESS]);
  assert.notEqual(r.status, 0); assert.ok(existsSync(receiptPath), r.stderr);
  const value = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(value.candidate.observed_sha, null); assert.equal(value.baseline.observed_sha, null); assert.equal(value.harness.observed_sha, null); assert.equal(value.execution.owned_root, owned);
  assertBoth(receiptPath, true, "early failure receipt");
});

test("Support identity probe requires the exact candidate fingerprint", { skip: !havePwsh }, () => {
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "VerifySupportBuild", "-Value", SUPPORT_BUILD]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "VerifySupportBuild", "-Value", "build-deadbeef"]).status, 0);
});

test("Doctor pin probe rejects rollback drift despite fail=0", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-pins-"));
  const manifest = { python_tools: { "coop-data-doc": "1.0.0", "coop-sql-review": "2.0.0", "coop-dax-review": "3.0.0" } };
  const good = { fail: 0, checks: Object.entries(manifest.python_tools).map(([name, version]) => ({ name: `${name} ${version} matches manifest (${version})`, section: "Tools", status: "ok", hint: "" })) };
  const manifestPath = join(dir, "manifest.json"); const goodPath = join(dir, "good.json"); const badPath = join(dir, "bad.json");
  writeFileSync(manifestPath, JSON.stringify(manifest)); writeFileSync(goodPath, JSON.stringify(good));
  const bad = structuredClone(good); bad.checks[0] = { ...bad.checks[0], name: "coop-data-doc 9.9.9 differs from manifest (1.0.0)", status: "warn" }; writeFileSync(badPath, JSON.stringify(bad));
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "VerifyDoctorPins", "-Root", goodPath, "-Value", manifestPath]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "VerifyDoctorPins", "-Root", badPath, "-Value", manifestPath]).status, 0);
});

test("failure-path finalization cannot be mutated out", () => {
  const source = readFileSync(SCRIPT, "utf8"); assertFinalizationContract(source);
  assert.throws(() => assertFinalizationContract(source.replace("Find-Canary $EvidenceRoot $canary", "@()")));
  const workflow = readFileSync(WORKFLOW, "utf8"); assert.match(workflow, /evidence-uploadable/); assert.match(workflow, /env\.EVIDENCE_UPLOADABLE == 'true'/);
});

test("product agent path is one effective onboarding/install/Doctor path", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const contract = (s) => { assert.match(s, /\$agentRoot = Join-Path \$profileRoot '\.coop\\agent'/); assert.match(s, /\$env:COOP_AGENT_DIR = \$agentRoot/); assert.match(s, /Join-Path \$agentRoot 'mcp\.json'/); };
  contract(source); assert.throws(() => contract(source.replace("$agentRoot = Join-Path $profileRoot '.coop\\agent'", "$agentRoot = Join-Path $ownedRoot 'split-agent'")));
});

test("timeout cleanup contract requires recursive kill and confirmed exit", () => {
  const source = readFileSync(SCRIPT, "utf8"); assertProcessCleanupContract(source);
  assert.throws(() => assertProcessCleanupContract(source.replace("/T /F", "/F").replace("WaitForExit(10000)", "WaitForExit(0)")));
});

test("workflow is manual, read-only, immutable, schema-validating, and credential-free", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/); assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /permissions:\s*write|contents:\s*write|pull-requests:\s*write/); assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 3);
  assert.match(workflow, new RegExp(`ref: ${CANDIDATE}`)); assert.match(workflow, new RegExp(`ref: ${BASELINE}`)); assert.match(workflow, /ExpectedHarnessSha '\$\{\{ github\.sha \}\}'/);
  assert.match(workflow, /ajv-cli@5\.0\.0/); assert.match(workflow, /terminal-workstation-receipt\.schema\.json/); assert.match(workflow, /runs-on: windows-latest/);
  assert.doesNotMatch(workflow, /secrets\.|GITHUB_TOKEN|repository_dispatch|workflow_run|\bgit push\b/);
});

test("operator runbook preserves observation boundaries and every journey", () => {
  const doc = readFileSync(DOC, "utf8"); for (const id of [...automatedIds, ...operatorIds]) assert.ok(doc.includes(`\`${id}\``), `missing ${id}`);
  assert.match(doc, /Never run this on Aaron's working installation/); assert.match(doc, /snapshot-capable/); assert.match(doc, /coop auth --json/);
  assert.match(doc, /checklist or template[\s\S]*not acceptance/i); assert.match(doc, new RegExp(CANDIDATE)); assert.match(doc, new RegExp(BASELINE));
});
