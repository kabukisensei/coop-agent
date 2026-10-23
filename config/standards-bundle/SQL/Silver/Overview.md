---
id: sql_silver_overview
title: Silver Tables
domain: sql
layer: silver
artifact: table
technology: agnostic
status: active
---
# Silver Tables

Silver tables reproduce source-system tables for downstream use. Keep their structure and data types close to the source; put reporting logic and dimensional modeling in Gold.

## Standards

### Source structure standards

- Keep each Silver table structurally aligned with its source table.
- Match source data types, string lengths, numeric precision and scale, and date/time precision when the target platform supports them.
- When the target does not support a source type, use the closest compatible type allowed by that platform.
- Do not change Silver types for reporting, presentation, or semantic-model convenience.

### Schema Manager standards

Schema Manager creates and maintains Silver tables for supported Dynamics 365 and Dataverse sources, including Finance and Operations, Project Operations, Customer Engagement, and custom Dataverse applications.

- Use Schema Manager to create or change these table definitions.
- Do not manually create or alter Schema Manager-managed definitions except for the two approved changes below.
- Do not use an LLM to create or alter Schema Manager-generated SQL.
- Change generated behavior through Schema Manager procedures, configuration, or metadata.

### Approved developer changes

Developers may make these two changes to a Schema Manager-managed table:

1. Increase a `VARCHAR` length when source data does not fit the generated length. Change only the affected column and use the smallest length that safely holds the source data.
2. Create, change, or remove custom indexes when the workload requires them.

Schema Manager must preserve increased `VARCHAR` lengths and custom indexes when it updates or rebuilds the table. A later run must not shrink an approved length or require a developer to recreate an index.

### Other source-system standards

Schema Manager rules do not apply to a source system it does not support. For those sources:

- Keep the Silver table as close to the source representation as the target permits.
- Use the closest compatible target type when the source type is unavailable.
- Put business transformations and dimensional modeling downstream unless ingestion itself requires a change.

## Default positions

### Recurring schema mismatch defaults

When the same schema mismatch recurs, correct the Schema Manager metadata, configuration, or type-mapping logic instead of repeatedly changing individual tables.
