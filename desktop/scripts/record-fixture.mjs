#!/usr/bin/env node
// Records the RPC fixture the window's tests replay (master plan D1b):
// tests/fixtures/desktop-rpc.jsonl, one {dir, msg} line per message between the
// window and Pi, and tests/fixtures/desktop-pi-surface.json, Pi's own slash
// commands and keybinding actions. A Pi upgrade (row U2) re-records it; the tests then show which
// events or commands changed shape.
//
// It runs the real Pi with coop's real launch arguments (`coop launch-spec
// --json`) against a scripted local model, in a throwaway agent dir and work
// folder, and answers every dialog from a fixed plan. Paths are replaced with
// <work>, <agent> and <coop> so the file is the same on every machine.
//
// usage (needs pwsh, node and Pi; a maintainer tool, not run by CI):
//   node desktop/scripts/record-fixture.mjs [--pi <pi cli.js>] [--extensions-from <agent dir>] [--out <file>]
//
// --extensions-from copies a synced agent dir's npm tree and package list
// (e.g. ~/.coop/agent after `coop sync`), so get_commands lists the pinned
// extensions' commands too. Without it only coop's own extensions load.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSplitter, encodeLine } from "../lib/jsonl.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const options = parseArgs(process.argv.slice(2));
const OUT = options.out || join(ROOT, "tests", "fixtures", "desktop-rpc.jsonl");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  return out;
}

function piEntry() {
  if (options.pi) return resolve(options.pi);
  const root = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).stdout.trim();
  const dir = join(root, "@earendil-works", "pi-coding-agent");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return join(dir, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
}

// --- The scripted model: one step per chat completion request -----------------
const ASK = {
  questions: [{
    question: "Which layout should report.sql use?",
    header: "Layout",
    options: [
      { label: "Cooptimize style", description: "Upper-case keywords, one column per line" },
      { label: "Keep as is", description: "Fix the spacing only" },
    ],
  }],
};
const STEPS = [
  { reasoning: "The user wants report.sql tidied and the build folder cleared. Ask which layout first.", text: "One question before I change the file.", tools: [{ name: "ask_user_question", args: ASK }] },
  { text: "I will format the query in the Cooptimize style.", tools: [{ name: "edit", args: { path: "report.sql", edits: [{ oldText: "select id,name from customers", newText: "SELECT\n    id,\n    name\nFROM customers;" }] } }] },
  { text: "Now the build folder.", tools: [{ name: "bash", args: { command: "rm -rf build" } }] },
  { reasoning: "The removal was declined, so report what changed.", text: "Done.\n\n- `report.sql` now follows the Cooptimize SQL style.\n- The build folder was **kept** because you declined.\n\n| Object | Change |\n|---|---|\n| `report.sql` | formatted |\n| `build/` | kept |\n\n```sql\nSELECT\n    id,\n    name\nFROM customers;\n```" },
  { text: "## Goal\nTidy report.sql and clear the build folder.\n\n## Done\n- report.sql formatted in the Cooptimize style.\n- build/ kept (removal declined)." },
];

function startModel() {
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
      const step = STEPS[Math.min(n++, STEPS.length - 1)];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant" });
      if (step.reasoning) for (const part of step.reasoning.match(/.{1,24}/gs)) chunk({ reasoning_content: part });
      if (step.text) for (const part of step.text.match(/.{1,16}/gs)) chunk({ content: part });
      (step.tools || []).forEach((tool, i) => {
        chunk({ tool_calls: [{ index: i, id: `call_${n}_${i}`, type: "function", function: { name: tool.name, arguments: "" } }] });
        chunk({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(tool.args) } }] });
      });
      chunk({}, step.tools ? "tool_calls" : "stop");
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1200 + 300 * n, completion_tokens: 80, total_tokens: 1280 + 300 * n } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// --- Throwaway agent dir and work folder --------------------------------------
function prepare(temp, port) {
  const agent = join(temp, "agent");
  const work = join(temp, "work");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, "build"), { recursive: true });
  // A tiny keepRecentTokens lets the short scripted session compact for real.
  const settings = { defaultProvider: "fixture", defaultModel: "fixture-model", quietStartup: true, compaction: { keepRecentTokens: 1 } };
  if (options.extensionsFrom) {
    const from = resolve(options.extensionsFrom);
    cpSync(join(from, "npm"), join(agent, "npm"), { recursive: true });
    const synced = JSON.parse(readFileSync(join(from, "settings.json"), "utf8"));
    if (Array.isArray(synced.packages)) settings.packages = synced.packages;
  }
  writeFileSync(join(agent, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  writeFileSync(join(agent, "models.json"), `${JSON.stringify({
    providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "Fixture model", reasoning: true, contextWindow: 200000, maxTokens: 8000 }] } },
  }, null, 2)}\n`);
  writeFileSync(join(work, "report.sql"), "select id,name from customers\n");
  writeFileSync(join(work, "build", "out.txt"), "build output\n");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: work });
  return { agent, work };
}

function launchSpec(agent) {
  const result = spawnSync("pwsh", ["-NoProfile", "-File", join(ROOT, "bin", "coop.ps1"), "launch-spec", "--json"], {
    encoding: "utf8", env: { ...process.env, COOP_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent },
  });
  if (result.status !== 0) throw new Error(`coop launch-spec failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

// --- Drive Pi ------------------------------------------------------------------
// Dialog answers, in order: cancel the /start menu, pick the first layout,
// decline the guardrails' `rm -rf` approval.
const ANSWERS = [{ cancelled: true }, { pick: 0 }, { confirmed: false }];

async function record() {
  const model = await startModel();
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "coop-fixture-")));
  const port = model.address().port;
  const { agent, work } = prepare(temp, port);
  const spec = launchSpec(agent);
  const entry = piEntry();
  const child = spawn(process.execPath, [entry, "--mode", "rpc", ...spec.args], {
    cwd: work, env: { ...process.env, ...spec.env, PI_CODING_AGENT_DIR: agent, COOP_DESKTOP: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const log = [];
  const waiters = [];
  let answered = 0;
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const send = (msg) => { log.push({ dir: "in", msg }); child.stdin.write(encodeLine(msg)); };
  const splitter = new JsonlSplitter((line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    log.push({ dir: "out", msg });
    for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.done(msg); }
    if (msg.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(msg.method)) {
      const plan = ANSWERS[answered++] || { cancelled: true };
      const reply = plan.pick !== undefined ? { value: msg.options[plan.pick] } : plan;
      setTimeout(() => send({ type: "extension_ui_response", id: msg.id, ...reply }), 50);
    }
  });
  child.stdout.on("data", (chunk) => splitter.push(chunk));
  const wait = (test, ms = 30_000) => new Promise((ok, fail) => {
    const w = { test, done: ok };
    waiters.push(w);
    setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); fail(new Error("timed out")); } }, ms);
  });
  let seq = 0;
  const call = async (command, { settle = false } = {}) => {
    const id = `f${++seq}`;
    const settled = settle ? wait((m) => m.type === "agent_settled", 60_000) : null;
    send({ id, ...command });
    await wait((m) => m.type === "response" && m.id === id, 60_000);
    if (settled) await settled;
  };
  await new Promise((ok) => setTimeout(ok, 4000));
  await call({ type: "get_state" });
  await call({ type: "get_commands" });
  await call({ type: "get_available_models" });
  await call({ type: "prompt", message: "/start" });
  await call({ type: "prompt", message: "Tidy report.sql and clear the build folder" }, { settle: true });
  await call({ type: "get_messages" });
  await call({ type: "get_session_stats" });
  await call({ type: "bash", command: "echo hello from coop" });
  await call({ type: "set_session_name", name: "Desktop fixture" });
  await call({ type: "compact", customInstructions: "Keep the layout decision" });
  await call({ type: "get_messages" });
  await call({ type: "get_tree" });
  child.stdin.end();
  await new Promise((ok) => { child.once("exit", ok); setTimeout(() => { child.kill(); ok(); }, 5000); });
  model.close();
  const text = normalize(log.map((entry) => JSON.stringify(trim(entry))).join("\n"), { temp, agent, work, pi: resolve(dirname(entry), "..", ".."), port });
  writeFileSync(OUT, `${text}\n`);
  rmSync(temp, { recursive: true, force: true });
  console.log(`record-fixture: wrote ${log.length} lines to ${OUT}`);
  const surfaceFile = join(dirname(OUT), "desktop-pi-surface.json");
  writeFileSync(surfaceFile, `${JSON.stringify(piSurface(resolve(dirname(entry), "..", "..")), null, 2)}\n`);
  console.log(`record-fixture: wrote ${surfaceFile}`);
  if (stderr.trim()) console.log(`Pi stderr:\n${stderr.slice(0, 2000)}`);
}

// Pi's own slash commands and keybinding actions, from the docs its package
// ships: the parity test checks the window's lists against them, so a Pi
// upgrade that adds either fails until desktop/PARITY.md maps it.
function piSurface(piDir) {
  const doc = (name) => readFileSync(join(piDir, "docs", name), "utf8");
  const column = (text, pattern) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].sort();
  return {
    pi: JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version,
    slashCommands: column(doc("slash-commands.md"), /^\| `\/([a-z][a-z-]*)/gm),
    keybindings: column(doc("keybindings.md"), /^\| `((?:app|tui)\.[A-Za-z.]+)`/gm),
  };
}

// Keep the fixture reviewable: long strings (the system prompt, the standards
// articles) keep their start, and the model list keeps the fixture's model and
// three others. Shapes are unchanged.
const MAX_STRING = 600;
function trim(value, key = "") {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, 400)}…[${value.length - 400} characters trimmed for the fixture]` : value;
  }
  // The window never shows system messages: keep their keys and tool names.
  if (value && value.role === "system") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "sections") out[k] = Object.fromEntries(Object.keys(v || {}).map((name) => [name, "…"]));
      else if (k === "toolsAdded") out[k] = (v || []).map((tool) => ({ name: tool && tool.name }));
      else out[k] = trim(v, k);
    }
    return out;
  }
  if (Array.isArray(value)) {
    const items = key === "models" && value.length > 4
      ? [...value.filter((m) => m && m.provider === "fixture"), ...value.filter((m) => !m || m.provider !== "fixture").slice(0, 3)]
      : value;
    return items.map((item) => trim(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, k)]));
  }
  return value;
}

// JSON-escaped forms of each path, longest first, so <work> wins over <temp>.
// Pi names a folder's session directory after the folder ("--tmp-x-work--"),
// and the scripted model's port changes per run: both get placeholders too.
function normalize(text, { agent, work, temp, pi, port }) {
  const pairs = [[work, "<work>"], [agent, "<agent>"], [pi, "<pi>"], [ROOT, "<coop>"], [temp, "<temp>"], [homedir(), "<home>"]];
  let out = text
    .split(`--${work.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`).join("--<work>--")
    .split(`127.0.0.1:${port}`).join("127.0.0.1:<port>");
  for (const [path, label] of pairs) {
    for (const form of new Set([path, path.replace(/\\/g, "/")])) {
      const escaped = JSON.stringify(form).slice(1, -1);
      out = out.split(escaped).join(label);
    }
  }
  return out;
}

if (!existsSync(join(ROOT, "bin", "coop.ps1"))) throw new Error("run from a coop-agent checkout");
await record();
