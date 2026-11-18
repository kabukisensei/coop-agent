---
id: source_d365_project_operations_joins
title: D365 Project Operations Table Joins
domain: source
layer: agnostic
artifact: join_map
technology: d365_dataverse
status: active
---
# D365 Project Operations Table Joins

Applies to SQL that joins standard Dynamics 365 Project Operations tables in Dataverse. It lists the usual lookup for each pair in the standard Microsoft schema.

## Standards

### Use standards

- Start from this map; never invent a join from a column name. Confirm every column in the live catalog or the Silver table before you use it.
- A lookup column holds the target row's GUID and joins to the target's `<table>id`. When the export has `TargetMetadata`, confirm the target there (see D365 Exports).
- A pair that is not listed is not known. Look it up in `TargetMetadata`, or say so and ask.

### Project joins

| From | To |
|---|---|
| `msdyn_projecttask.msdyn_project` | `msdyn_project.msdyn_projectid` |
| `msdyn_projecttask.msdyn_parenttask` | `msdyn_projecttask.msdyn_projecttaskid` |
| `msdyn_project.msdyn_customer` | `account.accountid` |
| `msdyn_project.msdyn_projectmanager` | `systemuser.systemuserid` |
| `msdyn_project.msdyn_contractorganizationalunit` | `msdyn_organizationalunit.msdyn_organizationalunitid` |

### Resource joins

| From | To |
|---|---|
| `msdyn_projectteam.msdyn_project` | `msdyn_project.msdyn_projectid` |
| `msdyn_projectteam.msdyn_bookableresourceid` | `bookableresource.bookableresourceid` |
| `msdyn_resourceassignment.msdyn_projectid` | `msdyn_project.msdyn_projectid` |
| `msdyn_resourceassignment.msdyn_taskid` | `msdyn_projecttask.msdyn_projecttaskid` |
| `msdyn_resourceassignment.msdyn_bookableresourceid` | `bookableresource.bookableresourceid` |
| `bookableresource.userid` | `systemuser.systemuserid` |

### Time, expense and actual joins

| From | To |
|---|---|
| `msdyn_timeentry.msdyn_project`, `msdyn_expense.msdyn_project`, `msdyn_actual.msdyn_project` | `msdyn_project.msdyn_projectid` |
| `msdyn_timeentry.msdyn_projecttask`, `msdyn_actual.msdyn_task` | `msdyn_projecttask.msdyn_projecttaskid` |
| `msdyn_timeentry.msdyn_bookableresource`, `msdyn_actual.msdyn_bookableresource` | `bookableresource.bookableresourceid` |
| `msdyn_expense.msdyn_expensecategory` | `msdyn_expensecategory.msdyn_expensecategoryid` |
| `msdyn_actual.msdyn_transactioncategory` | `msdyn_transactioncategory.msdyn_transactioncategoryid` |
| `msdyn_actual.msdyn_resourcecategory` | `bookableresourcecategory.bookableresourcecategoryid` |
| `msdyn_actual.msdyn_accountcustomer` | `account.accountid` |
| `transactioncurrencyid` on any table | `transactioncurrency.transactioncurrencyid` |

- The task and resource lookups are named differently on each table (`msdyn_projecttask` and `msdyn_task`; `msdyn_bookableresource` and `msdyn_bookableresourceid`). Check the name on the table you read.
- `msdyn_actual` holds cost and sales rows together. Split them with `msdyn_transactiontypecode` and `msdyn_transactionclassification`; never sum the table without both.
- `msdyn_timeentry.msdyn_duration` is in minutes.

### Contract joins

| From | To |
|---|---|
| Project contract | `salesorder`; its lines are `salesorderdetail` |
| `salesorderdetail.salesorderid` | `salesorder.salesorderid` |
| `salesorderdetail.msdyn_project` | `msdyn_project.msdyn_projectid` |
| `msdyn_actual.msdyn_salescontract` | `salesorder.salesorderid` |
| `msdyn_actual.msdyn_salescontractline` | `salesorderdetail.salesorderdetailid` |
