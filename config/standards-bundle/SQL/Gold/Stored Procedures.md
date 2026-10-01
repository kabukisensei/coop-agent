---
id: sql_gold_stored_procedures
title: Gold Stored Procedures
domain: sql
layer: gold
artifact: stored_procedure
technology: agnostic
status: active
---
# Gold Stored Procedures

Convert raw data into the final Gold fact or dimension shape. Organize applicable work as Removal, Gather, Transform, and Write. Loading recipes belong in the separate patterns knowledge base.

## Removal standards

Remove existing data only when the selected loading pattern requires it. The pattern and target technology determine whether to use `TRUNCATE`, `DELETE`, or another method.

```sql
TRUNCATE TABLE fact.Sales;
```

## Gather standards

Gather source data with CTEs or temporary tables. Preserve intermediate field names according to SQL Conventions.

```sql
FROM d365fo.salesline AS sl
INNER JOIN d365fo.salestable AS st
    ON sl.dataareaid = st.dataareaid
        AND sl.salesid = st.salesid
```

## Transformation standards

Resolve keys, joins, filters, and business transformations in the stored procedure. Apply target field names in the final write projection.

```sql
INNER JOIN dim.Customer AS cust
    ON sl.dataareaid = cust.dataareaid
        AND sl.custaccount = cust.customerid
```

## Write standards

Write the completed rows without adding business logic. The loading pattern and target technology determine whether to use `INSERT`, `MERGE`, or another method.

```sql
INSERT INTO fact.Sales (FKCustomer,SalesAmount)
SELECT
      fs.PKCustomer AS FKCustomer
     ,fs.lineamount AS SalesAmount
FROM #FinalSales AS fs;
```

## Comment standards

Explain why a non-obvious choice exists; do not narrate the SQL. Phase comments are allowed to separate long procedures.

```sql
-- A full refresh requires the prior snapshot to be removed.
```

## Preventing empty or partial tables

- Use an explicit transaction when DirectQuery, integrations, or other live consumers require removal and replacement to commit together.
- Commit on success; roll back on failure.
- Limit the transaction to statements that need to become visible together. Gather and transform beforehand when the loading pattern permits; long transactions increase blocking, conflicts, and resource use.
- Use this only when required by the incremental or replacement strategy.
- A standalone `MERGE` commits its changes together under autocommit. Use an explicit transaction when it needs to commit with other statements.

```sql
BEGIN TRANSACTION;
-- Removal and writing occur here; roll back on failure.
COMMIT TRANSACTION;
```
