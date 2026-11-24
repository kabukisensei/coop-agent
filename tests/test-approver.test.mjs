/**
 * The dev-VM test approver (tests/test-approver.mjs): the three gates refuse
 * on their own, a PRODUCTION question is never answered yes, every answer is
 * audited without text, and the shipped tree does not carry it.
 *
 * Gate lane: the pure gate and answer checks. Extended lane
 * (COOP_TEST_EXTENDED=1): one run against a scripted stand-in for `pi --mode rpc`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotIncludes } from "../desktop/scripts/build-installer.mjs";
import { APPROVE_DECLINE, APPROVE_ONCE, PRODUCTION, answerFor, auditAnswer, checkGates, defaultMarkerPath, insideGitRepository, nearestProjectFile, run } from "./test-approver.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "coop-test-approver-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n${error.stack || error}`); process.exit(1); }
}

// A client folder with a project file naming the fake-data client, and a marker
// file outside any repository that names this machine and that client.
const client = join(temp, "client");
mkdirSync(join(client, ".coop"), { recursive: true });
mkdirSync(join(client, "work", ".git"), { recursive: true });
writeFileSync(join(client, ".coop", "project.yml"), "profile:\n  organization: 'Cooptimize'\n  client: 'Fake Data Co'\n");
const markerDir = join(temp, "machine");
mkdirSync(markerDir);
const marker = join(markerDir, "test-approver.json");
writeFileSync(marker, JSON.stringify({ machine: "DEV-VM", client: "fake data co" }));
const good = { env: { COOP_TEST_APPROVER: "1" }, markerPath: marker, machine: "dev-vm", cwd: join(client, "work") };

await t("all three gates hold: on, with the client named", () => {
  const gate = checkGates(good);
  assert.equal(gate.ok, true);
  assert.equal(gate.client, "Fake Data Co");
  assert.equal(gate.projectFile, join(client, ".coop", "project.yml"));
});

await t("gate 1: without COOP_TEST_APPROVER=1 it refuses, whatever else holds", () => {
  assert.match(checkGates({ ...good, env: {} }).reason, /COOP_TEST_APPROVER/);
  assert.match(checkGates({ ...good, env: { COOP_TEST_APPROVER: "true" } }).reason, /COOP_TEST_APPROVER/);
});

await t("gate 2: the marker file must exist, be JSON, name this machine and sit outside every repository", () => {
  assert.match(checkGates({ ...good, markerPath: join(markerDir, "missing.json") }).reason, /no marker file/);
  assert.match(checkGates({ ...good, machine: "SOMEONE-ELSES-PC" }).reason, /names machine "DEV-VM", this is "SOMEONE-ELSES-PC"/);
  const bad = join(markerDir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.match(checkGates({ ...good, markerPath: bad }).reason, /not JSON/);
  writeFileSync(bad, JSON.stringify({ machine: "DEV-VM" }));
  assert.match(checkGates({ ...good, markerPath: bad }).reason, /"machine" and "client"/);
  const inRepo = join(client, "work", "test-approver.json");
  writeFileSync(inRepo, JSON.stringify({ machine: "DEV-VM", client: "Fake Data Co" }));
  assert.match(checkGates({ ...good, markerPath: inRepo }).reason, /inside a git repository/);
  assert.equal(insideGitRepository(join(client, "work", "deep")), true);
  assert.equal(insideGitRepository(markerDir), false);
});

await t("gate 3: the nearest project file must name the marker's client", () => {
  const other = join(temp, "other");
  mkdirSync(join(other, ".coop"), { recursive: true });
  writeFileSync(join(other, ".coop", "project.yml"), "profile:\n  client: 'A Real Client'\n");
  assert.match(checkGates({ ...good, cwd: other }).reason, /names client "A Real Client", the marker file names "fake data co"/);
  writeFileSync(join(other, ".coop", "project.yml"), "profile:\n  organization: 'Cooptimize'\n");
  assert.match(checkGates({ ...good, cwd: other }).reason, /names no profile.client/);
  assert.match(checkGates({ ...good, cwd: temp }).reason, /no \.coop\/project\.yml/);
  assert.equal(nearestProjectFile(join(client, "work")), join(client, ".coop", "project.yml"));
  assert.equal(nearestProjectFile(temp), "");
});

await t("the default marker place is machine-wide and outside any checkout", () => {
  assert.equal(defaultMarkerPath({ ProgramData: "D:\\ProgramData" }, "win32"), join("D:\\ProgramData", "coop", "test-approver.json"));
  assert.equal(defaultMarkerPath({}, "win32"), join("C:\\ProgramData", "coop", "test-approver.json"));
  assert.equal(defaultMarkerPath({}, "linux"), "/etc/coop/test-approver.json");
});

await t("a confirm is answered yes, a PRODUCTION confirm is declined, other dialogs are cancelled, the rest ignored", () => {
  const yes = answerFor({ type: "extension_ui_request", id: "q1", method: "confirm", title: "coop guardrails", message: "Run `rm -rf build`?" });
  assert.deepEqual(yes, { response: { type: "extension_ui_response", id: "q1", confirmed: true }, decision: "allowed", label: "approval" });
  const prod = answerFor({ type: "extension_ui_request", id: "q2", method: "confirm", title: "coop guardrails", message: "PRODUCTION write under unlock abc (10 min left):\n  UPDATE dbo.x\nIt changes production now. Run it once?" });
  assert.deepEqual(prod.response, { type: "extension_ui_response", id: "q2", cancelled: true });
  assert.equal(prod.decision, "declined");
  assert.equal(prod.label, "production");
  assert.ok(PRODUCTION.test("PRODUCTION write") && !PRODUCTION.test("the production write"), "the guardrails' own capitalised word, the way every prod message says it");
  const pick = answerFor({ type: "extension_ui_request", id: "q3", method: "select", title: "Welcome", options: ["a", "b"] });
  assert.deepEqual(pick.response, { type: "extension_ui_response", id: "q3", cancelled: true });
  assert.equal(answerFor({ type: "extension_ui_request", id: "n", method: "notify", message: "x" }), null);
  assert.equal(answerFor({ type: "response", id: "r" }), null);
});

// The write question since the statement moved into it: a select whose title
// carries the SQL, the target and the effect, with the guardrails' three options.
const WRITE_TITLE = "coop live-data guardrail\nWarehouse SQL write (one INSERT, UPDATE, CREATE or ALTER) about to run:\n  UPDATE sales.dim_kunde SET stadt = stadt WHERE 1 = 0\nTarget: dev Warehouse Coop Dev (the project file labels it dev)\nEffect: updates rows in sales.dim_kunde\nDeletes, drops, merges, EXEC, batches and production always ask. Run it?";
const SESSION_OPTION = "Allow fabric-sqlendpoint edits for this session (deletes still ask; production always asks)";
const WRITE_OPTIONS = [APPROVE_ONCE, SESSION_OPTION, APPROVE_DECLINE];

await t("the write question (a three-option select) is answered Allow once, never the session option; a PRODUCTION one is declined", () => {
  const once = answerFor({ type: "extension_ui_request", id: "w1", method: "select", title: WRITE_TITLE, options: WRITE_OPTIONS });
  assert.deepEqual(once, { response: { type: "extension_ui_response", id: "w1", value: "Allow once" }, decision: "allowed", label: "approval" });
  // The session option's own words ("production always asks") are not a PRODUCTION question.
  assert.ok(!PRODUCTION.test(WRITE_TITLE) && /production/.test(SESSION_OPTION));
  const prod = answerFor({ type: "extension_ui_request", id: "w2", method: "select", title: WRITE_TITLE.replace("Warehouse SQL write", "PRODUCTION Warehouse SQL write"), options: WRITE_OPTIONS });
  assert.deepEqual(prod, { response: { type: "extension_ui_response", id: "w2", cancelled: true }, decision: "declined", label: "production" });
  // Without both of the guardrails' own labels it is some other select: cancelled.
  for (const options of [[APPROVE_ONCE, "Something else"], [SESSION_OPTION, APPROVE_DECLINE], ["Yes", "No"], undefined]) {
    const other = answerFor({ type: "extension_ui_request", id: "w3", method: "select", title: WRITE_TITLE, options });
    assert.deepEqual(other.response, { type: "extension_ui_response", id: "w3", cancelled: true });
    assert.equal(other.decision, "declined");
  }
});

await t("the approver's option labels are the guardrails' own", () => {
  const guardrails = readFileSync(join(ROOT, "extensions", "coop-guardrails", "index.ts"), "utf8");
  assert.ok(guardrails.includes(`export const APPROVE_ONCE = ${JSON.stringify(APPROVE_ONCE)};`));
  assert.ok(guardrails.includes(`export const APPROVE_DECLINE = ${JSON.stringify(APPROVE_DECLINE)};`));
});

await t("an audit row names the dialog's kind and never its title, which carries the statement", () => {
  const rows = [];
  const env = { COOP_AGENT_DIR: join(temp, "agent") };
  auditAnswer({ cwd: "/work", decision: "allowed", label: "approval", dialog: "select" }, env, (path, line) => rows.push([path, line]));
  auditAnswer({ cwd: "/work", decision: "allowed", label: "approval", dialog: WRITE_TITLE }, env, (path, line) => rows.push([path, line]));
  auditAnswer({ cwd: "/work", decision: "allowed", label: "approval", tool: WRITE_TITLE }, env, (path, line) => rows.push([path, line]));
  assert.deepEqual(rows.map((r) => JSON.parse(r[1]).tool), ["select", "dialog", "dialog"]);
  assert.ok(rows.every((r) => !/UPDATE|dim_kunde|Warehouse|Target|Effect/.test(r[1])), "no statement, target or effect text");
});

await t("an audit row carries the fixed classification and never the question text", () => {
  const rows = [];
  auditAnswer({ cwd: "/work", decision: "allowed", label: "approval", dialog: "confirm" }, { COOP_AGENT_DIR: join(temp, "agent") }, (path, line) => rows.push([path, line]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], join(temp, "agent", "guardrails-audit.jsonl"));
  const row = JSON.parse(rows[0][1]);
  assert.equal(row.kind, "test-approver");
  assert.equal(row.detail, "test-approver");
  assert.equal(row.decision, "allowed");
  assert.equal(row.label, "approval");
  assert.equal(row.tool, "confirm");
  assert.ok(row.ts && row.pid, "timestamped, with the deciding process");
  assert.doesNotMatch(rows[0][1], /rm -rf|UPDATE/);
});

await t("the approver is development tooling: under tests/, excluded from the installer with the rest of tests/", () => {
  assert.equal(snapshotIncludes("tests/test-approver.mjs"), false, "the installer snapshot leaves it out with the rest of tests/");
  assert.equal(snapshotIncludes("tests/test-approver.test.mjs"), false);
  const source = readFileSync(join(ROOT, "tests", "test-approver.mjs"), "utf8");
  assert.doesNotMatch(source, /unlock-prod|prod-unlock\.json/, "it never touches the production unlock");
});

if (process.env.COOP_TEST_EXTENDED === "1") {
  await t("extended: a run waits for each agent run to end, answers the confirm and the write select, declines PRODUCTION, audits without text and ends Pi", async () => {
    // A stand-in that behaves as Pi's RPC mode does: a prompt is answered as soon
    // as its run starts (a second prompt during a run is refused), the question
    // comes later in the run, and agent_end closes it. A slash command is handled
    // without a run.
    const fake = join(temp, "fake-pi.mjs");
    writeFileSync(fake, `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const options = ${JSON.stringify(WRITE_OPTIONS)};
let buffer = "", busy = false;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    if (msg.type === "prompt") {
      if (busy) { send({ id: msg.id, type: "response", command: "prompt", success: false, error: "Agent is already processing." }); continue; }
      if (msg.message.startsWith("/")) { send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } }); continue; }
      busy = true;
      send({ id: msg.id, type: "response", command: "prompt", success: true });
      setTimeout(() => send({ type: "agent_start" }), 30);
      setTimeout(() => send(msg.message.startsWith("select:")
        ? { type: "extension_ui_request", id: "ask-" + msg.message, method: "select", title: msg.message, options }
        : { type: "extension_ui_request", id: "ask-" + msg.message, method: "confirm", title: "coop guardrails", message: msg.message }), 250);
    }
    if (msg.type === "extension_ui_response") {
      send({ type: "answered", id: msg.id, confirmed: msg.confirmed === true, cancelled: msg.cancelled === true, value: msg.value || "" });
      setTimeout(() => { busy = false; send({ type: "agent_end" }); }, 250);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`);
    const agent = join(temp, "agent");
    const spec = join(temp, "spec.json");
    writeFileSync(spec, JSON.stringify({ schema: 1, node: process.execPath, entry: fake, cwd: join(client, "work"), args: [], env: { COOP_AGENT_DIR: agent } }));
    const lines = [];
    const out = { write: (s) => lines.push(...s.split("\n").filter(Boolean)) };
    const errs = [];
    const err = { write: (s) => errs.push(s) };
    const env = { ...process.env, COOP_TEST_APPROVER: "1", COOP_AGENT_DIR: agent };
    const prompts = ["Run the dev write?", `select: ${WRITE_TITLE}`, "/a-command", "PRODUCTION write under unlock x: run it once?"];
    const code = await run({ spec, prompts, marker, timeout: 20000 }, { env, machine: "dev-vm", out, err });
    assert.equal(code, 0, errs.join(""));
    const events = lines.map((l) => JSON.parse(l));
    const answered = events.filter((m) => m.type === "answered");
    assert.deepEqual(answered.map((m) => [m.confirmed, m.cancelled, m.value]), [[true, false, ""], [false, false, "Allow once"], [false, true, ""]]);
    assert.equal(events.filter((m) => m.type === "agent_end").length, 3, "every run was let finish before the next prompt and before Pi was stopped");
    const audit = readFileSync(join(agent, "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((r) => [r.kind, r.tool, r.decision, r.label, r.detail]), [["test-approver", "confirm", "allowed", "approval", "test-approver"], ["test-approver", "select", "allowed", "approval", "test-approver"], ["test-approver", "confirm", "declined", "production", "test-approver"]]);
    assert.ok(audit.every((r) => !/unlock|dev write|UPDATE|dim_kunde|Target|Effect/.test(JSON.stringify(r))), "no question or statement text in the audit");
    // A run that outlasts --timeout is a failure, not a silent early stop.
    const slow = join(temp, "slow-pi.mjs");
    writeFileSync(slow, `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    if (msg.type === "prompt") { send({ id: msg.id, type: "response", command: "prompt", success: true }); send({ type: "agent_start" }); }
  }
});
process.stdin.on("end", () => process.exit(0));
`);
    const slowSpec = join(temp, "slow-spec.json");
    writeFileSync(slowSpec, JSON.stringify({ schema: 1, node: process.execPath, entry: slow, cwd: join(client, "work"), args: [], env: { COOP_AGENT_DIR: agent } }));
    assert.equal(await run({ spec: slowSpec, prompts: ["never ends"], marker, timeout: 800 }, { env, machine: "dev-vm", out, err }), 1);
    assert.match(errs.at(-1), /did not finish within 800 ms/);
    // With the gate off, nothing starts: no Pi, no answer, exit 2.
    assert.equal(await run({ spec, prompts: ["x"], marker, timeout: 1000 }, { env: { ...env, COOP_TEST_APPROVER: "" }, machine: "dev-vm", out, err }), 2);
    assert.match(errs.at(-1), /refused: COOP_TEST_APPROVER/);
  });
}

console.log(`${passed} test-approver tests passed${process.env.COOP_TEST_EXTENDED === "1" ? " (with the extended run)" : ""}`);
