---
artifact: agnostic
domain: sql
id: sql_silver_schema_manager
layer: silver
status: active
technology: agnostic
title: Silver Schema Manager
---

# Silver Schema Manager

Schema Manager is the approved deterministic process for defining,
creating, updating, and maintaining Silver tables for supported Dynamics
365 and Dataverse sources.

## Standards

### Generation standards

-   Create and manage supported Dynamics 365 and Dataverse Silver tables
    through Schema Manager.
-   Treat table definitions, columns, data types, and other generated
    structures as Schema Manager-managed.
-   Do not manually create or alter Schema Manager-managed structures
    except for documented exceptions.
-   Change generated structure or behavior through the applicable Schema
    Manager procedure, configuration, metadata, or other supported
    mechanism.
-   Do not use an LLM to author or alter Schema Manager-generated Silver
    SQL.

### Regeneration standards

Schema Manager manages supported developer changes when a Silver table
is updated or rebuilt.

-   Retain manually increased `VARCHAR` lengths as defined in [Schema
    Derivation](Schema%20Derivation.md).
-   Retain and rebuild custom indexes as defined in
    [Indexing](Indexing.md).
-   Do not require developers to reapply supported retained changes
    after each Schema Manager run.

## Source documentation pending (non-normative)

Detailed transformation, naming, type-mapping, table-generation,
schema-derivation, index-retention, and object-rebuild behavior is
maintained in Schema Manager procedures, configuration, and supporting
documentation. Do not infer undocumented behavior solely from generated
SQL output.
