// Tests for the JSONL wizard bridge's prompt-rendering logic in
// extensions/coop-tools (renderPrompt / askCheckbox). These are the pure
// mapping pieces of the bridge — no live coop-data-doc subprocess required.
// Imports the bundled extension's named exports (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const { renderPrompt, askCheckbox } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
};

t("renderPrompt text → ui.input, trimmed, control chars stripped", async () => {
  const calls = [];
  const ctx = {
    ui: {
      input: async (label, def) => {
        calls.push([label, def]);
        return "\u0007 My\u0008Estate \u0000";
      },
    },
  };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q1", kind: "text", message: "Project name?", default: "Coop BI Estate" });
  assert.equal(answer, "MyEstate");
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /Project name\?/);
  assert.equal(calls[0][1], "Coop BI Estate");
});

t("renderPrompt text → blank answer falls back to default", async () => {
  const ctx = { ui: { input: async () => "   " } };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q", kind: "text", message: "X", default: "fallback" });
  assert.equal(answer, "fallback");
});

t("renderPrompt path → discovers sibling folders and returns a relative path", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-path-picker-"));
  const cwd = join(root, "current-project");
  const sql = join(root, "sql-warehouse");
  mkdirSync(cwd); mkdirSync(sql);
  let calls = 0;
  const ctx = { cwd, ui: {
    select: async (_message, choices) => {
      calls++;
      if (calls === 1) {
        const folder = choices.find((choice) => choice.includes("sql-warehouse"));
        assert.ok(folder, "sibling folder should be discovered from the default's real parent");
        return folder;
      }
      return choices.find((choice) => choice.startsWith("✓ Use this folder:"));
    },
  } };
  const answer = await renderPrompt(ctx, {
    type: "prompt", id: "sql_path", kind: "path", message: "SQL repo path", default: "../sql-repo",
  });
  assert.equal(answer, relative(cwd, sql));
  assert.equal(calls, 2);
});

t("renderPrompt confirm → ui.confirm returns boolean", async () => {
  const ctx = { ui: { confirm: async () => true } };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q2", kind: "confirm", message: "Map it?" });
  assert.equal(answer, true);
});

t("renderPrompt select → chosen label mapped back to value", async () => {
  const labels = [];
  const ctx = { ui: { select: async (msg, l) => { labels.push(...l); return l[1]; } } };
  const answer = await renderPrompt(ctx, {
    type: "prompt",
    id: "q3",
    kind: "select",
    message: "Pick",
    choices: [
      { label: "Alpha", value: "a" },
      { label: "Beta", value: "b" },
    ],
  });
  assert.equal(answer, "b");
  assert.deepEqual(labels, ["Alpha", "Beta"]);
});

t("renderPrompt cancel (Esc) → null", async () => {
  const ctx = { ui: { input: async () => null } };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q4", kind: "text", message: "X", default: "" });
  assert.equal(answer, null);
});

t("askCheckbox → toggle loop returns final selected values", async () => {
  const picks = ["☑ A", "☐ B", "✓ Done"];
  let i = 0;
  const ctx = { ui: { select: async () => picks[i++] } };
  const answer = await askCheckbox(ctx, {
    type: "prompt",
    id: "q5",
    kind: "checkbox",
    message: "Folders",
    choices: [
      { label: "A", value: "a", checked: true },
      { label: "B", value: "b", checked: false },
    ],
  });
  // A was pre-checked → toggled OFF; B was unchecked → toggled ON; then Done.
  assert.deepEqual(answer, ["b"]);
});

t("askCheckbox → empty choices returns []", async () => {
  const ctx = { ui: { select: async () => "✓ Done" } };
  const answer = await askCheckbox(ctx, { type: "prompt", id: "q6", kind: "checkbox", message: "None", choices: [] });
  assert.deepEqual(answer, []);
});

t("askCheckbox → cancel (Esc) returns null", async () => {
  const ctx = { ui: { select: async () => null } };
  const answer = await askCheckbox(ctx, {
    type: "prompt",
    id: "q7",
    kind: "checkbox",
    message: "Folders",
    choices: [{ label: "A", value: "a", checked: false }],
  });
  assert.equal(answer, null);
});

console.log(`  ${n} setup-bridge tests passed`);
