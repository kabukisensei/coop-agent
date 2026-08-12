---
name: power-bi-report-authoring
description: Author, edit, and validate Power BI reports in PBIR/PBIP format using Microsoft's powerbi-report-author and powerbi-desktop CLIs plus direct JSON editing. Use whenever the user mentions PBIR/PBIP files, Power BI Desktop, report pages/visuals, themes, or wants to refresh or screenshot a report. Operates under the coop-workflow skill.
---

# Power BI report authoring (PBIR/PBIP)

This skill guides terminal-driven editing of Power BI reports using Microsoft's
MIT-licensed authoring CLIs. It assumes the Cooptimize workflow: read-only
first, plan-and-approve before edits, back up, review, show the diff, and never
commit source.

## Authoring model

There is no mutation CLI. You edit PBIR JSON files directly; the CLIs provide
metadata, validation, and Desktop verification:

- **`powerbi-report-author`** — visual catalogs, formatting metadata, report
  inventory, and validation. The source of truth for PBIR facts.
- **`powerbi-desktop`** — live Power BI Desktop bridge: open, reload, and
  screenshot reports. Windows + Power BI Desktop only.

## Coop conventions

This skill operates inside the `coop-workflow` skill:

- **Read-only first.** Explore with `preview-*` commands and file reads before
  changing anything.
- **Plan-and-approve.** For non-trivial edits, write a short PLAN and get user
  approval before mutating.
- **Back up.** Preserve the report folder or work on a branch before edits.
- **Smallest safe edit.** One coherent change at a time, then validate.
- **Never commit source.** Show the diff; let the human commit PBIR/PBIP source.
- **Log.** Append a task entry to the daily log.

## Prerequisites

Node.js 20 or later. Both CLIs are installed by `coop install`:

```bash
npm install -g @microsoft/powerbi-report-authoring-cli@latest
# Windows + Power BI Desktop only:
npm install -g @microsoft/powerbi-desktop-bridge-cli@latest
```

Verify:

```bash
powerbi-report-author --version
powerbi-desktop --version   # Windows only
```

On Windows, enable **File > Options > Preview features > external tool access
through secure local APIs** in Power BI Desktop and restart it for the bridge.

## PBIR file layout

```text
<Report>.pbip
├── <Report>.Report/
│   ├── .platform
│   ├── definition.pbir                  # report → semantic model binding
│   ├── definition/
│   │   ├── version.json
│   │   ├── report.json                  # themes, settings, resources
│   │   └── pages/
│   │       ├── pages.json               # pageOrder + activePageName
│   │       └── <pageId>/
│   │           ├── page.json
│   │           └── visuals/<visualId>/visual.json
│   └── StaticResources/RegisteredResources/   # custom theme JSON, images
└── <Report>.SemanticModel/              # out of scope here
```

## Editing rules (non-negotiable)

1. **Structured edits only.** Read the file → `JSON.parse` → modify the object →
   `JSON.stringify` → write back, or use exact old/new string edits. Never use
   regex or string replacement on PBIR JSON. In PowerShell never use
   `ConvertTo-Json` without `-Depth 20`; prefer Node.js for JSON manipulation.
2. **Preserve `$schema`.** Never invent or bump schema versions. For new files,
   copy the `$schema` URL from an existing file of the same type in the same
   report.
3. **Unique IDs.** Generate fresh IDs for new pages, visuals, and filters.
4. **Register pages.** Every new page goes into `pages.json` `pageOrder`.
5. **Lookup before writing.** Confirm visual roles, formatting objects,
   property names, enum values, and selectors with the CLI — never from memory.

## Metadata and inventory CLI

```bash
# Inventory (audit existing content)
powerbi-report-author preview-pages "Report.Report"
powerbi-report-author preview-visuals "Report.Report" --with-derived
powerbi-report-author preview-filters "Report.Report"
powerbi-report-author preview-themes "Report.Report"

# Visual capabilities
powerbi-report-author catalog list
powerbi-report-author catalog describe cardVisual

# Formatting metadata
powerbi-report-author formatting list-objects cardVisual
powerbi-report-author formatting describe-object cardVisual title
powerbi-report-author formatting describe-property cardVisual title fontSize
powerbi-report-author formatting search cardVisual "border|shadow"
powerbi-report-author formatting list-vcos
```

Use `formatting search <type> <regex>` when you do not know which object a
property belongs to. Some formatting objects need `{ id: ... }` selectors;
follow the `_selectorHint` from `describe-object`.

Two more helpers:

- **`expr`** — PBIR literal expression codec. PBIR property values are encoded
  literals (`"true"`/`"false"` for booleans, `123D` for decimals, `456L` for
  integers). Use `powerbi-report-author expr encode <value>` before writing a
  value into `visual.json`/`page.json`, and `expr decode <json>` to read one.
- **`powerbi-report-author doctor`** — environment self-check (Node version,
  metadata provider, schema reachability). Run it when the CLI behaves oddly.

## Validation

Run after every logical batch of edits:

```bash
powerbi-report-author validate "Report.Report"
powerbi-report-author validate "Report.Report" --pretty        # readable output
powerbi-report-author validate "Report.Report" --out diag.json # capture to file
```

- Non-zero exit / `failed`: fix every error before any Desktop reload.
- `succeededWithWarnings`: review warnings; unknown visual types or theme keys
  usually mean a typo unless the report intentionally uses a custom `.pbiviz`.
- Diagnostics include file and JSON paths — jump straight to the broken node.

## Desktop verification loop (Windows)

```text
1. Edit PBIR files
2. powerbi-report-author validate   → errors? fix, back to 1
3. powerbi-desktop status           → choose the correct PID
4. powerbi-desktop reload --pid N   → error? fix, back to 1
5. powerbi-desktop screenshot-all --pid N --output-dir shots
6. Review screenshots               → issues? fix, back to 1
```

Rules:

- If `status` shows `hasUnsavedChanges: true`, stop and ask the user to save or
  discard in Desktop first.
- Run reload and screenshots **serially per PID** — never in parallel.
- **Theme files are cache-keyed by name.** After editing a theme JSON, rename
  it with a random suffix (and update `report.json`), or close and reopen
  Desktop, or the change will not appear.
- `reload` covers report/PBIR changes only. Semantic-model (TMDL) changes need
  the semantic-model tooling and a PBIP reopen.
- No `powerbi-desktop` command takes `--report`; select the instance by PID.

## Visual type guardrails

Never create legacy visual types:

| Do not create | Use instead |
|---|---|
| `card`, `multiRowCard` | `cardVisual` (multi-value cards take multiple `Data` projections) |
| `table` | `tableEx` |
| `matrix` | `pivotTable` |
| `map`, `filledMap` | `azureMap` |

Role names vary by visual type (`cardVisual` binds to `Data`, not `Fields`).
Always confirm with `catalog describe <type>`.

## Deep mechanics

When the subordinate Microsoft `powerbi-report-authoring` skill is loaded
(allow-listed under `fabric_skills` and fetched into `skills/_microsoft_fabric/`),
defer to its `references/` for complete JSON templates and per-visual guidance:
`authoring.md`, `formatting.md`, `theming.md`, `re-theming.md`, `slicers.md`,
`filters.md`, `card.md`, `cartesian.md`, `table.md`, `powerbi-desktop.md`,
`screenshot-review.md`, and the rest. If it is missing, run
`scripts/fetch-microsoft-skills.sh`.

## Workflow

1. **Scope.** Confirm the report path and the requested change.
2. **Explore.** `preview-pages`, `preview-visuals`, read the target JSON files.
3. **Model.** Get table/column/measure names from TMDL files, the semantic
   model tooling, or the Modeling MCP — exact names only.
4. **Plan.** Short PLAN, get approval.
5. **Back up.** Copy the report folder or use a branch.
6. **Edit.** Structured JSON edits, smallest coherent batch.
7. **Validate.** `powerbi-report-author validate` — fix all errors.
8. **Verify.** Desktop reload + screenshots (Windows), or sandbox publish with
   approval elsewhere.
9. **Diff and log.** Show the diff, summarize, append to the daily log.

## Related skills and tools

- **`power-bi-report-review`** — read-only audit of a report.
- **`report-themes`** — theme authoring on top of these mechanics.
- **`custom-visuals`** — Deneb and SVG visuals on top of these mechanics.
- **`dax-review`** / **`coop-dax-review`** — DAX and model standards.
- **`coop-workflow`** — plan-and-approve, backups, diff, never commit source.

## Fetching current docs

Use the Microsoft Learn MCP for current PBIR schema and Desktop feature docs.
