// Tests for the data-doc config writer/parser + project-contract review scoping
// in extensions/coop-tools.
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
  renderMinimalConfig, parseExisting, updateConfigText, scalarValue, outputDirsConflict, siblingSite,
  findProjectYml, contractRepoPaths, contractReviewScope,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
};

t("render → parse round-trips the 5 managed fields", () => {
  const s = { projectName: "Coop Estate", sqlPath: "./sql", pbiPath: "./pbi", outputDir: "./data-docs", siteDir: "./data-docs-site" };
  const yml = renderMinimalConfig(s);
  const back = parseExisting(yml);
  assert.equal(back.projectName, s.projectName);
  assert.equal(back.sqlPath, s.sqlPath);
  assert.equal(back.pbiPath, s.pbiPath);
  assert.equal(back.outputDir, s.outputDir);
  assert.equal(back.siteDir, s.siteDir);
});

t("updateConfigText patches IN PLACE and preserves rich config", () => {
  const rich = [
    'project_name: "Old"',
    "repos:",
    '  sql:',
    '    path: "../old-sql"',
    '    include: ["models/**/*.sql"]',
    "  powerbi:",
    '    path: "../old-pbi"',
    "schema_mappings:",
    '  - schema: "sales"',
    '    model: "Sales"',
    "layers:",
    "  gold:",
    '    schemas: ["mart"]',
    'sql_dialect: "snowflake"',
    "output:",
    '  dir: "./data-docs"        # comment kept',
    '  site_dir: "./data-docs-site"',
    "",
  ].join("\n");
  const out = updateConfigText(rich, { projectName: "New", sqlPath: "./sql", pbiPath: "./pbi", outputDir: "./d", siteDir: "./d-site" });
  assert.match(out, /project_name: "New"/);
  assert.match(out, /path: "\.\/sql"/);
  assert.match(out, /path: "\.\/pbi"/);
  assert.match(out, /dir: "\.\/d"/);
  // preserved, untouched:
  assert.match(out, /models\/\*\*\/\*\.sql/, "include glob preserved");
  assert.match(out, /schema: "sales"/, "schema mapping preserved");
  assert.match(out, /schemas: \["mart"\]/, "layer preserved");
  assert.match(out, /sql_dialect: "snowflake"/, "dialect preserved");
  assert.match(out, /# comment kept/, "inline comment preserved");
  assert.doesNotMatch(out, /old-sql/, "old path replaced");
});

t("scalarValue handles quotes, '' escapes and # comments", () => {
  assert.equal(scalarValue(` "./data-docs"   # note`), "./data-docs");
  assert.equal(scalarValue(` 'Bob''s Estate'`), "Bob's Estate");
  assert.equal(scalarValue(` C#-models`), "C#-models"); // # not whitespace-preceded → kept
  assert.equal(scalarValue(` ./d   # c`), "./d");
});

t("outputDirsConflict: same/nested conflict, sibling ok (separator-aware)", () => {
  const r = (p) => process.cwd() + "/" + p;
  assert.equal(outputDirsConflict(r("docs"), r("docs")), true);
  assert.equal(outputDirsConflict(r("docs"), r("docs/site")), true);
  assert.equal(outputDirsConflict(r("data-docs"), r("data-docs-site")), false);
});

t("siblingSite appends -site to the markdown dir", () => {
  assert.equal(siblingSite("./data-docs"), "./data-docs-site");
  assert.equal(siblingSite("./docs/"), "./docs-site");
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

console.log(`  ${n} data-doc tests passed`);
