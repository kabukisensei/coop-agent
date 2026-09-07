import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyProjectConfig, getProjectConfig, proposeProjectConfig } from "../web/project-config-service.mjs";

let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`  ✓ ${name}`); }
const valid = async () => ({ valid: true, diagnostics: [] });

await test("current config inspection is fixed to the workspace contract path", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-current-"));
  const state = getProjectConfig({ workspace: root });
  assert.equal(state.targetPath, join(root, ".coop", "project.yml"));
  assert.equal(state.state, "not-configured");
  assert.equal(state.content, null);
});

await test("proposal previews exact old and new content without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-proposal-"));
  mkdirSync(join(root, ".coop"));
  writeFileSync(join(root, ".coop", "project.yml"), "profile:\n  client: Old\n");
  const proposal = await proposeProjectConfig({ workspace: root, candidate: "profile:\n  client: New", validate: valid, proposalId: "p1" });
  assert.equal(proposal.state, "proposed");
  assert.equal(proposal.preview.before, "profile:\n  client: Old\n");
  assert.equal(proposal.preview.after, "profile:\n  client: New\n");
  assert.equal(readFileSync(proposal.targetPath, "utf8"), proposal.preview.before);
});

await test("approved apply writes atomically and preserves a timestamped backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-apply-"));
  mkdirSync(join(root, ".coop"));
  const target = join(root, ".coop", "project.yml");
  writeFileSync(target, "profile:\n  client: Old\n");
  const proposal = await proposeProjectConfig({ workspace: root, candidate: "profile:\n  client: New\n", validate: valid, proposalId: "p2" });
  const applied = applyProjectConfig(proposal, { now: new Date("2026-09-04T19:00:00Z") });
  assert.equal(applied.state, "applied");
  assert.ok(applied.backupPath.endsWith("project.yml.20260904_190000.bak"));
  assert.equal(readFileSync(target, "utf8"), "profile:\n  client: New\n");
  assert.equal(readFileSync(applied.backupPath, "utf8"), "profile:\n  client: Old\n");
});

await test("concurrent changes make a proposal stale instead of overwriting", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-stale-"));
  mkdirSync(join(root, ".coop"));
  const target = join(root, ".coop", "project.yml");
  writeFileSync(target, "profile: {}\n");
  const proposal = await proposeProjectConfig({ workspace: root, candidate: "profile:\n  client: New\n", validate: valid });
  writeFileSync(target, "profile:\n  client: SomeoneElse\n");
  const result = applyProjectConfig(proposal);
  assert.equal(result.state, "stale");
  assert.equal(readFileSync(target, "utf8"), "profile:\n  client: SomeoneElse\n");
});

await test("rename failure preserves original bytes and recoverable backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-fail-"));
  mkdirSync(join(root, ".coop"));
  const target = join(root, ".coop", "project.yml");
  writeFileSync(target, "profile: {}\n");
  const proposal = await proposeProjectConfig({ workspace: root, candidate: "profile:\n  client: New\n", validate: valid });
  assert.throws(() => applyProjectConfig(proposal, { rename: () => { throw new Error("injected"); } }), /injected/);
  assert.equal(readFileSync(target, "utf8"), "profile: {}\n");
  assert.ok(existsSync(join(root, ".backups")));
});

await test("invalid proposals cannot be applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-invalid-"));
  const proposal = await proposeProjectConfig({ workspace: root, candidate: "- not-a-map\n", validate: async () => ({ valid: false, diagnostics: [{ code: "bad" }] }) });
  assert.equal(proposal.state, "invalid");
  assert.throws(() => applyProjectConfig(proposal), /valid proposed/);
});

console.log(`project config service: ${count} tests passed`);
