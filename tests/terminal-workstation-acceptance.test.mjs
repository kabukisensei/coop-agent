import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
const CANDIDATE = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const BASELINE = "d60300780b565aabf15b172b2bc32abad12b9ca6";
const HARNESS = "1111111111111111111111111111111111111111";
const CANDIDATE_BUILD = fingerprintBuild({ version: readFileSync(join(ROOT, "VERSION"), "utf8").trim(), commit: CANDIDATE }).value;
const statuses = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_REACHED", "NOT_AVAILABLE", "CAPABILITY_SKIP", "BETA_LIMITATION"];
const automatedIds = [
  "identity-and-isolation", "baseline-source-install", "candidate-upgrade-preservation",
  "candidate-health-and-tools", "same-candidate-reinstall", "baseline-rollback-preservation",
  "sanitized-read-only-evidence",
];
const operatorIds = [
  "fresh-candidate-install", "real-provider-auth", "real-model-response", "copied-repo-workflow",
  "decline-no-partial-write", "stop-and-continue", "reopen-resume", "teamai-failure-isolation",
  "rollback-instructions", "warehouse-mcp-live-acceptance", "snapshot-recovery",
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
  const identity = [...args];
  if (!identity.includes("-ExpectedCandidateSha")) identity.push("-ExpectedCandidateSha", CANDIDATE);
  if (!identity.includes("-ExpectedCandidateBuild")) identity.push("-ExpectedCandidateBuild", CANDIDATE_BUILD);
  if (!identity.includes("-ExpectedHarnessSha")) identity.push("-ExpectedHarnessSha", HARNESS);
  return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-File", SCRIPT, ...identity], { encoding: "utf8", ...options });
}

function evidence(kind = "COMMAND", observed = "redacted observation") {
  return { kind, observed, command: kind === "OPERATOR_OBSERVATION" ? "human interaction" : "verified command", exit_code: kind === "COMMAND" ? 0 : null, identity: kind === "OPERATOR_OBSERVATION" ? "operator" : `candidate:${CANDIDATE}`, path: "", sha256: "", warehouse_live: null };
}

const liveWarehouseProof = () => ({
  auth_state: "authenticated", target_validation: "validated", target_scope: "item",
  discovered_tool: "executeSQL", provenance: "live", mock: false,
});

function claim(id, { status = "PASS", automated = true, human = false, phase = phaseFor[id] || "PRECHECK", observation = true } = {}) {
  return {
    id, phase, status, required: true, automated, human_required: human, summary: `${id} observed`,
    evidence: human && observation ? [evidence("OPERATOR_OBSERVATION")] : automated ? [evidence()] : [],
  };
}

function receipt({ ready = false, layer = "AUTOMATED_WINDOWS", humanStatus = "NOT_REACHED" } = {}) {
  const value = {
    schema_version: 1,
    candidate: { expected_sha: CANDIDATE, observed_sha: CANDIDATE, expected_version: "0.23.1", observed_version: "0.23.1", expected_build: CANDIDATE_BUILD, observed_build: CANDIDATE_BUILD },
    baseline: { expected_sha: BASELINE, observed_sha: BASELINE, expected_version: "0.23.1", observed_version: "0.23.1" },
    harness: { observed_sha: HARNESS, observed_version: "0.23.1" },
    execution: { layer, runner: "disposable-test", started_utc: "2026-09-13T00:00:00Z", finished_utc: "2026-09-13T00:01:00Z", owned_root: "C:\\owned" },
    claims: automatedIds.map((id) => claim(id)),
    operator_evidence: operatorIds.map((id) => claim(id, { status: humanStatus, automated: false, human: true, phase: "OPERATOR" })),
    terminal_workstation_ready: ready,
  };
  if (ready) value.operator_evidence.find((x) => x.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live = liveWarehouseProof();
  return value;
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

function validateAuthorization(kind, path, nonce, harness = HARNESS, evidenceRoot = "") {
  const args = ["-Mode", "ValidateUploadAuthorization", "-AuthorizationKind", kind, "-ReceiptPath", path, "-RunNonce", nonce, "-ExpectedHarnessSha", harness];
  if (evidenceRoot) args.push("-EvidenceRoot", evidenceRoot);
  return runPs(args);
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
  assert.equal(schema.$defs.candidateIdentity.properties.expected_sha.pattern, "^[0-9a-f]{40}$");
  assert.equal(schema.$defs.candidateIdentity.properties.expected_build.pattern, "^build-[0-9a-f]{8}$");
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
    ["forged candidate expected SHA", (x) => { x.candidate.expected_sha = "2".repeat(40); }],
    ["forged candidate fingerprint", (x) => { x.candidate.expected_build = "build-deadbeef"; }],
    ["forged observed fingerprint", (x) => { x.candidate.observed_build = "build-deadbeef"; }],
    ["candidate observation mismatch", (x) => { x.candidate.observed_sha = BASELINE; }],
    ["wrong harness observation", (x) => { x.harness.observed_sha = "2".repeat(40); }],
    ["generic Warehouse text only", (x) => { x.operator_evidence.find((i) => i.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live = null; }],
    ["mock Warehouse provenance", (x) => { x.operator_evidence.find((i) => i.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live.mock = true; }],
    ["non-live Warehouse provenance", (x) => { x.operator_evidence.find((i) => i.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live.provenance = "fixture"; }],
    ["unvalidated Warehouse target", (x) => { x.operator_evidence.find((i) => i.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live.target_validation = "registered"; }],
    ["global Warehouse target", (x) => { x.operator_evidence.find((i) => i.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live.target_scope = "global"; }],
    ["undocumented Warehouse tool", (x) => { x.operator_evidence.find((i) => i.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live.discovered_tool = "fabric-sqlendpoint-not_sql"; }],
    ["Warehouse proof extra property", (x) => { x.operator_evidence.find((i) => i.id === "warehouse-mcp-live-acceptance").evidence[0].warehouse_live.claimed_live = true; }],
    ["malformed Warehouse object on unrelated evidence", (x) => { x.claims[0].evidence[0].warehouse_live = { foo: "bar" }; }],
  ];
  const dir = mkdtempSync(join(tmpdir(), "coop-mutations-"));
  const runtimeBound = new Set(["forged candidate expected SHA", "forged candidate fingerprint", "forged observed fingerprint", "candidate observation mismatch", "wrong harness observation"]);
  for (const [name, mutate] of mutations) {
    const value = receipt({ ready: true, layer: "DISPOSABLE_VM_OPERATOR", humanStatus: "PASS" }); mutate(value);
    const path = writeReceipt(dir, value, `${name.replaceAll(" ", "-")}.json`);
    if (runtimeBound.has(name)) {
      assert.equal(schemaValidate(path).status, 0, `${name}: shape schema must remain candidate-independent`);
      assert.notEqual(runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", path]).status, 0, `${name}: trusted runtime binding accepted forgery`);
    } else assertBoth(path, false, name);
  }
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

test("early native-precheck failure authorizes only its current safe receipt", { skip: !havePwsh || process.platform === "win32" }, () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const owned = join(mkdtempSync(join(tmpdir(), "coop-early-")), "owned"); const evidenceRoot = join(owned, "evidence"); const receiptPath = join(owned, "receipt.json");
  const r = runPs(["-Mode", "Run", "-HarnessRoot", join(owned, "missing-harness"), "-CandidateRoot", join(owned, "missing-candidate"), "-BaselineRoot", join(owned, "missing-baseline"), "-EvidenceRoot", evidenceRoot, "-ReceiptPath", receiptPath, "-RunNonce", nonce, "-ExpectedHarnessSha", HARNESS]);
  assert.notEqual(r.status, 0); assert.ok(existsSync(receiptPath), r.stderr);
  const value = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(value.candidate.observed_sha, null); assert.equal(value.baseline.observed_sha, null); assert.equal(value.harness.observed_sha, null); assert.equal(value.execution.owned_root, owned);
  assertBoth(receiptPath, true, "early failure receipt");
  assert.equal(validateAuthorization("Receipt", receiptPath, nonce).status, 0);
  assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false);
  assert.notEqual(validateAuthorization("Receipt", receiptPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").status, 0);
});

test("Support identity probe derives the candidate fingerprint through product code", { skip: !havePwsh }, () => {
  const candidateVersion = execFileSync("git", ["-C", ROOT, "show", `${CANDIDATE}:VERSION`], { encoding: "utf8" }).trim();
  const expected = fingerprintBuild({ version: candidateVersion, commit: CANDIDATE });
  assert.equal(expected.ok, true);
  assert.equal(runPs(["-Mode", "Probe", "-Probe", "VerifySupportBuild", "-Root", ROOT, "-Canary", CANDIDATE, "-Value", expected.value]).status, 0);
  assert.notEqual(runPs(["-Mode", "Probe", "-Probe", "VerifySupportBuild", "-Root", ROOT, "-Canary", CANDIDATE, "-Value", "build-deadbeef"]).status, 0);
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
  assert.notEqual(result.status, 0); assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false); assert.equal(existsSync(evidenceRoot), false);
});

test("lifecycle stderr validation rejects absent, duplicate, wrong, stale, malformed, and payload-spoofed records", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-lifecycle-record-")); const path = join(dir, "helper.stderr.txt");
  const nonce = "0123456789abcdef0123456789abcdef"; const stage = "job-terminate";
  const prefix = "COOP_KNOWLEDGE_GIT_LIFECYCLE:";
  const exact = `${prefix}${JSON.stringify({ schema_version: 1, nonce, stage, outcome: "failure" })}`;
  const validate = () => runPs(["-Mode", "Probe", "-Probe", "ValidateLifecycleEvent", "-Value", path, "-Root", stage, "-Canary", nonce]);
  assert.notEqual(validate().status, 0, "absent helper stderr log was accepted");
  writeFileSync(path, `ordinary helper diagnostic\n${exact}\n`);
  assert.equal(validate().status, 0, validate().stderr);
  writeFileSync(path, `${exact}\n${exact}\n`);
  assert.notEqual(validate().status, 0, "duplicate record was accepted");
  writeFileSync(path, `${prefix}${JSON.stringify({ schema_version: 1, nonce, stage: "job-close", outcome: "failure" })}\n`);
  assert.notEqual(validate().status, 0, "wrong-stage record was accepted");
  writeFileSync(path, `${prefix}${JSON.stringify({ schema_version: 1, nonce: "00000000000000000000000000000000", stage, outcome: "failure" })}\n`);
  assert.notEqual(validate().status, 0, "stale record was accepted");
  writeFileSync(path, `${prefix}{malformed\n`);
  assert.notEqual(validate().status, 0, "malformed record was accepted");
  writeFileSync(path, `${exact}\n${prefix}${JSON.stringify({ schema_version: 1, nonce: "0".repeat(32), stage, outcome: "failure" })}\n`);
  assert.notEqual(validate().status, 0, "payload-spoofed second record was accepted");
  writeFileSync(path, `${prefix}${JSON.stringify({ schema_version: 1, nonce, stage, outcome: "success" })}\n`);
  assert.notEqual(validate().status, 0, "wrong-outcome record was accepted");
  writeFileSync(path, `${prefix}${JSON.stringify({ schema_version: 1, nonce, stage, outcome: "failure", injected: true })}\n`);
  assert.notEqual(validate().status, 0, "record with unknown properties was accepted");
});

test("Run replaces stale authorization with current safe receipt authorization only", { skip: !havePwsh }, () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dir = mkdtempSync(join(tmpdir(), "coop-stale-upload-")); const owned = join(dir, "owned");
  const evidenceRoot = join(owned, "evidence"); const receiptPath = join(dir, "receipt.json"); const receiptAuthorization = `${receiptPath}.receipt-authorization.json`; const evidenceAuthorization = `${receiptPath}.evidence-authorization.json`;
  writeFileSync(receiptPath, JSON.stringify(receipt()));
  writeFileSync(receiptAuthorization, JSON.stringify({ schema_version: 1, kind: "receipt", run_nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", harness_sha: HARNESS, receipt_sha256: "0".repeat(64) }));
  writeFileSync(evidenceAuthorization, "stale evidence authorization\n");
  const result = runPs([
    "-Mode", "Run", "-HarnessRoot", join(dir, "missing-harness"), "-CandidateRoot", join(dir, "missing-candidate"),
    "-BaselineRoot", join(dir, "missing-baseline"), "-EvidenceRoot", evidenceRoot, "-ReceiptPath", receiptPath, "-RunNonce", nonce, "-ExpectedHarnessSha", HARNESS,
  ], { env: { ...process.env, COOP_TERMINAL_ACCEPTANCE_RECEIPT_SANITIZATION_FAULT: "fail" } });
  assert.notEqual(result.status, 0); assert.equal(existsSync(evidenceAuthorization), false, "stale evidence authorization survived");
  assert.equal(existsSync(receiptPath), true); assertBoth(receiptPath, true, "receipt-sanitization failure receipt");
  assert.equal(validateAuthorization("Receipt", receiptPath, nonce).status, 0);
  assert.notEqual(validateAuthorization("Receipt", receiptPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").status, 0);
  const generated = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(generated.terminal_workstation_ready, false);
  assert.deepEqual(generated.claims.map((item) => [item.id, item.status]), [
    ["sanitized-read-only-evidence", "FAIL"], ["automated-harness-completion", "FAIL"],
  ]);
});

test("revocation, replacement, validator, hash, and harness mutations fail closed", { skip: !havePwsh }, () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  for (const fault of ["revoke-fail", "receipt-replace-fail", "validator-fail"]) {
    const dir = mkdtempSync(join(tmpdir(), `coop-auth-${fault}-`)); const owned = join(dir, "owned");
    const receiptPath = join(dir, "receipt.json"); const evidenceRoot = join(owned, "evidence");
    writeFileSync(receiptPath, JSON.stringify(receipt()));
    writeFileSync(`${receiptPath}.receipt-authorization.json`, JSON.stringify({ schema_version: 1, kind: "receipt", run_nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", harness_sha: HARNESS, receipt_sha256: "0".repeat(64) }));
    const result = runPs(["-Mode", "Run", "-HarnessRoot", join(dir, "missing"), "-CandidateRoot", join(dir, "missing-candidate"), "-BaselineRoot", join(dir, "missing-baseline"), "-EvidenceRoot", evidenceRoot, "-ReceiptPath", receiptPath, "-RunNonce", nonce, "-ExpectedHarnessSha", HARNESS], { env: { ...process.env, COOP_TERMINAL_ACCEPTANCE_AUTHORIZATION_FAULT: fault } });
    assert.notEqual(result.status, 0, `${fault} unexpectedly passed`);
    assert.notEqual(validateAuthorization("Receipt", receiptPath, nonce).status, 0, `${fault} authorized receipt`);
    assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false, `${fault} authorized evidence`);
  }
  const dir = mkdtempSync(join(tmpdir(), "coop-auth-mutations-")); const owned = join(dir, "owned"); const receiptPath = join(dir, "receipt.json");
  runPs(["-Mode", "Run", "-HarnessRoot", join(dir, "missing"), "-CandidateRoot", join(dir, "missing-candidate"), "-BaselineRoot", join(dir, "missing-baseline"), "-EvidenceRoot", join(owned, "evidence"), "-ReceiptPath", receiptPath, "-RunNonce", nonce, "-ExpectedHarnessSha", HARNESS]);
  assert.equal(validateAuthorization("Receipt", receiptPath, nonce).status, 0);
  assert.notEqual(validateAuthorization("Receipt", receiptPath, nonce, "2222222222222222222222222222222222222222").status, 0);
  const changed = JSON.parse(readFileSync(receiptPath, "utf8")); changed.execution.runner = "mutated"; writeFileSync(receiptPath, JSON.stringify(changed));
  assert.notEqual(validateAuthorization("Receipt", receiptPath, nonce).status, 0, "receipt hash mutation accepted");
});

test("fully safe authorization binds receipt and exact evidence state independently", { skip: !havePwsh }, () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dir = mkdtempSync(join(tmpdir(), "coop-both-auth-")); const evidenceRoot = join(dir, "evidence"); mkdirSync(evidenceRoot);
  writeFileSync(join(evidenceRoot, "proof.txt"), "safe proof\n");
  const receiptPath = writeReceipt(dir, receipt());
  const authorized = runPs(["-Mode", "Probe", "-Probe", "AuthorizeArtifacts", "-ReceiptPath", receiptPath, "-Root", evidenceRoot, "-Value", nonce, "-Canary", HARNESS]);
  assert.equal(authorized.status, 0, authorized.stderr);
  assert.equal(validateAuthorization("Receipt", receiptPath, nonce).status, 0);
  assert.equal(validateAuthorization("Evidence", receiptPath, nonce, HARNESS, evidenceRoot).status, 0);
  writeFileSync(join(evidenceRoot, "proof.txt"), "changed proof\n");
  assert.notEqual(validateAuthorization("Evidence", receiptPath, nonce, HARNESS, evidenceRoot).status, 0, "changed evidence retained authority");
  assert.equal(validateAuthorization("Receipt", receiptPath, nonce).status, 0, "evidence state improperly controls safe receipt authority");
});

function writeOwnershipFixture(dir) {
  const writer = join(dir, "ownership-fixture.mjs");
  writeFileSync(writer, `import {spawn} from "node:child_process"; import {existsSync,readFileSync,writeFileSync} from "node:fs"; import {createServer} from "node:net";
const mode=process.argv[2], target=process.argv[3], self=process.argv[1];
if(mode==="success"){process.stdout.write("exact-stdout\\n");process.stderr.write("exact-stderr\\n");process.exit(23)}
if(mode==="unicode"){process.stdout.write(JSON.stringify({argv:process.argv.slice(3),stdin:readFileSync(0,"utf8")}));process.exit(0)}
if(mode==="leaf"){const startedAtMs=Date.now(),token=process.pid+":"+startedAtMs;const server=createServer(socket=>socket.end(token));server.listen(0,"127.0.0.1",()=>{writeFileSync(target+".identity.json",JSON.stringify({pid:process.pid,port:server.address().port,startedAtMs,token}));setTimeout(()=>writeFileSync(target,"late-write"),1800)})}
else if(mode==="churn"){setInterval(()=>spawn(process.execPath,[self,"leaf",target],{stdio:"ignore"}),5)}
else if(mode==="cleanup-race"){spawn(process.execPath,[self,"churn",target],{stdio:"ignore"});setInterval(()=>{},1000)}
else if(mode==="parent-success"){spawn(process.execPath,[self,"leaf",target],{stdio:"ignore"})}
else if(mode==="parent-with-descendant"){spawn(process.execPath,[self,"leaf",target],{stdio:"ignore"});const deadline=Date.now()+1000;const wait=setInterval(()=>{if(existsSync(target+".identity.json")||Date.now()>deadline){clearInterval(wait);process.exit(0)}},10)}
else{writeFileSync(mode,"payload-ran")}
`);
  return writer;
}

function originalDescendantResponds(identityPath) {
  const identity = JSON.parse(readFileSync(identityPath, "utf8"));
  return new Promise((resolveAlive) => {
    let response = "";
    const socket = connect({ host: "127.0.0.1", port: identity.port });
    const finish = (alive) => { socket.destroy(); resolveAlive(alive); };
    socket.setEncoding("utf8"); socket.setTimeout(1000, () => finish(false));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => finish(response === identity.token));
    socket.on("error", () => finish(false));
  });
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

test("bounded command preserves exact stdout, stderr, and child status", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-bounded-success-")); const writer = writeOwnershipFixture(dir); const logBase = join(dir, "bounded");
  const result = runPs(["-Mode", "Probe", "-Probe", "BoundedCommandSuccess", "-Value", writer, "-Root", logBase]);
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(`${logBase}.stdout.txt`, "utf8"), "exact-stdout\n"); assert.equal(readFileSync(`${logBase}.stderr.txt`, "utf8"), "exact-stderr\n");
});

test("knowledge-git preserves Unicode stdin paths, content, and exact argv directly", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-unicode-雪-")); const writer = writeOwnershipFixture(dir);
  const input = join(dir, "入力 space.txt"); const argvPath = join(dir, "引数 vector.json");
  const content = "Zażółć 雪\nsecond\n"; const difficult = ["雪 λ", "space arg", "&|<>^%!", 'quote"arg', "backslash\\tail", ""];
  writeFileSync(input, content, "utf8"); writeFileSync(argvPath, JSON.stringify([process.execPath, writer, "unicode", ...difficult]), "utf8");
  const result = spawnSync("python3", [join(ROOT, "scripts", "knowledge-git.py"), "--timeout-seconds", "10", "--stdin-file", input, "--argv-file", argvPath], {
    encoding: "utf8", env: { ...process.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { argv: difficult, stdin: content });
});

test("PowerShell bounded wrapper preserves Unicode stdin and difficult arguments", { skip: !havePwsh }, () => {
  const parent = mkdtempSync(join(tmpdir(), "coop-wrapper-unicode-")); const dir = join(parent, "雪 profile"); mkdirSync(dir);
  const writer = writeOwnershipFixture(dir); const input = join(dir, "入力 answers.txt"); writeFileSync(input, "Zażółć 雪\nsecond\n", "utf8");
  const result = runPs(["-Mode", "Probe", "-Probe", "BoundedUnicodeFidelity", "-Value", writer, "-Root", join(dir, "証拠 log"), "-Canary", input]);
  assert.equal(result.status, 0, result.stderr);
});

test("timeout owns descendants spawned during cleanup and suppresses upload", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-process-race-")); const writer = writeOwnershipFixture(dir); const lateWrite = join(dir, "late.txt"); const receiptPath = join(dir, "receipt.json");
  const result = runPs(["-Mode", "Probe", "-Probe", "BoundedProcessTree", "-Value", writer, "-Root", join(dir, "evidence", "bounded"), "-Canary", lateWrite, "-ReceiptPath", receiptPath]);
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(lateWrite), false); assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false);
});

test("successful parent with surviving descendant waits to timeout and suppresses upload", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-parent-success-")); const writer = writeOwnershipFixture(dir); const lateWrite = join(dir, "late.txt"); const receiptPath = join(dir, "receipt.json");
  const result = runPs(["-Mode", "Probe", "-Probe", "SuccessfulParentDescendant", "-Value", writer, "-Root", join(dir, "evidence", "bounded"), "-Canary", lateWrite, "-ReceiptPath", receiptPath]);
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(lateWrite), false); assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false);
});

test("native Windows lifecycle faults fail closed through real receipt finalization", { skip: !havePwsh || process.platform !== "win32" }, async () => {
  const candidateRoot = resolve(ROOT, "..", "candidate");
  const baselineRoot = resolve(ROOT, "..", "baseline");
  assert.equal(existsSync(candidateRoot), true, "workflow candidate checkout is required");
  assert.equal(existsSync(baselineRoot), true, "workflow baseline checkout is required");
  const harnessSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (const fault of ["job-create", "job-assign", "resume", "job-query", "job-terminate", "job-close"]) {
    const dir = mkdtempSync(join(tmpdir(), `coop-owner-${fault}-`)); const writer = writeOwnershipFixture(dir);
    const owned = join(dir, "owned"); const payloadMarker = join(owned, "ownership-payload.txt"); const receiptPath = join(dir, "receipt.json"); const pidPath = join(dir, "spawned.pid");
    const unrelatedMarker = join(dir, "unrelated.txt"); const unrelatedIdentityPath = `${unrelatedMarker}.identity.json`;
    const unrelated = spawn(process.execPath, [writer, "leaf", unrelatedMarker], { stdio: "ignore" });
    try {
      await waitForFile(unrelatedIdentityPath);
      const unrelatedIdentity = JSON.parse(readFileSync(unrelatedIdentityPath, "utf8"));
      assert.equal(unrelatedIdentity.pid, unrelated.pid, `${fault}: unrelated PID identity changed at spawn`);
      assert.equal(unrelatedIdentity.token, `${unrelatedIdentity.pid}:${unrelatedIdentity.startedAtMs}`, `${fault}: unrelated start identity is incomplete`);
      assert.equal(await originalDescendantResponds(unrelatedIdentityPath), true, `${fault}: unrelated process was not alive before mutation`);

      const env = {
        ...process.env,
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        COOP_KNOWLEDGE_GIT_TEST_FAULT: fault,
        COOP_KNOWLEDGE_GIT_TEST_PID_FILE: pidPath,
        COOP_TERMINAL_ACCEPTANCE_OWNERSHIP_FIXTURE: writer,
      };
      const runNonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      writeFileSync(`${receiptPath}.receipt-authorization.json`, "stale receipt authorization\n");
      writeFileSync(`${receiptPath}.evidence-authorization.json`, "stale evidence authorization\n");
      const result = runPs([
        "-Mode", "Run", "-HarnessRoot", ROOT, "-CandidateRoot", candidateRoot, "-BaselineRoot", baselineRoot,
        "-EvidenceRoot", join(owned, "evidence"), "-ReceiptPath", receiptPath, "-RunNonce", runNonce, "-ExpectedHarnessSha", harnessSha,
      ], { env });
      assert.notEqual(result.status, 0, `${fault}: injected lifecycle failure unexpectedly passed`);
      assert.equal(existsSync(receiptPath), true, `${fault}: fail-closed receipt was not generated`);
      assertBoth(receiptPath, true, `${fault}: generated receipt`);
      const generated = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(generated.terminal_workstation_ready, false, `${fault}: failure receipt claimed readiness`);
      const completion = generated.claims.filter((item) => item.id === "automated-harness-completion");
      assert.equal(completion.length, 1, `${fault}: exact completion failure claim missing`);
      assert.equal(completion[0].status, "FAIL", `${fault}: completion claim was not FAIL`);
      assert.match(completion[0].summary, new RegExp(`observed ownership lifecycle ${fault} outcome (failure|indeterminate) failed closed`));
      assert.match(completion[0].evidence[0].observed, new RegExp(`observed ownership lifecycle ${fault} outcome (failure|indeterminate) failed closed`));
      for (const item of generated.claims) {
        if (item.id !== "identity-and-isolation") assert.notEqual(item.status, "PASS", `${fault}: ${item.id} incorrectly passed`);
      }
      assert.equal(validateAuthorization("Receipt", receiptPath, runNonce, harnessSha).status, 0, `${fault}: safe failure receipt was not authorized`);
      assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false, `${fault}: evidence authorization appeared`);
      assert.equal(existsSync(join(owned, "evidence")), false, `${fault}: uncertain evidence was retained`);

      assert.equal(existsSync(pidPath), true, `${fault}: real owned root PID was not recorded`);
      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH", `${fault}: owned root ${pid} survived`);
      if (["job-create", "job-assign", "resume"].includes(fault)) {
        assert.equal(existsSync(`${payloadMarker}.identity.json`), false, `${fault}: suspended payload created a descendant`);
      } else {
        const identityPath = `${payloadMarker}.identity.json`;
        assert.equal(existsSync(identityPath), true, `${fault}: owned descendant identity was not captured`);
        const ownedIdentityBefore = readFileSync(identityPath, "utf8");
        assert.equal(await originalDescendantResponds(identityPath), false, `${fault}: original owned descendant survived cleanup`);
        assert.equal(readFileSync(identityPath, "utf8"), ownedIdentityBefore, `${fault}: owned descendant identity evidence changed`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
      assert.equal(existsSync(payloadMarker), false, `${fault}: owned descendant mutated state after finalization`);
      assert.deepEqual(JSON.parse(readFileSync(unrelatedIdentityPath, "utf8")), unrelatedIdentity, `${fault}: unrelated retained identity changed`);
      assert.equal(await originalDescendantResponds(unrelatedIdentityPath), true, `${fault}: unrelated retained process identity did not survive`);
    } finally {
      unrelated.kill();
    }
  }
  for (const mutation of ["no-event", "duplicate-event", "wrong-event", "stale-event", "malformed-event", "payload-spoofed"]) {
    const dir = mkdtempSync(join(tmpdir(), `coop-owner-event-${mutation}-`)); const writer = writeOwnershipFixture(dir);
    const result = runPs([
      "-Mode", "Probe", "-Probe", "OwnershipLifecycleFailure", "-Value", writer,
      "-Root", join(dir, "evidence", "bounded"), "-Canary", join(dir, "payload.txt"), "-ReceiptPath", join(dir, "receipt.json"),
    ], { env: { ...process.env, COOP_KNOWLEDGE_GIT_TEST_FAULT: "job-terminate", COOP_TERMINAL_ACCEPTANCE_EVENT_MUTATION: mutation } });
    assert.notEqual(result.status, 0, `${mutation}: lifecycle harness accepted unauthentic event evidence`);
  }
});

test("product agent path is one effective onboarding/install/Doctor path", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const contract = (s) => { assert.match(s, /\$agentRoot = Join-Path \$profileRoot '\.coop\\agent'/); assert.match(s, /\$env:COOP_AGENT_DIR = \$agentRoot/); assert.match(s, /Join-Path \$agentRoot 'mcp\.json'/); };
  contract(source); assert.throws(() => contract(source.replace("$agentRoot = Join-Path $profileRoot '.coop\\agent'", "$agentRoot = Join-Path $ownedRoot 'split-agent'")));
});

test("workflow binds dispatch and the named same-repo PR to the exact event-authorized SHA", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const expectedGate = "if: ${{ github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.base_ref == 'main' && github.head_ref == 'integration/presentation-2026-09-20' && github.event.pull_request.head.repo.full_name == github.repository) }}";
  const contract = (source) => {
    assert.match(source, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*candidate_sha:[\s\S]*required: true[\s\S]*pull_request:\s*\n\s*branches:\s*\n\s*- main/);
    assert.ok(source.includes(expectedGate), "native job must reject unauthorized PR heads and forks");
    assert.match(source, /permissions:\s*\n\s*contents: read/);
    assert.doesNotMatch(source, /pull_request_target|permissions:\s*write|contents:\s*write|pull-requests:\s*write/);
    assert.equal((source.match(/persist-credentials: false/g) || []).length, 3);
    assert.match(source, /Validate event-authorized candidate input[\s\S]*CANDIDATE_SHA -cnotmatch '\^\[0-9a-f\]\{40\}\$'[\s\S]*Checkout acceptance harness identity/);
    assert.match(source, /CANDIDATE_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| inputs\.candidate_sha \}\}/);
    assert.equal((source.match(/ref: \$\{\{ env\.CANDIDATE_SHA \}\}/g) || []).length, 2);
    assert.match(source, /\$observed = \(& git -C \$checkout rev-parse HEAD\)\.Trim\(\)[\s\S]*\$observed -cne \$expected/);
    assert.match(source, /ExpectedCandidateSha \$env:VERIFIED_CANDIDATE_SHA/);
    assert.match(source, /ExpectedCandidateBuild \$env:VERIFIED_CANDIDATE_BUILD/);
    assert.match(source, /VERSION[\s\S]*fingerprintBuild/);
    assert.match(source, new RegExp(`ref: ${BASELINE}`));
    assert.doesNotMatch(source, /github\.sha|refs\/pull|build-[0-9a-f]{8}|295693a/);
    assert.match(source, /ajv-cli@5\.0\.0/); assert.match(source, /terminal-workstation-receipt\.schema\.json/); assert.match(source, /runs-on: windows-latest/);
    assert.match(source, /terminal-workstation-receipt-\$\{\{ env\.VERIFIED_CANDIDATE_SHA \}\}-\$\{\{ env\.VERIFIED_CANDIDATE_BUILD \}\}/);
    assert.match(source, /if: always\(\) && env\.RECEIPT_UPLOADABLE == 'true'/);
    assert.match(source, /if: always\(\) && env\.EVIDENCE_UPLOADABLE == 'true'/);
    assert.match(source, /ValidateUploadAuthorization -AuthorizationKind Receipt/);
    assert.match(source, /ValidateUploadAuthorization -AuthorizationKind Evidence/);
    assert.match(source, /--test-name-pattern "Unicode\|lifecycle"/);
    assert.doesNotMatch(source, /secrets\.|GITHUB_TOKEN|repository_dispatch|workflow_run|\bgit push\b/);
  };
  contract(workflow);
  for (const forged of [
    workflow.replace("github.head_ref == 'integration/presentation-2026-09-20'", "github.head_ref != ''"),
    workflow.replace("github.event.pull_request.head.repo.full_name == github.repository", "true"),
    workflow.replace("ref: ${{ env.CANDIDATE_SHA }}", "ref: ${{ github.sha }}"),
    workflow.replace("$observed -cne $expected", "$false"),
  ]) assert.throws(() => contract(forged));
  const testSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(testSource, /COOP_TERMINAL_ACCEPTANCE_OWNERSHIP_FIXTURE[\s\S]*"-Mode", "Run"/);
  assert.match(testSource, /unrelatedIdentity\.startedAtMs[\s\S]*assertBoth\(receiptPath[\s\S]*completion\[0\]\.status/);
});

test("operator runbook preserves observation boundaries and every journey", () => {
  const doc = readFileSync(DOC, "utf8"); for (const id of [...automatedIds, ...operatorIds]) assert.ok(doc.includes(`\`${id}\``), `missing ${id}`);
  assert.match(doc, /Never run this on Aaron's working installation/); assert.match(doc, /snapshot-capable/); assert.match(doc, /coop auth --json/);
  assert.match(doc, /checklist or template[\s\S]*not acceptance/i); assert.match(doc, /event-authorized candidate SHA/); assert.doesNotMatch(doc, /295693a|build-24297cf9/); assert.match(doc, new RegExp(BASELINE));
});
