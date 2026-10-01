---
id: powerbi_semantic_model_fact_tables
title: Power BI Fact Tables
domain: powerbi
layer: semantic_model
artifact: fact_table
technology: power_bi
status: active
---
# Fact Measure and Attribute Tables

## Fact table structure standards

- Every fact uses a source-backed Attributes table and a paired one-row measure table named for the fact, even when no report-facing attributes are currently needed.
- Keep fields in Attributes and measures in the measure table.
- Create the pair from the start so adding attributes later does not require restructuring the model.

| Table | Contents |
|---|---|
| Ledger Transaction Attributes | Source rows and fields |
| Ledger Transactions | One-row table holding measures |

## Calculation table standards

- Put measures associated with one fact in its measure table.
- Every semantic model includes an `Ad Hoc Calculations` measure table with no measures defined in the semantic model. Its technical `Calculation` column and one-row structure remain.
- Use `Ad Hoc Calculations` for measures that exist only in a connected report: report-specific measures such as dynamic titles, tests, and proofs of concept.
- If a measure is generally useful, define it in the semantic model's appropriate fact measure table or multi-fact calculation table instead.
- Put measures spanning facts that do not belong to a single fact's measure table in `Multi-Fact {Model} Calculations`, such as `Multi-Fact Finance Calculations`. The model name distinguishes these tables when models are combined.
- After creating the first measure in a measure table, hide its technical `Calculation` field.

## Fact display-folder standards

Use these folders when the fields exist:

| Folder | Visibility |
|---|---|
| Attributes | Report-facing fields |
| Keys | All fields hidden |
| Numbers | All fields hidden |

## Open decisions (non-normative)

- A universal singular/plural naming rule is not defined; `Ledger Transaction Attributes` and `Ledger Transactions` are the approved example.
- Whether one-row measure tables must remain disconnected is not explicitly defined. Do not infer a relationship requirement from the phrase "one-row table."
