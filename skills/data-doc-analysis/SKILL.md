---
name: data-doc-analysis
description: Run and interpret coop-data-doc — scan to produce graph.json, build to produce manifest.json plus Markdown docs and the portal — then summarize lineage and find documentation gaps and staleness. Advisory analysis; regenerates docs/site only with approval.
---

# Data Documentation Analysis

## Purpose

Use `coop-data-doc` to understand a repo's data lineage and documentation health,
then report on coverage, gaps, and staleness. The deliverable is an analysis of the
generated artifacts. Generating documentation is read-safe; committing or
publishing the site happens only with approval per the contract.

Run inside the `coop-workflow` skill. `data_doc` is the lineage tool the
workflow calls at step 3 (read target + lineage) and step 9 (document).

## Analysis checklist

- **Scan.** Run `coop-data-doc scan` to (re)generate `graph.json` — the machine
  lineage graph of objects and their edges.
- **Build.** Run `coop-data-doc build` to produce `manifest.json`, the Markdown
  docs, and the portal. Use `manifest.json` as the structured source for analysis.
- **Read the generated Markdown — focused.** The per-object Markdown docs are the
  canonical, human- and agent-readable documentation for the estate. To protect the
  context window, **do not read the whole doc set**: locate the object's node in
  `manifest.json` / `graph.json` (it carries `upstream`, `downstream`, and each
  object's `slug`), then read **only** that object's `<slug>.md` plus its immediate
  upstream and downstream neighbors. Prefer **context-mode** (intent-driven search +
  sandboxed execution) to pull just the relevant slice. Widen the radius only when
  the change's blast radius requires it.
- **Lineage.** Summarize key flows: sources → bronze → silver → gold → semantic
  model → report. Highlight critical paths and any cross-repo edges.
- **Coverage gaps.** Identify objects with no description, no owner, or no glossary
  term; measures/columns lacking definitions; and dangling references.
- **Orphans + dead ends.** Flag objects with no upstream (unexplained sources) or
  no downstream (unused outputs that may be dead).
- **Staleness.** Compare doc timestamps against source changes (`git status` /
  recent commits) to find docs lagging behind the code they describe.
- **Consistency.** Check naming and layer placement against the standards
  referenced in `.coop/project.yml`.

## Tools / MCP used

- **`data_doc`** (`coop-data-doc`) — `scan` → `graph.json`; `build` →
  `manifest.json` + Markdown + portal. Also `check`, `init`, `setup`, `update`,
  `upgrade` as needed. This is the primary tool for this skill.
- **`git`** — `status` / `log` to detect source-vs-doc staleness (read-only).
- **Microsoft Learn MCP** — current guidance when interpreting Fabric/Power BI
  lineage.

## Output

A documentation-health report:

- **Lineage summary** — the main source-to-report flows, with critical paths.
- **Coverage** — documented vs. undocumented objects, and a gap list.
- **Orphans / dead ends** — objects missing upstream or downstream.
- **Staleness** — docs lagging behind their source.
- **Artifacts** — paths to the refreshed `graph.json` and `manifest.json`.
- **Next actions** — proposed doc/glossary/lineage updates for approval.

Log the analysis per step 10. The generated docs/site are commit-eligible
(**docs/logs/diagrams/site only**) and only with approval. Never commit source.
