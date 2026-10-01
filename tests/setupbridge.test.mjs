// Tests for the JSONL wizard bridge's prompt-rendering logic in
// extensions/coop-tools (renderPrompt / askCheckbox), plus the /setup-docs and
// /start > Document entry points around it (#102: home-folder stop, build-failure
// fix offer). No live coop-data-doc subprocess is required: pi.exec is faked.
// Imports the bundled extension's named exports (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const mod = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const { renderPrompt, askCheckbox, buildStartMenu } = mod;

let n = 0;
// Await each case: the bridge is async, and an un-awaited assertion would print ✓
// before it ran (and fail only as a stray unhandled rejection, out of order).
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

await t("renderPrompt text → ui.input, trimmed, control chars stripped", async () => {
  const calls = [];
  const ctx = {
    ui: {
      input: async (label, def) => {
        calls.push([label, def]);
        return "\u0007 My\u0008Estate \u0000";
      },
    },
  };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q1", kind: "text", message: "Project name?", default: "Coop BI Estate" });
  assert.equal(answer, "MyEstate");
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /Project name\?/);
  assert.equal(calls[0][1], "Coop BI Estate");
});

await t("renderPrompt text → blank answer falls back to default", async () => {
  const ctx = { ui: { input: async () => "   " } };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q", kind: "text", message: "X", default: "fallback" });
  assert.equal(answer, "fallback");
});

const MANUAL = "⌨ Type or paste the folder path";

await t("renderPrompt path → discovers sibling repos, but Enter never preselects a folder (#102)", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-path-picker-"));
  const cwd = join(root, "current-project");
  const sql = join(root, "sql-warehouse");
  // #102: sibling discovery is for real candidates, so the fixture sibling is a repo.
  mkdirSync(cwd); mkdirSync(join(sql, ".git"), { recursive: true });
  let calls = 0;
  const ctx = { cwd, ui: {
    select: async (_message, choices) => {
      calls++;
      if (calls === 1) {
        assert.equal(choices[0], MANUAL, "a missing suggestion makes Enter type/paste, never a folder");
        assert.ok(!choices.some((choice) => choice.includes("sql-repo")), "the missing placeholder is never offered");
        const folder = choices.find((choice) => choice.includes("sql-warehouse"));
        assert.ok(folder, "sibling repo should be discovered from the default's real parent");
        return folder;
      }
      assert.ok(choices[0].startsWith("✓ Use this folder:"), "a folder the user opened becomes the Enter choice");
      return choices.find((choice) => choice.startsWith("✓ Use this folder:"));
    },
  } };
  const answer = await renderPrompt(ctx, {
    type: "prompt", id: "sql_path", kind: "path", message: "SQL repo path", default: "../sql-repo",
  });
  assert.equal(answer, relative(cwd, sql));
  assert.equal(calls, 2);
});

// #102: a home-folder session. coop-data-doc suggests ../pbi-repo, which resolves to
// C:\Users\pbi-repo there; C:\Users holds no repo, so nothing nearby is a candidate.
function homeLikeSession() {
  const users = join(mkdtempSync(join(tmpdir(), "coop-102-home-")), "Users");
  const home = join(users, "me");
  mkdirSync(join(home, "Documents"), { recursive: true });
  mkdirSync(join(users, "Public"));
  return { users, home };
}

await t("renderPrompt path → missing suggestion, no nearby repo: Enter opens type/paste from the session folder (#102)", async () => {
  const { home } = homeLikeSession();
  let shown = [];
  const inputs = [];
  const ctx = { cwd: home, ui: {
    select: async (_message, choices) => { shown = choices; return choices[0]; },
    input: async (label, placeholder) => { inputs.push([label, placeholder]); return "  C:/code/PowerBI  "; },
  } };
  const answer = await renderPrompt(ctx, {
    type: "prompt", id: "pbi_path", kind: "path", message: "Power BI repo path", default: "../pbi-repo",
  });
  assert.equal(shown[0], MANUAL, "Enter must open type/paste, not keep or pick a folder");
  assert.ok(!shown.some((choice) => choice.includes("pbi-repo")), "the not-found placeholder is not offered");
  assert.ok(shown.includes("✓ Use this folder: ."), "browsing starts at the session folder");
  assert.ok(shown.includes("📁 Documents"), "the session folder's children are listed");
  assert.ok(!shown.some((choice) => choice === "📁 Public"), "browsing does not start at the parent (C:\\Users)");
  assert.equal(inputs.length, 1);
  assert.notEqual(inputs[0][1], "../pbi-repo", "the placeholder is not offered as the typed default either");
  assert.equal(answer, "C:/code/PowerBI");
});

await t("renderPrompt path → Enter at every dialog never answers the placeholder or a folder (#102)", async () => {
  const { home } = homeLikeSession();
  let dialogs = 0;
  const ctx = { cwd: home, ui: {
    select: async (_message, choices) => (++dialogs > 8 ? undefined : choices[0]),
    input: async () => (++dialogs > 8 ? undefined : ""),
  } };
  const answer = await renderPrompt(ctx, {
    type: "prompt", id: "pbi_path", kind: "path", message: "Power BI repo path", default: "../pbi-repo",
  });
  assert.equal(answer, null, "Enter-through only ends when the user presses Esc");
});

await t("renderPrompt path → an existing suggestion stays the Enter choice", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-path-existing-"));
  const cwd = join(root, "project");
  mkdirSync(cwd); mkdirSync(join(root, "sql"));
  let shown = [];
  const ctx = { cwd, ui: { select: async (_message, choices) => { shown = choices; return choices[0]; } } };
  const answer = await renderPrompt(ctx, {
    type: "prompt", id: "sql_path", kind: "path", message: "SQL repo path", default: "../sql",
  });
  assert.equal(shown[0], `✓ Use this folder: ${join("..", "sql")}`);
  assert.equal(answer, join("..", "sql"));
});

await t("renderPrompt path → a session folder that is itself a repo is not a nearby repo (#102)", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-path-self-repo-"));
  const cwd = join(root, "project");
  // The session folder is a Git checkout; its only sibling is not one.
  mkdirSync(join(cwd, ".git"), { recursive: true }); mkdirSync(join(root, "notes"));
  let shown = [];
  const ctx = { cwd, ui: { select: async (_message, choices) => { shown = choices; return undefined; } } };
  const answer = await renderPrompt(ctx, {
    type: "prompt", id: "pbi_path", kind: "path", message: "Power BI repo path", default: "../pbi-repo",
  });
  assert.equal(answer, null);
  assert.equal(shown[0], MANUAL);
  assert.ok(shown.includes("✓ Use this folder: ."), `browsing starts in the session folder, got ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes("📁 notes"), "browsing does not start beside the missing suggestion");
});

await t("renderPrompt path → a blank typed path keeps an existing suggestion", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-path-existing-typed-"));
  const cwd = join(root, "project");
  mkdirSync(cwd); mkdirSync(join(root, "sql"));
  let selects = 0;
  const inputs = [];
  const ctx = { cwd, ui: {
    // Pick "Type or paste" once; a second folder list means the blank line was not kept.
    select: async (_message, choices) => (++selects > 1 ? undefined : choices.find((c) => c === MANUAL)),
    input: async (label, placeholder) => { inputs.push([label, placeholder]); return ""; },
  } };
  const answer = await renderPrompt(ctx, {
    type: "prompt", id: "sql_path", kind: "path", message: "SQL repo path", default: "../sql",
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0][1], "../sql", "the existing suggestion is the typed default");
  assert.equal(answer, "../sql", "Enter on a blank line keeps the suggestion");
  assert.equal(selects, 1, "no return to the folder list");
});

await t("renderPrompt confirm → ui.confirm returns boolean", async () => {
  const ctx = { ui: { confirm: async () => true } };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q2", kind: "confirm", message: "Map it?" });
  assert.equal(answer, true);
});

await t("renderPrompt confirm → the wizard's default No is the Enter choice (#102)", async () => {
  let shown = [];
  // Pi's own confirm lists Yes first, so Enter there would answer Yes.
  const ctx = { ui: {
    confirm: async () => true,
    select: async (_title, options) => { shown = options; return options[0]; },
  } };
  const message = "'C:\\Users\\pbi-repo' doesn't exist (yet). Use it anyway?";
  const answer = await renderPrompt(ctx, { type: "prompt", id: "pbi_missing", kind: "confirm", message, default: false });
  assert.deepEqual(shown, ["No", "Yes"], "No is listed first (an RPC host shows it as the first button)");
  assert.equal(answer, false, "Enter keeps the default No");
  const yes = await renderPrompt({ ui: { ...ctx.ui, select: async () => "Yes" } }, { type: "prompt", id: "q", kind: "confirm", message, default: false });
  assert.equal(yes, true, "choosing Yes still answers true");
  const esc = await renderPrompt({ ui: { ...ctx.ui, select: async () => undefined } }, { type: "prompt", id: "q", kind: "confirm", message, default: false });
  assert.equal(esc, false, "Esc answers No, like Pi's confirm");
  const defaultYes = await renderPrompt(ctx, { type: "prompt", id: "q", kind: "confirm", message: "Map it?", default: true });
  assert.deepEqual(shown, ["Yes", "No"]);
  assert.equal(defaultYes, true);
});

await t("renderPrompt select → chosen label mapped back to value", async () => {
  const labels = [];
  const ctx = { ui: { select: async (msg, l) => { labels.push(...l); return l[1]; } } };
  const answer = await renderPrompt(ctx, {
    type: "prompt",
    id: "q3",
    kind: "select",
    message: "Pick",
    choices: [
      { label: "Alpha", value: "a" },
      { label: "Beta", value: "b" },
    ],
  });
  assert.equal(answer, "b");
  assert.deepEqual(labels, ["Alpha", "Beta"]);
});

await t("renderPrompt select → protocol default is shown first", async () => {
  let shown = [];
  const ctx = { ui: { select: async (_msg, labels) => { shown = labels; return labels[0]; } } };
  const answer = await renderPrompt(ctx, {
    type: "prompt",
    id: "local_sources",
    kind: "select",
    message: "Available sources",
    default: "sql",
    choices: [
      { label: "Both", value: "both" },
      { label: "SQL only", value: "sql" },
      { label: "Power BI only", value: "powerbi" },
    ],
  });
  assert.equal(answer, "sql");
  assert.deepEqual(shown, ["SQL only", "Both", "Power BI only"]);
});

await t("renderPrompt cancel (Esc) → null", async () => {
  const ctx = { ui: { input: async () => null } };
  const answer = await renderPrompt(ctx, { type: "prompt", id: "q4", kind: "text", message: "X", default: "" });
  assert.equal(answer, null);
});

await t("askCheckbox → toggle loop returns final selected values", async () => {
  const picks = ["☑ A", "☐ B", "✓ Done"];
  let i = 0;
  const ctx = { ui: { select: async () => picks[i++] } };
  const answer = await askCheckbox(ctx, {
    type: "prompt",
    id: "q5",
    kind: "checkbox",
    message: "Folders",
    choices: [
      { label: "A", value: "a", checked: true },
      { label: "B", value: "b", checked: false },
    ],
  });
  // A was pre-checked → toggled OFF; B was unchecked → toggled ON; then Done.
  assert.deepEqual(answer, ["b"]);
});

await t("askCheckbox → empty choices returns []", async () => {
  const ctx = { ui: { select: async () => "✓ Done" } };
  const answer = await askCheckbox(ctx, { type: "prompt", id: "q6", kind: "checkbox", message: "None", choices: [] });
  assert.deepEqual(answer, []);
});

await t("askCheckbox → cancel (Esc) returns null", async () => {
  const ctx = { ui: { select: async () => null } };
  const answer = await askCheckbox(ctx, {
    type: "prompt",
    id: "q7",
    kind: "checkbox",
    message: "Folders",
    choices: [{ label: "A", value: "a", checked: false }],
  });
  assert.equal(answer, null);
});

// --- /setup-docs and /start > Document entry points (#102) -------------------

/** Register the extension against a fake Pi; record exec calls and notifications. */
function boot(execResult = () => ({ code: 0, stdout: "", stderr: "" })) {
  const commands = {};
  const execs = [];
  const pi = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name, spec) => { commands[name] = spec.handler; },
    sendUserMessage: () => {},
    exec: async (bin, args, opts) => { execs.push({ bin, args, cwd: opts?.cwd }); return execResult(args); },
  };
  mod.default(pi);
  return { pi, commands, execs };
}

function sessionCtx(cwd, ui = {}) {
  const notices = [];
  const dialogs = [];
  const record = (kind) => async (title, ...rest) => { dialogs.push({ kind, title, rest }); return undefined; };
  return {
    notices,
    dialogs,
    ctx: {
      cwd,
      hasUI: true,
      mode: "tui",
      ui: {
        select: record("select"), confirm: record("confirm"), input: record("input"), editor: record("editor"),
        notify: (message, type) => notices.push({ message: String(message), type }),
        ...ui,
      },
    },
  };
}

/** Run fn with HOME/USERPROFILE pointing at a fixture home (os.homedir() reads them). */
async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { await fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const documentItem = () => buildStartMenu().find((item) => item.label.includes("Document a warehouse or semantic model"));

function assertHomeStop(notices, home) {
  const stop = notices.find((n) => n.type === "warning" && n.message.includes(home));
  assert.ok(stop, `expected a warning naming the home folder, got ${JSON.stringify(notices)}`);
  assert.match(stop.message, /home folder/i);
  assert.match(stop.message, /\bcd\b/, "terminal steps: cd into the project folder");
  assert.match(stop.message, /then run coop/i, "terminal steps: then start coop");
  assert.match(stop.message, /chat window/i, "chat window steps: change the chat's folder");
}

await t("/setup-docs in the home folder stops before anything is written there (#102)", async () => {
  const { home } = homeLikeSession();
  await withHome(home, async () => {
    const { commands, execs } = boot();
    const { ctx, notices, dialogs } = sessionCtx(home);
    await commands["setup-docs"]("", ctx);
    assert.deepEqual(execs, [], "the wizard never starts");
    assert.deepEqual(dialogs, [], "no setup dialog is shown");
    assert.ok(!existsSync(join(home, "coop-data-doc.yml")));
    assertHomeStop(notices, home);
  });
});

await t("/start > Document in the home folder stops, even with a home config waiting to build (#102)", async () => {
  const { home } = homeLikeSession();
  await withHome(home, async () => {
    const { pi, execs } = boot();
    const fresh = sessionCtx(home);
    await documentItem().run(pi, fresh.ctx);
    assert.deepEqual(execs, [], "no setup run from the home folder");
    assertHomeStop(fresh.notices, home);
    // The teammate's state after the original bug: a placeholder config in home.
    writeFileSync(join(home, "coop-data-doc.yml"), "repos:\n  powerbi:\n    path: ../pbi-repo\n");
    const again = sessionCtx(home);
    await documentItem().run(pi, again.ctx);
    assert.deepEqual(execs, [], "no build from the home folder");
    assertHomeStop(again.notices, home);
  });
});

await t("/setup-docs in a folder under home is not stopped (#102)", async () => {
  const { home } = homeLikeSession();
  const project = join(home, "Documents");
  await withHome(home, async () => {
    // A tool without the JSONL transport ends setup right after the guard.
    const { commands, execs } = boot(() => ({ code: 0, stdout: "Usage: coop-data-doc setup [PATH]", stderr: "" }));
    const { ctx, notices } = sessionCtx(project);
    await commands["setup-docs"]("", ctx);
    assert.ok(notices.some((n) => n.message.includes("does not support the native JSONL setup wizard")), JSON.stringify({ execs, notices }));
    assert.ok(!notices.some((n) => /home folder/i.test(n.message)));
  });
});

const MISSING = (project) =>
  `Error: Repo 'powerbi' path does not exist: ${join(project, "..", "pbi-repo")} (configured in ${join(project, "coop-data-doc.yml")})\n`;

function unbuiltProject() {
  const project = join(mkdtempSync(join(tmpdir(), "coop-102-build-")), "project");
  mkdirSync(project);
  writeFileSync(join(project, "coop-data-doc.yml"), "project_name: \"x\"\nrepos:\n  powerbi:\n    path: \"../pbi-repo\"\n");
  return project;
}

const failBuild = (stderr) => (args) => (args[0] === "build" ? { code: 1, stdout: "", stderr } : { code: 0, stdout: "Usage: coop-data-doc setup [PATH]", stderr: "" });

await t("a build that fails on a missing repo path offers to re-run setup or open the config (#102)", async () => {
  const project = unbuiltProject();
  const { pi } = boot(failBuild(MISSING(project)));
  let offered = null;
  const { ctx, notices } = sessionCtx(project, {
    select: async (title, options) => { offered = { title, options }; return options.find((o) => /re-run setup/i.test(o)); },
  });
  await documentItem().run(pi, ctx);
  assert.ok(offered, "the failure offers a fix");
  assert.match(offered.title, /pbi-repo/, "the offer names the missing path");
  assert.ok(offered.options.some((o) => /re-run setup/i.test(o)));
  assert.ok(offered.options.some((o) => /open .*coop-data-doc\.yml/i.test(o)));
  assert.ok(notices.some((n) => n.message.includes("does not support the native JSONL setup wizard")), "Re-run setup starts /setup-docs again");
});

await t("a missing repo path build failure can open the config to fix it (#102)", async () => {
  const project = unbuiltProject();
  const cfg = join(project, "coop-data-doc.yml");
  const { pi } = boot(failBuild(MISSING(project)));
  let edited = null;
  const { ctx } = sessionCtx(project, {
    select: async (_title, options) => options.find((o) => /open .*coop-data-doc\.yml/i.test(o)),
    editor: async (title, prefill) => { edited = { title, prefill }; return prefill.replace("../pbi-repo", "../PowerBI"); },
  });
  await documentItem().run(pi, ctx);
  assert.ok(edited, "the config opens in the editor");
  assert.match(edited.prefill, /\.\.\/pbi-repo/);
  assert.match(readFileSync(cfg, "utf8"), /"\.\.\/PowerBI"/, "the fixed path is saved");
});

await t("other build failures keep the plain error, no fix offer (#102)", async () => {
  const project = unbuiltProject();
  const { pi } = boot(failBuild("Error: something else broke\n"));
  const { ctx, notices, dialogs } = sessionCtx(project);
  await documentItem().run(pi, ctx);
  assert.deepEqual(dialogs, []);
  assert.ok(notices.some((n) => n.type === "error" && n.message.includes("something else broke")));
});

console.log(`  ${n} setup-bridge tests passed`);

await t("data-doc config follows ancestors and authoritative missing env path", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-doc-config-")));
  const nested = join(root, "client", "src");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "coop-data-doc.yml"), "project_name: Test\n");
  assert.equal(mod.findDataDocConfig(nested, {}), join(root, "coop-data-doc.yml"));
  assert.equal(mod.findDataDocConfig(nested, { COOP_DATA_DOC_CONFIG: "missing.yml" }), join(nested, "missing.yml"));
});

await t("data_doc failure/check claims no generated artifacts; lineage qualifies evidence", async () => {
  const tools = {};
  let result = { code: 2, stdout: "", stderr: "validation failed" };
  mod.default({ on: () => {}, registerTool: spec => { tools[spec.name] = spec; }, registerCommand: () => {}, exec: async () => result });
  const ctx = { cwd: tmpdir() };
  const failed = await tools.data_doc.execute("test", {command: "build"}, undefined, undefined, ctx);
  assert.doesNotMatch(failed.content[0].text, /Machine-readable artifacts:/);
  result = { code: 0, stdout: "Current", stderr: "" };
  const checked = await tools.data_doc.execute("test", {command: "check"}, undefined, undefined, ctx);
  assert.doesNotMatch(checked.content[0].text, /Machine-readable artifacts:/);
  result = { code: 0, stdout: JSON.stringify({ object: {name: "Sales"}, upstream: [], downstream: [], evidence: { state: "partial", states: ["missing", "unresolved"] } }), stderr: "" };
  const lineage = await tools.data_doc.execute("test", {command: "lineage", object: "Sales"}, undefined, undefined, ctx);
  assert.match(lineage.content[0].text, /observed/i);
  assert.match(lineage.content[0].text, /partial/);
  assert.match(lineage.content[0].text, /unresolved/);
  assert.match(lineage.content[0].text, /zero impact/i);
});

await t("data-doc symlink config uses resolved companion base", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-doc-symlink-")));
  mkdirSync(join(root, "project")); mkdirSync(join(root, "contracts"));
  const target = join(root, "contracts", "client.yml");
  writeFileSync(target, "project_name: Test\n");
  symlinkSync(target, join(root, "project", "coop-data-doc.yml"));
  assert.equal(mod.findDataDocConfig(join(root, "project"), {}), target);
});
