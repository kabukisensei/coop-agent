# Impact Analysis

Use the `power-bi-impact-analysis` skill, following the `coop-workflow` steps.

Task: Run an impact analysis for a proposed change to: {{object_or_file}}
Proposed change: {{proposed_change}}

Required steps:
1. Read `.coop/project.yml` and the relevant standards (SQL / DAX / documentation).
2. Locate `{{object_or_file}}` and its repository; run `git status` and `git pull`.
3. Use `data_doc` focused lineage for `{{object_or_file}}`. Refresh the graph only when requested/approved, and consume the returned node, edge, evidence, trust, coverage, and diagnostic fields rather than parsing `graph.json` in presentation code.
4. Map the blast radius of `{{proposed_change}}`: affected warehouse/lakehouse objects, semantic model measures and relationships, Power BI reports, and any pipelines or notebooks.
5. Where the change touches SQL or DAX, run `sql_review` / `dax_review` against the affected files to surface advisory risks.
6. Classify each downstream impact (breaking / non-breaking / cosmetic) and note required follow-up changes and a rollback path.
7. Write a short PLAN with the impact summary and recommended sequencing — read-only first; do not edit anything until the user approves.
8. With approval, back up before any edit, make the smallest safe change, re-run the applicable review, and show `git diff`.
9. Update Markdown docs, lineage, and diagrams; append an impact-analysis entry to the daily log.
10. Never commit source. Commit docs/logs/site only with approval.
11. Call `impact_analysis_result` with one complete `impact-analysis.v1` artifact. Cite evidence-source IDs on every path/object, label agent inference, keep gaps explicit, and never claim complete evidence when a source is partial or failed.
