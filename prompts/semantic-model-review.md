# Semantic Model Review

Use the `coop-workflow` skill.

Task: Review this Power BI semantic model: {{model_name}}
Focus: {{focus}}

Required steps:
1. Read `.coop/project.yml` and the DAX and documentation standards.
2. Locate the model's TMDL/source for `{{model_name}}` in the `fabric` repo; run `git status` and `git pull`.
3. Read the model definition and related docs/lineage — call the `data_doc` tool (`coop-data-doc`) for relationships instead of guessing.
4. Run the `dax_review` tool (`coop-dax-review check <paths> --format json`) over the measures and address advisory findings.
5. If Tabular Editor CLI is enabled in the contract, run Tabular Editor BPA against the model; otherwise note it is unavailable.
6. Check measures, relationships, and naming against the DAX standards, weighting `{{focus}}`: relationship cardinality and cross-filter direction, measure correctness and formatting, hidden technical columns, consistent naming.
7. Write a short PLAN of recommended changes — read-only first; do not edit anything until the user approves.
8. With approval, back up before any edit, make the smallest safe change, re-run `dax_review`, and show `git diff`.
9. Update Markdown docs, glossary, and lineage; append a review entry to the daily log.
10. Never commit semantic model / report / DAX source. Commit docs/logs/site only with approval.
