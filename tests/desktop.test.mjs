/**
 * The coop window (master plan D1b): its pure modules, a replay of the recorded
 * Pi RPC session (tests/fixtures/desktop-rpc.jsonl, coop's real launch
 * arguments and release extensions), and the terminal parity checklist
 * (desktop/PARITY.md) against the window's lists and Pi's own.
 *
 * Gate lane: no Electron, no Pi, no network, no child processes.
 * Re-record the fixture with: node desktop/scripts/record-fixture.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { JsonlSplitter, encodeLine } from "../desktop/lib/jsonl.mjs";
import { SpecError, parseSpec, piArgv, piEnv } from "../desktop/lib/spec.mjs";
import { CommandError, IMAGE_LIMITS, buildCommand, buildUiResponse } from "../desktop/lib/rpc-commands.mjs";
import { CSP, isAppUrl, resolveAsset } from "../desktop/lib/serve.mjs";
import { THEMES, loadSettings, saveSettings } from "../desktop/lib/settings.mjs";
import { isSessionPath, listSessions, sessionFolderName } from "../desktop/lib/sessions.mjs";
import { readBranch } from "../desktop/lib/git.mjs";
import { consoleProcess } from "../desktop/lib/terminal.mjs";
import { listFiles, rankFiles } from "../desktop/lib/files.mjs";
import { PiSession, endLeftovers, killTree } from "../desktop/lib/pi-session.mjs";
import { BUILTINS, KEYS, TERMINAL_ONLY, completions, parseInput } from "../desktop/renderer/commands.mjs";
import { activitySummary, applyEvent, createTimeline, finishBash, loadMessages, startBash, toolSummary, turnOf, turns } from "../desktop/renderer/timeline.mjs";
import { isSafeLink, parseMarkdown } from "../desktop/renderer/markdown.mjs";
import { diffStats, parseEditDiff } from "../desktop/renderer/diff.mjs";
import { matchOffsets } from "../desktop/renderer/find.mjs";
import { widgetView } from "../desktop/renderer/widgets.mjs";
import { COLLAPSE_KEY, MAX_ROWS, applyTodoResult, createTodos, startTurn, todoLines, todosFromMessages } from "../desktop/renderer/todos.mjs";
import { lockProblems, runtimePackageJson } from "../desktop/scripts/runtime-lock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(join(ROOT, "tests", "fixtures", "desktop-rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const SURFACE = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "desktop-pi-surface.json"), "utf8"));
// A Windows checkout may turn the Markdown into CRLF.
const PARITY = readFileSync(join(ROOT, "desktop", "PARITY.md"), "utf8").replace(/\r\n/g, "\n");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${String(error && error.stack || error).split("\n").slice(0, 6).join("\n    ")}`);
    failed += 1;
  }
}

const temp = mkdtempSync(join(tmpdir(), "coop-desktop-test-"));
const out = (predicate) => FIXTURE.filter((line) => line.dir === "out" && predicate(line.msg)).map((line) => line.msg);
const response = (command) => out((m) => m.type === "response" && m.command === command);

// --- JSONL --------------------------------------------------------------------

await check("JSONL: splits on LF only, keeps U+2028 inside strings, strips CR", () => {
  const lines = [];
  const splitter = new JsonlSplitter((line) => lines.push(line));
  splitter.push(Buffer.from(`${JSON.stringify({ text: "a\u2028b\u2029c" })}\r\n{"x":`));
  splitter.push(Buffer.from('1}\n'));
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ text: "a\u2028b\u2029c" }, { x: 1 }]);
});

await check("JSONL: a chunk that ends inside a UTF-8 character", () => {
  const lines = [];
  const splitter = new JsonlSplitter((line) => lines.push(line));
  const bytes = Buffer.from(`${JSON.stringify({ t: "Welcome to coop 👋" })}\n`);
  const cut = bytes.indexOf(0xf0) + 2;
  splitter.push(bytes.subarray(0, cut));
  splitter.push(bytes.subarray(cut));
  assert.equal(JSON.parse(lines[0]).t, "Welcome to coop 👋");
});

await check("JSONL: flush emits a last unterminated line; oversized lines throw", () => {
  const lines = [];
  const splitter = new JsonlSplitter((line) => lines.push(line), { maxLine: 16 });
  splitter.push('{"a":1}');
  splitter.flush();
  assert.deepEqual(lines, ['{"a":1}']);
  assert.throws(() => splitter.push("x".repeat(40)), /longer than the desktop accepts/);
  assert.equal(encodeLine({ a: 1 }), '{"a":1}\n');
});

// --- Launch spec --------------------------------------------------------------

const goodSpec = {
  schema: 1, version: "0.27.0", node: "C:\\Program Files\\nodejs\\node.exe",
  entry: "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js",
  cwd: "C:\\work\\repo", coop: "C:\\Users\\a\\.coop\\coop-agent\\bin\\coop.ps1",
  args: ["--no-extensions", "-e", "C:\\x\\extensions\\coop-tools"], env: { PI_CODING_AGENT_DIR: "C:\\Users\\a\\.coop\\agent", COOP_FIRST_RUN: "1" },
  loginPresent: false, notices: ["Azure sign-in expired", 7, "  ", "x".repeat(900)],
};

await check("spec: a coop desktop spec parses, notices are cleaned", () => {
  const spec = parseSpec(JSON.stringify(goodSpec));
  assert.equal(spec.cwd, goodSpec.cwd);
  assert.deepEqual(spec.args, goodSpec.args);
  assert.equal(spec.loginPresent, false);
  assert.deepEqual(spec.notices, ["Azure sign-in expired", "x".repeat(500)]);
  assert.equal(parseSpec(JSON.stringify({ ...goodSpec, loginPresent: undefined, notices: undefined })).loginPresent, true);
});

await check("spec: refuses a missing, foreign or unsafe spec", () => {
  const bad = [
    "", "{", JSON.stringify({ ...goodSpec, schema: 2 }),
    JSON.stringify({ ...goodSpec, node: "node" }),
    JSON.stringify({ ...goodSpec, cwd: "C:\\work\nrepo" }),
    JSON.stringify({ ...goodSpec, args: ["--mode", "json"] }),
    JSON.stringify({ ...goodSpec, args: ["--mode=json"] }),
    JSON.stringify({ ...goodSpec, args: ["-p"] }),
    JSON.stringify({ ...goodSpec, args: [7] }),
    JSON.stringify({ ...goodSpec, env: { PATH: "C:\\evil" } }),
    JSON.stringify({ ...goodSpec, env: { NODE_OPTIONS: "--require x" } }),
    JSON.stringify({ ...goodSpec, env: { COOP_X: "a\u0000b" } }),
  ];
  for (const raw of bad) assert.throws(() => parseSpec(raw), SpecError, raw.slice(0, 60));
});

await check("spec: Pi runs as node <entry> --mode rpc <coop's args>, with coop's env", () => {
  const spec = parseSpec(JSON.stringify(goodSpec));
  assert.deepEqual(piArgv(spec), { command: goodSpec.node, args: [goodSpec.entry, "--mode", "rpc", ...goodSpec.args] });
  const env = piEnv(spec, { PATH: "p", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--x", COOP_DESKTOP_SPEC: "{}", COOP_FABRIC_MCP_TOKEN: "old" });
  assert.deepEqual(env, { PATH: "p", PI_CODING_AGENT_DIR: goodSpec.env.PI_CODING_AGENT_DIR, COOP_FIRST_RUN: "1", COOP_DESKTOP: "1" });
  assert.equal(piEnv(spec, {}, { fabricToken: "t" }).COOP_FABRIC_MCP_TOKEN, "t");
  assert.ok(!goodSpec.args.includes("-a") && !goodSpec.args.includes("--approve"));
});

// --- RPC commands and dialog answers -------------------------------------------

await check("rpc: every command the recorded session sent passes the allowlist unchanged", () => {
  const sent = FIXTURE.filter((l) => l.dir === "in" && l.msg.type !== "extension_ui_response").map((l) => l.msg);
  assert.ok(sent.length >= 10);
  for (const { id, ...command } of sent) assert.deepEqual(buildCommand(command), command, command.type);
});

await check("rpc: renderer input is rebuilt field by field", () => {
  assert.deepEqual(buildCommand({ type: "prompt", message: "hi", sessionPath: "/x", id: "z" }), { type: "prompt", message: "hi" });
  assert.deepEqual(buildCommand({ type: "get_state", extra: 1 }), { type: "get_state" });
  assert.deepEqual(buildCommand({ type: "bash", command: "ls", excludeFromContext: true }), { type: "bash", command: "ls", excludeFromContext: true });
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  assert.deepEqual(buildCommand({ type: "steer", message: "m", images: [{ ...image, url: "http://x" }] }).images, [image]);
  const refused = [
    { type: "switch_session", sessionPath: "/x.jsonl" }, { type: "export_html", outputPath: "/x" }, { type: "get_entries" },
    { type: "prompt", message: "  " }, { type: "prompt", message: "a\u0000" }, { type: "prompt", message: "m", streamingBehavior: "now" },
    { type: "set_thinking_level", level: "huge" }, { type: "fork", entryId: "../x" }, { type: "set_auto_retry", enabled: "yes" },
    { type: "prompt", message: "m", images: [{ ...image, mimeType: "image/svg+xml" }] },
    { type: "prompt", message: "m", images: Array(IMAGE_LIMITS.maxImages + 1).fill(image) },
    null,
  ];
  for (const input of refused) assert.throws(() => buildCommand(input), CommandError, JSON.stringify(input));
});

await check("rpc: the recorded dialog answers rebuild from their requests", () => {
  const dialogs = out((m) => m.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(m.method));
  const answers = FIXTURE.filter((l) => l.dir === "in" && l.msg.type === "extension_ui_response").map((l) => l.msg);
  assert.equal(dialogs.length, 3);
  const window = [{ cancelled: true }, { value: dialogs[1].options[0] }, { confirmed: false }];
  dialogs.forEach((request, i) => assert.deepEqual(buildUiResponse(request, window[i]), answers[i]));
  assert.throws(() => buildUiResponse(dialogs[1], { value: "not offered" }), CommandError);
  assert.throws(() => buildUiResponse({ id: "n", method: "notify" }, { value: "x" }), CommandError);
  assert.deepEqual(buildUiResponse({ id: "i", method: "input" }, { value: "" }), { type: "extension_ui_response", id: "i", value: "" });
});

// --- Replaying the recorded session ---------------------------------------------

// Every event and extension request Pi sent while recording is one the window
// handles (or ignores on purpose). A Pi upgrade that adds one fails here.
const KNOWN_EVENTS = new Set([
  "response", "extension_ui_request", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "queue_update", "session_info_changed", "thinking_level_changed", "compaction_start", "compaction_end",
  "auto_retry_start", "auto_retry_end", "extension_error", "bash_execution_update",
]);
const UI_METHODS = new Set(["select", "confirm", "input", "editor", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

await check("replay: every recorded event type and extension request is one the window knows", () => {
  for (const msg of out(() => true)) {
    assert.ok(KNOWN_EVENTS.has(msg.type), `event ${msg.type}`);
    if (msg.type === "extension_ui_request") assert.ok(UI_METHODS.has(msg.method), `extension request ${msg.method}`);
  }
  const app = readFileSync(join(ROOT, "desktop", "renderer", "app.mjs"), "utf8");
  const main = readFileSync(join(ROOT, "desktop", "main.mjs"), "utf8");
  for (const method of UI_METHODS) assert.ok(app.includes(`"${method}"`) || main.includes(`"${method}"`), `no handler names ${method}`);
});

function replay() {
  const tl = createTimeline();
  const bash = new Map();
  for (const { dir, msg } of FIXTURE) {
    if (dir === "in" && msg.type === "bash") bash.set(msg.id, startBash(tl, msg.command, false));
    else if (dir === "out" && msg.type === "response" && bash.has(msg.id)) finishBash(tl, bash.get(msg.id), msg.data);
    else if (dir === "out" && msg.type !== "response" && msg.type !== "extension_ui_request") applyEvent(tl, msg);
  }
  return tl;
}

function shape(tl) {
  const kinds = tl.items.filter((item) => ["user", "assistant", "standards"].includes(item.kind)).map((item) => item.kind);
  const tools = [...tl.tools.values()].map((tool) => `${tool.name}:${tool.status}`);
  return { kinds, tools };
}

await check("replay: the live events build the conversation the terminal shows", () => {
  const tl = replay();
  const { kinds, tools } = shape(tl);
  assert.deepEqual(kinds, ["user", "standards", "assistant", "assistant", "assistant", "assistant", "assistant"]);
  assert.deepEqual(tools, ["ask_user_question:done", "todo:done", "edit:done", "todo:done", "bash:error"]);
  assert.equal(tl.items.find((i) => i.kind === "user").text, "Tidy report.sql and clear the build folder");
  const answers = tl.items.filter((i) => i.kind === "assistant");
  assert.ok(answers.every((item) => !item.streaming));
  assert.ok(answers[0].blocks.some((b) => b.type === "thinking" && b.text.includes("Ask which layout first")));
  assert.match(answers[4].blocks.find((b) => b.type === "text").text, /\| Object \| Change \|/);
  const bashTool = [...tl.tools.values()].find((t) => t.name === "bash");
  assert.match(bashTool.result.text, /blocked the rm -rf command \(you declined\)/);
  assert.equal(toolSummary("bash", bashTool.args), "rm -rf build");
  assert.equal(tl.busy, false);
  assert.equal(tl.sessionName, "Desktop fixture");
  assert.equal(tl.current, null);
});

await check("replay: the edit's diff, the shell command and the compaction notice", () => {
  const tl = replay();
  const edit = [...tl.tools.values()].find((t) => t.name === "edit");
  const rows = parseEditDiff(edit.result.details.diff);
  assert.deepEqual(diffStats(rows), { added: 4, removed: 1 });
  assert.deepEqual(rows[0], { kind: "del", line: "1", text: "select id,name from customers" });
  const shell = tl.items.find((i) => i.kind === "bash");
  assert.equal(shell.output, "hello from coop\n");
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.running, false);
  const compacted = tl.items.filter((i) => i.kind === "notice");
  assert.equal(compacted.length, 1);
  assert.match(compacted[0].text, /^Compacted the conversation: about \dk tokens down to \d+k\.$/);
});

await check("replay: a saved conversation (get_messages) loads the same as the live one", () => {
  const [before, after] = response("get_messages");
  const live = shape(replay());
  const saved = loadMessages(createTimeline(), before.data.messages);
  assert.deepEqual(shape(saved), live);
  const compacted = loadMessages(createTimeline(), after.data.messages);
  assert.deepEqual(compacted.items.map((i) => i.kind), ["compaction", "bash"]);
  assert.match(compacted.items[0].summary, /^## Goal/);
});

await check("replay: the session tree carries the compaction and the prompt", () => {
  const [tree] = response("get_tree");
  const types = [];
  const walk = (nodes) => { for (const node of nodes) { types.push(node.entry.message ? node.entry.message.role : node.entry.type); walk(node.children || []); } };
  walk(tree.data.tree);
  assert.ok(types.includes("user") && types.includes("compaction"), types.join(","));
  assert.equal(typeof tree.data.leafId, "string");
});

await check("replay: the final answer renders as Markdown, links are checked", () => {
  const text = out((m) => m.type === "message_end" && m.message.role === "assistant").pop().message.content.find((b) => b.type === "text").text;
  const blocks = parseMarkdown(text).map((b) => b.type);
  assert.deepEqual(blocks, ["paragraph", "list", "table", "code"]);
  assert.ok(isSafeLink("https://learn.microsoft.com/x"));
  for (const href of ["javascript:alert(1)", "file:///C:/x", "data:text/html,x", "vbscript:x"]) assert.ok(!isSafeLink(href), href);
});

// --- Composer ------------------------------------------------------------------

await check("composer: shell prefixes, built-ins, terminal-only and prompts", () => {
  assert.deepEqual(parseInput("!ls -la"), { kind: "bash", command: "ls -la", excluded: false });
  assert.deepEqual(parseInput("!!git status"), { kind: "bash", command: "git status", excluded: true });
  assert.equal(parseInput("/tree").command.action, "tree");
  assert.equal(parseInput("/compact keep the plan").arg, "keep the plan");
  assert.equal(parseInput("/mcp-auth fabric").command.action, "terminal");
  assert.deepEqual(parseInput("/start"), { kind: "prompt", text: "/start" });
  assert.deepEqual(parseInput("/skill:coop-workflow do x"), { kind: "prompt", text: "/skill:coop-workflow do x" });
  assert.deepEqual(parseInput("why is /tree slow"), { kind: "prompt", text: "why is /tree slow" });
});

await check("composer: / completion lists built-ins, then Pi's commands from the recording", () => {
  const [commands] = response("get_commands");
  const list = commands.data.commands;
  assert.deepEqual(completions("/tr", list).map((c) => c.name).slice(0, 1), ["tree"]);
  const memory = completions("/memory-sk", list);
  assert.equal(memory[0].name, "memory-skills");
  assert.match(memory[0].description, /\(opens the terminal\)$/);
  assert.ok(completions("/", list, { limit: 500 }).length >= BUILTINS.length + list.length - 1);
  assert.deepEqual(completions("tree", list), []);
});

await check("composer: @ file ranking", () => {
  const paths = ["build/", "build/out.txt", "docs/", "docs/report-notes.md", "report.sql", "src/", "src/reports/", "src/reports/daily.sql"];
  assert.deepEqual(rankFiles(paths, "rep").slice(0, 3), ["report.sql", "src/reports/", "docs/report-notes.md"]);
  assert.deepEqual(rankFiles(paths, ""), ["build/", "docs/", "src/", "report.sql"]);
  assert.deepEqual(rankFiles(paths, "bout"), ["build/out.txt"]);
  // A finished mention offers only other matches (here a fuzzy one).
  assert.deepEqual(rankFiles(paths, "report.sql"), ["src/reports/daily.sql"]);
  assert.deepEqual(rankFiles(paths, '"rep').slice(0, 1), ["report.sql"]);
  assert.deepEqual(rankFiles(paths, "zzz"), []);
});

await check("composer: @ file list from git, or a walk that skips .git and node_modules", async () => {
  const fromGit = await listFiles("/x", { execFileImpl: (cmd, args, opts, done) => done(null, "a/b/c.txt\0d.txt\0") });
  assert.deepEqual(fromGit, ["a/", "a/b/", "a/b/c.txt", "d.txt"]);
  const dir = join(temp, "walk");
  for (const sub of [".git", "node_modules/pkg", "src"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "x");
  writeFileSync(join(dir, "node_modules", "pkg", "i.js"), "x");
  writeFileSync(join(dir, "src", "a.sql"), "x");
  writeFileSync(join(dir, "top.md"), "x");
  const walked = await listFiles(dir, { execFileImpl: (cmd, args, opts, done) => done(new Error("not a repo")) });
  assert.deepEqual(walked.sort(), ["src/", "src/a.sql", "top.md"]);
});

await check("find: case-insensitive, non-overlapping match offsets", () => {
  assert.deepEqual(matchOffsets("Report report REPORT", "report"), [0, 7, 14]);
  assert.deepEqual(matchOffsets("aaaa", "aa"), [0, 2]);
  assert.deepEqual(matchOffsets("abc", ""), []);
});

// --- Main process helpers --------------------------------------------------------

await check("serve: only renderer files over coop://app, under a strict CSP", () => {
  const root = join(ROOT, "desktop", "renderer");
  assert.equal(resolveAsset(root, "coop://app/").file, join(root, "index.html"));
  assert.equal(resolveAsset(root, "coop://app/styles/app.css").type, "text/css; charset=utf-8");
  // URL parsing folds "../" away; whatever it leaves never leaves the renderer folder.
  for (const url of ["coop://app/../main.mjs", "coop://app/%2e%2e/main.mjs"]) {
    const asset = resolveAsset(root, url);
    assert.ok(!asset || asset.file.startsWith(join(root, "x").slice(0, -1)), url);
  }
  for (const url of ["coop://app/..%5Cmain.mjs", "coop://app/%2e%2e%2fmain.mjs", "coop://other/index.html",
    "file:///etc/passwd", "coop://app/.hidden.css", "coop://app/readme.txt", "coop://app/%00.html"]) {
    assert.equal(resolveAsset(root, url), null, url);
  }
  assert.ok(!/unsafe-(inline|eval)/.test(CSP) && /default-src 'none'/.test(CSP) && /connect-src 'none'/.test(CSP));
  assert.ok(isAppUrl("coop://app/index.html") && !isAppUrl("coop://application/x") && !isAppUrl("https://example.com"));
});

await check("serve: the page loads only its own files, with no inline script or style", () => {
  const html = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3);
  for (const ref of refs) assert.ok(resolveAsset(join(ROOT, "desktop", "renderer"), `coop://app/${ref}`), ref);
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html) && !/\sstyle=/.test(html) && !/\son[a-z]+=/.test(html));
  for (const file of ["app.mjs", "view.mjs", "ui.mjs", "markdown.mjs", "find.mjs"]) {
    const code = readFileSync(join(ROOT, "desktop", "renderer", file), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|new Function|\beval\(/.test(code), file);
  }
});

await check("settings: unknown values fall back, the four themes and auto are kept", () => {
  assert.deepEqual(THEMES, ["auto", "modern-dark", "modern-light", "retro-dark", "retro-light"]);
  const file = join(temp, "settings", "window.json");
  assert.equal(loadSettings(file).theme, "auto");
  assert.deepEqual(saveSettings(file, { theme: "retro-light", width: 99999, height: 900, maximized: "yes", extra: 1 }), { theme: "retro-light", width: 1280, height: 900, maximized: false, lastFolder: "" });
  assert.equal(loadSettings(file).theme, "retro-light");
  writeFileSync(file, "{not json");
  assert.equal(loadSettings(file).theme, "auto");
});

await check("sessions: Pi's folder naming, listing and the switch guard", () => {
  assert.equal(sessionFolderName("/tmp/x/work"), "--tmp-x-work--");
  assert.equal(sessionFolderName("C:\\Users\\a\\repo"), "--C--Users-a-repo--");
  const agent = join(temp, "agent");
  const cwd = join(temp, "repo");
  const folder = join(agent, "sessions", sessionFolderName(cwd));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "2026-10-02T00-00-00-000Z_abc.jsonl");
  writeFileSync(file, [
    { type: "session", id: "abc", cwd, timestamp: "2026-10-02T00:00:00.000Z" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Tidy report.sql\nmore" }] } },
    { type: "session_info", name: "Desktop fixture" },
  ].map((e) => JSON.stringify(e)).join("\n"));
  writeFileSync(join(folder, "not-a-session.jsonl"), '{"type":"message"}\n');
  const env = { PI_CODING_AGENT_DIR: agent };
  const listed = listSessions(env, cwd);
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0].title, listed[0].name, listed[0].messages], ["Tidy report.sql", "Desktop fixture", 1]);
  assert.ok(isSessionPath(env, file));
  const outside = join(temp, "outside.jsonl");
  writeFileSync(outside, "{}");
  assert.ok(!isSessionPath(env, outside));
  assert.ok(!isSessionPath(env, join(folder, "..", "..", "..", "outside.jsonl")));
  assert.ok(!isSessionPath(env, "relative.jsonl"));
  assert.ok(!isSessionPath({}, file));
  try {
    symlinkSync(outside, join(folder, "link.jsonl"));
    assert.ok(!isSessionPath(env, join(folder, "link.jsonl")));
  } catch (error) {
    if (error.code !== "EPERM") throw error; // Windows without symlink rights
  }
});

await check("git: the branch, a detached commit and a worktree", () => {
  const repo = join(temp, "git", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/d1b/desktop\n");
  assert.equal(readBranch(join(repo, "sub")), "d1b/desktop");
  writeFileSync(join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(readBranch(repo), "0123456");
  const tree = join(temp, "git", "tree");
  mkdirSync(join(temp, "git", "meta"), { recursive: true });
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(temp, "git", "meta", "HEAD"), "ref: refs/heads/feature\n");
  writeFileSync(join(tree, ".git"), "gitdir: ../meta\n");
  assert.equal(readBranch(tree), "feature");
});

await check("terminal: Open in terminal passes paths only through the environment", () => {
  const proc = consoleProcess({ coop: "C:\\Users\\O'Neil\\.coop\\coop-agent\\bin\\coop.ps1", cwd: "C:\\work\\a b", session: "C:\\Users\\O'Neil\\.coop\\agent\\sessions\\x.jsonl", env: { PATH: "p" }, systemRoot: "C:\\Windows" });
  assert.equal(proc.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const outer = Buffer.from(proc.args[proc.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  const inner = Buffer.from(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)[1], "base64").toString("utf16le");
  assert.ok(!outer.includes("O'Neil") && !inner.includes("O'Neil") && !inner.includes("a b"));
  assert.match(inner, /--session \$env:COOP_TERMINAL_SESSION/);
  assert.equal(proc.options.env.COOP_TERMINAL_CWD, "C:\\work\\a b");
  assert.equal(proc.options.shell, false);
  assert.throws(() => consoleProcess({ coop: "coop.ps1", cwd: "C:\\w", env: {}, systemRoot: "C:\\Windows" }));
  assert.throws(() => consoleProcess({ mode: "cmd", coop: "C:\\c.ps1", cwd: "C:\\w", env: {}, systemRoot: "C:\\Windows" }));
});

await check("pi-session: requests correlate by id, dialogs wait for an answer", async () => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242 });
  const written = [];
  child.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) written.push(JSON.parse(line)); });
  let spawned;
  const pi = new PiSession({ command: "node", args: ["cli.js", "--mode", "rpc"], cwd: "/w", env: {}, platform: "linux", spawnImpl: (cmd, args, opts) => { spawned = { cmd, args, opts }; return child; } });
  pi.start();
  assert.equal(spawned.opts.shell, false);
  assert.equal(spawned.opts.detached, true);
  const events = [];
  pi.on("event", (e) => events.push(e));
  const pending = pi.request({ type: "get_state" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written[0], { type: "get_state", id: "d1" });
  child.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "q1", method: "confirm", title: "coop guardrails" })}\n`);
  child.stdout.write(`${JSON.stringify({ id: "d1", type: "response", command: "get_state", success: true, data: { ok: 1 } })}\n`);
  assert.deepEqual((await pending).data, { ok: 1 });
  assert.equal(pi.openDialogs().length, 1);
  assert.ok(pi.answer({ type: "extension_ui_response", id: "q1", confirmed: true }));
  assert.ok(!pi.answer({ type: "extension_ui_response", id: "q1", confirmed: true }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written[1], { type: "extension_ui_response", id: "q1", confirmed: true });
  assert.deepEqual(events.map((e) => e.type), ["extension_ui_request"]);
  const orphan = pi.request({ type: "get_tree" });
  child.emit("exit", 1, null);
  await assert.rejects(orphan, /Pi exited/);
  await assert.rejects(pi.request({ type: "get_state" }), /not running/);
});

await check("pi-session: killTree ends the whole tree (taskkill /T on Windows)", () => {
  const calls = [];
  killTree(123, "win32", { execFileImpl: (file, args) => calls.push([file, args]), systemRoot: "C:\\Windows" });
  assert.deepEqual(calls, [["C:\\Windows\\System32\\taskkill.exe", ["/PID", "123", "/T", "/F"]]]);
  killTree(0, "win32", { execFileImpl: (file, args) => calls.push([file, args]), systemRoot: "C:\\Windows" });
  killTree(5, "win32", { execFileImpl: (file, args) => calls.push([file, args]), systemRoot: "Windows" });
  assert.equal(calls.length, 1);
});

await check("pi-session: on Windows, what a dead Pi left is found by its id and start time", async () => {
  let call;
  await endLeftovers(4242, "win32", 1_790_000_000_000, { execFileImpl: (file, args, options, done) => { call = { file, args, options }; done(null); }, systemRoot: "C:\\Windows", env: { PATH: "p" } });
  assert.equal(call.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(call.options.env, { PATH: "p", COOP_PI_PID: "4242", COOP_PI_STARTED: "1790000000000" });
  const script = Buffer.from(call.args[call.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  assert.ok(!script.includes("4242") && /ParentProcessId/.test(script) && /CreationDate/.test(script) && /Stop-Process/.test(script));
  call = undefined;
  await endLeftovers(4242, "win32", 0, { execFileImpl: () => { call = 1; }, systemRoot: "C:\\Windows" });
  assert.equal(call, undefined, "no start time, no cleanup");
});

// --- Runtime pin ---------------------------------------------------------------

await check("runtime: config/desktop-lock.json matches the manifest's Electron and pdf.js pins", () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "config", "desktop-lock.json"), "utf8"));
  assert.match(MANIFEST.desktop.electron, /^\d+\.\d+\.\d+$/);
  assert.match(MANIFEST.desktop.pdfjs, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(runtimePackageJson(MANIFEST).dependencies, { electron: MANIFEST.desktop.electron, "pdfjs-dist": MANIFEST.desktop.pdfjs });
  assert.deepEqual(lockProblems(MANIFEST, lock), []);
  const drifted = { ...MANIFEST, desktop: { electron: "1.0.0", pdfjs: MANIFEST.desktop.pdfjs } };
  assert.equal(lockProblems(drifted, lock).length, 2);
  assert.match(lockProblems({ ...MANIFEST, desktop: { electron: MANIFEST.desktop.electron, pdfjs: "1.0.0" } }, lock).join("\n"), /node_modules\/pdfjs-dist is 6\.\d+\.\d+, the manifest pins 1\.0\.0/);
  assert.throws(() => runtimePackageJson({ ...MANIFEST, desktop: { electron: "44.0.0" } }), /no desktop\.pdfjs/);
  // pdf.js's canvas is optional in the lock (rendering only) and never installed: --omit=optional.
  assert.equal(lock.packages["node_modules/@napi-rs/canvas"].optional, true);
  assert.match(readFileSync(join(ROOT, "lib", "common.ps1"), "utf8"), /npm ci --ignore-scripts --omit=optional/);
  const tampered = structuredClone(lock);
  tampered.packages["node_modules/electron"].resolved = "https://example.com/electron.tgz";
  assert.match(lockProblems(MANIFEST, tampered).join("\n"), /registry\.npmjs\.org/);
});

await check("activity: one line for a run of tool calls, the live step while one runs", () => {
  const tools = new Map([
    ["t1", { name: "read", args: { path: "sql/vSales.sql" }, status: "done" }],
    ["t2", { name: "bash", args: { command: "git status\n" }, status: "done" }],
    ["t3", { name: "edit", args: { path: "C:\\work\\report.sql" }, status: "error" }],
    ["t4", { name: "data_doc", args: {}, status: "running" }],
  ]);
  const block = (id, name) => ({ type: "tool", toolCallId: id, name });
  assert.equal(activitySummary([block("t1", "read")], tools), "Read vSales.sql");
  assert.equal(activitySummary([{ type: "thinking", text: "hmm" }, block("t1", "read"), block("t2", "bash"), block("t3", "edit")], tools), "Read vSales.sql, ran git status, edited report.sql (1 step failed)");
  assert.equal(activitySummary([block("t1", "read"), block("t1", "read"), block("t2", "bash"), block("t2", "bash"), block("t2", "bash")], tools), "Read 2 files, ran 3 commands");
  assert.equal(activitySummary([{ type: "thinking", text: "hmm" }], tools), "Thought it through");
  assert.equal(activitySummary([{ type: "tool", toolCallId: "", name: "grep" }, { type: "tool", toolCallId: "", name: "ls" }], tools), "Searched 2 times");
  assert.equal(activitySummary([block("t4", "data_doc")], tools, { live: true }), "Using data_doc...");
  assert.equal(activitySummary([block("t1", "read"), { type: "thinking", text: "" }], tools, { live: true }), "Thinking...");
  assert.equal(activitySummary([block("t4", "data_doc")], tools, { live: false }), "Used data_doc");
  assert.equal(activitySummary([{ type: "tool", toolCallId: "x", name: "bash" }], new Map([["x", { status: "running", args: { command: "pwsh -File build.ps1" } }]]), { live: true }), "Running pwsh -File build.ps1...");
});

await check("turns: consecutive assistant messages are one turn, anything else breaks it", () => {
  const items = [
    { id: "u1", kind: "user" }, { id: "a1", kind: "assistant" }, { id: "a2", kind: "assistant" }, { id: "a3", kind: "assistant" },
    { id: "u2", kind: "user" }, { id: "a4", kind: "assistant" }, { id: "b1", kind: "bash" }, { id: "a5", kind: "assistant" },
  ];
  const ids = (list) => list.map((item) => item.id);
  assert.deepEqual(ids(turnOf(items, "a2")), ["a1", "a2", "a3"]);
  assert.deepEqual(ids(turnOf(items, "a1")), ["a1", "a2", "a3"]);
  assert.deepEqual(ids(turnOf(items, "a3")), ["a1", "a2", "a3"]);
  assert.deepEqual(ids(turnOf(items, "a4")), ["a4"]);
  assert.deepEqual(ids(turnOf(items, "u2")), ["u2"]);
  assert.deepEqual(ids(turnOf(items, "nope")), []);
  assert.deepEqual(turns(items).map(ids), [["u1"], ["a1", "a2", "a3"], ["u2"], ["a4"], ["b1"], ["a5"]]);
  // The recorded session: every turn is one or more assistant items and nothing else.
  const tl = createTimeline();
  for (const line of out((m) => typeof m.type === "string")) applyEvent(tl, line);
  for (const turn of turns(tl.items).filter((t) => t[0].kind === "assistant")) assert.ok(turn.every((item) => item.kind === "assistant") && turnOf(tl.items, turn[0].id).length === turn.length);
});

// --- The todo panel (desktop/renderer/todos.mjs) -------------------------------
// rpiv-todo draws its panel as a TUI component, which Pi's RPC mode drops (the
// recording carries only its setWidget removal), so the window rebuilds the
// panel from the `todo` tool results, live and on load.
await check("todos: the recording carries the todo tool's results, not a widget, and the live events build the panel", () => {
  const widgets = out((m) => m.type === "extension_ui_request" && m.method === "setWidget" && m.widgetKey === "rpiv-todos");
  assert.ok(widgets.every((m) => m.widgetLines === undefined), "RPC now forwards rpiv-todo's panel: render it from setWidget instead");
  const state = createTodos();
  const lines = [];
  for (const { dir, msg } of FIXTURE) {
    if (dir !== "out") continue;
    if (msg.type === "agent_start") startTurn(state);
    if (msg.type === "tool_execution_end" && msg.toolName === "todo" && applyTodoResult(state, msg.result)) lines.push(todoLines(state));
  }
  assert.deepEqual(lines, [
    ["● Todos (0/1)", "└─ ○ Format report.sql"],
    ["○ Todos (1/1)", "└─ ✓ Format report.sql"],
  ]);
  // The completed row leaves the panel when the next turn starts.
  startTurn(state);
  assert.deepEqual(todoLines(state), []);
});

await check("todos: a saved conversation (get_messages) loads the list; after a compaction the same session keeps it", () => {
  const [before, after] = response("get_messages");
  const loaded = todosFromMessages(before.data.messages);
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.tasks.map((t) => [t.id, t.status]), [[1, "completed"]]);
  assert.deepEqual(todoLines(loaded), [], "rows completed in an earlier turn stay out of the way on a resume");
  const compacted = todosFromMessages(after.data.messages);
  assert.equal(compacted.found, false);
  assert.deepEqual(compacted.tasks, []);
  assert.deepEqual(todosFromMessages(undefined).tasks, []);
});

await check("todos: the panel's lines follow the terminal overlay (glyphs, activeForm, dependencies, ids, budget, collapse)", () => {
  const state = createTodos();
  const task = (id, status, extra = {}) => ({ id, subject: `Task ${id}`, status, ...extra });
  applyTodoResult(state, { details: { nextId: 4, tasks: [task(1, "completed"), task(2, "in_progress", { activeForm: "doing two" }), task(3, "pending")] } });
  assert.deepEqual(todoLines(state), ["● Todos (1/3)", "├─ ✓ Task 1", "├─ ◐ Task 2 (doing two)", "└─ ○ Task 3"]);
  assert.deepEqual(todoLines(state, { collapsed: true }), ["● Todos (1/3)", `└─ collapsed, ${COLLAPSE_KEY} expands`]);
  // Ids show only when a dependency points at them; deleted tasks never show.
  applyTodoResult(state, { details: { nextId: 5, tasks: [task(1, "deleted"), task(2, "in_progress"), task(3, "pending", { blockedBy: [2] }), task(4, "pending")] } });
  assert.deepEqual(todoLines(state), ["● Todos (0/3)", "├─ ◐ #2 Task 2", "├─ ○ #3 Task 3 ⛓ #2", "└─ ○ #4 Task 4"]);
  // A result without the snapshot changes nothing; a `clear` resets the hidden set.
  assert.equal(applyTodoResult(state, { details: { error: "nope" } }), false);
  assert.equal(applyTodoResult(state, undefined), false);
  assert.equal(todoLines(state).length, 4);
  // Budget: completed rows drop first, then the tail of the unfinished ones.
  const many = Array.from({ length: 15 }, (_, i) => task(i + 1, i < 5 ? "completed" : "pending"));
  applyTodoResult(state, { details: { nextId: 16, tasks: many } });
  const full = todoLines(state);
  assert.equal(full.length, MAX_ROWS);
  assert.equal(full[0], "○ Todos (5/15)".replace("○", "●"));
  // Eleven body rows, one of them the summary: the ten unfinished rows fill it and every completed row drops.
  assert.equal(full[full.length - 1], "└─ +5 more (5 completed)");
  assert.equal(todoLines(state, { rows: Infinity }).length, 16);
  const unfinished = Array.from({ length: 15 }, (_, i) => task(i + 1, "pending"));
  applyTodoResult(state, { details: { nextId: 16, tasks: unfinished } });
  assert.equal(todoLines(state)[MAX_ROWS - 1], "└─ +5 more (5 pending)");
  assert.equal(COLLAPSE_KEY, "Alt+T");
  assert.match(PARITY, /Alt\+T collapses/);
});

await check("widgets: Alt+T collapses a widget to its heading and a count; a one-line widget stays as it is", () => {
  const panel = { lines: ["● Todos (0/1)", "└─ ○ Format report.sql", ""] };
  assert.deepEqual(widgetView(panel, false), panel.lines);
  assert.deepEqual(widgetView(panel, true), ["● Todos (0/1)", "  … 1 more line (Alt+T expands)"]);
  assert.deepEqual(widgetView({ lines: ["heading", "a", "b", "c"] }, true)[1], "  … 3 more lines (Alt+T expands)");
  assert.deepEqual(widgetView({ lines: ["only a heading"] }, true), ["only a heading"]);
  assert.deepEqual(widgetView({ lines: ["heading", "", " "] }, true), ["heading"]);
  assert.deepEqual(widgetView({}, true), []);
});

// --- Terminal parity (desktop/PARITY.md) -------------------------------------------

function paritySection(heading) {
  const start = PARITY.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `PARITY.md has no "## ${heading}" section`);
  const end = PARITY.indexOf("\n## ", start + 4);
  const rows = new Map();
  for (const line of PARITY.slice(start, end < 0 ? undefined : end).split("\n")) {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    const key = /^`([^`]+)`$/.exec(cells[0] || "");
    if (key) rows.set(key[1], cells.slice(1));
  }
  return rows;
}
const MAPPINGS = new Set(["rpc", "window", "Pi", "terminal", "native"]);

await check("parity: every Pi built-in command has a row and a window action", () => {
  const rows = paritySection("Pi built-in commands");
  const piCommands = new Set(SURFACE.slashCommands);
  for (const name of piCommands) assert.ok(BUILTINS.some((c) => c.name === name) || Object.hasOwn(TERMINAL_ONLY, name), `Pi's /${name} has no window action`);
  for (const command of BUILTINS) {
    assert.ok(piCommands.has(command.name), `/${command.name} is not a Pi ${SURFACE.pi} command`);
    const row = rows.get(`/${command.name}`);
    assert.ok(row, `PARITY.md has no row for /${command.name}`);
    assert.equal(row[0] === "terminal", command.action === "terminal", `/${command.name}: PARITY says ${row[0]}, the window does ${command.action}`);
    assert.ok(row[1].length > 5);
  }
  assert.equal(rows.size, BUILTINS.length, "PARITY.md lists a built-in the window does not have");
});

await check("parity: every Pi keybinding action has a row matching the window's KEYS", () => {
  const rows = paritySection("Keybinding actions");
  assert.deepEqual(Object.keys(KEYS).sort(), [...SURFACE.keybindings].sort(), `KEYS differs from Pi ${SURFACE.pi}'s keybinding actions`);
  for (const [id, key] of Object.entries(KEYS)) {
    const row = rows.get(id);
    assert.ok(row, `PARITY.md has no row for ${id}`);
    assert.ok(MAPPINGS.has(row[0]), `${id}: unknown mapping ${row[0]}`);
    if (key.keys === "native" || key.keys === "terminal") assert.equal(row[0], key.keys, id);
    else assert.notEqual(row[0], "terminal", `${id} has a window key but PARITY says terminal`);
  }
  assert.equal(rows.size, Object.keys(KEYS).length);
});

await check("parity: every extension command in the recording has a row; terminal-only ones open the terminal", () => {
  const rows = paritySection("Extension commands");
  const [commands] = response("get_commands");
  const sources = new Set(commands.data.commands.map((c) => c.source));
  // Prompt templates and skills are covered by the category rule; any other source needs one.
  for (const source of sources) assert.ok(["extension", "prompt", "skill"].includes(source), `new command source ${source}: add a PARITY.md rule`);
  assert.match(PARITY, /## Prompt templates and skills/);
  const extensionCommands = commands.data.commands.filter((c) => c.source === "extension").map((c) => c.name);
  assert.ok(extensionCommands.length >= 30);
  for (const name of extensionCommands) {
    const row = rows.get(`/${name}`);
    assert.ok(row, `PARITY.md has no row for the extension command /${name}`);
    assert.equal(row[1], Object.hasOwn(TERMINAL_ONLY, name) ? "terminal" : "Pi", `/${name}`);
    assert.ok(!BUILTINS.some((c) => c.name === name), `/${name} is shadowed by a window built-in`);
  }
  for (const [name, row] of rows) {
    if (row[1] === "terminal") assert.ok(Object.hasOwn(TERMINAL_ONLY, name.slice(1)), `${name} is terminal in PARITY.md but not in TERMINAL_ONLY`);
  }
  for (const name of Object.keys(TERMINAL_ONLY)) assert.ok(rows.has(`/${name}`), `TERMINAL_ONLY /${name} has no row`);
});

await check("parity: every extension UI request has a row", () => {
  const rows = paritySection("Extension UI");
  for (const method of UI_METHODS) assert.ok(rows.has(method), method);
  for (const [name, row] of rows) assert.ok(MAPPINGS.has(row[0]), `${name}: ${row[0]}`);
});

await check("parity: the recorded launch adds nothing to coop's arguments", () => {
  // The recorder ran Pi with `coop launch-spec --json` plus --mode rpc only.
  assert.ok(!/"--approve"|"-a"/.test(readFileSync(join(ROOT, "desktop", "lib", "spec.mjs"), "utf8")));
  assert.match(PARITY, /never `--approve`/);
});

rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} desktop tests passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
