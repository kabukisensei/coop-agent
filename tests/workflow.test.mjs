// Tests that the vertical-slice workflow and live-data test hook are wired into
// the skill, prompt, and project contract templates.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const skill = readFileSync(join(ROOT, "skills/coop-workflow/SKILL.md"), "utf8");
assert.ok(skill.includes("## Slice by default"), "skill has 'Slice by default' section");
assert.ok(skill.includes("Failing check before"), "skill requires a failing check before the slice");
assert.ok(skill.includes("Passing check after"), "skill requires a passing check after the slice");
assert.ok(skill.includes("Why this slice first"), "skill requires why this slice is first");
assert.ok(skill.includes("slice-specific test"), "skill requires slice-specific tests");
assert.ok(skill.includes("capture a baseline"), "skill requires baseline before the change");
assert.ok(skill.includes("exact data condition"), "skill requires exact data condition to check");
assert.ok(skill.includes("default runner"), "skill treats configured command as optional default runner");
assert.ok(skill.includes("each slice still defines its own specific test"), "skill keeps test definition in the slice");
assert.ok(skill.includes("What would prove this slice wrong"), "skill requires early-warning signals");
assert.ok(skill.includes("What I’ll watch"), "skill requires concrete drift checks");
assert.ok(skill.includes("Stop-and-ask triggers"), "skill requires pause triggers");
assert.ok(skill.includes("Execute an approved slice without checkpoint stops"), "skill requires uninterrupted approved-slice execution");
assert.ok(skill.includes("do not ask the user to say"), "skill forbids repeated continue prompts");
assert.ok(skill.includes("internal steps, not reportable"), "skill makes internal checkpoints non-blocking");
assert.ok(skill.includes("An approved Dev/test validation pattern remains approved"), "skill preserves validation approval through the slice");
assert.ok(skill.includes("more than one edit"), "skill permits tightly related edits in one outcome slice");
assert.ok(skill.includes("Only after the passing check completes"), "skill delays reporting until the slice passes");
assert.ok(skill.includes("assumptions were invalidated"), "skill checks assumptions after the slice");
assert.ok(skill.includes("explain what happened"), "skill requires post-slice explanation");
assert.ok(skill.includes("Live-data tests between slices"), "skill documents live-data test hook");
assert.ok(skill.includes("tests.live_data.enabled"), "skill references the config key");
assert.ok(skill.includes("/slice-next"), "skill references the /slice-next prompt");

const prompt = readFileSync(join(ROOT, "prompts/slice-next.md"), "utf8");
assert.ok(prompt.includes("# /slice-next"), "prompt exposes /slice-next command");
assert.ok(prompt.includes("slice-specific test"), "prompt asks for slice-specific test");
assert.ok(prompt.includes("capture a baseline"), "prompt asks for baseline before the change");
assert.ok(prompt.includes("exact data condition"), "prompt asks for exact data condition");
assert.ok(prompt.includes("specific query/measure/command"), "prompt asks for specific live-data test");
assert.ok(prompt.includes("Passing check after"), "prompt asks for passing check after");
assert.ok(prompt.includes("Why this slice now"), "prompt asks for why this slice now");
assert.ok(prompt.includes("Assumptions I’m making"), "prompt asks for assumptions");
assert.ok(prompt.includes("What would prove this slice wrong"), "prompt asks for early-warning signals");
assert.ok(prompt.includes("Stop-and-ask triggers"), "prompt asks for pause triggers");
assert.ok(prompt.includes("Wait for my approval"), "prompt waits for approval before editing");
assert.ok(prompt.includes("without interim checkpoint stops"), "prompt requires uninterrupted approved-slice execution");
assert.ok(prompt.includes("only after the slice passes"), "prompt reports only after completion");
assert.ok(prompt.includes("tests.live_data.enabled"), "prompt references live-data config");

const explain = readFileSync(join(ROOT, "prompts/explain.md"), "utf8");
assert.ok(explain.includes("# /explain"), "prompt exposes /explain command");
assert.ok(explain.includes("teaching an experienced"), "explain prompt targets expert review");
assert.ok(explain.includes("What would make this approach wrong"), "explain prompt asks for warning signs");

const example = readFileSync(join(ROOT, ".coop/project.example.yml"), "utf8");
assert.ok(example.includes("tests:"), "example project has tests section");
assert.ok(example.includes("live_data:"), "example project has live_data section");
assert.ok(example.includes("between_slices:"), "example project has between_slices key");
assert.ok(example.includes("require_approval:"), "example project has require_approval key");

const fallback = readFileSync(join(ROOT, ".coop/project.yml"), "utf8");
assert.ok(fallback.includes("tests:"), "fallback project has tests section");
assert.ok(fallback.includes("live_data:"), "fallback project has live_data section");

const guardrails = readFileSync(join(ROOT, "docs/guardrails.md"), "utf8");
assert.ok(guardrails.includes("vertical slices"), "guardrails reference vertical slices");
assert.ok(guardrails.includes("tests.live_data.enabled"), "guardrails reference live-data test hook");
assert.ok(guardrails.includes("/slice-next"), "guardrails reference /slice-next prompt");
assert.ok(guardrails.includes("/explain"), "guardrails reference /explain prompt");
assert.ok(guardrails.includes("does not expire after each internal step"), "guardrails preserve slice approval");
assert.ok(guardrails.includes("messages are non-blocking"), "guardrails forbid progress checkpoints from ending a slice");

console.log("✓ workflow slice tests passed");
