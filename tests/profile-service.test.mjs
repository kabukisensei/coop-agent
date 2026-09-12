import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUserProfile, getUserProfile } from "../web/profile-service.mjs";

const dir = mkdtempSync(join(tmpdir(), "coop-profile-service-"));
const env = { ...process.env, COOP_DIR: dir };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

await test("missing profile is not-configured rather than an execution failure", async () => {
  const result = await getUserProfile({ env });
  assert.equal(result.state, "not-configured");
  assert.equal(result.profile, null);
  assert.deepEqual(result.questionnaire.fields.communication.preset.options.map((item) => item.id), ["concise", "balanced", "teaching", "custom"]);
  assert.equal(result.questionnaire.fields.name.max_length, 100);
  assert.equal(result.questionnaire.fields.communication.custom_instructions.max_length, 1000);
});

await test("profile writes require explicit approval and use the authoritative owner", async () => {
  const candidate = { name: "Aaron", communication: { preset: "balanced", custom_instructions: "ignored" } };
  await assert.rejects(() => applyUserProfile(candidate, { env }), /Explicit approval/);
  const result = await applyUserProfile(candidate, { approved: true, env });
  assert.equal(result.profile.name, "Aaron");
  assert.equal(result.profile.communication.custom_instructions, "");
  assert.equal(result.questionnaire.schema_version, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".coop", "user.json"), "utf8")), result.profile);
});

await test("invalid names and presets fail without replacing the current profile", async () => {
  const before = readFileSync(join(dir, ".coop", "user.json"), "utf8");
  await assert.rejects(() => applyUserProfile({ name: "bad/name", communication: { preset: "balanced" } }, { approved: true, env }), /invalid characters/i);
  await assert.rejects(() => applyUserProfile({ name: "Valid", communication: { preset: "invented" } }, { approved: true, env }), /preset is invalid/i);
  assert.equal(readFileSync(join(dir, ".coop", "user.json"), "utf8"), before);
});

await test("custom instructions are bounded and normalized by the same owner", async () => {
  const result = await applyUserProfile({ name: "Aaron", communication: { preset: "custom", custom_instructions: "Be brief\nplease\0" } }, { approved: true, env });
  assert.equal(result.profile.communication.custom_instructions, "Be brief please");
  await assert.rejects(() => applyUserProfile({ name: "Aaron", communication: { preset: "custom", custom_instructions: "x".repeat(1001) } }, { approved: true, env }), /too long/i);
});

console.log(`profile service: ${passed} tests passed`);
