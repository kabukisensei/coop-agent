/** Contract tests for Coop terminal-title branding. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST is required");
const { formatCoopTitle, formatSessionName, default: coopPowerline } = await import(pathToFileURL(join(dist, "coop-powerline.mjs")));

assert.equal(formatSessionName(undefined), "");
assert.equal(formatSessionName("  Revenue\n fix "), "Revenue fix");
assert.equal(formatSessionName("x".repeat(60)).length, 40);
console.log("  ✓ session names are folded and capped before they reach the footer")

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
let footer;
let footerRenders = 0;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_c, s) => s };
const renderFooter = () => stripAnsi(footer.render(120)[0]);
const ctx = {
  cwd: "/work/devops",
  hasUI: true,
  ui: {
    setTitle(value) {
      titles.push(value);
    },
    setHeader() {},
    setFooter(factory) {
      footer = factory({ requestRender: () => { footerRenders += 1; } }, theme, { getGitBranch: () => "main" });
    },
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
assert.match(renderFooter(), /Cooptimize {2}main/);
assert.doesNotMatch(renderFooter(), /Revenue/);

sessionName = "Revenue fix";
const rendersBefore = footerRenders;
await handlers.get("session_info_changed")({}, ctx);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(titles.at(-1), "coop - Revenue fix - devops");
assert.ok(footerRenders > rendersBefore, "a rename asks the footer to re-render");
assert.match(renderFooter(), /Cooptimize {2}Revenue fix {2}main/);
console.log("  ✓ startup and session rename hooks keep the tab Coop-branded and the footer shows the name")

await handlers.get("session_shutdown")({}, ctx);
console.log("  3 powerline title and footer tests passed");
