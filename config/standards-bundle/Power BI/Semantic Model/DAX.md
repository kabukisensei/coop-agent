---
id: powerbi_semantic_model_dax
title: Power BI DAX
domain: powerbi
layer: semantic_model
artifact: dax_expression
technology: power_bi
status: active
---
# DAX

Examples assume existing measures and show only the expression being discussed. Complete measures follow the structure rules below.

## DAX structure standards

- Use consistent, readable formatting; DAX Formatter is allowed.
- Qualify columns as `Table[Column]`; leave measure references unqualified.
- A single aggregation or measure reference can remain one expression. Other measures use named `VAR` steps and `RETURN`.
- Use descriptive camel case variables without prefixes.
- Put intermediate results in variables; do not nest `CALCULATE` inside `CALCULATE`.
- Name business-meaningful numeric and string constants with variables. Arithmetic `0`, `1`, and `100`, plus `BLANK()`, `TRUE()`, and `FALSE()`, can stay inline.

```dax
VAR result = [Sales Amount] - [Sales Cost]
RETURN result
```

## DAX average standards

Never use `AVERAGE` or `AVERAGEX`: they leave the business numerator and denominator implied, making the intended average ambiguous. Define both explicitly, then use `DIVIDE` so it is clear what is being totaled and what it is divided by.

```dax
DIVIDE([Sales Amount], [Sales Quantity], 0)
```

## CALCULATE filter standards

Suppose a financial report shows **Revenue of $1,000** and **Expense of $400** on separate rows. The rows use `Account[Account Type]`, and `[Amount]` returns the total for each row. For this example, both amounts are positive and no individual accounts are selected.

Now add a calculation that asks for Revenue. On the Expense row, should it fetch the $1,000 revenue amount or return blank because that row is not Revenue? The way you write the filter determines the answer.

### CALCULATE expense divided by revenue — replace Account Type

**Question:** what percentage of revenue did we spend? On the Expense row, we need **$400 ÷ $1,000 = 40%**. To get the $1,000, replace that row's Expense selection with Revenue:

```dax
CALCULATE([Amount], Account[Account Type] = "Revenue")
```

This returns **$1,000**, even on the Expense row. Use a direct filter when the calculation needs Revenue regardless of the row's Account Type.

With that expression saved as `[Revenue]`, the ratio is simply:

```dax
DIVIDE([Amount], [Revenue], 0)
```

### FILTER revenue within the current selection — keep visible types

**Report:** a matrix with `Account[Account Type]` on rows and `[Amount]` as a value. Add a second value, `[Revenue Within Selection]`, to show only the revenue portion of each row:

```dax
CALCULATE(
    [Amount],
    FILTER(VALUES(Account[Account Type]), Account[Account Type] = "Revenue")
)
```

| Matrix row | `[Amount]` | Types searched by `FILTER` | `[Revenue Within Selection]` |
|---|---:|---|---:|
| Revenue | $1,000 | Revenue | $1,000 |
| Expense | $400 | Expense | Blank |
| Total | $1,400 | Revenue, Expense | $1,000 |

On the Expense row, `VALUES` returns only `Expense`. Testing that value against `Revenue` leaves no matches. At the total, both types are visible and Revenue matches.

Use this behavior when the column should show revenue only where it belongs. The direct `Account Type = "Revenue"` filter would instead repeat **$1,000 on the Expense row**.

This would be the wrong Revenue measure for the percentage calculation above: dividing $400 by its blank result returns the explicit fallback of **0%**, instead of the intended **40%**.

The difference comes from what `FILTER` searches. Here, `VALUES` supplies only visible account types; `FILTER` does not inherently preserve every report selection.

### KEEPFILTERS the same Revenue-only column — simpler field test

For the simple equality test above, use `KEEPFILTERS` to get the same result with less code:

```dax
CALCULATE([Amount], KEEPFILTERS(Account[Account Type] = "Revenue"))
```

It returns **$1,000** on Revenue and **blank** on Expense. Use `FILTER` when the condition needs to evaluate a measure or compare fields for each item.

Direct filters replace only the named field's selection. Filters on specific accounts or account groups still apply; filtering Account Type to Revenue does not clear an expense-account selection. Company and date selections remain in all three examples.

### ALL department share — remove one selection

**Use when:** a department matrix needs each department's percentage of total expense. The denominator must include all departments, even when the Department slicer selects only one.

```dax
CALCULATE([Actual Expense], ALL(Department[Department]))
```

Use this total as the denominator in `DIVIDE([Actual Expense], [Total Expense], 0)`.

Only the Department field's filter is removed. Company, date, and filters on other fields such as Department Group still apply. If the denominator should include only slicer-selected departments, this is not that calculation.

### ALLEXCEPT annual budget — retain only the year

**Use when:** a monthly budget report needs the full-year budget as a comparison beside each month. Fiscal Year is explicitly selected or appears on the visual.

```dax
CALCULATE([Budget Amount], ALLEXCEPT('Date', 'Date'[Fiscal Year]))
```

This keeps the Fiscal Year filter and removes month, quarter, date, and other Date-table filters. Use it only when ignoring all those other date selections is intentional. It does not infer a year from a selected month or date; without an explicit Fiscal Year filter, the result can include every year.

### USERELATIONSHIP invoice due dates — change the date basis

**Use when:** an invoice report normally groups amounts by invoice date, but finance also needs amounts by due date. The model has an inactive relationship from `FKDueDate` to Date.

```dax
CALCULATE([Invoice Amount], USERELATIONSHIP(Invoices[FKDueDate], 'Date'[PKDate]))
```

The selected month now applies to due dates rather than invoice dates. This changes which date relationship the measure uses, not the date selected in the report.

Empty matches return blank for a SUM-based measure. Zero requires the base measure or another expression to produce zero.

## SUMMARIZE grouping standards

Use grouping when a calculation needs one result per account, order, or other business unit before combining those results. `SUMMARIZE` returns a table of groups; it does not itself return the final measure value.

### SUMMARIZE customers with past-due balances — test each customer

**Question:** how many customers have a past-due balance? Assume `[Past Due Balance]` already calculates the customer's net overdue amount for the selected date.

```dax
COUNTROWS(
    FILTER(
        SUMMARIZE(Customer, Customer[Company], Customer[Customer]),
        [Past Due Balance] > 0))
```

Group by company and customer, calculate each customer's past-due balance, then count only positive balances. This counts customers, not overdue invoices. Company keeps matching customer numbers in different companies separate.

A customer with three overdue invoices counts **once**. If Customer A owes **$100** and Customer B has an overdue credit of **$100**, the answer is **one customer**, even though the combined past-due balance is zero. Testing only the combined balance would miss Customer A.

### SUMMARIZE balance-sheet conversion — one spot rate per currency

**Question:** what is the balance sheet worth in the selected reporting currency at the selected valuation date? Assume `[Balance]` returns the source-currency balance and `[Spot Rate]` returns reporting-currency units per source-currency unit for that date. The source table below contains the balances being converted.

```dax
SUMX(
    SUMMARIZE('Balance Sheet', 'Balance Sheet'[Company], 'Balance Sheet'[Currency]),
    [Balance] * [Spot Rate])
```

**Why it is functionally needed:** the rate lookup needs one source currency at a time. Convert each company/currency balance before adding the results. Adding EUR and GBP first leaves no single currency from which to look up the rate.

For example, **EUR 100 × 1.10 USD/EUR + GBP 100 × 1.25 USD/GBP = USD 235**. Combining the balances into 200 and applying one rate gives the wrong result—or the rate lookup returns blank because multiple currencies are present.

**Why it helps performance:** a million postings might reduce to 20 company/currency groups. The expression requests a balance and spot rate for each group instead of repeating the conversion for every posting. This works because all balances in a group use the same rate at the selected valuation date.

- Include every field needed to identify the applicable rate. If converting multiple valuation dates together, include valuation date in the grouping too.
- Do not apply this grouping to transaction-date conversion when postings need different historical rates.
- Grouping establishes the currency for the lookup; `[Spot Rate]` still needs to resolve that currency, the reporting currency, and the valuation date.
- The requirement is to calculate at the rate's level of detail; `SUMMARIZE` is one way to do that. Check timings and results in the actual model rather than assuming grouping is always faster.

### VALUES grouping — one field

Use `VALUES` when the calculation needs only one distinct field. For example, this lists accounts visible under the current report selections:

```dax
VALUES(Account[Account])
```

Use `SUMMARIZE` when the grouping needs combinations of fields or must start from a specific table, including an already filtered table variable.

### SUMMARIZECOLUMNS — grouped query output

Use `SUMMARIZECOLUMNS` for a standalone query returning grouped fields and existing measures, such as a balance extract by company and account:

```dax
EVALUATE
SUMMARIZECOLUMNS(Company[Company], Account[Account], "Balance", [Balance])
```

Unlike `SUMMARIZE`, it has no starting-table argument. It builds groups from the supplied model columns and, in this example, omits groups where `[Balance]` is blank. A zero balance remains.

Both functions can be used in measures on supported engines; the standalone-query guidance is our usage convention, not a function limitation. They are not interchangeable: blank-group handling and filters coming from related tables can produce different rows. Check the returned groups before replacing one with the other.

## DAX total standards

Test detail rows, subtotals, and grand totals separately. Power BI recalculates the total; it does not automatically add displayed rows.

When the business definition requires adding row results, define the grouping explicitly and iterate over it.

```dax
SUMX(VALUES(FactSales[SalesOrder]), [Sales Amount])
```

## DAX function standards

- Use `DIVIDE` instead of `/`, with an explicit `0` alternate result for a zero or blank denominator.
- Replace `EARLIER` and `EARLIEST` with a variable holding the outer-row value.
- Do not wrap arithmetic in `IFERROR`. Use `DIVIDE` or explicit tests for expected blanks.

```dax
DIVIDE([Sales Amount], [Sales Quantity], 0)
```

## Complex DAX review standards

Before adding more complex DAX, check what one source row represents, the relationships, and source transformations. When the model structure causes the complexity, move stable joins and row-level business transformations into the model or source layer.

## References (non-normative)

- [Microsoft DAX `VAR` syntax and identifier rules](https://learn.microsoft.com/en-us/dax/var-dax)
- [Microsoft: avoid using `FILTER` as a `CALCULATE` filter argument](https://learn.microsoft.com/en-us/dax/best-practices/dax-avoid-avoid-filter-as-filter-argument)
- [Microsoft `KEEPFILTERS` behavior](https://learn.microsoft.com/en-us/dax/keepfilters-function-dax)
- [Microsoft `AVERAGE` behavior](https://learn.microsoft.com/en-us/dax/average-function-dax)
- [Microsoft `SUMMARIZE`](https://learn.microsoft.com/en-us/dax/summarize-function-dax)
- [Microsoft `SUMMARIZECOLUMNS`](https://learn.microsoft.com/en-us/dax/summarizecolumns-function-dax)
- [Microsoft `ALL`](https://learn.microsoft.com/en-us/dax/all-function-dax)
- [Microsoft `ALLEXCEPT`](https://learn.microsoft.com/en-us/dax/allexcept-function-dax)
- [Microsoft `CALCULATE`](https://learn.microsoft.com/en-us/dax/calculate-function-dax)
- [Microsoft `USERELATIONSHIP`](https://learn.microsoft.com/en-us/dax/userelationship-function-dax)
- [Microsoft `DIVIDE`](https://learn.microsoft.com/en-us/dax/divide-function-dax)
- [Microsoft `VALUES`](https://learn.microsoft.com/en-us/dax/values-function-dax)
