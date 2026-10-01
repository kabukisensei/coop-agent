---
id: powerbi_semantic_model_measures
title: Power BI Measures
domain: powerbi
layer: semantic_model
artifact: measure
technology: power_bi
status: active
---
# Semantic Model Measures

## Standards

### Measure naming standards

- Name base measures for their business value, such as `Sales Amount` or `Sales Quantity`.
- Name filtered measures `{Base Measure} | {Filter}` and reference the base measure instead of repeating its aggregation.
- Use `SUM` for additive base measures. Keep model-specific filtered measures in DAX, built from the base measure.

```dax
[Sales Amount] = SUM('Sales Transactions'[SalesAmount])
```

```dax
[Sales Amount | Intercompany] =
VAR result = CALCULATE([Sales Amount], KEEPFILTERS(Customer[Intercompany] = TRUE()))
RETURN result
```

### Measure visibility standards

- Expose business aggregations as explicit measures.
- Hide numeric columns not intended for direct aggregation or set `summarizeBy: none`.
- Give every visible measure a description; hidden helper measures can omit it.

### Measure format standards

- Give every visible measure an explicit format string.
- Align commas and decimal points within the visual.
- For aligned parenthesized negatives, use a dynamic format with non-breaking spaces and regular Segoe UI. Ordinary trailing spaces and bold/semibold fonts do not provide the required alignment.

```dax
"$ #,0" & UNICHAR(160) & ";$ (#,0);$ 0" & UNICHAR(160)
```

### Measure validation standards

- Establish the business definition, what is being counted or summed, report-filter behavior, and date-table requirements before writing the measure.
- Build and test incrementally.
- Check the base result, slicers, blank/zero/no-row cases, and a known control total when available.

## Default positions

### SQL or DAX defaults

Put organization-certified calculations in Gold SQL when multiple semantic models use them or are expected to. Otherwise, use DAX.

### Measure number-format defaults

Use these formats unless a project-specific format overrides them:

| Value | Format |
|---|---|
| Whole number | `#,###` |
| Percentage | `##%` |
| Currency | `$ #,0;-$ #,0;$ 0;--` |
