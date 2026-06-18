---
name: dax-review
description: Run and interpret coop-dax-review on DAX and semantic models — check {paths} --format json — then summarize findings by severity, cite file:line, and suggest fixes, adding Tabular Editor BPA where relevant. Advisory only; never edits or blocks.
---

# DAX Review

## Purpose

Run the advisory DAX standards check (`coop-dax-review`) over DAX / semantic model
files and turn the JSON output into a clear, prioritized summary. Where useful,
fold in Tabular Editor Best Practice Analyzer (BPA) results. This skill is
advisory: it reports and suggests but never edits a model or measure and never
blocks. Applying a fix is a separate, plan-and-approve step.

Run inside the `coop-workflow` skill. `dax_review` is the review tool the
workflow calls at step 7 for DAX/models; this skill covers running it and reading
results.

## Review checklist

- **Scope the paths.** Identify the DAX / TMDL / model files to check. Read
  `standards.dax` so findings map to the team's rules.
- **Run the check.** Invoke `coop-dax-review check <paths...> --format json`. Use
  `--min-severity error|warning|info` to filter and `--strict` when wanted. The
  tool is advisory and never modifies files.
- **Triage by severity.** Group findings into error / warning / info, highest
  impact first.
- **Cite precisely.** For each finding, cite `file:line`, the rule, and why it
  matters (correctness, context transition, performance, naming, formatting).
- **Tabular Editor BPA.** Where the model is available and Tabular Editor CLI is
  configured (`tools.tabular_editor_cli`, path-based, optional), run BPA and merge
  its findings — note that it is optional and only when enabled in the contract.
- **Suggest fixes.** Propose a concrete, minimal fix per finding. Do not apply it —
  surface it for the PLAN/approval gate.
- **Note false positives.** Where a finding is contextually fine, say so and why.

## Tools / MCP used

- **`dax_review`** (`coop-dax-review`) — the primary tool;
  `check {paths} --format json [--min-severity ...] [--strict]`. Advisory only.
- **Tabular Editor CLI BPA** — optional, path-configured; run only when enabled.
- **Power BI MCP** (`--readonly`) — optional, read-only inspection of the model for
  context behind a finding.
- **Microsoft Learn MCP** — current DAX / semantic-model guidance.

## Output

A findings summary:

- **Overview** — files checked, total findings, counts by severity, and whether
  BPA was run.
- **Findings by severity** — error → warning → info, each with `file:line`, rule,
  why it matters, and a suggested fix.
- **BPA findings** — merged in, where Tabular Editor ran.
- **False positives / context notes** — findings to ignore, with reasoning.
- **Next actions** — the fixes worth doing, as a PLAN for the user to approve.

Log the review per step 10. Never commit DAX / semantic model / report source —
show the diff after any approved fix and let the user commit. Commit
**docs/logs only**, with approval.
