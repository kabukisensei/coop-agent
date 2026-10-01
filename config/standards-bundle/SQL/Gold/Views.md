---
id: sql_gold_views
title: Gold Views
domain: sql
layer: gold
artifact: view
technology: agnostic
status: active
---
# Gold Views

## View naming standards

Use `{Schema}.{Entity}` with a PascalCase entity name. Use `common` for views shared by semantic models; otherwise use the model name.

```sql
CREATE VIEW sales.Customer AS
```

## View field standards

- Give every projected field an explicit alias, including unchanged names. Use brackets only when the name requires them.
- Organize dimensions under `--Keys` and `--Attributes`; add `--Numbers` for facts.
- Include `NULL AS FKNULL` in every fact view's keys.
- Keep key and number names unchanged. Numbers are additive fact fields intended for `SUM`.
- Give attributes friendly names with spaces.
- Exclude helper join fields such as `dataareaid` and `customerid`.

### Dimension view example

```sql
SELECT
    --Keys
      cust.PKCustomer   AS PKCustomer
    --Attributes
     ,cust.CustomerName AS [Customer Name]
FROM dim.Customer AS cust;
```

### Fact view example

```sql
SELECT
    --Keys
      NULL             AS FKNULL
     ,sales.FKCustomer AS FKCustomer
    --Attributes
     ,sales.SalesOrder AS [Sales Order]
    --Numbers
     ,sales.SalesAmount AS SalesAmount
FROM fact.Sales AS sales;
```

## Dimension display-field standards

When a dimension has an identifier and name, include both combined fields: identifier first for pivot reporting, and name first with the identifier in parentheses for alphabetical reporting.

```sql
     ,cust.Customer + ' • ' + cust.CustomerName      AS [Customer and Name]
     ,cust.CustomerName + ' (' + cust.Customer + ')' AS [Name and (Customer)]
```

## View transformation standards

The two dimension display fields above are approved transformations. Other transformations and all joins require an explicit user request, a necessity check, and a comment explaining the exception. Otherwise, put transformations in stored procedures.
