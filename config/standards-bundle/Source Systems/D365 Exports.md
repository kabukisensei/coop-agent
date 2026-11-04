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

## Default positions

### DAX defaults

- Deleted rows never reach a model built on Silver; no measure filters `IsDelete`.
