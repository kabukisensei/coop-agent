---
name: add-silver-columns
description: "Add source columns missing from Silver via the Schema Manager: Bronze view, regenerate, reload. Uses warehouse_manager."
---

# Add source columns to Silver (Schema Manager)

## When to use

The user names source tables and columns that exist in the source export but not yet
in Silver ("add taxgroup and bankaccount to custtable in dev"). The client's Schema
Manager (data warehouse manager) generates and loads each Silver table. Run it inside
`coop-workflow`.

Each client runs its own variant of the Schema Manager. The default flow below
(commented-out column lines in a generated Bronze view, one regenerate pipeline, one
reload pipeline) is one variant, not a rule. This client's file (`warehouse_manager`,
including `notes`) and what step 1 reads live decide the steps.

Not for: new tables, new Bronze views, type or logic changes, Gold objects or models.
Never redesign the Schema Manager (no new config tables or inclusion parameters) unless
the user asks for that.

## The project file

Read `warehouse_manager` in `.coop/project.yml` (the example contract documents every
key). It names the Bronze database and view schemas, the Silver database, the two
single-table pipelines and their parameters, parent pipelines never to run, and the
workspace or Data Factory per environment, and `notes` (how this client's variant
differs from the default flow, in the client's own words). Parameter values may hold placeholders:
`{table}`, `{bronze_database}`, `{bronze_schema}`, `{silver_database}`,
`{silver_schema}` (the Bronze view's schema when `silver.schema` is empty), `{run_id}`
(one new UUID per table) and `{lookup}` (read the value from the client's own metadata
and show where it came from). Other values pass as written.

The block is missing or has blanks: discover read-only (workspace items, pipeline
definitions, view schemas), show the user the block you would write, and edit the
contract only with their yes (or point them to `/setup-project`). Never take values
from another client, a remembered pilot or a different environment.

The client's flow differs from the default (`notes` says so, the view has no commented
column lines, the generator also loads, or a step is a notebook or procedure rather
than a pipeline): do not force the default. Describe what you found, build the plan
from this client's own steps, and offer to record them in `notes` (with the user's yes).
Unsure how a step works: ask before any write.

## Environment

Only `dev` and `test` (the user names it; otherwise `sql_targets.default_environment`).
For production, do not run anything: write the same plan as a run sheet a person
follows (view diff, both pipelines with resolved parameters, checks), and say so.

## Procedure

### 1. Read only (no approval needed)

1. For each table: find the Bronze view (`bronze.view_schemas` for its source system)
   and the matching Silver table. Read the live view definition.
2. For each column: confirm it exists in the raw source table and matches exactly one
   commented line inside the view's managed SELECT. Already included is a no-op (that
   table needs no regenerate or reload). Missing in source, or matched twice: stop for
   that table and report.
3. Read both pipeline definitions (and the notebook or procedure the regenerate pipeline
   calls). Check every contract parameter name against the definition; report a mismatch
   instead of guessing. Establish whether regeneration drops and recreates the table, how
   it keeps existing column types, and the reload's full-load filter.
4. Capture the Silver table's columns (type, length, precision, nullability), indexes,
   constraints and permissions, the Silver row count and the eligible Bronze row count.
5. `sql_impact` and `data_doc lineage` for the view and the Silver table; note
   downstream objects. Missing lineage is partial coverage, not zero impact.
6. Check run history: an in-progress run of either pipeline or a `never_run` parent is a
   stop.

### 2. One plan, one approval

Present, per table: the exact view diff, both pipeline runs with every resolved
parameter (names and ids), and the checks. State plainly what regeneration does as step
1 found it (when it drops and recreates the table, say it stays empty until the reload
succeeds), that downstream
Gold objects and models are not refreshed, and the stop triggers below. One approval
covers the listed tables only; the guardrails still ask at each write.

### 3. Per table, in order

1. Back up the view definition, the Silver structure and both pipeline definitions to
   the client's backup folder (never inside a repository). Follow `sql_source` checkout
   when SQL source control is on.
2. `ALTER` the view: uncomment only the approved lines; keep every other line,
   expression and enum block as is; add one `-- coop YYYY-MM-DD: <columns> for <user>`
   line beside them. Read the definition back and compare it with the expected diff.
3. Run the regenerate pipeline with the resolved parameters (`fab job run`, or the
   Fabric jobs API / `az rest` for Data Factory, parameters in the pipeline's own
   parameter object). Save the run id. Never resubmit a run whose acceptance is unclear;
   check the history instead.
4. Wait until the run and every activity succeeded. Then run the reload pipeline with
   the full-load parameters, and wait the same way. Honor `Retry-After`.
5. Verify: each new column exists with the generator's type; every original column kept
   its type; indexes and permissions are intact; the Silver row count matches the
   eligible Bronze count (explain any difference). A pipeline success alone is not proof.
6. Only then start the next table.

### Stop and ask (never retry or repair on your own)

- the view, pipeline or Silver table differs from what step 1 read;
- a run fails, is cancelled, or its parameters resolved to another table;
- an index, constraint or permission was lost, or a column type changed;
- row counts do not reconcile;
- the work would need a parent pipeline, another table, or a Gold or model refresh.

A failed reload can leave the Silver table empty: say so first in the report.

### 4. Close out

Summarize per table (columns added, run ids, checks), run `data_doc impact`, list the
downstream objects the user may want to refresh, and append the daily log. Never commit
source. Never save tokens, connection strings or URL query strings.
