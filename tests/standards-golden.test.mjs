import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStandardsContext, identifyTaskDomains, pinStandardsTask, refreshCanonical, retrieveRelevantSections } from "../lib/standards.mjs";

// Golden prompt set for the standards classifier (#101): 52 realistic prompts, each
// with the coop-standards article titles it must and must not get, holdout rows scored
// the same way that must all pass, plus negatives that must get no standards.
// tests/fixtures/standards-golden-corpus.json mirrors the front matter of every active
// wiki article at the recorded revision; the bodies here are stubs, because selection
// reads only front matter.
//
// The wiki is a local git repo refreshed once into temp storage, the way every
// standards suite resolves (the fixtureRoot seam went with #83). No network, no sleep
// or poll, and a git timeout that only trips on a hang (see #100). Scoring then runs
// on the pinned resolutions without further git calls.

// Prompts that fail today, by corpus number, with exactly how they fail. A prompt that
// starts passing fails this suite until its line is deleted (a one-line change); a prompt
// not listed here that fails, or a listed one that fails differently, is a regression.
const KNOWN_FAILURES = new Map([
  // "index" now matches the stemmed "indexing", so a gold index task also gets Silver Indexing.
  [22, ["forbidden Silver Indexing"]],
  // PBIX, PBIP, .gitignore and "chart" are not words of the articles' titles or front matter.
  [37, ["missing Power BI File Types"]],
  [38, ["missing Power BI File Types"]],
  [41, ["missing Power BI Report Visuals"]],
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const golden = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "standards-golden-corpus.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "coop-std-golden-"));
const wiki = join(tmp, "wiki");
const registryPath = join(tmp, "registry.json");
const options = (more = {}) => ({
  canonicalRoot: join(tmp, "cache", "canonical"), statePath: join(tmp, "cache", "status.json"), snapshotRoot: join(tmp, "snapshots"),
  registryPath, fixtureRegistry: true, remote: wiki, cwd: tmp, now: () => 1_000_000,
  reviewerBins: { sql: join(tmp, "none-sql"), dax: join(tmp, "none-dax") }, ...more,
});
const git = (args) => execFileSync("git", ["-C", wiki, ...args], { encoding: "utf8" }).trim();
const WIKI_DOMAINS = ["sql", "dax", "semantic_model"];
const titles = (sections) => sections.filter((s) => s.file).map((s) => s.heading);

try {
  assert.equal(golden.prompts.length, 52);
  for (const a of golden.wiki.articles) {
    const fields = ["id", "title", "domain", "layer", "artifact", "technology", "status"].map((key) => `${key}: ${a[key]}`).join("\n");
    mkdirSync(dirname(join(wiki, a.path)), { recursive: true });
    writeFileSync(join(wiki, a.path), `---\n${fields}\n---\n# ${a.title}\nStub body.\n`);
  }
  execFileSync("git", ["init", "-q", "-b", "main", wiki]);
  git(["config", "user.email", "standards@test.invalid"]); git(["config", "user.name", "Standards Test"]);
  git(["add", "."]); git(["commit", "-q", "-m", `front matter of coop-standards ${golden.wiki.revision}`]);
  writeFileSync(registryPath, JSON.stringify({ schema_version: 1, canonical: { id: "cooptimize-formal-standards", repository: wiki, authoritative_branch: "main", freshness_seconds: 900, timeout_seconds: 60 } }));
  const refreshed = refreshCanonical(options({ force: true }));
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));

  // The same pinned resolutions buildStandardsContext injects from; every active article is read.
  const pin = pinStandardsTask(WIKI_DOMAINS, options({ refresh: false }));
  const resolutions = Object.fromEntries(WIKI_DOMAINS.map((domain) => [domain, pin.resolve(domain)]));
  assert.deepEqual(Object.values(resolutions).flatMap((r) => r.articles.map((a) => a.title)).sort(), golden.wiki.articles.map((a) => a.title).sort());
  const standardsFor = (prompt) => {
    const domains = identifyTaskDomains(prompt);
    return { domains, injected: domains.filter((d) => resolutions[d]).flatMap((d) => titles(retrieveRelevantSections(resolutions[d], prompt))) };
  };

  // buildStandardsContext is identifyTaskDomains plus these resolutions: spot-check a SQL,
  // a DAX + model, and a four-domain prompt end to end.
  for (const n of [1, 26, 43]) {
    const { prompt } = golden.prompts[n - 1];
    const context = buildStandardsContext(prompt, options({ refresh: false }));
    assert.deepEqual({ domains: [...context.domains], injected: context.records.flatMap((r) => titles(r.sections)) }, standardsFor(prompt), `#${n}`);
  }

  const reasonsFor = (c) => {
    const { domains, injected } = standardsFor(c.prompt);
    return [
      ...c.domains_expected.filter((d) => !domains.includes(d)).map((d) => `missing domain ${d}`),
      ...c.must_include.filter((t) => !injected.includes(t)).map((t) => `missing ${t}`),
      ...c.must_not_include.filter((t) => injected.includes(t)).map((t) => `forbidden ${t}`),
    ];
  };
  const wrong = [];
  let passing = 0;
  golden.prompts.forEach((c, i) => {
    const n = i + 1;
    const reasons = reasonsFor(c);
    if (!reasons.length) passing++;
    const known = KNOWN_FAILURES.get(n) || [];
    if (JSON.stringify(reasons) === JSON.stringify(known)) return;
    wrong.push(reasons.length ? `#${n} ${c.prompt}: ${reasons.join("; ")}${known.length ? ` (known: ${known.join("; ")})` : ""}`
      : `#${n} ${c.prompt}: now passes; delete its KNOWN_FAILURES line`);
  });
  assert.deepEqual(wrong, []);

  // Holdout rows: ordinary wording from outside the 52 that only #95's wiki-layer
  // widening reached (a Power BI report with a slicer, visual, bookmark, tooltip or
  // theme; a gold proc, sproc or merge; "silver custtable"; "... to silver"; the
  // warehouse in a Fabric workspace). Removing the widening must not lose them, so
  // every one passes; there is no known-failures list here.
  assert.ok(golden.holdout.length >= 16);
  const holdoutWrong = golden.holdout.map((c) => ({ prompt: c.prompt, reasons: reasonsFor(c) })).filter((row) => row.reasons.length);
  assert.deepEqual(holdoutWrong, []);

  // Everyday prompts that say "report", "silver", "gold", "format strings" or "relate",
  // a file name before "view(s)", "Visual Studio", "... to gold" about a color, or
  // "fabric" as cloth get no standards through the real entry point, with the wiki
  // generation active.
  const leaked = golden.negatives.map((prompt) => ({ prompt, injected: buildStandardsContext(prompt, options({ refresh: false })).records.flatMap((r) => r.sections.map((s) => s.heading)) }))
    .filter((row) => row.injected.length);
  assert.deepEqual(leaked, []);

  console.log(`  ✓ golden prompts: ${passing}/${golden.prompts.length} pass, ${KNOWN_FAILURES.size} known failures; ${golden.holdout.length}/${golden.holdout.length} holdout prompts pass; ${golden.negatives.length} negatives get no standards (wiki ${golden.wiki.revision.slice(0, 7)})`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
