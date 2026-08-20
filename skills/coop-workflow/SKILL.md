---
name: coop-workflow
description: The Cooptimize workflow for any task touching SQL, DAX, Fabric, semantic models, Power BI reports, documentation, or lineage. Principles first (read-only first, plan-and-approve before edits, back up, review, document, never commit source); the step sequence is a default to adapt, not a rigid count.
---

# Cooptimize Workflow

Use this skill for **every** task that reads or changes SQL, DAX, Fabric
warehouse/lakehouse objects, semantic models, Power BI reports, documentation, or
lineage. It keeps work grounded and ensures a human at Cooptimize reviews anything
before it ships. Derived from the pi-analytics-agent mandatory workflow, with
documentation reads handled by the `coop-data-doc` tool.

## Principles (these are what matter)

- **Read-only first**, plan and **get approval before changing anything**. Once the
  user approves a slice, that approval remains valid through its stated backup,
  edits, review, authorized validation, restoration, diff, and passing check.
- **Back up** before edits; make the **smallest safe change**.
- **Review** with the tools; **document and log** the work.
- **Never commit source** — docs/logs/site only, after approval.
- **Explain your choices** (why this approach/pattern/trade-off), but keep it terse
  when the user says the rationale isn't needed for that situation.

The sequence below is the **default way** to honor those principles — adapt it
(skip, reorder, or combine steps) to the task. The exact number of steps is not
sacred; the principles are. This workflow also governs official Microsoft
Fabric/Power BI authoring skills (`powerbi-report-authoring`,
`semantic-model-authoring`, `sqldw-authoring-cli`, `eventhouse-cli`, etc.):
they may edit source files, but they still require plan approval, backups,
review, diff summary, and human commit.

## Before you start

Read the project contract `.coop/project.yml` (coop loads the nearest one). It is
the single source of truth for repo paths, Fabric/Power BI workspaces, standards
locations, backup/log rules, allowed/blocked commit paths, and the approval policy.
If it is missing, ask the user to copy `.coop/project.example.yml` into the repo's
`.coop/project.yml` and fill the TODOs.

## The default sequence

1. **Read context.** Read `.coop/project.yml` and the relevant standards
   (`standards.sql` / `standards.dax` / `standards.fabric` / `standards.documentation`).
2. **Locate + scope.** Identify the repo and object, and the upstream/downstream
   impact. Run `git status` and `git pull` for the relevant repo.
3. **Read the target + lineage.** Read the file(s) and related documentation and
   lineage — call the `data_doc` tool (`coop-data-doc`) instead of guessing at
   relationships. Use the **Microsoft Learn** MCP for current Microsoft docs.
4. **Plan the first slice + get approval.** For multi-step work, write a short PLAN
   for the first vertical slice (what, why, failing check before, passing check after,
   blast radius, rollback). For single-edit tasks, still write a short PLAN.
   **Do not edit anything until the user approves the slice or plan.** That approval
   covers the complete stated slice; do not seek approval again at its internal steps.
5. **Back up.** Create a timestamped backup of every file you will change, under
   `.backups/...` using `backup.timestamp_format` from the contract.
6. **Smallest safe edit.** Make the minimal change that satisfies the request.
7. **Review.** Run the applicable review tool: `sql_review` (`coop-sql-review`) for
   SQL, `dax_review` (`coop-dax-review`) for DAX/models. Where relevant, run Tabular
   Editor BPA and `fabric-cicd` in validate-only mode. Address findings.
8. **Diff + summarize.** Show `git diff` and summarize the change in plain language.
9. **Document.** Update Markdown docs, glossary, and lineage; regenerate the site
   (or re-run `coop-data-doc build`) if documentation changed.
10. **Log.** Append a task entry to the daily log
    (`docs/agent/logs/daily/YYYY-MM-DD.md`): summary, files touched, object(s)
    affected, standards checked, validation run, docs updated, next action.
11. **Commit policy.** Commit **docs / logs / site only**, and **only** if the
    contract allows it and the user approves. **Never commit SQL, DAX, semantic
    model, report, Python, or notebook source** — make the edit, show the diff,
    and let the user commit. Use the `git-helper` skill (or `/pr-description`) to
    draft a Conventional-Commits message and PR description from the diff so the
    human's commit is one paste — drafts only, it never commits.

## Slice by default

For any task with more than one independently testable outcome, run it as a sequence
of **vertical slices**. A slice is one small, end-to-end behavioral outcome that starts
with a failing check and ends with a passing check. A slice may include multiple tightly
related file or object edits needed for that one outcome; do not split it merely because
it has a backup, refactor, review finding, or more than one edit.

Before each slice, state:

- **Goal** — one sentence.
- **Failing check before** — the specific test, SQL/DAX query, measure, linter, or
  review that demonstrates the current problem. Run it before the change to capture a baseline.
- **Smallest safe change** — the exact file(s) and lines.
- **Passing check after** — the same specific test/query/measure/review that will
  prove the slice fixed the problem. State the exact data condition or output that
  changes.
- **Why this slice first** — dependency order, blast radius, rollback safety.
- **Assumptions I’m making** — data shape, repo state, or behavior this slice relies on.
- **What would prove this slice wrong** — the earliest signal that the approach is off.
- **What I’ll watch** — concrete checks I’ll use to spot drift before the final test.
- **Stop-and-ask triggers** — conditions where I will pause instead of continuing.

### Execute an approved slice without checkpoint stops

After the user approves a slice, continue through its stated **backup → minimal edit →
review and in-scope remediation → authorized validation → restoration → passing check
→ final result** in the same run. Backup completion, edit completion, advisory-review
output, test start, and ordinary progress updates are internal steps, not reportable
endpoints. Do not end the turn merely to announce them, and do not ask the user to say
"continue" again.

Pause only when a declared stop-and-ask trigger actually fires: a genuine blocker, a
test mismatch or invalidated assumption, scope expansion, a decision only the user can
make, or a newly encountered destructive, production, or otherwise unapproved action.
An approved Dev/test validation pattern remains approved for that slice. Progress may
be shown when useful, but it is non-blocking and must not replace completing the slice.

Each slice gets its own test. A generic test suite is not enough: the failing and
passing checks must target the exact data, model, or behavior outcome this slice
changes. If you use live data, write the before-query and the after-query, run them,
and compare the results. If the slice is a SQL/DAX change, the failing check is often
a query that returns the wrong value today; the passing check is the same query
returning the expected value after the change.

Only after the passing check completes, briefly **explain what happened, what you
learned, and whether any assumptions were invalidated**. If an assumption was wrong or
a stop-and-ask trigger fired, do not proceed to the next slice without approval. The
`/slice-next` prompt applies after the current slice is complete and expands this
template when you want to plan the next slice explicitly.

### Live-data tests between slices

If `.coop/project.yml` contains `tests.live_data.enabled: true`, live-data tests are
allowed between slices. The configured `command` is a default runner; each slice still defines its own specific test in the **Failing check before / Passing check after** fields above. If the slice-specific test can be expressed as a SQL/DAX query or a
script, run it through the configured command or directly against the configured
workspace. Example:

```yaml
tests:
  live_data:
    enabled: true
    between_slices: true
    command: "pytest tests/integration"   # optional default runner
    workspace: "dev"          # dev or test only
    require_approval: true    # ask before running
```

Live-data tests must target a dev or test workspace. Never run them against production
unless the user explicitly says so. If `require_approval` is true (the default), ask
before running the command unless the user already approved that specific validation
or an explicitly named Dev/test validation pattern as part of the current slice.

## Other working habits

These sharpen the principles above; reach for them on non-trivial or multi-step work.

- **Codify mistakes.** When the model repeats an error or the user corrects the
  same thing twice, write the correction down where future sessions inherit it —
  the relevant skill, `.coop/project.yml` standards, or memory (pi-hermes-memory).
  A fix that lives only in this chat is a fix you'll redo next week.
- **Markdown annotations.** Accept review feedback as annotations keyed to
  sections/files/lines (e.g. `fact_sales.sql:42: use the shared date dimension`)
  and apply **only** what's annotated — read each referenced spot first, make the
  smallest edit, flag anything an annotation would break. The `/annotate` prompt
  sets this up.
- **End with a handoff.** After a long task, emit a handoff: what changed,
  what you reviewed/tested (with results), files modified, open blockers, and the
  next 3–5 todos. It's what lets the next session — or teammate — resume cold. The
  `/handoff` prompt produces it. For a fresh task, `/spec-first` writes the spec up
  front; both stay read-only.

## Guardrails (always)

- **Read-only first.** Default to read/list/inspect. MCP servers (Fabric, Power BI,
  Microsoft Learn) are read-only; never call create/update/delete/deploy/publish
  without explicit approval.
- **No production changes** without a clear, specific instruction.
- **Never expose secrets** — no tokens, keys, connection strings, or `.env`
  contents in output or memory.
- **Use memory** (pi-hermes-memory) for durable facts, preferences, and
  corrections — never for secrets.

When uncertain, **stop and ask.** Raising a tension for the group to resolve by
consent beats acting without it.
