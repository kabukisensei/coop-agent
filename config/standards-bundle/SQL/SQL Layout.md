---
id: sql_formatting
title: SQL Layout
domain: sql
layer: agnostic
artifact: formatting
technology: agnostic
status: active
---
# SQL Layout

These rules define how SQL is displayed. Apply them to new or fully reformatted statements. During a targeted edit, leave unrelated formatting alone.

## Standards

### SELECT layout standards

- In multiline lists, place each comma one character left of the first expression with no following space.
- Within each contiguous projection section, align column-alias `AS` keywords at the same visual column. A blank line or organizing comment starts a new section.
- Do not align `AS` used for tables, CTEs, or `CREATE ... AS`.

```sql
SELECT
      ct.accountnum AS Customer
     ,ct.name       AS [Customer Name]
```

### CTE layout standards

- Put `WITH` on its own line.
- Align CTE names. Place each continuation comma one character left of the CTE name with no following space.

```sql
WITH
     ActiveCustomers AS (...)
    ,SalesOrders AS (...)
```

### Join layout standards

Indent `ON` four spaces beneath the join and each additional predicate four spaces beneath `ON`.

```sql
INNER JOIN d365fo.salestable AS st
    ON ct.dataareaid = st.dataareaid
        AND ct.accountnum = st.custaccount
```

### SQL Prompt bracket setting

Use **Remove unnecessary square brackets** when formatting with SQL Prompt. Keep required brackets, such as `AS [Customer Name]`; remove optional ones, such as `AS [Customer]`.

## Default positions

### Indentation defaults

Use spaces so alignment survives different editor tab settings. At the outermost level, examples use six spaces before SELECT expressions and five before CTE names; each list's comma sits one column earlier. The lists align internally, not with each other.

### Clause layout defaults

Start `SELECT`, `FROM`, `WHERE`, `GROUP BY`, and `ORDER BY` on separate lines aligned with each other. Use the SELECT list layout for multiline grouping and ordering lists. Put additional WHERE conditions on separate indented lines; preserve parentheses that control mixed AND/OR logic.

```sql
FROM d365fo.custtable AS ct
WHERE ct.blocked = 0
    AND ct.dataareaid = 'usmf'
```

### CASE layout defaults

Put each `WHEN` and `ELSE` on a separate indented line. Align `END` with `CASE` and keep the output alias after `END`.

```sql
CASE
    WHEN ct.blocked = 0 THEN 'Available'
    ELSE 'Blocked'
END AS [Customer Status]
```

### EXISTS comment defaults

Put the explanation immediately above the `WHERE` or `AND` containing `EXISTS` or `NOT EXISTS`. Plain prose is enough; no fixed comment template is required.

## References (non-normative)

- [Redgate SQL Prompt: Add/remove square brackets](https://documentation.red-gate.com/sp10/sql-refactoring/sql-prompt-actions)
