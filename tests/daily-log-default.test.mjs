// Tests for contract-driven default daily logging and its quiet completion check.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const {
  default: coopTools,
  dailyLogOptOut,
  dailyLogSystemInstruction,
  dailyLogToolEffect,
  requiredDailyLog,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

function writeContract(root, required = true) {
  mkdirSync(join(root, ".coop"), { recursive: true });
  writeFileSync(join(root, ".coop", "project.yml"), `profile:
  timezone: 'America/Chicago'
logging:
  daily_log_path: 'work/logs/{yyyy-mm-dd}.md'
  require_task_log: ${required}
`);
}

await t("nearest contract resolves its timezone-aware daily path", () => {
  const root = mkdtempSync(join(tmpdir(), "coop-daily-path-"));
  const child = join(root, "src", "nested");
  mkdirSync(child, { recursive: true });
  writeContract(root);
  const requirement = requiredDailyLog(child, new Date("2026-01-02T03:00:00Z"));
  assert.ok(requirement);
  assert.equal(requirement.date, "2026-01-01");
  assert.equal(requirement.displayPath, "work/logs/2026-01-01.md");
  assert.match(dailyLogSystemInstruction(requirement), /NON-SKIPPABLE/);
  assert.match(dailyLogSystemInstruction(requirement), /daily-logger skill/);
});

await t("tool classifier ignores reads and recognizes work plus the log write", () => {
  const root = "/work/project";
  const log = "/work/project/docs/agent/logs/daily/2026-01-01.md";
  assert.equal(dailyLogToolEffect("read", { path: "README.md" }, root, log), "none");
  assert.equal(dailyLogToolEffect("data_doc", { command: "lineage" }, root, log), "none");
  assert.equal(dailyLogToolEffect("sql_review", {}, root, log), "meaningful");
  assert.equal(dailyLogToolEffect("edit", { path: "src/app.ts" }, root, log), "meaningful");
  assert.equal(dailyLogToolEffect("write", { path: log }, root, log), "log");
  assert.equal(dailyLogToolEffect("bash", { command: "npm test" }, root, log), "meaningful");
  assert.equal(dailyLogToolEffect("bash", { command: `sed -n '1,20p' ${log}` }, root, log), "none");
  assert.equal(dailyLogOptOut("Do not log this task, please."), true);
  assert.equal(dailyLogOptOut("Do not log secrets or tokens."), false);
  assert.equal(dailyLogOptOut("Why didn't Coop log this task?"), false);
});

await t("runtime prompts every enabled turn and warns only after unlogged work", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-daily-runtime-"));
  writeContract(root);
  const handlers = new Map();
  const notices = [];
  const statuses = [];
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (name, handler) => handlers.set(name, handler),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage: () => {},
  };
  coopTools(pi);
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
  };
  const before = () => handlers.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  const call = (toolCallId, toolName, input) => handlers.get("tool_call")({ toolCallId, toolName, input }, ctx);
  const result = (toolCallId, isError = false) => handlers.get("tool_result")({ toolCallId, isError }, ctx);
  const settle = () => handlers.get("agent_settled")({}, ctx);

  const first = await before();
  assert.match(first.systemPrompt, /^BASE/);
  assert.match(first.systemPrompt, /daily-logger/);
  await call("read-1", "read", { path: "README.md" });
  await result("read-1");
  await settle();
  assert.equal(notices.length, 0, "read-only Q&A must stay quiet");

  await before();
  await call("edit-1", "edit", { path: "src/app.ts" });
  await result("edit-1");
  await settle();
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /Required daily log wasn't updated/);
  const requirement = requiredDailyLog(root);
  assert.deepEqual(statuses.at(-1), { key: "coop-daily-log", text: `daily log missing · ${requirement.date}` });

  await before();
  const logPath = requirement.logPath;
  await call("edit-2", "edit", { path: "src/app.ts" });
  await result("edit-2");
  await call("log-1", "write", { path: logPath });
  await result("log-1");
  await settle();
  assert.equal(notices.length, 1, "logged work must not add a warning");
  assert.deepEqual(statuses.at(-1), { key: "coop-daily-log", text: undefined });

  await handlers.get("before_agent_start")({ systemPrompt: "BASE", prompt: "Skip the daily log for this task." }, ctx);
  await call("edit-3", "edit", { path: "src/opted-out.ts" });
  await result("edit-3");
  await settle();
  assert.equal(notices.length, 1, "an explicit per-task opt-out must stay quiet");
});

await t("disabled contract injects no logging instruction", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-daily-disabled-"));
  writeContract(root, false);
  assert.equal(requiredDailyLog(root), null);
  const handlers = new Map();
  coopTools({
    registerTool: () => {},
    registerCommand: () => {},
    on: (name, handler) => handlers.set(name, handler),
  });
  const result = await handlers.get("before_agent_start")(
    { systemPrompt: "BASE" },
    { cwd: root, ui: { setStatus: () => {} } },
  );
  assert.equal(result, undefined);
});

console.log(`  ${n} daily-log-default tests passed`);
