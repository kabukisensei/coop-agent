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
- CTE definitions and `CREATE ... AS` do not use column-alias alignment. Table-source aliases follow the join layout standards below.

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

- Indent joins four spaces beneath `FROM`. Indent `ON` and its additional `AND` predicates four spaces beneath the join, at the same indentation.
- Align table-source `AS` keywords across the `FROM` and joins in the same query block. Do not align across separate queries or CTE definitions.
- Align `=` signs within each join's `ON` clause; start alignment afresh for the next join.
- Use SQL Prompt's alias alignment and comparison-operator alignment options.

```sql
FROM OrderAmounts                AS oa
    INNER JOIN d365fo.salestable AS st
        ON oa.dataareaid = st.dataareaid
        AND oa.salesid   = st.salesid
    LEFT JOIN d365fo.custtable   AS ct
        ON st.dataareaid   = ct.dataareaid
        AND st.custaccount = ct.accountnum
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

## Stored procedure layout example

This reporting procedure summarizes nonzero sales lines by company and sales order, labels missing customer records, and includes only customers with posted transactions. It demonstrates layout, not a Gold loading pattern. Assume the D365FO tables are available under `d365fo`.

```sql
CREATE OR ALTER PROCEDURE reporting.SalesOrderSummary
AS
BEGIN
    SET NOCOUNT ON;

    WITH
         IncludedLines AS
         (
             SELECT
                   sl.dataareaid
                  ,sl.salesid
                  ,sl.lineamount
             FROM d365fo.salesline AS sl
             WHERE sl.salesid <> ''
                 AND sl.lineamount <> 0
         )
        ,OrderAmounts AS
         (
             SELECT
                   il.dataareaid
                  ,il.salesid
                  ,SUM(il.lineamount) AS lineamount
             FROM IncludedLines AS il
             GROUP BY
                   il.dataareaid
                  ,il.salesid
         )
    SELECT
        -- Order attributes
          oa.dataareaid  AS Company
         ,oa.salesid     AS [Sales Order]
         ,st.custaccount AS Customer
         ,CASE
              WHEN ct.accountnum IS NULL THEN 'Missing customer'
              ELSE 'Matched customer'
          END            AS [Customer Match]

        -- Amounts
         ,oa.lineamount AS [Sales Amount]
    FROM OrderAmounts                AS oa
        INNER JOIN d365fo.salestable AS st
            ON oa.dataareaid = st.dataareaid
            AND oa.salesid   = st.salesid
        LEFT JOIN d365fo.custtable   AS ct
            ON st.dataareaid   = ct.dataareaid
            AND st.custaccount = ct.accountnum
    -- Require posted customer activity without multiplying sales-order rows.
    WHERE EXISTS
    (
        SELECT 1
        FROM d365fo.custtrans AS ctr
        WHERE st.dataareaid = ctr.dataareaid
            AND st.custaccount = ctr.accountnum
    )
    ORDER BY
          oa.dataareaid
         ,oa.salesid;
END;
```

## Supporting references

- [Redgate SQL Prompt: Add/remove square brackets](https://documentation.red-gate.com/sp10/sql-refactoring/sql-prompt-actions)
- [Redgate SQL Prompt: table-alias alignment in joins](https://documentation.red-gate.com/sp9/release-notes-and-other-versions/sql-prompt-8-0-release-notes)
- [Thinkwise: SQL Prompt style and comparison alignment](https://docs.thinkwisesoftware.com/docs/sf/guidelines_sql_formatting#comparison-alignment)
