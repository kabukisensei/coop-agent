// Tests for the data-doc config writer/parser in extensions/coop-tools.
// Imports the bundled extension's named exports (COOP_TEST_DIST set by tests/run.sh).
import { strict as assert } from "node:assert";

const dist = process.env.COOP_TEST_DIST;
const { renderMinimalConfig, parseExisting, updateConfigText, scalarValue, outputDirsConflict, siblingSite } =
  await import(`${dist}/coop-tools.mjs`);

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

console.log(`  ${n} data-doc tests passed`);
