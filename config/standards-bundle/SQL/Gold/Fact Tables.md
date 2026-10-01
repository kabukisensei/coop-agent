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

## Open decisions (non-normative)

- Names for multiple references to one dimension and optional fact identities.
- Naming and types for currencies, quantities, percentages, dates, flags, codes, descriptions, and audit fields.
- Index names, column order, index type, and physical foreign-key constraints.
