// Change history (FEATURES-DESIGN CW2), run against the real code paths: the
// store (lib/action-history.mjs) and the REAL coop-guardrails handlers (bundled),
// with real write calls going through tool_call and tool_result, real files, a
// real git repository (git check-ignore, git merge-file) and the real /history
// restore command.
//   COOP_TEST_DIST=<bundled extensions> node --test tests/action-history.test.mjs
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-cw2-")));
const HOME = join(root, "home");
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.COOP_DIR = HOME;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.COOP_ROOT = ROOT;
delete process.env.COOP_NO_GUARDRAILS;
mkdirSync(join(HOME, ".coop"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const PROFILE = join(HOME, ".coop");
const HISTORY = join(PROFILE, "history");
const CONFIG = join(PROFILE, "config");

const lib = await import(pathToFileURL(join(ROOT, "lib", "action-history.mjs")).href);
const cg = await import(pathToFileURL(`${process.env.COOP_TEST_DIST}/coop-guardrails.mjs`).href);

const repo = join(root, "client");
const git = (...args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
mkdirSync(join(repo, "docs"), { recursive: true });
spawnSync("git", ["init", "-q", repo]);
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "coop test");
writeFileSync(join(repo, ".gitignore"), "ignored/\n");
writeFileSync(join(repo, "README.md"), "# Client\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const setSwitch = (on) => writeFileSync(CONFIG, JSON.stringify({ features: { history: on } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh guardrails instance (it reads the switch at load, as after /new). */
function load({ confirm = async () => true, hasUI = true, sessionId = "sess-1" } = {}) {
  const handlers = {};
  const commands = {};
  const notices = [];
  const confirms = [];
  const pi = {
    on: (ev, h) => { handlers[ev] = h; },
    registerCommand: (name, spec) => { commands[name] = spec; },
    exec: async (bin, args, opts = {}) => {
      const r = spawnSync(bin, args, { cwd: opts.cwd || repo, encoding: "utf8" });
      return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 1 };
    },
  };
  cg.default(pi);
  const ui = { confirm: async (title, message) => { confirms.push(`${title}\n${message}`); return confirm(title, message); }, select: async () => undefined, input: async () => undefined, notify: (m, level) => notices.push({ m, level }) };
  const ctx = { cwd: repo, hasUI, ui: hasUI ? ui : { notify: ui.notify }, sessionManager: { getSessionId: () => sessionId } };
  let n = 0;
  /** One real write or edit: tool_call, the tool itself (the file changes), tool_result. */
  async function fileTool(tool, path, change, { isError = false, cwd = repo } = {}) {
    const toolCallId = `call-${++n}-${Math.random().toString(16).slice(2, 8)}`;
    const input = tool === "write" ? { path, content: change } : { path, edits: [] };
    const c = { ...ctx, cwd };
    const decision = await handlers.tool_call({ type: "tool_call", toolName: tool, toolCallId, input }, c);
    if (decision && decision.block) return { blocked: true, decision };
    const full = resolve(cwd, path);
    if (!isError) {
      mkdirSync(resolve(full, ".."), { recursive: true });
      if (tool === "write") writeFileSync(full, change);
      else writeFileSync(full, change(readFileSync(full, "utf8")));
    }
    const result = await handlers.tool_result({ type: "tool_result", toolName: tool, toolCallId, input, content: [], isError, details: undefined }, c);
    return { blocked: false, toolCallId, result };
  }
  async function call(toolName, input, c = ctx) {
    const toolCallId = `call-${++n}`;
    const decision = await handlers.tool_call({ type: "tool_call", toolName, toolCallId, input }, c);
    if (decision && decision.block) return { blocked: true, decision, toolCallId };
    await handlers.tool_result({ type: "tool_result", toolName, toolCallId, input, content: [], isError: false, details: undefined }, c);
    return { blocked: false, toolCallId };
  }
  const command = async (name, args, c = ctx) => commands[name].handler(args, c);
  return { handlers, commands, notices, confirms, ctx, fileTool, call, command };
}

const store = () => lib.storeFor(repo).store;
/** Wait for the deferred recording (it runs after the result, off the critical path). */
async function lines(expected, s = store()) {
  for (let i = 0; i < 200; i++) {
    const got = lib.readEntries(s, { limit: Infinity });
    if (got.length >= expected) return got;
    await sleep(10);
  }
  return lib.readEntries(s, { limit: Infinity });
}
const blobCount = (s = store()) => readdirSync(s).filter((m) => /^\d{4}-\d{2}$/.test(m)).reduce((n, m) => n + (existsSync(join(s, m, "blobs")) ? readdirSync(join(s, m, "blobs")).length : 0), 0);
const reset = () => { rmSync(HISTORY, { recursive: true, force: true }); lib.clearGitIgnoredCache(); };

test("off (the default): no history folder, no /history, the write goes through as today", async () => {
  reset();
  rmSync(CONFIG, { force: true });
  const g = load();
  assert.equal(g.commands.history, undefined, "/history is registered only while the switch is on");
  const r = await g.fileTool("write", "docs/off.md", "off\n");
  assert.equal(r.blocked, false);
  assert.equal(r.result, undefined, "tool_result changes nothing");
  await sleep(50);
  assert.equal(existsSync(HISTORY), false, "off makes no folder");
  setSwitch(false);
  const g2 = load();
  await g2.fileTool("write", "docs/off.md", "still off\n");
  await sleep(50);
  assert.equal(existsSync(HISTORY), false, "an explicit false is off too");
});

test("on: one line per write with every field, the store keyed by slug + hash of the real root", async () => {
  reset();
  setSwitch(true);
  const g = load();
  assert.ok(g.commands.history, "/history is registered");
  writeFileSync(join(repo, "docs", "a.md"), "one\ntwo\n");
  const r = await g.fileTool("edit", "docs/a.md", (t) => t.replace("two", "TWO"));
  assert.equal(r.result, undefined, "the result is not changed");
  const [e] = await lines(1);
  assert.match(store(), /[\\/]history[\\/]client-[0-9a-f]{8}$/);
  assert.equal(e.v, 1);
  assert.match(e.id, /^[0-9a-f]{8}$/);
  assert.ok(!Number.isNaN(Date.parse(e.ts)));
  assert.equal(e.session, "sess-1");
  assert.equal(e.toolCallId, r.toolCallId);
  assert.equal(e.tool, "edit");
  assert.equal(e.target, "docs/a.md");
  assert.equal(e.approval, "none-needed");
  assert.equal(e.result, "ok");
  assert.equal(e.kind, "file");
  assert.equal(lib.readBlob(store(), e.month, e.before).toString(), "one\ntwo\n");
  assert.equal(lib.readBlob(store(), e.month, e.after).toString(), "one\nTWO\n");
  assert.equal(e.month, new Date().toISOString().slice(0, 7));
  // A new file: before is "absent".
  await g.fileTool("write", "docs/new.md", "fresh\n");
  const [n] = await lines(2);
  assert.equal(n.before, "absent");
  assert.equal(n.target, "docs/new.md");
  // A failed tool call is still recorded, as failed.
  await g.fileTool("write", "docs/a.md", "never\n", { isError: true });
  const [f] = await lines(3);
  assert.equal(f.result, "error");
  // The model's own context never gets the history: tool_result returns nothing.
  assert.ok(lib.readEntries(store()).every((x) => !("content" in x)));
});

test("two repositories with one folder name never share a store", () => {
  const a = join(root, "x", "sql"), b = join(root, "y", "sql");
  mkdirSync(join(a, ".git"), { recursive: true });
  mkdirSync(join(b, ".git"), { recursive: true });
  assert.notEqual(lib.storeFor(a).store, lib.storeFor(b).store);
  assert.match(lib.storeKey(a), /^sql-[0-9a-f]{8}$/);
  // The same repository through a link is the same store.
  symlinkSync(a, join(root, "link-sql"));
  assert.equal(lib.storeFor(join(root, "link-sql")).store, lib.storeFor(a).store);
  // Windows: the key is case-insensitive.
  assert.equal(lib.storeKey("C:\\Work\\SQL", "win32").slice(-8), lib.storeKey("c:\\work\\sql", "win32").slice(-8));
});

test("left out: the call is recorded, the content is not", async () => {
  reset();
  setSwitch(true);
  const g = load({ confirm: async () => true });
  const cases = [
    [".env", "API_KEY=abc\n", "secret-looking file"],
    ["docs/token.md", "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789\n", "secret text"],
    ["data/extract.csv", "id,name\n1,a\n", "data file"],
    ["live/dev-changes.md", "x\n", "live, backups or drafts folder"],
    ["ignored/notes.md", "x\n", "ignored by .gitignore"],
    ["docs/bin.dat", "a\u0000b", "binary file"],
  ];
  for (const [path, text] of cases) await g.fileTool("write", path, text);
  writeFileSync(join(repo, "docs", "big.md"), "x".repeat(lib.MAX_FILE_BYTES + 1));
  await g.fileTool("edit", "docs/big.md", (t) => `${t}y`);
  const got = await lines(cases.length + 1);
  for (const [path, , why] of cases) {
    const e = got.find((x) => x.target === path);
    assert.ok(e, `${path} recorded`);
    assert.equal(e.excluded, why, path);
    assert.equal(e.before, null);
    assert.equal(e.after, null);
  }
  assert.equal(got.find((x) => x.target === "docs/big.md").excluded, "over 5 MB");
  assert.equal(got.find((x) => x.target === ".env").approval, "asked-once", "the secret write asked");
  assert.equal(blobCount(), 0, "no content stored for any of them");
  assert.match(lib.notRestorable(got[0]), /content was not stored/);
});

test("equal content is stored once", async () => {
  reset();
  setSwitch(true);
  const g = load();
  for (let i = 0; i < 3; i++) {
    await g.fileTool("write", "docs/same.md", "A\n");
    await g.fileTool("write", "docs/same.md", "B\n");
  }
  const got = await lines(6);
  assert.equal(got.length, 6);
  assert.equal(blobCount(), 2, "A and B, once each");
});

test("two processes appending to one log: every line parses; a torn line is skipped", async () => {
  reset();
  const script = `import { recordCallOnly } from ${JSON.stringify(pathToFileURL(join(ROOT, "lib", "action-history.mjs")).href)};
for (let i = 0; i < 150; i++) recordCallOnly({ cwd: ${JSON.stringify(repo)}, tool: "bash", approval: "asked-once", label: "p" + process.pid + "-" + i });`;
  const file = join(root, "append.mjs");
  writeFileSync(file, script);
  const run = () => new Promise((done) => spawn(process.execPath, [file], { stdio: "ignore", env: process.env }).on("exit", done));
  await Promise.all([run(), run()]);
  const s = store();
  const month = readdirSync(s).find((m) => /^\d{4}-\d{2}$/.test(m));
  const log = join(s, month, "log.jsonl");
  const raw = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.equal(raw.length, 300);
  assert.ok(raw.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), "no line was interleaved");
  appendFileSync(log, '{"v":1,"id":"deadbeef","ts":"2026');
  appendFileSync(log, "\n{not json}\n");
  assert.equal(lib.readEntries(s, { limit: Infinity }).length, 300, "torn and broken lines are skipped");
});

test("approval paths: asked once, session grant, record-only lines for a shell command the guardrails asked about", async () => {
  reset();
  setSwitch(true);
  const g = load({ confirm: async () => true });
  const r = await g.call("bash", { command: "rm -rf build" });
  assert.equal(r.blocked, false);
  const [e] = await lines(1);
  assert.equal(e.kind, "record-only");
  assert.equal(e.tool, "bash");
  assert.equal(e.approval, "asked-once");
  assert.equal(e.target, "rm -rf", "the audit's fixed label, never the command text");
  assert.match(lib.notRestorable(e), /not restorable here/);
  // A plain read-only command that asks nothing is not recorded.
  await g.call("bash", { command: "ls docs" });
  await sleep(50);
  assert.equal(lib.readEntries(store(), { limit: Infinity }).length, 1);
  // A read is never recorded, even one that asked.
  await g.call("read", { path: ".env" });
  await sleep(50);
  assert.equal(lib.readEntries(store(), { limit: Infinity }).length, 1);
});

test("/history lists the last 20, newest first, to the person only", async () => {
  reset();
  setSwitch(true);
  const g = load();
  for (let i = 0; i < 22; i++) await g.fileTool("write", "docs/list.md", `v${i}\n`);
  await lines(22);
  await g.command("history", "");
  const text = g.notices.at(-1).m;
  assert.match(text, /^Change history for .*client \(newest first/);
  assert.equal(text.split("\n").length, 21, "a header and 20 rows");
  assert.match(text.split("\n")[1], /write\s+docs\/list\.md\s+\[none-needed\]/);
});

test("restore: clean, keeping a later edit (git merge-file), refused conflict and the separate overwrite; backup first; its own line", async () => {
  reset();
  setSwitch(true);
  let answer = true;
  const g = load({ confirm: async () => answer });
  const file = join(repo, "docs", "r.md");
  const base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
  writeFileSync(file, base);
  await g.fileTool("edit", "docs/r.md", (t) => t.replace("b\n", "B\n"));
  const [first] = await lines(1);
  // Clean: the file is that change's result.
  await g.command("history", `restore ${first.id}`);
  assert.equal(readFileSync(file, "utf8"), base);
  assert.match(g.confirms.at(-1), /Restore docs\/r\.md to before change/);
  assert.match(g.confirms.at(-1), /-B\n\+b/);
  assert.match(g.notices.at(-1).m, /restored docs\/r\.md .*Backup: /);
  const backups = join(PROFILE, "backups", "client", "docs");
  assert.equal(readdirSync(backups).length, 1, "a backup of the file as it was is written first");
  assert.equal(readFileSync(join(backups, readdirSync(backups)[0]), "utf8"), base.replace("b\n", "B\n"));
  const [own] = await lines(2);
  assert.equal(own.approval, "restore-approved");
  assert.equal(own.tool, "restore");

  // Merged: a later edit elsewhere in the file is kept.
  await g.fileTool("edit", "docs/r.md", (t) => t.replace("b\n", "B\n"));
  const [second] = await lines(3);
  await g.fileTool("edit", "docs/r.md", (t) => t.replace("i\n", "I\n"));
  await lines(4);
  await g.command("history", `restore ${second.id}`);
  assert.equal(readFileSync(file, "utf8"), base.replace("i\n", "I\n"), "only that change's hunk is taken out");
  assert.match(g.confirms.at(-1), /keeping the later edits/);

  // Conflict: a later edit on the same line. Declined: the file stays.
  await g.fileTool("edit", "docs/r.md", (t) => t.replace("d\n", "D\n"));
  const [third] = await lines(6);
  await g.fileTool("edit", "docs/r.md", (t) => t.replace("D\n", "DD\n"));
  await lines(7);
  const before = readFileSync(file, "utf8");
  answer = false;
  await g.command("history", `restore ${third.id}`);
  assert.match(g.confirms.at(-1), /^coop change history: overwrite the whole file\?/);
  assert.match(g.confirms.at(-1), /conflicts with later edits/);
  assert.match(g.confirms.at(-1), /LOSING EVERY LATER EDIT/);
  assert.equal(readFileSync(file, "utf8"), before, "declined: unchanged");
  // The overwrite, approved on its own.
  answer = true;
  await g.command("history", `restore ${third.id}`);
  assert.equal(readFileSync(file, "utf8"), before.replace("DD\n", "d\n"), "the whole file as it was before that change");
});

test("restore refuses: headless, a record-only line, an unknown id, an excluded file, a path outside the repository", async () => {
  reset();
  setSwitch(true);
  const g = load();
  await g.fileTool("write", "docs/h.md", "1\n");
  await g.fileTool("write", "docs/h.md", "2\n");
  const [e] = await lines(2);
  const headless = { cwd: repo, hasUI: false, ui: { notify: (m, level) => g.notices.push({ m, level }) }, sessionManager: { getSessionId: () => "x" } };
  await g.command("history", `restore ${e.id}`, headless);
  assert.match(g.notices.at(-1).m, /unavailable in headless mode/);
  assert.equal(readFileSync(join(repo, "docs", "h.md"), "utf8"), "2\n");
  await g.command("history", "restore 0123abcd");
  assert.match(g.notices.at(-1).m, /no change 0123abcd/);
  await g.call("bash", { command: "rm -rf build" });
  const [rec] = await lines(3);
  await g.command("history", `restore ${rec.id}`);
  assert.match(g.notices.at(-1).m, /not restorable here/);
  // A line whose target points outside the repository (a hand-edited log) is refused.
  const s = store();
  appendFileSync(join(s, e.month, "log.jsonl"), `${JSON.stringify({ ...e, id: "0badc0de", target: "../outside.md" })}\n`);
  writeFileSync(join(root, "outside.md"), "2\n");
  await g.command("history", "restore 0badc0de");
  assert.match(g.notices.at(-1).m, /outside this repository/);
  assert.equal(readFileSync(join(root, "outside.md"), "utf8"), "2\n");
});

test("a failure to record never fails the write: one notice, one audit row", async () => {
  reset();
  setSwitch(true);
  writeFileSync(HISTORY, "a file where the folder should be");
  try {
    const g = load();
    const r = await g.fileTool("write", "docs/f.md", "x\n");
    const r2 = await g.fileTool("write", "docs/f.md", "y\n");
    assert.equal(r.blocked, false);
    assert.equal(r.result, undefined);
    assert.equal(readFileSync(join(repo, "docs", "f.md"), "utf8"), "y\n");
    await sleep(100);
    const warned = g.notices.filter((x) => /^change history paused:/.test(x.m));
    assert.equal(warned.length, 1, "one notice per session");
    const audit = readFileSync(join(process.env.PI_CODING_AGENT_DIR, "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(audit.filter((a) => a.kind === "change-history" && a.decision === "failed").length >= 2);
  } finally { rmSync(HISTORY, { force: true }); }
});

test("the history folder is blocked for model reads, writes, edits and commands, by every spelling, on or off", async () => {
  reset();
  setSwitch(true);
  const g = load();
  await g.fileTool("write", "docs/p.md", "p\n");
  const [e] = await lines(1);
  const log = join(store(), e.month, "log.jsonl");
  symlinkSync(HISTORY, join(repo, "innocent"));
  for (const on of [true, false]) {
    setSwitch(on);
    const h = load();
    const blockedFile = async (tool, path, cwd = repo) => {
      const r = await h.handlers.tool_call({ toolName: tool, toolCallId: "b", input: tool === "write" ? { path, content: "x" } : { path } }, { ...h.ctx, cwd });
      return Boolean(r && r.block && /change history/.test(r.reason));
    };
    for (const tool of ["read", "write", "edit"]) {
      assert.ok(await blockedFile(tool, log), `${tool} absolute (${on})`);
      assert.ok(await blockedFile(tool, log.replace(HOME, "~")), `${tool} ~ (${on})`);
      assert.ok(await blockedFile(tool, `@${log}`), `${tool} @ (${on})`);
      assert.ok(await blockedFile(tool, "innocent/x"), `${tool} through a link (${on})`);
      assert.ok(await blockedFile(tool, "history/x", PROFILE), `${tool} relative (${on})`);
    }
    const blockedShell = async (command, toolName = "bash") => {
      const r = await h.handlers.tool_call({ toolName, toolCallId: "s", input: { command } }, h.ctx);
      return Boolean(r && r.block && /change history/.test(r.reason));
    };
    for (const command of [
      `cat ${log}`, "cat ~/.coop/history/*/log.jsonl", "cat $HOME/.coop/history", 'cat "${USERPROFILE}/.coop/history"',
      "type %USERPROFILE%\\.coop\\history\\x", "ls $COOP_DIR/.coop/hist*", "ls ~/.coop/*", "cd ~/.coop && cat history/a",
      "cat innocent/log.jsonl", "rm -rf ~/.coop/history", "zcat ~/.coop/history/x/2026-11/blobs/a.gz",
    ]) assert.ok(await blockedShell(command), `${command} (${on})`);
    assert.ok(await blockedShell("Get-Content $env:USERPROFILE\\.coop\\history\\x", "powershell"), `powershell (${on})`);
    // Narrow: everything else is today's behaviour.
    for (const command of ["ls ~/.coop", "cat docs/p.md", "ls ~/*", "git log --oneline -1"]) assert.ok(!(await blockedShell(command)), `${command} is not blocked (${on})`);
    assert.ok(!(await blockedFile("read", "docs/p.md")), "an ordinary read");
  }
  rmSync(join(repo, "innocent"));
});

test("whole-month retention: the 1 GB cap removes the oldest month folders first", () => {
  reset();
  const s = lib.storeFor(repo).store;
  for (const [m, size] of [["2026-08", 600], ["2026-09", 300], ["2026-10", 300]]) {
    mkdirSync(join(s, m, "blobs"), { recursive: true });
    writeFileSync(join(s, m, "log.jsonl"), "x".repeat(size));
  }
  const removed = lib.enforceCap(HISTORY, 700);
  assert.deepEqual(removed.map((r) => r.month), ["2026-08"]);
  assert.ok(!existsSync(join(s, "2026-08")) && existsSync(join(s, "2026-09")) && existsSync(join(s, "2026-10")), "whole folders, oldest first");
  assert.equal(lib.historyStatus(HISTORY).months, 2);
  const r = spawnSync(process.execPath, [join(ROOT, "lib", "action-history.mjs"), "status", "--json"], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).months, 2);
});
