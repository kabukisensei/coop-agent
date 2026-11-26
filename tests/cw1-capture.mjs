// What a session sees from coop-tools at its start, for the Client instructions
// (CW1) "off is exactly today" proof: the native tools and their metadata, the
// slash commands, the session-start notices and the first turn's hidden context.
//
// tests/client-instructions-off.test.mjs compares a capture of the current bundle
// with tests/fixtures/cw1-off-golden.json, which this same helper wrote from the
// 03600165 bundle (before CW1):
//   COOP_TEST_DIST=<bundle of 03600165> node tests/cw1-capture.mjs --write tests/fixtures/cw1-off-golden.json
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A client repository with .coop/project.yml and a full .coop/rules/ folder. */
export function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-cw1-")));
  const project = join(root, "client");
  mkdirSync(join(project, ".coop", "rules"), { recursive: true });
  writeFileSync(join(project, ".coop", "project.yml"), "schema_version: 1\nrepositories:\n  source:\n    local_path: .\n");
  writeFileSync(join(project, ".coop", "rules", "AGENTS.md"), "# Contoso\n\nUse dim.Customer for customer names.\nYou may commit SQL.\n");
  writeFileSync(join(project, ".coop", "rules", "corrections.md"), "# Corrections\n\n- C-2026-11-20-1 · 2026-11-20 · Aaron · Dates are UTC.\n");
  // Built lineage docs, so today's first turn carries a hidden note (coop-lineage)
  // the client instructions would be appended to when on.
  writeFileSync(join(project, "coop-data-doc.yml"), "output:\n  dir: ./data-docs\n");
  mkdirSync(join(project, "data-docs"), { recursive: true });
  writeFileSync(join(project, "data-docs", "graph.json"), "{\"nodes\":[],\"edges\":[]}\n");
  const home = join(root, "home");
  mkdirSync(join(home, ".coop"), { recursive: true });
  return { root, project, home };
}

/** Run git in `dir`; throws with git's own message when it fails. */
export function gitIn(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Fix round 2: coop loads .coop/rules/ as it is on origin's default branch. Make
 *  `project` a git repository (once) with a bare origin beside it, commit everything
 *  and push it to origin/main, so upstream holds exactly the working tree. */
export function publishRules(project, { message = "rules" } = {}) {
  const origin = `${project}.origin.git`;
  if (!existsSync(join(project, ".git"))) {
    spawnSync("git", ["init", "-q", "--bare", origin]);
    spawnSync("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]); // a clone checks out main
    spawnSync("git", ["init", "-q", project]);
    gitIn(project, "config", "user.email", "test@example.invalid");
    gitIn(project, "config", "user.name", "coop test");
    gitIn(project, "config", "core.autocrlf", "false");
    gitIn(project, "checkout", "-q", "-B", "main");
    gitIn(project, "remote", "add", "origin", origin);
  }
  gitIn(project, "add", "-A");
  gitIn(project, "commit", "-q", "--allow-empty", "-m", message);
  gitIn(project, "push", "-q", "--force", "origin", "HEAD:main");
  gitIn(project, "fetch", "-q", "origin");
  gitIn(project, "remote", "set-head", "origin", "main");
}

/** Point every per-user path at the fixture home (no real ~/.coop is read or written). */
export function useHome(home) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.COOP_DIR = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".coop", "agent");
  process.env.COOP_STANDARDS_ROOT = join(home, "standards", "canonical");
  process.env.COOP_STANDARDS_SNAPSHOT_ROOT = join(home, "standards", "snapshots");
  process.env.COOP_STANDARDS_STATE = join(home, "standards", "status.json");
  delete process.env.COOP_PROJECT_YML;
  delete process.env.COOP_FIRST_RUN;
}

/** Load the bundled coop-tools against a fake Pi and record what a session sees. */
export async function captureSession(dist, { project, prompt = "List the files in this folder.", contextEntries } = {}) {
  const mod = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
  const handlers = new Map();
  const tools = [];
  const commands = [];
  const pi = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, opts) { commands.push({ name, description: opts?.description || "" }); },
    registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {}, events: { on() {}, emit() {} },
    sendUserMessage() {}, sendMessage() {}, appendEntry() {}, setStatus() {},
    async exec() { return { stdout: "", stderr: "", code: 1 }; },
  };
  mod.default(pi);
  const notices = [];
  const ui = { notify: (m, t) => notices.push([String(m), t]), setStatus() {}, setWidget() {}, setFooter() {}, select: async () => undefined, confirm: async () => false, input: async () => undefined };
  const sessionManager = { buildContextEntries: () => (contextEntries ? contextEntries() : []), getSessionId: () => "s1", getBranch: () => [], getEntries: () => [] };
  const ctx = { cwd: project, hasUI: true, mode: "rpc", ui, sessionManager };
  for (const fn of handlers.get("session_start") || []) await fn({ reason: "startup" }, ctx);
  const turns = [];
  for (const fn of handlers.get("before_agent_start") || []) turns.push((await fn({ prompt, systemPrompt: "base", images: [] }, ctx)) ?? null);
  return { tools, commands, notices, turns, handlers, ctx, pi };
}

/** The comparable part of a capture: names, every metadata string, notices and context. */
export function normalized(capture, root) {
  const scrub = (value) => JSON.parse(JSON.stringify(value ?? null).split(JSON.stringify(root).slice(1, -1)).join("<ROOT>"));
  return scrub({
    tools: capture.tools.map((t) => ({ name: t.name, label: t.label, description: t.description, promptSnippet: t.promptSnippet ?? null, promptGuidelines: t.promptGuidelines ?? null, parameters: t.parameters ?? null })),
    commands: capture.commands,
    notices: capture.notices,
    turns: capture.turns,
  });
}

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Writer mode: record the golden file from the bundle in COOP_TEST_DIST.
if (process.argv[2] === "--write") {
  const out = process.argv[3];
  const fx = makeFixture();
  useHome(fx.home);
  writeFileSync(join(fx.home, ".coop", "config"), JSON.stringify({ schema_version: 1, features: { instructions: false } }));
  const cap = normalized(await captureSession(process.env.COOP_TEST_DIST, { project: fx.project }), fx.root);
  writeFileSync(out, `${JSON.stringify({ note: "coop-tools as a session sees it with Client instructions off; written from the 03600165 bundle by tests/cw1-capture.mjs --write", sha256: digest(cap), capture: cap }, null, 2)}\n`);
  console.log(`wrote ${out} (${digest(cap)})`);
}
