// Change history (CW2), extended lane: what a write waits for. 200 real write
// calls through the bundled guardrails' tool_call and tool_result handlers, with
// the switch off and on, each to its own file (so no cache is warm); the
// per-write difference is the overhead the person can feel (the design's bar:
// under 10 ms at p95). Off runs no history code at all, so "on" carries every
// cost: the folder check, the path rules and the two reads. Then one file just
// under 5 MB (read twice on the tool path) and one excluded path (a .csv: never
// read). The recording itself runs after the result and is timed on its own.
//   COOP_TEST_DIST=<bundled extensions> node tests/action-history-overhead.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-cw2-perf-")));
const HOME = join(root, "home");
Object.assign(process.env, { HOME, USERPROFILE: HOME, COOP_DIR: HOME, PI_CODING_AGENT_DIR: join(root, "agent"), COOP_ROOT: ROOT });
mkdirSync(join(HOME, ".coop"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const repo = join(root, "client");
mkdirSync(join(repo, "docs"), { recursive: true });
mkdirSync(join(repo, "data"), { recursive: true });
spawnSync("git", ["init", "-q", repo]);

const cg = await import(pathToFileURL(`${process.env.COOP_TEST_DIST}/coop-guardrails.mjs`).href);
const lib = await import(pathToFileURL(join(ROOT, "lib", "action-history.mjs")).href);
const N = 200;
const text = (i) => Array.from({ length: 120 }, (_, n) => `SELECT ${n} AS c${n}, '${i}' AS v; -- line ${n}`).join("\n");

function load(on) {
  writeFileSync(join(HOME, ".coop", "config"), JSON.stringify({ features: { history: on } }));
  const handlers = {};
  cg.default({ on: (ev, h) => { handlers[ev] = h; }, registerCommand() {}, exec: async () => ({ stdout: "", stderr: "", code: 0 }) });
  return handlers;
}
const ctx = { cwd: repo, hasUI: true, ui: { confirm: async () => true, notify() {} }, sessionManager: { getSessionId: () => "perf" } };

// Off and on alternate write by write (two instances, each read its switch at
// load), so warm-up and machine noise fall on both alike.
async function run() {
  const handlers = { off: load(false), on: load(true) };
  const times = { off: [], on: [] };
  for (let i = 0; i < N + 20; i++) {
    for (const mode of i % 2 ? ["on", "off"] : ["off", "on"]) {
      const h = handlers[mode];
      const toolCallId = `${mode}-${i}`;
      const input = { path: `docs/perf-${mode}-${i}.md`, content: text(`${mode}${i}`) };
      const t0 = performance.now();
      await h.tool_call({ toolName: "write", toolCallId, input }, ctx);
      const t1 = performance.now();
      writeFileSync(join(repo, input.path), input.content); // the tool itself, not timed
      const t2 = performance.now();
      await h.tool_result({ toolName: "write", toolCallId, input, content: [], isError: false }, ctx);
      const t3 = performance.now();
      if (i >= 20) times[mode].push((t1 - t0) + (t3 - t2)); // 20 warm-up writes
      await new Promise((r) => setImmediate(r));
    }
  }
  return times;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

/** One write's handler time, off and on, `reps` times each: the medians. */
async function one(path, content, reps = 5) {
  const handlers = { off: load(false), on: load(true) };
  const times = { off: [], on: [] };
  for (let i = 0; i < reps; i++) {
    for (const mode of ["off", "on"]) {
      const h = handlers[mode];
      const toolCallId = `one-${mode}-${path}-${i}`;
      const input = { path, content };
      const t0 = performance.now();
      await h.tool_call({ toolName: "write", toolCallId, input }, ctx);
      const t1 = performance.now();
      writeFileSync(join(repo, path), content);
      const t2 = performance.now();
      await h.tool_result({ toolName: "write", toolCallId, input, content: [], isError: false }, ctx);
      times[mode].push((t1 - t0) + (performance.now() - t2));
      await cg.historySettled();
    }
  }
  return { off: pct(times.off, 50), on: pct(times.on, 50) };
}

const { off, on } = await run();
// The measurement is of a recorder that records: every "on" write has its line.
await cg.historySettled();
const recorded = lib.readEntries(lib.storeFor(repo).store, { limit: Infinity }).filter((e) => e.session === "perf" && e.toolCallId.startsWith("on-"));
assert.equal(recorded.length, N + 20, "history on recorded every write");
assert.ok(recorded.every((e) => e.before && e.after && !e.excluded), "with its content");
// The deferred recording, timed directly (off the critical path).
const rec = [];
for (let i = 0; i < N; i++) {
  const file = join(repo, "docs", "rec.md");
  const before = (() => { try { return readFileSync(file); } catch { return null; } })();
  writeFileSync(file, text(`r${i}`));
  const t0 = performance.now();
  await lib.recordFileChange({ file, tool: "write", before });
  rec.push(performance.now() - t0);
}
const bigText = "x".repeat(lib.MAX_FILE_BYTES - 1024);
writeFileSync(join(repo, "docs", "big.md"), bigText);
const big = await one("docs/big.md", `${bigText.slice(1)}y`);
const bigLine = lib.readEntries(lib.storeFor(repo).store, { limit: 5 }).find((e) => e.target === "docs/big.md");
assert.ok(bigLine && bigLine.after && !bigLine.excluded, "the 5 MB file's content is kept");
const excluded = await one("data/extract.csv", text("csv"));
assert.equal(lib.readEntries(lib.storeFor(repo).store, { limit: 5 }).find((e) => e.target === "data/extract.csv").excluded, "data file");
const ms = (x) => `${x.toFixed(3)} ms`;
const report = {
  writes: N,
  inlineOff: { median: pct(off, 50), p95: pct(off, 95) },
  inlineOn: { median: pct(on, 50), p95: pct(on, 95) },
  overhead: { median: pct(on, 50) - pct(off, 50), p95: pct(on, 95) - pct(off, 95) },
  deferredRecord: { median: pct(rec, 50), p95: pct(rec, 95) },
  file5MB: { off: big.off, on: big.on, overhead: big.on - big.off },
  excludedCsv: { off: excluded.off, on: excluded.on, overhead: excluded.on - excluded.off },
};
console.log(`  change history per-write cost over ${N} writes (4.7 KB files, a new file each write):`);
console.log(`    guardrails handlers, history off: median ${ms(report.inlineOff.median)}, p95 ${ms(report.inlineOff.p95)}`);
console.log(`    guardrails handlers, history on:  median ${ms(report.inlineOn.median)}, p95 ${ms(report.inlineOn.p95)}`);
console.log(`    overhead a write waits for:       median ${ms(report.overhead.median)}, p95 ${ms(report.overhead.p95)}`);
console.log(`    deferred recording (after the result): median ${ms(report.deferredRecord.median)}, p95 ${ms(report.deferredRecord.p95)}`);
console.log(`    one file just under 5 MB (median of 5): off ${ms(big.off)}, on ${ms(big.on)}, overhead ${ms(big.on - big.off)}`);
console.log(`    one excluded path (.csv, median of 5):  off ${ms(excluded.off)}, on ${ms(excluded.on)}, overhead ${ms(excluded.on - excluded.off)}`);
if (process.env.COOP_HISTORY_PERF_JSON) writeFileSync(process.env.COOP_HISTORY_PERF_JSON, JSON.stringify(report, null, 2));
assert.ok(report.inlineOn.p95 - report.inlineOff.p95 < 10, `p95 overhead ${ms(report.overhead.p95)} is under 10 ms`);
console.log("  ✓ change history adds under 10 ms per write at p95");
