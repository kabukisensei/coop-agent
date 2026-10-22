import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "coop-bpa-"));
const { default: register } = await import(pathToFileURL(join(process.env.COOP_TEST_DIST, "coop-tools.mjs")).href);
const tools = new Map();
const resultHooks = [];
const calls = [];
let response;
register({
  on(name, handler) { if (name === "tool_result") resultHooks.push(handler); },
  registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); },
  async exec(exe, args, options) {
    calls.push({ exe, args, options });
    if (response instanceof Error) throw response;
    return response;
  },
});
const ctx = { cwd: root, hasUI: false };
const signal = new AbortController().signal;
const invoke = async (params = {}) => {
  const result = await tools.get("bpa_review").execute("test", params, signal, undefined, ctx);
  assert.equal(result.isError, undefined, "execute must use Pi's supported AgentToolResult shape");
  let event = { toolName: "bpa_review", toolCallId: "test", input: params, ...result, isError: false };
  for (const hook of resultHooks) event = { ...event, ...await hook(event, ctx) };
  return event;
};
const contract = (rules, exe = "te") => writeFileSync(join(root, ".coop", "project.yml"),
  `tools:\n  tabular_editor_cli:\n    enabled: true\n    executable_path: '${exe}'\n${rules === undefined ? "" : `    bpa_rules_path: ${rules}\n`}power_bi:\n  semantic_models:\n    - path: Finance.SemanticModel\n`);
const report = (results = [], ruleErrors = 0, code = results.length ? 1 : 0) => ({
  code, stderr: "preview diagnostic", stdout: JSON.stringify({ rulesEvaluated: 33, violations: results.length, ruleErrors, ignoredRules: 0, results }),
});
const finding = (severityLabel) => ({ ruleId: `RULE_${severityLabel}`, ruleName: "Set a format string", severityLabel, objectName: "'Sales'[Amount]" });

try {
  mkdirSync(join(root, ".coop"));
  for (const rules of [undefined, "null", "~", "''", ""]) {
    contract(rules);
    response = report([finding("Error"), finding("Warning"), finding("Info")]);
    const result = await invoke();
    assert.equal(result.isError, false);
    assert.equal(result.details.exitCode, 1); // Findings are advisory, not a process failure.
    assert.deepEqual(result.details.report.summary, { error: 1, warning: 1, info: 1 });
    assert.equal(result.details.report.findings[0].object, "'Sales'[Amount]");
    assert.equal(result.details.report.findings[0].file, join(root, "Finance.SemanticModel"));
    // Pi gives the model the text only, so every finding is in it, errors first.
    const text = result.content[0].text;
    assert.match(text, /^bpa_review: 3 finding\(s\)/);
    assert.ok(text.indexOf("- [error] RULE_Error: Set a format string ('Sales'[Amount])") < text.indexOf("- [warning] RULE_Warning"), text);
    assert.match(text, /- \[info\] RULE_Info: Set a format string \('Sales'\[Amount\]\)/);
    assert.doesNotMatch(text, /in details/);
    assert.deepEqual(calls.at(-1).args, ["bpa", "run", "--model", join(root, "Finance.SemanticModel"), "--output-format", "json", "--non-interactive"]);
    assert.equal(calls.at(-1).options.signal, signal);
  }
  contract("rules/BPARules.json", "te.exe");
  response = report();
  let result = await invoke({ paths: ["Other.SemanticModel"] });
  assert.deepEqual(calls.at(-1).args.slice(-2), ["--rules", join(root, "rules", "BPARules.json")]);
  assert.equal(calls.at(-1).args[3], join(root, "Other.SemanticModel"));
  assert.equal(result.details.report.findings.length, 0);
  assert.equal(result.isError, false);

  response = report([finding("Warning")]);
  result = await invoke({ paths: ["First.SemanticModel", "Second.SemanticModel"] });
  assert.equal(result.details.report.summary.warning, 2);
  assert.deepEqual(result.details.report.findings.map((f) => f.file), [join(root, "First.SemanticModel"), join(root, "Second.SemanticModel")]);

  for (const stdout of ["not JSON", "{}", '{"violations":1,"ruleErrors":0,"results":[]}', '{"violations":1,"ruleErrors":0,"results":[{}]}']) {
    response = { stdout, stderr: "failure diagnostic", code: 2 };
    result = await invoke();
    assert.equal(result.isError, true);
    assert.equal(result.details.reportRejected, true);
    assert.equal(result.details.report, undefined);
    assert.match(result.details.stderr, /failure diagnostic/);
  }
  response = report([], 1);
  result = await invoke();
  assert.equal(result.isError, true);
  assert.equal(result.details.report.ruleErrors, 1);
  response = report([], 0, 1);
  assert.equal((await invoke()).isError, true); // Exit 1 without findings is not a clean review.
  response = report([finding("Error")], 0, 2);
  assert.equal((await invoke()).isError, true);
  response = new Error("Executable missing");
  assert.equal((await invoke()).isError, true);
  for (const hook of resultHooks) {
    const override = await hook({ toolName: "data_doc", isError: false, details: { analysisFailed: true } }, ctx);
    assert.equal(override?.isError, undefined, "BPA hook must not alter other tools");
  }

  // TE CLI 0.7.x findings envelope (the shape 0.7.1.2 prints).
  contract(undefined);
  const modern = (items = [], ruleErrors = 0, code = items.length ? 1 : 0, summary) => {
    const count = (s) => items.filter((f) => f.severity === s).length;
    return {
      code, stderr: "Preview build: expires 2026-10-31. {not json",
      stdout: JSON.stringify({
        command: "bpa run",
        summary: summary || { errors: count("error"), warnings: count("warning"), info: count("info"), total: items.length },
        findings: items, rulesEvaluated: 33, violations: items.length, ruleErrors, ignoredRules: 0,
      }),
    };
  };
  const modernFinding = (severity, code = `CODE_${severity}`) => ({
    severity, source: "bpa", code, message: "Fixture finding", object: "'Example'[Key]", objectType: "Column",
    objectPath: "Example/Key", ruleName: "Fixture rule", category: "Performance", fixable: false,
  });
  response = modern();
  result = await invoke();
  assert.equal(result.isError, false, "zero findings is a clean review");
  assert.deepEqual(result.details.report.summary, { error: 0, warning: 0, info: 0 });
  response = modern([modernFinding("error", "TEST_RULE")]);
  result = await invoke();
  assert.equal(result.isError, false, "exit 1 with findings and no rule errors is an advisory result");
  assert.deepEqual(result.details.report.summary, { error: 1, warning: 0, info: 0 });
  assert.deepEqual(result.details.report.findings[0], {
    rule: "TEST_RULE", severity: "error", file: join(root, "Finance.SemanticModel"), object: "'Example'[Key]",
    message: "Fixture rule: Fixture finding", objectPath: "Example/Key", objectType: "Column", category: "Performance", fixable: false,
  });
  assert.match(result.content[0].text, /- \[error\] TEST_RULE: Fixture rule: Fixture finding \('Example'\[Key\]\)/);
  response = modern([modernFinding("warning"), modernFinding("error"), modernFinding("info")]);
  result = await invoke();
  assert.deepEqual(result.details.report.summary, { error: 1, warning: 1, info: 1 });
  assert.ok(result.content[0].text.indexOf("[error] CODE_error") < result.content[0].text.indexOf("[warning] CODE_warning"));
  response = modern([modernFinding("warning")], 2);
  result = await invoke();
  assert.equal(result.isError, true, "rule errors leave the review incomplete");
  assert.equal(result.details.report.ruleErrors, 2);
  for (const bad of [
    modern([modernFinding("error")], 0, 1, { errors: 0, warnings: 0, info: 0, total: 0 }), // summary disagrees
    { code: 1, stderr: "", stdout: JSON.stringify({ findings: [modernFinding("error")], violations: 2, ruleErrors: 0 }) }, // count disagrees
    { code: 1, stderr: "", stdout: JSON.stringify({ findings: [{ ...modernFinding("error"), code: undefined }], violations: 1, ruleErrors: 0 }) },
    { code: 1, stderr: "", stdout: JSON.stringify({ findings: [modernFinding("fatal")], violations: 1, ruleErrors: 0 }) },
    { code: 1, stderr: "", stdout: JSON.stringify({ findings: [], violations: 0 }) }, // no ruleErrors: partial
    { code: 1, stderr: "", stdout: modern([modernFinding("error")]).stdout.slice(0, 80) }, // cut off
  ]) {
    response = bad;
    result = await invoke();
    assert.equal(result.isError, true, bad.stdout);
    assert.equal(result.details.reportRejected, true);
  }

  contract("rules/BPARules.json", "TabularEditor.exe");
  response = { code: 0, stdout: "Sales: [LEGACY_RULE] (Warning) Add a description", stderr: "" };
  result = await invoke();
  assert.deepEqual(calls.at(-1).args, [join(root, "Finance.SemanticModel"), "-A", join(root, "rules", "BPARules.json"), "-V"]);
  assert.equal(result.details.report.findings[0].rule, "LEGACY_RULE");
  assert.equal(result.details.report.summary.warning, 1);
  contract("null", "TabularEditor.exe");
  const before = calls.length;
  assert.match((await invoke()).content[0].text, /Legacy.*requires bpa_rules_path/);
  assert.equal(calls.length, before);
  console.log("✓ native BPA built-in rules, JSON findings, diagnostics, and legacy compatibility passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
