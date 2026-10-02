// Tests for the coop-data-doc.yml reader (parseExisting / scalarValue) and the
// project-contract review scoping (findProjectYml / contractRepoPaths /
// contractReviewScope) in extensions/coop-tools. coop never writes
// coop-data-doc.yml itself (the companion's JSONL wizard owns it), so only the
// read side is pinned here.
// Imports the bundled extension's named exports (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// COOP_TEST_DIST is an ABSOLUTE path; a bare `C:\...` is not a valid ESM URL on
// Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME), so import it via a file:// URL.
const dist = process.env.COOP_TEST_DIST;
const {
  parseExisting, scalarValue,
  findProjectYml, contractRepoPaths, contractReviewScope,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
};

t("parseExisting reads project name, repo paths, output dir and derives sourceMode", () => {
  const yml = [
    "# coop-data-doc configuration",
    'project_name: "Coop Estate"',
    "repos:",
    "  sql:",
    '    path: "./sql"',
    '    include: ["**/*.sql"]',
    "  staging:",
    '    path: "./staging"',
    "  powerbi:",
    "    path: ../pbi   # relative to this file",
    "schema_mappings: []",
    "output:",
    '  dir: "./data-docs"        # markdown docs',
    '  site_dir: "./data-docs-site"',
    'sql_dialect: "tsql"',
    "",
  ].join("\n");
  const cfg = parseExisting(yml);
  assert.equal(cfg.projectName, "Coop Estate");
  assert.equal(cfg.sqlPath, "./sql");
  assert.equal(cfg.pbiPath, "../pbi");
  assert.equal(cfg.outputDir, "./data-docs");
  assert.equal(cfg.sourceMode, "both");
  assert.equal("siteDir" in cfg, false, "output.site_dir is the companion's, never read");
  assert.equal(parseExisting('repos:\n  sql:\n    path: "./sql"\n').sourceMode, "sql");
  assert.equal(parseExisting('repos:\n  powerbi:\n    path: "./pbi"\n').sourceMode, "powerbi");
  const none = parseExisting("");
  assert.equal(none.sourceMode, "none");
  assert.equal(none.outputDir, undefined, "a missing output.dir is left to the caller's default");
});

t("scalarValue handles quotes, '' escapes and # comments", () => {
  assert.equal(scalarValue(` "./data-docs"   # note`), "./data-docs");
  assert.equal(scalarValue(` 'Bob''s Estate'`), "Bob's Estate");
  assert.equal(scalarValue(` C#-models`), "C#-models"); // # not whitespace-preceded → kept
  assert.equal(scalarValue(` ./d   # c`), "./d");
});

t("scalarValue decodes the YAML escapes coop-data-doc writes for non-ASCII values", () => {
  // coop-data-doc 1.3.0 writes every non-ASCII character as \uXXXX (row 11a, Windows check).
  assert.equal(scalarValue(` "Entrep\\u00f4t SQL"`), "Entrepôt SQL");
  assert.equal(scalarValue(` "Domaine \\u00dcn\\u00efcode \\u2013 \\u00c9t\\u00e9"`), "Domaine Ünïcode – Été");
  assert.equal(scalarValue(` "\\U0001F600 \\x41"`), "😀 A");
  assert.equal(scalarValue(` "C:\\\\data\\"docs\\"\\tx"`), 'C:\\data"docs"\tx');
  assert.equal(scalarValue(` "bad \\u12 end"`), "bad u12 end"); // malformed escape: no throw
  const cfg = parseExisting('project_name: "Mod\\u00e8le"\nrepos:\n  sql:\n    path: "./Entrep\\u00f4t SQL"\n');
  assert.equal(cfg.projectName, "Modèle");
  assert.equal(cfg.sqlPath, "./Entrepôt SQL");
});

// --- project-contract review scoping (issue #25) -----------------------------

t("contractRepoPaths: filled paths extracted, TODO placeholders reported", () => {
  const yml = [
    "profile:",
    '  organization: "Cooptimize"',
    "repositories:",
    "  fabric:",
    '    description: "Semantic models"',
    '    local_path: "/work/fabric"',
    "  fabric_dw:",
    '    local_path: "./fabric-dw"   # relative is fine',
    '    sql_root: "sql"',
    "  extras:",
    '    local_path: "TODO: /path/to/extras"',
    "fabric:",
    '  tenant_id: "t-1"',
  ].join("\n");
  const { paths, todo } = contractRepoPaths(yml);
  assert.deepEqual(paths, ["/work/fabric", "./fabric-dw"]);
  assert.deepEqual(todo, ["extras"]);
});

t("contractRepoPaths: no repositories section -> nothing", () => {
  const { paths, todo } = contractRepoPaths('profile:\n  organization: "Cooptimize"\n');
  assert.deepEqual(paths, []);
  assert.deepEqual(todo, []);
});

t("findProjectYml walks up; contractReviewScope resolves + filters", () => {
  const T = mkdtempSync(join(tmpdir(), "coop-scope-"));
  try {
    // <T>/proj/.coop/project.yml declares one existing repo (relative), one
    // missing, one TODO; a nested workdir finds the contract by walking up.
    mkdirSync(join(T, "proj", ".coop"), { recursive: true });
    mkdirSync(join(T, "proj", "sqlrepo"), { recursive: true });
    mkdirSync(join(T, "proj", "deep", "nested"), { recursive: true });
    const contract = join(T, "proj", ".coop", "project.yml");
    writeFileSync(
      contract,
      [
        "repositories:",
        "  warehouse:",
        '    local_path: "./sqlrepo"',
        "  reports:",
        '    local_path: "./no-such-dir"',
        "  extras:",
        '    local_path: "TODO: fill me"',
        "",
      ].join("\n"),
    );
    assert.equal(findProjectYml(join(T, "proj", "deep", "nested")), contract);
    const scope = contractReviewScope(join(T, "proj", "deep", "nested"));
    assert.equal(scope.contract, contract);
    assert.deepEqual(scope.paths, [resolve(T, "proj", "sqlrepo")]);
    assert.deepEqual(scope.skippedMissing, ["./no-such-dir"]);
    assert.deepEqual(scope.skippedTodo, ["extras"]);
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
});

t("contractReviewScope: no contract anywhere -> empty scope (fallback to '.')", () => {
  const T = mkdtempSync(join(tmpdir(), "coop-noscope-"));
  try {
    const scope = contractReviewScope(T);
    // NB: if a stray .coop/project.yml exists in a tmpdir ancestor this walk would
    // find it — tolerated: assert only when nothing was found.
    if (scope.contract === null) {
      assert.deepEqual(scope.paths, []);
      assert.deepEqual(scope.skippedTodo, []);
      assert.deepEqual(scope.skippedMissing, []);
    }
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
});

t("contractReviewScope: all-TODO contract -> empty paths (fallback), repos noted", () => {
  const T = mkdtempSync(join(tmpdir(), "coop-todoscope-"));
  try {
    mkdirSync(join(T, ".coop"), { recursive: true });
    writeFileSync(
      join(T, ".coop", "project.yml"),
      'repositories:\n  fabric:\n    local_path: "TODO: /path/to/fabric"\n',
    );
    const scope = contractReviewScope(T);
    assert.deepEqual(scope.paths, []);
    assert.deepEqual(scope.skippedTodo, ["fabric"]);
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
});

console.log(`  ${n} review-scope tests passed`);
