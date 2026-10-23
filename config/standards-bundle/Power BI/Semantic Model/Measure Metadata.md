---
id: powerbi_semantic_model_measures
title: Power BI Measure Metadata
domain: powerbi
layer: semantic_model
artifact: measure
technology: power_bi
status: active
---
# Measure Metadata

These standards define measure names, descriptions, visibility, and formatting. Rules for writing measure expressions belong in DAX.

## Measure naming standards

- Name base measures for their business value, such as `Sales Amount` or `Sales Quantity`.
- Name filtered measures `{Base Measure} | {Filter}`.

```text
Sales Amount | Intercompany
```

## Measure visibility standards

- Expose business aggregations as explicit measures.
- Hide numeric columns not intended for direct aggregation or set `summarizeBy: none`.
- Give every visible measure a description; hidden helper measures can omit it.

## Measure format standards

- Give every visible measure an explicit format string.
- Align commas and decimal points within the visual.
- For aligned parenthesized negatives, use a dynamic format with non-breaking spaces and regular Segoe UI. Ordinary trailing spaces and bold/semibold fonts do not provide the required alignment.

```dax
"$ #,0" & UNICHAR(160) & ";$ (#,0);$ 0" & UNICHAR(160)
```

## Measure number-format defaults

Use these formats unless a project-specific format overrides them:

| Value | Format |
|---|---|
| Whole number | `#,###` |
| Percentage | `##%` |
| Currency | `$ #,0;-$ #,0;$ 0;--` |
