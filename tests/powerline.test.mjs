/** Contract tests for Coop terminal-title branding. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST is required");
const { formatCoopTitle, formatCoopVersion, formatSessionName, layoutFooter, visWidth, wrapSlashProvider, filterSlashItems, unknownSlashCommand, TITLE_SETTLE_DELAYS_MS, default: coopPowerline } = await import(pathToFileURL(join(dist, "coop-powerline.mjs")));
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

assert.equal(formatSessionName(undefined), "");
assert.equal(formatSessionName("  Revenue\n fix "), "Revenue fix");
assert.equal(formatSessionName("x".repeat(60)).length, 40);
console.log("  ✓ session names are folded and capped before they reach the footer")

assert.equal(formatCoopTitle("/work/devops"), "coop - devops");
assert.equal(formatCoopTitle("/work/devops", "Revenue fix"), "coop - Revenue fix - devops");
console.log("  ✓ terminal title formatter replaces Pi branding with coop")

// The running version (#429): COOP_VERSION from bin/coop.ps1, else the VERSION
// file beside the extension; ` dev` marks a git checkout.
{
  const root = mkdtempSync(join(tmpdir(), "coop-powerline-version-"));
  try {
    assert.equal(formatCoopVersion({}, root), "", "no env and no VERSION file: nothing is shown");
    assert.equal(formatCoopVersion({ COOP_VERSION: "0.38.4" }, root), "v0.38.4");
    writeFileSync(join(root, "VERSION"), "0.38.5\n");
    assert.equal(formatCoopVersion({}, root), "v0.38.5", "the VERSION file covers a plain pi -e launch");
    mkdirSync(join(root, ".git"));
    assert.equal(formatCoopVersion({ COOP_VERSION: "0.38.4" }, root), "v0.38.4 dev", "a git checkout is marked dev");
    assert.equal(formatCoopVersion({ COOP_VERSION: "garbage" }, root), "", "a value that is not a version is dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("  ✓ the footer version comes from COOP_VERSION or the VERSION file, with dev for a checkout");
}
delete process.env.COOP_VERSION;

const handlers = new Map();
const commands = new Map();
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerCommand(name, options) {
    commands.set(name, options);
  },
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

// --- #429: the version is in the footer; the title is reasserted after Pi and child processes rewrite it ---
{
  process.env.COOP_VERSION = "0.38.4";
  const titles2 = [];
  let footer2;
  const ctx2 = {
    cwd: "/work/devops",
    hasUI: true,
    ui: {
      setTitle(value) { titles2.push(value); },
      setHeader() {},
      setFooter(factory) { footer2 = factory({ requestRender() {} }, theme, { getGitBranch: () => "main" }); },
      setWorkingMessage() {},
      setWorkingIndicator() {},
      addAutocompleteProvider() {},
    },
    sessionManager: { getSessionName: () => undefined },
  };
  await handlers.get("session_start")({}, ctx2);
  const line = stripAnsi(footer2.render(120)[0]);
  assert.match(line, /^⬢ Cooptimize v0\.38\.4(?: dev)? {2}main/, `the footer leads with the running version: ${JSON.stringify(line)}`);
  delete process.env.COOP_VERSION;
  assert.ok(TITLE_SETTLE_DELAYS_MS.includes(0) && TITLE_SETTLE_DELAYS_MS.includes(250) && TITLE_SETTLE_DELAYS_MS.some((d) => d >= 16_000), "the schedule covers Pi's post-bind, /new and Windows package-check restores");
  // Pi overwrites the title after binding; coop takes it back within the first settle delays.
  titles2.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(titles2.length >= 3 && titles2.every((t) => t === "coop - devops"), `the title is reasserted on the settle schedule: ${JSON.stringify(titles2)}`);
  // A tool that spawned a child process just returned: the title is set again at once.
  for (const name of ["tool_execution_end", "turn_end", "agent_end"]) {
    titles2.length = 0;
    await handlers.get(name)({}, ctx2);
    assert.equal(titles2[0], "coop - devops", `${name} reasserts the title`);
  }
  // After shutdown (and the /new teardown that precedes a new session_start) no old timer fires.
  await handlers.get("session_shutdown")({}, ctx2);
  titles2.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(titles2, [], "no title timer survives session_shutdown");
  console.log("  ✓ the footer shows the coop version and the tab title is reasserted after /new and tool calls");
}

// --- #428: Enter on an unknown slash command never runs the fuzzy match ---
{
  const base = {
    commands: [{ name: "exit" }, { name: "settings" }, { name: "setup-project" }, { name: "skill:docs" }, { name: "mcp__powerbi__RunDAXQueryWithMetrics" }],
    basePath: "/work",
    async getSuggestions(lines, cursorLine, cursorCol) {
      const text = (lines[cursorLine] || "").slice(0, cursorCol);
      if (text === "@fi") return { items: [{ value: "file.sql", label: "file.sql" }], prefix: "@fi" };
      if (!text.startsWith("/")) return null;
      // Pi's fuzzy list for the word: the real one matched /exit to an MCP prompt.
      const word = text.slice(1);
      const items = this.commands.map((c) => ({ value: c.name, label: c.name })).filter((i) => [...word].every((ch) => i.value.toLowerCase().includes(ch)));
      return items.length ? { items, prefix: text } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return { lines: [`/${item.value} `], cursorLine: 0, cursorCol: item.value.length + 2, note: this.basePath };
    },
    shouldTriggerFileCompletion() { return true; },
  };
  let known;
  const wrapped = wrapSlashProvider(base, (names) => { known = names; });
  assert.deepEqual([...known].sort(), ["exit", "mcp__powerbi__RunDAXQueryWithMetrics", "settings", "setup-project", "skill:docs"], "the command names come from Pi's provider");
  const suggest = async (text) => wrapped.getSuggestions([text], 0, text.length, {});
  assert.equal(await suggest("/xit"), null, "a word that starts no command shows no list, so Enter cannot apply a fuzzy pick");
  assert.equal(await suggest("/dcs"), null, "fuzzy-only matches hide the list");
  assert.deepEqual((await suggest("/exit")).items.map((i) => i.value), ["exit", "mcp__powerbi__RunDAXQueryWithMetrics"], "an exact command leads its list; the fuzzy rest follows");
  assert.deepEqual((await suggest("/se")).items.map((i) => i.value)[0], "settings", "a prefix keeps Pi's order among the prefix matches");
  assert.deepEqual((await suggest("/doc")).items.map((i) => i.value)[0], "skill:docs", "a skill answers to its bare name");
  assert.deepEqual((await suggest("@fi")).items.map((i) => i.value), ["file.sql"], "file completion is untouched");
  assert.equal(await suggest("/settings arg"), null, "argument completion is the base provider's answer");
  assert.equal(wrapped.applyCompletion(["/ex"], 0, 3, { value: "exit" }, "/ex").note, "/work", "other members are forwarded bound to the base provider");
  assert.equal(wrapped.shouldTriggerFileCompletion(), true);
  assert.equal(wrapped.basePath, "/work");
  assert.deepEqual(filterSlashItems([{ value: "b" }, { value: "a" }], ""), [{ value: "b" }, { value: "a" }], "an empty word keeps the whole list");
  assert.equal(unknownSlashCommand("/xit", known), "xit");
  assert.equal(unknownSlashCommand("/exit", known), undefined);
  assert.equal(unknownSlashCommand("/docs", known), undefined, "a skill's bare name is known");
  assert.equal(unknownSlashCommand("/tmp/x is full", known), undefined, "a path is text");
  assert.equal(unknownSlashCommand("/x.y", known), undefined, "a dotted token is text");
  assert.equal(unknownSlashCommand("/xit now", known), "xit", "arguments do not make a command known");
  assert.equal(unknownSlashCommand("/xit", new Set()), undefined, "no provider seen (the window): passive");

  // The input hook: the provider wrapper fills the known names on session_start.
  const notices = [];
  const editor = [];
  let wrapper;
  const ctx3 = {
    cwd: "/work/devops",
    hasUI: true,
    ui: {
      setTitle() {},
      setHeader() {},
      setFooter() {},
      setWorkingMessage() {},
      setWorkingIndicator() {},
      addAutocompleteProvider(factory) { wrapper = factory; },
      setEditorText(text) { editor.push(text); },
      notify(message, level) { notices.push({ message, level }); },
    },
    sessionManager: { getSessionName: () => undefined },
  };
  await handlers.get("session_start")({}, ctx3);
  assert.ok(wrapper, "session_start registers the slash provider wrapper");
  wrapper(base);
  const input = (text, source = "interactive") => handlers.get("input")({ type: "input", text, source }, ctx3);
  assert.deepEqual(await input("/exit"), { action: "continue" }, "a known command passes");
  assert.deepEqual(await input("hello /xit"), { action: "continue" }, "ordinary text passes");
  assert.deepEqual(await input("/xit"), { action: "handled" }, "an unknown command is held");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editor.includes("/xit"), "the held text is put back in the editor");
  assert.match(notices.at(-1).message, /Unknown command \/xit/);
  assert.equal(notices.at(-1).level, "warning");
  assert.deepEqual(await input("/xit"), { action: "continue" }, "the same text sent again goes through as typed");
  assert.deepEqual(await input("/xit"), { action: "handled" }, "a third time it is held again");
  assert.deepEqual(await input("/xit", "rpc"), { action: "continue" }, "only the terminal's own typing is checked");
  await handlers.get("session_shutdown")({}, ctx3);
  assert.equal(commands.get("exit")?.description, "Quit coop (same as /quit)", "/exit is registered as a quit alias");
  let shutdowns = 0;
  await commands.get("exit").handler("", { shutdown() { shutdowns += 1; } });
  assert.equal(shutdowns, 1, "/exit asks Pi to shut down");
  console.log("  ✓ an unknown slash command never runs a fuzzy match on Enter; /exit quits");
}
