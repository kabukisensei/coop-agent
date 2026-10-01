// The sql-formatting skill: the Cooptimize SQL Prompt export ships unchanged, the
// skill text carries the formatting contract, and the worked example honours the
// mechanical parts of it (four-space indent, uppercase keywords, leading commas
// with no space after them, aligned aliases, indented joins, semicolons).
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "skills/sql-formatting");

// --- the exported style ships unchanged, without user-profile paths -------------
const style = JSON.parse(readFileSync(join(DIR, "sql-prompt-cooptimize-style.json"), "utf8"));
assert.equal(style.metadata.name, "Cooptimize", "style export is the Cooptimize style");
assert.equal(style.lists.placeFirstItemOnNewLine, "always");
assert.equal(style.lists.placeCommasBeforeItems, true);
assert.equal(style.lists.addSpaceAfterComma, false);
assert.equal(style.lists.alignAliases, true);
assert.equal(style.casing.reservedKeywords, "uppercase");
assert.equal(style.casing.builtInFunctions, "uppercase");
assert.equal(style.casing.builtInDataTypes, "uppercase");
assert.equal(style.casing.useObjectDefinitionCase, true);
assert.equal(style.joinStatements.join.keywordAlignment, "indented");
assert.equal(style.joinStatements.on.keywordAlignment, "indented");
assert.equal(style.parentheses.collapseParenthesesShorterThan, 75);
assert.equal(style.controlFlow.collapseStatementsShorterThan, 78);
assert.equal(style.variables.placeEqualsSignOnNewLine, true);

const layout = readFileSync(join(DIR, "sql-prompt-layout-options.xml"), "utf8");
for (const expected of [
  "<IndentationAmount>4</IndentationAmount>",
  "<FormatActionLayout>true</FormatActionLayout>",
  "<FormatActionApplyCasing>true</FormatActionApplyCasing>",
  "<FormatActionInsertSemicolons>true</FormatActionInsertSemicolons>",
  "<FormatActionExpandWildCards>false</FormatActionExpandWildCards>",
  "<FormatActionQualifyObjectNames>false</FormatActionQualifyObjectNames>",
  "<FormatActionRemoveSquareBrackets>false</FormatActionRemoveSquareBrackets>",
  "<FormatActionAddRemoveAsFromTableAlias>false</FormatActionAddRemoveAsFromTableAlias>",
  "<FormatActionNormaliseColumnAlias>false</FormatActionNormaliseColumnAlias>",
]) {
  assert.ok(layout.includes(expected), `layout options carry ${expected}`);
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
for (const file of walk(DIR)) {
  const text = readFileSync(file, "utf8");
  assert.ok(!/C:\\Users|AppData|quiddity/i.test(text), `${file} carries no local user-profile path`);
}

// --- the skill text carries the contract -----------------------------------------
const skill = readFileSync(join(DIR, "SKILL.md"), "utf8");
assert.ok(/^name: sql-formatting$/m.test(skill), "skill is named sql-formatting");
for (const needle of [
  "sql-prompt-cooptimize-style.json",
  "sql-prompt-layout-options.xml",
  "examples/formatted.sql",
  "four spaces per level",
  "uppercase reserved keywords",
  "terminate every statement with `;`",
  "no space\n  after the comma",
  "Align column-alias\n  `AS` keywords",
  "indent the `JOIN` keyword one level under `FROM`",
  "indent `ON` one level under the join",
  "shorter than 75 characters (78 for control-flow",
  "`=` on a new indented line",
  "Formatting is presentation only",
  "expand `*` wildcards",
  "qualify object names",
  "add or remove square brackets",
  "## Where the style and the wiki differ",
]) {
  assert.ok(skill.includes(needle), `skill states: ${JSON.stringify(needle)}`);
}
assert.ok(!/coop-sql-review|sql_review/.test(skill), "skill does not point at the retired review CLI");

// --- the worked example honours the mechanical rules ----------------------------
const sql = readFileSync(join(DIR, "examples/formatted.sql"), "utf8");
const lines = sql.split("\n");
const code = lines
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => line.trim() !== "" && !line.trim().startsWith("--"));
const strip = (line) => line.replace(/--.*$/, "").replace(/N?'[^']*'/g, "''");
const indentOf = (line) => line.length - line.trimStart().length;

assert.ok(!sql.includes("\t"), "example uses spaces, never tabs");

let leadingCommas = 0;
for (const { line, n } of code) {
  const indent = indentOf(line);
  const body = line.trimStart();
  if (body.startsWith(",")) {
    leadingCommas += 1;
    assert.equal(indent % 4, 3, `line ${n}: a leading comma sits one column left of the list item`);
    assert.notEqual(body[1], " ", `line ${n}: no space after a leading comma`);
  } else if (/^(AND|OR)\b/.test(body)) {
    assert.ok(indent > 4, `line ${n}: AND/OR is aligned with the first predicate, not a clause`);
  } else {
    assert.equal(indent % 4, 0, `line ${n}: indentation is a multiple of four spaces`);
  }
}
assert.ok(leadingCommas >= 12, "example exercises leading-comma lists");

const keywords = "select|from|where|inner|left|join|on|and|or|group|order|by|with|as|case|when|then|else|end|declare|set|create|table|insert|into|values|top|distinct|constraint|primary|key|clustered|identity|not|null|in|desc|count|max|upper|dateadd|sysdatetime|int|nvarchar|day";
const lower = new RegExp(`(^|[^\\w.@\\[])(${keywords})(?=[^\\w\\]]|$)`, "gm");
for (const { line, n } of code) {
  const bare = strip(line);
  const hits = [...bare.matchAll(lower)].map((m) => m[2]).filter((w) => w === w.toLowerCase());
  assert.deepEqual(hits, [], `line ${n}: keywords, functions and types are uppercase`);
}

const statementStarts = code.filter(({ line }, i) =>
  /^(DECLARE|SET|WITH|SELECT|CREATE|INSERT)\b/.test(line)
  && (i === 0 || strip(code[i - 1].line).trimEnd().endsWith(";"))).length;
const terminated = code.filter(({ line }) => strip(line).trimEnd().endsWith(";")).length;
assert.ok(statementStarts >= 6, "example has several statements");
assert.equal(terminated, statementStarts, "every statement ends with a semicolon");
assert.ok(strip(code[code.length - 1].line).trimEnd().endsWith(";"), "the last statement is terminated");

let lastFrom = null;
let lastJoin = null;
let joins = 0;
for (const { line, n } of code) {
  const body = line.trimStart();
  const indent = indentOf(line);
  if (/^FROM\b/.test(body)) lastFrom = indent;
  if (/^(INNER|LEFT) JOIN\b/.test(body)) {
    joins += 1;
    assert.equal(indent, lastFrom + 4, `line ${n}: JOIN is indented one level under FROM`);
    assert.ok(/JOIN \S/.test(body), `line ${n}: the joined table stays on the JOIN line`);
    lastJoin = indent;
  }
  if (/^ON\b/.test(body)) assert.equal(indent, lastJoin + 4, `line ${n}: ON is indented one level under its JOIN`);
}
assert.ok(joins >= 1, "example has a join");

const listStart = lines.findIndex((l) => l.startsWith("SELECT TOP"));
const listEnd = lines.findIndex((l, i) => i > listStart && l.startsWith("FROM"));
const aliasColumns = new Set(
  lines.slice(listStart + 1, listEnd).filter((l) => / AS /.test(l)).map((l) => l.indexOf(" AS ")));
assert.equal(aliasColumns.size, 1, "column-alias AS keywords are aligned within the select list");
assert.ok(lines[listStart + 1].startsWith("    "), "the list starts on a new line after TOP");

assert.ok(/^SET @Company\n    = /m.test(sql), "a SET assignment puts = on a new indented line");
assert.ok(/IN \( [^)]+ \)/.test(sql), "IN lists stay on one line with spaces inside the parentheses");
assert.ok(/^    END\s+AS /m.test(sql), "END aligns with CASE and carries the alias");

console.log("✓ sql-formatting skill: export unchanged, contract stated, worked example conforms");
