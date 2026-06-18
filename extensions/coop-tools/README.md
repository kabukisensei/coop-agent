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

## Behavior notes

- If a CLI is not installed, the tool returns a friendly message
  (*"… could not run … Is it installed? (coop install)"*) rather than raising —
  it does not break the conversation.
- Tools run in the session's working directory (`ctx.cwd`) and honor the
  abort signal.
- These mirror the CLI contracts exactly; there are no extra flags. The
  parameters above are the whole surface.
