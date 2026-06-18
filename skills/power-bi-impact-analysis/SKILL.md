---
name: power-bi-impact-analysis
description: Assess the downstream and upstream impact of a proposed change to a Power BI semantic model, measure, column, table, or report. Maps dependencies and lineage via data_doc and the read-only Power BI MCP, then lists affected reports, apps, and consumers. Advisory only; never edits a model or report.
---

# Power BI Impact Analysis

## Purpose

Before a semantic model or report change, determine its blast radius: what feeds
the target (upstream) and what depends on it (downstream). The deliverable is an
impact report so a human can scope and approve the change. This skill reads and
analyzes only — it never edits a model, measure, or report.

Run inside the `coop-workflow` skill. This skill primarily supports step 2
(scope + upstream/downstream impact) and step 3 (read target + lineage); it must
not stand in for the PLAN/approval gate at step 4.

## Analysis checklist

- **Identify the target.** Pin down the exact object — table, column, measure,
  calculation group, relationship, or report visual — and the change intent
  (rename, retype, remove, redefine, refactor).
- **Upstream.** Trace what the target depends on: source tables/queries, Fabric
  warehouse/lakehouse objects, referenced measures and columns. Use `data_doc`
  lineage rather than guessing.
- **Downstream.** Find dependent measures, calculated columns, relationships,
  reports, and apps that consume the target. A removed/renamed measure breaks
  every visual and dependent measure that references it.
- **Cross-artifact reach.** Note dependent dataflows, paginated reports, Excel
  Analyze-in connections, and other workspaces sharing the model.
- **Refresh / RLS.** Flag impact on refresh logic, incremental refresh policies,
  and row-level security roles tied to the changed object.
- **Risk rating.** Rate blast radius (low / medium / high) by count and
  criticality of affected consumers; call out anything user-facing.

## Tools / MCP used

- **`data_doc`** (`coop-data-doc`) — `scan` to refresh `graph.json`, then read
  lineage to walk upstream/downstream edges for the target object.
- **Power BI MCP** (`powerbi-mcp-server --readonly`) — `list` / `read` /
  `inspect` the semantic model, measures, relationships, and report usage.
  Read-only; never create/update/publish.
- **Fabric MCP** — read-only, to reach upstream warehouse/lakehouse objects.
- **Microsoft Learn MCP** — current Power BI / semantic-model guidance.

## Output

An impact report:

- **Target** — object, change intent.
- **Upstream dependencies** — sources and references the change relies on.
- **Downstream impact** — affected measures, relationships, reports, apps, and
  consumers, with a lineage path for each.
- **Risk rating** — low / medium / high, with the reasoning.
- **Recommendation** — safer alternatives (e.g., deprecate-then-remove) and the
  PLAN the user should approve before any edit.

Log the analysis per step 10. Commit **docs/logs/diagrams only**, with approval.
Never commit semantic model or report source.
