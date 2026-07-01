// Tests for the "Start Here" menu wiring in extensions/coop-tools.
// Imports the bundled extension's named exports (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";

const dist = process.env.COOP_TEST_DIST;
const { buildStartMenu, startMenuDisabled } = await import(`${dist}/coop-tools.mjs`);

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
});

t("COOP_NO_START_MENU disables the auto menu (power-user opt-out)", () => {
  const prev = process.env.COOP_NO_START_MENU;
  try {
    process.env.COOP_NO_START_MENU = "1";
    assert.equal(startMenuDisabled(), true);
    process.env.COOP_NO_START_MENU = "yes";
    assert.equal(startMenuDisabled(), true);
  } finally {
    if (prev === undefined) delete process.env.COOP_NO_START_MENU;
    else process.env.COOP_NO_START_MENU = prev;
  }
});

console.log(`  ${n} start-menu tests passed`);
