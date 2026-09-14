// Runtime (handler-level) tests for the /share-learning nudge in
// extensions/coop-tools. The predicate tests in share-learning.test.mjs cover
// shouldSuggestShareLearning in isolation; the review requires exercising the
// REGISTERED session_start / tool_result / agent_settled handlers, because the
// dedupe-by-toolCallId contract lives in the handler, not the predicate.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
assert.ok(dist && existsSync(join(dist, "coop-tools.mjs")), "COOP_TEST_DIST must contain the bundled coop-tools.mjs");

// Knowledge must be "available" for the nudge: a configured, existing clone.
const tmp = mkdtempSync(join(tmpdir(), "coop-nudge-"));
const coopDir = join(tmp, "coop");
const kbDir = join(tmp, "kb", "incremental-bi");
const workDir = join(tmp, "work");
mkdirSync(join(coopDir, ".coop"), { recursive: true });
mkdirSync(kbDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(
  join(coopDir, ".coop", "config"),
  JSON.stringify({
    schema_version: 1,
    knowledge: { enabled: true, repos: [{ url: "https://example.com/repo.git", local_path: kbDir }] },
  })
);
process.env.COOP_DIR = coopDir;

const mod = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

/** Register a fresh extension instance and capture its handlers + notifications. */
function boot() {
  const handlers = {};
  const notifications = [];
  const api = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerTool: () => {},
    registerCommand: () => {},
  };
  mod.default(api);
  const ctx = {
    cwd: workDir,
    hasUI: false,
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  };
  return { handlers, notifications, ctx };
}

const fail = (toolCallId) => ({ toolCallId, isError: true });
const okResult = (toolCallId) => ({ toolCallId, isError: false });

await t("duplicate delivery of the same failed tool result counts once — no nudge", async () => {
  const { handlers, notifications, ctx } = boot();
  await handlers["session_start"]({}, ctx);
  await handlers["tool_result"](fail("call-1"), ctx);
  await handlers["tool_result"](fail("call-1"), ctx); // replayed delivery
  await handlers["agent_settled"]({}, ctx);
  const nudges = notifications.filter((x) => /team learning/.test(x.message));
  assert.equal(nudges.length, 0, `one distinct failure must not nudge: ${JSON.stringify(notifications)}`);
});

await t("failures across two turns accumulate and nudge exactly once", async () => {
  const { handlers, notifications, ctx } = boot();
  await handlers["session_start"]({}, ctx);
  await handlers["before_agent_start"]({ prompt: "first turn", systemPrompt: "base" }, ctx);
  await handlers["tool_result"](fail("call-a"), ctx);
  await handlers["agent_settled"]({}, ctx);
  assert.equal(notifications.filter((x) => /team learning/.test(x.message)).length, 0, "one failure: no nudge yet");
  await handlers["before_agent_start"]({ prompt: "second turn", systemPrompt: "base" }, ctx);
  await handlers["tool_result"](fail("call-b"), ctx);
  await handlers["agent_settled"]({}, ctx);
  const nudges = notifications.filter((x) => /team learning/.test(x.message));
  assert.equal(nudges.length, 1, `two distinct failures across turns: exactly one nudge: ${JSON.stringify(notifications)}`);
});

await t("the nudge fires once per session even after further failures", async () => {
  const { handlers, notifications, ctx } = boot();
  await handlers["session_start"]({}, ctx);
  await handlers["tool_result"](fail("call-1"), ctx);
  await handlers["tool_result"](fail("call-2"), ctx);
  await handlers["agent_settled"]({}, ctx);
  await handlers["tool_result"](fail("call-3"), ctx);
  await handlers["agent_settled"]({}, ctx);
  const nudges = notifications.filter((x) => /team learning/.test(x.message));
  assert.equal(nudges.length, 1, `once-per-session notification: ${JSON.stringify(notifications)}`);
});

await t("a new session resets the tally and the nudge can fire again", async () => {
  const { handlers, notifications, ctx } = boot();
  await handlers["session_start"]({}, ctx);
  await handlers["tool_result"](fail("call-1"), ctx);
  await handlers["tool_result"](fail("call-2"), ctx);
  await handlers["agent_settled"]({}, ctx);
  assert.equal(notifications.filter((x) => /team learning/.test(x.message)).length, 1, "nudge in first session");
  await handlers["session_start"]({}, ctx); // fresh session
  await handlers["tool_result"](fail("call-9"), ctx);
  await handlers["agent_settled"]({}, ctx);
  assert.equal(notifications.filter((x) => /team learning/.test(x.message)).length, 1, "one failure in new session: no nudge");
  await handlers["tool_result"](fail("call-10"), ctx);
  await handlers["agent_settled"]({}, ctx);
  const nudges = notifications.filter((x) => /team learning/.test(x.message));
  assert.equal(nudges.length, 2, `fresh session tallies independently: ${JSON.stringify(notifications)}`);
});

await t("dedup does not disturb daily-log bookkeeping; both checks run at settle", async () => {
  const { handlers, notifications, ctx } = boot();
  // Contract requires a daily task log under the work dir.
  mkdirSync(join(workDir, ".coop"), { recursive: true });
  writeFileSync(
    join(workDir, ".coop", "project.yml"),
    "profile:\n  timezone: 'America/Chicago'\nlogging:\n  daily_log_path: 'work/logs/{yyyy-mm-dd}.md'\n  require_task_log: true\n"
  );
  await handlers["session_start"]({}, ctx);
  await handlers["before_agent_start"]({ prompt: "log the work", systemPrompt: "base" }, ctx);
  // A failing tool result replayed twice must count once...
  await handlers["tool_call"]({ toolName: "bash", input: { command: "npm test" }, toolCallId: "tc-1" }, ctx);
  await handlers["tool_result"](fail("tc-1"), ctx);
  await handlers["tool_result"](fail("tc-1"), ctx);
  // ...and a successful log write still marks the daily log touched. The
  // required log path is work/logs/<YYYY-MM-DD> rendered in the contract's
  // timezone (profile.timezone: America/Chicago), so the satisfying write must
  // target exactly that path — any other path is merely "meaningful" work.
  const chicagoDate = (() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const v = (type) => parts.find((p) => p.type === type)?.value || "";
    return `${v("year")}-${v("month")}-${v("day")}`;
  })();
  await handlers["tool_call"]({ toolName: "write", input: { path: `work/logs/${chicagoDate}.md` }, toolCallId: "tc-2" }, ctx);
  await handlers["tool_result"](okResult("tc-2"), ctx);
  await handlers["agent_settled"]({}, ctx);
  const nudges = notifications.filter((x) => /team learning/.test(x.message));
  const missing = notifications.filter((x) => /daily log missing|wasn't updated/.test(x.message));
  // The replayed failure counts ONCE, so the tally is 1 — below the >= 2
  // nudge threshold (see shouldSuggestShareLearning). Had dedup been broken
  // the replay would have tallied 2 and a nudge WOULD have fired, so 0
  // nudges here proves both the dedup and the threshold.
  assert.equal(nudges.length, 0, `one deduped failure is below the nudge threshold: ${JSON.stringify(notifications)}`);
  assert.equal(missing.length, 0, `daily log satisfied — no missing-log warning: ${JSON.stringify(notifications)}`);
  rmSync(join(workDir, ".coop"), { recursive: true, force: true });
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\nlearning-nudge-runtime: ${n} runtime tests passed`);
