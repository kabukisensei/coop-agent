// Change history (CW2), Neon's review B6: with the feature OFF no history code
// runs on the tool path at all. The guardrails are bundled with
// lib/action-history.mjs left as an import (tests/run.sh: --external), and that
// import resolves to a stub written here which counts every call into the real
// module. Off: real write, edit, read, bash and PowerShell calls (the history
// folder named among them) through tool_call and tool_result make no call. On:
// the same calls do (the stub is wired), and a glob in ~/.coop that cannot match
// "history" is not blocked.
//   COOP_TEST_HISTORY_STUB_DIST=<dir with x/y/coop-guardrails.mjs> node tests/action-history-off.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = process.env.COOP_TEST_HISTORY_STUB_DIST;
assert.ok(DIST, "COOP_TEST_HISTORY_STUB_DIST is set (tests/run.sh)");
const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-cw2-off-")));
const HOME = join(root, "home");
Object.assign(process.env, { HOME, USERPROFILE: HOME, COOP_DIR: HOME, PI_CODING_AGENT_DIR: join(root, "agent"), COOP_ROOT: ROOT });
delete process.env.COOP_NO_GUARDRAILS;
mkdirSync(join(HOME, ".coop", "history", "x"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const CONFIG = join(HOME, ".coop", "config");

// The stub: every function the real module exports, counted.
const real = await import(pathToFileURL(join(ROOT, "lib", "action-history.mjs")).href);
mkdirSync(join(DIST, "lib"), { recursive: true });
writeFileSync(join(DIST, "lib", "action-history.mjs"), [
  `import * as real from ${JSON.stringify(pathToFileURL(join(ROOT, "lib", "action-history.mjs")).href)};`,
  "globalThis.__historyCalls = globalThis.__historyCalls || [];",
  "const wrap = (name) => (...args) => { globalThis.__historyCalls.push(name); return real[name](...args); };",
  ...Object.keys(real).map((k) => (typeof real[k] === "function" ? `export const ${k} = wrap(${JSON.stringify(k)});` : `export const ${k} = real.${k};`)),
  "",
].join("\n"));
const cg = await import(pathToFileURL(join(DIST, "x", "y", "coop-guardrails.mjs")).href);

const repo = join(root, "client");
mkdirSync(join(repo, "docs"), { recursive: true });
spawnSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "docs", "a.md"), "a\n");

function load() {
  const handlers = {};
  const commands = {};
  const pi = { on: (ev, h) => { handlers[ev] = h; }, registerCommand: (name, spec) => { commands[name] = spec; }, exec: async () => ({ stdout: "", stderr: "", code: 0 }) };
  cg.default(pi);
  const ui = { confirm: async () => true, select: async () => undefined, input: async () => undefined, notify: () => {} };
  const ctx = { cwd: repo, hasUI: true, ui, sessionManager: { getSessionId: () => "s" } };
  return { handlers, commands, ctx };
}

/** Real calls through tool_call and tool_result; returns the block reasons. */
async function drive(g) {
  const reasons = [];
  let n = 0;
  const calls = [
    ["write", { path: "docs/a.md", content: "b\n" }],
    ["edit", { path: "docs/a.md", edits: [] }],
    ["read", { path: "docs/a.md" }],
    ["read", { path: join(HOME, ".coop", "history", "x", "log.jsonl") }],
    ["bash", { command: "ls ~/.coop/*.json" }],
    ["bash", { command: "cat ~/.coop/history/x/log.jsonl" }],
    ["bash", { command: "ls ~/.coop/*" }],
    ["bash", { command: "rm -rf build" }],
    ["powershell", { command: "Get-ChildItem $env:USERPROFILE\\.coop\\history" }],
  ];
  for (const [toolName, input] of calls) {
    const toolCallId = `c${++n}`;
    const d = await g.handlers.tool_call({ type: "tool_call", toolName, toolCallId, input }, g.ctx);
    reasons.push(d && d.block ? String(d.reason) : "");
    await g.handlers.tool_result({ type: "tool_result", toolName, toolCallId, input, content: [], isError: false }, g.ctx);
  }
  await cg.historySettled();
  return reasons;
}

// Off: not one call into the history module, at load, session start or on the tool path.
writeFileSync(CONFIG, JSON.stringify({ features: { history: false } }));
globalThis.__historyCalls = [];
const off = load();
await off.handlers.session_start({ type: "session_start" }, off.ctx);
const offReasons = await drive(off);
await off.handlers.session_shutdown({ type: "session_shutdown" }, off.ctx);
assert.deepEqual(globalThis.__historyCalls, [], "off: no history code ran");
assert.equal(off.commands.history, undefined);
assert.ok(offReasons.every((r) => !/change history/.test(r)), "off: nothing is blocked as the change history");
console.log("  ✓ off: write, edit, read, bash and PowerShell calls make no call into lib/action-history.mjs");

// On: the stub is wired (calls are counted), the folder is blocked, and the glob
// false positive is gone.
writeFileSync(CONFIG, JSON.stringify({ features: { history: true } }));
globalThis.__historyCalls = [];
const on = load();
await on.handlers.session_start({ type: "session_start" }, on.ctx);
const onReasons = await drive(on);
assert.ok(globalThis.__historyCalls.length > 0, "on: the history module is called (the stub is wired)");
assert.ok(on.commands.history);
assert.equal(onReasons[4], "", "ls ~/.coop/*.json is not blocked");
assert.match(onReasons[3], /change history/);
assert.match(onReasons[5], /change history/);
assert.match(onReasons[6], /change history/);
assert.match(onReasons[8], /change history/);
console.log("  ✓ on: the same calls reach the history module; the folder is blocked, ls ~/.coop/*.json is not");
