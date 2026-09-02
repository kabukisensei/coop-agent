---
name: daily-logger
description: Append a structured entry after meaningful completed project work, including implementation, configuration, validation, SQL, DAX, Fabric, semantic models, reports, documentation, or lineage. Required before the final response when the nearest project contract sets logging.require_task_log true. Skip ordinary read-only Q&A/status checks or an explicit per-task user opt-out. Records work, review state, findings, open questions, and next actions. The log is a documentation artifact — commit it only with approval, never source.
---

# Daily Logger

## Purpose

Keep a durable, human-readable record of the day's analytics-engineering work so the
team has an audit trail of what changed, what's pending review, and what's next. This
is **step 10 of the `coop-workflow`** ("Log") made concrete. A required-task-log
contract authorizes the append; committing the log happens only with approval.

When the nearest `.coop/project.yml` sets `logging.require_task_log: true`, treat
this skill as a non-skippable completion postcondition for meaningful work. Use it
before the final response. That contract flag is standing authorization to append
the log; it is not authorization to commit or push it. Respect an explicit user
request not to log a particular task.

## When to log

Append an entry whenever you:

- completed an implementation or configuration change,
- prepared or proposed a source change for human review (SQL / DAX / model / report),
- ran meaningful validation or a review (`sql_review` / `dax_review`) or
  built/refreshed docs (`data_doc`),
- updated documentation, glossary, lineage, or the portal,
- hit an open question or a decision the user should weigh in on.

Multiple tasks in one day go in the **same** day's file — append, don't overwrite.
Do not create an entry for ordinary read-only Q&A or a simple status check.

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
