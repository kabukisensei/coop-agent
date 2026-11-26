// Change history (FEATURES-DESIGN CW2) in the window: the Changes pane's History
// view, mounted on the live fake DOM, with coop.history / coop.historyDiff
// answered by the main process's own read path (desktop/lib/history-view.mjs)
// over a real store written by lib/action-history.mjs.
//   node tests/history-pane.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-cw2-pane-")));
const HOME = join(root, "home");
const env = { ...process.env, HOME, USERPROFILE: HOME, COOP_DIR: HOME };
Object.assign(process.env, { HOME, USERPROFILE: HOME, COOP_DIR: HOME });
const repo = join(root, "w");
mkdirSync(join(repo, "sql"), { recursive: true });
spawnSync("git", ["init", "-q", repo]);

const lib = await import("../lib/action-history.mjs");
const view = await import("../desktop/lib/history-view.mjs");
const liveDom = await import("./fixtures/fake-dom.mjs");
const { mountChanges, historyOn, restorePrompt, historyRegisteredIn } = await import("../desktop/renderer/pane-changes.mjs");

let n = 0;
let failed = 0;
// Each check reports on its own, so one failure does not hide the next.
const check = async (name, fn) => {
  try { await fn(); n++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error && error.message || error).split("\n")[0]}`); }
};

// A real store: two edits of one file, one data extract (not kept), one record-only line.
const file = join(repo, "sql", "v.sql");
writeFileSync(file, "SELECT 1\nFROM a\n");
let before = readFileSync(file);
writeFileSync(file, "SELECT 1\nFROM b\n");
const e1 = await lib.recordFileChange({ file, tool: "edit", before, approval: "none-needed", session: "s1", env });
before = readFileSync(file);
writeFileSync(file, "SELECT 2\nFROM b\n");
const e2 = await lib.recordFileChange({ file, tool: "edit", before, approval: "asked-once", session: "s1", env });
writeFileSync(join(repo, "out.csv"), "a,b\n");
const e3 = await lib.recordFileChange({ file: join(repo, "out.csv"), tool: "write", before: null, session: "s1", env });
const e4 = await lib.recordCallOnly({ cwd: repo, tool: "bash", approval: "asked-once", label: "rm -rf", env });

await check("the main process's read path: off answers nothing; on lists newest first and gives one change's diff", () => {
  assert.equal(view.historyRows(repo, { on: false, env }).success, false);
  assert.equal(view.historyDiff(repo, e1.id, { on: false, env }).success, false);
  const rows = view.historyRows(repo, { on: true, env });
  assert.deepEqual(rows.data.entries.map((e) => e.id), [e4.id, e3.id, e2.id, e1.id]);
  assert.ok(rows.data.entries.every((e) => !("before" in e) && !("after" in e)), "rows carry no blob names or content");
  assert.equal(view.historyDiff(repo, e1.id, { on: true, env }).data.diff, "@@ -1,2 +1,2 @@\n SELECT 1\n-FROM a\n+FROM b");
  assert.match(view.historyDiff(repo, e3.id, { on: true, env }).data.error, /content was not kept \(data file\)/);
  assert.match(view.historyDiff(repo, e4.id, { on: true, env }).data.error, /not restorable here/);
  assert.equal(view.historyDiff(repo, "ffffffff", { on: true, env }).success, false);
  assert.equal(view.historyOnIn({ ok: true, features: [{ key: "history", on: true }] }), true);
  for (const v of [undefined, {}, { ok: false, features: [{ key: "history", on: true }] }, { ok: true, features: [{ key: "history", on: "true" }] }]) assert.equal(view.historyOnIn(v), false);
});

function pane(on, { registered = true, repos = [{ id: "", label: "w", rel: "" }], current = "" } = {}) {
  const dom = liveDom.installLiveDom();
  const box = new liveDom.FakeElement("div");
  dom.body.append(box);
  const h = { on, registered, prompts: [], asked: [] };
  const coop = {
    changes: async () => ({ success: true, data: { repos, current, repo: true, files: [{ path: "sql/v.sql", status: "modified", added: 1, removed: 1 }], drafts: [], draftsDir: "" } }),
    changeDiff: async () => ({ success: true, data: { diff: "@@ -1 +1 @@\n-a\n+b" } }),
    history: async () => { h.asked.push("history"); return view.historyRows(repo, { on: h.on, env }); },
    historyDiff: async (id) => view.historyDiff(repo, id, { on: h.on, env }),
    openInEditor: async () => ({ success: true, data: {} }),
  };
  h.api = mountChanges(box, {}, { coop, cwd: () => repo, setPrompt: (t) => h.prompts.push(t), getPrompt: () => "", commentsOn: () => true, historyOn: () => h.on, historyRegistered: () => h.registered });
  return Object.assign(h, { dom, box, q: (s) => box.querySelector(s), all: (s) => box.querySelectorAll(s) });
}

await check("off: no History switch, the pane is the Uncommitted list as before, the store is never read", async () => {
  const h = pane(false);
  await h.dom.settle();
  assert.equal(h.q(".change-views"), null);
  assert.equal(h.all(".history-row").length, 0);
  assert.equal(h.all(".change-file").length, 1);
  assert.deepEqual(h.asked, []);
});

await check("on: History lists coop's changes, a row shows its diff, Restore fills the prompt (the person sends it)", async () => {
  const h = pane(true);
  await h.dom.settle();
  const tabs = h.q(".change-views").querySelectorAll("button");
  assert.deepEqual(tabs.map((b) => b.textContent), ["Uncommitted", "History"]);
  h.dom.click(tabs[1]);
  await h.dom.settle();
  const rows = h.all(".history-row");
  assert.equal(rows.length, 4);
  assert.match(h.q(".pane-summary").textContent, /^4 changes coop made in this repository, newest first/);
  // The newest (record-only) is selected first: no diff, no Restore.
  assert.equal(h.q(".change-restore"), null);
  assert.match(h.q(".change-diff").textContent, /not restorable here/);
  // The second edit: its diff, and Restore.
  h.dom.click(rows[2]);
  await h.dom.settle();
  assert.match(h.q(".change-head").textContent, new RegExp(`sql/v\\.sql \\(change ${e2.id}`));
  assert.ok(h.q("[data-line]"), "the diff is drawn by the existing diff view");
  assert.match(h.q(".change-diff").textContent, /SELECT 2/);
  // A click on a line of a recorded change opens no comment or Fix form.
  h.dom.click(h.q("[data-line]"));
  assert.equal(h.q(".fix-line"), null);
  h.dom.click(h.q(".change-restore"));
  assert.deepEqual(h.prompts, [`/history restore ${e2.id}`]);
  // The data extract: no diff, no Restore.
  h.dom.click(rows[1]);
  await h.dom.settle();
  assert.equal(h.q(".change-restore"), null);
  assert.match(h.q(".change-diff").textContent, /content was not kept/);
  // Back to Uncommitted.
  h.dom.click(h.q(".change-views").querySelectorAll("button")[0]);
  await h.dom.settle();
  assert.equal(h.all(".history-row").length, 0);
  assert.equal(h.all(".change-file").length, 1);
});

await check("turned off in Settings while History shows: the switch goes and the pane returns to Uncommitted", async () => {
  const h = pane(true);
  await h.dom.settle();
  h.dom.click(h.q(".change-views").querySelectorAll("button")[1]);
  await h.dom.settle();
  assert.equal(h.all(".history-row").length, 4);
  h.on = false;
  h.dom.window.dispatchEvent(new CustomEvent("coop:features"));
  await h.dom.settle();
  assert.equal(h.q(".change-views"), null);
  assert.equal(h.all(".history-row").length, 0);
  assert.equal(h.all(".change-file").length, 1);
});

await check("the Restore prompt carries only the id", () => {
  assert.equal(restorePrompt("ab12cd34"), "/history restore ab12cd34");
  assert.equal(restorePrompt("ab12; rm -rf /"), "/history restore ab12f");
  assert.equal(historyOn({ ok: true, features: [{ key: "history", on: true }] }), true);
  assert.equal(historyOn({ ok: true, features: [{ key: "history", on: false }] }), false);
});

// --- Fix round (Neon's review B1, B2) --------------------------------------------

await check("B2: on, but /history not registered in this coop (turned on after it started): no Restore, a note to restart", async () => {
  const h = pane(true, { registered: false });
  await h.dom.settle();
  h.dom.click(h.q(".change-views").querySelectorAll("button")[1]);
  await h.dom.settle();
  h.dom.click(h.all(".history-row")[2]);
  await h.dom.settle();
  assert.equal(h.q(".change-restore"), null, "no Restore: /history would go to the model as a prompt");
  assert.match(h.q(".change-restore-note").textContent, /run \/new or restart coop/);
  assert.deepEqual(h.prompts, []);
  // Pi's command list decides it.
  assert.equal(historyRegisteredIn([{ name: "approvals" }, { name: "history", source: "extension" }]), true);
  for (const c of [undefined, [], [{ name: "approvals" }], [null]]) assert.equal(historyRegisteredIn(c), false);
});

await check("B1: Restore names the repository the pane picked (a file's history is in its own repository)", async () => {
  const h = pane(true, { repos: [{ id: "", label: "w", rel: "" }, { id: "sqlA", label: "sqlA", rel: "sqlA" }], current: "sqlA" });
  await h.dom.settle();
  h.dom.click(h.q(".change-views").querySelectorAll("button")[1]);
  await h.dom.settle();
  h.dom.click(h.all(".history-row")[2]);
  await h.dom.settle();
  h.dom.click(h.q(".change-restore"));
  assert.deepEqual(h.prompts, [`/history restore ${e2.id} sqlA`]);
  assert.equal(restorePrompt("ab12cd34", "../other repo\n"), "/history restore ab12cd34 ../other repo");
});

await check("a CRLF-only change says so instead of an empty diff", async () => {
  const f = join(repo, "sql", "crlf.sql");
  writeFileSync(f, "a\nb\n");
  const b0 = readFileSync(f);
  writeFileSync(f, "a\r\nb\r\n");
  const e = await lib.recordFileChange({ file: f, tool: "write", before: b0, env });
  assert.match(view.historyDiff(repo, e.id, { on: true, env }).data.error, /No lines changed: only line endings \(CRLF\/LF\) changed/);
});

if (failed) { console.log(`  ✗ ${failed} change history pane test(s) FAILED`); process.exit(1); }
console.log(`  ${n} change history pane tests passed`);
