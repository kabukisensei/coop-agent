---
name: fabric-workspace-review
description: Read-only review of a Microsoft Fabric workspace and architecture — lakehouse/warehouse, medallion bronze/silver/gold layers, capacity, naming, security/access, and deployment pipelines. Advisory only; uses the Fabric CLI (fab) and Fabric MCP read-only, with fabric-cicd in validate-only mode.
---

# Fabric Workspace Review

## Purpose

Inspect a Microsoft Fabric workspace and report on its architecture, hygiene, and
deployment posture. Output is an advisory review — findings and recommendations
only. This skill never creates, updates, deploys, or deletes Fabric artifacts.

Run this inside the `coop-workflow` 11 steps: read `.coop/project.yml` and
`standards.fabric` first, scope the workspace and its blast radius, inspect
read-only, write a PLAN before any change is even proposed, and log the review.

## Review checklist

- **Architecture.** Identify lakehouse vs. warehouse usage and confirm a clean
  medallion split — bronze (raw/ingested), silver (conformed/cleansed), gold
  (business/serving). Flag layer-skipping, cross-layer writes, and gold logic
  living in silver.
- **Naming.** Check workspace, item, and schema names against `standards.fabric`
  (environment suffixes, layer prefixes, casing). Flag inconsistencies and
  ambiguous abbreviations.
- **Capacity.** Note the assigned capacity/SKU and look for obvious pressure
  signals (oversized items, runaway refreshes, throttling notes). Capacity tuning
  is a recommendation, not an action.
- **Security / access.** Review workspace roles, item permissions, and any
  service principals. Flag over-broad access (everyone as Admin/Member), shared
  personal accounts, and gaps between dev/test/prod.
- **Environments + pipelines.** Compare the `dev` / `test` / `prod` workspaces
  from the contract. Inspect deployment pipeline stages and parameter rules for
  drift between stages.
- **Deployment validation.** Where a `fabric-cicd` config exists, run it in
  **validate-only** mode to surface config/parameter problems. Never trigger a
  real deploy without explicit approval (`ask_first` in the contract).
- **Secrets.** Confirm no tokens, connection strings, or keys are exposed in
  inspected items or output.

## Tools / MCP used

- **`fab`** (Microsoft Fabric CLI) — list/inspect workspaces, items, and
  capacity, read-only first. Note the Homebrew `fabric` formula ships a different
  `fab`; `coop doctor` detects that collision.
- **Fabric MCP** (`@microsoft/fabric-mcp`) — `list` / `read` / `inspect` only.
  Never call create/update/delete/deploy.
- **`fabric-cicd`** — validate-only; deployment requires explicit approval.
- **Microsoft Learn MCP** — current Fabric guidance instead of relying on memory.

## Output

A read-only review report:

- **Summary** — workspace, capacity/SKU, environment, overall posture.
- **Architecture + medallion** — layer map and any layering issues.
- **Findings** grouped by area (architecture, naming, capacity, security,
  deployment), each with severity and a concrete, advisory recommendation.
- **fabric-cicd validate** — pass/fail and notable warnings (if a config exists).
- **Next actions** — proposed follow-ups for the user to approve.

Log the review per step 10. Per the contract, commit **docs/logs/diagrams only**,
and only with approval. Never commit Fabric artifact source.
