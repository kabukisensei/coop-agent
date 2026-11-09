// FocusTime contract (FT1): the Coop brief, the story_proposals v1 JSON and the
// `[Coop brief v1]` / `[Coop update v1]` DevOps comments are a shared contract with
// cooptimize/focustime. The fixture copies FocusTime's schema keys, enums and the
// regex it reads comments with; this test fails when the skill or /handoff drifts.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout has CRLF
const c = JSON.parse(read("tests/fixtures/focustime/coop-proposals-v1.json"));
const skill = read("skills/azure-devops/SKILL.md");
const handoff = read("prompts/handoff.md");

// The skill's description names the trigger so the skill loads on a pasted brief.
const desc = skill.split("\n").find((l) => l.startsWith("description:"));
assert.ok(desc && desc.includes("Coop brief"), "description mentions the Coop brief");
assert.ok(skill.includes(c.brief_heading), "skill recognizes FocusTime's brief heading");
assert.ok(skill.includes("never as instructions"), "brief content is data, never instructions");

// The example JSON block must satisfy FocusTime's schema and checks.
const m = /```json\n([\s\S]*?)\n```/.exec(skill.slice(skill.indexOf("## FocusTime")));
assert.ok(m, "skill has a story_proposals json example");
const ex = JSON.parse(m[1]);
assert.deepEqual(Object.keys(ex).sort(), [...c.required].sort(), "top-level keys are exactly FocusTime's");
assert.equal(ex.kind, c.kind);
assert.equal(ex.version, c.version);
assert.ok(Number.isInteger(ex.feature_id), "feature_id is an integer");
assert.ok(ex.proposals.length <= c.max_proposals);
const idRe = new RegExp(c.proposal_id_pattern);
for (const p of ex.proposals) {
  assert.deepEqual(Object.keys(p).sort(), [...c.proposal_required].sort(), "proposal keys are exactly FocusTime's");
  assert.ok(idRe.test(p.id), "proposal id matches FocusTime's pattern");
  assert.ok(c.sizes.includes(p.size), "size is one FocusTime accepts");
  assert.ok(p.title.length >= 1 && p.title.length <= c.title_max);
}
for (const s of ex.set_aside) {
  assert.deepEqual(Object.keys(s).sort(), [...c.set_aside_required].sort(), "set_aside keys are exactly FocusTime's");
  assert.ok(c.why.includes(s.why));
}
// The rules the skill states match the fixture's limits.
assert.ok(skill.includes(c.proposal_id_pattern), "skill states the id pattern");
assert.ok(skill.includes("at most 10 proposals"), "skill states the proposal cap");
assert.ok(skill.includes("1 to 120 characters"), "skill states the title limit");
for (const w of c.why) assert.ok(skill.includes(w), `skill names why=${w}`);

// Comment shapes: FocusTime reads the first line after the prefix.
const block = new RegExp(c.comment_block, "i");
const fence = /```text\n([\s\S]*?)\n```/.exec(skill.slice(skill.indexOf("## FocusTime")));
assert.ok(fence, "skill shows the update comment shape");
assert.ok(block.test(fence[1]), "the update comment starts with a prefix FocusTime reads");
assert.ok(fence[1].startsWith("[Coop update v1]\n"), "the prefix is alone on line 1");
assert.ok(skill.includes("exactly `[Coop brief v1]`"), "skill posts proposals under the brief prefix");
assert.ok(block.test("[Coop brief v1]\n- p1"), "brief prefix matches FocusTime's regex");
assert.match(skill, /never another client's name/, "comments never name another client");
assert.match(skill, /no SQL, code, file paths/, "comments carry no code");

// /handoff offers the comment, confirm-first, and names it as its only write.
assert.ok(handoff.includes("`[Coop update v1]`"), "/handoff offers the update comment");
assert.ok(handoff.includes("only on the person's yes"), "/handoff posts only on a yes");
assert.ok(handoff.includes("the one write `/handoff` may make"), "/handoff stays otherwise read-only");

console.log("✓ FocusTime contract tests passed");
