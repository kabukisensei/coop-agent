# Discovery

Use the `coop-workflow` skill.

Task: Kick off discovery of this repo or estate: {{repo_or_area}}
Goal: {{goal}}

Required steps:
1. Read `.coop/project.yml` and the relevant standards.
2. Identify which repository (`fabric` / `fabric_dw`) or Fabric/Power BI area `{{repo_or_area}}` maps to; run `git status` and `git pull` for it.
3. Run the `data_doc` tool (`coop-data-doc scan`) to build `graph.json`, then `coop-data-doc build` if no manifest exists.
4. Read the generated lineage and existing docs under `docs/agent` to map the architecture (medallion bronze/silver/gold layers, warehouse/lakehouse, semantic models, reports).
5. Summarize the architecture and end-to-end lineage in plain language: sources, transformations, downstream consumers.
6. List risks and gaps you found (undocumented objects, broken or missing lineage, naming/standards drift, single points of failure, stale docs).
7. Write a short PLAN proposing the next discovery or remediation steps — read-only first; do not edit anything until the user approves the plan.
8. With approval, update Markdown docs and append a discovery entry to the daily log.
9. Do not commit any source. Commit docs/logs/site only if the contract allows and the user approves.
