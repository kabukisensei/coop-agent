import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectSetupState } from "../web/project-setup-service.mjs";

let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`  ✓ ${name}`); }

await test("a missing contract requests only the exact project setup step", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-setup-missing-"));
  const report = await getProjectSetupState({ workspace: root, capabilityId: "coop.lineage.explorer" });
  assert.equal(report.state, "progressive");
  assert.equal(report.capability.available, false);
  assert.deepEqual(report.capability.missingSections, ["project-contract", "data-doc"]);
  assert.equal(report.capability.nextAction.operationId, "project.configure");
});

await test("skipped optional integrations are not-configured rather than broken", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-setup-skip-"));
  mkdirSync(join(root, ".coop"));
  writeFileSync(join(root, ".coop", "project.yml"), "profile:\n  organization: Cooptimize\nrepositories: {}\ntools:\n  fabric_cli:\n    enabled: false\n  tabular_editor_cli:\n    enabled: false\n");
  const report = await getProjectSetupState({ workspace: root });
  assert.equal(report.state, "ready");
  assert.equal(report.sections.find((section) => section.id === "microsoft").state, "not-configured");
  assert.equal(report.sections.find((section) => section.id === "microsoft").selected, false);
  assert.equal(report.sections.some((section) => section.state === "broken"), false);
});

await test("selected but incomplete Fabric setup is progressive and names the next step", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-setup-progressive-"));
  mkdirSync(join(root, ".coop"));
  writeFileSync(join(root, ".coop", "project.yml"), "profile: {}\ntools:\n  fabric_cli:\n    enabled: true\nfabric:\n  tenant_id: ''\n");
  const report = await getProjectSetupState({ workspace: root, capabilityId: "coop.impact.guided" });
  assert.equal(report.state, "progressive");
  assert.ok(report.capability.missingSections.includes("microsoft"));
  assert.equal(report.capability.nextAction.operationId, "data-doc.configure");
});

await test("capability readiness is evaluated from the same section state", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-setup-ready-"));
  mkdirSync(join(root, ".coop"));
  writeFileSync(join(root, ".coop", "project.yml"), "profile: {}\ntools:\n  fabric_cli:\n    enabled: true\n  tabular_editor_cli:\n    enabled: false\nfabric:\n  tenant_id: tenant-1\npower_bi:\n  default_workspace_name: QE Dev\n  default_workspace_id: 11111111-1111-4111-8111-111111111111\n");
  writeFileSync(join(root, "coop-data-doc.yml"), "project_name: QE\n");
  const report = await getProjectSetupState({ workspace: root, capabilityId: "coop.impact.guided" });
  assert.equal(report.capability.available, true);
  assert.deepEqual(report.capability.missingSections, []);
});

await test("malformed project YAML is broken and never exposes raw content", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-setup-broken-"));
  mkdirSync(join(root, ".coop"));
  writeFileSync(join(root, ".coop", "project.yml"), "profile: [unterminated\nsecret: do-not-return\n");
  const report = await getProjectSetupState({ workspace: root });
  assert.equal(report.state, "broken");
  assert.equal(JSON.stringify(report).includes("do-not-return"), false);
});

await test("checked-in schema pins progressive and not-configured states", async () => {
  const schema = JSON.parse(readFileSync(new URL("../config/project-setup-state.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.ok(schema.properties.state.enum.includes("progressive"));
  assert.ok(schema.properties.sections.items.properties.state.enum.includes("not-configured"));
});

console.log(`project setup service: ${count} tests passed`);
