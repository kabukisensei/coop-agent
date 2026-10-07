# Cooptimize Agent — Tool Contracts

The exact, machine-readable contracts `coop` and the native tools rely on. These
are stable interfaces — `bin/coop.ps1`, `extensions/coop-tools/index.ts`, and
`.coop/project.yml` all assume them. Do **not** invent flags beyond what is
listed here.

---

## SQL / DAX standards — applied while writing, no review CLI

There is no `coop sql-review`, `coop dax-review` or `coop review` command and no
`sql_review` / `dax_review` native tool (retired in ST1; the `coop-sql-review` and
`coop-dax-review` repos are archived). Standards reach the agent as **content, not
a tool call**: at launch `lib/standards.mjs` resolves the active
`cooptimize/coop-standards` wiki articles (see
[Revision 9 standards resolution](#revision-9-standards-resolution)), and the
`coop-tools` `before_agent_start` hook feeds the relevant articles into every SQL,
DAX and semantic-model task. Before presenting such a change the agent
**self-checks** its own diff against the same articles and names any rule it could
not meet. The deterministic checks that remain are `bpa_review` (Tabular Editor
BPA, semantic models) and `fabric-cicd` validate.

---

## `coop data-doc`

Documents the SQL + Power BI estate and builds lineage.

**CLI contract:** `coop-data-doc <build|scan|check|lineage|init|setup|update|upgrade>`
plus the non-interactive agent/CI helpers `folders`, `set-folders`, `show-config`,
`config-set`, `resolve`, and `resolve-apply`.

- `scan` → writes the lineage graph **`graph.json`** (read-only over source).
- `build` → also writes **`manifest.json`** + Markdown docs + the searchable
  portal/site.
- `check` → CI staleness gate.
- `lineage <object> [--depth N]` → prints ONE object's upstream/downstream +
  relationships as **JSON**, read from the already-built `graph.json` (default
  `--depth 1`). Ambiguous names print the candidate list instead of guessing;
  no built graph → a one-line error pointing at `build`.
- `setup` → **interactive wizard**: prompts for each value, prefilled from any
  existing config, then validates and saves. Ctrl-C before the end writes nothing.
- `init` → writes a starter config to edit by hand (`--force` to overwrite).
- The agent/CI helpers (`folders`, `set-folders`, `show-config`, `config-set`,
  `resolve`, `resolve-apply`) read/patch config or list ambiguous links as JSON
  with **no prompts**, so a session can drive setup non-interactively. When run
  with no terminal (e.g. under the agent), `scan`/`build` **degrade to
  non-interactive** — building everything that resolves automatically and pointing
  the user at a terminal to map the rest — instead of crashing on the missing
  console.

**First-run setup.** `coop-data-doc` reads its own config file,
**`coop-data-doc.yml`** — which is **separate** from coop's `.coop/project.yml`. It
points the tool at the repos to crawl and the doc output. Two ways to create it:

- **In the agent (recommended):** run **`/setup-docs`**, or choose *Document my
  data* from `/start`. `extensions/coop-tools` bridges the full native
  questionnaire over strict JSONL; prompt definitions remain solely in
  `coop-data-doc`. Setup is never launched automatically. Older tool versions stop
  with upgrade guidance.
- **In a shell (the same wizard):**

```
coop data-doc setup     # full interactive wizard (layers, branding, mappings, globs)
coop data-doc init      # or: write a starter coop-data-doc.yml to edit by hand
```

Until a config exists, doc-building commands flow through and the tool reports
`No coop-data-doc.yml found in this folder or any parent` (or `Config file not
found: <path>` when `--config` / `COOP_DATA_DOC_CONFIG` names a missing file) —
and the native `data_doc` tool appends a `/setup-docs` hint when it sees either.

**How `coop` invokes it** (`bin/coop.ps1` → `Invoke-DataDoc`):

- Args are **passed through verbatim** — including the interactive `setup` wizard and
  `init` (coop preserves the terminal, so the prompts work). `coop data-doc` with no
  args defaults to **`build`**.
- After a successful `build`, `update` or `scan`, it asks `coop-data-doc
  show-config` (passing any `--config`) which config the tool used, then
  summarizes `graph.json` in that config's `output.dir`, resolved against the
  config's folder. This follows the tool's own discovery (`--config`, then
  `COOP_DATA_DOC_CONFIG`, then this folder or a parent), so a build from a
  subfolder or with a custom output dir reports the graph it wrote. Other
  subcommands and failed runs print no summary. The summary counts nodes
  (`nodes`/`objects`/`entities`), edges (`edges`/`links`/`lineage`), and docs
  (`documents`/`docs`/`pages`).

**Example:**

```
$ coop data-doc scan
coop-data-doc scan
… (tool output) …
✓ Machine-readable output: C:\work\estate\data-docs\graph.json
  214 nodes, 538 edges
```

`manifest.json` / `graph.json` are committable documentation artifacts; source
is never touched. (`tools.coop_data_doc.machine_outputs` in `.coop/project.yml`
lists `["graph.json", "manifest.json"]`.)

---

## Native LLM tools (`extensions/coop-tools`)

Registered with Pi so the model can call them directly. All advisory /
read-only. Pi sends the model a tool's `content` text only; `details` reach the UI
and the session log, never the model. So each tool renders what the model needs
(lineage names, impacted objects, catalog items, query rows, BPA findings) into
`content`, capped at 12,000 characters with a closing line that says how many
lines were left out and how to narrow the call, and keeps the full structured data
in `details`.

### Revision 9 standards resolution

Applicable SQL, DAX, and semantic-model prompts automatically run the task-time
sequence `identify domain → resolve authority → retrieve relevant sections → do
the work → validate against the same authority`. The hidden `before_agent_start`
context is bounded by relevant headings; a complete authority document is used
only when the task explicitly needs it. Unrelated prompts receive no standards
content. `/standards-status` reports the effective standard for each domain and
the independent states/revisions of formal standards, the Incremental BI
`approved_pattern`, and governed TeamAI `team_knowledge`.

Resolution precedence is project/client override, verified canonical checkout,
verified stale last-known-good, the bundled copy, then truthful
unavailable/auth-required. The resolution states are `canonical`,
`project_override`, `stale_last_known_good`, `bundled`, `auth_required` and
`unavailable`. The bundled copy is `config/standards-bundle/`: the wiki's active
articles at their wiki paths plus `bundle.json` (repository, branch, revision,
capture time, every article's sha256), written from a verified clone by
`node lib/standards-cli.mjs bundle-update <clone>` before each release and
checked by `bundle-check`. It is used only when it names the registry's own
repository and branch and every listed article is present unchanged; a domain
resolved from it carries `state=bundled`, `degraded: true` and the capture date,
the agent is told the wiki was unreachable, and `coop doctor` warns. Its
snapshot hash equals the canonical one for the same article bytes. Existing relative `standards.sql` and `standards.dax`
paths in v0.23.1 project contracts remain project-local overrides without rewriting
the contract. Project-controlled paths must resolve to regular files whose real
paths stay inside the project root; traversal, absolute POSIX/Windows paths, and
escaping symlinks are ignored in favor of the next verified authority.
`semantic_model`, `dax`, and `documentation` resolve separately; Incremental BI
is retrieved only for relevant semantic-model tasks and never becomes mandatory
authority.

At task start, resolved bytes are copied once into a read-only, content-addressed
**domain snapshot**: one file per domain, the concatenation of that domain's
articles (path order, front matter stripped) under a header that says it is not the
standard. Its SHA-256 is the domain's resolution identity (task pins, provenance);
the original authority path remains in `source_path`. The snapshot path, realpath
and hash are rechecked when it is read, and a mismatch fails closed. The agent
receives the articles themselves, not the snapshot, and its self-check binds to the
same resolution, so what it wrote against and what it checks against cannot drift
mid-task.

The canonical remote is the private `https://github.com/cooptimize/coop-standards.git`
repository. Only its configured authoritative/default `main` branch is consumed. Coop
reads it as the Obsidian wiki it is: each Markdown article with front matter and
`status: active` is a standard, mapped to a Coop domain by its `domain`/`artifact` fields
(`sql`; `powerbi` → `dax` for `dax_expression`/`measure`, else `semantic_model`; any other
domain keeps its name). `standards.yml`, `standards/*.md`, `scripts/`, and `deprecation/`
are never read. Tasks receive the relevant articles whole, each with path, SHA-256 and
revision; the domain snapshot above is built in Coop's snapshot storage from the same
articles.
Coop performs a bounded, noninteractive, fail-soft refresh at launch and before applicable
work when the last successful check is at least 15 minutes old; `coop sync` forces a
check. A verified change stages and durably validates one complete immutable generation,
then atomically switches the single active pointer and rebuilds its retrieval index.
Invalid, partial, offline, authentication-failed, or lock-timeout refreshes preserve the
prior verified generation as degraded/stale last-known-good. Refreshes use one
cross-process lock, but Monday P0 never guesses that an old or malformed lock is safe
to recover: it does not steal, rename, or delete uncertain locks. A crash-abandoned lock
requires later/manual cleanup. Canonical generations are not pruned
and readers use no leases; bounded cleanup and disk-growth management are deferred beta
limitations. Each task uses immutable content-addressed snapshots, so a task retains one
path, commit and SHA-256 even if a later refresh lands during it. Doctor and Support
report source, branch, successful check/sync times, commit, SHA-256, freshness and
degraded state per domain truthfully.

### `bpa_review` (Tabular Editor)

| Param | Type | Notes |
|-------|------|-------|
| `paths` | `string[]` (optional) | Semantic models to check. When omitted, uses `power_bi.semantic_models[].path` from the project contract. |
| `min_severity` | `"error" \| "warning" \| "info"` (optional) | Ignored by TE CLI but preserved for API compatibility. |
| `strict` | `boolean` (optional, default false) | Reserved for API compatibility; native BPA findings remain advisory. |

Native tool invocation in `extensions/coop-tools/index.ts`:
`te bpa run --model <model> --output-format json --non-interactive`.
Enable `tools.tabular_editor_cli` and set its `executable_path` to the installed
cross-platform `te` CLI. An omitted, empty, or YAML-null `bpa_rules_path` uses TE's
built-in rules (and any model-embedded rules, following TE's defaults). A configured
path adds `--rules <absolute path>`. No fix or save flags are passed.

JSON violations become structured findings with rule IDs, object names, model paths,
and severity counts. Exit 1 with findings is advisory; invalid output, execution
failures, or rule evaluation errors are reported as incomplete/failed analysis.
The text lists every finding as `- [severity] rule: message (object)`, errors
first. Raw stdout/stderr and the invoked arguments remain in `details`. Missing TE
configuration returns a setup hint. Legacy `TabularEditor.exe` keeps its
`<model> -A <rules> -V` invocation and requires an explicit rule file.

### `data_doc`

| Param | Type | Notes |
|-------|------|-------|
| `command` | `"scan" \| "build" \| "check" \| "lineage" \| "impact"` (optional) | Defaults to **`scan`** (read-only). `build` writes docs/portal; `lineage` looks up one object; `impact` lists what changed files feed. |
| `object` | `string` (optional) | **Required when `command === "lineage"`** — the object to look up (e.g. `dbo.fact_sales`, or a table/measure name). Ambiguous names return candidates. |
| `depth` | `number` (optional) | For `lineage` only: hops up/downstream to include (default 1). |
| `files` | `string[]` (optional) | For `impact`: the changed source files, relative to the session folder, absolute, or relative to a documented repo root. |
| `against` | `string` (optional) | For `impact`: a git ref (e.g. `main`) whose committed `graph.json` is the baseline. |

For `scan` / `build` / `check`, invocation is `coop-data-doc <command>` via
`pi.exec`. Result `content` notes the artifacts: always `graph.json`, plus
`manifest.json + Markdown docs + portal` when `command === "build"`, followed by the
last 25 lines of stdout. `details` → `{ tool: "coop-data-doc", command, exitCode, stderr }`.
When stdout/stderr matches `Config file not found` / `No coop-data-doc.yml`, the result
appends a hint to run `/setup-docs` (or `coop data-doc setup`) — noting the docs are
optional and you can still work without them.

For `command === "lineage"`, invocation is `coop-data-doc lineage <object> [--depth N]`.
It reads the **already-built** `graph.json` (it does not re-parse the repos), so the
agent can ground a change in an object's immediate lineage. Result `content`
opens with the counts (`N upstream, M downstream, K relationship(s)`) and the
evidence state, then the object's doc page and one line per upstream object,
downstream object and relationship (`- name (type)`). The full slice is in
`details.lineage` → the parsed JSON `{ object, schema, layer, source_file, upstream[],
downstream[], relationships[], evidence }` (each up/downstream entry carries `id`,
`name`, `type`, and `doc`, the per-object Markdown path). With coop-data-doc 1.3.2+
the slice also carries `loaded_by[]` (the Power BI tables whose partition names the
object: `{ table, source, linked }`), rendered as a "Loaded by" list; a hit with
`linked: false` is connected by name only (the SQL object is not documented or
not resolved). A view the docs do not hold at all but a model loads
(`{ object: null, undocumented_source: true, loaded_by[], downstream[] }`) is
reported as "not a documented object, but N Power BI table(s) load it by name"
instead of a failure, so the SQL side can stay outside the docs. When the contract
declares `power_bi.table_mapping` (below), every slice about a SQL object ends with
one "Declared mapping" line: `holds` when a loading table is one the rule or an
override predicts, else `does not match`, naming the table the rule expected and
none documented, the table that loads it outside the rule, or the missing prefix,
so an empty "Loaded by" is never read as "no Power BI dependents". An ambiguous `object`
lists the candidates (`{ query, ambiguous: true, matches[], loaded_by[] }` in details; re-call
with a specific name); when there's
no built graph, `content` says so and points at `build` / `/setup-docs` — you can
still proceed without it. `object` is required: a blank one returns a usage note, not
an error.

For `command === "impact"`, invocation is `coop-data-doc impact --format=json
--evidence` plus a baseline and the changed files (each `--files=<path>`, given
both as passed and relative to every documented repo root it sits in, since the
graph records source files relative to their repo root):

- With `files` and no `against`, the baseline is the **current built graph**
  (`--baseline=<output dir>/graph.json`, found the same way as the session-start
  note). The objects those files define seed the traversal, and their downstream
  comes from the graph as built, so no rebuild or committed docs are needed. A
  file the graph does not know (a new object, or a stale graph) matches nothing.
- With `against` (a git ref name), the baseline is that ref's committed
  `graph.json` (`--git=<ref>`): after `build`, every added, changed or removed
  object seeds the traversal, or only the given `files` when set.

`content` lists each changed object and every downstream object it feeds, with the
evidence state; an empty result says no documented object matched and never
claims zero impact. `details` → `{ tool, command, files, against, args, exitCode,
impact, stderr }`. The skills `coop-workflow` (step 8) and `git-helper` (the PR
description's **Lineage impact**) call it before a change is presented.

> The model can call `scan` / `build` / `check` / `lineage` / `impact`. Interactive setup is
> user-driven through **`/setup-docs`** or the `/start` menu (the full native
> wizard over JSONL), or through the same wizard in a shell with `coop data-doc setup`.

> Note: the native `data_doc` tool defaults to **`scan`** (read-only first per
> the workflow), whereas the `coop data-doc` subcommand defaults to **`build`**.

**Auto-detection (lineage grounding).** When docs already exist, one hook makes
coop consult lineage without the user asking:

- `before_agent_start` — once per folder, when **built** docs exist (the config
  coop-data-doc itself would select, then its output dir has `graph.json`), it injects an
  agent-visible, **`display: false`** note (`customType: "coop-lineage"`) telling
  coop to look up an object's up/downstream via `data_doc (command="lineage")`
  before touching it. **Silent when no built docs exist** — the docs are an aid,
  not a gate.

The same hook also grounds **simple Fabric reads**: once per contract, when the
nearest `.coop/project.yml` pins a Warehouse/Lakehouse target
(`fabric.default_workspace_id` + `fabric.default_sql_endpoint`), it injects an
agent-visible, `display: false` note (`customType: "coop-fabric-target"`) carrying
the workspace and item ids and telling coop to call `fabric-sqlendpoint` with them
directly for a one-row query, listing, or connection check — no team-knowledge,
memory, skill, or catalog detour. The approval prompt before Warehouse SQL is
unchanged. Silent when the contract has no usable target.

There is deliberately no data-doc `session_start` hook: missing or unbuilt docs
stay silent, and users opt into setup later with `/setup-docs`, `/start`, or
`coop data-doc setup`.

### `sql_impact` (live impact tracing)

Read-only live impact tracing for one SQL object (master plan section 8 item 4,
row SQ4), implemented by `lib/sql_impact.py` over the same connection path as
`fabric_sql_query` (`open_connection` in `lib/sql_query.py`: the contract's ready
dev or test `sql_targets` default, or the managed Fabric target when the contract
has no `sql_targets`; same identity pinning, driver, encryption and timeouts). The
tool accepts exactly one field, `object` (`schema.name` or `name`, `dbo` assumed,
brackets allowed, identifier characters only), and runs three fixed, parameterized
catalog queries with the name bound through `OBJECT_ID(?)`, never spliced in:

| Section | Query | Notes |
| --- | --- | --- |
| `downstream` | `sys.dm_sql_referencing_entities(?, 'OBJECT')` joined to `sys.objects` | who references the object, resolved at call time; where the target rejects that function (Fabric Warehouse), the `sys.sql_expression_dependencies` rows whose `referenced_id` is the object. Each dependent then carries `columns`, the object's columns it reads, from one bound `sys.dm_sql_referenced_entities(?, 'OBJECT')` query per dependent filtered to `referenced_minor_name` (SQ8; the first 50 dependents, the section's `column_references` says `ok`, `partial`, `unavailable` or `none`) |
| `upstream` | `sys.sql_expression_dependencies` for the object's referenced entities, joined to `sys.objects` | each item carries `resolved`; an unresolved or ambiguous one (dropped, cross-database) adds `mentioned_in_definition` from a `sys.sql_modules` `LIKE` check |
| `columns` | `INFORMATION_SCHEMA.COLUMNS` | name, type, nullability, position, so a before/after comparison knows what to count |

Each section is `{"state": "ok", "items": [...], "count", "truncated"}` or
`{"state": "unavailable", "reason": ...}` when that catalog view is missing on the
target (Synapse serverless never exposes `sys.dm_sql_referencing_entities`, so its
`downstream` section says so without asking the server), so an empty list never
means "could not look". A successful `downstream` section also carries `coverage`
(this database only, dependents whose definitions this principal can read), because
`sys.dm_sql_referencing_entities` returns partial results when `VIEW DEFINITION` is
missing on some referencing objects and never sees dynamic SQL or other databases:
an empty list means "none visible", and the tool's text says so instead of "no
dependents". Dependencies are capped at 500 per section and columns at 1000. The result also carries the executor's `target`
summary and the resolved `object` (schema, name, type); `object_not_found`,
`object_invalid` and `input_invalid` are the tool's own states, every other state is
the executor's. Driver error text, hosts and tokens never appear.

Both native SQL tools run against the contract the session started with: the
extension notes the text of `.coop/project.yml` at `session_start` (or on the first
native SQL call) and compares the file on every call. A contract edited mid-session,
by hand or by `/setup-project`, gets `contract_changed` and connects nowhere until
`/new` or a restart re-reads it, so the executor can never connect to a target the
guardrails' trusted snapshot did not authorize.

Governance (`extensions/coop-guardrails`): `sql_impact` is a metadata read, so it
runs without a prompt when the trusted contract snapshot resolves a dev or test
target (the ready `sql_targets` default, or the managed Fabric entry's environment
without `sql_targets`); a production or unresolved target asks once per call (and
is blocked headlessly); a call carrying any field beyond `object` is blocked. The
audit records a fixed label and the environment, never the object name. The tool's
text output adds a `data_doc` lineage hint when built docs exist in the folder, and
the `impact-analysis` prompt and the `coop-workflow` skill call `sql_impact` before
any live SQL edit. The text lists every item in each section (`- schema.name (type)`,
unresolved references flagged, dependents with `uses <columns>`; columns as
`- name type NULL|NOT NULL`). With a declared `power_bi.table_mapping`, an
empty downstream list also says which semantic-model table the mapping expects
to load the object, and that the catalog cannot see Power BI, so `data_doc
lineage` confirms it.

### Session lineage context (`lib/lineage-context.mjs`, `/impact`)

Master plan row SQ8: coop holds the downstream of every SQL object it is about to
change, filled once per object from the cheapest fresh source, and never re-runs a
lookup it already holds. The store is one JSON file per Pi process under the agent
dir (`lineage-context/<pid>.json`, keyed by lower-cased `schema.name`), because
`coop-tools` fills it and `coop-guardrails` reads it; `session_start` and
`session_shutdown` clear it, and files of Pi processes that are gone are pruned.

| Step | Where | What happens |
| --- | --- | --- |
| before an `edit` or `write` of a `.sql` file | `coop-tools` `tool_call` hook (it loads before the guardrails, so it runs first) | the object comes from the file's `CREATE` statement, else the snapshot layout `<schema>/<name>.sql`, else `dbo.<stem>`; the committed catalog snapshot (SQ9) is scanned for the object's columns and every definition that names it, with the columns each one mentions; when built lineage docs exist, `coop-data-doc lineage` adds the docs' downstream and the Power BI tables that load it. A source already recorded for the object is not asked again |
| the same call | `coop-guardrails` `tool_call` hook | `editGateDecision`: the edit goes through when any source holds the object, when every source that exists was tried, or when the file defines no object coop can name (a script); it is blocked, with a reason naming `sql_impact` for the object, when a live target (the contract's `sql_targets`, or a managed dev/test Fabric entry) could still answer and was never asked, including when the snapshot's answer is older than `catalog.max_age_days`. Audit kind `lineage-gate`, label the path, detail `lineage-not-held`; `read` is never gated |
| `sql_impact` and `data_doc lineage` results | `coop-tools` `tool_result` hook | recorded for the object as the `live` and `docs` sources (any `sql_impact` answer counts as asked, so an unreachable target is a miss the gate accepts, never a lookup owed forever) |
| the edit's result | `coop-tools` `tool_result` hook | one line appended: `Downstream of <object>: <dependent> (<kind>, uses <columns>); …` with the follow-on rule (a renamed or removed column breaks each one that uses it; an added column reaches them only when each is updated) and `/impact shows the detail`; with nothing found, the line says which sources were checked and that an empty result is not proof of zero impact |
| `/impact [schema.name]` | registered command, no model turn, no budget cost | the detail for one object (sources, columns, each dependent with the columns it uses) or the summary line of every object held; `/explain impact` points here |

A source's state per object is `hit`, `miss`, `stale` (the snapshot answered but is
older than the contract's age, so a live lookup is still owed) or `absent` (the
source does not exist here, or was never asked). The gate is the enforcement; the
`coop-workflow` skill's step 3 describes the same order as guidance.

### Declared layout and table mapping (`fabric.layout`, `power_bi.table_mapping`)

Master plan C2 (demo of 2026-10-05: "I don't want the tool to assume anything").
The contract states the two things coop used to assume; `lib/project-contract.mjs`
reads and writes both, and `/setup-project`, the window's Project form and
`coop init` ask for them with the Fabric / Power BI questions.

| Key | Values | Meaning |
| --- | --- | --- |
| `fabric.layout` | `warehouse`, `lakehouse`, `sql_database`, `mixed`, or blank | The Fabric item kinds that hold the client's SQL. Proposed from `fabric.default_sql_endpoint.item_type`, then the dev `sql_targets` kind. Informational today: nothing is blocked by it. |
| `power_bi.table_mapping.rule` | `same_name` (default) or `prefix` | `same_name`: a model table is named like the SQL object it loads (`dbo.vSales` or `vSales` loads `dbo.vSales`), the rule the "Loaded by" lineage uses. `prefix`: table `<name>` loads `default_schema.<view_prefix><name>`. |
| `power_bi.table_mapping.default_schema` | one SQL identifier (default `dbo`) | The schema assumed for a model table named without one. |
| `power_bi.table_mapping.view_prefix` | letters, digits, `_` (blank unless `rule: prefix`) | The prefix the model table names drop. |
| `power_bi.table_mapping.overrides` | mapping, model table name to `schema.object` | Hand-edited exceptions; they win over the rule and are never rewritten by the wizard or the form (the form shows them read-only). |

`tableMappingFromContract(text)` returns `{ declared, rule, defaultSchema,
viewPrefix, overrides, layout }`; `declared` is false without the block, and an
undeclared mapping is checked against nothing (older contracts keep today's
behavior until `/setup-project` runs once). `expectedModelTables(mapping, schema,
name)` and `expectedSqlObject(mapping, table)` are the two directions of the rule;
`mappingCheckLines` (lineage) and `mappingExpectationLine` (sql_impact) render the
texts above. The wizard writes `view_prefix: ''` for a `same_name` rule and never
touches `overrides` once it holds entries.

### `catalog_snapshot` (committed dev catalog snapshot)

The committed dev catalog snapshot (master plan row SQ9, Joel's "schema file coop
must follow" and "export of object definitions into a read-only folder" as one
feature), implemented by `lib/catalog_snapshot.py` over the same connection path
as `sql_impact` (`open_connection`: the contract's ready dev or test default,
never production; same identity pinning, driver, encryption and timeouts). The
tool accepts one optional field, `command`:

| Command | What it does |
| --- | --- |
| `status` (default) | Reads the snapshot folder only, no connection: `missing`, `ok` or `stale` with the path, the time it was taken, its age and the object counts. |
| `snapshot` | Runs three fixed, parameter-free catalog queries (`sys.objects`, `INFORMATION_SCHEMA.COLUMNS`, `sys.sql_modules`) and rewrites the folder: one `<schema>/<name>.sql` per object (tables as a `CREATE TABLE` built from their columns, types and nullability; views, procedures and functions as the definition the catalog holds), `manifest.json` (time taken, target environment, kind and database, counts, file list, anything unavailable or skipped) and a `README.md`. |

The folder is `catalog.path` from the contract (relative to the contract root),
else `<data_docs repository>/catalog/<environment>` when the contract names a
`data_docs` repository, else `.coop/catalog/<environment>` beside the contract;
`catalog.max_age_days` (default 7) decides when `status` and the session-start
note call it stale. A folder that is not a snapshot (no `manifest.json`, not
empty) is never overwritten (`output_not_snapshot`). No row data, credential,
connection string or server name is written; a snapshot of a production target is
refused (`target_not_dev_or_test`). Caps: 5000 objects, 200,000 columns, one
million characters per definition; an object whose name is not a plain identifier,
or whose definition the principal cannot read, is skipped and listed in the
manifest. On a Lakehouse SQL endpoint the definitions are unavailable and the
manifest says so; tables still land.

Governance (`extensions/coop-guardrails`): `status` runs without a prompt or an
audit row (it reads a folder); `snapshot` follows the `sql_impact` rule (a resolved
dev or test target runs without a prompt, production or an unresolved target asks
once per call and is blocked headlessly, any other field or command is blocked).
The session-start note names the snapshot's state so coop reads the object's file
before writing SQL, offers a refresh when it is stale, and offers the first
snapshot when none exists (only where the contract has a `sql_targets` section;
`coop doctor` applies the same gate). `coop catalog snapshot` and `coop catalog status` are
the terminal forms; `coop doctor` reports the state in the project-contract
section; `coop init --seed-docs` uses the folder as coop-data-doc's SQL source when
the contract has no SQL repository. The snapshot is reference, never a deployment
artifact: nothing runs from it.

---

## Microsoft Fabric CLI (`fab`) and the Python Fabric collision

`coop fabric [args]` (alias `coop fab`) is a pure pass-through in `bin/coop.ps1`:
it dies when `fab` is not on `PATH`, otherwise runs `fab` with the arguments
unchanged.

- The intended `fab` is the **Microsoft Fabric CLI** (`ms-fabric-cli`, installed
  via pipx at the manifest's pin).
- **Collision:** the Python package `fabric` ships a *different* `fab` — a Python
  SSH / Paramiko automation tool. If both are on `PATH`, `coop fabric …` may run
  the wrong one.
- **Doctor detection:** `coop doctor` checks which `fab` resolves first and warns
  when the Paramiko `fab` shadows the Microsoft Fabric CLI, so the user can fix
  `PATH` or uninstall the conflicting package.

`coop doctor` detects the collision by checking whether `fab --version` mentions
Paramiko/Invoke (the Python SSH tool) and reports it as a **hard error** (`✗`,
counted toward a non-zero exit), exactly as emitted by `scripts/doctor.ps1`:

```
$ coop fabric workspace list      # -> whichever `fab` is first on PATH
$ coop doctor
Microsoft Fabric CLI
✗ fab is the WRONG tool — this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI
      Fix: pipx install ms-fabric-cli==1.7.0   and put pipx's bin dir first on PATH (pipx ensurepath)
           or uninstall the Python fabric package. Verify with: fab --version
```

---

## `fabric-cicd` — a Python library (validate-only by default)

`fabric-cicd` is a Python **LIBRARY** (no CLI). coop installs it via
`pipx inject ms-fabric-cli fabric-cicd` so `fabric_cicd` is importable in the
Fabric CLI's environment; it's used in deployment scripts (`import fabric_cicd`),
**NOT** as a `fabric-cicd` command. `coop doctor` checks it's importable
(`python -c "import fabric_cicd"` in the Fabric CLI's env).

In `.coop/project.yml`, `tools.fabric_cicd.default_mode` is `"validate_only"`. The
agent runs validation freely; **deploy / run-deployment is approval-gated**
(`approval_policy.ask_first` includes "fabric-cicd deploy / run deployment", and
deploying to test/prod is in `never_without_explicit_instruction`).

---

## MCP read-only action policy

The MCP servers are optional; `coop` runs without them. `fabric` and
`microsoft-learn` are read-only over **client data** — `fabric` *by policy* (its MCP
has **no** server-side read-only switch), so the guardrail heuristic + Pi's tool
approval are what hold it. `powerbi-modeling-mcp` runs `--readwrite` so an approved
semantic model edit can land (#159): the guardrail reads each call's
`request.operation`, lets reads run, asks before edits (an approval can cover the
session), and asks every time for deletes, whole-model imports, deploys, unknown
operations and production. Manifest-pinned managed config is generated into coop's isolated agent dir
(`~/.coop/agent/mcp-adapter.json`) from `~/.coop/config` by `coop onboard` / `coop sync`,
and wired through `pi-mcp-adapter`. The `fabric-sqlendpoint` entry's Warehouse target
comes from the contract above the current folder, and every launch regenerates it
for the folder coop starts in (`Update-CoopManagedMcpConfig`), so the shared config
follows the last launch, not the last sync. Each launch also writes its folder's own
copy, `<agent dir>\mcp\<key>.json` (`Get-CoopFolderMcpConfigPath`: the first 12 hex
characters of the SHA-256 of the lower-cased folder path), and hands that path to Pi
(`--mcp-config`) and to coop's own readers (`COOP_MCP_CONFIG`: the guardrails'
Warehouse environment, `fabric_sql_query`'s target check, the launch token). A coop
already running on one folder is never retargeted by a later launch elsewhere,
including on its next `/new`.

Per `.coop/project.yml` and `docs/guardrails.md`:

| Server | Allowed by default | Requires explicit approval |
|--------|--------------------|----------------------------|
| `fabric` | `list`, `read`, `inspect` (read-only **by policy**) | `create`, `update`, `delete`, `deploy` |
| `fabric-sqlendpoint` | separate managed direct HTTP SQL endpoint | every `executeSQL` / `execute_query` call; DDL/DML/destructive SQL is classified before row-read handling |
| `powerbi-modeling-mcp` (`--readwrite`) | `Get`, `List`, `Export`, connect, trace | `Create`, `Update`, `Rename`, refresh (session approval allowed); `Delete`, imports, `DeployToFabric`, unknown operations and production (every time) |
| `microsoft-learn` | docs lookups (always-current) | — |

`coop` **never** calls create/update/delete/deploy/publish MCP actions without
explicit approval — regardless of what the server is capable of.

### SQL connection targets (`sql_targets:` in the project contract)

`.coop/project.yml` can name every SQL environment an engagement reaches and which
one coop works on (master plan section 8 item 1, row SQ1). `lib/sql_targets.py`
is the one reader (`doctor-lines`, `show`, `default`; `--project <yml>` or the
nearest contract), dependency-free like the rest of `lib/`:

```yaml
sql_targets:
  default_environment: dev      # dev or test; never prod
  dev:
    kind: azure_sql             # fabric_warehouse | fabric_lakehouse | fabric_sql_database | azure_sql | synapse_serverless
    server: contoso-dev.database.windows.net
    database: ContosoDW
  test:
    kind: fabric_warehouse
    workspace_id: <guid>        # Fabric kinds carry ids; coop discovers the host
    item_id: <guid>             # (fabric_lakehouse also needs sql_endpoint_id)
    database: SalesWarehouse    # the Warehouse / Lakehouse item name
  prod:
    kind: azure_sql
    server: contoso.database.windows.net
    database: ContosoDW
```

| `kind` | Host the entry must name (or discovery must return) | Connect timeout |
| --- | --- | --- |
| `fabric_warehouse`, `fabric_lakehouse` | `*.datawarehouse.fabric.microsoft.com` (discovered from `workspace_id` / `item_id`; a hand-written `server` is rejected) | 15 s |
| `fabric_sql_database` | `*.database.fabric.microsoft.com` | 15 s |
| `azure_sql` | `*.database.windows.net` (serverless compute auto-pauses, so the first connection after idle can take up to a minute) | 60 s |
| `synapse_serverless` | `*-ondemand.sql.azuresynapse.net` (views and external objects only) | 15 s |

Rules the reader enforces: the host pattern must match the kind, so a production
host cannot hide behind a dev kind and a Fabric host cannot pass as Azure SQL;
`prod` may be present but is never the default; an entry with blank values is
"unconfigured" (a doctor warning, not an error) so a wizard can leave
placeholders; credential keys (`user`, `password`, `connection_string`, ...) make
the entry invalid because coop authenticates with Entra ID tokens only. `coop doctor`
prints one Project-contract row per entry (the ready default is marked) and one
warning per rule broken. `/setup-project` proposes the dev entry's kind from the
machine's client platform (SQ7) and the Fabric answer, writes the dev entry, and
leaves `test` / `prod` to fill in; editing an existing contract touches only the
dev entry. The SQL executor and the guardrails' resolved scope read this section
in the later SQ rows; until then the managed `fabric-sqlendpoint` target below
still comes from `fabric.default_sql_endpoint`.

### Managed Warehouse SQL endpoint MCP

`coop sync` generates `fabric-sqlendpoint` as a distinct managed server; it does
not add a second SQL executor to the general `fabric` MCP. The global URL is
`https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint`. If the nearest
project contract has complete canonical UUIDs for `fabric.default_workspace_id`
and `fabric.default_sql_endpoint`, Coop uses the item URL
`https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/{workspaceId}/items/{itemId}/sqlEndpoint`.
For Lakehouse targets, `itemId` is the `sqlEndpointProperties.id`, not the
Lakehouse item ID.

The managed entry uses direct Streamable HTTP with `auth: false`, an exact COOP-owned
`requestHeadersCommand`, and a 60-second request timeout. Immediately before Pi starts,
Coop still obtains a Fabric token from the existing Azure CLI login for the session
identity guardrail. That launch token is minted for the client tenant when one is
configured: the tenant chain the launch sign-in uses (the project's
`fabric.tenant_id`, else `~/.coop/config` `azure.tenant_id`), read from the same
contract. With no tenant configured, the mint is the same unpinned az call as before.
For every MCP request, the header helper obtains a fresh token for the launch token's
tenant (its `tid`), requires its tenant and principal claims to match that launch
identity, and authorizes only the exact configured HTTPS Fabric endpoint. A different
principal or tenant fails closed; per-request tokens are pinned to the launch tenant,
so a guest whose az default account is their home tenant still gets client-tenant
tokens. Tokens are never written to argv, config, disk, or diagnostics. The helper
contract is `lib/fabric_request_headers.mjs --token <resource> [--tenant <id>]` for
coop's own mints, where `<id>` must be a GUID or a domain name with a dot, and
`lib/fabric_request_headers.mjs <endpoint URL>` for per-request headers.
The general `fabric` MCP (`@microsoft/fabric-mcp`) signs in with az's default account;
coop cannot give it a tenant, and `coop doctor` says so on its row.
Doctor is observational: `warehouse_mcp.py doctor-json` returns `state` (the
one-word verdict the row prints; `registered` means the config, and when probed
the live checks, passed), `config_state` (what the config alone proves:
`registered`, `unavailable` or `target_invalid`), `probe_state` (`not_probed`,
`ok`, or the first failing live step: `auth_required`, `token_timeout`,
`token_output_invalid`, `azure_cli_unavailable`, `token_launch_failed`,
`token_command_failed`, `target_invalid`, `tool_missing` or `unavailable`) and
`usable` (true only when the probe ran, the target validated and a compatible
SQL tool was listed). The `coop doctor` row says `usable`, `configured (not
probed)` or `probed: <state>` accordingly, and names the probe tenant only when
it is the one `Get-CoopTenant` resolves. The launch's `launch-token` frames are
validated once, by `lib/fabric_token_runner.mjs`, against `WARNING_STATES` in
`lib/warehouse_mcp.py`. Live dev/test verification remains pending on the
signed-in user, tenant, target, and Fabric permissions.

For a verified managed target, one approved session scope covers matching single
`SELECT` calls with a literal `TOP` bound, including bracketed names such as
`[Calendar Month Date]` and escaped `]]` inside identifiers. Dynamic namespace and
central-proxy calls share that grant. Identifier text cannot hide a three-part or
four-part cross-database name. Double-quoted identifiers, unfamiliar SQL, batches,
and mutations do not inherit this grant; scope expansion asks again. Rejecting an
expansion retains the earlier grant; revocation and a new session clear it.

The preferred live SQL route is that managed MCP server. Coop also registers exactly
one explicit fallback, `fabric_sql_query`, implemented by the new consolidated
`lib/sql_query.py` helper (renamed from `fabric_sql_query.py`; it also serves Azure SQL, Fabric SQL database and Synapse serverless targets declared in `sql_targets:`).
The tool accepts only `query` plus optional `maximum_rows`; target, server, identity,
and credentials come from the contract and the selected Fabric Python
(`coop_fabric_python` / `Get-CoopFabricPython`). When the contract declares
`sql_targets:` (row SQ2), the executor connects to its ready default entry: a
direct kind (`azure_sql`, `fabric_sql_database`, `synapse_serverless`) connects to
the contract's `server` with that kind's connect timeout (60 s for Azure SQL, whose
serverless tier auto-pauses; 15 s otherwise) and mints only the
`database.windows.net` token; an `azure_sql` entry with `read_scale_replicas: true`
adds `ApplicationIntent=ReadOnly`. A discovered kind (`fabric_warehouse`,
`fabric_lakehouse`) runs the same Fabric REST discovery as the managed target, from
the contract's ids. A production entry is never selected, and a contract whose
default entry is unconfigured or invalid returns `target_invalid` before any mint.
Without `sql_targets:` the executor falls back to the canonical project/managed MCP
snapshot as before. The `ok` result carries a `target` summary (`environment`,
`kind`, `database`; never the host). On a machine with no managed Warehouse server
(an Azure SQL-only install), the launch token helper mints the SQL audience for the
contract's tenant chain so the executor still has a launch identity to pin to.
It never cascades from MCP automatically. It accepts one plain literal-`TOP` `SELECT`, rejects mutations,
batches, cross-database names, and unbounded reads before authentication, and returns
capped structured JSON. Its text shows the column names, then one JSON array per
row, up to the 12,000-character cap. Endpoint discovery uses Fabric's documented item APIs:
Warehouse `GET /v1/workspaces/{workspaceId}/warehouses/{warehouseId}` reads
`properties.connectionString`; Lakehouse
`GET /v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}` uses the source Lakehouse
ID and reads `properties.sqlEndpointProperties.connectionString`. Returned item and
endpoint IDs/types are checked against the canonical target when present. Azure CLI
supplies separate in-memory Fabric REST and
`database.windows.net` tokens, both minted for the launch token's tenant (with no
launch token, nothing is minted); pyodbc uses only ODBC Driver 18 or newer, encrypted
connections, access-token attribute `1256`, bounded execution, and bounded per-value
and aggregate JSON materialization. The launcher resolves the selected interpreter in
a short subprocess and then starts that Python executable directly, so cancellation
targets the query process. SQL and tokens are
never placed in argv, config, disk, logs, or diagnostics. The exact fallback tool resolves the
same read scope as MCP (client, tenant, principal, environment, target, 60 seconds),
and a plain read runs without a prompt on any environment. With a contract
`sql_targets:` section the guardrails resolve that scope from the trusted contract
snapshot (row SQ3; `docs/guardrails-reference.md`): the default entry, or the ready
entry the call's `environment` field names (`dev`, `test` or `prod`; reads only).

### Microsoft skills catalog

Official Microsoft skills resolve from `config/microsoft-skills.json` into
immutable generations under the effective Coop/Pi agent dir
(`catalogs/microsoft`). Launch reads `current.json` only and never networks.
Refresh is exact-commit, noninteractive, bounded, staged, validated, and
fail-soft: a last-known-good generation keeps launch working when offline.
Each approved skill has a committed tree SHA-256. Every launch recomputes the
actual exported tree receipt and full generation content address, and rejects
pointer, repository, revision, path, receipt, or generation rewrites that do not
match that committed authority.
Baseline loads Microsoft KQL, Microsoft Docs, and every skill in the pinned
skills-for-fabric catalog (v0.3.18) when a contract turns Fabric skills on,
including `sqldw-cli` for Fabric Warehouse and Lakehouse SQL (its authoring,
consumption and operations guidance in one skill; the older
`sqldw-operations-cli` name no longer exists) and `sqldb-cli` for Fabric SQL
database (`fabric_sql_database` in `sql_targets:`). Neither covers Azure SQL
Database or Synapse serverless outside Fabric: for those kinds the resolved SQL
standards (fed into context at launch) and the `coop-workflow` guidance are the
authority, and no Microsoft skill is substituted (master plan section 8 item 6,
row SQ6).

### Offline data documentation evidence

`data_doc lineage` and `data_doc impact` preserve the companion's complete JSON in
tool details, including coverage, trust and source provenance. The text names the
observed links and their evidence state; zero observed neighbors never proves zero impact
outside the parsed scope. Older companion output without evidence remains unknown.
A failed scan/build and a read-only `check` do not claim newly generated artifacts.
Startup announces a graph only when `graph.json` exists and points to object pages
only when a manifest exists.

The companion selects `COOP_DATA_DOC_CONFIG` first (including a missing authoring
path), then searches the working directory and its ancestors. Coop uses the same
resolved config path, including symlinks, for output discovery and wizard path
pickers. Relative source/output paths belong to that config's parent directory.
The existing setup wizard uses UTF-8 JSONL in both directions through pipes;
portable tests exercise a non-UTF-8 Python stream, while native Windows terminal
and PowerShell 5.1 qualification remains a release acceptance requirement.
SQL sources are optional and may be partial; live discovery remains Coop SQ.
