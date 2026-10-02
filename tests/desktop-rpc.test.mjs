/**
 * The coop window's Pi process handling (desktop/lib/pi-session.mjs) against a
 * real child process: a scripted stand-in for `pi --mode rpc` that answers
 * commands, asks a dialog, starts a child of its own (as Pi starts MCP
 * servers) and can hang or crash. Closing the window must end Pi and
 * everything it started.
 *
 * Extended lane: real processes, polls and a grace timer.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSession } from "../desktop/lib/pi-session.mjs";

const temp = mkdtempSync(join(tmpdir(), "coop-desktop-rpc-"));
const FAKE = join(temp, "fake-pi.mjs");
writeFileSync(FAKE, `
import { spawn } from "node:child_process";
const mode = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
// A long-lived child, the way Pi starts MCP servers.
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
send({ type: "helper", pid: helper.pid });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.type === "get_state") send({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionName: "x\\u2028y" } });
    if (msg.type === "prompt") {
      send({ type: "extension_ui_request", id: "ask-1", method: "confirm", title: "coop guardrails", message: "Run it?" });
      pending = msg.id;
    }
    if (msg.type === "extension_ui_response") send({ id: pending, type: "response", command: "prompt", success: true, data: { confirmed: msg.confirmed } });
    if (msg.type === "get_tree" && mode === "crash") { process.stderr.write("fatal: the model provider went away\\n"); process.exit(3); }
  }
});
let pending = null;
// Pi ends its children and exits when the window closes its stdin; a hung Pi does not.
process.stdin.on("end", () => { if (mode !== "hang") { helper.kill(); process.exit(0); } });
`);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${String(error && error.stack || error).split("\n").slice(0, 6).join("\n    ")}`);
    failed += 1;
  }
}

function start(mode) {
  const pi = new PiSession({ command: process.execPath, args: [FAKE, mode], cwd: temp, env: process.env, responseTimeoutMs: 10_000 });
  const events = [];
  const helper = new Promise((resolve) => pi.on("event", (event) => { events.push(event); if (event.type === "helper") resolve(event.pid); }));
  pi.start();
  return { pi, events, helper };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function gone(pid, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

await check("a command, a dialog and its answer round-trip through a real process", async () => {
  const { pi, events, helper } = start("normal");
  await helper;
  const state = await pi.request({ type: "get_state" });
  assert.equal(state.data.sessionName, "x y");
  const prompt = pi.request({ type: "prompt", message: "Tidy report.sql" });
  await new Promise((r) => { const t = setInterval(() => { if (pi.openDialogs().length) { clearInterval(t); r(); } }, 20); });
  assert.equal(events.filter((e) => e.type === "extension_ui_request").length, 1);
  assert.ok(pi.answer({ type: "extension_ui_response", id: "ask-1", confirmed: false }));
  assert.deepEqual((await prompt).data, { confirmed: false });
  await pi.stop();
});

await check("closing the window ends a well-behaved Pi and its children", async () => {
  const { pi, helper } = start("normal");
  const helperPid = await helper;
  const exit = new Promise((r) => pi.once("exit", r));
  const started = Date.now();
  await pi.stop({ graceMs: 5000 });
  assert.equal((await exit).code, 0);
  assert.ok(Date.now() - started < 4000, "stop waited for the grace timer");
  assert.ok(await gone(pi.child.pid) && await gone(helperPid));
});

await check("a hung Pi is ended with everything it started after the grace period", async () => {
  const { pi, helper } = start("hang");
  const helperPid = await helper;
  const started = Date.now();
  await pi.stop({ graceMs: 600 });
  assert.ok(Date.now() - started >= 500, "stop did not wait for the grace period");
  assert.ok(await gone(pi.child.pid), "Pi still runs");
  assert.ok(await gone(helperPid), "Pi's child still runs");
});

await check("a crash rejects waiting requests and reports Pi's last words", async () => {
  const { pi, helper } = start("crash");
  const helperPid = await helper;
  const exit = new Promise((r) => pi.once("exit", r));
  await assert.rejects(pi.request({ type: "get_tree" }), /Pi exited/);
  const info = await exit;
  assert.equal(info.code, 3);
  assert.match(info.stderr, /the model provider went away/);
  await pi.stop();
  assert.ok(await gone(helperPid), "the crashed Pi's child still runs");
});

rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} desktop process tests passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
