# Fabric Architecture Review

Use the `fabric-workspace-review` skill, following the `coop-workflow` steps.

Task: Review the architecture of this Fabric workspace: {{workspace}}
Concern: {{concern}}

Required steps:
1. Read `.coop/project.yml` and the Fabric and documentation standards.
2. Resolve `{{workspace}}` to a workspace name/id from the contract's `fabric` section; confirm which environment (dev/test/prod) it is.
3. Use the Fabric MCP (read-only: list / read / inspect) to enumerate workspace items — lakehouses, warehouses, pipelines, notebooks, semantic models, reports. Never call create/update/delete/deploy.
4. Run the `data_doc` tool (`coop-data-doc scan`) and read existing docs/lineage to map how items connect across the medallion layers.
5. Use the Microsoft Learn MCP for current Fabric guidance where the design touches Microsoft recommendations.
6. Assess the architecture against `{{concern}}`: layer separation (bronze/silver/gold), capacity and refresh patterns, naming and workspace hygiene, lineage integrity, security/least-privilege.
7. Write a short PLAN of findings and recommended actions — read-only first; do not edit anything until the user approves.
8. With approval, update Markdown docs and diagrams and append a review entry to the daily log.
9. Do not commit any source and never run deployments. Commit docs/logs/site only with approval.
