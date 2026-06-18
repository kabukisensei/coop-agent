# D365 Migration Review

Use the `d365-migration-review` skill, following the `coop-workflow` steps.

Task: Review this D365 (Finance & Operations) to Fabric migration slice: {{entity_or_area}}
Target layer: {{target_layer}}

Required steps:
1. Read `.coop/project.yml` and the SQL, Fabric, and documentation standards.
2. Locate the migration artifacts for `{{entity_or_area}}` in the `fabric_dw` repo (and `fabric` repo if a model/report is in scope); run `git status` and `git pull`.
3. Read the source D365 entity mapping, the destination `{{target_layer}}` (bronze/silver/gold) objects, and related docs/lineage — call the `data_doc` tool (`coop-data-doc`) for lineage.
4. Use the Microsoft Learn MCP for current D365 F&O and Fabric entity/export guidance where relevant.
5. Run the `sql_review` tool (`coop-sql-review check <paths> --format json`) over the SQL that lands and transforms the entity into `{{target_layer}}`; address advisory findings.
6. Check the slice for migration correctness: column mapping and types, keys and surrogate handling, incremental vs full load, deduplication, naming and layer placement against standards.
7. Write a short PLAN of findings and recommended changes — read-only first; do not edit anything until the user approves.
8. With approval, back up before any edit, make the smallest safe change, re-run `sql_review`, and show `git diff`.
9. Update Markdown docs, glossary, and lineage; append a migration-review entry to the daily log.
10. Never commit SQL / Python / notebook / model source. Commit docs/logs/site only with approval.
