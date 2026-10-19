// J0 (master plan section 6.6): lib/router-trial.mjs scores classifiers against
// the coop/auto rule and the hand labels. The classifier is injected here, so the
// test calls no vendor; the shipped set is checked for shape and for the rows the
// rule gets wrong on purpose (the short medium-thinking lookups a classifier
// could route better).
import assert from "node:assert/strict";
import { classifyRequest, LONG_PROMPT_CHARS, SHORT_PROMPT_CHARS, TIERS } from "../lib/router-rules.mjs";
import { CLASSIFIERS, DEFAULT_SET, formatReport, missingKeys, parseArgs, readSet, resolvePiEntry, runTrial } from "../lib/router-trial.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync as readFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// --- the Pi entry --------------------------------------------------------------
// Pi 1.2.0's package.json exports only an `import` condition, which
// require.resolve (the `require` condition) rejects with 'No "exports" main
// defined' (Aaron's first trial run on the dev VM, 2026-10-19). The entry comes
// from the package's own manifest instead, for every shape Pi has shipped.
{
  const t = mkdtempSync(join(tmpdir(), "coop-router-trial-pi-"));
  const pkgDir = (name, manifest) => { const d = join(t, name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "package.json"), JSON.stringify(manifest)); return d; };
  const importOnly = pkgDir("pi-1.2.0", { name: "@earendil-works/pi-coding-agent", version: "1.2.0", main: "./dist/index.js", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" } } });
  assert.equal(resolvePiEntry(importOnly), join(importOnly, "dist", "index.js"), "an import-only export resolves to its import entry");
  const mainOnly = pkgDir("pi-main", { name: "@earendil-works/pi-coding-agent", version: "1.1.0", main: "dist/index.js" });
  assert.equal(resolvePiEntry(mainOnly), join(mainOnly, "dist", "index.js"), "a package with main alone resolves to main");
  const stringExport = pkgDir("pi-string", { name: "x", exports: "./lib/entry.js" });
  assert.equal(resolvePiEntry(stringExport), join(stringExport, "lib", "entry.js"), "a string export is the entry");
  const nested = pkgDir("pi-nested", { name: "x", exports: { ".": { import: { default: "./dist/i.js" } } } });
  assert.equal(resolvePiEntry(nested), join(nested, "dist", "i.js"), "a nested import.default export is the entry");
  const bare = pkgDir("pi-bare", { name: "x" });
  assert.equal(resolvePiEntry(bare), join(bare, "dist", "index.js"), "no exports and no main fall back to dist/index.js");
  // The Pi this machine has, when there is one: its entry exists and is the file
  // Node itself picks for an import of the package.
  try {
    const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
    const piDir = join(root, "@earendil-works", "pi-coding-agent");
    if (existsSync(join(piDir, "package.json"))) {
      const entry = resolvePiEntry(piDir);
      assert.ok(existsSync(entry), `the installed Pi's entry exists: ${entry}`);
      const manifest = JSON.parse(readFile(join(piDir, "package.json"), "utf8"));
      assert.ok(entry.endsWith(join(...String(manifest.exports?.["."]?.import ?? manifest.main).replace(/^\.\//, "").split("/"))), "the installed Pi's entry is its import export");
    }
  } catch { /* no global npm here: the fixtures above cover the shapes */ }
}

// --- the rule ---------------------------------------------------------------
assert.equal(classifyRequest("What is DAX?", "low"), "build");
assert.equal(classifyRequest("What is DAX?", "medium"), "standard");
assert.equal(classifyRequest("x".repeat(SHORT_PROMPT_CHARS + 1), "low"), "standard");
assert.equal(classifyRequest("Design the migration", "high"), "plan");
assert.equal(classifyRequest("x".repeat(LONG_PROMPT_CHARS), "low"), "plan");
assert.equal(classifyRequest(undefined, "medium"), "standard");

// --- the shipped set --------------------------------------------------------
const rows = readSet(DEFAULT_SET);
assert.equal(rows.length, 50, "the shipped set holds 50 rows");
assert.equal(new Set(rows.map((r) => r.id)).size, 50, "ids are unique");
for (const r of rows) assert.ok(TIERS.includes(r.label) && r.prompt.trim().length > 0);
for (const t of TIERS) assert.ok(rows.filter((r) => r.label === t).length >= 7, `at least 7 rows labelled ${t}`);
const ruleMisses = rows.filter((r) => classifyRequest(r.prompt, r.thinkingLevel) !== r.label);
assert.ok(ruleMisses.length > 0 && ruleMisses.length < 10, "the set holds a few rows the rule gets wrong, so a classifier can beat it");
assert.ok(ruleMisses.every((r) => r.label === "build" && r.thinkingLevel === "medium"), "the rule's misses are the short medium-thinking lookups");
assert.ok(rows.some((r) => r.prompt.length >= LONG_PROMPT_CHARS && r.label === "plan"), "one long brief plans by length");
const rawText = (await import("node:fs")).readFileSync(DEFAULT_SET, "utf8");
assert.ok(!/contoso\.com|@cooptimize|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(rawText), "the set carries no tenant, workspace or item ids");

// --- scoring ----------------------------------------------------------------
const perfect = async (_name, row) => ({ choice: row.label, probabilities: {}, confidence: 1, cost: 0.001 });
const r1 = await runTrial(rows, ["typesafe"], perfect);
assert.equal(r1.rows, 50);
assert.equal(r1.rule.correct, 50 - ruleMisses.length);
assert.equal(r1.classifiers.typesafe.accuracy, 1);
assert.equal(r1.classifiers.typesafe.errors, 0);
assert.equal(r1.classifiers.typesafe.disagreements.length, 0);
assert.ok(Math.abs(r1.classifiers.typesafe.cost - 0.05) < 1e-9, "cost sums per row");
assert.ok(r1.classifiers.typesafe.agreesWithRule < 1 && r1.classifiers.typesafe.agreesWithRule > 0.8);
const report1 = formatReport(r1);
assert.match(report1, /^rows: 50/m);
assert.match(report1, /verdict: typesafe routes better than the rule/);
assert.ok(!report1.includes(rows[0].prompt), "the report prints no prompt text");

// A classifier that always says standard loses to the rule; errors count, not score.
let n = 0;
const flaky = async (name, row) => (n++ % 10 === 0 ? { error: "rate limited" } : { choice: "standard", probabilities: {}, confidence: 0.5, cost: 0 });
const r2 = await runTrial(rows, ["typesafe", "cloudflare"], flaky);
assert.equal(r2.classifiers.typesafe.errors, 5);
assert.ok(r2.classifiers.typesafe.accuracy < r2.rule.accuracy);
assert.ok(r2.classifiers.typesafe.disagreements.length > 0);
assert.ok(r2.classifiers.typesafe.disagreements.every((d) => typeof d.id === "string" && !("prompt" in d)), "disagreements carry ids, never prompts");
assert.match(formatReport(r2), /verdict: no classifier beats the rule on this set; coop\/auto keeps the rule/);

// --- arguments and keys -----------------------------------------------------
const a = parseArgs(["--classifiers", "typesafe,cloudflare-flash", "--out", "x.json", "--pi", "/p"]);
assert.deepEqual(a.classifiers, ["typesafe", "cloudflare-flash"]);
assert.equal(a.out, "x.json");
assert.equal(a.pi, "/p");
assert.equal(parseArgs([]).set, DEFAULT_SET);
assert.equal(parseArgs([]).allowWindows, false);
assert.equal(parseArgs(["--allow-windows"]).allowWindows, true);
assert.throws(() => parseArgs(["--classifiers", "openai"]), /unknown classifier/);
assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
assert.deepEqual(missingKeys("typesafe", {}), ["TYPESAFE_API_KEY"]);
assert.deepEqual(missingKeys("typesafe", { TYPESAFE_API_KEY: "k" }), []);
assert.deepEqual(missingKeys("cloudflare", { CLOUDFLARE_API_KEY: "k" }), ["CLOUDFLARE_ACCOUNT_ID"]);
for (const c of Object.values(CLASSIFIERS)) assert.ok(c.provider !== "openai-codex", "the trial never scores the Codex models themselves");

console.log("  ✓ router-trial tests passed");
