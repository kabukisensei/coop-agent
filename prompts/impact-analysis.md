# Impact Analysis

Use the `power-bi-impact-analysis` skill, following the `coop-workflow` steps.

Task: Run an impact analysis for a proposed change to: {{object_or_file}}
Proposed change: {{proposed_change}}

Required steps:
1. Read `.coop/project.yml` for project context and use COOP's resolved SQL, DAX, and documentation task authority, including any deliberate project override.
2. Locate `{{object_or_file}}` and its repository; run `git status` and `git pull`.
3. Trace the live blast radius first: call the `sql_impact` tool with `{{object_or_file}}` (its dependents, references and columns on the contract's default dev/test target; a section marked `unavailable` means the target could not be asked, not that nothing depends on it). Then run the `data_doc` tool (`coop-data-doc scan`) to refresh lineage and trace upstream and downstream dependencies of `{{object_or_file}}` from `graph.json` (`data_doc` with `command="lineage"`); compare the two and report drift between the live catalog and the docs instead of trusting either alone.
4. Map the blast radius of `{{proposed_change}}`: affected warehouse/lakehouse objects, semantic model measures and relationships, Power BI reports, and any pipelines or notebooks.
5. Where the change touches SQL or DAX, self-check the affected files against the standards articles in context and list every rule they do not meet.
6. Classify each downstream impact (breaking / non-breaking / cosmetic) and note required follow-up changes and a rollback path.
7. Write a short PLAN with the impact summary and recommended sequencing — read-only first; do not edit anything until the user approves.
8. With approval, back up before any edit, make the smallest safe change, self-check the diff against the standards articles in context (fix what does not meet them; deviate only on a user exception or a stated reason), run BPA where relevant, and show `git diff`.
9. Update Markdown docs, lineage, and diagrams; append an impact-analysis entry to the daily log.
10. Never commit source. Commit docs/logs/site only with approval.
