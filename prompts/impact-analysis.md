# Impact Analysis

Use the `power-bi-impact-analysis` skill, following the `coop-workflow` steps.

Task: Run an impact analysis for a proposed change to: {{object_or_file}}
Proposed change: {{proposed_change}}

Required steps:
1. Read `.coop/project.yml` and the relevant standards (SQL / DAX / documentation).
2. Locate `{{object_or_file}}` and its repository; run `git status` and `git pull`.
3. Run the `data_doc` tool (`coop-data-doc scan`) to refresh lineage, then trace upstream and downstream dependencies of `{{object_or_file}}` from `graph.json`.
4. Map the blast radius of `{{proposed_change}}`: affected warehouse/lakehouse objects, semantic model measures and relationships, Power BI reports, and any pipelines or notebooks.
5. Where the change touches SQL or DAX, run `sql_review` / `dax_review` against the affected files to surface advisory risks.
6. Classify each downstream impact (breaking / non-breaking / cosmetic) and note required follow-up changes and a rollback path.
7. Write a short PLAN with the impact summary and recommended sequencing — read-only first; do not edit anything until the user approves.
8. With approval, back up before any edit, make the smallest safe change, re-run the applicable review, and show `git diff`.
9. Update Markdown docs, lineage, and diagrams; append an impact-analysis entry to the daily log.
10. Never commit source. Commit docs/logs/site only with approval.
