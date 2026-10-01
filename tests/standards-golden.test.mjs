import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStandardsContext, pinStandardsTask, refreshCanonical } from "../lib/standards.mjs";

// Golden prompt set for the standards classifier (#101): 52 realistic prompts, each
// with the coop-standards article titles it must and must not get, holdout rows scored
// the same way that must all pass, plus negatives that must get no standards.
// tests/fixtures/standards-golden-corpus.json mirrors the front matter of every active
// wiki article at the recorded revision; the bodies here are stubs, because selection
// reads only front matter. Every prompt runs through buildStandardsContext, the entry
// point the agent uses: the classifier plus the wiki-layer recall floor.
//
// Never below main: every prompt and holdout row records, as main_domains, the domains
// origin/main at 82e7561 (before #101) selected, and must keep all of them except the
// ones its below_main entry names with the reason. Negatives are exempt; floor_chatter
// rows get exactly main's domains.
//
// The wiki is a local git repo refreshed once into temp storage, the way every
// standards suite resolves (the fixtureRoot seam went with #83). No network, no sleep
// or poll, and a git timeout that only trips on a hang (see #100). Scoring then runs
// with refresh off, without further git calls.

// Prompts that fail today, by corpus number, with exactly how they fail. A prompt that
// starts passing fails this suite until its line is deleted (a one-line change); a prompt
// not listed here that fails, or a listed one that fails differently, is a regression.
const KNOWN_FAILURES = new Map([
  // "index" now matches the stemmed "indexing", so a gold index task also gets Silver Indexing.
  [22, ["forbidden Silver Indexing"]],
  // "chart" is not a word of the articles' titles or front matter.
  [41, ["missing Power BI Report Visuals"]],
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const golden = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "standards-golden-corpus.json"), "utf8"));
// Fixture roots are resolved to their real path: macOS keeps tmpdir() under the
// /var -> /private/var symlink, which the standards storage-root check rejects.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "coop-std-golden-")));
const wiki = join(tmp, "wiki");
const registryPath = join(tmp, "registry.json");
const options = (more = {}) => ({
  canonicalRoot: join(tmp, "cache", "canonical"), statePath: join(tmp, "cache", "status.json"), snapshotRoot: join(tmp, "snapshots"),
  registryPath, fixtureRegistry: true, remote: wiki, cwd: tmp, now: () => 1_000_000,
  ...more,
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

  // Every active article resolves into the domains buildStandardsContext injects from.
  const pin = pinStandardsTask(WIKI_DOMAINS, options({ refresh: false }));
  assert.deepEqual(WIKI_DOMAINS.flatMap((domain) => pin.resolve(domain).articles.map((a) => a.title)).sort(), golden.wiki.articles.map((a) => a.title).sort());
  const standardsFor = (prompt) => {
    const context = buildStandardsContext(prompt, options({ refresh: false }));
    return { domains: [...context.domains], injected: context.records.flatMap((r) => titles(r.sections)), headings: context.records.flatMap((r) => r.sections.map((s) => s.heading)) };
  };

  const reasonsFor = (c) => {
    const { domains, injected, headings } = standardsFor(c.prompt);
    return [
      ...c.domains_expected.filter((d) => !domains.includes(d)).map((d) => `missing domain ${d}`),
      ...c.must_include.filter((t) => !injected.includes(t)).map((t) => `missing ${t}`),
      ...c.must_not_include.filter((t) => injected.includes(t)).map((t) => `forbidden ${t}`),
      ...(c.no_standards ? headings.map((h) => `injected ${h}`) : []),
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

  // Holdout rows: ordinary wording from outside the 52 (a Power BI report with a slicer,
  // visual, bookmark, tooltip, theme or card; a gold proc, sproc, SP or merge; "silver
  // custtable"; "... to silver"; the warehouse in a Fabric workspace; bronze -> silver;
  // a gold fact or dimension table next to a measure or "the model"; a page or matrix
  // subtotals on a report called Marketing or Project Status; README naming conventions),
  // plus a churn model and a business model canvas "measures" that must get nothing.
  // Every one passes; there is no known-failures list here.
  assert.ok(golden.holdout.length >= 26);
  const holdoutWrong = golden.holdout.map((c) => ({ prompt: c.prompt, reasons: reasonsFor(c) })).filter((row) => row.reasons.length);
  assert.deepEqual(holdoutWrong, []);

  // Never below main (#101): the classifier and the recall floor together keep every
  // domain origin/main selected, except the ones a row's below_main names. A below_main
  // domain must be one main selected and this code does not, so a stale entry fails too.
  const belowMain = [...golden.prompts, ...golden.holdout].flatMap((c) => {
    assert.ok(Array.isArray(c.main_domains), `main_domains recorded for: ${c.prompt}`);
    const { domains } = standardsFor(c.prompt);
    const allowed = c.below_main?.domains || [];
    if (allowed.length) assert.ok(c.below_main.why, `below_main says why: ${c.prompt}`);
    return [
      ...c.main_domains.filter((d) => !domains.includes(d) && !allowed.includes(d)).map((d) => `${c.prompt}: lost main's ${d}`),
      ...allowed.filter((d) => !c.main_domains.includes(d) || domains.includes(d)).map((d) => `${c.prompt}: stale below_main ${d}`),
    ];
  });
  assert.deepEqual(belowMain, []);

  // Negatives get no standards through the real entry point, with the wiki generation
  // active: the floor never reaches some ("format strings in the Python logging calls",
  // "accounts.py views", "example.com views", a [Project Name] placeholder, a visual for
  // slides or a visual merchandising role next to "measures", a measure table for
  // recipes), and gives way in the known non-coding contexts for the rest (a status
  // report, a report generator or button, gold/silver badges, sponsors, tiers and colors,
  // README and website wording).
  const leaked = golden.negatives.map((prompt) => ({ prompt, injected: standardsFor(prompt).headings })).filter((row) => row.injected.length);
  assert.deepEqual(leaked, []);

  // Floor chatter: everyday prompts the floor reaches outside those contexts (a
  // quarterly report, "report the failing tests", fabric samples, a merge conflict in
  // the gold branch). They get exactly main's domains: extra context on chatter is the
  // accepted price of never missing a standard on real coding work.
  const chatter = golden.floor_chatter.map((c) => ({ prompt: c.prompt, expected: [...c.main_domains].sort(), actual: standardsFor(c.prompt).domains.sort() }))
    .filter((row) => JSON.stringify(row.expected) !== JSON.stringify(row.actual));
  assert.deepEqual(chatter, []);

  const narrower = [...golden.prompts, ...golden.holdout].filter((c) => c.below_main).length;
  console.log(`  ✓ golden prompts: ${passing}/${golden.prompts.length} pass, ${KNOWN_FAILURES.size} known failures; ${golden.holdout.length}/${golden.holdout.length} holdout prompts pass; every row keeps main's domains (${narrower} narrower by design); ${golden.negatives.length} negatives get no standards; ${golden.floor_chatter.length} floor-chatter prompts get main's domains (wiki ${golden.wiki.revision.slice(0, 7)})`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
