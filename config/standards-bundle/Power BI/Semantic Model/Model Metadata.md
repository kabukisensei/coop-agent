---
id: powerbi_semantic_model_tables
title: Power BI Semantic Model Metadata
domain: powerbi
layer: semantic_model
artifact: model_metadata
technology: power_bi
status: active
---
# Semantic Model Metadata

These standards define names, formats, visibility, folders, hierarchies, and other metadata for tables and columns. Measure metadata and DAX expressions are defined separately.

## Table and column naming standards

- Use PascalCase table and calculated-column names unless a more specific naming rule applies. Approved measure-table names and friendly report-facing column names contain spaces; Direct Lake table names match their source exactly.
- Qualify column references with the table name.

```dax
Customer[CustomerGroup]
```

## Column metadata standards

- Disable summarization for numeric columns not intended for aggregation, especially visible fields such as Year and Line Number. Hiding a field and disabling summarization are separate settings.
- Format dates as `mm/dd/yyyy` and Boolean/BIT fields as `TRUE` / `FALSE`.
- Convert timestamps to the client's primary time zone in SQL using time-zone conversion, never a fixed UTC offset.
- Show the local date, time, and zone; include the zone in the column name.

```text
Created Date ET: 10/06/2025 3:00 PM Eastern
```

## Date table metadata standards

- Define the Date table in SQL, not with a DAX calculated table.
- Use one contiguous, marked Date table for time intelligence.
- Disable auto date/time and remove `LocalDateTable_*` and `DateTableTemplate_*` tables.
- Use `Calendar`, `Fiscal`, and `Relative` folders when those fields exist.

## Calculated column defaults

- Define columns in SQL.
- Use DAX calculated columns only for approved edge cases where special-character handling requires them.
- Before adding a calculated column to a Direct Lake model, verify that the specific Direct Lake mode supports it.

## Display folder standards

Dimension folders are optional. When used, group fields by subject.

## Hierarchy and sorting standards

- Put ordered levels in a hierarchy with a clear name.
- Put first the field whose label can represent the hierarchy in visuals where it cannot be renamed.
- Sort Date-table strings by an integer or Date column. Hide sort-only columns.

```text
Month Name → sort by Month Number (hidden)
```

For a `Product` hierarchy with Category → Subcategory → Product levels, Category is the first field. Check that its label is suitable when a visual displays that label for the hierarchy and cannot rename it.

## Open decisions (not standards)

- Whether timestamp names should explicitly include `Time`, and whether the displayed value needs a zone when the column name already includes it. The current approved example remains `Created Date ET: 10/06/2025 3:00 PM Eastern`.
- How clients with multiple time zones choose the reporting zone, and where that choice is configured.
- Date-table range and fiscal-calendar source.

## Supporting references

- [Microsoft: Direct Lake overview and limitations](https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview)
