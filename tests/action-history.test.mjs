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
/** The deferred recording (it runs after the result, off the critical path), once it has finished. */
async function lines(expected, s = store()) {
  await cg.historySettled();
  const got = lib.readEntries(s, { limit: Infinity });
  assert.ok(got.length >= expected, `${expected} line(s) recorded, found ${got.length}`);
  return got;
}
const settled = () => cg.historySettled();
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
  await settled();
  assert.equal(existsSync(HISTORY), false, "off makes no folder");
  setSwitch(false);
  const g2 = load();
  await g2.fileTool("write", "docs/off.md", "still off\n");
  await settled();
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

test("approval paths: asked once, record-only lines for a shell command the guardrails asked about", async () => {
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
  await settled();
  assert.equal(lib.readEntries(store(), { limit: Infinity }).length, 1);
  // A read is never recorded, even one that asked.
  await g.call("read", { path: ".env" });
  await settled();
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

test("restore refuses: headless, a record-only line, an unknown id, a path outside the repository", async () => {
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
    await settled();
    const warned = g.notices.filter((x) => /^change history could not record a change:/.test(x.m));
    assert.equal(warned.length, 1, "one notice per session");
    const audit = readFileSync(join(process.env.PI_CODING_AGENT_DIR, "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(audit.filter((a) => a.kind === "change-history" && a.decision === "failed").length >= 2);
  } finally { rmSync(HISTORY, { force: true }); }
});

test("on: the history folder is blocked for model reads, writes, edits and commands, by every spelling; off: no history check at all", async () => {
  reset();
  setSwitch(true);
  const g = load();
  await g.fileTool("write", "docs/p.md", "p\n");
  const [e] = await lines(1);
  const log = join(store(), e.month, "log.jsonl");
  symlinkSync(HISTORY, join(repo, "innocent"));
  for (const on of [true, false]) {
    setSwitch(on);
    const h = load({ confirm: async () => true });
    const blockedFile = async (tool, path, cwd = repo) => {
      const r = await h.handlers.tool_call({ toolName: tool, toolCallId: "b", input: tool === "write" ? { path, content: "x" } : { path } }, { ...h.ctx, cwd });
      return Boolean(r && r.block && /change history/.test(r.reason));
    };
    for (const tool of ["read", "write", "edit"]) {
      assert.equal(await blockedFile(tool, log), on, `${tool} absolute (${on})`);
      assert.equal(await blockedFile(tool, log.replace(HOME, "~")), on, `${tool} ~ (${on})`);
      assert.equal(await blockedFile(tool, `@${log}`), on, `${tool} @ (${on})`);
      assert.equal(await blockedFile(tool, "innocent/x"), on, `${tool} through a link (${on})`);
      assert.equal(await blockedFile(tool, "history/x", PROFILE), on, `${tool} relative (${on})`);
    }
    const blockedShell = async (command, toolName = "bash") => {
      const r = await h.handlers.tool_call({ toolName, toolCallId: "s", input: { command } }, h.ctx);
      return Boolean(r && r.block && /change history/.test(r.reason));
    };
    for (const command of [
      `cat ${log}`, `python -c "print(open('${log}').read())"`, `python -c "open('~/.coop/history/x')"`, "cat ~/.coop/history/*/log.jsonl", "cat $HOME/.coop/history", 'cat "${USERPROFILE}/.coop/history"',
      "type %USERPROFILE%\\.coop\\history\\x", "ls $COOP_DIR/.coop/hist*", "ls ~/.coop/*", "cd ~/.coop && cat history/a",
      "cat innocent/log.jsonl", "rm -rf ~/.coop/history", "zcat ~/.coop/history/x/2026-11/blobs/a.gz",
      "ls ~/.coop/h*", "ls ~/.coop/[h]istory", "ls ~/.coop/hist?ry/x",
    ]) assert.equal(await blockedShell(command), on, `${command} (${on})`);
    assert.equal(await blockedShell("Get-Content $env:USERPROFILE\\.coop\\history\\x", "powershell"), on, `powershell (${on})`);
    // Narrow: everything else is today's behaviour. A glob in ~/.coop that cannot
    // match the name "history" is not it (Neon B6).
    mkdirSync(join(repo, ".coop"), { recursive: true });
    for (const command of ["ls ~/.coop", "cat docs/p.md", "ls ~/*", "git log --oneline -1", "cat .coop/history.md", "ls .coop/history", "cat ~/.coop/history-notes.txt",
      "ls ~/.coop/*.json", "cat ~/.coop/*.txt", "ls ~/.coop/b*"]) assert.ok(!(await blockedShell(command)), `${command} is not blocked (${on})`);
    assert.ok(!(await blockedFile("read", "docs/p.md")), "an ordinary read");
  }
  rmSync(join(repo, "innocent"));
});

test("whole-month retention: the 1 GB cap removes the oldest month folders first", async () => {
  reset();
  const s = lib.storeFor(repo).store;
  for (const [m, size] of [["2026-08", 600], ["2026-09", 300], ["2026-10", 300]]) {
    mkdirSync(join(s, m, "blobs"), { recursive: true });
    writeFileSync(join(s, m, "log.jsonl"), "x".repeat(size));
  }
  const removed = await lib.enforceCap(HISTORY, 700, { now: new Date("2026-11-26T12:00:00Z") });
  assert.deepEqual(removed.map((r) => r.month), ["2026-08"]);
  assert.ok(!existsSync(join(s, "2026-08")) && existsSync(join(s, "2026-09")) && existsSync(join(s, "2026-10")), "whole folders, oldest first");
  assert.equal((await lib.historyStatus(HISTORY)).months, 2);
  const r = spawnSync(process.execPath, [join(ROOT, "lib", "action-history.mjs"), "status", "--json"], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).months, 2);
});

// --- Fix round (Neon's review of CW2) ------------------------------------------

test("B3: the bytes after are the file as this call left it, even when a second edit lands before the recording runs", async () => {
  reset();
  setSwitch(true);
  const g = load();
  const file = join(repo, "docs", "race.md");
  writeFileSync(file, "v0\n");
  await g.fileTool("write", "docs/race.md", "v1\n");
  // The recording is deferred (setImmediate, then git check-ignore). A second
  // edit lands first, outside this call:
  writeFileSync(file, "v2\n");
  const [first] = await lines(1);
  assert.equal(lib.readBlob(store(), first.month, first.before).toString(), "v0\n");
  assert.equal(lib.readBlob(store(), first.month, first.after).toString(), "v1\n", "after is v1, not the later v2");
  // Restoring that first change keeps the later edit's question: it is not a silent clean overwrite.
  const plan = lib.planRestore(store(), first, readFileSync(file));
  assert.notEqual(plan.mode, "clean");
});

test("should-fix 6: a locked file is never waited for on the tool path; its content is simply not kept", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions (not root)" : false }, async () => {
  reset();
  setSwitch(true);
  const g = load();
  const file = join(repo, "docs", "locked.md");
  writeFileSync(file, "locked\n");
  const toolCallId = "locked-1";
  const input = { path: "docs/locked.md", content: "new\n" };
  spawnSync("chmod", ["000", file]);
  let decision;
  try { decision = await g.handlers.tool_call({ type: "tool_call", toolName: "write", toolCallId, input }, g.ctx); } finally { spawnSync("chmod", ["644", file]); }
  assert.ok(!decision || !decision.block);
  writeFileSync(file, "new\n");
  await g.handlers.tool_result({ type: "tool_result", toolName: "write", toolCallId, input, content: [], isError: false }, g.ctx);
  const [e] = await lines(1);
  assert.equal(e.excluded, "could not be read (locked?)");
  assert.equal(g.notices.filter((x) => /could not record/.test(x.m)).length, 0, "not a failure: the call is recorded without content");
});

test("B2: switched on at a session start without /history registered: nothing recorded, no command, the session says to restart coop", async () => {
  reset();
  setSwitch(false);
  const g = load();
  assert.equal(g.commands.history, undefined);
  setSwitch(true);
  await g.handlers.session_start({ type: "session_start" }, g.ctx);
  assert.ok(g.notices.some((x) => /restart coop to use Change history/.test(x.m)), "the session line says to restart");
  assert.equal(g.commands.history, undefined, "still no /history: a Restore would go to the model");
  await g.fileTool("write", "docs/b2.md", "b2\n");
  await settled();
  assert.equal(existsSync(HISTORY), false, "nothing recorded until a restart");
  // A restart (a fresh instance with the switch on) has it.
  const h = load();
  assert.ok(h.commands.history);
  await h.fileTool("write", "docs/b2.md", "b2 again\n");
  await lines(1);
});

test("B1: a client folder with several repositories: each file's change goes to its own repository, /history lists them all or the one named, and restore finds it", async () => {
  reset();
  setSwitch(true);
  const client = join(root, "multi");
  for (const name of ["sqlA", "sqlB"]) {
    mkdirSync(join(client, name, "views"), { recursive: true });
    spawnSync("git", ["init", "-q", join(client, name)]);
    writeFileSync(join(client, name, "views", "v.sql"), `SELECT '${name}'\n`);
  }
  let answer = true;
  const g = load({ confirm: async () => answer });
  const c = { ...g.ctx, cwd: client };
  await g.fileTool("write", "sqlA/views/v.sql", "SELECT 'A2'\n", { cwd: client });
  await g.fileTool("write", "sqlB/views/v.sql", "SELECT 'B2'\n", { cwd: client });
  const [a] = await lines(1, lib.storeFor(join(client, "sqlA")).store);
  const [b] = await lines(1, lib.storeFor(join(client, "sqlB")).store);
  assert.equal(a.target, "views/v.sql");
  await g.command("history", "", c);
  const all = g.notices.at(-1).m;
  assert.match(all, /sqlA\/views\/v\.sql/);
  assert.match(all, /sqlB\/views\/v\.sql/);
  await g.command("history", "list sqlB", c);
  assert.match(g.notices.at(-1).m, new RegExp(b.id));
  assert.doesNotMatch(g.notices.at(-1).m, new RegExp(a.id), "the repository the pane picked, only");
  // Restore by id alone (found in sqlA's store) and with the repository named.
  await g.command("history", `restore ${a.id}`, c);
  assert.equal(readFileSync(join(client, "sqlA", "views", "v.sql"), "utf8"), "SELECT 'sqlA'\n");
  await g.command("history", `restore ${b.id} sqlB`, c);
  assert.equal(readFileSync(join(client, "sqlB", "views", "v.sql"), "utf8"), "SELECT 'sqlB'\n");
  await g.command("history", `restore ${b.id} sqlA`, c);
  assert.match(g.notices.at(-1).m, /no change/, "the wrong repository named: not found there");
});

test("B4: the 1 GB cap never follows a linked history folder, skips bad month names and never removes the current month", async () => {
  reset();
  const outside = join(root, "outside-history");
  const s = join(outside, "client-0123abcd");
  for (const m of ["2026-01", "0000-01", "2026-13", "9999-12"]) {
    mkdirSync(join(s, m), { recursive: true });
    writeFileSync(join(s, m, "log.jsonl"), "x".repeat(500));
  }
  mkdirSync(PROFILE, { recursive: true });
  symlinkSync(outside, HISTORY);
  try {
    assert.deepEqual(await lib.enforceCap(HISTORY, 1), [], "a linked history folder: nothing removed");
    assert.ok(existsSync(join(s, "2026-01", "log.jsonl")));
    assert.equal((await lib.historyStatus(HISTORY)).linked, true);
  } finally { rmSync(HISTORY, { force: true }); }
  // A plain folder: bad names are not months; the current month stays even over the cap.
  const now = new Date("2026-11-26T12:00:00Z");
  const own = join(HISTORY, "client-0123abcd");
  for (const m of ["2026-10", "2026-11", "0000-01", "2026-13"]) {
    mkdirSync(join(own, m), { recursive: true });
    writeFileSync(join(own, m, "log.jsonl"), "x".repeat(500));
  }
  assert.deepEqual((await lib.listMonths(HISTORY)).map((m) => m.month), ["2026-10", "2026-11"]);
  const removed = await lib.enforceCap(HISTORY, 1, { now });
  assert.deepEqual(removed.map((m) => m.month), ["2026-10"]);
  assert.ok(existsSync(join(own, "2026-11", "log.jsonl")), "the current month is never removed by the cap");
  assert.ok(existsSync(join(own, "0000-01")), "a folder that is no month is left alone");
  assert.equal(lib.sizeText(1024 * 1024 * 1024), "1.0 GB");
});

test("should-fix 5: restore a deleted file (and its folder), refuse a binary-now file and a created file; a CRLF-only change says so", async () => {
  reset();
  setSwitch(true);
  const g = load();
  mkdirSync(join(repo, "gone", "deep"), { recursive: true });
  writeFileSync(join(repo, "gone", "deep", "d.md"), "keep me\n");
  await g.fileTool("write", "gone/deep/d.md", "changed\n");
  const [d] = await lines(1);
  rmSync(join(repo, "gone"), { recursive: true, force: true });
  await g.command("history", `restore ${d.id}`);
  assert.match(g.confirms.at(-1), /was deleted after change/);
  assert.equal(readFileSync(join(repo, "gone", "deep", "d.md"), "utf8"), "keep me\n", "the file and its folder come back");
  // An empty file deleted since: it still comes back (not "nothing to restore").
  writeFileSync(join(repo, "docs", "empty.md"), "");
  await g.fileTool("write", "docs/empty.md", "now text\n");
  const [em] = await lines(3);
  rmSync(join(repo, "docs", "empty.md"));
  await g.command("history", `restore ${em.id}`);
  assert.equal(readFileSync(join(repo, "docs", "empty.md"), "utf8"), "");
  // Binary now: refused, the file untouched.
  writeFileSync(join(repo, "docs", "bin.md"), "a\nb\nc\n");
  await g.fileTool("write", "docs/bin.md", "a\nB\nc\n");
  const [bn] = await lines(5);
  writeFileSync(join(repo, "docs", "bin.md"), Buffer.from([0x61, 0, 0x62]));
  await g.command("history", `restore ${bn.id}`);
  assert.match(g.notices.at(-1).m, /binary now/);
  assert.deepEqual([...readFileSync(join(repo, "docs", "bin.md"))], [0x61, 0, 0x62]);
  // A change that created the file: refused with its reason.
  await g.fileTool("write", "docs/created.md", "new\n");
  const [cr] = await lines(6);
  await g.command("history", `restore ${cr.id}`);
  assert.match(g.notices.at(-1).m, /created the file/);
  // An excluded file (a data extract): refused, content not stored.
  await g.fileTool("write", "docs/x.csv", "a,b\n");
  const [cs] = await lines(7);
  await g.command("history", `restore ${cs.id}`);
  assert.match(g.notices.at(-1).m, /content was not stored \(data file\)/);
  // CRLF only.
  writeFileSync(join(repo, "docs", "crlf.md"), "a\nb\n");
  await g.fileTool("write", "docs/crlf.md", "a\r\nb\r\n");
  const [cl] = await lines(8);
  assert.deepEqual(lib.entryDiff(store(), cl), { diff: "", note: "line endings (CRLF/LF)" });
  await g.command("history", `restore ${cl.id}`);
  assert.match(g.confirms.at(-1), /only line endings \(CRLF\/LF\)/);
  // git merge-file failing (status > 127) is a refusal, not a conflict card.
  const fake = join(root, "fake-git.sh");
  writeFileSync(fake, "#!/bin/sh\nexit 255\n", { mode: 0o755 });
  writeFileSync(join(repo, "docs", "m.md"), "1\n2\n3\n");
  await g.fileTool("write", "docs/m.md", "1\nTWO\n3\n");
  const [mm] = await lines(10);
  writeFileSync(join(repo, "docs", "m.md"), "1\nTWO\n3\nlater\n");
  if (process.platform !== "win32") assert.equal(lib.planRestore(store(), mm, readFileSync(join(repo, "docs", "m.md")), { git: fake }).mode, "refused");
});

test("should-fix 7: a secret name that links elsewhere, a .gitignore written since, a new folder in a linked repository", async () => {
  reset();
  setSwitch(true);
  const g = load({ confirm: async () => true });
  writeFileSync(join(repo, "docs", "cfg.txt"), "harmless\n");
  symlinkSync(join(repo, "docs", "cfg.txt"), join(repo, ".env.local"));
  try {
    await g.fileTool("write", ".env.local", "plain words\n");
    const [e] = await lines(1);
    assert.equal(e.excluded, "secret-looking file", "the name the tool was given counts");
  } finally { rmSync(join(repo, ".env.local"), { force: true }); }
  // Not ignored, then coop adds it to .gitignore: the next write is ignored.
  await g.fileTool("write", "later/x.md", "1\n");
  const [x1] = await lines(2);
  assert.equal(x1.excluded, undefined);
  await g.fileTool("write", ".gitignore", "ignored/\nlater/\n");
  await lines(3);
  await g.fileTool("write", "later/x.md", "2\n");
  const [x2] = await lines(4);
  assert.equal(x2.excluded, "ignored by .gitignore");
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  // The repository through a link, a failed write into a new nested folder: still inside it.
  const link = join(root, "client-link");
  symlinkSync(repo, link);
  try {
    await g.fileTool("write", "brand/new/dir/f.md", "x\n", { cwd: link, isError: true });
    const [f] = await lines(5);
    assert.equal(f.target, "brand/new/dir/f.md");
    assert.notEqual(f.excluded, "outside the repository");
  } finally { rmSync(link, { force: true }); }
});

test("should-fix 8: a torn last line does not swallow the next one; shutdown waits for the last line", async () => {
  reset();
  setSwitch(true);
  const g = load();
  await g.fileTool("write", "docs/t.md", "1\n");
  const [e] = await lines(1);
  appendFileSync(join(store(), e.month, "log.jsonl"), '{"v":1,"id":"torn');
  await g.fileTool("write", "docs/t.md", "2\n");
  const got = await lines(2);
  assert.equal(got.length, 2, "the line after a torn one still parses");
  // /new or exit: the last edit's line is written before shutdown returns.
  await g.fileTool("write", "docs/t.md", "3\n");
  await g.handlers.session_shutdown({ type: "session_shutdown" }, g.ctx);
  assert.equal(lib.readEntries(store(), { limit: Infinity }).length, 3);
});
