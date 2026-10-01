---
artifact: table
domain: sql
id: sql_silver_schema_derivation
layer: silver
status: active
technology: agnostic
title: Silver Schema Derivation
---

# Silver Schema Derivation

Schema Manager derives Silver column definitions from available Dynamics
365 and Dataverse source metadata and the deterministic rules
implemented by Schema Manager.

## Standards

### Schema derivation standards

-   Use Schema Manager-derived column definitions for supported Dynamics
    365 and Dataverse sources.
-   Do not manually redefine generated Silver column types except for
    documented exceptions.
-   Treat source metadata as the starting point for generated data
    types, lengths, precision, and scale.

### String-length exception

Source metadata does not always represent the string length required by
the actual source data. A derived `VARCHAR` length can therefore be
smaller than values encountered during ingestion and cause string or
binary data truncation failures.

When this occurs:

-   Developers MAY manually increase the affected `VARCHAR` length to
    resolve the truncation failure.
-   Limit the change to the affected column and increase the length only
    as needed to safely accommodate the source data.
-   Schema Manager MUST retain a manually increased `VARCHAR` length
    when the object is processed again.
-   Schema Manager MUST NOT overwrite the manual increase with a smaller
    source-derived length.
-   The retained length applies when Schema Manager subsequently updates
    or rebuilds the Silver table.

A manual `VARCHAR` increase is a documented exception for inaccurate
source schema derivation. It is not a general alternative to Schema
Manager-managed table definitions.

## Default positions

### Recurring derivation issues

Review the source metadata and Schema Manager derivation logic when the
same type of derivation issue occurs repeatedly. Where practical,
correct recurring issues in Schema Manager metadata, configuration,
profiling, or type-derivation logic rather than repeatedly correcting
individual tables.
