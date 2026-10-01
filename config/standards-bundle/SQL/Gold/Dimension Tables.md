---
id: sql_gold_dimension_tables
title: Gold Dimension Tables
domain: sql
layer: gold
artifact: dimension_table
technology: agnostic
status: active
---
# Gold Dimension Tables

## Standards

### Dimension naming standards

- Use `dim` and a PascalCase table name.
- Name the identity `PK{DimensionName}` and use the target's standard identity behavior.
- Keep lowercase source names for business matching fields, such as `dataareaid` and `customerid`. These fields can be nullable, combined, and non-unique.
- Name business-facing identifiers for the entity: `Customer`, not `CustomerId`. Use PascalCase for other columns.

```sql
CREATE TABLE dim.Customer (...)
      PKCustomer bigint IDENTITY NOT NULL
```

### Dimension matching standards

- Where supported, index fields used together for matching with a composite, non-unique index.
- Do not create an artificial missing-match row, such as key `-1` named `Unknown`.

```sql
CREATE INDEX IX_Customer_dataareaid_customerid
    ON dim.Customer (dataareaid,customerid);
```

## Default positions

### Dimension nullability defaults

Make every column except the identity nullable. Population is controlled by the stored procedure.

```sql
     ,customerid varchar(20) NULL
     ,CustomerName varchar(100) NULL
```

## Open decisions (non-normative)

- Naming and types for numbers, dates, flags, codes, descriptions, and audit fields.
- Index names, column order, index type, and physical constraints on the identity key.
