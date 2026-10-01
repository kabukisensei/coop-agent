---
name: sql-formatting
description: Lay out T-SQL coop writes or reformats in the Cooptimize SQL Prompt style (4-space indent, uppercase keywords, leading commas, aligned aliases, indented joins, semicolons). Presentation only.
---

# SQL formatting (Cooptimize SQL Prompt style)

Apply this skill whenever coop **writes** T-SQL (a new statement, view, procedure,
query, or a rewritten block) or is **asked to reformat** existing T-SQL. It governs
layout only. Correctness, naming, performance and safety stay with the resolved
standards (the coop-standards wiki's *SQL Conventions*, *SQL Layout* and the
Gold/Silver articles) and the task itself.

## Source of truth

The canonical style is the Cooptimize SQL Prompt 11 export shipped unchanged next
to this file:

| File | Role |
|---|---|
| `sql-prompt-cooptimize-style.json` | The custom style (lists, parentheses, casing, DML/DDL, joins, operators). The formatting source of truth. |
| `sql-prompt-layout-options.xml` | The format-action settings: four-space indentation, apply layout and casing, insert semicolons, and the actions SQL Prompt must **not** take. |
| `examples/formatted.sql` | A worked example of the style. Where it disagrees with the JSON, the JSON wins. |

coop does not run SQL Prompt. It reproduces the style by hand from the rules below.
A teammate with SQL Prompt 11 can import the JSON as a custom style and get the same
result (`SQL Prompt > Options > Styles > Import`).

## Precedence

1. A more specific instruction from the user for this task.
2. A target file whose existing statements already follow one consistent, deliberate
   style: keep it during a targeted edit (SQL Conventions, "Defaults when editing
   existing code").
3. This style, for new SQL and for a requested reformat.

Aaron set this style as coop's default on 2026-10-01. Where it differs from the
wiki's *SQL Layout* article the style wins by that decision; the differences are
listed at the end so the wiki can be brought into line rather than drift.

## The contract

Apply all of these to SQL you write or are asked to reformat:

- **Indentation**: four spaces per level, never tabs.
- **Casing**: uppercase reserved keywords, built-in functions, built-in data types and
  global variables (`SELECT`, `COALESCE`, `NVARCHAR`, `@@ROWCOUNT`). Keep identifiers
  exactly as the object was defined (`useObjectDefinitionCase`); do not change the
  case of tables, columns, aliases or variables.
- **Semicolons**: terminate every statement with `;`.
- **Lists** (select lists, column lists, `GROUP BY`, `ORDER BY`, `VALUES`, CTE
  lists): the first item goes on a new line, indented one level. Every following
  item starts with a leading comma one column left of the first item and **no space
  after the comma**. Lists align internally, not across clauses. Align column-alias
  `AS` keywords and trailing comments within a list.
- **`DISTINCT` / `TOP`**: the list starts on a new line after them.
- **Joins**: indent the `JOIN` keyword one level under `FROM`; keep the joined table
  on the `JOIN` line; indent `ON` one level under the join. Align each `AND` / `OR`
  with the first predicate after `ON` or `WHERE`.
- **Parentheses** in statements (DML and DDL): expand to statement level, with the
  opening and closing parenthesis on their own lines aligned with the owning keyword
  and the contents indented one level. `IN (...)` stays on one line with a space
  inside each parenthesis.
- **Short things stay compact**: a whole statement, a parenthesised expression, a
  subquery or a `CASE` expression shorter than 75 characters (78 for control-flow
  statements such as `IF` / `WHILE` bodies) may stay on one line. Longer ones expand.
- **`CASE`** longer than the threshold: `WHEN` / `ELSE` each on its own indented line,
  `END` aligned with `CASE`, the alias after `END`.
- **Variables**: a `SET` / `DECLARE` assignment puts the `=` on a new indented line.
- **`INSERT ... VALUES`**: indent the contents of the `VALUES` parentheses.
- **DDL**: align data types and constraints into columns; put each constraint on its
  own line; put constraint columns on new lines when the column list is long or has
  more than one column.
- **Batch separators**: do not preserve stray empty lines after `GO`.

## What formatting never does

Formatting is presentation only. It must not change what a statement returns,
touch unrelated lines, or make any of these changes, which the exported options
switch off (`sql-prompt-layout-options.xml`):

- expand `*` wildcards;
- qualify object names or add or remove schema prefixes;
- add or remove square brackets;
- add or remove `AS` on table aliases or normalise column aliases;
- rename identifiers, reorder joins, or rewrite expressions.

Those are standards questions, not layout: when coop **writes** new SQL it still
follows SQL Conventions (explicit projections, `AS` on every alias, schema-qualified
permanent objects, brackets only where required), and a review may still raise them
as findings. A reformat request alone does not license them.

## Where the style and the wiki differ

The coop-standards *SQL Layout* article was written before this export. Known
differences (style wins by Aaron's 2026-10-01 decision; propose a wiki update when
you touch one):

| Point | SQL Layout article | This style |
|---|---|---|
| Select-list indent | Six spaces before the first expression, comma at column five | Four spaces, comma at column four |
| CTE-name indent | Five spaces | Four spaces |
| `JOIN` keyword | Aligned with `FROM` | Indented one level under `FROM` |
| `AND` / `OR` | Indented four spaces under `WHERE` / `ON` | Aligned with the first predicate |
| Short `CASE` | Always one `WHEN` per line | Collapses to one line under 75 characters |
| Square brackets | "Remove unnecessary square brackets" when formatting with SQL Prompt | Formatting leaves brackets alone (new SQL still uses brackets only where required) |

Everything else in *SQL Layout* (aligned `AS`, `ON` indented under its join, major
clauses on their own lines, `END` aligned with `CASE`, an explanatory comment above
`EXISTS`) agrees with the style.

## Not defined by the export

The export does not set an identifier-case policy, a maximum line length, or every
SQL Prompt default. Do not invent those. Follow the existing file or the standards
where they speak; otherwise leave the line as written.
