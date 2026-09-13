import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fingerprintBuild } from "../lib/support-center.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "acceptance", "windows-terminal-workstation.ps1");
const SCHEMA = join(ROOT, "acceptance", "terminal-workstation-receipt.schema.json");
const WORKFLOW = join(ROOT, ".github", "workflows", "windows-terminal-workstation-acceptance.yml");
const DOC = join(ROOT, "docs", "terminal-workstation-acceptance.md");
const CANDIDATE = "295693a3eb08e9988594971d87bc4de751e6b551";
const BASELINE = "d60300780b565aabf15b172b2bc32abad12b9ca6";
const HARNESS = "1111111111111111111111111111111111111111";
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

function observedManifestState(manifest) {
  const checks = [{ name: `pi ${manifest.pi.version} matches manifest (${manifest.pi.version})`, status: "ok" }];
  for (const [name, version] of Object.entries(manifest.extensions)) checks.push({ name: `${name} ${version} matches manifest (${version})`, status: "ok" });
  for (const [name, version] of Object.entries(manifest.python_tools)) {
    checks.push({ name: name === "fabric-cicd" ? `${name} ${version} (library, in the Fabric CLI env)` : `${name} ${version} matches manifest (${version})`, status: "ok" });
  }
  const dependencies = { [manifest.pi.package]: { version: manifest.pi.version } };
  for (const [name, version] of Object.entries(manifest.npm_tools)) dependencies[name] = { version };
  const mcpServers = {}; const managed_servers = [];
  Object.entries(manifest.mcp_servers).forEach(([name, version], index) => { const server = `managed-${index}`; managed_servers.push(server); mcpServers[server] = { command: "npx", args: ["-y", `${name}@${version}`] }; });
  return { coop_version: manifest.coop_version, doctor: { fail: 0, checks }, npm_inventory: { dependencies }, mcp_config: { mcpServers, _coop: { managed_servers } } };
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
    ["numeric date-time", (x) => { x.execution.started_utc = 20260913; }],
    ["numeric runner", (x) => { x.execution.runner = 7; }],
    ["string schema version", (x) => { x.schema_version = "1"; }],
    ["numeric candidate expected SHA", (x) => { x.candidate.expected_sha = 295693; }],
    ["missing candidate expected version", (x) => { x.candidate.expected_version = null; }],
    ["numeric candidate expected version", (x) => { x.candidate.expected_version = 231; }],
    ["numeric candidate observed version", (x) => { x.candidate.observed_version = 231; }],
    ["numeric baseline expected version", (x) => { x.baseline.expected_version = 231; }],
    ["numeric harness observed version", (x) => { x.harness.observed_version = 231; }],
    ["invalid claim ID", (x) => { x.claims[0].id = "Bad_ID"; }],
    ["numeric claim ID", (x) => { x.claims[0].id = 7; }],
    ["invalid automated flags", (x) => { x.claims[0].human_required = true; }],
    ["scalar claim evidence", (x) => { x.claims[0].evidence = structuredClone(x.claims[0].evidence[0]); }],
    ["null claim evidence", (x) => { x.claims[0].evidence = null; }],
    ["object claim evidence", (x) => { x.claims[0].evidence = { item: structuredClone(x.claims[0].evidence[0]) }; }],
    ["scalar operator evidence", (x) => { x.operator_evidence[0].evidence = "observed"; }],
    ["string evidence exit code", (x) => { x.claims[0].evidence[0].exit_code = "0"; }],
    ["COMMAND null exit code", (x) => { x.claims[0].evidence[0].exit_code = null; }],
    ["numeric evidence observed", (x) => { x.claims[0].evidence[0].observed = 1; }],
    ["scalar claims collection", (x) => { x.claims = structuredClone(x.claims[0]); }],
    ["null operator collection", (x) => { x.operator_evidence = null; }],
    ["candidate observation mismatch", (x) => { x.candidate.observed_sha = BASELINE; }],
    ["harness aliases product", (x) => { x.harness.observed_sha = CANDIDATE; }],
  ];
  const dir = mkdtempSync(join(tmpdir(), "coop-mutations-"));
  for (const [name, mutate] of mutations) { const value = receipt({ ready: true, layer: "DISPOSABLE_VM_OPERATOR", humanStatus: "PASS" }); mutate(value); assertBoth(writeReceipt(dir, value, `${name.replaceAll(" ", "-")}.json`), false, name); }
});

test("schema and PowerShell retain null/integer exit codes for non-COMMAND evidence", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-non-command-exit-"));
  for (const value of [null, 17]) {
    const candidate = receipt({ ready: true, layer: "DISPOSABLE_VM_OPERATOR", humanStatus: "PASS" });
    candidate.claims[0].evidence[0] = evidence("HASH"); candidate.claims[0].evidence[0].exit_code = value;
    assertBoth(writeReceipt(dir, candidate, `hash-${value ?? "null"}.json`), true, `HASH exit_code ${value}`);
  }
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

test("Support identity probe derives the candidate fingerprint through product code", { skip: !havePwsh }, () => {
  const candidateVersion = execFileSync("git", ["-C", ROOT, "show", `${CANDIDATE}:VERSION`], { encoding: "utf8" }).trim();
  const expected = fingerprintBuild({ version: candidateVersion, commit: CANDIDATE });
  assert.equal(expected.ok, true);
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "VerifySupportBuild", "-Value", expected.value]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "VerifySupportBuild", "-Value", "build-deadbeef"]).status, 0);
});

test("complete candidate and rollback manifest proofs reject drift in every pin category", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-pins-"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));
  const manifestPath = join(dir, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const good = observedManifestState(manifest); const goodPath = join(dir, "good.json"); writeFileSync(goodPath, JSON.stringify(good));
  for (const phase of ["candidate", "rollback"]) {
    const result = runPs(["-Mode", "Probe", "-Probe", "VerifyManifestPins", "-Root", goodPath, "-Value", manifestPath]);
    assert.equal(result.status, 0, `${phase} complete proof: ${result.stderr}`);
  }
  const extensionName = Object.keys(manifest.extensions)[0]; const extensionVersion = manifest.extensions[extensionName];
  const pythonName = Object.keys(manifest.python_tools)[0]; const pythonVersion = manifest.python_tools[pythonName];
  const npmName = Object.keys(manifest.npm_tools)[0];
  const mutations = [
    ["coop_version", (x) => { x.coop_version = "9.9.9"; }],
    ["pi", (x) => { x.npm_inventory.dependencies[manifest.pi.package].version = "9.9.9"; }],
    ["extensions", (x) => { const c = x.doctor.checks.find((item) => item.name.startsWith(`${extensionName} `)); c.name = c.name.replaceAll(extensionVersion, "9.9.9"); }],
    ["python_tools", (x) => { const c = x.doctor.checks.find((item) => item.name.startsWith(`${pythonName} `)); c.name = c.name.replaceAll(pythonVersion, "9.9.9"); }],
    ["npm_tools", (x) => { x.npm_inventory.dependencies[npmName].version = "9.9.9"; }],
    ["mcp_servers", (x) => { x.mcp_config.mcpServers["managed-0"].args[1] = x.mcp_config.mcpServers["managed-0"].args[1].replace(/@[^@]+$/, "@9.9.9"); }],
  ];
  for (const [category, mutate] of mutations) {
    const bad = structuredClone(good); mutate(bad); const path = join(dir, `${category}.json`); writeFileSync(path, JSON.stringify(bad));
    for (const phase of ["candidate", "rollback"]) {
      const result = runPs(["-Mode", "Probe", "-Probe", "VerifyManifestPins", "-Root", path, "-Value", manifestPath]);
      assert.notEqual(result.status, 0, `${phase} must reject ${category} drift`);
    }
  }
  const nonManaged = structuredClone(good); nonManaged.mcp_config._coop.managed_servers = []; nonManaged.mcp_config.mcpServers = {};
  const nonManagedPath = join(dir, "mcp-not-managed.json"); writeFileSync(nonManagedPath, JSON.stringify(nonManaged));
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "VerifyManifestPins", "-Root", nonManagedPath, "-Value", manifestPath]).status, 0);
});

test("failure-path canary contamination removes evidence and emits no upload marker", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-finalize-")); const evidenceRoot = join(dir, "evidence"); mkdirSync(evidenceRoot);
  const receiptPath = join(dir, "receipt.json"); const canary = "FINALIZATION-CANARY";
  writeFileSync(join(evidenceRoot, "unsafe.log"), `leaked=${canary}`); writeFileSync(receiptPath, "{}");
  const result = runPs(["-Mode", "Probe", "-Probe", "FinalizeArtifacts", "-Root", evidenceRoot, "-Value", receiptPath, "-Canary", canary]);
  assert.notEqual(result.status, 0); assert.equal(existsSync(`${receiptPath}.evidence-uploadable`), false); assert.equal(existsSync(evidenceRoot), false);
});

function writeOwnershipFixture(dir) {
  const writer = join(dir, "ownership-fixture.mjs");
  writeFileSync(writer, `import {spawn} from "node:child_process"; import {writeFileSync} from "node:fs";
const mode=process.argv[2], target=process.argv[3], self=process.argv[1];
if(mode==="success"){process.stdout.write("exact-stdout\\n");process.stderr.write("exact-stderr\\n");process.exit(23)}
if(mode==="leaf"){setTimeout(()=>writeFileSync(target,"late-write"),1800);setInterval(()=>{},1000)}
else if(mode==="churn"){setInterval(()=>spawn(process.execPath,[self,"leaf",target],{stdio:"ignore"}),5)}
else if(mode==="cleanup-race"){spawn(process.execPath,[self,"churn",target],{stdio:"ignore"});setInterval(()=>{},1000)}
else if(mode==="parent-success"){spawn(process.execPath,[self,"leaf",target],{stdio:"ignore"})}
else{writeFileSync(mode,"payload-ran")}
`);
  return writer;
}

test("bounded command preserves exact stdout, stderr, and child status", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-bounded-success-")); const writer = writeOwnershipFixture(dir); const logBase = join(dir, "bounded");
  const result = runPs(["-Mode", "Probe", "-Probe", "BoundedCommandSuccess", "-Value", writer, "-Root", logBase]);
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(`${logBase}.stdout.txt`, "utf8"), "exact-stdout\n"); assert.equal(readFileSync(`${logBase}.stderr.txt`, "utf8"), "exact-stderr\n");
});

test("timeout owns descendants spawned during cleanup and suppresses upload", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-process-race-")); const writer = writeOwnershipFixture(dir); const lateWrite = join(dir, "late.txt"); const receiptPath = join(dir, "receipt.json");
  const result = runPs(["-Mode", "Probe", "-Probe", "BoundedProcessTree", "-Value", writer, "-Root", join(dir, "evidence", "bounded"), "-Canary", lateWrite, "-ReceiptPath", receiptPath]);
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(lateWrite), false); assert.equal(existsSync(`${receiptPath}.evidence-uploadable`), false);
});

test("successful parent with surviving descendant waits to timeout and suppresses upload", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-parent-success-")); const writer = writeOwnershipFixture(dir); const lateWrite = join(dir, "late.txt"); const receiptPath = join(dir, "receipt.json");
  const result = runPs(["-Mode", "Probe", "-Probe", "SuccessfulParentDescendant", "-Value", writer, "-Root", join(dir, "evidence", "bounded"), "-Canary", lateWrite, "-ReceiptPath", receiptPath]);
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(lateWrite), false); assert.equal(existsSync(`${receiptPath}.evidence-uploadable`), false);
});

test("ownership-unavailable 126 runs no payload and suppresses upload", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-owner-unavailable-")); const writer = writeOwnershipFixture(dir); const payloadMarker = join(dir, "payload.txt"); const receiptPath = join(dir, "receipt.json");
  const env = { ...process.env, COOP_ACCEPTANCE_FORCE_OWNERSHIP_UNAVAILABLE: "1" };
  const result = runPs(["-Mode", "Probe", "-Probe", "OwnershipUnavailable", "-Value", writer, "-Root", join(dir, "evidence", "bounded"), "-Canary", payloadMarker, "-ReceiptPath", receiptPath], { env });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(payloadMarker), false); assert.equal(existsSync(`${receiptPath}.evidence-uploadable`), false);
});

test("product agent path is one effective onboarding/install/Doctor path", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const contract = (s) => { assert.match(s, /\$agentRoot = Join-Path \$profileRoot '\.coop\\agent'/); assert.match(s, /\$env:COOP_AGENT_DIR = \$agentRoot/); assert.match(s, /Join-Path \$agentRoot 'mcp\.json'/); };
  contract(source); assert.throws(() => contract(source.replace("$agentRoot = Join-Path $profileRoot '.coop\\agent'", "$agentRoot = Join-Path $ownedRoot 'split-agent'")));
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
