---
id: source_d365_dataverse
title: D365 Dataverse Source Tables
domain: source
layer: agnostic
artifact: source_table
technology: d365_dataverse
status: active
---
# D365 Dataverse Source Tables

Applies to SQL and DAX that read Dataverse tables: Dynamics 365 Customer Engagement (Sales, Customer Service), Project Operations and custom Dataverse apps.

## Standards

### Column-existence standards

- Never assume a table, column or choice value from memory. Confirm it in the live catalog, the catalog snapshot, or the Silver table definition.
- Custom tables and columns carry a publisher prefix and vary by client. Name them as such in the summary.

### Silver shape standards

- Silver is a full copy of each source table under the source's schema (`d365po` for Dataverse), with lowercase source names and no history.
- Missing values: text and lookup GUIDs are `''` (empty string), dates are `1900-01-01`, numbers can be NULL. Test text and GUIDs with `= ''`, never `IS NULL`.

### Key standards

- Each table's primary key is a GUID column named `<table>id`, such as `accountid`.
- A lookup column holds the target row's GUID. Join it to the target's primary key.
- A polymorphic lookup (customer, owner, regarding) can point to more than one table. Join it only together with its target-type column, checked in the export.

```sql
    LEFT JOIN d365po.account AS acc
        ON opp.parentaccountid = acc.accountid
```

### Choice standards

- `statecode`, `statuscode`, choice (option set) and Yes/No columns store integers. Schema Manager keeps the integer and adds its English label as `<column>name`: `statecodename`, `statuscodename`, `<choice>name`. Use the label column; never decode a choice above Silver.
- Dataverse's own lookup-name columns (ending `name` or `yominame`) pass through unchanged. Check which one a `...name` column is before you use it.
- A value added after the last Schema Manager run has a NULL label. Report it; never fill it in by hand.
- Never write a choice's value or label from memory. When a filter must use one, confirm it in Silver and add a `--` comment naming the column and the value's label.
- A multi-select choice stores several values in one column. Split it before you filter on it.

### Active-row standards

- `statecode` separates active from inactive rows. Filter it only when the task asks for active rows; never by default.

### Date standards

- Date and time columns such as `createdon` and `modifiedon` are UTC. A date-only column has no time zone. Convert to local time only for presentation.

### Project Operations standards

- Project Operations keeps project, task, time, expense and actual rows in Dataverse (`msdyn_project`, `msdyn_projecttask`, `msdyn_timeentry`, `msdyn_expense`, `msdyn_actual`). With F&O integration, posted cost and revenue also land in F&O project transaction tables.
- Choose one side as the system of record for each measure. Never union Dataverse actuals with F&O project transactions.

## Default positions

### DAX defaults

- Take choice and state labels from Silver, not from DAX.
- Label Yes/No columns with words, not 1 and 0.

## Open decisions (not standards)

- For Project Operations with F&O, which side is the system of record for cost, revenue and hours.
