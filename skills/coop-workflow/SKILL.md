---
name: coop-workflow
description: The mandatory 11-step Cooptimize workflow for any task touching SQL, DAX, Fabric, semantic models, Power BI reports, documentation, or lineage. Read-only first, plan-and-approve before edits, never commit source.
---

# Cooptimize Workflow (the 11 steps)

Use this skill for **every** task that reads or changes SQL, DAX, Fabric
warehouse/lakehouse objects, semantic models, Power BI reports, documentation, or
lineage. It keeps work grounded and ensures a human at Cooptimize reviews anything
before it ships. Derived from the pi-analytics-agent mandatory workflow, tightened
to 11 steps, with documentation reads handled by the `coop-data-doc` tool.

## Before you start

Read the project contract `.coop/project.yml` (coop loads the nearest one). It is
the single source of truth for repo paths, Fabric/Power BI workspaces, standards
locations, backup/log rules, allowed/blocked commit paths, and the approval policy.
If it is missing, ask the user to copy `.coop/project.example.yml` into the repo's
`.coop/project.yml` and fill the TODOs.

## The 11 steps

1. **Read context.** Read `.coop/project.yml` and the relevant standards
   (`standards.sql` / `standards.dax` / `standards.fabric` / `standards.documentation`).
2. **Locate + scope.** Identify the repo and object, and the upstream/downstream
   impact. Run `git status` and `git pull` for the relevant repo.
3. **Read the target + lineage.** Read the file(s) and related documentation and
   lineage — call the `data_doc` tool (`coop-data-doc`) instead of guessing at
   relationships. Use the **Microsoft Learn** MCP for current Microsoft docs.
4. **Plan + get approval.** Write a short PLAN (what, why, blast radius, rollback).
   **Do not edit anything until the user approves the plan.**
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
    and let the user commit.

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
