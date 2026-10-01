---
id: tech_fabric_warehouse
title: Fabric Warehouse Target
domain: sql
layer: agnostic
artifact: agnostic
technology: fabric_warehouse
status: active
---
# Fabric Warehouse

Applies only to Fabric Warehouse. Persisted-column type restrictions apply when defining persisted columns, including tables created inside a stored procedure; they are not restrictions on view output or Azure SQL columns.

## Fabric persisted-column standards

| Do not use | Use instead |
|---|---|
| `nvarchar`, `nchar` | `varchar`, `char` |
| `datetime`, `smalldatetime` | `datetime2` |
| `datetimeoffset` | `datetime2`; apply offset/time-zone logic at query time |
| `money`, `smallmoney` | `decimal(19,4)` |
| `tinyint` | `smallint` |
| `text`, `ntext` | `varchar(max)` |
| `image` | `varbinary(max)` |
| `xml` | `varchar(max)` |
| `json` | `varchar(max)` |
| `geography`, `geometry` | latitude/longitude columns, WKB `varbinary`, or WKT `varchar` |
| `hierarchyid`, CLR user-defined types | a supported native type |

Do not apply these persisted-column restrictions to Azure SQL. Select Azure SQL target mode when reviewing Azure SQL with `coop-sql-review`.

## Fabric persisted-expression standards

In CTAS projections, explicitly cast expressions when the persisted type needs to be controlled, including aggregate outputs.

```sql
     ,CAST(SUM(sl.lineamount) AS decimal(19,4)) AS SalesAmount
```

## Fabric connection standards

- Specify the database with `-d` in Fabric Warehouse `sqlcmd` calls.
- Use Microsoft Entra authentication (`-G`), never SQL authentication.

```text
sqlcmd -S <warehouse-endpoint> -d <database> -G
```
