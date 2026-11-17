---
id: sql_gold_fact_tables
title: Gold Fact Tables
domain: sql
layer: gold
artifact: fact_table
technology: agnostic
status: active
---
# Gold Fact Tables

## Standards

### Fact naming standards

- Use `fact` and PascalCase table and column names.
- Name dimension references `FK{DimensionName}`.
- Name business-facing identifiers for the entity: `Customer`, not `CustomerId`.

```sql
CREATE TABLE fact.CustomerTransactions (...)
      FKCustomer bigint NULL
```

### Fact null standards

- Keep `NULL` when a fact value is unknown or does not apply. `NULL` and zero mean different things.
- Do not replace `NULL` with `0`, `''`, or another placeholder unless the business asks for that value.

```sql
     ,sl.discamount AS DiscountAmount
```

### Fact index standards

Where supported, add non-unique indexes to join columns. Indexes do not enforce relationships or uniqueness.

```sql
CREATE INDEX IX_CustomerTransactions_FKCustomer
    ON fact.CustomerTransactions (FKCustomer);
```

## Default positions

### Fact column defaults

- Make columns nullable.
- Add an identity column only when there is a specific need.

```sql
     ,Customer varchar(20) NULL
     ,AmountMST decimal(19,4) NULL
```
