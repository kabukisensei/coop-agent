---
name: d365-migration-review
description: Review a D365 Finance & Operations to Microsoft Fabric migration mapping — entity-to-layer placement (bronze/silver/gold), key strategy, slowly-changing-dimension (SCD2) handling, data type fidelity, and reconciliation. Advisory only; reads mapping specs and lineage and never edits migration code.
---

# D365 → Fabric Migration Review

## Purpose

Review how D365 Finance & Operations data is being mapped into a Fabric medallion
architecture, and check that the design is sound before it is built or trusted.
The deliverable is an advisory review of the mapping — this skill reads specs,
SQL, and lineage and reports findings; it never edits migration code or objects.

Run inside the `coop-workflow` skill: read `.coop/project.yml`, `standards.sql`,
and `standards.fabric` first; scope the entities under review; inspect read-only;
write findings and a PLAN; log the review.

## Review checklist

- **Entity → layer mapping.** Confirm each F&O entity/table lands correctly:
  bronze = raw ingested as-is, silver = conformed/cleansed/deduplicated, gold =
  business/serving. Flag transformations done in the wrong layer.
- **Keys.** Verify source keys (often `RecId` / `RecVersion`, composite, or
  company-scoped `DataAreaId`) are preserved, and that surrogate keys in
  silver/gold are stable, deterministic, and documented.
- **SCD2.** Where dimensions track history, check SCD2 mechanics: effective-from /
  effective-to, current-row flag, change detection, and handling of late-arriving
  and reactivated records. Flag silent overwrites where history is required.
- **Data types.** Check fidelity across the boundary — enums/base-enums, dates and
  datetimes (and time zones / UTC), decimals and currency precision/scale, and
  string lengths. Flag lossy casts and ambiguous enum-to-label mappings.
- **Company / partition scope.** Confirm `DataAreaId` (legal entity) and
  partitioning are handled so cross-company data is not blended incorrectly.
- **Reconciliation.** Confirm a reconciliation plan exists — row counts, control
  totals, and key checks from F&O source through bronze/silver/gold. Flag missing
  reconciliation for financial/transactional entities.
- **SQL quality.** Run `sql_review` on the silver/gold T-SQL and fold findings in.

## Tools / MCP used

- **`sql_review`** (`coop-sql-review`) — advisory T-SQL standards check on
  migration SQL (`check {paths} --format json`).
- **`data_doc`** (`coop-data-doc`) — `scan` then read lineage to trace entities
  through bronze/silver/gold and spot orphaned or undocumented mappings.
- **Fabric MCP** — read-only inspection of resulting lakehouse/warehouse objects.
- **Microsoft Learn MCP** — current D365 F&O and Fabric data-mapping guidance.

## Output

A read-only review report:

- **Scope** — entities/tables reviewed and target layers.
- **Mapping table** — F&O entity → layer → key strategy → SCD type, per entity.
- **Findings** grouped by area (layering, keys, SCD2, data types, scope,
  reconciliation, SQL), each with severity and an advisory recommendation.
- **Reconciliation gaps** — entities lacking a verifiable check.
- **Next actions** — proposed follow-ups for the user to approve.

Log the review per step 10. Commit **docs/logs/diagrams only**, with approval.
Never commit SQL, notebook, or migration source.
