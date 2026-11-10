// Tests for /feedback and `coop feedback` (lib/feedback.mjs, lib/feedback-cli.mjs
// and runFeedback in coop-tools; Aaron, 2026-11-10). The point of the feature is
// client data isolation: these tests pin what is redacted, that the person's
// edits are redacted again, that nothing leaves without their go, and that only
// a github.com page on the configured repository is ever opened.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "coop-feedback-")));
process.env.COOP_DIR = join(tmp, "home");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
delete process.env.COOP_FEEDBACK_REPO;
delete process.env.COOP_PROJECT_YML;
const profile = join(tmp, "home", ".coop");
mkdirSync(profile, { recursive: true });

const f = await import("../lib/feedback.mjs");

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

const CONTRACT = `profile:
  organization: "Cooptimize"
  client: "Contoso Retail"
repositories:
  contoso_sql:
    role: "sql"
    local_path: "../contoso-sql"
    agent_allowed_to_commit:
      - "docs/**"
fabric:
  default_workspace_name: "Contoso Dev"
  warehouse_names: ["ContosoWH", "TODO: warehouse"]
  layout: "warehouse"
sql_targets:
  dev:
    kind: azure_sql
    server: "contoso-dev.database.windows.net"
    database: "SalesDW"
`;
const clientDir = join(tmp, "Contoso");
mkdirSync(join(clientDir, "home", ".coop"), { recursive: true });
const contractPath = join(clientDir, "home", ".coop", "project.yml");
writeFileSync(contractPath, CONTRACT);

await check("the repository is Cooptimize/coop-feedback unless the config or environment names another owner/name", () => {
  const config = join(tmp, "config.json");
  assert.equal(f.feedbackRepo({}, join(tmp, "missing")), "Cooptimize/coop-feedback");
  writeFileSync(config, JSON.stringify({ feedback: { repo: "Cooptimize/coop-issues" } }));
  assert.equal(f.feedbackRepo({}, config), "Cooptimize/coop-issues");
  assert.equal(f.feedbackRepo({ COOP_FEEDBACK_REPO: "kabukisensei/coop-feedback" }, config), "kabukisensei/coop-feedback");
  for (const bad of ["https://evil.example/x", "a/b/c", "../x", "owner/name?x=1"]) assert.equal(f.feedbackRepo({ COOP_FEEDBACK_REPO: bad }, join(tmp, "missing")), "Cooptimize/coop-feedback", bad);
});

await check("project file terms: the client, repositories, folders, servers, databases, workspaces and items; never coop's own words", () => {
  const terms = f.projectFileTerms(CONTRACT);
  for (const term of ["Contoso Retail", "contoso_sql", "../contoso-sql", "contoso-sql", "Contoso Dev", "ContosoWH", "contoso-dev.database.windows.net", "SalesDW"]) assert.ok(terms.includes(term), term);
  for (const term of ["Cooptimize", "sql", "warehouse", "azure_sql", "docs/**", "TODO: warehouse", "main"]) assert.ok(!terms.includes(term), term);
});

const names = f.collectRedactionTerms({ projectFiles: [contractPath], cwd: clientDir });
names.user = "jdoe"; names.machine = "CONTOSO-VM7";

await check("redaction: names, paths, emails, ids, servers, links and secrets in the person's words; ordinary words stay", () => {
  const { text, counts } = f.redactText("Contoso Retail's SalesDW in C:\\Users\\jdoe\\Contoso\\x.sql on contoso-dev.database.windows.net failed for jdoe@contoso.com (id 0c1f1e2a-1111-2222-3333-444455556666) see https://app.fabric.microsoft.com/groups/1 and https://github.com/Cooptimize/coop-feedback/issues/3 token=abc123 on CONTOSO-VM7. I asked coop to create a view from the sales table in Fabric.", names);
  for (const leak of ["Contoso", "SalesDW", "jdoe", "Users", "contoso-dev", "0c1f1e2a", "app.fabric", "abc123", "CONTOSO-VM7"]) assert.ok(!text.includes(leak), `${leak} leaked: ${text}`);
  assert.match(text, /https:\/\/github\.com\/Cooptimize\/coop-feedback\/issues\/3/, "a link to a coop repository stays");
  assert.match(text, /create a view from the sales table in Fabric/, "the person's own description of the problem stays readable");
  assert.ok(counts["client name"] >= 1 && counts.path >= 1 && counts.secret >= 1);
});

await check("redaction of error messages also drops SQL, bracketed and quoted names", () => {
  const { text } = f.redactText("Invalid object name 'dbo.Orders'. SELECT o.Id FROM dbo.Orders o WHERE o.Total > 5\nlocked [sales].[Customer]\nconnection: Server=tcp:x,1433;Database=Prod;User ID=svc;Password=hunter2", names, { machine: true });
  for (const leak of ["Orders", "Total", "Customer", "hunter2", "Prod", "svc"]) assert.ok(!text.includes(leak), `${leak} leaked: ${text}`);
  assert.match(text, /<sql omitted>/);
});

await check("session errors: failed model calls and failed tool calls only, newest five, one line each", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "SELECT secret FROM client" } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "client answer" }] } },
    ...Array.from({ length: 6 }, (_, i) => ({ type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: `failure ${i}\nsecond line` }] } })),
    { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests\nmore" } },
  ];
  const errors = f.sessionErrors(branch);
  assert.equal(errors.length, 5);
  assert.equal(errors.at(-1), "model: 429 Too Many Requests");
  assert.ok(!errors.some((e) => /client|second line/.test(e)), "no conversation text, one line each");
});

await check("the report: the person's words, coop's facts, redacted errors; split and URL round-trip", () => {
  const report = f.buildReport({ kind: "bug", title: "SalesDW deploy failed", description: "It broke in C:\\work\\Contoso", facts: { coop: "0.40.1", pi: "1.5.0", surface: "window", os: "Windows 11", node: "v22", model: "openai-codex/gpt-5" }, errors: ["sql: Invalid column 'Margin'"], names });
  assert.equal(report.title, "<name> deploy failed");
  assert.match(report.body, /coop 0\.40\.1, Pi 1\.5\.0, in the window/);
  assert.match(report.body, /Invalid column '<name>'/);
  assert.match(report.body, /coop removed .* before this preview/);
  assert.ok(!/Contoso|SalesDW|Margin/.test(report.body));
  const split = f.splitPreview(`# ${report.title}\n\n${report.body}`);
  assert.equal(split.title, report.title);
  assert.equal(split.body, report.body.trim());
  const { url, cut } = f.issueUrl({ repo: "Cooptimize/coop-feedback", kind: "bug", title: report.title, body: report.body });
  assert.equal(cut, false);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://github.com/Cooptimize/coop-feedback/issues/new");
  assert.equal(parsed.searchParams.get("body"), report.body);
  assert.equal(parsed.searchParams.get("labels"), "bug,from-coop");
  const long = f.issueUrl({ repo: "Cooptimize/coop-feedback", title: "t", body: "x".repeat(20000) });
  assert.ok(long.cut && long.url.length <= f.MAX_URL_LENGTH);
  assert.match(new URL(long.url).searchParams.get("body"), /full report is on your clipboard/);
});

await check("delivery saves under ~/.coop/reports, copies, and opens only a github.com page", () => {
  const opened = [];
  const copied = [];
  const result = f.deliverReport({ repo: "Cooptimize/coop-feedback", kind: "idea", title: "T", body: "B", open: (url) => { opened.push(url); return true; }, copy: (text) => { copied.push(text); return true; } });
  assert.ok(result.file.startsWith(join(profile, "reports")), result.file);
  assert.equal(readFileSync(result.file, "utf8"), "# T\n\nB\n");
  assert.deepEqual(copied, ["# T\n\nB\n"]);
  assert.match(opened[0], /^https:\/\/github\.com\/Cooptimize\/coop-feedback\/issues\/new\?/);
  assert.equal(f.openInBrowser("https://evil.example/x"), false);
  assert.equal(f.openInBrowser("file:///C:/x"), false);
});

await check("coop feedback --print: the redacted preview and the link, nothing saved or opened", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "lib", "feedback-cli.mjs"), "--print", "--kind", "idea", "--title", "Contoso wants dark mode", "--description", "for SalesDW"], { cwd: join(clientDir, "home"), env: { ...process.env, COOP_PROJECT_YML: contractPath }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# <client> wants dark mode/);
  assert.match(r.stdout, /in the shell/);
  assert.ok(!/SalesDW|Contoso/.test(r.stdout), r.stdout);
  assert.match(r.stdout, /https:\/\/github\.com\/Cooptimize\/coop-feedback\/issues\/new\?/);
  const bad = spawnSync(process.execPath, [join(ROOT, "lib", "feedback-cli.mjs"), "--print", "--kind", "rant", "--title", "x"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

const dist = process.env.COOP_TEST_DIST;
if (dist) {
  const tools = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
  const notices = [];
  const fakeCtx = (answers) => ({
    hasUI: true,
    cwd: join(clientDir, "home"),
    model: { provider: "openai-codex", id: "gpt-5" },
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "fabric_sql_query", isError: true, content: [{ type: "text", text: "Invalid object name 'SalesDW.dbo.Orders'." }] } }] },
    ui: {
      select: async () => answers.select,
      input: async () => answers.input,
      editor: async (title, prefill) => { answers.editors.push({ title, prefill }); return answers.editorReplies.shift(); },
      confirm: async () => answers.confirm,
      notify: (message, type) => notices.push({ message, type }),
    },
  });
  const env = { ...process.env, COOP_PROJECT_YML: contractPath };

  await check("/feedback: the preview is redacted, the person's edits are redacted again, and the browser opens only after their yes", async () => {
    const answers = { select: f.KINDS[0].label, input: "SalesDW deploy failed", confirm: true, editors: [], editorReplies: ["It broke for Contoso Retail.", undefined] };
    const delivered = [];
    const deliver = (args) => { delivered.push(args); return { file: join(profile, "reports", "x.md"), copied: true, opened: true, url: "", cut: false }; };
    // The preview reply is filled in once the first editor call has shown the preview.
    const ctx = fakeCtx(answers);
    const editor = ctx.ui.editor;
    ctx.ui.editor = async (title, prefill) => {
      const reply = await editor(title, prefill);
      if (answers.editors.length === 2) return `${prefill}\n\nAlso pasted back: SalesDW on contoso-dev.database.windows.net`;
      return reply;
    };
    await tools.runFeedback(ctx, "", { deliver, env });
    const preview = answers.editors[1].prefill;
    assert.match(answers.editors[1].title, /Cooptimize\/coop-feedback/);
    assert.ok(!/Contoso|SalesDW|Orders/.test(preview), preview);
    assert.match(preview, /fabric_sql_query: Invalid object name '<name>'/);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].repo, "Cooptimize/coop-feedback");
    assert.equal(delivered[0].kind, "bug");
    assert.ok(!/SalesDW|contoso-dev/.test(delivered[0].body), "an edit that pastes a name back in is redacted again");
    assert.match(notices.at(-1).message, /press Submit/);
  });

  await check("/feedback: No at the last step, or Cancel anywhere, sends nothing", async () => {
    for (const answers of [
      { select: f.KINDS[1].label, input: "x", confirm: false, editors: [], editorReplies: ["words", "# x\n\nbody"] },
      { select: undefined, input: "x", confirm: true, editors: [], editorReplies: [] },
      { select: f.KINDS[2].label, input: "x", confirm: true, editors: [], editorReplies: [undefined] },
    ]) {
      let called = false;
      await tools.runFeedback(fakeCtx(answers), "", { deliver: () => { called = true; return {}; }, env });
      assert.equal(called, false);
      assert.match(notices.at(-1).message, /No feedback sent/);
    }
    await tools.runFeedback({ hasUI: false, ui: { notify: (m) => notices.push({ message: m }) } }, "", { env });
    assert.match(notices.at(-1).message, /coop feedback/);
  });
}

console.log(`  ${n} feedback tests passed`);
