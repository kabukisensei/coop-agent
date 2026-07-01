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

It also adds a friendly **Start Here menu** (the `/start` command, plus an
auto-open on a fresh session) so newcomers get guided choices instead of a blank
prompt, a **first-run setup** for `coop-data-doc` (the `/setup-docs` command and a
startup offer) so lineage docs can be established without leaving the agent, and a
**native lineage announcement** that points the agent at built docs before it
touches an object — see [Start Here menu](#start-here-menu-start),
[Data-doc setup](#data-doc-setup-setup-docs) and
[Lineage awareness](#lineage-awareness-before_agent_start) below.

## Start Here menu (`/start`)

A guided menu of common Cooptimize tasks so a fresh session opens with clear
choices instead of a blank prompt — the thing that most intimidates people who
aren't at home in a terminal. Each choice sends a friendly, first-person request
**as you** (the menu just pre-writes the prompt a newcomer would otherwise have to
compose); the agent then asks for specifics. The *Document my data* choice routes
into the `/setup-docs` wizard (or a build) when needed. Choices are wired to the
tools/skills coop already ships: SQL review, DAX review, impact/lineage, Fabric
workspace/architecture review, and work logs.

**Strictly additive and opt-outable — power users lose nothing:**

- **`/start`** opens the menu on demand, anytime.
- It **auto-opens only on the initial launch** of an interactive session (reason
  `startup`) — never on `/new`, `/resume`, `/fork`, or `/reload`.
- Every menu always offers **"Something else — I'll type it myself"** (one key →
  the normal blank prompt), and when auto-opened also **"Don't show this
  automatically"**.
- Turn it off for good with `COOP_NO_START_MENU=1`, or the `start-menu.off` marker
  (written in the coop agent dir when you pick *Don't show this automatically*).
- On the initial launch the menu is the front door, so it **replaces** the
  separate data-doc startup offer for that session (the menu surfaces data-doc
  setup as a choice). On `/resume` / `/fork` / `/reload`, the original data-doc
  offer still fires exactly as before.

It requires dialog-capable UI (`ctx.hasUI`), degrades to a one-line breadcrumb
("Type /start …") when dialogs aren't available, and is wrapped so it can never
break a session.

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

Runs `coop-data-doc <command>` to understand and document the SQL + Power BI
estate and build lineage. Executes **sequentially**.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `command` | `scan` \| `build` \| `check` \| `lineage` | `scan` | See below. |
| `object` | `string` | — | For `lineage`: the object to look up (e.g. `dbo.fact_sales`, or a table/measure name). Ambiguous names return candidates. |
| `depth` | `number` | `1` | For `lineage`: hops up/downstream to include. |

- **`scan`** (default) — read-only; writes the lineage graph (`graph.json`).
- **`build`** — also writes Markdown docs (per-object docs + lineage), a
  searchable portal, and `manifest.json`. Documentation outputs are committable;
  source is never touched.
- **`check`** — CI staleness gate.
- **`lineage`** — read-only; returns **one** object's upstream inputs, downstream
  dependents, and relationships as JSON, read from the **built** graph. Call it
  (or read the object's `<slug>.md` via `manifest.json`) **before** analyzing or
  changing any object, so you know its up/downstream consequences — don't
  reconstruct lineage by hand. An ambiguous `object` returns the candidate
  matches to choose from; if no graph has been built yet, it says so and you can
  still proceed without it (suggest `/setup-docs`).

For `scan` / `build` / `check`, the text result reports the command, exit code,
the machine-readable artifacts produced (`graph.json`, plus `manifest.json` +
Markdown docs + portal on `build`), and the tail of stdout; the `lineage` result
summarizes the up/downstream counts and carries the full slice + doc path in the
tool result's `details`. If the folder has no `coop-data-doc.yml` or built graph,
these **degrade gracefully** — the docs are an aid, not a requirement.

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

## Lineage awareness (`before_agent_start`)

When **built** `coop-data-doc` outputs exist for the working folder, this
extension injects a note — **once per folder** — telling the agent to consult the
lineage before it touches any object. The note is **agent-visible but hidden from
the human** (`customType: "coop-lineage"`, `display: false`), so it grounds the
model without cluttering the transcript. It carries the markdown output dir
(relative to cwd) and instructs the agent to look up up/downstream impact via the
`data_doc` tool (`command="lineage"`, `object="<name>"`) and read that object's
doc (located via `manifest.json`) plus its immediate neighbors — and to run
`data_doc (build)` if the docs look stale.

"Built" means the markdown output dir (from `coop-data-doc.yml`'s `output.dir`,
defaulting to `./data-docs`) contains a `manifest.json` **or** an `index.md`. The
hook **degrades silently** when there's no `coop-data-doc.yml`, or when a config
exists but hasn't been built yet — the docs are an aid, not a gate, and the whole
hook is wrapped so it can never break a turn.

## Behavior notes

- If a CLI is not installed, the tool returns a friendly message
  (*"… could not run … Is it installed? (coop install)"*) rather than raising —
  it does not break the conversation.
- Tools run in the session's working directory (`ctx.cwd`) and honor the
  abort signal.
- These mirror the CLI contracts exactly; there are no extra flags. The
  parameters above are the whole surface.
