// Tests for extensions/coop-guardrails — drives the REAL tool_call handler with a
// mock pi/ctx (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";

const dist = process.env.COOP_TEST_DIST;
const coopGuardrails = (await import(`${dist}/coop-guardrails.mjs`)).default;

// Capture the handler the extension registers.
let staged = "";
let confirmAnswer = false;
const handlers = {};
const cmds = {};
const pi = {
  on: (ev, h) => (handlers[ev] = h),
  registerCommand: (name, opts) => (cmds[name] = opts),
  exec: async (bin, args) =>
    bin === "git" && args.join(" ").includes("diff --cached")
      ? { stdout: staged, code: 0, stderr: "" }
      : { stdout: "", code: 0, stderr: "" },
};
coopGuardrails(pi);
const handle = handlers["tool_call"];
assert.ok(typeof handle === "function", "registers a tool_call handler");
assert.ok(cmds["coop-guardrails"], "registers the /coop-guardrails command");

const ctx = { cwd: "/tmp/no-such-repo-xyz", hasUI: true, ui: { confirm: async () => confirmAnswer, notify: () => {} } };
const call = async (command, { stagedFiles = "", confirm = false, toolName = "bash" } = {}) => {
  staged = stagedFiles;
  confirmAnswer = confirm;
  return await handle({ toolName, input: { command } }, ctx);
};
const blocked = (r) => !!(r && r.block);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

await t("blocks git commit when source is staged", async () => {
  assert.equal(blocked(await call("git commit -m wip", { stagedFiles: "docs/a.md\nsql/gold/v.sql" })), true);
});
await t("allows a docs-only git commit", async () => {
  assert.equal(blocked(await call("git commit -m docs", { stagedFiles: "docs/a.md\nsite/i.html" })), false);
});
await t("allows git commit with nothing staged", async () => {
  assert.equal(blocked(await call("git commit -m x", { stagedFiles: "" })), false);
});
await t("blocks a declined destructive command (rm -rf)", async () => {
  assert.equal(blocked(await call("rm -rf /tmp/x", { confirm: false })), true);
});
await t("allows an approved destructive command", async () => {
  assert.equal(blocked(await call("rm -rf /tmp/x", { confirm: true })), false);
});
await t("blocks declined git push --force", async () => {
  assert.equal(blocked(await call("git push --force origin main", { confirm: false })), true);
});
await t("allows a safe command (ls)", async () => {
  assert.equal(blocked(await call("ls -la")), false);
});
await t("ignores non-bash tools", async () => {
  assert.equal(blocked(await handle({ toolName: "read", input: { path: "x" } }, ctx)), false);
});
await t("COOP_NO_GUARDRAILS=1 disables enforcement", async () => {
  process.env.COOP_NO_GUARDRAILS = "1";
  const r = await call("git commit -m x", { stagedFiles: "sql/v.sql" });
  delete process.env.COOP_NO_GUARDRAILS;
  assert.equal(blocked(r), false);
});

console.log(`  ${n} guardrails tests passed`);
