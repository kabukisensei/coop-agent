# coop-tools

Native, LLM-callable Cooptimize tools for Pi. This **companion** extension —
loaded via `pi -e` (or automatically by `bin/coop`) — registers three tools the
agent can call directly instead of asking you to run a CLI:

```sh
pi -e extensions/coop-tools
```

Each tool shells out to a standalone Coop CLI with `--format json`, parses the
result, and returns it as structured `details` on the tool result so the model
can reason over it. All three are **advisory / read-only**: they report
findings or build documentation, but they never edit source.

It also adds a **first-run setup** for `coop-data-doc` (the `/setup-docs` command
and a startup prompt) so lineage docs can be established without leaving the
agent — see [Data-doc setup](#data-doc-setup-setup-docs) below.

## Tools

### `sql_review`

Runs `coop-sql-review check <paths> --format json` against T-SQL / Fabric
Warehouse SQL. Advisory only — it reports deviations from Cooptimize SQL
standards and never edits or blocks. Executes in **parallel**.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `paths` | `string[]` | `["."]` | Files or directories to check. |
| `min_severity` | `error` \| `warning` \| `info` | — | Adds `--min-severity`. |
| `strict` | `boolean` | `false` | Adds `--strict` (exit non-zero if findings remain — CI gate). |

The text result summarizes findings by severity (error / warning / info) and
exit code; the full structured report is in the tool result's `details.report`.

### `dax_review`

Runs `coop-dax-review check <paths> --format json` against DAX / semantic-model
files. Same parameters, output shape, and parallel execution as `sql_review`;
same advisory, never-edits guarantee — measured against Cooptimize DAX
standards.

### `data_doc`

Runs `coop-data-doc <command>` to document the SQL + Power BI estate and build
lineage. Executes **sequentially**.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `command` | `scan` \| `build` \| `check` | `scan` | See below. |

- **`scan`** (default) — read-only; writes the lineage graph (`graph.json`).
- **`build`** — also writes Markdown docs, a searchable portal, and
  `manifest.json`. Documentation outputs are committable; source is never
  touched.
- **`check`** — CI staleness gate.

The text result reports the command, exit code, the machine-readable artifacts
produced, and the tail of stdout.

## Data-doc setup (`/setup-docs`)

`coop-data-doc` is configured by a `coop-data-doc.yml` in the working folder. Its
own `setup` wizard is interactive (questionary), but Pi runs tool subprocesses
**non-interactively** (no TTY) — so the agent can't drive that wizard directly.
Instead this extension renders a small wizard with **Pi's native dialogs**
(`ctx.ui.input` / `ctx.ui.confirm` / `ctx.ui.select`), writes or patches
`coop-data-doc.yml`, and offers to run `coop-data-doc build`.

- **Startup offer.** On `session_start`, if the working folder has no
  `coop-data-doc.yml` (and no `.coop-data-doc.skip` marker), coop offers to set it
  up — **Yes / Not now / Don't ask again**. Only *Don't ask again* writes
  `.coop-data-doc.skip` (so an accidental Esc/dismiss never silences setup forever;
  delete the marker, or run `/setup-docs`, to re-enable). If a config exists but the
  docs aren't built yet, it offers to build them instead. The offer fires once per
  folder per process (keyed by cwd, so `/new` / `/resume` / `/fork` into a new folder
  still get offered).
- **`/setup-docs` command.** Run (or re-run) the wizard anytime. When a
  `coop-data-doc.yml` already exists, its values **prefill** the prompts and the
  wizard **patches only the fields it manages, in place** — so anything set by the
  full wizard (layers, branding, schema→model mappings, include/exclude globs,
  `sql_dialect`) and your comments are preserved. A successful run clears the skip
  marker.
- **Collected fields (essentials):** project name, SQL repo path, Power BI repo
  path, and the Markdown + HTML output folders (with the same separate-folders
  rule the CLI enforces, separator-aware so it holds on Windows). Everything else is
  left untouched (re-run) or defaulted (fresh) — configure the rest with the **full**
  wizard in a shell: `coop data-doc setup`.

The fresh-config writer mirrors the defaults in `coop-data-doc`'s `config.py`
(`render_config_yaml`); a re-run edits the existing file in place. Validation is
delegated to `coop-data-doc build` (`Config.load`), whose error is surfaced via
`ctx.ui.notify`. Pasted control characters are stripped from inputs so the written
YAML stays loadable.

## Behavior notes

- If a CLI is not installed, the tool returns a friendly message
  (*"… could not run … Is it installed? (coop install)"*) rather than raising —
  it does not break the conversation.
- Tools run in the session's working directory (`ctx.cwd`) and honor the
  abort signal.
- These mirror the CLI contracts exactly; there are no extra flags. The
  parameters above are the whole surface.
