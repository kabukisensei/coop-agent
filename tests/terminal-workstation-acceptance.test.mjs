import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fingerprintBuild } from "../lib/support-center.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "acceptance", "windows-terminal-workstation.ps1");
const SCHEMA = join(ROOT, "acceptance", "terminal-workstation-receipt.schema.json");
const WORKFLOW = join(ROOT, ".github", "workflows", "windows-terminal-workstation-acceptance.yml");
const YAML_READER = join(ROOT, "lib", "_yaml.py");
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
const PWSH = havePwsh ? spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "(Get-Command pwsh).Source"], { encoding: "utf8" }).stdout.trim() : "pwsh";
const pythonCandidates = [...new Set([process.env.CERT_PYTHON, "python3", "python"].filter(Boolean))];
const pythonDiscovery = pythonCandidates.map((command) => ({
  command,
  probe: spawnSync(command, ["-c", "import os,sys; print(os.path.abspath(sys.executable))"], { encoding: "utf8" }),
})).find(({ probe }) => probe.status === 0 && !probe.error && probe.stdout?.trim());
assert.ok(pythonDiscovery, `Python is mandatory; tried: ${pythonCandidates.join(", ")}`);
const PYTHON_PATH = pythonDiscovery.probe.stdout.trim();
const schemaProbe = spawnSync(PYTHON_PATH, ["-c", "import jsonschema"], { encoding: "utf8" });

function runPs(args, options = {}) {
  const identity = [...args];
  if (!identity.includes("-ExpectedCandidateSha")) identity.push("-ExpectedCandidateSha", CANDIDATE);
  if (!identity.includes("-ExpectedCandidateBuild")) identity.push("-ExpectedCandidateBuild", CANDIDATE_BUILD);
  if (!identity.includes("-ExpectedHarnessSha")) identity.push("-ExpectedHarnessSha", HARNESS);
  return spawnSync(PWSH, ["-NoLogo", "-NoProfile", "-File", SCRIPT, ...identity], { encoding: "utf8", ...options });
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
    trust_model: {
      name: "reviewed-candidate-non-malicious", candidate_admin_code_trusted: true,
      adversarial_admin_containment: false, deferred_hardening: "post-release",
      limitation: "Certification does not contain intentionally malicious administrator-level candidate code.",
    },
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
  return spawnSync(PYTHON_PATH, ["-c", code, SCHEMA, path], { encoding: "utf8" });
}

function assertBoth(path, expected, label, harness = HARNESS) {
  const schema = schemaValidate(path);
  const ps = runPs(["-Mode", "ValidateReceipt", "-ReceiptPath", path, "-ExpectedHarnessSha", harness]);
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
  return { coop_version: manifest.coop_version, doctor: { fail: 0, checks }, npm_inventory: { dependencies }, extension_inventory: structuredClone(manifest.extensions), mcp_config: { mcpServers, _coop: { managed_servers } } };
}

test("committed Draft 2020-12 schema validator is available and enforces formats", () => {
  assert.equal(schemaProbe.status, 0, `python jsonschema is mandatory: ${schemaProbe.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "coop-schema-format-"));
  const bad = receipt(); bad.execution.started_utc = "not-a-date";
  assert.notEqual(schemaValidate(writeReceipt(dir, bad)).status, 0);
});

test("dual receipt validation binds an explicit harness identity", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-explicit-harness-"));
  const harness = "2".repeat(40); const value = receipt(); value.harness.observed_sha = harness;
  assertBoth(writeReceipt(dir, value), true, "explicit harness identity", harness);
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
    ["missing trust model", (x) => { delete x.trust_model; }],
    ["malicious candidate incorrectly in scope", (x) => { x.trust_model.candidate_admin_code_trusted = false; }],
    ["adversarial containment incorrectly claimed", (x) => { x.trust_model.adversarial_admin_containment = true; }],
    ["trust limitation altered", (x) => { x.trust_model.limitation = "all administrator code is contained"; }],
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
    ["array Warehouse auth state", (x) => { x.claims[0].evidence[0].warehouse_live = { ...liveWarehouseProof(), auth_state: ["authenticated"] }; }],
    ["array Warehouse target validation", (x) => { x.claims[0].evidence[0].warehouse_live = { ...liveWarehouseProof(), target_validation: ["validated"] }; }],
    ["array Warehouse target scope", (x) => { x.claims[0].evidence[0].warehouse_live = { ...liveWarehouseProof(), target_scope: ["item"] }; }],
    ["array Warehouse discovered tool", (x) => { x.claims[0].evidence[0].warehouse_live = { ...liveWarehouseProof(), discovered_tool: ["executeSQL"] }; }],
    ["array Warehouse provenance", (x) => { x.claims[0].evidence[0].warehouse_live = { ...liveWarehouseProof(), provenance: ["live"] }; }],
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
    ["extensions", (x) => { x.extension_inventory[extensionName] = "9.9.9"; }],
    ["extensions_missing", (x) => { delete x.extension_inventory[extensionName]; }],
    ["extensions_extra", (x) => { x.extension_inventory["unmanaged-extension"] = "1.0.0"; }],
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

test("installed extension collector enumerates configured packages independently of the manifest", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-extension-inventory-"));
  const agentRoot = join(dir, "agent");
  const manifest = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));
  const manifestPath = join(dir, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const packages = Object.entries(manifest.extensions).map(([name, version]) => `npm:${name}@${version}`);
  const writePackage = (name, version) => {
    const packageDir = join(agentRoot, "npm", "node_modules", ...name.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version }));
  };
  for (const [name, version] of Object.entries(manifest.extensions)) writePackage(name, version);
  mkdirSync(agentRoot, { recursive: true });
  writeFileSync(join(agentRoot, "settings.json"), JSON.stringify({ packages }));
  const good = runPs(["-Mode", "Probe", "-Probe", "CollectExtensionInventory", "-Root", agentRoot, "-Value", manifestPath]);
  assert.equal(good.status, 0, good.stderr);

  const [firstName, firstVersion] = Object.entries(manifest.extensions)[0];
  const firstMetadata = join(agentRoot, "npm", "node_modules", ...firstName.split("/"), "package.json");
  writeFileSync(firstMetadata, JSON.stringify({ name: "wrong-extension", version: firstVersion }));
  const wrongName = runPs(["-Mode", "Probe", "-Probe", "CollectExtensionInventory", "-Root", agentRoot, "-Value", manifestPath]);
  assert.notEqual(wrongName.status, 0, "collector accepted mismatched package metadata identity");
  writeFileSync(firstMetadata, JSON.stringify({ version: firstVersion }));
  const missingName = runPs(["-Mode", "Probe", "-Probe", "CollectExtensionInventory", "-Root", agentRoot, "-Value", manifestPath]);
  assert.notEqual(missingName.status, 0, "collector accepted missing package metadata identity");
  writePackage(firstName, firstVersion);

  writeFileSync(join(agentRoot, "settings.json"), JSON.stringify({ packages: [...packages.slice(0, -1), `${packages.at(-1)}\n`] }));
  const trailingNewline = runPs(["-Mode", "Probe", "-Probe", "CollectExtensionInventory", "-Root", agentRoot, "-Value", manifestPath]);
  assert.notEqual(trailingNewline.status, 0, "collector accepted a package spec with a trailing newline");

  const extraName = "unmanaged-extension"; const extraVersion = "1.0.0";
  writePackage(extraName, extraVersion);
  writeFileSync(join(agentRoot, "settings.json"), JSON.stringify({ packages: [...packages, `npm:${extraName}@${extraVersion}`] }));
  const extra = runPs(["-Mode", "Probe", "-Probe", "CollectExtensionInventory", "-Root", agentRoot, "-Value", manifestPath]);
  assert.notEqual(extra.status, 0, "collector silently excluded an extra configured extension");
});

test("rollback npm reconciliation executes, fails closed, and precedes proof construction", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-npm-reconcile-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ "@scope/absent": "NOT_INSTALLED", "@scope/pinned": "1.2.3" }));
  const success = runPs(["-Mode", "Probe", "-Probe", "ReconcileNpmState", "-Root", statePath, "-Value", "0"]);
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout.trim()), ["uninstall -g @scope/absent", "install -g @scope/pinned@1.2.3"]);
  const failure = runPs(["-Mode", "Probe", "-Probe", "ReconcileNpmState", "-Root", statePath, "-Value", "17"]);
  assert.notEqual(failure.status, 0, "failed npm reconciliation was accepted");
  assert.ok(failure.stderr.includes("exited 17"), "failed npm reconciliation did not propagate its exit code");

  const source = readFileSync(SCRIPT, "utf8");
  const baselineCapture = source.indexOf("$baselineNpmToolState = [ordered]@{}");
  const candidateInstall = source.indexOf("$candidateInstall = Invoke-Bounded");
  const rollbackInstall = source.indexOf("$rollback = Invoke-Bounded");
  const reconciliation = source.indexOf("[void](Invoke-NpmRollbackReconciliation ([pscustomobject]$baselineNpmToolState) $logs)");
  const rollbackInventory = source.indexOf("$rollbackNpm = Invoke-Bounded");
  const rollbackComparison = source.indexOf("if ($actual -cne $baselineNpmToolState[$name])");
  const proofConstruction = source.indexOf("$rollbackPinProof = Get-ManifestPinProof");
  assert.ok(baselineCapture > 0 && baselineCapture < candidateInstall, "baseline npm state must be captured before upgrade");
  assert.ok(rollbackInstall < reconciliation && reconciliation < rollbackInventory, "npm reconciliation must run after baseline source install and before rollback inventory");
  assert.ok(rollbackInventory < rollbackComparison && rollbackComparison < proofConstruction, "actual baseline comparison must succeed before rollback proof construction");
  assert.ok(source.includes("$rollbackExpected.npm_tools.PSObject.Properties.Remove($name)"), "an initially absent npm tool must remain absent in rollback proof");
});

test("bounded behavioral suite re-finalizes immutable artifacts and checkouts before upload", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const contract = (candidate) => {
    const snapshotHelper = candidate.match(/function Get-CheckoutSnapshot[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(snapshotHelper, /Get-DirectTreeHash \$Path \$true/);
    assert.match(snapshotHelper, /Get-DirectTreeHash \$git \$false/);
    const block = candidate.match(/if \(\$Mode -eq 'RunBehavioralSuite'\) \{([\s\S]*?)\n\}\n\nif \(\$Mode -eq 'ValidateReceipt'\)/)?.[1] ?? "";
    assert.ok(block, "post-suite finalization mode missing");
    const receiptHash = block.indexOf("$receiptBefore = Get-FileSha $ReceiptPath");
    const evidenceHash = block.indexOf("$evidenceBefore = Get-TreeHash $EvidenceRoot");
    const checkoutHash = block.indexOf("$checkoutSnapshots[$item.Label] = Get-CheckoutSnapshot $item.Path");
    const commandHash = block.indexOf("$commandFileHashes[$name] = if ($path) { Get-FileSha $path } else { '' }");
    const environmentClear = block.indexOf("[Environment]::SetEnvironmentVariable($name, $null, 'Process')");
    const bounded = block.indexOf("$suite = Invoke-Bounded 'powershell.exe'");
    const environmentRestore = block.indexOf("[Environment]::SetEnvironmentVariable($name, $commandFileValues[$name], 'Process')", bounded);
    const exitGate = block.indexOf("Assert-ExitZero $suite 'exact-candidate behavioral suite'");
    const processGate = block.indexOf("Stop-TrackedProcessTrees", exitGate);
    const mutationGate = block.indexOf("throw 'behavioral suite mutated frozen artifacts'");
    const commandGate = block.indexOf("throw \"behavioral suite mutated GitHub command file: $name\"", mutationGate);
    const snapshotGate = block.indexOf("Assert-CheckoutSnapshot $checkoutSnapshots[$item.Label] $item.Path $item.Label", commandGate);
    const canaryGate = block.indexOf("$evidenceHits = @(Find-Canary $EvidenceRoot $Canary)", snapshotGate);
    const revoke = block.indexOf("Remove-UploadAuthorizations $ReceiptPath", canaryGate);
    const receiptAuth = block.indexOf("\n    New-UploadAuthorization 'Receipt' $ReceiptPath $RunNonce $ExpectedHarnessSha", revoke);
    const evidenceAuth = block.indexOf("\n    New-UploadAuthorization 'Evidence' $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot", receiptAuth);
    assert.ok(receiptHash >= 0 && evidenceHash >= 0 && checkoutHash >= 0 && commandHash >= 0 && receiptHash < bounded && evidenceHash < bounded && checkoutHash < bounded && commandHash < bounded, "artifacts, checkouts, git metadata, and command files must be frozen before the suite");
    assert.ok(commandHash < environmentClear && environmentClear < bounded && bounded < environmentRestore && environmentRestore < exitGate, "GitHub command channels must be absent from the bounded child and restored only after it exits");
    assert.ok(exitGate < processGate && processGate < mutationGate && mutationGate < commandGate && commandGate < snapshotGate && snapshotGate < canaryGate, "post-suite checks must be direct, process-closed, and ordered without git execution");
    assert.doesNotMatch(block.slice(exitGate, revoke), /(?:^|\s)git(?:\s|$)|Assert-FrozenArtifactsSafe|Assert-CheckoutIdentity/, "post-suite finalization must not execute candidate-controlled git configuration");
    assert.match(block, /try \{[\s\S]*\$suite = Invoke-Bounded[\s\S]*\} finally \{[\s\S]*SetEnvironmentVariable\(\$name, \$commandFileValues\[\$name\]/);
    assert.ok(canaryGate < revoke && revoke < receiptAuth && receiptAuth < evidenceAuth, "only post-suite finalization may re-authorize uploads");
    assert.match(block, /catch \{[\s\S]*Remove-UploadAuthorizations \$ReceiptPath[\s\S]*throw/);
  };
  contract(source);
  for (const [index, mutant] of [
    source.replace("$suite = Invoke-Bounded 'powershell.exe'", "$suite = Start-Process 'powershell.exe'"),
    source.replace("Assert-ExitZero $suite 'exact-candidate behavioral suite'", "Write-Output $suite.ExitCode"),
    source.replace("throw 'behavioral suite mutated frozen artifacts'", "Write-Output 'artifact mutation ignored'"),
    source.replace("[Environment]::SetEnvironmentVariable($name, $null, 'Process')", "# command channels left available"),
    source.replace("$commandFileHashes[$name] = if ($path) { Get-FileSha $path } else { '' }", "$commandFileHashes[$name] = ''"),
    source.replace("    Stop-TrackedProcessTrees\n    if ((Get-FileSha $ReceiptPath)", "    # process cleanup skipped\n    if ((Get-FileSha $ReceiptPath)"),
    source.replace("Assert-CheckoutSnapshot $checkoutSnapshots[$item.Label] $item.Path $item.Label", "Write-Output 'snapshot skipped'"),
    source.replace("Get-DirectTreeHash $git $false", "Get-DirectTreeHash $Path $true"),
    source.replace("New-UploadAuthorization 'Evidence' $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot", "# New-UploadAuthorization 'Evidence' $ReceiptPath $RunNonce $ExpectedHarnessSha $EvidenceRoot"),
  ].entries()) assert.throws(() => contract(mutant), `post-suite finalization mutant ${index} was accepted`);
});

test("failure-path canary contamination removes evidence and emits no upload marker", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-finalize-")); const evidenceRoot = join(dir, "evidence"); mkdirSync(evidenceRoot);
  const receiptPath = join(dir, "receipt.json"); const canary = "FINALIZATION-CANARY";
  writeFileSync(join(evidenceRoot, "unsafe.log"), `leaked=${canary}`); writeFileSync(receiptPath, "{}");
  const result = runPs(["-Mode", "Probe", "-Probe", "FinalizeArtifacts", "-Root", evidenceRoot, "-Value", receiptPath, "-Canary", canary]);
  assert.notEqual(result.status, 0); assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false); assert.equal(existsSync(evidenceRoot), false);
});

test("artifact finalization rejects directory links before hashing or canary scanning", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-reparse-finalize-"));
  const evidenceRoot = join(dir, "evidence"); const outside = join(dir, "outside");
  mkdirSync(evidenceRoot); mkdirSync(outside); writeFileSync(join(outside, "unscanned.txt"), "REPARSE-CANARY");
  symlinkSync(outside, join(evidenceRoot, "junction"), process.platform === "win32" ? "junction" : "dir");
  const receiptPath = join(dir, "receipt.json"); writeFileSync(receiptPath, "{}");
  const result = runPs(["-Mode", "Probe", "-Probe", "FinalizeArtifacts", "-Root", evidenceRoot, "-Value", receiptPath, "-Canary", "REPARSE-CANARY"]);
  assert.notEqual(result.status, 0, "directory link escaped artifact validation");
  assert.match(result.stderr, /reparse point/i);
  assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false);
  assert.equal(existsSync(evidenceRoot), true, "rejected evidence tree was recursively removed");
  assert.equal(readFileSync(join(outside, "unscanned.txt"), "utf8"), "REPARSE-CANARY", "reparse target was traversed or removed");
});

test("artifact finalization rejects a junctioned ancestor before reading its target", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-reparse-ancestor-"));
  const actualParent = join(dir, "actual"); const actualEvidence = join(actualParent, "evidence");
  mkdirSync(actualEvidence, { recursive: true }); writeFileSync(join(actualEvidence, "outside.txt"), "ANCESTOR-CANARY");
  const linkedParent = join(dir, "linked-parent");
  symlinkSync(actualParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const receiptPath = join(dir, "receipt.json"); writeFileSync(receiptPath, "{}");
  const linkedEvidence = join(linkedParent, "evidence");
  for (const probe of ["FinalizeArtifacts", "HashTree", "HashDirectTree", "ScanCanary"]) {
    const args = ["-Mode", "Probe", "-Probe", probe, "-Root", linkedEvidence];
    if (probe === "FinalizeArtifacts") args.push("-Value", receiptPath);
    if (probe === "FinalizeArtifacts" || probe === "ScanCanary") args.push("-Canary", "ANCESTOR-CANARY");
    const result = runPs(args);
    assert.notEqual(result.status, 0, `junctioned ancestor escaped ${probe}`);
    assert.match(result.stderr, /reparse ancestry rejected/i);
    assert.doesNotMatch(result.stderr, /credential canary found|canary found in receipt/i, "external target was scanned before ancestry rejection");
  }
  const create = runPs(["-Mode", "Probe", "-Probe", "AssertEmptyRoot", "-Root", join(linkedParent, "new-owned")]);
  assert.notEqual(create.status, 0, "normal owned-root creation entered a junctioned ancestor");
  assert.match(create.stderr, /reparse ancestry rejected/i);
  assert.equal(existsSync(join(actualParent, "new-owned")), false, "owned root was created inside the junction target");
  assert.equal(existsSync(actualEvidence), true, "rejected evidence tree was recursively removed");
  assert.equal(readFileSync(join(actualEvidence, "outside.txt"), "utf8"), "ANCESTOR-CANARY", "junction target was removed");
  assert.equal(existsSync(`${receiptPath}.evidence-authorization.json`), false);
});

test("authorization revocation and validation reject linked paths before reading or removal", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-reparse-authorization-"));
  const evidenceRoot = join(dir, "evidence"); mkdirSync(evidenceRoot); writeFileSync(join(evidenceRoot, "safe.txt"), "safe");
  const receiptPath = writeReceipt(dir, receipt());
  const authorizationPath = `${receiptPath}.receipt-authorization.json`;
  const outside = join(dir, "outside-authorization.json"); writeFileSync(outside, "EXTERNAL-AUTHORIZATION");
  symlinkSync(outside, authorizationPath, "file");
  const authorize = runPs(["-Mode", "Probe", "-Probe", "AuthorizeArtifacts", "-Root", evidenceRoot, "-ReceiptPath", receiptPath, "-Value", "a".repeat(32), "-Canary", HARNESS]);
  assert.notEqual(authorize.status, 0, "revocation followed a linked authorization leaf");
  assert.match(authorize.stderr, /reparse ancestry rejected/i);
  assert.equal(readFileSync(outside, "utf8"), "EXTERNAL-AUTHORIZATION", "revocation removed or changed the external authorization target");
  const validate = runPs(["-Mode", "ValidateUploadAuthorization", "-AuthorizationKind", "Receipt", "-ReceiptPath", receiptPath, "-RunNonce", "a".repeat(32)]);
  assert.notEqual(validate.status, 0, "validator followed a linked authorization leaf");
  assert.match(validate.stderr, /reparse ancestry rejected/i);
  assert.equal(readFileSync(outside, "utf8"), "EXTERNAL-AUTHORIZATION", "validator changed the external authorization target");
});

test("failure cleanup rejects a linked receipt ancestor without deleting its marker target", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-reparse-marker-cleanup-"));
  const evidenceRoot = join(dir, "evidence"); const outsideEvidence = join(dir, "outside-evidence");
  mkdirSync(evidenceRoot); mkdirSync(outsideEvidence); writeFileSync(join(outsideEvidence, "canary.txt"), "MARKER-CANARY");
  symlinkSync(outsideEvidence, join(evidenceRoot, "junction"), process.platform === "win32" ? "junction" : "dir");
  const actualReceiptParent = join(dir, "actual-receipts"); mkdirSync(actualReceiptParent);
  const linkedReceiptParent = join(dir, "linked-receipts"); symlinkSync(actualReceiptParent, linkedReceiptParent, process.platform === "win32" ? "junction" : "dir");
  const receiptPath = join(linkedReceiptParent, "receipt.json");
  const outsideMarker = join(actualReceiptParent, "receipt.json.evidence-authorization.json"); writeFileSync(outsideMarker, "EXTERNAL-MARKER");
  const result = runPs(["-Mode", "Probe", "-Probe", "FinalizeArtifacts", "-Root", evidenceRoot, "-Value", receiptPath, "-Canary", "MARKER-CANARY"]);
  assert.notEqual(result.status, 0, "linked receipt ancestor survived failure cleanup");
  assert.equal(readFileSync(outsideMarker, "utf8"), "EXTERNAL-MARKER", "failure cleanup deleted the linked marker target");
  assert.equal(existsSync(evidenceRoot), true, "rejected evidence was recursively removed");
});

test("checkout ancestry is rejected before git or snapshot access", { skip: !havePwsh }, () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-reparse-checkout-"));
  const actualParent = join(dir, "actual"); const checkout = join(actualParent, "checkout"); mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "sentinel.txt"), "CHECKOUT-SENTINEL");
  const linkedParent = join(dir, "linked"); symlinkSync(actualParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const result = runPs(["-Mode", "Probe", "-Probe", "ValidateCheckout", "-Root", join(linkedParent, "checkout"), "-Value", CANDIDATE]);
  assert.notEqual(result.status, 0, "linked checkout ancestor reached git or snapshot access");
  assert.match(result.stderr, /reparse ancestry rejected/i);
  assert.equal(readFileSync(join(checkout, "sentinel.txt"), "utf8"), "CHECKOUT-SENTINEL");
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
const mode=process.argv[2], target=process.argv[3], self=process.argv[1], delay=Number(process.argv[4]||1800);
if(mode==="success"){process.stdout.write("exact-stdout\\n");process.stderr.write("exact-stderr\\n");process.exit(23)}
if(mode==="unicode"){process.stdout.write(JSON.stringify({argv:process.argv.slice(3),stdin:readFileSync(0,"utf8")}));process.exit(0)}
if(mode==="leaf"){const startedAtMs=Date.now(),token=process.pid+":"+startedAtMs;const server=createServer(socket=>socket.end(token));server.listen(0,"127.0.0.1",()=>{writeFileSync(target+".identity.json",JSON.stringify({pid:process.pid,port:server.address().port,startedAtMs,token}));setTimeout(()=>writeFileSync(target,"late-write"),delay)})}
else if(mode==="churn"){setInterval(()=>spawn(process.execPath,[self,"leaf",target],{stdio:"ignore"}),5)}
else if(mode==="cleanup-race"){spawn(process.execPath,[self,"churn",target],{stdio:"ignore"});setInterval(()=>{},1000)}
else if(mode==="parent-success"){spawn(process.execPath,[self,"leaf",target],{stdio:"ignore"})}
else if(mode==="parent-with-descendant"){spawn(process.execPath,[self,"leaf",target,"4000"],{stdio:"ignore"});const deadline=Date.now()+1000;const wait=setInterval(()=>{if(existsSync(target+".identity.json")||Date.now()>deadline){clearInterval(wait);process.exit(0)}},10)}
else if(mode==="owned-timeout"){spawn(process.execPath,[self,"leaf",target,"6000"],{stdio:"ignore"});const deadline=Date.now()+3000;const wait=setInterval(()=>{if(existsSync(target+".identity.json")){clearInterval(wait);setInterval(()=>{},1000)}else if(Date.now()>deadline){clearInterval(wait);process.exit(2)}},10)}
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
  const result = spawnSync(PYTHON_PATH, [join(ROOT, "scripts", "knowledge-git.py"), "--timeout-seconds", "10", "--stdin-file", input, "--argv-file", argvPath], {
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
      assertBoth(receiptPath, true, `${fault}: generated receipt`, harnessSha);
      const generated = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(generated.terminal_workstation_ready, false, `${fault}: failure receipt claimed readiness`);
      const completion = generated.claims.filter((item) => item.id === "automated-harness-completion");
      assert.equal(completion.length, 1, `${fault}: exact completion failure claim missing`);
      assert.equal(completion[0].status, "FAIL", `${fault}: completion claim was not FAIL`);
      assert.match(completion[0].summary, new RegExp(`observed ownership lifecycle ${fault} outcome (failure|indeterminate) failed closed`));
      assert.match(completion[0].evidence[0].observed, /^one authentic helper stderr lifecycle record; sha256=[0-9a-f]{64}$/);
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
      const postFinalizationWaitMs = ["job-terminate", "job-close"].includes(fault) ? 5000 : 2200;
      await new Promise((resolveWait) => setTimeout(resolveWait, postFinalizationWaitMs));
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

test("certification Python pin reaches bounded helpers and baseline onboarding", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "coop-python-pin-"));
  let probeNumber = 0;
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const invalidFirstDir = join(dir, "invalid-first");
  mkdirSync(invalidFirstDir);
  const invalidPython = join(invalidFirstDir, process.platform === "win32" ? "python3.exe" : "python3");
  copyFileSync(process.execPath, invalidPython);
  chmodSync(invalidPython, 0o755);
  const probe = (candidate, env, cwd = dir) => {
    const script = join(dir, `probe-${probeNumber++}.ps1`);
    writeFileSync(script, candidate, "utf8");
    return spawnSync(PWSH, ["-NoLogo", "-NoProfile", "-File", script, "-Mode", "Probe", "-Probe", "ResolvePython"], { encoding: "utf8", env, cwd });
  };
  const assertWiring = (candidate) => {
    assert.match(candidate, /IsPathRooted\(\$Path\)/);
    assert.match(candidate, /Equals\(\$Path, \$expected, \$comparison\)/);
    assert.match(candidate, /Test-Path -LiteralPath \$expected -PathType Leaf/);
    assert.match(candidate, /& \$expected -c 'import os,sys; print\(os\.path\.abspath\(sys\.executable\)\)'/);
    assert.equal((candidate.match(/Get-AcceptancePython/g) || []).length, 4);
    assert.match(candidate, /try \{ \$pythonPath = Get-AcceptancePython \} catch \{ \$pythonPath = '' \}/);
    assert.match(candidate, /FilePath = \$pythonPath/);
    assert.match(candidate, /\$onboardPython = Get-AcceptancePython[\s\S]*Invoke-Bounded \$onboardPython/);
  };
  const assertBehavior = (candidate) => {
    const pinnedPath = resolve(PYTHON_PATH);
    const pinned = probe(candidate, { ...process.env, CERT_PYTHON: pinnedPath });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(normalize(pinned.stdout.trim()), normalize(pinnedPath));

    const fallbackEnv = { ...process.env };
    delete fallbackEnv.CERT_PYTHON;
    fallbackEnv.PATH = dirname(pinnedPath);
    const fallback = probe(candidate, fallbackEnv);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(normalize(fallback.stdout.trim()), normalize(pinnedPath));

    const invalidFirstEnv = { ...process.env, PATH: `${invalidFirstDir}${delimiter}${dirname(pinnedPath)}` };
    delete invalidFirstEnv.CERT_PYTHON;
    const invalidFirst = probe(candidate, invalidFirstEnv);
    assert.equal(invalidFirst.status, 0, invalidFirst.stderr);
    assert.equal(normalize(invalidFirst.stdout.trim()), normalize(pinnedPath));

    const allInvalidEnv = { ...process.env, PATH: invalidFirstDir };
    delete allInvalidEnv.CERT_PYTHON;
    assert.notEqual(probe(candidate, allInvalidEnv).status, 0);

    assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: relative(dir, pinnedPath) }).status, 0);
    const separator = process.platform === "win32" ? "\\" : "/";
    const nonCanonical = `${dirname(pinnedPath)}${separator}unused-segment${separator}..${separator}${basename(pinnedPath)}`;
    assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: nonCanonical }).status, 0);
    if (process.platform === "win32") {
      assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: `${pinnedPath.slice(0, 2)}${basename(pinnedPath)}` }, dirname(pinnedPath)).status, 0);
      assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: pinnedPath.slice(2) }, dirname(pinnedPath)).status, 0);
    }
    assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: join(dir, "missing-python.exe") }).status, 0);
    assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: join(ROOT, "README.md") }).status, 0);
    assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: pinnedPath.replace(/.(?=[^/\\]+$)/, "[$&]") }).status, 0);
    assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: resolve(process.execPath) }).status, 0);
    const wrapper = join(dir, process.platform === "win32" ? "python-wrapper.cmd" : "python-wrapper");
    if (process.platform === "win32") writeFileSync(wrapper, `@echo off\r\n"${pinnedPath}" %*\r\n`, "utf8");
    else { writeFileSync(wrapper, `#!/bin/sh\nexec '${pinnedPath.replaceAll("'", "'\\''")}' "$@"\n`, "utf8"); chmodSync(wrapper, 0o755); }
    assert.notEqual(probe(candidate, { ...process.env, CERT_PYTHON: wrapper }).status, 0);
  };
  assertWiring(source);
  assertBehavior(source);
  for (const [index, mutant] of [
    source.replace("if ($env:CERT_PYTHON) {", "if ($false) {"),
    source.replace("return Resolve-AcceptancePythonExecutable $env:CERT_PYTHON", "return 'python'"),
    source.replace("try { return Resolve-AcceptancePythonExecutable $python.Source }", `try { return '${resolve(process.execPath).replaceAll("'", "''")}' }`),
    source.replace("if (-not [string]::Equals($Path, $expected, $comparison))", "if ($false)"),
    source.replace("if (-not [string]::Equals($actual, $expected, $comparison))", "if ($false)"),
  ].entries()) assert.throws(() => assertBehavior(mutant), `Python resolver behavioral mutant ${index} was accepted`);
  for (const [index, mutant] of [
    source.replace("FilePath = $pythonPath", "FilePath = 'python'"),
    source.replace("$onboardPython = Get-AcceptancePython", "$onboardPython = 'python'"),
  ].entries()) assert.throws(() => assertWiring(mutant), `Python resolver wiring mutant ${index} was accepted`);
});

test("upgrade preserves operator state while managed MCP converges by release", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const upgradePreservation = 'foreach ($file in $preservedStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "preserved state changed during candidate upgrade: $file" } }';
  const reinstallPreservation = 'foreach ($file in $preservedStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during same-candidate reinstall: $file" } }';
  const rollbackPreservation = 'foreach ($file in $preservedStateFiles) { if ((Get-FileSha $file) -ne $stateBefore[$file]) { throw "state changed during rollback: $file" } }';
  const candidateIdempotence = "if ((Get-FileSha $managedMcpPath) -ne $candidateMcpSha) { throw 'managed MCP state changed during same-candidate reinstall' }";
  const baselineConvergence = "if ((Get-FileSha $managedMcpPath) -ne $baselineMcpSha) { throw 'managed MCP state did not converge to the baseline during rollback' }";
  const contract = (candidate) => {
    const preserved = candidate.match(/\$preservedStateFiles = @\(([\s\S]*?)\n  \)/)?.[1] ?? "";
    assert.match(preserved, /user\.json/);
    assert.match(preserved, /\.coop\\config/);
    assert.match(preserved, /project\.yml/);
    assert.doesNotMatch(preserved, /mcp\.json/);
    assert.ok(candidate.includes("$baselineMcpSha = $stateBefore[$managedMcpPath]"));
    assert.ok(candidate.includes("$candidateMcpSha = Get-FileSha $managedMcpPath"));
    for (const check of [upgradePreservation, reinstallPreservation, rollbackPreservation, candidateIdempotence, baselineConvergence]) {
      assert.ok(candidate.includes(check), `missing state-transition check: ${check}`);
    }
  };
  contract(source);
  for (const check of [upgradePreservation, reinstallPreservation, rollbackPreservation, candidateIdempotence, baselineConvergence]) {
    const removed = source.replace(check, "");
    const inverted = source.replace(check, check.replace(" -ne ", " -eq "));
    assert.throws(() => contract(removed), `removed check was accepted: ${check}`);
    assert.throws(() => contract(inverted), `inverted check was accepted: ${check}`);
  }
});

test("workflow binds dispatch and the named same-repo PR to the exact event-authorized SHA", () => {
  for (let current = WORKFLOW; ; current = dirname(current)) {
    assert.equal(lstatSync(current).isSymbolicLink(), false, `certification workflow ancestry must not contain a symbolic link: ${current}`);
    if (current === ROOT) break;
    assert.notEqual(dirname(current), current, "certification workflow path escaped the repository root");
  }
  const workflowStat = lstatSync(WORKFLOW);
  assert.equal(workflowStat.isSymbolicLink(), false, "certification workflow path must not be a symbolic link");
  assert.equal(workflowStat.isFile(), true, "certification workflow path must be a regular file");
  const workflowBytes = readFileSync(WORKFLOW);
  const workflow = workflowBytes.toString("utf8");
  assert.equal(Buffer.from(workflow, "utf8").equals(workflowBytes), true, "certification workflow must be canonical UTF-8 bytes");
  assert.match(readFileSync(join(ROOT, ".gitattributes"), "utf8"), /^\.github\/workflows\/windows-terminal-workstation-acceptance\.yml text eol=lf$/m, "certification workflow line endings must be pinned to LF");
  const workflowRepoPath = ".github/workflows/windows-terminal-workstation-acceptance.yml";
  const indexEntry = execFileSync("git", ["-C", ROOT, "ls-files", "-s", "--", workflowRepoPath], { encoding: "utf8" }).trim();
  const indexMatch = indexEntry.match(/^100644 ([0-9a-f]{40}) 0\t\.github\/workflows\/windows-terminal-workstation-acceptance\.yml$/);
  assert.ok(indexMatch, "certification workflow must be one ordinary 100644 Git index entry");
  const gitBlob = createHash("sha1").update(`blob ${workflowBytes.length}\0`).update(workflowBytes).digest("hex");
  assert.equal(gitBlob, indexMatch[1], "certification workflow bytes must match the indexed Git blob");
  const expectedGate = "if: ${{ github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.base_ref == 'main' && github.head_ref == 'integration/presentation-2026-09-20' && github.event.pull_request.head.repo.full_name == github.repository) }}";
  const contract = (source) => {
    assert.equal(createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"), "81e2175aa448c5321978ec1f9b1349a03237c6923c053047dd71f0d041699624", "exact acceptance workflow source changed");
    assert.match(source, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*candidate_sha:[\s\S]*required: true[\s\S]*pull_request:\s*\n\s*branches:\s*\n\s*- main/);
    assert.ok(source.includes(expectedGate), "native job must reject unauthorized PR heads and forks");
    assert.match(source, /permissions:\s*\n\s*contents: read/);
    assert.doesNotMatch(source, /pull_request_target|permissions:\s*write|contents:\s*write|pull-requests:\s*write/);
    assert.equal((source.match(/persist-credentials: false/g) || []).length, 3);
    assert.match(source, /Validate event-authorized candidate input[\s\S]*CANDIDATE_SHA -cnotmatch '\^\[0-9a-f\]\{40\}\$'[\s\S]*Checkout acceptance harness identity/);
    assert.match(source, /CANDIDATE_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| inputs\.candidate_sha \}\}/);
    assert.equal((source.match(/ref: \$\{\{ env\.CANDIDATE_SHA \}\}/g) || []).length, 2);
    assert.match(source, /\$observed = \(& git -C \$checkout rev-parse HEAD\)\.Trim\(\)[\s\S]*\$observed -cne \$expected/);
    assert.equal((source.match(/^      - name: Run exact-candidate behavioral tests under Windows PowerShell 5\.1$/gm) || []).length, 1);
    const yamlCode = "import importlib.util,json,sys;p=sys.argv[1];s=importlib.util.spec_from_file_location('_coop_yaml',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m._load_fallback(sys.stdin.read())))";
    const yamlProbe = spawnSync(PYTHON_PATH, ["-c", yamlCode, YAML_READER], { encoding: "utf8", input: source });
    assert.equal(yamlProbe.status, 0, yamlProbe.stderr);
    const activeSteps = JSON.parse(yamlProbe.stdout)?.jobs?.["native-windows-p0"]?.steps;
    assert.ok(Array.isArray(activeSteps), "native Windows workflow steps must parse");
    const exactCandidateSuiteSteps = activeSteps.filter((step) => step?.name === "Run exact-candidate behavioral tests under Windows PowerShell 5.1");
    const suiteRun = [
      "$harnessRoot = Join-Path $env:GITHUB_WORKSPACE 'harness'",
      "$candidateRoot = Join-Path $env:GITHUB_WORKSPACE 'candidate'",
      "$baselineRoot = Join-Path $env:GITHUB_WORKSPACE 'baseline'",
      "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `",
      "..\\harness\\acceptance\\windows-terminal-workstation.ps1 `",
      "-Mode RunBehavioralSuite `",
      "-HarnessRoot $harnessRoot `",
      "-CandidateRoot $candidateRoot `",
      "-BaselineRoot $baselineRoot `",
      "-EvidenceRoot $env:EVIDENCE_PATH `",
      "-ReceiptPath $env:RECEIPT_PATH `",
      "-RunNonce $env:RUN_NONCE `",
      "-Canary $env:EVIDENCE_CANARY `",
      "-ExpectedHarnessSha $env:VERIFIED_CANDIDATE_SHA `",
      "-ExpectedCandidateSha $env:VERIFIED_CANDIDATE_SHA `",
      "-ExpectedCandidateBuild $env:VERIFIED_CANDIDATE_BUILD",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].join("\n");
    assert.deepEqual(exactCandidateSuiteSteps, [{
      name: "Run exact-candidate behavioral tests under Windows PowerShell 5.1",
      id: "exact_behavioral_suite",
      shell: "powershell",
      "working-directory": "candidate",
      run: suiteRun,
    }]);
    assert.doesNotMatch(source, /-HarnessRoot \(Resolve-Path|-CandidateRoot \(Resolve-Path|-BaselineRoot \(Resolve-Path/);
    const verifyStep = activeSteps.find((step) => step?.name === "Verify event-authorized exact checkout identity");
    const verifyRun = verifyStep?.run ?? "";
    const safeLoop = "foreach ($checkout in @($harness,$candidate,$baseline)) { Assert-SafeCheckout $checkout }";
    assert.ok(verifyRun.split("\n").includes(safeLoop), "checkout scan must be an unconditional statement");
    assert.match(verifyRun, /if \(\(\$item\.Attributes -band \[System\.IO\.FileAttributes\]::ReparsePoint\) -ne 0\) \{ throw "checkout reparse ancestry rejected/);
    assert.match(verifyRun, /if \(\(\$item\.Attributes -band \[System\.IO\.FileAttributes\]::ReparsePoint\) -ne 0\) \{ throw "checkout contains a reparse point/);
    assert.ok(verifyRun.indexOf(safeLoop) >= 0 && verifyRun.indexOf(safeLoop) < verifyRun.indexOf("git -C"), "checkout scan must precede first git access");
    assert.ok(verifyRun.indexOf(safeLoop) < verifyRun.indexOf("$version = (Get-Content"), "checkout scan must precede VERSION access");
    assert.ok(verifyRun.indexOf(safeLoop) < verifyRun.indexOf("$module = (New-Object System.Uri"), "checkout scan must precede module access");
    const pythonPinIndex = activeSteps.findIndex((step) => step?.name === "Pin runner Python for certification");
    const exactSuiteIndex = activeSteps.findIndex((step) => step?.name === "Run exact-candidate behavioral tests under Windows PowerShell 5.1");
    const validationStep = activeSteps.find((step) => step?.name === "Validate fail-closed receipt");
    const receiptUploadStep = activeSteps.find((step) => step?.name === "Upload fail-closed receipt");
    const evidenceUploadStep = activeSteps.find((step) => step?.name === "Upload fully scanned automated evidence");
    const dependencyIndex = activeSteps.findIndex((step) => step?.name === "Install receipt-schema test dependency");
    const ownershipIndex = activeSteps.findIndex((step) => step?.name === "Exercise ownership faults and Unicode transport");
    const nativeAcceptanceIndex = activeSteps.findIndex((step) => step?.name === "Run native acceptance (cannot close human gate)");
    assert.ok(pythonPinIndex >= 0 && dependencyIndex >= 0 && ownershipIndex >= 0 && nativeAcceptanceIndex >= 0 && exactSuiteIndex >= 0);
    assert.ok(pythonPinIndex < dependencyIndex && dependencyIndex < ownershipIndex && ownershipIndex < nativeAcceptanceIndex && nativeAcceptanceIndex < exactSuiteIndex, "the exact behavioral suite must run only after every acceptance Python consumer");
    assert.equal(validationStep?.if, "always() && steps.exact_behavioral_suite.outcome == 'success'");
    assert.equal(validationStep?.id, "validate_artifacts");
    const nativeRun = activeSteps[nativeAcceptanceIndex]?.run ?? "";
    assert.match(nativeRun, /-Mode Run `[\s\S]*-HarnessRoot \$harnessRoot `[\s\S]*-CandidateRoot \$candidateRoot `[\s\S]*-BaselineRoot \$baselineRoot `/);
    assert.doesNotMatch(nativeRun, /Resolve-Path/);
    const validationRun = validationStep?.run ?? "";
    assert.match(validationRun, /receipt_uploadable=true[\s\S]*GITHUB_OUTPUT/);
    assert.match(validationRun, /evidence_uploadable=true[\s\S]*GITHUB_OUTPUT/);
    assert.doesNotMatch(validationRun, /Test-Path/i);
    const receiptOutput = '"receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append';
    const evidenceCommand = "-Mode ValidateUploadAuthorization -AuthorizationKind Evidence `";
    const receiptOutputIndex = validationRun.indexOf(receiptOutput);
    const evidenceCommandIndex = validationRun.indexOf(evidenceCommand, receiptOutputIndex + receiptOutput.length);
    const evidenceCheckIndex = validationRun.indexOf("if ($LASTEXITCODE -ne 0) { throw 'current evidence upload authorization failed' }", evidenceCommandIndex);
    const evidenceOutputIndex = validationRun.indexOf('"evidence_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append');
    const evidencePrefix = validationRun.slice(receiptOutputIndex + receiptOutput.length, evidenceCommandIndex);
    assert.ok(receiptOutputIndex >= 0 && evidenceCommandIndex > receiptOutputIndex && !/if\s*\(|Test-Path/i.test(evidencePrefix), "evidence validation must be unconditional after receipt authorization");
    assert.ok(evidenceCheckIndex > evidenceCommandIndex && evidenceOutputIndex > evidenceCheckIndex, "evidence output must follow successful validation");
    assert.equal(receiptUploadStep?.if, "always() && steps.exact_behavioral_suite.outcome == 'success' && steps.validate_artifacts.outcome == 'success' && steps.validate_artifacts.outputs.receipt_uploadable == 'true'");
    assert.equal(evidenceUploadStep?.if, "always() && steps.exact_behavioral_suite.outcome == 'success' && steps.validate_artifacts.outcome == 'success' && steps.validate_artifacts.outputs.evidence_uploadable == 'true'");
    assert.doesNotMatch(source, /RECEIPT_UPLOADABLE|EVIDENCE_UPLOADABLE/);
    const pythonPinRun = [
      "$python = (& .\\harness\\acceptance\\windows-terminal-workstation.ps1 -Mode Probe -Probe ResolvePython | Out-String).Trim()",
      "if ($LASTEXITCODE -ne 0 -or -not $python) { exit 1 }",
      "& $python --version",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      '"CERT_PYTHON=$python" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
      "(Split-Path -Parent $python) | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append",
    ].join("\n");
    const pythonPin = activeSteps[pythonPinIndex];
    assert.deepEqual(pythonPin, {
      name: "Pin runner Python for certification",
      shell: "powershell",
      run: pythonPinRun,
    });

    assert.match(activeSteps[dependencyIndex].run, /& \$env:CERT_PYTHON -m pip install/);
    assert.match(activeSteps[dependencyIndex].run, /& \$env:CERT_PYTHON -c "import jsonschema"/);
    const ownershipStep = activeSteps.find((step) => step?.name === "Exercise ownership faults and Unicode transport");
    assert.match(ownershipStep?.run ?? "", /& \$env:CERT_PYTHON \.\\harness\\tests\\knowledge-git\.test\.py/);
    assert.match(source, /ExpectedCandidateSha \$env:VERIFIED_CANDIDATE_SHA/);
    assert.match(source, /ExpectedCandidateBuild \$env:VERIFIED_CANDIDATE_BUILD/);
    assert.match(source, /VERSION[\s\S]*fingerprintBuild/);
    assert.match(source, new RegExp(`ref: ${BASELINE}`));
    assert.doesNotMatch(source, /github\.sha|refs\/pull|build-[0-9a-f]{8}|295693a/);
    assert.match(source, /ajv-cli@5\.0\.0/); assert.match(source, /terminal-workstation-receipt\.schema\.json/); assert.match(source, /runs-on: windows-latest/);
    assert.match(source, /terminal-workstation-receipt-\$\{\{ env\.VERIFIED_CANDIDATE_SHA \}\}-\$\{\{ env\.VERIFIED_CANDIDATE_BUILD \}\}/);
    assert.match(source, /steps\.exact_behavioral_suite\.outcome == 'success'/);
    assert.match(source, /ValidateUploadAuthorization -AuthorizationKind Receipt/);
    assert.match(source, /ValidateUploadAuthorization -AuthorizationKind Evidence/);
    assert.match(source, /--test-name-pattern "Unicode\|lifecycle\|directory links\|junctioned ancestor\|authorization revocation\|failure cleanup\|checkout ancestry\|owned-root probe\|fully safe authorization\|decisive receipt mutations"/);
    assert.doesNotMatch(source, /secrets\.|GITHUB_TOKEN|repository_dispatch|workflow_run|\bgit push\b/);
  };
  contract(workflow);
  const moveStepBefore = (source, movedName, anchorName) => {
    const movedMarker = `      - name: ${movedName}`;
    const anchorMarker = `      - name: ${anchorName}`;
    const start = source.indexOf(movedMarker);
    const next = source.indexOf("\n      - name:", start + movedMarker.length);
    assert.ok(start >= 0 && next > start, `missing workflow step to move: ${movedName}`);
    const block = source.slice(start, next + 1);
    const without = source.slice(0, start) + source.slice(next + 1);
    const anchor = without.indexOf(anchorMarker);
    assert.ok(anchor >= 0, `missing workflow anchor: ${anchorName}`);
    return without.slice(0, anchor) + block + without.slice(anchor);
  };
  for (const [index, forged] of [
    workflow.replace("github.head_ref == 'integration/presentation-2026-09-20'", "github.head_ref != ''"),
    workflow.replace("github.event.pull_request.head.repo.full_name == github.repository", "true"),
    workflow.replace("ref: ${{ env.CANDIDATE_SHA }}", "ref: ${{ github.sha }}"),
    workflow.replace("$observed -cne $expected", "$false"),
    workflow.replace("Run exact-candidate behavioral tests under Windows PowerShell 5.1\n        id: exact_behavioral_suite\n        shell: powershell", "Run exact-candidate behavioral tests under Windows PowerShell 5.1\n        id: exact_behavioral_suite\n        shell: pwsh"),
    workflow.replace("        working-directory: candidate\n        run: |", "        working-directory: candidate\n        continue-on-error: true\n        run: |"),
    workflow.replace("        shell: powershell\n        working-directory: candidate", "        # shell: powershell\n        shell: pwsh\n        working-directory: candidate"),
    workflow.replace("        working-directory: candidate\n        run: |", "        working-directory: candidate-other\n        run: |"),
    workflow.replace("-Mode RunBehavioralSuite `", "-Mode ValidateReceipt `"),
    workflow.replace("        run: |\n          $harnessRoot = Join-Path $env:GITHUB_WORKSPACE 'harness'", "        \"continue-on-error\": true\n        run: |\n          $harnessRoot = Join-Path $env:GITHUB_WORKSPACE 'harness'"),
    workflow.replace("          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n\n      - name: Validate fail-closed receipt", "          if ($false) { exit $LASTEXITCODE }\n\n      - name: Validate fail-closed receipt"),
    workflow.replace("      - name: Run exact-candidate behavioral tests under Windows PowerShell 5.1", "      - continue-on-error: true\n        #      - name: Run exact-candidate behavioral tests under Windows PowerShell 5.1"),
    workflow.replace("        working-directory: candidate\n        run: |", "        working-directory: candidate\n        continue-on-error: true\n        run: |").replace("    runs-on: windows-latest", "    name: |\n      - name: Run exact-candidate behavioral tests under Windows PowerShell 5.1\n        id: exact_behavioral_suite\n        shell: powershell\n        working-directory: candidate\n        run: .\\tests\\run.ps1\n      - name: scalar terminator\n    runs-on: windows-latest"),
    workflow.replace("-Probe ResolvePython", "-Probe ValidateSha"),
    workflow.replace("$env:GITHUB_PATH -Encoding utf8 -Append", "$env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append"),
    workflow.replace("& $env:CERT_PYTHON -m pip install", "python -m pip install"),
    workflow.replace("& $python --version", "# & $python --version"),
    workflow.replace("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }", "if ($false) { exit $LASTEXITCODE }"),
    workflow.replace('"CERT_PYTHON=$python"', '"CERT_PYTHON=python"'),
    workflow.replace("      - name: Pin runner Python for certification", "      - name: Pin runner Python for certification\n        continue-on-error: true"),
    moveStepBefore(workflow, "Run exact-candidate behavioral tests under Windows PowerShell 5.1", "Install receipt-schema test dependency"),
    moveStepBefore(workflow, "Run exact-candidate behavioral tests under Windows PowerShell 5.1", "Exercise ownership faults and Unicode transport"),
    workflow.replace("if: always() && steps.exact_behavioral_suite.outcome == 'success'\n        shell: powershell", "if: always()\n        shell: powershell"),
    workflow.replace("steps.validate_artifacts.outcome == 'success' && steps.validate_artifacts.outputs.receipt_uploadable == 'true'", "true"),
    workflow.replace("steps.validate_artifacts.outcome == 'success' && steps.validate_artifacts.outputs.evidence_uploadable == 'true'", "true"),
    workflow.replace("& $env:CERT_PYTHON .\\harness\\tests\\knowledge-git.test.py", "python .\\harness\\tests\\knowledge-git.test.py"),
    workflow.replace("          $expected = $env:CANDIDATE_SHA", "          $early = (& git -C (Join-Path $env:GITHUB_WORKSPACE 'candidate') rev-parse HEAD)\n          $expected = $env:CANDIDATE_SHA"),
    workflow.replace("          $expected = $env:CANDIDATE_SHA", "          $early = Get-Content -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'candidate\\VERSION') -Raw\n          $expected = $env:CANDIDATE_SHA"),
    workflow.replace("          $expected = $env:CANDIDATE_SHA", "          $early = (& git --git-dir (Join-Path $env:GITHUB_WORKSPACE 'candidate\\.git') rev-parse HEAD)\n          $expected = $env:CANDIDATE_SHA"),
    workflow.replace("          foreach ($checkout in @($harness,$candidate,$baseline)) { Assert-SafeCheckout $checkout }", "          if ($false) { foreach ($checkout in @($harness,$candidate,$baseline)) { Assert-SafeCheckout $checkout } }"),
    workflow.replace("if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw \"checkout reparse ancestry rejected", "if ($false) { throw \"checkout reparse ancestry rejected"),
    workflow.replace("if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw \"checkout contains a reparse point", "if ($false) { throw \"checkout contains a reparse point"),
    workflow.replace("@($harness,$candidate,$baseline)", "@($harness,$candidate)"),
    workflow.replace("          $candidateRoot = Join-Path $env:GITHUB_WORKSPACE 'candidate'", "          $candidateRoot = Join-Path $env:GITHUB_WORKSPACE 'harness'"),
    workflow.replace("            -CandidateRoot $candidateRoot `", "            -CandidateRoot $harnessRoot `"),
    workflow.replace('          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append', '          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append\n          $marker = Join-Path (Split-Path $env:RECEIPT_PATH -Parent) "evidence-authorization.json"\n          if (Test-Path $marker) { Write-Output "marker exists" }'),
    workflow.replace('          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append', '          if ($false) {\n          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append').replace('          "evidence_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append', '          "evidence_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append\n          }'),
    workflow.replace('          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append\n          powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `', '          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append\n          "evidence_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append\n          powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `'),
    workflow.replace('          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append', '          Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "evidence_uploadable=true"\n          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append'),
    workflow.replace('          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append', '          if ([System.IO.File]::Exists("$env:RECEIPT_PATH.evidence-authorization.json")) { Write-Output "marker exists" }\n          "receipt_uploadable=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append'),
    workflow.replace("      - name: Run native acceptance (cannot close human gate)\n        shell: powershell\n        run: |", "      - name: Run native acceptance (cannot close human gate)\n        shell: powershell\n        run: >"),
    workflow.replace("          $baselineRoot = Join-Path $env:GITHUB_WORKSPACE 'baseline'\n          powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `\n            .\\harness\\acceptance\\windows-terminal-workstation.ps1 `", "          $baselineRoot = Join-Path $env:GITHUB_WORKSPACE 'baseline'\n          powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `\n\n            .\\harness\\acceptance\\windows-terminal-workstation.ps1 `"),
  ].entries()) assert.throws(() => contract(forged), `workflow mutant ${index} was accepted`);
  const testSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(testSource, /COOP_TERMINAL_ACCEPTANCE_OWNERSHIP_FIXTURE[\s\S]*"-Mode", "Run"/);
  assert.match(testSource, /unrelatedIdentity\.startedAtMs[\s\S]*assertBoth\(receiptPath[\s\S]*completion\[0\]\.status/);
});

test("operator runbook preserves observation boundaries and every journey", () => {
  const doc = readFileSync(DOC, "utf8"); for (const id of [...automatedIds, ...operatorIds]) assert.ok(doc.includes(`\`${id}\``), `missing ${id}`);
  assert.match(doc, /Never run this on Aaron's working installation/); assert.match(doc, /snapshot-capable/); assert.match(doc, /coop auth --json/);
  assert.match(doc, /checklist or template[\s\S]*not acceptance/i); assert.match(doc, /event-authorized candidate SHA/); assert.doesNotMatch(doc, /295693a|build-24297cf9/); assert.match(doc, new RegExp(BASELINE));
});
