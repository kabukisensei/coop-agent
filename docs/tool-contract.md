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
`error: Config file not found: coop-data-doc.yml` — and the native `data_doc` tool
appends a `/setup-docs` hint when it sees that.

**How `coop` invokes it** (`bin/coop.ps1` → `Invoke-DataDoc`):

- Args are **passed through verbatim** — including the interactive `setup` wizard and
  `init` (coop preserves the terminal, so the prompts work). `coop data-doc` with no
  args defaults to **`build`**.
- After running, it looks for machine-readable artifacts in this order and
  summarizes the first found:
  `data-docs/manifest.json`, `data-docs/graph.json`, `manifest.json`,
  `graph.json`, `docs/manifest.json`, `docs/graph.json`, `site/manifest.json`,
  `data-docs-site/manifest.json`. The summary counts nodes
  (`nodes`/`objects`/`entities`), edges (`edges`/`links`/`lineage`), and docs
  (`documents`/`docs`/`pages`).

**Example:**

```
$ coop data-doc scan
coop-data-doc scan
… (tool output) …
✓ Machine-readable output: graph.json
  214 nodes, 538 edges
```

`manifest.json` / `graph.json` are committable documentation artifacts; source
is never touched. (`tools.coop_data_doc.machine_outputs` in `.coop/project.yml`
lists `["graph.json", "manifest.json"]`.)

---

## Native LLM tools (`extensions/coop-tools`)

Registered with Pi so the model can call them directly. All advisory /
read-only. Each returns a short text summary in `content` and the full structured
data in `details`.

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
Raw stdout/stderr and the invoked arguments remain in `details`. Missing TE
configuration returns a setup hint. Legacy `TabularEditor.exe` keeps its
`<model> -A <rules> -V` invocation and requires an explicit rule file.

### `data_doc`

| Param | Type | Notes |
|-------|------|-------|
| `command` | `"scan" \| "build" \| "check" \| "lineage"` (optional) | Defaults to **`scan`** (read-only). `build` writes docs/portal; `lineage` looks up one object. |
| `object` | `string` (optional) | **Required when `command === "lineage"`** — the object to look up (e.g. `dbo.fact_sales`, or a table/measure name). Ambiguous names return candidates. |
| `depth` | `number` (optional) | For `lineage` only: hops up/downstream to include (default 1). |

For `scan` / `build` / `check`, invocation is `coop-data-doc <command>` via
`pi.exec`. Result `content` notes the artifacts: always `graph.json`, plus
`manifest.json + Markdown docs + portal` when `command === "build"`, followed by the
last 25 lines of stdout. `details` → `{ tool: "coop-data-doc", command, exitCode, stderr }`.
When stdout/stderr matches `Config file not found` / `No coop-data-doc.yml`, the result
appends a hint to run `/setup-docs` (or `coop data-doc setup`) — noting the docs are
optional and you can still work without them.

For `command === "lineage"`, invocation is `coop-data-doc lineage <object> [--depth N]`.
It reads the **already-built** `graph.json` (it does not re-parse the repos), so the
agent can ground a change in an object's immediate lineage. Result `content` is a
one-liner (`N upstream, M downstream, K relationship(s)`); the full slice is in
`details.lineage` → the parsed JSON `{ object, schema, layer, source_file, upstream[],
downstream[], relationships[] }` (each up/downstream entry carries `id`, `name`,
`type`, and `doc`, the per-object Markdown path). An ambiguous `object` returns
`{ query, ambiguous: true, matches[] }` (re-call with a specific name); when there's
no built graph, `content` says so and points at `build` / `/setup-docs` — you can
still proceed without it. `object` is required: a blank one returns a usage note, not
an error.

> The model can call `scan` / `build` / `check` / `lineage`. Interactive setup is
> user-driven through **`/setup-docs`** or the `/start` menu (the full native
> wizard over JSONL), or through the same wizard in a shell with `coop data-doc setup`.

> Note: the native `data_doc` tool defaults to **`scan`** (read-only first per
> the workflow), whereas the `coop data-doc` subcommand defaults to **`build`**.

**Auto-detection (lineage grounding).** When docs already exist, one hook makes
coop consult lineage without the user asking:

- `before_agent_start` — once per folder, when **built** docs exist (the config's
  markdown output dir has `manifest.json` or `index.md`), it injects an
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
operations and production. `context-mode` is **not**
a pure read: it runs **sandboxed code over the docs/graph** (not client data) to save
context. Manifest-pinned managed config is generated into coop's isolated agent dir
(`~/.coop/agent/mcp-adapter.json`) from `~/.coop/config` by `coop onboard` / `coop sync`,
and wired through `pi-mcp-adapter`.

Per `.coop/project.yml` and `docs/guardrails.md`:

| Server | Allowed by default | Requires explicit approval |
|--------|--------------------|----------------------------|
| `fabric` | `list`, `read`, `inspect` (read-only **by policy**) | `create`, `update`, `delete`, `deploy` |
| `fabric-sqlendpoint` | separate managed direct HTTP SQL endpoint | every `executeSQL` / `execute_query` call; DDL/DML/destructive SQL is classified before row-read handling |
| `powerbi-modeling-mcp` (`--readwrite`) | `Get`, `List`, `Export`, connect, trace | `Create`, `Update`, `Rename`, refresh (session approval allowed); `Delete`, imports, `DeployToFabric`, unknown operations and production (every time) |
| `microsoft-learn` | docs lookups (always-current) | — |
| `context-mode` | intent search + **sandboxed exec** over docs/graph | — |

`coop` **never** calls create/update/delete/deploy/publish MCP actions without
explicit approval — regardless of what the server is capable of.

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
`lib/fabric_sql_query.py` helper (no historical standalone runner was recovered).
The tool accepts only `query` plus optional `maximum_rows`; target, server, identity,
and credentials come from the canonical project/managed MCP snapshot and selected
Fabric Python (`coop_fabric_python` / `Get-CoopFabricPython`). It never cascades from
MCP automatically. It accepts one plain literal-`TOP` `SELECT`, rejects mutations,
batches, cross-database names, and unbounded reads before authentication, and returns
capped structured JSON. Endpoint discovery uses Fabric's documented item APIs:
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
never placed in argv, config, disk, logs, or diagnostics. The exact fallback tool may
reuse the same in-memory session grant as MCP only when its canonical
client/tenant/principal/environment/target/read/row/60-second scope matches.

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
Baseline loads Microsoft KQL, Microsoft Docs, and Fabric SQL DW authoring and
consumption skills only; `sqldw-operations-cli` is recorded as deferred.

### Offline data documentation evidence

`data_doc lineage` preserves the companion's complete JSON slice in tool details,
including coverage, trust and source provenance. The text summary describes observed
links and their evidence state; zero observed neighbors never proves zero impact
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
