/** Contract tests for Coop terminal-title branding. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST is required");
const { formatCoopTitle, formatSessionName, layoutFooter, visWidth, default: coopPowerline } = await import(pathToFileURL(join(dist, "coop-powerline.mjs")));

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

// Footer layout across terminal widths (Aaron runs Windows Terminal at varying
// widths; the usage data must never be cut off).
const usageStatus = "Usage: 5h: 82% | 7d: 64% | 5h resets 2h13m | 7d resets Oct 5 14:00";
const segs = [
  { parts: ["gpt-5.5-codex"], join: "", sep: "  ·  " },
  { parts: ["ctx 12%  34.2k>1.9k tok  $0.412"], join: "", sep: "  ·  " },
  { parts: usageStatus.split(" | "), join: " | ", sep: "  ·  " },
];
const left = "⬢ Cooptimize  Revenue fix  main";
const fields = segs.flatMap((s) => s.parts);
const oneLine = visWidth(left) + 1 + visWidth(segs.map((s, i) => (i ? s.sep : "") + s.parts.join(s.join)).join(""));
for (const width of [200, 160, 120, 100, 80, 60, 40, 24]) {
  const lines = layoutFooter(left, segs, width).map(stripAnsi);
  for (const line of lines) assert.ok(visWidth(line) <= width, `width ${width}: line too wide: ${JSON.stringify(line)}`);
  const all = lines.join("\n");
  for (const f of fields) {
    if (visWidth(f) <= width) assert.ok(all.includes(f), `width ${width}: "${f}" missing from ${JSON.stringify(lines)}`);
  }
  assert.ok(lines[0].startsWith(width >= visWidth(left) ? left : left.slice(0, width)), `width ${width}: left side starts line 1`);
  if (width >= oneLine) assert.equal(lines.length, 1, `width ${width}: a wide window keeps the one-line footer`);
  else assert.ok(lines.length >= 2, `width ${width}: wraps instead of clipping`);
  if (width >= 100 && width < oneLine) {
    assert.ok(lines.some((l) => l.trim() === usageStatus), `width ${width}: the usage status stays whole on its own line`);
  }
}
const one = (t) => ({ parts: [t], join: "", sep: " · " });
assert.deepEqual(layoutFooter("L", [one("a"), one("b")], 10), ["L    a · b"], "a footer that fits is one line, right side flush to the edge");
assert.deepEqual(
  layoutFooter("left side", [one("aaaa"), one("bbbbbbbb")], 16),
  ["left side   aaaa", "        bbbbbbbb"],
  "the overflow wraps onto a right-aligned line",
);
assert.deepEqual(
  layoutFooter("L", [{ parts: ["5h: 82%", "7d: 64%"], join: " | ", sep: " · " }], 10),
  ["L", "   5h: 82%", "   7d: 64%"],
  "a status wider than a line breaks between its fields",
);
const long = layoutFooter("L", [one("x".repeat(25))], 10);
assert.equal(long.slice(1).map((l) => l.trim()).join(""), "x".repeat(25), "a field wider than the line is split, not dropped");
assert.equal(visWidth("日本"), 4, "wide characters count as two columns");
assert.ok(layoutFooter("⬢ 日本語の名前ですよ", [one("gpt")], 12).every((l) => visWidth(l) <= 12));
assert.deepEqual(layoutFooter("L", [], 0), []);
console.log("  ✓ footer is one line when it fits and wraps (never clips) usage in narrow windows");

ctx.model = { id: "gpt-5.5-codex" };
let narrow;
ctx.ui.setFooter = (factory) => {
  narrow = factory({ requestRender() {} }, theme, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["pi-better-openai", usageStatus]]),
  });
};
await handlers.get("session_start")({}, ctx);
const narrowLines = narrow.render(90).map(stripAnsi);
assert.ok(narrowLines.length >= 2, "the real footer wraps at 90 columns");
assert.ok(narrowLines.every((l) => visWidth(l) <= 90));
for (const piece of ["gpt-5.5-codex", "5h: 82%", "7d: 64%", "7d resets Oct 5 14:00"]) {
  assert.ok(narrowLines.join("\n").includes(piece), `the footer keeps "${piece}" at 90 columns`);
}
assert.equal(narrow.render(240).length, 1, "the real footer is one line in a wide window");
console.log("  ✓ the live footer surfaces pi-better-openai usage in full at 90 columns");

await handlers.get("session_shutdown")({}, ctx);
console.log("  5 powerline title and footer tests passed");

// Under coop/auto (master plan R1) the model segment shows the routed physical
// model beside the selection, read from the latest successful assistant reply.
{
  const { formatModel } = await import(pathToFileURL(join(dist, "coop-powerline.mjs")));
  const auto = { provider: "coop", id: "auto", api: "pi-virtual" };
  const branchOf = (...messages) => ({ getBranch: () => messages.map((message) => ({ type: "message", message })) });
  assert.equal(formatModel({ model: { provider: "openai-codex", id: "gpt-5.6-terra", api: "openai-codex-responses" } }), "gpt-5.6-terra");
  assert.equal(formatModel({ model: auto, sessionManager: branchOf() }), "auto", "no reply yet: the selection alone");
  assert.equal(formatModel({ model: auto, sessionManager: branchOf({ role: "assistant", model: "gpt-5.6-terra", api: "openai-codex-responses", stopReason: "stop" }, { role: "assistant", model: "gpt-5.6-luna", api: "openai-codex-responses", stopReason: "stop" }) }), "auto → gpt-5.6-luna");
  assert.equal(formatModel({ model: auto, sessionManager: branchOf({ role: "assistant", model: "gpt-5.6-terra", api: "openai-codex-responses", stopReason: "stop" }, { role: "assistant", model: "auto", api: "pi-virtual", stopReason: "error" }) }), "auto → gpt-5.6-terra", "a failed route is skipped");
  assert.equal(formatModel({ model: undefined }), "");
  console.log("  ✓ the footer shows the routed model under coop/auto");
}
