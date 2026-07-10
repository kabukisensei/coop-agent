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

- **In the agent (recommended):** run **`/setup-docs`**, or accept the offer coop
  makes on launch when the folder has no `coop-data-doc.yml`. A native-dialog quick
  wizard (in `extensions/coop-tools`) collects the essentials — project name, SQL +
  Power BI repo paths, output folders — then writes/patches `coop-data-doc.yml` and
  offers to build. A re-run patches **only those fields, in place**, preserving
  anything set by the full wizard (layers, branding, mappings, globs, dialect).
  "Don't ask again" drops a `.coop-data-doc.skip` marker so the launch offer won't
  re-ask. (It lives in coop-tools because Pi runs tool subprocesses
  non-interactively — no TTY — so the tool's own questionary wizard can't be driven
  from inside a session.)
- **In a shell (full wizard):**

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

> The model can call `scan` / `build` / `check` / `lineage` — **`setup` and `init`
> are not exposed to the LLM** (a wizard can't be driven through a captured subprocess).
> Interactive setup is user-driven: the **`/setup-docs`** command + launch offer
> (native dialogs, also in `extensions/coop-tools`), or `coop data-doc setup` in a
> shell for the full wizard.

> Note: the native `data_doc` tool defaults to **`scan`** (read-only first per
> the workflow), whereas the `coop data-doc` subcommand defaults to **`build`**.

**Auto-detection (lineage grounding).** Two hooks make coop consult lineage
without the user asking:

- `before_agent_start` — once per folder, when **built** docs exist (the config's
  markdown output dir has `manifest.json` or `index.md`), it injects an
  agent-visible, **`display: false`** note (`customType: "coop-lineage"`) telling
  coop to look up an object's up/downstream via `data_doc (command="lineage")`
  before touching it. **Silent when no built docs exist** — the docs are an aid,
  not a gate.
- `session_start` — when the folder has **no** `coop-data-doc.yml` (and no
  `.coop-data-doc.skip` marker), it offers `/setup-docs`; when a config exists but
  isn't built, it offers to build. Esc/"Not now" never suppresses; only an explicit
  "Don't ask again" writes the skip marker.

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
context. Config lives in `config/mcp.example.json` (pinned versions), placed non-
destructively into coop's isolated agent dir (`~/.coop/agent/mcp.json`) by `coop sync`,
and wired through `pi-mcp-adapter`.

Per `.coop/project.yml` and `docs/guardrails.md`:

| Server | Allowed by default | Requires explicit approval |
|--------|--------------------|----------------------------|
| `fabric` | `list`, `read`, `inspect` (read-only **by policy**) | `create`, `update`, `delete`, `deploy` |
| `powerbi` (`--readonly`) | `list`, `read`, `inspect` | `create`, `update`, `delete`, `publish` |
| `microsoft-learn` | docs lookups (always-current) | — |
| `context-mode` | intent search + **sandboxed exec** over docs/graph | — |

`coop` **never** calls create/update/delete/deploy/publish MCP actions without
explicit approval — regardless of what the server is capable of.
