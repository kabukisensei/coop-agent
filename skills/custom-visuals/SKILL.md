---
name: custom-visuals
description: Author custom visuals for Power BI reports: Deneb (Vega/Vega-Lite) and SVG generated via DAX measures. Use when the user mentions Deneb, Vega, Vega-Lite, SVG sparklines, SVG measures, or inline graphics in tables/matrices/cards.
---

# Custom visuals in Power BI

Power BI supports two advanced custom-visual patterns that go beyond native
visuals:

- **Deneb** — a certified custom visual that renders Vega or Vega-Lite specs.
  Use for interactive charts that need precise control over marks, interactivity,
  or chart types Power BI does not provide natively.
- **SVG via DAX measures** — a measure returns an SVG data URI with the
  `ImageUrl` data category. Use for lightweight inline graphics in tables,
  matrices, cards, and image visuals.

Both are authored through the PBIR mechanics in the `power-bi-report-authoring`
skill (direct JSON edits + `powerbi-report-author validate` + Desktop
verification) and operate under the `coop-workflow` skill.

## Coop conventions

- **Plan before creating.** Custom visuals add maintenance; confirm the user
  accepts the trade-off.
- **Structured edits only.** Modify `visual.json` / `reportExtensions.json` via
  JSON parse → modify → stringify or exact-match edits; never regex on JSON.
- **Back up.** Preserve the report folder before adding visuals or extension
  measures.
- **Validate and verify.** Run `powerbi-report-author validate` after each batch
  and capture a Desktop screenshot or sandbox render before calling it done.
- **Log.** Append a task entry to the daily log.

See `examples/` for starter Deneb and SVG measure files.

## Choose the right pattern

| Need | Use |
|---|---|
| Interactive custom chart with cross-filtering/tooltips | **Deneb** |
| Sparkline, data bar, KPI micro-chart inside a table/matrix/card | **SVG measure** |
| Statistical visualization requiring complex transforms | **Deneb** |
| Simple static indicator with no interactivity | **SVG measure** |
| Native visual can already do it | Native visual |

## Deneb visuals

Deneb's `visualType` GUID is `deneb7E15AEF80B9E4D4F8E12924291ECE89A`. It is a
custom visual, so `powerbi-report-author catalog` will not list it and
`validate` treats it as a known-custom type only when the `.pbiviz` is
registered under the report's `CustomVisuals/` folder.

### Scaffold the visual

The reliable way to add a Deneb visual to a PBIR report:

1. **Preferred:** copy an existing Deneb `visual.json` (from this report or a
   known-good one) into a new `visuals/<newVisualId>/` folder, give it a fresh
   unique name/ID, and adjust position and size.
2. If no template exists, add the visual once in Power BI Desktop (which also
   registers the `.pbiviz` under `CustomVisuals/`), save as PBIP, then continue
   editing on disk.

Deneb has one data role: `dataset`. All fields bind to it. Keep the existing
`query` structure from the template and only swap the field references — confirm
field/entity names against the semantic model (TMDL) before binding.

### Author the spec

Prefer **Vega-Lite** unless you need Vega-only features (signals, event streams,
force/voronoi layouts).

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "data": {"name": "dataset"},
  "mark": {"type": "bar", "tooltip": true},
  "encoding": {
    "y": {"field": "Category", "type": "nominal"},
    "x": {"field": "Value", "type": "quantitative"}
  }
}
```

Critical rules:

- Field names in the spec must match the `nativeQueryRef` from the bindings.
- Special characters (`.`, `[`, `]`, `\`, `"`) in field names become `_`.
- Spaces are preserved.
- Vega-Lite uses `"data": {"name": "dataset"}` (object); Vega uses an array.

### Embed the spec

The spec lives inside the visual's `visual.json` as a stringified JSON literal.
Find the existing spec property in the template you copied, replace its string
value with your spec (properly escaped), and write the file back with a
structured JSON edit. Never paste unescaped JSON into the string.

Then validate:

```bash
powerbi-report-author validate "Report.Report"
```

### Theme integration

Use Power BI theme functions instead of hardcoded hex values:

| Need | Vega/Vega-Lite |
|---|---|
| Theme color by index | `{"signal": "pbiColor(0)"}` |
| Categorical palette | `{"scheme": "pbiColorNominal"}` |
| Ordinal palette | `{"scheme": "pbiColorOrdinal"}` |
| Continuous gradient | `{"scheme": "pbiColorLinear"}` |
| Divergent gradient | `{"scheme": "pbiColorDivergent"}` |

### Interactivity

Enable cross-filtering, cross-highlighting, and tooltips in the visual
configuration. Handle `__selected__` and `<field>__highlight` fields when
selection or highlighting is enabled.

## SVG visuals via DAX measures

### How it works

1. A DAX measure returns an SVG string prefixed with `data:image/svg+xml;utf8,`.
2. The measure's `dataCategory` is set to `ImageUrl`.
3. Power BI renders the SVG as an image in supported visuals.

Supported visuals: table, matrix, image, new card, new slicer.

### Create an extension measure

Report-level (extension) measures live in `definition/reportExtensions.json`.
Add the measure there with a structured JSON edit (see
`power-bi-report-authoring` editing rules), setting its `dataCategory` to
`ImageUrl`. Prefer model-level measures in the semantic model (TMDL) when the
graphic is reused across reports.

```dax
SVG Sparkline =
VAR _Prefix = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 30'>"
VAR _Bar = "<rect x='0' y='0' width='50' height='30' fill='#2196F3'/>"
VAR _Suffix = "</svg>"
RETURN _Prefix & _Bar & _Suffix
```

Measure conventions:

- Use a **VAR pattern**: CONFIG → NORMALIZATION → SVG ELEMENTS → ASSEMBLY.
- Normalize raw values to a fixed SVG coordinate range (e.g., 0–100).
- Use `ALLSELECTED` for scope when the chart should respond to slicers.
- Guard against total/subtotal rows with `HASONEVALUE` or `ISINSCOPE`.
- Use single quotes for SVG attributes: `fill='#2196F3'`.
- Use hex colors with `#`; never `%23` URL encoding or named colors.
- Use `viewBox` for responsive scaling.

### Example: normalized bar

```dax
SVG Bar =
VAR _Actual = [Sales Amount]
VAR _Max = CALCULATE ( MAXX ( ALLSELECTED ( 'Product'[Category] ), [Sales Amount] ), REMOVEFILTERS ( 'Product'[Category] ) ) * 1.1
VAR _Range = 100
VAR _Normalized = DIVIDE ( _Actual, _Max ) * _Range
VAR _Svg =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 25'>" &
    "<desc>" & FORMAT ( _Actual, "000000000000" ) & "</desc>" &
    "<rect x='0' y='5' width='" & _Normalized & "' height='15' fill='#5B8DBE'/>" &
    "</svg>"
RETURN
    IF ( HASONEVALUE ( 'Product'[Category] ), _Svg )
```

The `<desc>` trick lets the table/matrix sort by the SVG column.

### Limitations

- SVG images are static: no hover, click, or tooltip.
- No JavaScript.
- 32K character limit per rendered cell.
- Each visible cell evaluates the string-building expression; push aggregations
  into model measures so the SVG measure only maps numbers to coordinates.

## Validation

For both patterns:

```bash
powerbi-report-author validate "Report.Report"
```

For Deneb, also verify the spec renders as expected with a Desktop
reload + screenshot (`powerbi-desktop reload --pid N` then
`screenshot-all --pid N --output-dir shots`, Windows only) or a sandbox
publish. For SVG measures, preview the static SVG in a browser before
converting it to DAX.

## Accessibility

- Deneb: provide tooltips and ensure color is not the only encoding.
- SVG measures: screen readers receive no per-cell data from the SVG URI. Add
  adjacent readable columns and dynamic alt-text measures.

## Related skills

- **`power-bi-report-authoring`** — PBIR editing rules, validation, and Desktop
  verification.
- **`power-bi-report-review`** — audit reports that use custom visuals.
- **`report-themes`** — theme authoring for consistent colors.
