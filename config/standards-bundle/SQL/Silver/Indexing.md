---
artifact: table
domain: sql
id: sql_silver_indexing
layer: silver
status: active
technology: agnostic
title: Silver Indexing
---

# Silver Indexing

Developers can add custom indexes to Schema Manager-managed Silver
tables when workload performance requires them.

## Standards

### Custom index standards

-   Developers MAY create, modify, or remove custom indexes on Silver
    tables based on query or processing requirements.
-   Treat custom indexes as developer-defined objects rather than part
    of the Schema Manager-generated table definition.
-   Schema Manager MUST retain custom indexes associated with a Silver
    table.
-   When Schema Manager rebuilds or recreates a Silver table, it MUST
    recreate the retained custom indexes.
-   Do not require developers to manually recreate retained indexes
    after a Schema Manager run.

## Default positions

### Index ownership

Schema Manager owns the generated Silver table definition and lifecycle.
Developers own decisions about additional custom indexes required for
workload performance; Schema Manager retains those indexes through
supported table updates and rebuilds.
