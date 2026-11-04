---
id: source_d365_fo
title: D365 Finance and Operations Source Tables
domain: source
layer: agnostic
artifact: source_table
technology: d365_fo
status: active
---
# D365 Finance and Operations Source Tables

Applies to SQL and DAX that read Dynamics 365 Finance and Operations (F&O) tables, in Silver or straight from an export. Silver keeps F&O names and types, so these rules hold in every layer above it.

## Standards

### Column-existence standards

- Never assume a column, table or enum value from memory. Confirm it in the live catalog, the catalog snapshot, or the Silver table definition before you use it.
- Custom fields (often a client or ISV prefix) and ISV tables vary by client. Name them as such in the summary.

### Company standards

- Company-specific tables carry `dataareaid`. Join two company-specific tables on `dataareaid` first, then on the business key.
- Shared tables have no `dataareaid`: `dirpartytable`, `logisticspostaladdress`, `logisticselectronicaddress`, `ecoresproduct`, the `dimensionattribute*` tables, and the ledger tables `generaljournalentry` and `generaljournalaccountentry`. Never add a `dataareaid` predicate to them.
- Ledger entries reach a company through `generaljournalentry.ledger` = `ledger.recid`, not through `dataareaid`.
- Never aggregate a company-specific table across companies unless the task asks for it; keep `dataareaid` in the grain otherwise.

```sql
    INNER JOIN d365fo.custtable AS ct
        ON st.dataareaid  = ct.dataareaid
        AND st.custaccount = ct.accountnum
```

### Silver shape standards

- Silver is a full copy of each source table under the source's schema (`d365fo` for F&O), with lowercase source names and no history.
- Missing values: text is `''` (empty string), dates are `1900-01-01`, numbers can be NULL. Test text with `= ''`, never `IS NULL`.
- `partition`, `recversion` and `sysrowversion` are left out of Silver unless a developer added them. Never join on a column the Silver table lacks.

### RecId standards

- `recid` is the table's surrogate key. A foreign-key column that holds another table's `recid` joins to that table's `recid`, never to a name or display value.
- Common RecId foreign keys: `custtable.party` and `vendtable.party` to `dirpartytable.recid`; `defaultdimension` to `dimensionattributevalueset.recid`; `ledgerdimension` to `dimensionattributevaluecombination.recid`.
- `inventdimid` is a string key, not a RecId: join `inventdim` on `dataareaid` and `inventdimid`.

```sql
    INNER JOIN d365fo.dirpartytable AS dpt
        ON ct.party = dpt.recid
```

### Party standards

- Customer, vendor, worker and company names come from `dirpartytable.name` through the `party` key. `custtable` and `vendtable` have no name column.
- Addresses and contact details come from the party's location records (`logisticspostaladdress`, `logisticselectronicaddress`), filtered to the current validity period.

### Enum standards

- F&O stores an enum as an integer. Schema Manager keeps the integer and adds its English label as `<enum>name`: `salesstatus` and `salesstatusname`. Use the label column; never write a `CASE` that decodes an enum above Silver.
- A value added in D365 after the last Schema Manager run has a NULL label. Report it; never fill it in by hand.
- Never write an enum's integer value or label from memory. When a filter must use one, confirm it in Silver and add a `--` comment naming the enum and the value's label.

```sql
     ,st.salesstatusname AS [Sales Status]
```

### Financial dimension standards

- Dimensions are not columns on the transaction. `defaultdimension` points to a value set whose items are in `dimensionattributevaluesetitem` (`displayvalue`), each linked through `dimensionattributevalue` to its `dimensionattribute` (`name`).
- `ledgerdimension` points to `dimensionattributevaluecombination` (`displayvalue`, `mainaccount`).
- Flatten dimensions once, in a shared view or table, and reuse it. Never repeat the flattening in each Gold object.

### Date and amount standards

- `1900-01-01` is the empty date, both from F&O and from Silver's null handling. Treat it as no date; never show it as a real date.
- UTC datetime fields such as `createddatetime` and `modifieddatetime` are stored in UTC. Date fields such as `transdate` have no time zone.
- Amounts come in up to three currencies: transaction (`amountcur`), accounting (`amountmst`) and reporting (`reportingcurrencyamount`). Name the currency in every measure or column alias. Never add amounts in different currencies.

## Default positions

### Entity defaults

- BYOD exports data entities (staging tables such as `custcustomerv3staging`); Synapse Link and Fabric Link export tables. Use the names of the export the client has; never mix an entity's fields with a table's.

### DAX defaults

- Take enum labels from Silver and flatten dimensions in SQL, not in DAX.
- Keep company in the model's grain. A measure that sums across companies or currencies states that in its description.
