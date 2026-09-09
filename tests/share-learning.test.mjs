// Tests for Step 1.5: shouldSuggestShareLearning predicate and share-learning prompt conventions.
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const {
  shouldSuggestShareLearning,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

await t("returns false when knowledge is not available", () => {
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: false,
      toolFailures: 5,
      userSteers: 2,
    }),
    false
  );
});

await t("returns false when already suggested in this session", () => {
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: true,
      alreadySuggested: true,
      toolFailures: 5,
    }),
    false
  );
});

await t("returns false when friction is low", () => {
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: true,
      toolFailures: 0,
      userSteers: 0,
      retries: 0,
    }),
    false
  );
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: true,
      toolFailures: 1,
      userSteers: 0,
      retries: 0,
    }),
    false
  );
});

await t("returns true on repeated tool failures (>=2)", () => {
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: true,
      toolFailures: 2,
    }),
    true
  );
});

await t("returns false on a single tool failure", () => {
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: true,
      toolFailures: 1,
    }),
    false
  );
});

await t("steer/retry signals are deferred (not part of the contract)", () => {
  // Automatic user-correction/steer/retry detection is deliberately deferred;
  // the predicate only counts repeated tool failures today. Extra signal
  // fields must not change the result.
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: true,
      toolFailures: 0,
      userSteers: 1,
    }),
    false
  );
  assert.equal(
    shouldSuggestShareLearning({
      knowledgeAvailable: true,
      toolFailures: 0,
      retries: 1,
    }),
    false
  );
});

await t("prompts/share-learning.md exists, is non-empty, and includes expected frontmatter keys", () => {
  const promptPath = join(process.cwd(), "prompts", "share-learning.md");
  assert.ok(existsSync(promptPath), "prompts/share-learning.md must exist");
  const content = readFileSync(promptPath, "utf8");
  assert.ok(content.length > 50);
  assert.match(content, /title:/);
  assert.match(content, /author:/);
  assert.match(content, /date:/);
  assert.match(content, /tags:/);
  assert.match(content, /x-coop:/);
  assert.match(content, /kind:/);
  assert.match(content, /scope:/);
  assert.match(content, /sensitivity:/);
  assert.match(content, /status:/);
  assert.match(content, /confidence:/);
});

await t("share-learning prompt routes publication through PR only — no teamai push route", () => {
  const content = readFileSync(join(process.cwd(), "prompts", "share-learning.md"), "utf8");
  assert.ok(!/teamai/i.test(content), "teamai must not appear in the sharing prompt");
  assert.match(content, /NEVER commit directly to main/i);
  assert.match(content, /pull request/i);
});

await t("share-learning prompt requires selecting the knowledge repository before drafting", () => {
  const content = readFileSync(join(process.cwd(), "prompts", "share-learning.md"), "utf8");
  assert.match(content, /Select the knowledge repository FIRST/i);
  assert.match(content, /WHICH repository this learning belongs to/i);
  assert.match(content, /Never publish a note to a\s*repository the user did not pick/i);
});

await t("team-knowledge skill drives the local-search helper, never teamai", () => {
  const skillPath = join(process.cwd(), "skills", "team-knowledge", "SKILL.md");
  assert.ok(existsSync(skillPath), "skills/team-knowledge/SKILL.md must exist");
  const content = readFileSync(skillPath, "utf8");
  assert.match(content, /scripts\/search-knowledge\.py/);
  assert.match(content, /search-knowledge\.py.*--query/s);
  assert.match(content, /\$COOP_ROOT/);
  // Handle the structured statuses instead of guessing.
  for (const status of ["ok", "unavailable", "disabled", "invalid_config"]) {
    assert.ok(content.includes(`\`${status}\``), `skill must explain status ${status}`);
  }
  // Repository identity + note path must be cited together.
  assert.match(content, /repository identity plus the note path|repository \(root label\/path\)/);
  // No teamai recall route may remain.
  assert.ok(!/teamai recall/.test(content), "teamai recall route must be removed from the skill");
});
