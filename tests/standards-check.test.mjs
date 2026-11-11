// Master plan SC1: standards_check gives coop's own change a second look in a
// separate model request that sees only the change and the standards articles.
// Bundle built by tests/run.sh (COOP_TEST_DIST); the model is a stub.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectChange, findingsText, parseFindings, standardsForChecker, standardsQuery } from "../lib/standards-check.mjs";
import { identifyTaskDomains } from "../lib/standards.mjs";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist, "COOP_TEST_DIST must be set by tests/run.sh");
const { createStandardsCheck } = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);

// --- the change: a diff for a tracked file, the whole file for a new one -----
const repo = mkdtempSync(join(tmpdir(), "coop-sc1-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
git("init", "-q");
git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
mkdirSync(join(repo, "sql"));
writeFileSync(join(repo, "sql", "load.sql"), "SELECT *\nFROM silver.customer;\n");
writeFileSync(join(repo, "sql", "same.sql"), "SELECT 1;\n");
git("add", "."); git("commit", "-q", "-m", "base");
writeFileSync(join(repo, "sql", "load.sql"), "SELECT *\nFROM silver.customer\nWHERE x = 1;\n");
writeFileSync(join(repo, "sql", "new.sql"), "select a from t\n");

const change = collectChange(["sql/load.sql", "sql/new.sql", "sql/same.sql", "sql/gone.sql"], repo);
assert.deepEqual(change.checked, [{ file: "sql/load.sql", baseline: "git" }, { file: "sql/new.sql", baseline: "new" }]);
assert.match(change.text, /\+WHERE x = 1;/, "tracked file: the diff");
assert.match(change.text, /^ {4}1 {2}select a from t$/m, "new file: numbered lines");
assert.equal(change.skipped.length, 2);
assert.match(change.skipped.join("|"), /same\.sql \(no change against the last commit\)/);
assert.match(change.skipped.join("|"), /gone\.sql \(not found\)/);

// Outside git every line is the change.
const loose = mkdtempSync(join(tmpdir(), "coop-sc1-loose-"));
writeFileSync(join(loose, "draft.sql"), "SELECT 1;\n");
const looseChange = collectChange(["draft.sql"], loose, () => { throw new Error("not a repo"); });
assert.deepEqual(looseChange.checked, [{ file: "draft.sql", baseline: "none" }]);

// --- the standards query lands on the right domains ---------------------------
assert.deepEqual(identifyTaskDomains(standardsQuery(["sql/load.sql"], change.text)), ["sql"]);
assert.ok(identifyTaskDomains(standardsQuery(["Model.SemanticModel/definition/tables/Sales.tmdl"], "")).includes("semantic_model"));
assert.ok(identifyTaskDomains(standardsQuery(["Model.SemanticModel/definition/tables/Sales.tmdl"], "")).includes("dax"));
assert.doesNotMatch(standardsQuery(["a.sql"], "+added line\n context line\n-removed"), /context line|removed/, "only added lines steer article choice");

// --- findings: grounded ones kept, the rest dropped ---------------------------
const records = [{ sections: [{ heading: "SQL Conventions", file: "sql/conventions.md", content: "Never SELECT *." }, { heading: "SQL Layout", content: "Keywords upper case." }, { heading: "empty", content: "" }] }];
const std = standardsForChecker(records);
assert.deepEqual(std.titles, ["SQL Conventions", "SQL Layout"]);
assert.match(std.text, /## SQL Conventions \(sql\/conventions\.md\)\nNever SELECT \*\./);

const answer = "```json\n" + JSON.stringify({ findings: [
  { file: "sql/load.sql", line: 1, article: "SQL Conventions", rule: "No SELECT *", problem: "Lists no columns.", fix: "Name the columns.", introduced: false },
  { file: "new.sql", line: 1, article: "sql layout", rule: "Keyword case", problem: "Lower-case keywords.", fix: "Upper-case them.", introduced: true },
  { file: "sql/load.sql", line: 3, article: "Query Performance Handbook", rule: "x", problem: "invented article" },
  { file: "sql/load.sql", article: "SQL Layout", problem: "no line" },
  { file: "other.sql", line: 2, article: "SQL Layout", problem: "file not in the change" },
] }) + "\n```";
const parsed = parseFindings(answer, { titles: std.titles, files: change.checked.map((c) => c.file) });
assert.equal(parsed.ok, true);
assert.equal(parsed.dropped, 3);
assert.deepEqual(parsed.findings.map((f) => [f.file, f.line, f.article, f.introduced]), [["sql/new.sql", 1, "SQL Layout", true], ["sql/load.sql", 1, "SQL Conventions", false]]);
assert.equal(parseFindings("I could not decide.", { titles: std.titles, files: [] }).ok, false);
assert.equal(parseFindings('Here: {"findings":[]} done', { titles: std.titles, files: [] }).ok, true);

const text = findingsText({ ...parsed, checked: change.checked, skipped: change.skipped, truncated: false, titles: std.titles });
assert.match(text, /^standards_check: 1 problem\(s\) in the change, 1 pre-existing \(2 file\(s\) against 2 article\(s\): SQL Conventions, SQL Layout\)\./);
assert.match(text, /- sql\/new\.sql:1 \[SQL Layout\] Keyword case: Lower-case keywords\. Fix: Upper-case them\./);
assert.match(text, /Pre-existing \(already there before this change/);
assert.match(text, /3 finding\(s\) dropped/);
const clean = findingsText({ findings: [], dropped: 0, checked: change.checked, skipped: [], truncated: false, titles: std.titles });
assert.match(clean, /^standards_check: no standards problems found in the change \(2 file\(s\) against 2 article\(s\)/);
assert.equal(clean.split("\n").length, 1, "a clean check is one line");

// --- the tool: one separate request with only the change and the standards ----
const calls = [];
const deps = (over = {}) => ({
  readSettings: () => ({ transport: "sse", timeoutMs: 1234, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 } }),
  loadComplete: async () => async (model, context, options) => { calls.push({ model, context, options }); return { stopReason: "stop", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: answer }] }; },
  standards: () => ({ records }),
  collect: (files, cwd) => collectChange(files, cwd),
  getThinkingLevel: () => "high",
  ...over,
});
const ctx = (over = {}) => ({
  cwd: repo,
  model: { provider: "openai-codex", id: "gpt-5", api: "openai-codex-responses", reasoning: true },
  modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "tok", headers: { "x-a": "1", "x-gone": null }, baseUrl: "https://chatgpt.example/backend-api" }) },
  ...over,
});
let out = await createStandardsCheck(deps())("id", { files: ["sql/load.sql", "sql/new.sql"] }, undefined, undefined, ctx());
assert.equal(out.details.state, "ok");
assert.equal(out.details.findings.length, 2);
assert.match(out.content[0].text, /^standards_check: 1 problem\(s\) in the change, 1 pre-existing/);
assert.equal(calls.length, 1, "exactly one model request");
const call = calls[0];
assert.equal(call.model.baseUrl, "https://chatgpt.example/backend-api");
assert.equal(call.context.messages.length, 1, "no conversation history reaches the checker");
assert.match(call.context.systemPrompt, /You did not write the change/);
assert.match(call.context.messages[0].content[0].text, /<standards>[\s\S]*Never SELECT \*\.[\s\S]*<\/standards>[\s\S]*<change>[\s\S]*\+WHERE x = 1;/);
assert.equal(call.options.apiKey, "tok");
assert.deepEqual(call.options.headers, { "x-a": "1" });
assert.equal(call.options.transport, "sse");
assert.equal(call.options.reasoning, "high");
assert.equal(call.options.cacheRetention, "none");
assert.equal(call.options.timeoutMs, 1234);
assert.match(String(call.options.sessionId), /^[0-9a-f-]{36}$/, "a fresh routing id, not the session's");

// Every failure leaves the in-context self-check standing and never throws.
const unavailable = async (d, c, why) => {
  const r = await createStandardsCheck(d)("id", { files: ["sql/load.sql"] }, undefined, undefined, c);
  assert.equal(r.details.state, "unavailable", why);
  assert.match(r.content[0].text, /^standards_check unavailable: .*Do the step 7 self-check yourself/, why);
};
await unavailable(deps({ loadComplete: async () => { throw new Error("no such export"); } }), ctx(), "Pi without the seam");
await unavailable(deps(), ctx({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false }) } }), "no sign-in");
await unavailable(deps(), ctx({ model: undefined }), "no model");
await unavailable(deps({ standards: () => ({ records: [] }) }), ctx(), "no articles");
await unavailable(deps({ standards: () => { throw new Error("locked"); } }), ctx(), "standards throw");
await unavailable(deps({ loadComplete: async () => async () => { throw new Error("socket closed"); } }), ctx(), "request throws");
await unavailable(deps({ loadComplete: async () => async () => ({ stopReason: "error", errorMessage: "429" }) }), ctx(), "request errors");
await unavailable(deps({ loadComplete: async () => async () => ({ stopReason: "stop", content: [{ type: "text", text: "Looks fine to me!" }] }) }), ctx(), "prose answer");

out = await createStandardsCheck(deps())("id", { files: [] }, undefined, undefined, ctx());
assert.equal(out.details.state, "no_files");
const before = calls.length;
out = await createStandardsCheck(deps())("id", { files: ["sql/same.sql"] }, undefined, undefined, ctx());
assert.equal(out.details.state, "nothing_to_check");
assert.equal(calls.length, before, "an unchanged file costs no model request");

console.log("✓ standards-check: fresh-context check of the change against the standards");
