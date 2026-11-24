// Lineage docs from the live dev database: the coop-tools side (what /setup-docs
// offers, what a session start refreshes, how a result reads). The helper that
// resolves the dev targets and runs coop-data-doc is tests/live-docs.test.py.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
if (!dist) { console.error("COOP_TEST_DIST not set"); process.exit(1); }
const tools = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const root = mkdtempSync(join(tmpdir(), "coop-live-docs-"));

t("a config reads a live database only with a filled live_sources block", () => {
  assert.equal(tools.hasLiveSources('repos:\n  sql:\n    path: "./sql"\n'), false);
  assert.equal(tools.hasLiveSources("live_sources: {}\noutput:\n  dir: x\n"), false);
  assert.equal(tools.hasLiveSources("# live_sources:\n#   dev:\n"), false);
  assert.equal(tools.hasLiveSources('live_sources:\n  "dev":\n    server: "h"\n'), true);
  assert.equal(tools.hasLiveSources('live_sources:   # from dev\r\n  "dev":\r\n    server: "h"\r\n'), true);
});

t("the live choice is offered only when the project file names a dev SQL target", () => {
  const none = join(root, "none");
  mkdirSync(join(none, ".coop"), { recursive: true });
  writeFileSync(join(none, ".coop", "project.yml"), "profile:\n  client: 'Contoso'\n");
  assert.equal(tools.hasDevSqlTarget(none), false);
  assert.equal(tools.hasDevSqlTarget(join(root, "no-contract")), false);

  const prodOnly = join(root, "prod");
  mkdirSync(join(prodOnly, ".coop"), { recursive: true });
  writeFileSync(join(prodOnly, ".coop", "project.yml"), "sql_targets:\n  default_environment: dev\n  dev:\n    kind: 'azure_sql'\n    server: ''\n    database: ''\n  prod:\n    kind: 'azure_sql'\n    server: 'contoso.database.windows.net'\n    database: 'ContosoDW'\n");
  assert.equal(tools.hasDevSqlTarget(prodOnly), false);

  const dev = join(root, "dev");
  mkdirSync(join(dev, ".coop"), { recursive: true });
  writeFileSync(join(dev, ".coop", "project.yml"), "sql_targets:\n  default_environment: dev\n  dev:\n    kind: 'azure_sql'\n    server: 'contoso-dev.database.windows.net'\n    database: 'ContosoDW'\n");
  assert.equal(tools.hasDevSqlTarget(dev), true);

  const named = join(root, "named");
  mkdirSync(join(named, ".coop"), { recursive: true });
  writeFileSync(join(named, ".coop", "project.yml"), "sql_targets:\n  default_environment: test\n  test:\n    kind: 'azure_sql'\n    server: 'contoso-test.database.windows.net'\n    database: 'ContosoDW'\n  named:\n    lake:\n      dev:\n        kind: 'azure_sql'\n        server: 'contoso-lake-dev.database.windows.net'\n        database: 'Lake'\n");
  assert.equal(tools.hasDevSqlTarget(named), true);
});

t("a refresh reads as one clause per source, with no host and no token", () => {
  const text = tools.liveDocsSummary({ sources: [
    { name: "dev", state: "taken", objects: { view: 9, table: 5, procedure: 1 }, unread: 2 },
    { name: "dev_lake", state: "fresh", age_days: 2.5 },
    { name: "other", state: "not_a_dev_target" },
    { name: "slow", state: "tool_timeout" },
    { name: "bad", state: "snapshot_failed" },
  ] });
  assert.equal(text, "dev: 1 procedure, 5 table, 9 view; 2 could not be read with this sign-in; dev_lake: up to date (2.5 day(s) old); other: skipped, it is not a dev target of .coop/project.yml; slow: the read did not finish in time; bad: the read failed (run `coop data-doc snapshot bad` in a shell for the reason)");
  assert.equal(tools.liveDocsSummary({}), "");
  assert.equal(tools.LIVE_DOCS_MAX_AGE_DAYS, 7);
});

rmSync(root, { recursive: true, force: true });
console.log(`✓ live docs (${n} tests)`);
