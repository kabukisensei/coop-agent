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

- Use `SQLServer` and `SQLDB` as shared connection parameters.
- In each source query, set `SchemaName` and `TableName` for the source object. Do not create shared parameters for schema and table names.

```powerquery
let
    SchemaName = "sales",
    TableName = "Customer",
    Source = Sql.Database(SQLServer, SQLDB),
    Result = Source{[Schema = SchemaName, Item = TableName]}[Data]
in
    Result
```

### Transformation standards

Do not perform transformations in Power Query. Keep M queries limited to parameters, connections, source navigation, and the approved one-row measure-table definition below. Put data transformations in SQL.

### Fact query standards

For every fact, the Attributes query reads source rows. Its paired measure query contains one `Int64` column, `Calculation`, and one row with value `0`.

Example: `Ledger Transaction Attributes` holds the data; `Ledger Transactions` holds measures.

Table placement and visibility are defined in [Fact Tables](<Fact Tables.md>).

### Measure table query standards

Use a literal `#table` for every one-row measure table so Tabular Editor can read it. Do not use the compressed `Binary.Decompress`/JSON expression produced by **Enter Data** because it's not human readable.

```powerquery
#table(type table [Calculation = Int64.Type], {{0}})
```

### Power Query group-order standards

In the Power Query pane, organize parameters and queries into folders in this order:

1. Parameters
2. Dimensions
3. Facts — Fact Measure Hosts, then Fact Attributes
4. Calculation Tables — the `Ad Hoc Calculations` and `Multi-Fact {Model} Calculations` measure tables, not calculation groups or DAX calculated tables
5. Other Queries — supporting queries and functions outside the groups above

## Default positions

### Development refresh defaults

During local development, default to refreshing the schema without loading data by using **Refresh schema only** in Power BI Desktop or the equivalent in Tabular Editor. Load data locally when it is useful for development or testing.
