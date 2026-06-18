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

**CLI contract:** `coop-data-doc <build|scan|check|init|setup|update|upgrade>`

- `scan` → writes the lineage graph **`graph.json`** (read-only over source).
- `build` → also writes **`manifest.json`** + Markdown docs + the searchable
  portal/site.
- `check` → CI staleness gate.
- `setup` → **interactive wizard**: prompts for each value, prefilled from any
  existing config, then validates and saves. Ctrl-C before the end writes nothing.
- `init` → writes a starter config to edit by hand (`--force` to overwrite).

**First-run setup (user-driven).** `coop-data-doc` reads its own config file,
**`coop-data-doc.yml`** — which is **separate** from coop's `.coop/project.yml`. It
points the tool at the repos to crawl and the doc output. coop does **not** create
it for you; the tool does, when you run its setup:

```
coop data-doc setup     # interactive wizard (recommended first time)
coop data-doc init      # or: write a starter coop-data-doc.yml to edit by hand
```

Until that exists, doc-building commands flow through and the tool tells you to run
`init`/`setup` (e.g. `error: Config file not found: coop-data-doc.yml`). The review
tools (`sql_review` / `dax_review`) have **no** wizard — they use bundled standards,
configurable per-run with `--standards` / `--config`.

**How `coop` invokes it** (`bin/coop` → `run_data_doc`):

- Args are **passed through verbatim** — including the interactive `setup` wizard and
  `init` (coop preserves the terminal, so the prompts work). `coop data-doc` with no
  args defaults to **`build`**.
- After running, it looks for machine-readable artifacts in this order and
  summarizes the first found:
  `manifest.json`, `graph.json`, `docs/manifest.json`, `docs/graph.json`,
  `site/manifest.json`. The summary counts nodes
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
| `paths` | `string[]` (optional) | Files/dirs to check. Defaults to `["."]`. |
| `min_severity` | `"error" \| "warning" \| "info"` (optional) | Maps to `--min-severity`. |
| `strict` | `boolean` (optional, default false) | Maps to `--strict` (CI gate). |

Invocation (built in `runReview`):
`<bin> check <paths…> --format json [--min-severity <s>] [--strict]`, run with
`pi.exec(bin, args, { cwd: ctx.cwd, signal })`.

Result:

- `content[0].text` — e.g.
  `coop-sql-review: 3 finding(s) — 1 error, 2 warning, 0 info (exit 1). Full structured report is in this tool result's details.`
- `details` — `{ tool, args, exitCode, report: <parsed JSON or raw stdout>, stderr }`.
- If the binary is missing or JSON won't parse, it reports the problem in
  `content` (not a conversation error) and still returns `details`.

### `data_doc`

| Param | Type | Notes |
|-------|------|-------|
| `command` | `"scan" \| "build" \| "check"` (optional) | Defaults to **`scan`** (read-only). `build` writes docs/portal. |

Invocation: `coop-data-doc <command>` via `pi.exec`. Result `content` notes the
artifacts: always `graph.json`, plus `manifest.json + Markdown docs + portal`
when `command === "build"`, followed by the last 25 lines of stdout.
`details` → `{ tool: "coop-data-doc", command, exitCode, stderr }`.

> Note: the native `data_doc` tool defaults to **`scan`** (read-only first per
> the workflow), whereas the `coop data-doc` subcommand defaults to **`build`**.

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

## `fabric-cicd` — validate-only by default

Fabric deployment validation. In `.coop/project.yml`,
`tools.fabric_cicd.default_mode` is `"validate_only"`. The agent runs validation
freely; **deploy / run-deployment is approval-gated** (`approval_policy.ask_first`
includes "fabric-cicd deploy / run deployment", and deploying to test/prod is in
`never_without_explicit_instruction`).

---

## MCP read-only action policy

All MCP servers (`fabric`, `powerbi --readonly`, `microsoft-learn`,
`context-mode`) are read-only and optional; `coop` runs without them. Config lives
in `config/mcp.example.json`, placed non-destructively into
`~/.config/mcp/mcp.json` by `coop sync`, and wired through `pi-mcp-adapter`.

Per `.coop/project.yml` and `docs/guardrails.md`:

| Server | Allowed by default | Requires explicit approval |
|--------|--------------------|----------------------------|
| `fabric` | `list`, `read`, `inspect` | `create`, `update`, `delete`, `deploy` |
| `powerbi` (`--readonly`) | `list`, `read`, `inspect` | `create`, `update`, `delete`, `publish` |
| `microsoft-learn` | docs lookups (always-current) | — |
| `context-mode` | local read | — |

`coop` **never** calls create/update/delete/deploy/publish MCP actions without
explicit approval — regardless of what the server is capable of.
