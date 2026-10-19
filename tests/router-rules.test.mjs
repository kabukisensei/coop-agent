// The coop/auto routing rule (lib/router-rules.mjs, master plan R1) against the
// two synthetic prompt sets that the J0 classifier trial left behind
// (tests/fixtures/router-trial/*.jsonl, no client data): the rule alone routes
// them, and the sets hold the shapes it must get right. The trial itself and
// its classifiers were removed on 2026-10-19 (CHANGELOG, Unreleased).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRequest, LONG_PROMPT_CHARS, SHORT_PROMPT_CHARS, TIERS } from "../lib/router-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const readSet = (name) => readFileSync(join(HERE, "fixtures", "router-trial", name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --- the rule ---------------------------------------------------------------
assert.equal(classifyRequest("What is DAX?", "low"), "build");
// A short prompt at medium thinking is a build-model task, question or edit alike (blind quality test, 2026-10-19).
assert.equal(classifyRequest("What is DAX?", "medium"), "build", "a short question at medium thinking is a lookup");
assert.equal(classifyRequest("Explain CALCULATE in one sentence.", "medium"), "build");
assert.equal(classifyRequest("Fix the DAX measure that divides by zero.", "medium"), "build", "a short edit is build work");
assert.equal(classifyRequest("x".repeat(SHORT_PROMPT_CHARS), "medium"), "build");
assert.equal(classifyRequest("x".repeat(SHORT_PROMPT_CHARS + 1), "medium"), "standard", "a longer medium prompt plans on the standard model");
assert.equal(classifyRequest("x".repeat(SHORT_PROMPT_CHARS + 1), "low"), "standard");
assert.equal(classifyRequest("Design the migration", "high"), "plan");
assert.equal(classifyRequest("x".repeat(LONG_PROMPT_CHARS), "low"), "plan");
assert.equal(classifyRequest(undefined, "medium"), "build");

// --- the shipped 50-row set: every row routes ----------------------------------
const rows = readSet("prompts.jsonl");
assert.equal(rows.length, 50, "the shipped set holds 50 rows");
assert.equal(new Set(rows.map((r) => r.id)).size, 50, "ids are unique");
for (const r of rows) assert.ok(TIERS.includes(r.label) && r.prompt.trim().length > 0);
for (const t of TIERS) assert.ok(rows.filter((r) => r.label === t).length >= 2, `at least 2 rows labelled ${t}`);
const misses = rows.filter((r) => classifyRequest(r.prompt, r.thinkingLevel) !== r.label);
assert.equal(misses.length, 0, `the rule routes the whole shipped set: ${misses.map((r) => r.id).join(", ")}`);
const shortMedium = rows.filter((r) => r.thinkingLevel === "medium" && r.label === "build");
assert.ok(shortMedium.length >= 7 && shortMedium.every((r) => r.prompt.length <= SHORT_PROMPT_CHARS), "the short medium-thinking prompts (lookups and edits) are build work");
assert.ok(rows.some((r) => r.prompt.length >= LONG_PROMPT_CHARS && r.label === "plan"), "one long brief plans by length");

// --- the 200-row set: 98%, the four long medium briefs under the length threshold --
const big = readSet("prompts-200.jsonl");
assert.equal(big.length, 200);
const bigMisses = big.filter((r) => classifyRequest(r.prompt, r.thinkingLevel) !== r.label);
assert.ok(bigMisses.length <= 4 && bigMisses.every((r) => r.label === "plan" && r.thinkingLevel === "medium" && r.prompt.length < LONG_PROMPT_CHARS), `the 200-row misses are only medium briefs shorter than ${LONG_PROMPT_CHARS}: ${bigMisses.map((r) => r.id).join(", ")}`);

// --- no client data in either set ----------------------------------------------
for (const name of ["prompts.jsonl", "prompts-200.jsonl"]) {
  const raw = readFileSync(join(HERE, "fixtures", "router-trial", name), "utf8");
  assert.ok(!/contoso\.com|@cooptimize|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(raw), `${name} carries no tenant, workspace or item ids`);
}

console.log("  ✓ router-rules tests passed");
