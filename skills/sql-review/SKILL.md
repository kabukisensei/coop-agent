---
name: sql-review
description: Run and interpret coop-sql-review on T-SQL (Fabric Warehouse/Lakehouse, medallion bronze/silver/gold) — check {paths} --format json — then summarize findings by severity, cite file:line, and suggest fixes. Advisory only; never edits or blocks.
---

# SQL Review

## Purpose

Run the advisory T-SQL standards check (`coop-sql-review`) over SQL files and turn
the JSON output into a clear, prioritized summary the user can act on. This skill
is advisory: it reports findings and suggests fixes but never edits files and never
blocks. Applying a fix is a separate, plan-and-approve step.

Run inside the `coop-workflow` skill. `sql_review` is the review tool the
workflow calls at step 7 for SQL; this skill covers running it and reading results.

## Review checklist

- **Scope the paths.** Identify the SQL files to check (use `sql_root` from
  `.coop/project.yml`). Read `standards.sql` so findings map to the team's rules.
- **Run the check.** Invoke `coop-sql-review check <paths...> --format json`. Use
  `--min-severity error|warning|info` to filter and `--strict` when a strict pass
  is wanted. The tool is advisory and never modifies files.
- **Triage by severity.** Group findings into error / warning / info and sort so
  the user sees the highest-impact items first.
- **Cite precisely.** For each finding, cite `file:line`, the rule, and a one-line
  explanation of why it matters (correctness, performance, medallion layering,
  naming).
- **Suggest fixes.** Propose a concrete, minimal fix per finding. Do not apply it —
  surface it for the PLAN/approval gate.
- **Note false positives.** Where a finding is contextually fine, say so and why,
  rather than silently dropping it.

## Tools / MCP used

- **`sql_review`** (`coop-sql-review`) — the primary tool;
  `check {paths} --format json [--min-severity ...] [--strict]`. Advisory only.
- **`data_doc`** (`coop-data-doc`) — optional, to confirm layer placement /
  lineage context for a flagged object.
- **Microsoft Learn MCP** — current T-SQL / Fabric Warehouse guidance when a rule's
  rationale needs grounding.

## Output

A findings summary:

- **Overview** — files checked, total findings, counts by severity.
- **Findings by severity** — error → warning → info, each with `file:line`, rule,
  why it matters, and a suggested fix.
- **False positives / context notes** — findings to ignore, with reasoning.
- **Next actions** — the fixes worth doing, as a PLAN for the user to approve.

Log the review per step 10. Never commit SQL source — show the diff after any
approved fix and let the user commit. Commit **docs/logs only**, with approval.
