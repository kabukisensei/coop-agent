// The sql-formatting skill: the Cooptimize SQL Prompt export ships unchanged, the
// skill text carries the formatting contract (wiki SQL Layout first, then the
// export), and the worked example honours the mechanical parts of it: six-space
// select lists with the comma one column left and no space after it, five-space
// CTE names, uppercase keywords, aligned aliases, JOIN aligned with FROM, ON four
// under the join, AND four under WHERE/ON, one WHEN per line, semicolons.
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
// Normalise line endings: a Windows checkout with autocrlf hands us CRLF.
const text = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const skill = text(join(DIR, "SKILL.md"));
assert.ok(/^name: sql-formatting$/m.test(skill), "skill is named sql-formatting");
for (const needle of [
  "sql-prompt-cooptimize-style.json",
  "sql-prompt-layout-options.xml",
  "examples/formatted.sql",
  "**SQL Layout** article",
  "Where it speaks, it wins",
  "uppercase reserved keywords",
  "terminate every statement with `;`",
  "six spaces in at the outermost level",
  "no space after\n  the comma",
  "align column-alias `AS` keywords",
  "CTE names five spaces in",
  "`JOIN` aligned with `FROM`",
  "four spaces under the join",
  "four spaces under `WHERE`",
  "every `WHEN` and `ELSE` on its own indented line",
  "shorter than 75 characters (78 for control-flow",
  "`=` on a new indented line",
  "Formatting is presentation only",
  "expand `*` wildcards",
  "qualify object names",
  "## Where the export and the wiki differ",
]) {
  assert.ok(skill.includes(needle), `skill states: ${JSON.stringify(needle)}`);
}
assert.ok(!/coop-sql-review|sql_review/.test(skill), "skill does not point at the retired review CLI");

// --- the worked example honours the mechanical rules ----------------------------
const sql = text(join(DIR, "examples/formatted.sql"));
const lines = sql.split("\n");
const code = lines
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => line.trim() !== "" && !line.trim().startsWith("--"));
const strip = (line) => line.replace(/--.*$/, "").replace(/N?'[^']*'/g, "''");
const indentOf = (line) => line.length - line.trimStart().length;
const body = (line) => line.trimStart();

assert.ok(!sql.includes("\t"), "example uses spaces, never tabs");

// Leading commas: never a space after the comma; the item text lands on the column
// of the item above (comma one column left of the first item).
let leadingCommas = 0;
for (let i = 0; i < code.length; i += 1) {
  const { line, n } = code[i];
  if (!body(line).startsWith(",")) continue;
  leadingCommas += 1;
  assert.notEqual(body(line)[1], " ", `line ${n}: no space after a leading comma`);
  // Walk back to the previous line at a shallower-or-equal depth that is not a
  // nested block line: the item this comma continues.
  let j = i - 1;
  while (j >= 0 && indentOf(code[j].line) > indentOf(line) + 1) j -= 1;
  const prev = code[j].line;
  const prevItemCol = body(prev).startsWith(",") ? indentOf(prev) + 1 : indentOf(prev);
  assert.equal(indentOf(line) + 1, prevItemCol, `line ${n}: comma sits one column left of the list item`);
}
assert.ok(leadingCommas >= 12, "example exercises leading-comma lists");

// Wiki list columns at the outermost level: six for select/group/order lists, five
// for CTE names.
const topSelect = lines.findIndex((l) => l.startsWith("SELECT TOP"));
const topFrom = lines.findIndex((l, i) => i > topSelect && l.startsWith("FROM"));
assert.equal(indentOf(lines[topSelect + 1]), 6, "select list starts six spaces in");
for (const l of lines.slice(topSelect + 1, topFrom)) {
  if (body(l).startsWith(",")) assert.equal(indentOf(l), 5, `select-list comma at column five: ${l.trim()}`);
}
for (const kw of ["GROUP BY", "ORDER BY"]) {
  const at = lines.findIndex((l) => l === kw);
  assert.ok(at > 0, `${kw} on its own line`);
  assert.equal(indentOf(lines[at + 1]), 6, `${kw} list starts six spaces in`);
  assert.equal(indentOf(lines[at + 2]), 5, `${kw} continuation comma at column five`);
}
const withAt = lines.findIndex((l) => l === "WITH");
assert.ok(withAt >= 0, "WITH on its own line");
assert.equal(indentOf(lines[withAt + 1]), 5, "first CTE name five spaces in");
const cteComma = lines.find((l) => /^\s*,\w+ AS$/.test(l));
assert.ok(cteComma && indentOf(cteComma) === 4, "CTE continuation comma at column four");

// Casing.
const keywords = "select|from|where|inner|left|join|on|and|or|group|order|by|with|as|case|when|then|else|end|declare|set|create|table|insert|into|values|top|distinct|constraint|primary|key|clustered|identity|not|null|in|desc|count|max|upper|dateadd|sysdatetime|int|nvarchar|day";
const lower = new RegExp(`(^|[^\\w.@\\[])(${keywords})(?=[^\\w\\]]|$)`, "gm");
for (const { line, n } of code) {
  const hits = [...strip(line).matchAll(lower)].map((m) => m[2]).filter((w) => w === w.toLowerCase());
  assert.deepEqual(hits, [], `line ${n}: keywords, functions and types are uppercase`);
}

// Semicolons.
const statementStarts = code.filter(({ line }, i) =>
  /^(DECLARE|SET|WITH|SELECT|CREATE|INSERT)\b/.test(line)
  && (i === 0 || strip(code[i - 1].line).trimEnd().endsWith(";"))).length;
const terminated = code.filter(({ line }) => strip(line).trimEnd().endsWith(";")).length;
assert.ok(statementStarts >= 6, "example has several statements");
assert.equal(terminated, statementStarts, "every statement ends with a semicolon");
assert.ok(strip(code[code.length - 1].line).trimEnd().endsWith(";"), "the last statement is terminated");

// Joins and predicates.
let lastFrom = null;
let lastJoin = null;
let lastPredicateOwner = null;
let joins = 0;
for (const { line, n } of code) {
  const b = body(line);
  const indent = indentOf(line);
  if (/^FROM\b/.test(b)) lastFrom = indent;
  if (/^WHERE\b/.test(b)) lastPredicateOwner = indent;
  if (/^(INNER|LEFT) JOIN\b/.test(b)) {
    joins += 1;
    assert.equal(indent, lastFrom, `line ${n}: JOIN is aligned with FROM`);
    assert.ok(/JOIN \S/.test(b), `line ${n}: the joined table stays on the JOIN line`);
    lastJoin = indent;
  }
  if (/^ON\b/.test(b)) {
    assert.equal(indent, lastJoin + 4, `line ${n}: ON is four spaces under its JOIN`);
    lastPredicateOwner = indent;
  }
  if (/^(AND|OR)\b/.test(b)) assert.equal(indent, lastPredicateOwner + 4, `line ${n}: AND/OR is four spaces under WHERE/ON`);
}
assert.ok(joins >= 1, "example has a join");

// Aliases aligned within the select list; one WHEN per line; END aligned with CASE.
const aliasColumns = new Set(
  lines.slice(topSelect + 1, topFrom).filter((l) => / AS /.test(l)).map((l) => l.indexOf(" AS ")));
assert.equal(aliasColumns.size, 1, "column-alias AS keywords are aligned within the select list");
const caseAt = lines.findIndex((l) => /^\s*,CASE$/.test(l));
assert.ok(caseAt > 0, "CASE opens its own line");
const caseCol = lines[caseAt].indexOf("CASE");
const endAt = lines.findIndex((l, i) => i > caseAt && /^\s*END\b/.test(l));
assert.equal(indentOf(lines[endAt]), caseCol, "END aligns with CASE");
assert.ok(/^\s*END\s+AS /.test(lines[endAt]), "the alias follows END");
for (const l of lines.slice(caseAt + 1, endAt)) {
  assert.ok(/^\s*(WHEN|ELSE)\b/.test(l), `one WHEN/ELSE per line: ${l.trim()}`);
  assert.equal(indentOf(l), caseCol + 4, `WHEN/ELSE indented four under CASE: ${l.trim()}`);
}

assert.ok(/^SET @Company\n    = /m.test(sql), "a SET assignment puts = on a new indented line");
assert.ok(/IN \( [^)]+ \)/.test(sql), "IN lists stay on one line with spaces inside the parentheses");
assert.ok(!/AS \[\w+\]/.test(sql), "no unnecessary square brackets around single-word aliases");

console.log("✓ sql-formatting skill: export unchanged, contract stated, worked example conforms");
