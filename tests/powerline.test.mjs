/** Contract tests for Coop terminal-title branding and footer ownership. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST is required");
const { formatCoopTitle, default: coopPowerline } = await import(pathToFileURL(join(dist, "coop-powerline.mjs")));

assert.equal(formatCoopTitle("/work/devops"), "coop - devops");
assert.equal(formatCoopTitle("/work/devops", "Revenue fix"), "coop - Revenue fix - devops");
console.log("  ✓ terminal title formatter replaces Pi branding with coop");

const handlers = new Map();
coopPowerline({
  on(name, handler) { handlers.set(name, handler); },
  registerCommand() {},
});

let sessionName;
let footer;
let footerSets = 0;
let renders = 0;
const branchListeners = new Set();
const titles = [];
const theme = { fg: (_color, text) => text };
const footerData = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map([["openai", "5h 80% · 7d 90%"]]),
  onBranchChange(listener) {
    branchListeners.add(listener);
    return () => branchListeners.delete(listener);
  },
};
const ctx = {
  cwd: "/work/devops",
  hasUI: true,
  model: { id: "test-model" },
  getContextUsage: () => ({ percent: 25 }),
  ui: {
    setTitle(value) { titles.push(value); },
    setHeader() {},
    // Pi's setExtensionFooter disposes the old component before replacing it;
    // undefined restores its built-in footer. Exercise that lifecycle, not just
    // whether Coop called setFooter.
    setFooter(factory) {
      footerSets++;
      footer?.dispose?.();
      footer = factory?.({ requestRender: () => renders++ }, theme, footerData);
    },
    setWorkingMessage() {},
    setWorkingIndicator() {},
  },
  sessionManager: { getSessionName: () => sessionName },
};
const emit = (name, context = ctx) => handlers.get(name)?.({}, context);
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// Deterministic title timers: no sleeps or real 16-second startup timer.
mock.timers.enable({ apis: ["setTimeout"] });
try {
  await emit("session_start");
  mock.timers.tick(0);
  assert.equal(titles.at(-1), "coop - devops");
  const initialFooter = footer;
  await emit("resources_discover");
  await emit("resources_discover");
  assert.equal(footer, initialFooter);
  assert.equal(footerSets, 1, "an intact footer must not be reinstalled");
  assert.equal(branchListeners.size, 1);
  console.log("  ✓ startup re-apply is a no-op while Coop still owns the footer");

  // A later session_start handler may await I/O before clearing Coop's footer.
  // Pi awaits all these handlers before dispatching resources_discover.
  await (async () => {
    await Promise.resolve();
    ctx.ui.setFooter(undefined);
  })();
  assert.equal(footer, undefined);
  assert.equal(branchListeners.size, 0, "replacement disposes the old subscription");
  await emit("resources_discover");
  assert.ok(footer, "restore Coop after the competing startup handler");
  const line = stripAnsi(footer.render(120)[0]);
  assert.match(line, /⬢ Cooptimize/);
  assert.match(line, /main/);
  assert.match(line, /test-model/);
  assert.match(line, /ctx 25%/);
  assert.match(line, /5h 80% · 7d 90%/);
  assert.ok(stripAnsi(footer.render(20)[0]).length <= 20);
  assert.equal(branchListeners.size, 1);
  for (const listener of branchListeners) listener();
  assert.equal(renders, 1, "the restored footer still renders on branch changes");
  const restoredFooter = footer;
  await emit("resources_discover");
  assert.equal(footer, restoredFooter);
  console.log("  ✓ a later clear is repaired with branding, statuses and one live subscription");

  // Cover replacement with another custom component as well as undefined.
  let competingDisposals = 0;
  ctx.ui.setFooter(() => ({ dispose: () => competingDisposals++ }));
  await emit("resources_discover");
  assert.equal(competingDisposals, 1);
  assert.equal(branchListeners.size, 1);
  console.log("  ✓ a competing footer is disposed when Coop reclaims the bar");

  sessionName = "Revenue fix";
  await emit("session_info_changed");
  mock.timers.tick(0);
  assert.equal(titles.at(-1), "coop - Revenue fix - devops");
  console.log("  ✓ startup and session rename hooks keep the tab Coop-branded");

  await emit("session_start");
  await emit("resources_discover");
  assert.equal(branchListeners.size, 1, "repeated starts do not accumulate listeners");
  await emit("session_shutdown");
  ctx.ui.setFooter(undefined);
  const shutdownSets = footerSets;
  await emit("resources_discover");
  assert.equal(footerSets, shutdownSets, "shutdown drops the re-apply callback");
  assert.equal(branchListeners.size, 0);
  console.log("  ✓ repeated starts and shutdown do not leak or revive a footer");

  for (const context of [
    { hasUI: false, ui: { setFooter() { assert.fail("headless footer call"); } } },
    { hasUI: true, ui: {} },
    { hasUI: true, ui: { setFooter() { throw new Error("UI unavailable"); } } },
  ]) {
    await emit("session_start", context);
    await emit("resources_discover", context);
    await emit("session_shutdown", context);
  }
  assert.equal(footerSets, shutdownSets, "unsupported contexts cannot revive a stale footer");
  console.log("  ✓ headless, missing and throwing footer APIs remain safe");
} finally {
  await emit("session_shutdown");
  mock.timers.reset();
}
console.log("  7 powerline tests passed");
