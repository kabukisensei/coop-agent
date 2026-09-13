import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

await test("creating a new project configuration when none exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-new-"));
  const target = join(root, ".coop", "project.yml");
  const initialState = getProjectConfig({ workspace: root });
  assert.equal(initialState.state, "not-configured");
  assert.equal(initialState.content, null);

  const proposal = await proposeProjectConfig({
    workspace: root,
    candidate: "profile:\n  client: New Project\n  language: 日本語\n",
    validate: valid,
    proposalId: "p-new",
  });
  assert.equal(proposal.state, "proposed");
  assert.equal(proposal.baseDigest, null);
  assert.equal(proposal.preview.before, null);
  assert.equal(proposal.preview.after, "profile:\n  client: New Project\n  language: 日本語\n");

  const applied = applyProjectConfig(proposal, { now: new Date("2026-09-04T19:30:00Z") });
  assert.equal(applied.state, "applied");
  assert.equal(applied.backupPath, null);
  assert.ok(existsSync(target));
  assert.equal(readFileSync(target, "utf8"), "profile:\n  client: New Project\n  language: 日本語\n");
  assert.ok(!existsSync(join(root, ".backups")) || readdirSync(join(root, ".backups")).length === 0);

  const coopFiles = readdirSync(join(root, ".coop"));
  const tempFiles = coopFiles.filter((f) => f.startsWith(".project.yml.") && f.endsWith(".tmp"));
  assert.equal(tempFiles.length, 0);

  const finalState = getProjectConfig({ workspace: root });
  assert.equal(finalState.state, "configured");
  assert.equal(finalState.content, "profile:\n  client: New Project\n  language: 日本語\n");
});

await test("updating an existing configuration with an intact backup in .backups/", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-update-"));
  mkdirSync(join(root, ".coop"));
  const target = join(root, ".coop", "project.yml");
  const originalContent = "profile:\n  client: Initial Client\n  notes: 初期設定 ⚡\n";
  const updatedContent = "profile:\n  client: Updated Client\n  notes: 更新設定 🚀\n";
  writeFileSync(target, originalContent);

  const proposal = await proposeProjectConfig({
    workspace: root,
    candidate: updatedContent,
    validate: valid,
    proposalId: "p-update",
  });
  assert.equal(proposal.state, "proposed");
  assert.equal(proposal.preview.before, originalContent);
  assert.equal(proposal.preview.after, updatedContent);

  const applied = applyProjectConfig(proposal, { now: new Date("2026-09-04T20:15:30Z") });
  assert.equal(applied.state, "applied");
  assert.ok(applied.backupPath);
  assert.ok(applied.backupPath.endsWith("project.yml.20260904_201530.bak"));
  assert.ok(existsSync(applied.backupPath));
  assert.equal(readFileSync(applied.backupPath, "utf8"), originalContent);
  assert.equal(readFileSync(target, "utf8"), updatedContent);

  const coopFiles = readdirSync(join(root, ".coop"));
  const tempFiles = coopFiles.filter((f) => f.startsWith(".project.yml.") && f.endsWith(".tmp"));
  assert.equal(tempFiles.length, 0);
});

await test("write or replacement failure leaves original configuration intact and cleans up temporary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-fail-cleanup-"));
  mkdirSync(join(root, ".coop"));
  const target = join(root, ".coop", "project.yml");
  const originalContent = "profile:\n  client: Untouched\n";
  writeFileSync(target, originalContent);

  const proposal = await proposeProjectConfig({
    workspace: root,
    candidate: "profile:\n  client: NeverWritten\n",
    validate: valid,
  });

  assert.throws(
    () => applyProjectConfig(proposal, { rename: () => { throw new Error("simulated rename failure"); } }),
    /simulated rename failure/
  );

  assert.equal(readFileSync(target, "utf8"), originalContent);

  const coopFiles = readdirSync(join(root, ".coop"));
  const tempFiles = coopFiles.filter((f) => f.startsWith(".project.yml.") && f.endsWith(".tmp"));
  assert.equal(tempFiles.length, 0);

  const backupFiles = readdirSync(join(root, ".backups"));
  assert.ok(backupFiles.length > 0);
  assert.equal(readFileSync(join(root, ".backups", backupFiles[0]), "utf8"), originalContent);
});

await test("replacement failure when creating new configuration leaves target absent and cleans up temporary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-config-new-fail-"));
  const target = join(root, ".coop", "project.yml");

  const proposal = await proposeProjectConfig({
    workspace: root,
    candidate: "profile:\n  client: FailNew\n",
    validate: valid,
  });

  assert.throws(
    () => applyProjectConfig(proposal, { rename: () => { throw new Error("simulated new rename failure"); } }),
    /simulated new rename failure/
  );

  assert.ok(!existsSync(target));
  const coopFiles = readdirSync(join(root, ".coop"));
  const tempFiles = coopFiles.filter((f) => f.startsWith(".project.yml.") && f.endsWith(".tmp"));
  assert.equal(tempFiles.length, 0);
});

if (process.platform !== "win32") {
  await test("POSIX: replacing a read-only (0444) configuration succeeds and preserves intact backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "coop-config-ro-"));
    mkdirSync(join(root, ".coop"));
    const target = join(root, ".coop", "project.yml");
    const originalContent = "profile:\n  client: ReadOnly Baseline Client\n  version: 1\n";
    const updatedContent = "profile:\n  client: ReadOnly Replaced Client\n  version: 2\n";
    writeFileSync(target, originalContent);
    chmodSync(target, 0o444);

    const proposal = await proposeProjectConfig({
      workspace: root,
      candidate: updatedContent,
      validate: valid,
      proposalId: "p-ro",
    });
    assert.equal(proposal.state, "proposed");
    assert.equal(proposal.preview.before, originalContent);
    assert.equal(proposal.preview.after, updatedContent);

    const applied = applyProjectConfig(proposal, { now: new Date("2026-09-04T21:00:00Z") });
    assert.equal(applied.state, "applied");
    assert.ok(applied.backupPath);
    assert.ok(existsSync(applied.backupPath));
    assert.equal(readFileSync(applied.backupPath, "utf8"), originalContent);
    assert.equal(readFileSync(target, "utf8"), updatedContent);

    const coopFiles = readdirSync(join(root, ".coop"));
    const tempFiles = coopFiles.filter((f) => f.startsWith(".project.yml.") && f.endsWith(".tmp"));
    assert.equal(tempFiles.length, 0);
  });
}

console.log(`project config service: ${count} tests passed`);
