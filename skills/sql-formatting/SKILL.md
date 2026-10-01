---
name: sql-formatting
description: Lay out T-SQL coop writes or reformats in the Cooptimize style (wiki SQL Layout, then the SQL Prompt export; uppercase keywords, leading commas, aligned aliases, semicolons). Presentation only.
---

# SQL formatting (Cooptimize style)

Apply this skill whenever coop **writes** T-SQL (a new statement, view, procedure,
query, or a rewritten block) or is **asked to reformat** existing T-SQL. It governs
layout only. Correctness, naming, performance and safety stay with the resolved
standards (the coop-standards wiki's *SQL Conventions*, *SQL Layout* and the
Gold/Silver articles) and the task itself.

## Sources of truth

Two sources, in this order:

1. The coop-standards wiki's **SQL Layout** article (in COOP's resolved standards;
   bundled copy under `config/standards-bundle/SQL/`). Where it speaks, it wins.
2. Aaron's **Cooptimize SQL Prompt 11 export**, shipped unchanged next to this file,
   for everything the article leaves open.

| File | Role |
|---|---|
| `sql-prompt-cooptimize-style.json` | The custom style (lists, parentheses, casing, DML/DDL, joins, operators). |
| `sql-prompt-layout-options.xml` | The format-action settings: four-space indentation, apply layout and casing, insert semicolons, and the actions SQL Prompt must **not** take. |
| `examples/formatted.sql` | A worked example of the combined layout. Where it disagrees with this file, this file wins. |

coop does not run SQL Prompt. It reproduces the layout by hand from the rules below.

## Precedence

1. A more specific instruction from the user for this task.
2. A target file whose existing statements already follow one consistent, deliberate
   style: keep it during a targeted edit (SQL Conventions, "Defaults when editing
   existing code").
3. The rules below, for new SQL and for a requested reformat.

Aaron confirmed on 2026-10-01 that the wiki wins where it and the export differ;
the differences are listed at the end so nobody re-derives them.

## The contract

Apply all of these to SQL you write or are asked to reformat:

- **Indentation**: spaces, never tabs. Four spaces per nesting level, except the
  list columns below, which the wiki fixes.
- **Casing**: uppercase reserved keywords, built-in functions, built-in data types and
  global variables (`SELECT`, `COALESCE`, `NVARCHAR`, `@@ROWCOUNT`). Keep identifiers
  exactly as the object was defined (`useObjectDefinitionCase`); do not change the
  case of tables, columns, aliases or variables.
- **Semicolons**: terminate every statement with `;`.
- **Lists** (select lists, column lists, `GROUP BY`, `ORDER BY`, `VALUES`): the first
  item goes on a new line, six spaces in at the outermost level. Every following item
  starts with a leading comma one column left of the first item and **no space after
  the comma**. Lists align internally, not across clauses. Within each contiguous
  projection section, align column-alias `AS` keywords at one visual column, and
  align trailing comments; a blank line or organising comment starts a new section.
  Do not align `AS` used for tables, CTEs or `CREATE ... AS`.
- **CTEs**: `WITH` on its own line; CTE names five spaces in, each continuation comma
  one column left of the name with no space after it.
- **`DISTINCT` / `TOP`**: the list starts on a new line after them.
- **Major clauses**: `SELECT`, `FROM`, `WHERE`, `GROUP BY` and `ORDER BY` each start a
  line, aligned with each other.
- **Joins**: `JOIN` aligned with `FROM`, the joined table on the `JOIN` line; `ON`
  four spaces under the join; each further predicate four spaces under `ON`.
- **`WHERE`**: further conditions on separate lines, four spaces under `WHERE`;
  keep the parentheses that control mixed `AND` / `OR` logic.
- **Parentheses** in statements (DML and DDL): expand to statement level, with the
  opening and closing parenthesis on their own lines aligned with the owning keyword
  and the contents indented. `IN (...)` stays on one line with a space inside each
  parenthesis.
- **Short things stay compact**: a whole statement, a parenthesised expression or a
  subquery shorter than 75 characters (78 for control-flow statements such as `IF` /
  `WHILE` bodies) may stay on one line. Longer ones expand.
- **`CASE`**: every `WHEN` and `ELSE` on its own indented line, `END` aligned with
  `CASE`, the alias after `END`. (The wiki fixes this; the export's 75-character
  collapse does not apply to `CASE`.)
- **`EXISTS` / `NOT EXISTS`**: the explanatory comment sits immediately above the
  `WHERE` or `AND` that contains it.
- **Variables**: a `SET` / `DECLARE` assignment puts the `=` on a new indented line.
- **`INSERT ... VALUES`**: indent the contents of the `VALUES` parentheses.
- **DDL**: align data types and constraints into columns; put each constraint on its
  own line; put constraint columns on new lines when the column list is long or has
  more than one column.
- **Square brackets**: on a full reformat, remove brackets that are not required
  (`AS [Customer]` becomes `AS Customer`; `AS [Customer Name]` keeps them). During a
  targeted edit leave existing brackets alone.
- **Batch separators**: do not preserve stray empty lines after `GO`.

## What formatting never does

Formatting is presentation only. It must not change what a statement returns or
touch unrelated lines, and it never makes these changes, which the exported options
switch off (`sql-prompt-layout-options.xml`):

- expand `*` wildcards;
- qualify object names or add or remove schema prefixes;
- add or remove `AS` on table aliases or normalise column aliases;
- rename identifiers, reorder joins, or rewrite expressions.

Those are standards questions, not layout: when coop **writes** new SQL it still
follows SQL Conventions (explicit projections, `AS` on every alias, schema-qualified
permanent objects, brackets only where required), and a review may still raise them
as findings. A reformat request alone does not license them.

## Where the export and the wiki differ

The export predates the wiki's *SQL Layout* article on these points. The wiki wins
(Aaron, 2026-10-01); do not re-open them without a user instruction:

| Point | SQL Prompt export | Wiki, applied |
|---|---|---|
| Select-list indent | Four spaces, comma at column four | Six spaces, comma at column five |
| CTE-name indent | Four spaces | Five spaces, comma at column four |
| `JOIN` keyword | Indented one level under `FROM` | Aligned with `FROM` |
| `AND` / `OR` | Aligned with the first predicate | Four spaces under `WHERE` / `ON` |
| Short `CASE` | Collapses to one line under 75 characters | Always one `WHEN` per line |
| Square brackets | Formatting leaves brackets alone | Unnecessary brackets removed on a full reformat |

A teammate importing the JSON into SQL Prompt gets the export's layout on those six
points, so SQL Prompt output needs those touch-ups before it matches coop's.

## Not defined by either source

Neither source sets an identifier-case policy, a maximum line length, or every SQL
Prompt default. Do not invent those. Follow the existing file or the standards where
they speak; otherwise leave the line as written.
