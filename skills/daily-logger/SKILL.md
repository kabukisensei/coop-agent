---
name: daily-logger
description: Append a structured entry to the daily work log after completing (or preparing) any task that touches SQL, DAX, Fabric, semantic models, reports, documentation, or lineage. Records what was done, what's awaiting human review, standards findings, open questions, and next actions. The log is a documentation artifact — commit it (with approval), never source.
---

# Daily Logger

## Purpose

Keep a durable, human-readable record of the day's analytics-engineering work so the
team has an audit trail of what changed, what's pending review, and what's next. This
is **step 10 of the `coop-workflow`** ("Log") made concrete. Logging is read-safe;
committing the log happens only with approval per the contract.

## When to log

Append an entry whenever you:

- prepared or proposed a source change for human review (SQL / DAX / model / report),
- ran a review (`sql_review` / `dax_review`) or built/refreshed docs (`data_doc`),
- updated documentation, glossary, lineage, or the portal,
- hit an open question or a decision the user should weigh in on.

Multiple tasks in one day go in the **same** day's file — append, don't overwrite.

## Where it goes

Use the path from the project contract (`.coop/project.yml` →
`logging.daily_log_path`), which defaults to:

```
docs/agent/logs/daily/YYYY-MM-DD.md
```

(Weekly roll-ups go to `logging.weekly_log_path`, default
`docs/agent/logs/weekly/YYYY-Www.md` — see the `/weekly-log` prompt.) Create the
folder/file if missing; otherwise append a new dated task block.

## Entry structure

Start a new file from this template (fill what applies; leave a table empty rather
than inventing rows):

```markdown
# Daily Log — YYYY-MM-DD

## Summary
One or two lines on the day's focus.

## Tasks completed
| Time | Repo | Object / file | Summary | Docs updated |
|------|------|---------------|---------|--------------|

## Source changes prepared for review (NOT committed)
| File | Summary | Action needed from a human |
|------|---------|----------------------------|

## Documentation / logs / site committed (with approval)
| Commit | Summary |
|--------|---------|

## Standards / quality findings
- From `sql_review` / `dax_review` (cite file:line and severity), Tabular Editor BPA,
  or `fabric-cicd` validate.

## Open questions
- Tensions to surface for a consent round.

## Next suggested actions
- 
```

## Commit policy

The daily log is a **documentation artifact** and is in the contract's
`agent_allowed_to_commit` paths (`docs/agent/logs/**`). Commit it **only with
approval** and with a `docs:`-style message. **Never** commit SQL, DAX, semantic
model, report, Python, or notebook source — show the diff and let a human commit
those. Never write secrets (tokens, connection strings, keys) into the log.

## Tools / related

- **`/daily-log`** prompt — scaffolds or appends today's entry on demand.
- **`/weekly-log`** prompt — rolls up the week's daily logs.
- Runs inside the **`coop-workflow`** skill (step 10) and under `docs/guardrails.md`.
