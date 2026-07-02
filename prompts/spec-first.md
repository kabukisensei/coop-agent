# /spec-first

Use the `coop-workflow` skill.

Before writing or changing anything for this task, produce a short **written
spec** and get my approval on it. Cover:

- **Goal** — the outcome in one or two sentences.
- **Constraints** — standards from `.coop/project.yml`, guardrails, and any
  non-negotiables (backups, never-commit-source, production-safety).
- **Data model / objects** — the SQL objects, DAX measures, semantic-model
  tables, or reports in scope, and their lineage (look up upstream/downstream
  with the `data_doc` tool, `command="lineage"`, before broad reads).
- **Interfaces** — the queries, endpoints, refresh paths, or report pages
  touched.
- **Edge cases** — nulls, late/duplicate data, incremental-refresh windows,
  permission boundaries.
- **Test / validation plan** — which reviews (`sql_review` / `dax_review` / BPA /
  `fabric-cicd` validate) and checks will prove it works.

Keep the spec focused — read the object plus its immediate lineage neighbors, not
the whole estate. Present the spec as a PLAN and wait for approval before editing.
