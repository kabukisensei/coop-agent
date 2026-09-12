// Tests for the installed Support Center workflow (lib/support-center-cli.mjs
// via scripts/support-center.sh). Uses a disposable COOP_DIR profile with
// synthetic events incl. planted credentials — they must never reach the
// exported bundle unredacted.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SH = join(ROOT, "scripts", "support-center.sh");
const profile = mkdtempSync(join(tmpdir(), "support-test-"));
const coopDir = join(profile, "coop");
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

console.log(`  ${n} support-command tests passed`);
