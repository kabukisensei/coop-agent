/** Contract tests for Coop terminal-title branding. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST is required");
const { formatCoopTitle, default: coopPowerline } = await import(pathToFileURL(join(dist, "coop-powerline.mjs")));

assert.equal(formatCoopTitle("/work/devops"), "coop - devops");
assert.equal(formatCoopTitle("/work/devops", "Revenue fix"), "coop - Revenue fix - devops");
console.log("  ✓ terminal title formatter replaces Pi branding with coop")

const handlers = new Map();
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerCommand() {},
};
coopPowerline(pi);

let sessionName;
const titles = [];
const ctx = {
  cwd: "/work/devops",
  hasUI: true,
  ui: {
    setTitle(value) {
      titles.push(value);
    },
    setHeader() {},
    setFooter() {},
    setWorkingMessage() {},
    setWorkingIndicator() {},
  },
  sessionManager: {
    getSessionName() {
      return sessionName;
    },
  },
};

await handlers.get("session_start")({}, ctx);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(titles.at(-1), "coop - devops");

sessionName = "Revenue fix";
await handlers.get("session_info_changed")({}, ctx);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(titles.at(-1), "coop - Revenue fix - devops");
console.log("  ✓ startup and session rename hooks keep the tab Coop-branded")

await handlers.get("session_shutdown")({}, ctx);
console.log("  2 powerline title tests passed");
