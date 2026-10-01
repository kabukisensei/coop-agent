---
id: powerbi_semantic_model_m_query
title: Power BI M Query
domain: powerbi
layer: semantic_model
artifact: m_query
technology: power_bi
status: active
---
# M Query

## Standards

### Connection parameter standards

- Use `SQLServer` and `SQLDB` connection parameters.
- Do not use `PartialData`, the legacy development data-limiting parameter, in new models.
- Define schema and table names as local `let` steps, distinct from the shared `SQLServer` and `SQLDB` parameters.

```powerquery
let
    SchemaName = "sales",
    TableName = "Customer",
    Source = Sql.Database(SQLServer, SQLDB),
    Result = Source{[Schema = SchemaName, Item = TableName]}[Data]
in
    Result
```

### Fact query standards

For every fact, the Attributes query reads source rows. Its paired measure query contains one `Int64` column, `Calculation`, and one row with value `0`.

Example: `Ledger Transaction Attributes` holds the data; `Ledger Transactions` holds measures.

Table placement and visibility are defined in [Fact Tables](<Fact Tables.md>).

### Measure table query standards

Use a literal `#table` for every one-row measure table so Tabular Editor can read it. Do not use the compressed `Binary.Decompress`/JSON expression produced by **Enter Data**.

```powerquery
#table(type table [Calculation = Int64.Type], {{0}})
```

### Power Query group-order standards

1. Parameters
2. Dimensions
3. Facts — Fact Measure Hosts, then Fact Attributes
4. Calculation Tables — the `Ad Hoc Calculations` and `Multi-Fact {Model} Calculations` measure tables, not calculation groups or DAX calculated tables
5. Other Queries — supporting queries and functions outside the groups above

## Default positions

### Development refresh defaults

Use **Home > Refresh > Sync schema only** in Power BI Desktop when developing without loading data. Local data loads are allowed whenever useful for development or testing; they do not need to wait for deployment.

Power BI's built-in refresh options replace the need for `PartialData`, the old filter used to limit development data loads.

## Open decisions (non-normative)

- A migration process for existing `PartialData` models is not defined.
- Allowed M transformations, native queries, and query-folding requirements are not defined. Do not infer a ban on all M transformations from the simple source-navigation example.
- Power BI incremental-refresh parameters and setup are not defined here; loading recipes belong in the separate patterns knowledge base.

## References (non-normative)

- [Microsoft: Power BI refresh options](https://learn.microsoft.com/en-us/power-bi/connect-data/refresh-data)
