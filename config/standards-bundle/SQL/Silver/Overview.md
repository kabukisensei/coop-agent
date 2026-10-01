---
artifact: agnostic
domain: sql
id: sql_silver_overview
layer: silver
status: active
technology: agnostic
title: Silver Layer
---

# Silver Layer

Silver preserves source-system structure and data types as closely as
the target platform allows. Dynamics 365 and Dataverse sources use
Schema Manager for deterministic Silver generation.

## Standards

### Silver schema standards

-   Keep Silver tables structurally aligned with their source tables.
-   Match source column data types as closely as the target platform
    supports.
-   Preserve source string lengths, numeric precision and scale, and
    date/time precision where supported.
-   When the target platform does not support the source type, use the
    closest compatible target type.
-   Do not change a Silver data type solely for downstream reporting,
    presentation, or semantic-model convenience.
-   Apply target-technology type restrictions where required by the
    platform.

### Dynamics 365 and Dataverse standards

These standards apply to data sourced from:

-   Dynamics 365 Finance & Operations (F&O).
-   Dynamics 365 Project Operations.
-   Dynamics 365 Customer Engagement (CE).
-   Custom Dataverse applications and tables.

They apply when these sources are replicated into Azure Data Lake or
Microsoft OneLake for Azure- and Fabric-based implementations,
respectively.

-   Manage these Silver tables through the approved Schema Manager
    process.
-   Treat the generated table definition and lifecycle as owned by
    Schema Manager.
-   Do not manually alter Schema Manager-managed structures except for
    documented exceptions.
-   Do not use an LLM to author or alter generated Silver SQL.
-   Change generated behavior through Schema Manager procedures,
    configuration, metadata, or other supported mechanisms.

See [Schema Manager](Schema%20Manager.md) for generation and lifecycle
standards.

### Other source systems

Schema Manager requirements do not apply to source systems that have not
been incorporated into Schema Manager.

-   Match Silver columns to the source table data types as closely as
    the target platform supports.
-   Keep the Silver table as close to the source representation as
    practical.
-   Use the closest compatible target type when the source type is not
    supported.
-   Perform business-oriented transformations and dimensional modeling
    downstream unless the Silver ingestion process requires otherwise.

## Documented exceptions

-   See [Schema Derivation](Schema%20Derivation.md) for source metadata
    and `VARCHAR` length exceptions.
-   See [Indexing](Indexing.md) for developer-managed Silver indexes.
