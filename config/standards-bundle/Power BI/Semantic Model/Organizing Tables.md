---
id: powerbi_semantic_model_tables
title: Organizing Power BI Tables
domain: powerbi
layer: semantic_model
artifact: table
technology: power_bi
status: active
---
# Organizing Semantic Model Tables

## Table naming standards

- Use PascalCase table and calculated-column names unless a more specific naming rule applies. Approved measure-table names and friendly report-facing column names contain spaces; Direct Lake table names match their source exactly.
- Qualify column references with the table name.

```dax
Customer[CustomerGroup]
```

## Field formatting standards

- Disable summarization for numeric columns not intended for aggregation, especially visible fields such as Year and Line Number. Hiding a field and disabling summarization are separate settings.
- Format dates as `mm/dd/yyyy` and Boolean/BIT fields as `TRUE` / `FALSE`.
- Convert timestamps to the client's primary time zone in SQL using time-zone conversion, never a fixed UTC offset.
- Show the local date, time, and zone; include the zone in the column name.

```text
Created Date ET: 10/06/2025 3:00 PM Eastern
```

## Date table standards

- Use one contiguous, marked Date table for time intelligence.
- Disable auto date/time and remove `LocalDateTable_*` and `DateTableTemplate_*` tables.
- Use `Calendar`, `Fiscal`, and `Relative` folders when those fields exist.

## Dimension folder standards

Dimension folders are optional. When used, group fields by subject.

## Hierarchy and sorting standards

- Put ordered levels in a hierarchy with a clear name.
- Put first the field whose label can represent the hierarchy in visuals where it cannot be renamed.
- Sort Date-table strings by an integer or Date column. Hide sort-only columns.

```text
Month Name → sort by Month Number (hidden)
```

For a `Product` hierarchy with Category → Subcategory → Product levels, Category is the first field. Check that its label is suitable when a visual displays that label for the hierarchy and cannot rename it.

## Semantic model deployment standards

- Before adding calculated columns to a Direct Lake model, check Microsoft's current [Direct Lake limitations](https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview#considerations-and-limitations) for the specific Direct Lake mode. Do not use unsupported features.
- Direct Lake table names match their source exactly.
- Deploy semantic-model source with TMDL, not TMSL.

## Open decisions (non-normative)

- Whether timestamp names should explicitly include `Time`, and whether the displayed value needs a zone when the column name already includes it. The current approved example remains `Created Date ET: 10/06/2025 3:00 PM Eastern`.
- How clients with multiple time zones choose the reporting zone, and where that choice is configured.
- Date-table range, fiscal-calendar source, and whether the table is supplied by SQL or DAX.

## References (non-normative)

- [Microsoft: Direct Lake overview and limitations](https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview)
