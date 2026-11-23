#!/usr/bin/env node
// The dev-VM test approver: a HOST script that runs coop in Pi's RPC mode and
// answers the guardrails' yes/no questions itself, so a scripted check can drive
// an approval-gated flow on the development VM without a person at the desk.
//
// It is development tooling under tests/, never installed or shipped (the
// installer snapshot test keeps tests/ out), and it changes nothing in coop or
// the guardrails: coop asks exactly as it does in the window, and this process
// is the one answering. It answers only when ALL THREE hold, checked before Pi
// starts and again before every answer:
//   1. the environment sets COOP_TEST_APPROVER=1;
//   2. a marker file OUTSIDE ANY GIT REPOSITORY names this machine
//      (default C:\ProgramData\coop\test-approver.json on Windows,
//      /etc/coop/test-approver.json elsewhere): {"machine": "<hostname>",
//      "client": "<the fake-data client>"};
//   3. the nearest .coop/project.yml above the working folder names that same
//      client in profile.client.
// It answers the two shapes the guardrails ask in: a yes/no confirm (yes), and
// the write question's three-option select ("Allow once" / "Allow ... edits for
// this session" / "Decline"), where it picks "Allow once" and never the
// session-wide option, so every later write asks again.
// A question that says PRODUCTION is always declined: the approver never stands
// in for a person at a production write, and the human unlock stays a person's.
// Every answer it gives is one row in guardrails-audit.jsonl (the same file the
// guardrails write), kind "test-approver", detail "test-approver", with no
// question text and no command text: the row names the dialog's kind (confirm,
// select), never its title, which carries the statement about to run.
//
// Usage (on the dev VM, from the client folder):
//   coop desktop --print-spec > spec.json
//   $env:COOP_TEST_APPROVER = '1'
//   node tests\test-approver.mjs --spec spec.json --prompt "..." [--prompt "..."] [--marker <path>] [--timeout <ms>]
// Pi's events stream to stdout as JSON lines; each prompt is sent once the run
// the one before it started has finished, and Pi is stopped after the last run
// ends. The exit code is 0 when every prompt ran to its end, 2 when a gate
// refused, 1 on a Pi failure or a run that outlasted --timeout.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseSpec, piArgv, piEnv } = await import(pathToFileURL(join(ROOT, "desktop", "lib", "spec.mjs")).href);
const { PiSession } = await import(pathToFileURL(join(ROOT, "desktop", "lib", "pi-session.mjs")).href);
const { projectYamlScalar } = await import(pathToFileURL(join(ROOT, "lib", "project-contract.mjs")).href);
const { agentDir } = await import(pathToFileURL(join(ROOT, "lib", "paths.mjs")).href);

export const PRODUCTION = /\bPRODUCTION\b/;

// The write question's own option labels (extensions/coop-guardrails/index.ts:
// APPROVE_ONCE, APPROVE_DECLINE); the test keeps these equal to the source.
export const APPROVE_ONCE = "Allow once";
export const APPROVE_DECLINE = "Decline";

/** How long after a prompt is accepted a run may take to start before the prompt
 *  counts as handled without one (a slash command starts no run). */
export const RUN_START_MS = 2000;

/** The marker file's default place: outside every repository, machine-wide. */
export function defaultMarkerPath(env = process.env, os = platform()) {
  if (os === "win32") return join(env.ProgramData || "C:\\ProgramData", "coop", "test-approver.json");
  return "/etc/coop/test-approver.json";
}

/** True when `path` or any folder above it holds a .git entry. */
export function insideGitRepository(path) {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The nearest .coop/project.yml at or above `cwd`, or "". */
export function nearestProjectFile(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".coop", "project.yml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

const fold = (value) => String(value || "").trim().toLowerCase();

/**
 * The three gates. Returns { ok: true, client, marker } or { ok: false, reason }.
 * Pure given its inputs so the gate can be tested without a machine or a Pi.
 */
export function checkGates({ env = process.env, markerPath = defaultMarkerPath(env), machine = hostname(), cwd = process.cwd(), readFile = (p) => readFileSync(p, "utf8") } = {}) {
  if (env.COOP_TEST_APPROVER !== "1") return { ok: false, reason: "COOP_TEST_APPROVER is not 1" };
  if (!existsSync(markerPath)) return { ok: false, reason: `no marker file at ${markerPath}` };
  if (insideGitRepository(dirname(markerPath))) return { ok: false, reason: `the marker file ${markerPath} is inside a git repository; it must live outside every repo` };
  let marker;
  try { marker = JSON.parse(readFile(markerPath)); } catch { return { ok: false, reason: `the marker file ${markerPath} is not JSON` }; }
  if (!marker || typeof marker !== "object" || !fold(marker.machine) || !fold(marker.client)) {
    return { ok: false, reason: `the marker file ${markerPath} must name "machine" and "client"` };
  }
  if (fold(marker.machine) !== fold(machine)) return { ok: false, reason: `the marker file names machine "${marker.machine}", this is "${machine}"` };
  const projectFile = nearestProjectFile(cwd);
  if (!projectFile) return { ok: false, reason: `no .coop/project.yml at or above ${cwd}` };
  let client = "";
  try { client = projectYamlScalar(readFile(projectFile), ["profile", "client"]); } catch { /* unreadable: no client */ }
  if (!fold(client)) return { ok: false, reason: `${projectFile} names no profile.client` };
  if (fold(client) !== fold(marker.client)) return { ok: false, reason: `${projectFile} names client "${client}", the marker file names "${marker.client}"` };
  return { ok: true, client, marker: markerPath, projectFile };
}

/**
 * The answer to one extension_ui_request, or null for a request that is not a
 * dialog. A confirm is "yes" and the guardrails' write question (a select that
 * offers both "Allow once" and "Decline") is "Allow once", unless the question
 * says PRODUCTION; every other dialog (any other select, input, editor) is
 * cancelled so the run never waits on a person. The session-wide option is
 * never picked. PRODUCTION is looked for in the title and message only: the
 * session option's own label says "production always asks" on every question.
 */
export function answerFor(request) {
  if (!request || request.type !== "extension_ui_request") return null;
  const base = { type: "extension_ui_response", id: request.id };
  const text = `${request.title || ""}\n${request.message || ""}`;
  if (request.method === "confirm") {
    if (PRODUCTION.test(text)) return { response: { ...base, cancelled: true }, decision: "declined", label: "production" };
    return { response: { ...base, confirmed: true }, decision: "allowed", label: "approval" };
  }
  const options = Array.isArray(request.options) ? request.options : [];
  if (request.method === "select" && options.includes(APPROVE_ONCE) && options.includes(APPROVE_DECLINE)) {
    if (PRODUCTION.test(text)) return { response: { ...base, cancelled: true }, decision: "declined", label: "production" };
    return { response: { ...base, value: APPROVE_ONCE }, decision: "allowed", label: "approval" };
  }
  if (["select", "input", "editor"].includes(request.method)) return { response: { ...base, cancelled: true }, decision: "declined", label: request.method };
  return null;
}

const DIALOG_KINDS = ["confirm", "select", "input", "editor"];

/**
 * One audit row in the guardrails' own file; no question or command text.
 * `dialog` is the request's method and is written only when it is one of the
 * four dialog kinds; a title is never written, because the guardrails put the
 * statement about to run in it.
 */
export function auditAnswer({ cwd, decision, label, dialog }, env = process.env, append = appendFileSync) {
  try {
    const path = join(agentDir(env), "guardrails-audit.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const tool = DIALOG_KINDS.includes(dialog) ? dialog : "dialog";
    append(path, JSON.stringify({ ts: new Date().toISOString(), cwd, kind: "test-approver", tool, decision, label, detail: "test-approver", pid: process.pid }) + "\n");
  } catch { /* logging never changes the answer; the row is best-effort like the guardrails' own */ }
}

function parseArgs(argv) {
  const options = { spec: "", prompts: [], marker: "", timeout: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--spec") options.spec = argv[++i] || "";
    else if (arg === "--prompt") options.prompts.push(argv[++i] || "");
    else if (arg === "--marker") options.marker = argv[++i] || "";
    else if (arg === "--timeout") options.timeout = Number(argv[++i]) || 0;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.spec) throw new Error("--spec <file> is required (coop desktop --print-spec > spec.json)");
  if (!options.prompts.length) throw new Error("at least one --prompt is required");
  return options;
}

/** Run the prompts against Pi, answering dialogs; resolves with the exit code. */
export async function run(options, { env = process.env, machine = hostname(), out = process.stdout, err = process.stderr } = {}) {
  const spec = parseSpec(readFileSync(options.spec, "utf8"));
  const gate = () => checkGates({ env, markerPath: options.marker || defaultMarkerPath(env), machine, cwd: spec.cwd });
  const first = gate();
  if (!first.ok) { err.write(`test approver: refused: ${first.reason}\n`); return 2; }
  err.write(`test approver: on for client "${first.client}" (${first.projectFile}; marker ${first.marker})\n`);
  const { command, args } = piArgv(spec);
  const pi = new PiSession({ command, args, cwd: spec.cwd, env: piEnv(spec, env) });
  const exited = new Promise((resolve) => pi.on("exit", resolve));
  // Pi answers a prompt as soon as its run starts, so the run's end is read from
  // the events: agent_start opens it, agent_end closes it.
  let running = false;
  let wake = () => {};
  const changed = () => new Promise((resolve) => { wake = resolve; });
  pi.on("exit", () => wake());
  pi.on("event", (message) => {
    out.write(JSON.stringify(message) + "\n");
    if (message.type === "agent_start") { running = true; wake(); }
    if (message.type === "agent_end") { running = false; wake(); }
    const answer = answerFor(message);
    if (!answer) return;
    // The gates again, so a marker or project file changed mid-run stops the answers.
    const again = gate();
    if (!again.ok) {
      err.write(`test approver: gate failed mid-run (${again.reason}); cancelling the question\n`);
      pi.answer({ type: "extension_ui_response", id: message.id, cancelled: true });
      auditAnswer({ cwd: spec.cwd, decision: "declined", label: "gate-failed", dialog: message.method }, env);
      return;
    }
    pi.answer(answer.response);
    auditAnswer({ cwd: spec.cwd, decision: answer.decision, label: answer.label, dialog: message.method }, env);
    err.write(`test approver: ${answer.decision} (${answer.label})\n`);
  });
  pi.on("protocol-error", (text) => err.write(`test approver: ${text}\n`));
  pi.start();
  let code = 0;
  try {
    for (const prompt of options.prompts) {
      const response = await pi.request({ type: "prompt", message: prompt }, { timeoutMs: options.timeout });
      if (!response.success) { err.write(`test approver: prompt failed: ${response.error || "unknown error"}\n`); code = 1; break; }
      // Wait for the run this prompt started to end. A prompt that starts none
      // within RUN_START_MS (a slash command) is done already.
      const deadline = options.timeout > 0 ? Date.now() + options.timeout : Infinity;
      const within = (ms) => new Promise((resolve) => { const timer = setTimeout(() => resolve("timeout"), Math.min(ms, 2 ** 31 - 1)); changed().then(() => { clearTimeout(timer); resolve("changed"); }); });
      if (!running && !pi.exited) await within(RUN_START_MS);
      let late = false;
      while (running && !pi.exited) {
        if (Date.now() >= deadline) { late = true; break; }
        await within(Math.min(deadline - Date.now(), 60_000));
      }
      if (late) { err.write(`test approver: the run did not finish within ${options.timeout} ms\n`); code = 1; break; }
    }
  } catch (error) {
    err.write(`test approver: ${error.message}\n`);
    code = 1;
  }
  await pi.stop();
  const { code: piCode, reason, stderr } = await exited;
  if (code === 0 && piCode && piCode !== 0) { err.write(`test approver: Pi exited ${piCode} ${reason || ""}\n${stderr || ""}`); code = 1; }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { process.stderr.write(`test approver: ${error.message}\n`); process.exit(2); }
  process.exit(await run(options));
}
