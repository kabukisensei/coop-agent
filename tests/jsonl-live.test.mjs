// Live JSONL happy-path test against the REAL coop-data-doc binary (>= 1.1.1).
// Drives the full setup questionnaire the way extensions/coop-tools does:
//   hello(1.x) -> prompt* -> {id, answer}* -> exactly one `complete` -> exit 0.
// Skips cleanly when no capable binary is on PATH; set COOP_TEST_DATADOC_REQUIRED=1
// (CI with a pinned tool) to turn a skip into a failure.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = process.env.COOP_TEST_DIST;
if (!dist) { console.error("COOP_TEST_DIST not set"); process.exit(1); }
const { resolveDataDocExecutable } = await import(new URL(`${dist}/coop-tools.mjs`, "file://").href);

let exe;
try { exe = resolveDataDocExecutable(process.platform, process.env); }
catch (e) {
  if (process.env.COOP_TEST_DATADOC_REQUIRED === "1") { console.error(e.message); process.exit(1); }
  console.log("  – coop-data-doc not on PATH; skipping live JSONL happy-path");
  process.exit(0);
}

const verOut = await new Promise((res) => {
  const p = spawn(exe, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.once("close", () => res(out));
});
const m = verOut.match(/(\d+\.\d+\.\d+)/);
const capable = m && m[1] !== "1.0.0" && m[1].split(".")[0] >= "1";
if (!capable) {
  if (process.env.COOP_TEST_DATADOC_REQUIRED === "1") {
    console.error(`coop-data-doc ${m ? m[1] : "(unknown)"} cannot drive the JSONL wizard; need >= 1.1.1`);
    process.exit(1);
  }
  console.log(`  – coop-data-doc ${m ? m[1] : "?"} lacks the JSONL wizard; skipping live happy-path`);
  process.exit(0);
}

// --- fixture project -----------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "coop-jsonl-live-"));
const sqlDir = join(work, "sql", "models");
mkdirSync(sqlDir, { recursive: true });
mkdirSync(join(work, "pbi"), { recursive: true });
writeFileSync(join(sqlDir, "f.sql"), "CREATE OR REPLACE VIEW gold.f AS SELECT 1 AS x;\n");

// --- drive the questionnaire ---------------------------------------------------
const child = spawn(exe, ["setup", "--transport", "jsonl"], { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
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
    // Layer pickers require at least one entry; derive a name from the prompt id.
    if (/layer/i.test(id) && !/^no_/.test(id)) return [id.replace(/_layer.*$/, "")];
    return [];
  }
  if (typeof p.default === "string" && p.default) return p.default;
  if (/name/i.test(id)) return "CleanRoom Estate";
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
ok(terminals.length === 1 && terminals[0].type === "complete",
   `exactly one terminal event, of type complete (got ${terminals.map((t) => t.type).join(",") || "none"})`);
ok(exitCode === 0, `exit code is 0 (got ${exitCode}${stderrTail ? `; stderr: ${stderrTail.split("\n").pop()}` : ""})`);

const cfgPath = (evt) => {
  const c = evt && evt.data && evt.data.config;
  return c ? join(work, c) : null;
};
const completeEvt = terminals.find((t) => t.type === "complete");
const cfg = cfgPath(completeEvt) || join(work, "coop-data-doc.yml");
ok(existsSync(cfg), `indicated config exists (${cfg.replace(work + "/", "")})`);
if (existsSync(cfg)) {
  // Validity: the tool's own parser accepts it (show-config exits 0 with JSON).
  const show = await new Promise((res) => {
    const p = spawn(exe, ["show-config"], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    p.once("close", (c) => res({ c, out }));
  });
  ok(show.c === 0 && (() => { try { JSON.parse(show.out); return true; } catch { return false; } })(),
     "config is valid (show-config parses it as JSON)");
}

console.log(failures === 0 ? `  ✓ live JSONL happy-path passed (${prompts.length} prompts answered)` : "  ✗ live JSONL happy-path FAILED");
process.exit(failures === 0 ? 0 : 1);
