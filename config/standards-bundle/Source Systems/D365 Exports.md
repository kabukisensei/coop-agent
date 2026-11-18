---
id: source_d365_exports
title: D365 Exports
domain: source
layer: agnostic
artifact: export
technology: d365
status: active
---
# D365 Exports

Applies to SQL and DAX that read Dynamics 365 data through an export: Azure Synapse Link for Dataverse, Microsoft Fabric Link, or F&O Bring Your Own Database (BYOD).

## Standards

### Export standards

- Know which export a source table came from before you write against it. Column names, deleted rows and change columns differ by export.

| Export | Exports | Deleted rows | Change columns |
|---|---|---|---|
| Synapse Link | Tables (F&O and Dataverse) | Kept, flagged `IsDelete` | `SinkCreatedOn`, `SinkModifiedOn`, `versionnumber` |
| Fabric Link | Tables (F&O and Dataverse) | Kept, flagged `IsDelete` | `SinkCreatedOn`, `SinkModifiedOn`, `versionnumber` |
| BYOD | F&O data entities | Check the export's delete handling | Entity fields only |

### Deleted-row standards

- Silver loads only rows whose `IsDelete` is NULL, so Silver has no deleted rows. SQL over Silver needs no delete filter.
- SQL that reads an export directly (Bronze or the Link tables) excludes deleted rows, unless the task is about deletions. Test `IsDelete` without wrapping it in a function.

```sql
WHERE (ct.isdelete IS NULL OR ct.isdelete = 0)
```

### Change-column standards

- `SinkCreatedOn`, `SinkModifiedOn` and `versionnumber` describe the export, not the business event. Never use them as business dates.
- Silver keeps `SinkModifiedOn` (UTC; `1900-01-01` when missing) and leaves out `SinkCreatedOn` and, unless a developer added it, `versionnumber`.
- Silver is a full reload of each table. Never build Gold logic that assumes Silver keeps history or a watermark.

### Export metadata standards

- Synapse Link and Fabric Link export metadata tables beside the data. Before you guess a label, an enum value or a lookup join, read them with a read-only query. Confirm in the live catalog that the table exists first; BYOD has none.

| Table | Holds | Columns |
|---|---|---|
| `GlobalOptionsetMetadata` | F&O enum labels and shared Dataverse choice labels | `EntityName`, `OptionSetName`, `Option`, `LocalizedLabel`, `LocalizedLabelLanguageCode`, `GlobalOptionSetName` |
| `OptionsetMetadata` | Dataverse choice labels that belong to one table | The same, without `GlobalOptionSetName` |
| `StateMetadata`, `StatusMetadata` | `statecode` and `statuscode` labels | Check the catalog |
| `TargetMetadata` | The table each lookup column points to | `EntityName`, `AttributeName`, `ReferencedEntity`, `ReferencedAttribute` |

- Filter a label lookup on the table (`EntityName`), the column (`OptionSetName`) and the language (`1033` is English). Never match on the column name alone: two tables can share a column name with different labels.
- `TargetMetadata` gives one row per target, so a polymorphic lookup has several. It may not list F&O tables: with no row for a column, take the join from the F&O article or ask; never infer it from the column name.
- These tables are for looking things up while you write. Gold SQL still takes labels from the Silver `<column>name` column, never from a join to a metadata table.

```sql
SELECT gom.[Option], gom.LocalizedLabel
FROM dbo.GlobalOptionsetMetadata AS gom
WHERE gom.EntityName = 'salestable'
    AND gom.OptionSetName = 'salesstatus'
    AND gom.LocalizedLabelLanguageCode = 1033
```

### F&O export column standards

- In a Link export of an F&O table, `Id` is a GUID made from the row's RecId. It is not `recid`; keep joining on `recid`.
- An F&O field named `ID` arrives as `FnO_Id`. A field whose name is a SQL reserved word gets a trailing underscore: `Level` becomes `Level_`.
- Long text is cut to 2,000 characters. Array fields are missing from exports made before platform update 65. Never read a short text or a missing array column as the D365 value.
- A table whose name starts `mserp_` is an F&O data entity, not a table. Never mix its fields with a table's.

## Default positions

### DAX defaults

- Deleted rows never reach a model built on Silver; no measure filters `IsDelete`.
