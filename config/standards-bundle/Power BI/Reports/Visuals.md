---
id: powerbi_reports_visuals
title: Power BI Report Visuals
domain: powerbi
layer: report
artifact: visual
technology: power_bi
status: active
---
# Report Visuals

## Standards

### Visual accessibility standards

- Never use color alone to convey meaning. Combine color and tint in charts, and color and shape in icons.
- Never use table or matrix cell shading.

### Visual interaction standards

- Set chart interactions to **Filter**, not **Highlight**.
- Explicitly define drill-through filters.
- Do not create bookmark-controlled filter panels: they require two bookmarks on every page.

### KPI standards

Use approved custom SVG assets for KPI status indicators instead of platform-default status icons.

## Default positions

### Visual layout defaults

- Leave 16 pixels between visuals: two grid movements at 100% zoom with snap to grid enabled.
- Center titles and use dark gray.
- Choose charts for the reporting requirement.
- Use Segoe UI for flexibility and consistent numeric spacing.

### Visual color defaults

- Use one primary color per visual; use gray or lighter variations for other elements.
- Small tables have no alternating row colors. Large tables use alternating row colors.

### Slicer defaults

Use one to five visible slicers instead of relying on the built-in Filters pane. Slicers are discoverable, flexible, and can be selectively synchronized across pages.

## Open decisions (non-normative)

Clarify whether the cell-shading prohibition excludes alternating row backgrounds, which are the current default for large tables.
