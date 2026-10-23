---
id: sql_conventions
title: SQL Conventions
domain: sql
layer: agnostic
artifact: conventions
technology: agnostic
status: active
---
# SQL Conventions

Standards are required. Default positions are starting choices for new code; follow an existing statement’s consistent style during targeted edits.

## Standards

### SELECT standards

- Use explicit projections. Never use `SELECT *`.
- In `INSERT ... SELECT`, alias every expression to its exact target column.
- List the target columns explicitly in every `INSERT ... SELECT`; do not rely on the table's physical column order.

```sql
INSERT INTO dim.Customer (Customer)
SELECT
      ct.accountnum AS Customer
FROM d365fo.custtable AS ct;
```

### DISTINCT standards

- Use `DISTINCT` only when the required result is one row per unique projected value.
- Never add `DISTINCT` to hide duplicate rows caused by an incorrect join, an incorrect grain, or a query whose duplication is not understood.

### Null-handling standards

- Use null-handling functions such as `ISNULL`, `COALESCE`, and `NULLIF` only in the `SELECT` projection. Do not use them in `FROM`, `JOIN`, `ON`, or `WHERE` logic.
- Use them for expected null behavior, such as presenting a missing value after a `LEFT JOIN`; do not use them to conceal incorrect source data or repair Silver data in a query.
- There is no repository-wide preference between `COALESCE` and `ISNULL`; use the function whose behavior fits the expression and target type.

### Alias standards

- Alias every table and CTE reference, even when only one source is referenced.
- Do not use single-letter or ordinal aliases such as `t1`.
- Use square brackets only when required, such as names containing spaces or reserved words: `AS [Customer Name]`, but `AS Customer`. This applies to source identifiers and aliases, including views.
- When an existing output contract requires a SQL reserved word as an alias, enclose it in brackets.
- Qualify permanent table and view names with their schema. CTEs and temporary tables do not need schema qualification.
- Output aliases follow the target article: technical fields retain their required names; Gold view attributes use friendly names with spaces.

```sql
FROM d365fo.custtable AS ct
```

### CTE standards

- Use CTEs instead of nested derived tables for multi-step transformations.
- Preserve source field names through CTEs unless the transformation requires a rename. Apply target names in the final projection.

```sql
WITH
     ActiveCustomers AS (...)
```

### Join standards

- Never use `RIGHT JOIN`.
- Keep `ON` clauses limited to relationship predicates. Do not place `CASE` expressions or filter functions in them.

```sql
    LEFT JOIN dim.Customer AS cust
        ON sl.customerid = cust.customerid
```

### Comments standards

- Use only line comments in SQL: `-- ...`.
- Do not use block comments such as `/* ... */`.
- Use `--` comments to explain intent, assumptions, or the purpose of a conditional expression; keep them brief and directly tied to the code they describe.

```sql
-- Tests for customer sales without multiplying rows.
WHERE EXISTS (...)
```

### EXISTS standards

- `EXISTS` and `NOT EXISTS` are allowed.
- Add a comment stating the tested condition and why `EXISTS` is used.

```sql
-- Tests for customer sales without multiplying rows.
WHERE EXISTS (...)
```

## Default positions

### Defaults when editing existing code

- `JOIN` versus `INNER JOIN`, optional `AS`, and equality-operand order are nonfunctional differences. They are not defects in existing code.
- Preserve the statement's established style during a targeted edit. Do not change unrelated code solely to enforce a default.
- Use one style consistently within each statement.

### Alias defaults

- Use recognizable source abbreviations, such as `salesline AS sl` and `salestable AS st`.
- Use lowercase source aliases. When a source is joined more than once or an abbreviation is ambiguous, use `{abbreviation}_{role}`, such as `ct_order` and `ct_invoice`.
- Use `AS` for table, CTE, and column aliases.
- Avoid SQL reserved words as aliases.

```sql
custtable AS ct_order
custtable AS ct_invoice
```

### CTE and temporary-table defaults

- Use CTEs when they produce the required result without a demonstrated performance problem.
- Use a temporary table when the intermediate result is reused or when it resolves a demonstrated performance problem.
- Name CTEs in PascalCase for their transformation, such as `ActiveCustomers`.
- Filter business rows in CTEs before joins.

```sql
ActiveCustomers AS (...)
```

### Set operator defaults

- Use `UNION ALL`.
- Use `UNION` only when removing duplicate rows across the combined result sets is an intentional requirement.

### Table-hint defaults

Do not use `NOLOCK` by default. Cooptimize normally queries replicated or warehouse data rather than an active production ERP database. Use `NOLOCK` only for an explicitly approved case where dirty-read behavior is acceptable.

### Join defaults

- Use explicit `INNER JOIN` or `LEFT JOIN` for new and fully rewritten statements.
- Use `LEFT JOIN`, not `LEFT OUTER JOIN`; omit the optional `OUTER` keyword.
- Do not use `FULL OUTER JOIN` by default.
- Within each `ON` clause, order join conditions from the most general key to the most specific: for example, company (`dataareaid`) before sales order (`salesid`).
- Place the table already in the `FROM`/join chain first and the table introduced by that `JOIN` second.

```sql
    INNER JOIN d365fo.salestable AS st
        ON sl.dataareaid = st.dataareaid
        AND sl.salesid   = st.salesid
```

### Join order defaults

- Start `FROM` with the most detailed source table, such as sales lines rather than sales headers.
- List `INNER JOIN` clauses first, followed by `LEFT JOIN` clauses.
- Favor larger tables earlier and smaller lookup tables later.
- Respect dependencies: a join that uses an earlier table's fields must follow that table. These are ordering guidelines; do not reorder joins when doing so changes which rows are returned.

```sql
FROM d365fo.salesline            AS sl
    INNER JOIN d365fo.salestable AS st
        ON ...
    LEFT JOIN dim.Customer       AS cust
        ON ...
```

### Missing-match defaults

Use `NOT EXISTS` for missing-match checks when the comparison can contain NULL. `NOT IN (subquery)` can return no matches when the subquery includes NULL; it is not interchangeable with `NOT EXISTS`. Decide separately how a NULL outer key should behave.

```sql
-- Finds customers with no matching sales orders.
WHERE NOT EXISTS (...)
```

## Supporting references

- [Microsoft: NULL behavior with IN and NOT IN](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/in-transact-sql)
