// Tests for the installed Support Center workflow (lib/support-center-cli.mjs
// via scripts/support-center.sh). Uses a disposable COOP_DIR profile with
// synthetic events incl. planted credentials — they must never reach the
// exported bundle unredacted.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Windows: import.meta.url.pathname yields "/D:/a/..." (leading slash keeps
// the drive), and resolve() then produces "D:\D:\a\..." — fileURLToPath is
// the correct URL→path conversion on every platform.
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SH = join(ROOT, "scripts", "support-center.sh");
const profile = mkdtempSync(join(tmpdir(), "support-test-"));
const coopDir = join(profile, "coop");

// Environment probe (r8 precedent): constrained sandboxes may deny spawning
// bash from node — possibly with status 0 AND an error set. Skip explicitly
// instead of failing the suite — native runs execute the full journey.
const bashProbe = spawnSync("bash", ["-c", "true"], { encoding: "utf8" });
if (bashProbe.status !== 0 || bashProbe.error) {
  console.log(`  (8 skipped: bash spawn unavailable in this environment (${bashProbe.error?.code ?? `status ${bashProbe.status}`}) —`);
  console.log("   run natively for the full support-command journey; no product defect)");
  console.log("  0 support-command tests passed (8 environment skips)");
  process.exit(0);
}
mkdirSync(join(coopDir, "support"), { recursive: true });
// synthetic host events: one benign, one with planted credentials
writeFileSync(join(coopDir, "support", "events.jsonl"), [
  JSON.stringify({ event: "sync", detail: "knowledge repos synced" }),
  JSON.stringify({ event: "api-call", config: { endpoint: "https://example.invalid", api_key: "PLANTED-SECRET-123", note: "fine" } }),
].join("\n") + "\n");

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

await t("coop support preview runs against a disposable profile and reports health", async () => {
  const out = execFileSync("bash", [SH], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  assert.match(out, /COOP SUPPORT — run /);
  assert.match(out, /✓ node: ok/);
  assert.match(out, /redact: token, password, authorization/);
});

await t("export writes a sanitized bundle; planted credential redacted", async () => {
  const exp = join(profile, "out", "bundle.json");
  execFileSync("bash", [SH, "--export", exp], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  const bundle = JSON.parse(readFileSync(exp, "utf8"));
  const raw = readFileSync(exp, "utf8");
  assert.equal(raw.includes("PLANTED-SECRET-123"), false, "planted credential must not persist");
  assert.match(bundle.run, /^(run|incident)-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  const ev = bundle.events.find((e) => e.event === "api-call");
  assert.equal(ev.config.api_key, "[REDACTED]");
  assert.equal(ev.config.note, "fine");
  assert.ok(Array.isArray(bundle.manifest.redact));
  assert.ok(bundle.manifest.components.length >= 3);
});

await t("incident mode issues an incident ID and flags the operator report", async () => {
  const exp = join(profile, "out", "incident.json");
  const out = execFileSync("bash", [SH, "--incident", "--export", exp], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  assert.match(out, /! operator-report: degraded/);
  const bundle = JSON.parse(readFileSync(exp, "utf8"));
  assert.match(bundle.run, /^incident-/);
});

await t("default export under the profile prunes to bounded retention", async () => {
  for (let i = 0; i < 12; i++) {
    spawnSync("bash", [SH], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  }
  const bundles = readdirSync(join(coopDir, "support", "bundles"));
  assert.ok(bundles.length <= 10, `retention bound (got ${bundles.length})`);
  assert.ok(bundles.length >= 5, "recent bundles retained");
});

await t("event log is trimmed to the bounded length including the new run record", async () => {
  // seed the log AT the bound so one more run must enforce 200 exactly (F2)
  const seed = Array.from({ length: 200 }, (_, i) => JSON.stringify({ event: `seed-${i}`, detail: "x" }));
  writeFileSync(join(coopDir, "support", "events.jsonl"), seed.join("\n") + "\n");
  spawnSync("bash", [SH], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  const lines = readFileSync(join(coopDir, "support", "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(lines.length <= 200, `event log bounded (got ${lines.length})`);
  assert.ok(lines.some((l) => l.includes("support-run")), "new run record retained within the bound");
});

await t("malformed event lines persist no raw content (F1 round 2)", async () => {
  writeFileSync(join(coopDir, "support", "events.jsonl"), 'not json at all token=hunter2-secret\n' + JSON.stringify({ event: "ok", note: "fine" }) + "\n");
  spawnSync("bash", [SH], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  const log = readFileSync(join(coopDir, "support", "events.jsonl"), "utf8");
  assert.equal(log.includes("hunter2-secret"), false, "malformed line content must not persist");
  assert.ok(log.includes("unparseable_event"));
});

await t("host event log is rewritten sanitized — planted credential never persists (F1)", async () => {
  // self-seeding: earlier tests overwrite the shared log
  writeFileSync(join(coopDir, "support", "events.jsonl"), [
    JSON.stringify({ event: "sync", detail: "knowledge repos synced" }),
    JSON.stringify({ event: "api-call", config: { endpoint: "https://example.invalid", api_key: "PLANTED-SECRET-123", note: "fine" } }),
  ].join("\n") + "\n");
  spawnSync("bash", [SH], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  const log = readFileSync(join(coopDir, "support", "events.jsonl"), "utf8");
  assert.equal(log.includes("PLANTED-SECRET-123"), false, "raw log must be redacted too");
  const api = log.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.event === "api-call");
  assert.equal(api.config.api_key, "[REDACTED]");
});

await t("runs without HOME (COOP_DIR set) stay in-profile (F3)", async () => {
  const r = spawnSync("bash", ["-c", `env -u HOME node "${join(ROOT, "lib", "support-center-cli.mjs")}" --json`],
    { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

// --- build identity (support build fingerprint) -----------------------------
const { resolveCoopBuildIdentity } = await import("../lib/coop-build-identity.mjs");
const { fingerprintBuild } = await import("../lib/support-center.mjs");

await t("build identity resolves the checkout VERSION and a 40-hex revision", () => {
  const r = resolveCoopBuildIdentity(ROOT, {
    execFileImpl: () => "356998f3e8415698cd7651ba1a3fafa25a725506",
    readVersionImpl: () => "0.23.1",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.version, "0.23.1");
  assert.equal(r.value.commit, "356998f3e8415698cd7651ba1a3fafa25a725506");
});

await t("build identity refuses a missing or malformed revision", () => {
  const noGit = resolveCoopBuildIdentity(ROOT, { execFileImpl: () => { throw new Error("no git"); }, readVersionImpl: () => "0.23.1" });
  assert.equal(noGit.ok, false);
  const badCommit = resolveCoopBuildIdentity(ROOT, { execFileImpl: () => "not-a-commit", readVersionImpl: () => "0.23.1" });
  assert.equal(badCommit.ok, false);
});

await t("build identity refuses a missing VERSION", () => {
  const r = resolveCoopBuildIdentity(ROOT, { execFileImpl: () => "356998f3e8415698cd7651ba1a3fafa25a725506", readVersionImpl: () => { throw new Error("ENOENT"); } });
  assert.equal(r.ok, false);
});

await t("support CLI fingerprints this checkout, not a hard-coded build", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "lib", "support-center-cli.mjs"), "--json"], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const bundle = JSON.parse(r.stdout);
  assert.match(bundle.versions.coopBuild, /^build-[0-9a-f]{8}$/);
  const stale = fingerprintBuild({ version: "integration-2026-09-20", commit: "8a57991", channel: "candidate" });
  assert.notEqual(bundle.versions.coopBuild, stale.value, "must not pin the old hard-coded build identity");
});

await t("support identity equals the expected COOP source/build identity", () => {
  const expectedVersion = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  const expectedCommit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const expected = fingerprintBuild({ version: expectedVersion, commit: expectedCommit });
  assert.equal(expected.ok, true);
  const r = spawnSync(process.execPath, [join(ROOT, "lib", "support-center-cli.mjs"), "--json"], { env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const bundle = JSON.parse(r.stdout);
  assert.equal(bundle.versions.coopBuild, expected.value, "identity must equal the checkout VERSION+HEAD fingerprint");
});

await t("invocation from an unrelated git project still identifies COOP, never the project HEAD", () => {
  const foreign = mkdtempSync(join(tmpdir(), "foreign-project-"));
  execFileSync("git", ["-C", foreign, "init", "-q"], { encoding: "utf8" });
  execFileSync("git", ["-C", foreign, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { encoding: "utf8" });
  const foreignHead = execFileSync("git", ["-C", foreign, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const r = spawnSync(process.execPath, [join(ROOT, "lib", "support-center-cli.mjs"), "--json"], { cwd: foreign, env: { ...process.env, COOP_DIR: coopDir }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const bundle = JSON.parse(r.stdout);
  assert.match(bundle.versions.coopBuild, /^build-[0-9a-f]{8}$/);
  assert.notEqual(bundle.versions.coopBuild, fingerprintBuild({ version: "0.0.0", commit: foreignHead }).value, "must never use the invoking project's HEAD");
});

console.log(`  ${n} support-command tests passed`);
