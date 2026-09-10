import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeDoctorReport, runDoctor } from "../web/doctor-service.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let count = 0;
async function test(name, fn) {
  await fn();
  count++;
  console.log(`  ✓ ${name}`);
}

const legacy = {
  checks: [
    { name: "pi  (0.84.3)", section: "Core", status: "ok", hint: "" },
    { name: "no Pi login found yet", section: "Core", status: "warn", hint: "sign in to Coop" },
    { name: "fab missing", section: "Microsoft Fabric CLI", status: "fail", hint: "pipx install ms-fabric-cli" },
  ],
  fail: 1,
  warn: 1,
};

await test("normalizes legacy checks into stable shared health states", async () => {
  const report = normalizeDoctorReport(legacy, { now: new Date("2026-09-04T12:00:00Z"), runId: "run-1" });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "error");
  assert.deepEqual(report.counts, { healthy: 1, warning: 0, error: 1, unavailable: 1, skipped: 0 });
  assert.equal(new Set(report.checks.map((check) => check.id)).size, 3);
  assert.equal(report.checks[1].repair.operationId, "doctor.repair.authenticate");
  assert.equal(report.checks[2].repair.operationId, "doctor.repair.install");
  assert.ok(report.checks.every((check) => check.repair === null || check.repair.approvalRequired));
});

await test("distinguishes unavailable and skipped checks from degraded health", async () => {
  const report = normalizeDoctorReport({ checks: [
    { name: "Power BI Desktop — Windows only, not applicable here", section: "Tools", status: "ok", hint: "" },
    { name: "optional helper missing", section: "Tools", status: "warn", hint: "install it" },
    { name: "installed version is older than expected", section: "Tools", status: "warn", hint: "update it" },
  ] });
  assert.deepEqual(report.checks.map((check) => check.state), ["skipped", "unavailable", "warning"]);
});

await test("stable IDs ignore volatile versions", async () => {
  const first = normalizeDoctorReport(legacy, { runId: "a" });
  const changed = structuredClone(legacy);
  changed.checks[0].name = "pi  (0.85.1)";
  const second = normalizeDoctorReport(changed, { runId: "b" });
  assert.equal(first.checks[0].id, second.checks[0].id);
});

await test("runner consumes one platform Doctor JSON source", async () => {
  let invocation;
  const report = await runDoctor({
    platform: "win32",
    execute: async (spec) => {
      invocation = spec;
      return { code: 1, stdout: JSON.stringify(legacy), stderr: "" };
    },
  });
  assert.equal(invocation.bin, "powershell.exe");
  assert.ok(invocation.args.some((arg) => arg.endsWith("doctor.ps1")));
  assert.equal(report.status, "error");
});

await test("checked-in schema pins states and repair metadata", async () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "config", "doctor-report.schema.json"), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.status.enum, ["healthy", "warning", "error"]);
  const check = schema.properties.checks.items;
  assert.ok(check.required.includes("repair"));
});

await test("runner surfaces helpful error when doctor stdout is polluted with non-JSON text", async () => {
  await assert.rejects(
    () => runDoctor({
      platform: "win32",
      execute: async () => ({ code: 1, stdout: "reinstall so the pinned coop-data-doc is first on PATH\n" + JSON.stringify(legacy), stderr: "" }),
    }),
    /Doctor did not return valid JSON \(exit 1\)\./
  );
});

console.log(`doctor service: ${count} tests passed`);
