// Live JSONL happy-path test against the REAL coop-data-doc binary (>= 1.1.1).
// Drives the full setup questionnaire the way extensions/coop-tools does:
//   hello(1.x) -> prompt* -> {id, answer}* -> exactly one `complete` -> exit 0.
// Skips cleanly when no capable binary is on PATH; set COOP_TEST_DATADOC_REQUIRED=1
// (CI with a pinned tool) to turn a skip into a failure.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
if (!dist) { console.error("COOP_TEST_DIST not set"); process.exit(1); }
const { resolveDataDocInvocation, runJsonlSetup } = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);

let invocation;
try { invocation = resolveDataDocInvocation(process.platform, process.env); }
catch (e) {
  if (process.env.COOP_TEST_DATADOC_REQUIRED === "1") { console.error(e.message); process.exit(1); }
  console.log("  – coop-data-doc not on PATH; skipping live JSONL happy-path");
  process.exit(0);
}

const verResult = await new Promise((res) => {
  const p = spawn(invocation.command, [...invocation.args, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  let settled = false;
  p.once("error", (error) => { if (!settled) { settled = true; res({ out, error }); } });
  p.once("close", () => { if (!settled) { settled = true; res({ out, error: null }); } });
});
if (verResult.error) {
  if (process.env.COOP_TEST_DATADOC_REQUIRED === "1") {
    console.error(`could not start coop-data-doc: ${verResult.error.message}`);
    process.exit(1);
  }
  console.log("  – coop-data-doc not on PATH; skipping live JSONL happy-path");
  process.exit(0);
}
const verOut = verResult.out;
const m = verOut.match(/(\d+)\.(\d+)\.(\d+)/);
// The JSONL transport contract requires >= 1.1.1: compare numerically on all
// three components (a string/prefix check would accept 1.0.1 or 1.1.0).
const capable = !!m && (+m[1] > 1 || (+m[1] === 1 && (+m[2] > 1 || (+m[2] === 1 && +m[3] >= 1))));
if (!capable) {
  if (process.env.COOP_TEST_DATADOC_REQUIRED === "1") {
    console.error(`coop-data-doc ${m ? `${m[1]}.${m[2]}.${m[3]}` : "(unknown)"} cannot drive the JSONL wizard; need >= 1.1.1`);
    process.exit(1);
  }
  console.log(`  – coop-data-doc ${m ? `${m[1]}.${m[2]}.${m[3]}` : "?"} lacks the JSONL wizard; skipping live happy-path`);
  process.exit(0);
}

// --- fixture project -----------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "coop-jsonl-live-"));
const sqlDir = join(work, "sql", "models");
mkdirSync(sqlDir, { recursive: true });
mkdirSync(join(work, "pbi"), { recursive: true });
writeFileSync(join(sqlDir, "f.sql"), "CREATE OR REPLACE VIEW gold.f AS SELECT 1 AS x;\n");

// --- drive the questionnaire ---------------------------------------------------
const childEnv = {
  ...process.env,
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  COOP_DATA_DOC_CONFIG: "coop-data-doc.yml",
};
const child = spawn(invocation.command, [...invocation.args, "setup", "--transport", "jsonl"], {
  cwd: work,
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
});
const events = [];
const rawLines = [];
let stdoutNonJson = "";
let stderrTail = "";
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { events.push(JSON.parse(line)); rawLines.push(line); }
    catch { stdoutNonJson += line + "\n"; }
  }
});
child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-1000); });

const answerFor = (p) => {
  // Sensible answers per kind; paths point at real fixture dirs so validation passes.
  const id = String(p.id || "");
  // 'csv' prompts take comma-separated lists; blank is valid ([]), but folder/
  // schema pickers need entries that exist — answer from the fixture.
  if (id === "csv") {
    if (typeof p.default === "string" && p.default) return p.default;
    const msg = String(p.message || "").toLowerCase();
    if (/folder|glob/.test(msg)) return "models";
    if (/drop/.test(msg)) return "staging, tmp";
    if (/schema/.test(msg)) return "gold";
    return "staging";
  }
  if (/sql/i.test(id) && p.kind === "path") return sqlDir;
  if (/pbi|power\s*bi/i.test(id) && p.kind === "path") return join(work, "pbi");
  if (p.kind === "confirm") return true;
  if (p.kind === "select") {
    const choices = p.choices || [];
    const pre = choices.find((c) => c.checked);
    return pre ? pre.value : (choices[0] ? choices[0].value : "");
  }
  if (p.kind === "checkbox") {
    const checked = (p.choices || []).filter((c) => c.checked).map((c) => c.value);
    if (checked.length) return checked;
    // Layer pickers require an OFFERED entry; choose the first discovered schema
    // (never fabricate one from the prompt id).
    if (/layer/i.test(id) && !/^no_/.test(id)) {
      const offered = (p.choices || []).find((c) => c.value !== "__manual__");
      return offered ? [offered.value] : [];
    }
    return [];
  }
  if (/name/i.test(id)) return "CleanRoom — Estate ✓";
  if (typeof p.default === "string" && p.default) return p.default;
  return "yes";
};

const exitCode = await new Promise((resolveExit) => {
  let bufIdx = 0; // how many events consumed by the responder
  const seenIds = new Map();
  const respond = () => {
    for (; bufIdx < events.length; bufIdx++) {
      const evt = events[bufIdx];
      if (evt.type === "prompt") {
        // Runaway guard: a valid answer must advance the wizard. Re-asking the
        // same id >5 times means our responder is wrong — fail fast with data
        // instead of OOMing on an infinite prompt loop.
        const k = `${evt.id}|${String(evt.message).slice(0, 60)}`;
        const n = (seenIds.get(k) || 0) + 1;
        seenIds.set(k, n);
        if (n > 4) {
          try { child.kill(); } catch {}
          clearInterval(pump); clearTimeout(watchdog);
          console.error(`  ✗ runaway questionnaire at prompt ${JSON.stringify(String(evt.id).slice(0, 120))} (kind=${evt.kind}, default=${JSON.stringify(String(evt.default ?? "").slice(0, 60))})`);
          console.error(`    last messages: ${events.filter((e) => e.type === "prompt").slice(-3).map((e) => String(e.message).slice(0, 80)).join(" | ")}`);
          console.error(`    asked ids: ${[...seenIds.keys()].map((k) => String(k).slice(0, 40)).join(" | ")}`);
          process.exit(1);
        }
        const _a = answerFor(evt);
        if (process.env.COOP_JSONL_TRACE) console.error(`TRACE ask=${String(evt.id).slice(0,20)} | ${String(evt.message).slice(0,70)} -> ${JSON.stringify(_a).slice(0,40)}`);
        child.stdin.write(JSON.stringify({ id: evt.id, answer: _a }) + "\n");
      } else if (evt.type === "complete" || evt.type === "cancelled" || evt.type === "error") {
        child.stdin.end();
      }
    }
  };
  const pump = setInterval(respond, 25);
  child.stdout.on("data", respond);
  const watchdog = setTimeout(() => { try { child.kill(); } catch {} }, 120000);
  child.once("close", (code) => { clearInterval(pump); clearTimeout(watchdog); resolveExit(code); });
});

// --- assertions ----------------------------------------------------------------
let failures = 0;
const ok = (cond, name) => { console.log(`  ${cond ? "✓" : "✗"} ${name}`); if (!cond) failures++; };

ok(events.length > 0 && events[0].type === "hello" && /^1\./.test(events[0].protocol_version || ""),
   "hello (protocol 1.x) is the first event");
ok(stdoutNonJson === "", "stdout carries only JSON lines");
const prompts = events.filter((e) => e.type === "prompt");
ok(prompts.length > 0, `questionnaire asked ${prompts.length} prompts`);
ok(!events.some((e) => e.type === "error"), "no error events during happy path");
const terminals = events.filter((e) => ["complete", "cancelled", "error"].includes(e.type));
for (const event of terminals.filter((event) => event.type === "error")) console.error(`  JSONL error: ${JSON.stringify(event)}`);
ok(terminals.length === 1 && terminals[0].type === "complete",
   `exactly one terminal event, of type complete (got ${terminals.map((t) => t.type).join(",") || "none"})`);
ok(exitCode === 0, `exit code is 0 (got ${exitCode}${stderrTail ? `; stderr: ${stderrTail.split("\n").pop()}` : ""})`);

const expectedPromptId = "SQL repo path — the folder with your procs, tables, views_path";
ok(prompts.some((p) => p.id === expectedPromptId),
   `exact Unicode prompt ID ('${expectedPromptId}') received`);
ok(!rawLines.some((l) => l.includes("\uFFFD")), "no Unicode replacement characters (\\uFFFD) in JSONL stream");

const cfgPath = (evt) => {
  const c = evt && evt.data && evt.data.config;
  return c ? join(work, c) : null;
};
const completeEvt = terminals.find((t) => t.type === "complete");
const cfg = cfgPath(completeEvt) || join(work, "coop-data-doc.yml");
ok(existsSync(cfg), `indicated config exists (${cfg.replace(work + "/", "")})`);
if (existsSync(cfg)) {
  const cfgText = readFileSync(cfg, "utf-8");
  const nameMatch = cfgText.includes("CleanRoom — Estate ✓") || cfgText.includes("CleanRoom \\u2014 Estate \\u2713");
  ok(nameMatch, "exact Unicode project name round-tripped into config");
  // Validity: the tool's own parser accepts it (show-config exits 0 with JSON).
  const show = await new Promise((res) => {
    const p = spawn(invocation.command, [...invocation.args, "show-config"], { cwd: work, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    p.once("close", (c) => res({ c, out }));
  });
  let parsedConfig = null;
  try { parsedConfig = JSON.parse(show.out); } catch {}
  ok(show.c === 0 && parsedConfig !== null,
     "config is valid (show-config parses it as JSON)");
  ok(parsedConfig && parsedConfig.project_name === "CleanRoom — Estate ✓",
     "show-config returns exact Unicode project name ('CleanRoom — Estate ✓')");
}

// --- production runJsonlSetup verification with Unicode round-trip -------------
console.log("→ production runJsonlSetup verification (UTF-8 encoding round-trip)");
const prodWork = mkdtempSync(join(tmpdir(), "coop-jsonl-prod-"));
const prodSqlDir = join(prodWork, "sql", "models");
mkdirSync(prodSqlDir, { recursive: true });
mkdirSync(join(prodWork, "pbi"), { recursive: true });
writeFileSync(join(prodSqlDir, "f.sql"), "CREATE OR REPLACE VIEW gold.f AS SELECT 1 AS x;\n");

const prevCfgEnv = process.env.COOP_DATA_DOC_CONFIG;
process.env.COOP_DATA_DOC_CONFIG = join(prodWork, "coop-data-doc.yml");

const prodPrompts = [];
const expectedProjectName = "CleanRoom — Estate ✓";

const prodCtx = {
  cwd: prodWork,
  ui: {
    notify: (_msg, _level) => {},
    confirm: async (_title, msg) => {
      prodPrompts.push({ kind: "confirm", message: msg });
      return true;
    },
    select: async (msg, choices) => {
      prodPrompts.push({ kind: "select", message: msg, choices });
      const unchecked = choices.find((c) => typeof c === "string" && c.startsWith("☐ "));
      if (unchecked) return unchecked;
      const done = choices.find((c) => c === "✓ Done");
      if (done) return done;
      const folder = choices.find((c) => typeof c === "string" && c.startsWith("✓ Use this folder:"));
      if (folder) return folder;
      return choices[0];
    },
    input: async (msg, def) => {
      prodPrompts.push({ kind: "input", message: msg, def });
      if (/project name/i.test(msg)) return expectedProjectName;
      if (/schemas.*accept/i.test(msg)) return "gold";
      if (/schemas.*drop/i.test(msg)) return "staging, tmp";
      if (/folder globs/i.test(msg)) return "models";
      return def || "";
    },
  },
};

const prefill = {
  projectName: expectedProjectName,
  sourceMode: "both",
  sqlPath: "sql/models",
  pbiPath: "pbi",
};

let prodSuccess = false;
try {
  prodSuccess = await runJsonlSetup({}, prodCtx, prefill);
} finally {
  if (prevCfgEnv !== undefined) process.env.COOP_DATA_DOC_CONFIG = prevCfgEnv;
  else delete process.env.COOP_DATA_DOC_CONFIG;
}

ok(prodSuccess === true, "production runJsonlSetup completed successfully (returned true)");

// Assert exact Unicode prompt received over wire by runJsonlSetup
const matchingPrompt = prodPrompts.find((p) => p.message && p.message.includes("SQL repo path — the folder"));
ok(!!matchingPrompt, "exact Unicode prompt message with em-dash (\\u2014) received by runJsonlSetup");

// Assert exact Unicode answer round-tripped into written config
const prodCfgPath = join(prodWork, "coop-data-doc.yml");
ok(existsSync(prodCfgPath), "production runJsonlSetup wrote config file");
if (existsSync(prodCfgPath)) {
  const cfgText = readFileSync(prodCfgPath, "utf-8");
  const nameMatch = cfgText.includes(expectedProjectName) || cfgText.includes("CleanRoom \\u2014 Estate \\u2713");
  ok(nameMatch, `exact Unicode answer '${expectedProjectName}' round-tripped into config`);
  // Also verify via show-config for production runJsonlSetup
  const prodShow = await new Promise((res) => {
    const p = spawn(invocation.command, [...invocation.args, "show-config"], { cwd: prodWork, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    p.once("close", (c) => res({ c, out }));
  });
  let prodParsed = null;
  try { prodParsed = JSON.parse(prodShow.out); } catch {}
  ok(prodShow.c === 0 && prodParsed !== null,
     "production config is valid (show-config parses it as JSON)");
  ok(prodParsed && prodParsed.project_name === expectedProjectName,
     `production config show-config returns exact Unicode project name ('${expectedProjectName}')`);
}

try { rmSync(prodWork, { recursive: true, force: true }); } catch {}

console.log(failures === 0 ? `  ✓ live JSONL happy-path passed (${prompts.length} prompts answered)` : "  ✗ live JSONL happy-path FAILED");
process.exit(failures === 0 ? 0 : 1);
