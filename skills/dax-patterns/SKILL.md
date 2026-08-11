---
name: dax-patterns
description: Consult when writing or editing DAX measures whose business logic operates at an entity grain — "for each customer…", "for each day…", "for each product…". Covers exchange-rate calculations, customers-with-balances, distinct conditional counts, semi-additive measures, weighted averages, threshold-based logic, de-duplicating transactional data, and performance optimization. Recommends the SUMX + SUMMARIZE reshape-to-grain pattern. Advisory authoring guidance only; applies under the coop-workflow skill.
---

# DAX patterns — SUMX + SUMMARIZE (reshape to the grain)

## When to use this pattern

Use it when the calculation's business logic naturally says **"for each
customer…"**, **"for each day…"**, or **"for each product…"** — i.e. the
calculation belongs at an entity grain, not at the transaction row grain and not
over the entire filter context. SUMMARIZE creates the virtual table (like a SQL
CTE or derived table), and SUMX iterates over it to produce the final result.
This writes the calculation at the correct level of grain, improving both
correctness and performance.

Reach for this pattern when any of these criteria apply:

- **Exchange rate calculations (performance)** — summarize by Date/Currency,
  calculate the exchange rate once per group, then aggregate. Avoids repeated
  lookups and can dramatically improve performance.
- **Customers with balances** — summarize to one row per customer, determine
  whether each customer has a balance, then count the qualifying customers.
  Without this pattern you'd count transactions instead of customers.
- **Distinct calculations with conditions** — count products, orders, or
  accounts meeting criteria where the condition should be evaluated once per
  entity rather than once per transaction.
- **Semi-additive measures** — calculate ending balance, latest status, or last
  inventory level per account, then sum across accounts.
- **Weighted averages** — summarize to the appropriate grain (e.g.
  Product × Month), calculate the weighted value for each group, then aggregate
  correctly.
- **Threshold-based logic** — apply rules like "customers with more than $1,000
  in sales" or "stores with at least 10 orders" by evaluating the threshold once
  per entity.
- **De-duplicating transactional data** — roll multiple fact rows into a single
  logical entity before performing downstream calculations.
- **Performance optimization** — replace expensive repeated calculations with one
  calculation per group, especially when expensive measures would otherwise be
  evaluated millions of times.

## The pattern

```
VAR Groups =
    SUMMARIZE (
        'Fact',
        'Dim'[GroupKey1],
        'Dim'[GroupKey2],
        "ComputedPerGroup", <per-group expression>
    )
VAR Result = SUMX ( Groups, <aggregate over the per-group value> )
```

Step by step:

1. **SUMMARIZE creates the virtual table** — the groups you care about, one row
   per group, with any per-group value computed once.
2. **SUMX iterates over that table** — aggregating the per-group values into the
   final result.

If you're coming from SQL, it's very similar to creating a CTE or derived table
and then aggregating over it.

## Checklist

- Does the business logic say "for each <entity>"? Then consider this pattern.
- Compute the per-entity value once per group (SUMMARIZE column), then aggregate
  with SUMX — don't recompute it per row of the underlying fact table.
- When the goal is a grouped table for display rather than per-group iteration,
  prefer `SUMMARIZECOLUMNS` (see the fetched `semantic-model-authoring` DAX
  references) — this pattern is for when you need to **iterate** over the groups
  and aggregate their values.
- Work inside the coop-workflow skill: propose the measure as a PLAN, show the
  diff after approval, and never commit DAX / model source — the user commits.

## Output

- A proposed DAX measure using this pattern where the criteria match, framed in
  the team's DAX standards terms (variable-first, explicit iterators).
- A one-line note on why the grain change is correct (count customers, not
  transactions; one rate lookup per group; threshold evaluated once per entity).
