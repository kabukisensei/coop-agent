# Cooptimize Agent — Tool Contracts

The exact, machine-readable contracts `coop` and the native tools rely on. These
are stable interfaces — `bin/coop`, `extensions/coop-tools/index.ts`, and
`.coop/project.yml` all assume them. Do **not** invent flags beyond what is
listed here.

---

## `coop sql-review` / `coop dax-review`

Both wrap the standalone advisory linters. They are **advisory only** — they
never edit files and never block.

**CLI contract (the tool binaries):**

```
coop-sql-review check <paths...> --format json [--min-severity error|warning|info] [--strict]
coop-dax-review check <paths...> --format json [--min-severity error|warning|info] [--strict]
```

**How `coop` invokes them** (`bin/coop` → `run_tool`):

The CLI wrappers **flow straight through** — `coop sql-review <args>` runs
`coop-sql-review <args>` verbatim (`exec`), and likewise for dax. Every subcommand
works and the exit code propagates:

```
coop sql-review check sql/gold --format text     # human-readable report
coop sql-review check sql/gold --format json     # raw JSON
coop sql-review rules                            # list the rules
coop sql-review upgrade                          # update the tool
coop sql-review check sql/                        # directory -> interactive subfolder picker (TTY)
```

There is **no capture and no summary** in the CLI path (so the tools' own
interactive prompts work). The tools have **no setup wizard** — they ship bundled
standards, configurable per run with `--standards` / `--config`.

**For the AI agent**, structured JSON comes from the native `sql_review` / `dax_review`
tools in `extensions/coop-tools/index.ts`, which run `check … --format json` and
return the parsed report in the tool result's `details`. Report shape:

```json
{ "findings": [ { "severity": "error", "rule": "TSQL-NO-SELECT-STAR",
                  "message": "Avoid SELECT * in gold layer views.",
                  "file": "sql/gold/v_sales.sql", "line": 12 } ] }
```

The native tool counts the `severity` field (`error` / `warning` / `info`) for its
one-line summary and passes the full report through in `details`.

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
appends a `/setup-docs` hint when it sees that. The review tools (`sql_review` /
`dax_review`) have **no** wizard — they use bundled standards, configurable per-run
with `--standards` / `--config`.

**How `coop` invokes it** (`bin/coop` → `run_data_doc`):

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
verified stale last-known-good, SQL/DAX reviewer bundled fallback, then truthful
unavailable/auth-required. Existing relative `standards.sql` and `standards.dax`
paths in v0.23.1 project contracts remain project-local overrides without rewriting
the contract. Project-controlled paths must resolve to regular files whose real
paths stay inside the project root; traversal, absolute POSIX/Windows paths, and
escaping symlinks are ignored in favor of the next verified authority.
`semantic_model`, `dax`, and `documentation` resolve separately; Incremental BI
is retrieved only for relevant semantic-model tasks and never becomes mandatory
authority.

At task start, resolved bytes are copied once into a read-only, content-addressed
snapshot. The context reads that snapshot and the SQL/DAX reviewer receives the
same snapshot through `--standards`; the original authority path remains in
`source_path` for provenance. Reviewer-returned path/hash provenance is mandatory,
and the snapshot path, realpath, and hash are rechecked before output is accepted.
The reviewer report remains unchanged: any reviewer-owned revision claim is retained
as a claim, while COOP records the trusted resolver's revision separately in a
wrapper-owned `standardsBinding` after path/hash verification. A mismatch fails
closed. Aggregate review writes into per-run files and atomically promotes only
accepted reports; rejected output is quarantined away from canonical configured
review paths and cannot enter docs, suite summaries, comparison baselines, or HTML.
Bundled fallback is discovered through the installed reviewer's own JSON provenance;
legacy top-level-version and explicit standards-revision envelopes use the same
path/hash compatibility rule as actual review and are snapshotted the same way, so
its real, bounded guidance is available before work rather than only after review.
Pinned reviewer source references used to verify this contract are
`/tmp/std-ref-sql` at `cd9bf347548375801df0abf86b13f72781e1d360` and
`/tmp/std-ref-dax` at `fe39270168c08a6360c99aadcb51a9ad73678a65`.

The canonical remote is the private `https://github.com/cooptimize/coop-standards.git`
repository. Only its configured authoritative/default `main` branch is consumed. Coop
performs a bounded, noninteractive, fail-soft refresh at launch and before applicable
work when the last successful check is at least 15 minutes old; `coop sync` forces a
check. A verified change stages and durably validates one complete immutable generation,
then atomically switches the single active pointer and rebuilds its retrieval index.
Invalid, partial, offline, authentication-failed, or lock-timeout refreshes preserve the
prior verified generation as degraded/stale last-known-good. Refreshes use one
cross-process lock, but Monday P0 never guesses that an old or malformed lock is safe
to recover: it does not steal, rename, or delete uncertain locks. A crash-abandoned lock
requires later/manual cleanup. Canonical and accepted-review generations are not pruned
and readers use no leases; bounded cleanup and disk-growth management are deferred beta
limitations. Each task uses immutable content-addressed snapshots, so generation and
SQL/DAX review retain one path, commit and SHA-256 even if a later refresh lands during
that task. Accepted SQL+DAX review generations also retain captured report bytes,
COOP-owned bindings, and independently revalidated authority provenance behind one
atomic pointer. Doctor and Support report source, branch, successful check/sync times,
commit, SHA-256, freshness, degraded state and per-domain fallback truthfully.

### `sql_review` / `dax_review`

| Param | Type | Notes |
|-------|------|-------|
| `paths` | `string[]` (optional) | Files/dirs to check. When omitted, the nearest `.coop/project.yml`'s `repositories.*.local_path` entries scope the review (TODO placeholders and paths missing on this machine are skipped with a note); only with no usable contract does it fall back to `["."]`. Explicit paths always win. The scope used is surfaced in the result (`details.scope` + a `Scope:` line). |
| `min_severity` | `"error" \| "warning" \| "info"` (optional) | Maps to `--min-severity`. |
| `strict` | `boolean` (optional, default false) | Maps to `--strict` (CI gate). |

Invocation (built in `runReview`):
`<bin> check <paths…> --format json [--min-severity <s>] [--strict]`, run with
`pi.exec(bin, args, { cwd: ctx.cwd, signal })`.

Result:

- `content[0].text` — e.g.
  `coop-sql-review: 3 finding(s) — 1 error, 2 warning, 0 info (exit 0). Full structured report is in this tool result's details.`
  (the advisory default exits `0` even with findings; `--strict` exits `2` when errors are present)
- `details` — `{ tool, args, exitCode, report: <parsed JSON or raw stdout>, stderr }`.
- If the binary is missing or JSON won't parse, it reports the problem in
  `content` (not a conversation error) and still returns `details`.

### `bpa_review` (Tabular Editor)

| Param | Type | Notes |
|-------|------|-------|
| `paths` | `string[]` (optional) | Semantic models to check. When omitted, uses `power_bi.semantic_models[].path` from the project contract. |
| `min_severity` | `"error" \| "warning" \| "info"` (optional) | Ignored by TE CLI but preserved for API compatibility. |
| `strict` | `boolean` (optional, default false) | If true, non-zero TE exit codes trigger CI failures. |

Invocation (built in `index.ts` and `coop review`):
`te bpa run <model> -r <bpa_rules_path> --non-interactive` (the cross-platform Tabular Editor CLI; `te auth login` once during the preview). Output is parsed into JSON findings. Advisory only. Degrades gracefully: if TE is not configured, it's a hint, never a failure.

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

There is deliberately no data-doc `session_start` hook: missing or unbuilt docs
stay silent, and users opt into setup later with `/setup-docs`, `/start`, or
`coop data-doc setup`.

---

## Microsoft Fabric CLI (`fab`) and the Homebrew collision

`coop fabric [args]` (alias `coop fab`) is a pure pass-through:
`have fab || die; exec fab "$@"`.

- The intended `fab` is the **Microsoft Fabric CLI** (`ms-fabric-cli`, installed
  via pipx).
- **Collision:** a Homebrew formula named `fabric` ships a *different* `fab`
  binary — a Python SSH / Paramiko automation tool. If both are on `PATH`,
  `coop fabric …` may run the wrong one.
- **Doctor detection:** `coop doctor` checks which `fab` resolves first and warns
  when the Homebrew/Paramiko `fab` shadows the Microsoft Fabric CLI, so the user
  can fix `PATH` or uninstall the conflicting formula.

`coop doctor` detects the collision by checking whether `fab --version` mentions
Paramiko/Invoke (the Python SSH tool) and reports it as a **hard error** (`✗`,
counted toward a non-zero exit), exactly as emitted by `scripts/doctor.sh`:

```
$ coop fabric workspace list      # -> whichever `fab` is first on PATH
$ coop doctor
Microsoft Fabric CLI
✗ fab is the WRONG tool — this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI
      Fix: pipx install ms-fabric-cli   and ensure ~/.local/bin precedes Homebrew on PATH
           (or: brew uninstall fabric). Verify with: fab --version
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

The MCP servers are optional; `coop` runs without them. `fabric`, `powerbi --readonly`,
and `microsoft-learn` are read-only over **client data** — `fabric` is read-only *by
policy* (its MCP has **no** server-side read-only switch, unlike `powerbi`'s `--readonly`),
so the guardrail heuristic + Pi's tool approval are what hold it. `context-mode` is **not**
a pure read: it runs **sandboxed code over the docs/graph** (not client data) to save
context. Manifest-pinned managed config is generated into coop's isolated agent dir
(`~/.coop/agent/mcp.json`) from `~/.coop/config` by `coop onboard` / `coop sync`,
and wired through `pi-mcp-adapter`.

Per `.coop/project.yml` and `docs/guardrails.md`:

| Server | Allowed by default | Requires explicit approval |
|--------|--------------------|----------------------------|
| `fabric` | `list`, `read`, `inspect` (read-only **by policy**) | `create`, `update`, `delete`, `deploy` |
| `fabric-sqlendpoint` | separate managed direct HTTP SQL endpoint | every `executeSQL` / `execute_query` call; DDL/DML/destructive SQL is classified before row-read handling |
| `powerbi` (`--readonly`) | `list`, `read`, `inspect` | `create`, `update`, `delete`, `publish` |
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

The managed entry uses direct Streamable HTTP with `auth: bearer` and
`bearerTokenEnv: COOP_FABRIC_MCP_TOKEN`. Immediately before Pi starts, Coop obtains
a Fabric token from the existing Azure CLI login and sets it only in that child
environment. Coop does not write bearer tokens, token helper commands, token config,
or token argv. Relaunch Coop to reconnect after the launch-time token expires.
Doctor treats config registration as only one state; live tools-list discovery
can still report `auth_required`, `unavailable`, `tool_missing`, or
`target_invalid`. Live dev/test verification remains pending on the signed-in
user, tenant, target, and Fabric permissions.

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
`database.windows.net` tokens; pyodbc uses only ODBC Driver 18 or newer, encrypted
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
