// Tests for the "Start Here" menu wiring in extensions/coop-tools.
// Imports the bundled extension's named exports (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";

// COOP_TEST_DIST is an ABSOLUTE path; a bare `C:\...` is not a valid ESM URL on
// Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME), so import it via a file:// URL.
const dist = process.env.COOP_TEST_DIST;
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildStartMenu, shouldOpenFirstRunMenu, saveUserProfileName } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
};

t("buildStartMenu returns runnable task items with unique labels", () => {
  const items = buildStartMenu();
  assert.ok(Array.isArray(items) && items.length >= 5, "expected several menu items");
  for (const it of items) {
    assert.equal(typeof it.label, "string");
    assert.ok(it.label.length > 0, "every item has a label");
    assert.equal(typeof it.run, "function", "every item has a run() dispatcher");
  }
  // The dispatcher matches the picked label back to its item, so labels must be unique.
  const labels = items.map((i) => i.label);
  assert.equal(new Set(labels).size, labels.length, "menu labels must be unique");
  assert.ok(labels.some((label) => label.includes("set up or edit this Coop project")), "project wizard must be discoverable from /start");
  assert.ok(labels.some((label) => label.includes("Document a warehouse or semantic model")), "data-doc setup must be discoverable from /start");
});

t("the menu is the seven common workflows of master plan section 9, in order", () => {
  const labels = buildStartMenu().map((i) => i.label);
  assert.equal(labels.length, 7, "one menu item per plan workflow");
  const expected = [
    "against our standards",
    "Trace the impact",
    "Fix or edit an object on dev",
    "Document a warehouse or semantic model",
    "Start a client project",
    "log or a handoff",
    "Sign in or check health",
  ];
  expected.forEach((needle, i) => assert.ok(labels[i].includes(needle), `item ${i + 1} is "${needle}", got "${labels[i]}"`));
});

t("prompt-sending items name the prompt or tool that does the work", async () => {
  const sent = [];
  const pi = { sendUserMessage: (m) => sent.push(m) };
  const items = buildStartMenu();
  for (const idx of [0, 1, 2, 5, 6]) await items[idx].run(pi, {});
  assert.equal(sent.length, 5);
  assert.match(sent[0], /standards/);
  assert.match(sent[1], /sql_impact/);
  assert.match(sent[1], /data_doc lineage/);
  assert.match(sent[2], /\/spec-first/);
  assert.match(sent[2], /\/slice-next/);
  assert.match(sent[3], /\/daily-log/);
  assert.match(sent[3], /\/handoff/);
  assert.match(sent[4], /coop doctor/);
  assert.match(sent[4], /az login/);
  for (const m of sent) assert.doesNotMatch(m, /sql_review|dax_review/, "the retired review tools are never requested");
});

t("shouldOpenFirstRunMenu: only a TUI with COOP_FIRST_RUN set, once", () => {
  const tui = { hasUI: true, mode: "tui" };
  assert.equal(shouldOpenFirstRunMenu(tui, {}), false, "no flag: the prompt stays blank");
  assert.equal(shouldOpenFirstRunMenu(tui, { COOP_FIRST_RUN: "1" }), true);
  assert.equal(shouldOpenFirstRunMenu(tui, { COOP_FIRST_RUN: "true" }), true);
  assert.equal(shouldOpenFirstRunMenu(tui, { COOP_FIRST_RUN: "0" }), false);
  assert.equal(shouldOpenFirstRunMenu({ hasUI: false, mode: "tui" }, { COOP_FIRST_RUN: "1" }), false, "no dialogs: no menu");
  assert.equal(shouldOpenFirstRunMenu({ hasUI: true, mode: "rpc" }, { COOP_FIRST_RUN: "1" }), false, "rpc mode never opens a dialog");
});

t("saveUserProfileName writes onboard.py's user.json shape and applies its name rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-startmenu-"));
  try {
    const path = join(dir, "nested", "user.json");
    assert.equal(saveUserProfileName("  Aaron\u0007 ", path), "Aaron", "control characters stripped, trimmed");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved, { schema_version: 1, name: "Aaron", communication: { preset: "balanced", custom_instructions: "" } });
    assert.equal(saveUserProfileName("", join(dir, "blank.json")), null);
    assert.equal(saveUserProfileName("C:\\Users\\me", join(dir, "path.json")), null, "path-like names are rejected like onboard.py");
    assert.equal(saveUserProfileName("x".repeat(101), join(dir, "long.json")), null);
    assert.equal(existsSync(join(dir, "blank.json")) || existsSync(join(dir, "path.json")) || existsSync(join(dir, "long.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`  ${n} start-menu tests passed`);
