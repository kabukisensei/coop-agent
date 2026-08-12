---
name: report-themes
description: Design, apply, audit, and validate Power BI report themes by editing theme.json in PBIR reports and validating with the powerbi-report-author CLI. Use when a report uses a default theme, has inconsistent formatting, needs rebranding, or the user wants to centralize visual styles.
---

# Power BI report themes

A report theme centralizes formatting that would otherwise drift across visuals:
colors, fonts, visual-type defaults, and container styling. Theme-first reports
are easier to rebrand, diff, and maintain.

A theme is a JSON file under the report's
`StaticResources/RegisteredResources/` folder, registered in
`definition/report.json`. You edit it with the structured-JSON rules from the
`power-bi-report-authoring` skill; there is no mutation CLI. This skill runs
under the `coop-workflow` skill.

## Coop conventions

- **Audit before changing.** Read the current theme and inventory visuals
  before editing.
- **Plan the palette.** Propose colors/fonts with rationale and get approval,
  especially for rebrands.
- **Back up.** Preserve the report folder or work on a branch before theme swaps.
- **Structured edits only.** Parse → modify → stringify, or exact-match edits.
  Never regex on `theme.json`, `report.json`, or `visual.json`.
- **Validate and verify.** Run `powerbi-report-author validate`, then Desktop
  reload + screenshots (or sandbox render).
- **Log.** Append a summary to the daily log.

## When to use

- A report still uses a default Power BI theme.
- Visuals have inconsistent colors, fonts, or repeated local overrides.
- The report needs rebranding.
- Auditing theme compliance before a release.

## Formatting cascade

```text
Power BI defaults
  -> theme wildcard defaults (visualStyles "*")
  -> theme visual-type defaults (visualStyles "<type>")
  -> visual instance overrides (visual.json objects)
```

The last layer wins. When rendering looks wrong, read the visual's `visual.json`
`objects` and `visualContainerObjects` to find the overriding layer.

## Audit before changing

```bash
powerbi-report-author preview-themes "Report.Report"
powerbi-report-author preview-visuals "Report.Report" --with-derived
powerbi-report-author validate "Report.Report"
```

Then read the theme JSON and scan for hardcoded overrides:

```bash
# Find literal hex colors sitting in page/visual definitions (overrides)
grep -rniE '"#([0-9a-f]{6}|[0-9a-f]{3})"' "Report.Report/definition/" | head -40
```

Look for:

- Hard-coded colors outside the theme.
- Repeated font or container overrides at the visual level.
- Inconsistent visual-type styling.
- Weak contrast or excessive palette size.
- Semantic colors (good/neutral/bad) that change meaning between pages.

## Theme JSON essentials

Preserve the existing `$schema` and top-level `name`. The properties you
usually touch:

```json
{
  "name": "Cooptimize",
  "dataColors": ["#00416B", "#42783C", "#82AA43", "#B2D235"],
  "background": "#FFFFFF",
  "foreground": "#252525",
  "good": "#2E7D32",
  "neutral": "#6B7280",
  "bad": "#C62828",
  "textClasses": {
    "title":   { "fontFace": "Segoe UI Semibold", "fontSize": 14 },
    "label":   { "fontFace": "Segoe UI",          "fontSize": 10 },
    "callout": { "fontFace": "Segoe UI Semibold", "fontSize": 32 }
  },
  "visualStyles": {
    "*": {
      "*": {
        "dropShadow": [{ "show": false }],
        "border":     [{ "show": false }]
      }
    },
    "cardVisual": {
      "*": {
        "title": [{ "fontSize": 14 }]
      }
    }
  }
}
```

- `dataColors` is the categorical palette applied in order.
- `visualStyles."*"` sets wildcard defaults for every visual; a named visual
  type overrides the wildcard for that type.
- Property names inside `visualStyles` must be valid formatting objects for the
  target visual type. Confirm them with
  `powerbi-report-author formatting list-objects <type>` and
  `formatting describe-object <type> <object>` before adding.
- Theme values are plain JSON (no PBIR expression wrappers). Helpers:
  `powerbi-report-author theme encode <value>` and
  `powerbi-report-author theme shade-color <hex> <percent>` for the
  ThemeDataColor shade algorithm.

## Design rules

1. Limit the data palette to the number of categories the report genuinely needs.
2. Reserve saturated accents for focus, selection, exceptions, and key comparisons.
3. Assign one stable meaning to each semantic color.
4. Keep structural colors quiet — axes, borders, gridlines, and backgrounds
   should support reading, not compete with data.
5. Use one portable font family and a small type scale. Prefer Segoe UI.
6. Prefer wildcard defaults, then visual-type defaults, then rare instance overrides.
7. Preserve accessible contrast and never rely on hue alone to communicate state.

## Re-theming an existing report

Changing the theme does not touch per-visual overrides. When the report has
hardcoded colors:

1. **Build a color mapping** — old hex → new hex for every theme color.
2. **Update `theme.json`** with the new palette.
3. **Sweep old hex literals** across `definition/` — shapes, nav buttons, and
   accent bars commonly hardcode `dataColors[0]` and friends as `Literal`
   values that survive a theme swap. Edit each match with structured edits.
4. **Register/rename** — theme files are cache-keyed by name in Desktop.
   After editing, either rename the theme file with a small random suffix (and
   update the registration in `report.json`) or close and reopen Desktop.
5. **Validate and verify** (below).

Watch polarity: a dark-to-light (or light-to-dark) swap needs an explicit
foreground/background audit so text does not go invisible.

## Clearing stale visual overrides

Removing per-visual overrides is destructive. Get approval, keep conditional
formatting, and make surgical edits to each `visual.json` (delete only the
override entries, keep bindings). Do not bulk-rewrite `objects` blocks.

## Validate and verify

```bash
powerbi-report-author validate "Report.Report"
```

On Windows with Power BI Desktop:

```bash
powerbi-desktop status
powerbi-desktop reload --pid <pid>
powerbi-desktop screenshot-all --pid <pid> --output-dir screenshots
```

Remember the theme cache-key caveat: reload alone may not pick up theme edits —
rename the theme file or reopen Desktop. On macOS/Linux, verify with validation
plus a sandbox publish (with approval).

## Deep mechanics

When the subordinate Microsoft `powerbi-report-authoring` skill is loaded
(`skills/_microsoft_fabric/`), defer to its `references/theming.md` for the full
theme.json property surface (style presets, ThemeDataColor reference) and
`references/re-theming.md` for the complete re-theming workflow, color-mapping
sweep, and dark-mode checklist.

## Workflow

1. **Audit.** Preview themes/visuals, read theme.json, grep hex overrides.
2. **Plan.** Propose palette/fonts with rationale; get approval.
3. **Back up.** Copy the report folder or work on a branch.
4. **Edit.** Structured edits to theme.json (and override sweep if re-theming).
5. **Validate.** `powerbi-report-author validate`.
6. **Verify.** Reload (rename trick) + screenshots, or sandbox publish.
7. **Log.** Append a summary to the daily log.

## Related skills

- **`power-bi-report-authoring`** — PBIR editing rules, validation, Desktop loop.
- **`power-bi-report-review`** — audit reports for theme compliance.
- **`custom-visuals`** — theme integration for Deneb and SVG visuals.
- **`coop-workflow`** — plan-and-approve, backups, diff, never commit source.
