---
name: power-bi-report-review
description: Audit a Power BI report for quality, usage, performance, governance, accessibility, and design. Use when the user asks to review, audit, or health-check a report, or assess whether a report is being used effectively. Read-only advisory under the coop-workflow skill.
---

# Power BI report review

Structured, read-only evaluation of a Power BI report. The output is a
prioritized list of findings with concrete recommendations and, where possible,
file or workspace locations.

This skill is **advisory**: it reports, suggests, and never edits a report or
model. Run under the `coop-workflow` skill.

## Coop conventions

- **Read-only only.** Use `powerbi-report-author`, direct PBIR file reads,
  `coop-data-doc`, and read-only MCP queries. Never call
  create/update/delete/deploy/publish without explicit approval.
- **Evidence first.** Ground findings in `powerbi-report-author validate`,
  `preview-*` inventory commands, Usage Metrics, or Performance Analyzer
  exports rather than impressions.
- **Scope before depth.** Confirm the report, lifecycle stage, and dimensions
  with the user before starting.
- **Prioritized output.** Lead with critical/high findings and cite file or
  workspace locations.
- **Log.** Append a summary to the daily log.

## When to use

- Reviewing report quality before release or handoff.
- Auditing whether an existing report is worth maintaining.
- Investigating performance, adoption, or design issues.
- Comparing a report against Cooptimize standards.

## Scope first

Before reviewing, clarify with the user:

- Single report or workspace-wide audit?
- Lifecycle stage: development, testing, or production?
- Which dimensions matter most? (usage, design, performance, governance, accessibility)
- Do they have access to the underlying semantic model?
- Where should findings be recorded? (daily log, markdown doc, issue tracker)

The applicable dimensions depend on lifecycle stage:

| Stage | Usage data? | Review focus |
|---|---|---|
| Development | No | Design, binding, performance, accessibility, structure |
| Testing | Partial | Above + verify testers are actually using it |
| Production | Yes | All dimensions, especially usage, distribution, and governance |

## How to gather evidence

Use read-only tools only:

- **Local PBIR/PBIP files:** read the `.Report` tree directly and run
  `powerbi-report-author preview-pages`, `preview-visuals`, `preview-filters`,
  `preview-themes`, and `validate` (see `power-bi-report-authoring`).
- **Lineage and impact:** `coop-data-doc` / `data_doc` tool.
- **Workspace metadata:** `fab` CLI or Fabric/Power BI MCP (list, read, inspect).
- **Model-side issues:** `coop-dax-review` / `dax_review` tool.
- **Usage Metrics:** Power BI service Usage Metrics report or Activity Events
  (tenant admin). Do not rely on arbitrary "healthy" thresholds — interpret in
  context of audience size and report cadence.

If the semantic model is in scope, run `dax-review` or `power-bi-impact-analysis`
in parallel. Many report symptoms (slow visuals, blank values, broken bindings)
start in the model.

## Review dimensions

### 1. Usage and adoption

The most objective signal of report value. A report nobody views is a
maintenance liability.

Evaluate:

- **Audience reach:** % of users with access who viewed the report in the last
  7, 28, and 60 days.
- **View trends:** rolling 7-day average vs. prior week.
- **Page distribution:** views concentrated on one page may indicate poor
  navigation or irrelevant pages.
- **Last visited:** when was the report last accessed?
- **Subscriptions:** a report with zero views but active subscribers may still
  deliver value passively.
- **Load times:** P50 and P90 from Usage Metrics or Performance Analyzer.

Caveats: zero views can mean new, seasonal, embedded, or subscription-driven
consumption. Cross-reference before calling a report dead.

### 2. Design and layout

Checklist:

- [ ] Page titles present and descriptive.
- [ ] Equal spacing between visuals and consistent margins.
- [ ] Detail gradient followed: KPIs/cards top-left, detail bottom-right.
- [ ] Color is intentional and accessible; no red/green-only encoding.
- [ ] Fonts and sizes consistent (prefer Segoe UI).
- [ ] Visual count reasonable per page (rough guide: 12–15 max for performance).
- [ ] No empty visuals; every data visual has bindings.
- [ ] Custom theme applied, not a default Power BI theme.
- [ ] Chart axes start at zero unless intentionally otherwise.
- [ ] Default sort configured on all visuals.
- [ ] Visuals named clearly in the selection pane.
- [ ] Mobile layout provided if audience consumes on mobile.
- [ ] Visual headers disabled where drill-down/through is not needed.
- [ ] Cross-filtering/highlighting configured intentionally, not left at defaults.
- [ ] Slicer "Apply" buttons considered on performance-sensitive pages.
- [ ] Synchronized slicers used across pages where required.

### 3. Data model binding

Checklist:

- [ ] Report is a thin report connected to a published model, not a thick report
      embedding its own model.
- [ ] All field bindings resolve to existing columns/measures.
- [ ] Extension measures (thin report measures) are used sparingly and only for
      report-specific logic.
- [ ] No broken or orphaned field references.
- [ ] Measures vs. columns used appropriately in visuals.
- [ ] Visual-level filters are intentional and documented.

### 4. Performance

Checklist:

- [ ] Page load P50 and P90 are acceptable for the audience.
- [ ] Visual count per page is justified by query cost, not just count.
- [ ] Heavy visuals use aggregations or pre-computed measures.
- [ ] DirectQuery/Direct Lake reports avoid report-level heavy operations.
- [ ] Extension measures are not doing work that belongs in the model.

Use Performance Analyzer exports, `powerbi-report-author validate`, and model
review via `coop-dax-review` to ground findings.

### 5. Governance

Checklist:

- [ ] Thin report connected to published model.
- [ ] Endorsement status appropriate (Certified for production, Promoted for team).
- [ ] Sensitivity label applied if tenant policy requires it.
- [ ] Part of a deployment pipeline if in a production workspace.
- [ ] Distributed via workspace app or org app, not direct links or publish-to-web.
- [ ] Access granted via security groups, not individual users.
- [ ] Consumers have Viewer role; edit access limited to developers.
- [ ] Export-to-Excel patterns reviewed for data-governance risk.

### 6. Accessibility, standards, and documentation

Accessibility checklist:

- [ ] Alt text on all data visuals.
- [ ] Decorative items removed from tab sequence.
- [ ] Tab order matches geometric reading pattern.
- [ ] No color-only encoding; paired with shape, glyph, or text.
- [ ] Color contrast meets WCAG 2.1 AA.
- [ ] Font sizes legible.
- [ ] Mobile layout present where relevant.

Standards and documentation:

- [ ] Naming conventions followed (report, pages, visuals).
- [ ] Purpose statement and intended audience documented.
- [ ] Atypical features documented (hidden slicers, bookmarks, custom visuals).
- [ ] Support contacts and feedback channel identified.
- [ ] Training/adoption materials available for business users.

## Severity scale

Tag each finding:

- **Critical:** broken functionality, security risk, completely unused report
  consuming capacity.
- **High:** performance impacting users, major design violations, missing data
  bindings.
- **Medium:** design inconsistencies, moderate performance concerns, partial
  accessibility gaps.
- **Low:** polish items, style preferences, optimization opportunities.

## Output format

```
REPORT REVIEW: <Report Name>
===============================

USAGE SIGNAL
  Views (30d): 47  |  Viewers: 8  |  Reach: 12%
  Top pages: Overview (60%), Detail (30%), Trends (10%)
  Load time P50: 3.2s  |  P90: 7.1s

CRITICAL
  - [Performance] P90 load time exceeds 7s due to 14 visuals on Overview page

HIGH
  - [Design] No page titles on 2 of 3 pages
  - [Binding] 3 visuals have orphaned field references

MEDIUM
  - [Design] Inconsistent margins (24px left, 32px right)
  - [Accessibility] Missing alt text on 5 data visuals

LOW
  - [Design] Default theme applied; consider custom theme
  - [Standards] Report name uses spaces instead of hyphens
```

## Workflow

1. **Scope.** Confirm report, stage, dimensions, and output location.
2. **Gather.** Read PBIR files, run `powerbi-report-author validate` and the
   `preview-*` inventory commands, query workspace metadata, and pull Usage
   Metrics where available.
3. **Evaluate.** Walk the relevant checklists; score findings by severity.
4. **Report.** Lead with the highest-impact findings.
5. **Recommend.** For each finding, suggest a concrete fix and the owner
   (report author, model author, tenant admin).
6. **Log.** Append a summary to the daily log.

## Related skills

- **`power-bi-report-authoring`** — PBIR inspection and editing commands.
- **`power-bi-impact-analysis`** — blast-radius analysis before changes.
- **`dax-review`** / **`coop-dax-review`** — model and DAX review.
- **`fabric-workspace-review`** — workspace-level architecture review.
- **`coop-workflow`** — plan-and-approve, backups, logging, never commit source.
