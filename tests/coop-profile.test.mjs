// Behavioral tests for extensions/coop-profile.
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = mkdtempSync(path.join(tmpdir(), "coop-profile-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const userFile = path.join(home, ".coop", "user.json");
mkdirSync(path.dirname(userFile), { recursive: true });
const dist = process.env.COOP_TEST_DIST || "/tmp/coop-test-dist";
const modPath = path.join(dist, "coop-profile.mjs");
assert.ok(existsSync(modPath));
const mod = await import(pathToFileURL(modPath).href);

writeFileSync(userFile, JSON.stringify({ schema_version: 2, name: "Ignored", communication: { preset: "balanced" } }));
assert.equal(mod.loadProfile(), null, "unknown schema is ignored");
writeFileSync(userFile, "not-json");
assert.equal(mod.loadProfile(), null, "malformed JSON is ignored");
writeFileSync(userFile, JSON.stringify({ schema_version: 1, name: "Aaron\nInjected", communication: { preset: "custom", custom_instructions: "Be brief\u0000\nplease" } }));
const profile = mod.loadProfile();
assert.equal(profile.name, "Aaron Injected");
assert.match(mod.buildInstruction(profile), /Be brief please/);

let handler;
mod.default({ pi: { on: (_event, h) => { handler = h; } } });
const first = await handler({ systemPrompt: "base" }, {});
const second = await handler({ systemPrompt: "base" }, {});
assert.equal(first.systemPrompt, second.systemPrompt, "contribution remains constant across turns");
assert.ok(!("message" in first), "does not append a persistent session message");
assert.equal((first.systemPrompt.match(/COOP user profile/g) || []).length, 1);
console.log("  ✓ profile schema, sanitization, and constant system-prompt contribution");
