# coop-tools

Native, LLM-callable Cooptimize tools for Pi. This **companion** extension —
loaded via `pi -e` (or automatically by `bin/coop.ps1`) — registers three tools the
agent can call directly instead of asking you to run a CLI: `data_doc`
(coop-data-doc), `bpa_review` (Tabular Editor BPA, the deterministic model check)
and the governed `fabric_sql_query` fallback:

```sh
pi -e extensions/coop-tools
```

Each tool shells out, parses the result, and returns it as structured `details`
on the tool result so the model can reason over it. All three are **advisory /
read-only**: they report findings, build documentation or run one bounded read,
but they never edit source.

SQL and DAX standards are **not** a tool here. The former `sql_review` /
`dax_review` wrappers were retired (master plan ST1): the extension's
`before_agent_start` hook feeds the active coop-standards wiki articles into every
SQL / DAX / semantic-model task, and the agent self-checks its diff against them
before presenting a change, naming any rule it could not meet.

It also adds the **Start Here menu** (the `/start` command, opened once on the
first interactive launch), a native
**project contract wizard** (`/setup-project`), and setup for `coop-data-doc`
(the manual `/setup-docs` command) so lineage docs can
be established without leaving the agent when the user is ready, and a
**native lineage announcement** that points the agent at built docs before it
touches an object — see [Start Here menu](#start-here-menu-start),
[Data-doc setup](#data-doc-setup-setup-docs) and
[Lineage awareness](#lineage-awareness-before_agent_start) below. It also turns
`logging.require_task_log` into a real completion rule; see
[Required daily logging](#required-daily-logging).

## Project setup (`/setup-project`)

Users do not need to know `coop init` or manually edit YAML. Run `/setup-project`
or choose *Start a client project* from `/start` whenever the project is ready to
configure. Normal Coop startup does not open the wizard. The contract is one
committed team file per client, in a repository the team clones (master plan C1):
a contract found above the current folder, or in the client home repository
`<client>-coop` beside it, is edited in place, never shadowed by a second copy.
When origin has the file and this checkout does not, the wizard first offers
**Get the team's project file** (`lib/project-share.mjs`: a fast-forward pull when
nothing else would move, else only that file with a backup). A new contract goes
at the repository root, or, beside several repositories, in the home repository
the wizard creates after the client's name (`git init`, README from
`templates/client-home/`, every sibling listed as `../<name>`). Saving ends with
**Share with the team?**: one yes, then coop commits only `.coop/project.yml`
(`coop: project file updated by <name>`) and pushes the current branch, audited as
`project-share`; `/project-share` and `/project-get` do the same any time, and the
`session_start` hook says one line when the team's copy is newer, this copy is
unshared, or the team has a file this checkout lacks (`COOP_PROJECT_SYNC=0`
silences it). While the local user
profile (`<profile dir>/user.json`) is missing, the wizard first asks the name coop
calls the user by and saves it there with the balanced communication preset (the
launch no longer runs the onboarding wizard, master plan FR1); the name never goes
into `project.yml`.

The wizard configures the organization/client, zero or more repository paths and
roles (including mixed SQL + Power BI repos), default branches, Fabric/Power BI
tenant and workspace defaults, and the optional Tabular Editor CLI. Starting with
no local source creates a first-class discovery project; one-sided and partial
coverage can be expanded later. A new project receives conservative commit policies
and approval defaults. Editing an existing project creates a backup and patches
only wizard-owned scalar fields; comments, custom sections, commit allow/deny
rules, and future unknown settings are preserved. Run `/new` or restart Coop after
editing so `coop-guardrails` loads a fresh trusted contract snapshot.

## Start Here menu (`/start`)

The seven common workflows of the master plan (section 9), each wired to a prompt,
skill or native wizard coop already ships:

1. Check SQL, DAX or a model against our standards (the standards self-check;
   `bpa_review` for a model)
2. Trace the impact of a change (`sql_impact` for a live SQL object, then
   `data_doc lineage`)
3. Fix or edit an object on dev, with approval (`/spec-first` then `/slice-next`)
4. Document a warehouse or semantic model (`/setup-docs`, or a `data_doc build`)
5. Start a client project (the `/setup-project` wizard; asks your name while no
   profile exists)
6. Write today's log or a handoff (`/daily-log`, `/weekly-log`, `/handoff`)
7. Sign in or check health (`coop doctor`, `az login`)

Items 4 and 5 run a native wizard; the others send a friendly, first-person
request **as you** (the menu just pre-writes the prompt a newcomer would otherwise
have to compose), and the agent then asks for specifics. The Fabric workspace
review stays available as `/fabric-architecture-review`.

**When it opens:**

- **Once, on the first interactive launch** on a machine: `bin/coop.ps1` sets
  `COOP_FIRST_RUN=1` the first time it launches Pi from a terminal and writes
  `<profile dir>/first-run` so it never does so again; the `session_start` hook
  shows the menu once and clears the flag, so `/new` in the same process does not
  reopen it. When that launch is also the one-time model sign-in, the hook only
  says to run `/start` after signing in.
- **`/start`** opens the menu on demand, anytime. Later launches, `/new`,
  `/resume`, `/fork` and `/reload` go straight to the prompt.
- The menu offers **"Something else — I'll type it myself"** to return to the prompt.
- Data-doc setup is never opened automatically. The menu's *Document a warehouse or
  semantic model* choice launches it only when selected; `/setup-docs` remains
  available anytime.

It requires dialog-capable UI (`ctx.hasUI`), provides a one-line explanation when
dialogs aren't available, and is wrapped so it can never break a session.

## Tools

### `bpa_review`

Runs Tabular Editor BPA (`te bpa run --model <model> --output-format json
--non-interactive`) against semantic models when `tools.tabular_editor_cli` is
enabled in `.coop/project.yml`. Advisory only — it reports findings by severity
and never edits model files. Executes in **parallel**. Called without `paths`, it
checks the contract's `power_bi.semantic_models[].path` entries. Parameters,
rule-path handling and the result shape are in
[docs/tool-contract.md](../../docs/tool-contract.md).

### `fabric_sql_query`

Governed pyodbc fallback for one bounded `SELECT TOP` read against the
contract's Fabric SQL target, used only after the managed `fabric-sqlendpoint` MCP
actually failed. Executes **sequentially**. Contract in
[docs/tool-contract.md](../../docs/tool-contract.md).

### `data_doc`

Runs `coop-data-doc <command>` to understand and document whatever SQL and/or
Power BI source is available and build lineage. Executes **sequentially**.

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

`coop-data-doc` is configured by `coop-data-doc.yml`. This extension launches the
same authoritative setup questionnaire with `--transport jsonl`, renders its prompts
through Pi dialogs, and returns answers over stdin. No local/reduced wizard exists.

- **`/setup-docs` command.** Run or re-run the full native questionnaire anytime.
  Choose SQL + Power BI, SQL only, Power BI only, or no local source yet; existing
  config values prefill prompts. Completion/cancellation/error events and
  process exit status must agree before the bridge reports success. Repository-path
  prompts browse real folders with a type-to-filter selector, so users can open a
  nearby repo and store its relative path without typing an absolute path. When the
  suggested folder doesn't exist, Enter opens *Type or paste the folder path*: no
  folder is preselected, and browsing starts beside the suggestion only when a real
  repo is there (otherwise in the session folder). Yes/no questions show the
  wizard's default first, so "Use it anyway?" answers No on Enter.
- **Safe defaults (#102).** `/setup-docs` and *Document my data* stop in the home
  folder without writing `coop-data-doc.yml` and explain how to open coop in the
  project folder. A config saved as "not runnable yet" is a warning, and no build is
  offered. A build that fails on a missing repo path offers to re-run setup or to
  open `coop-data-doc.yml` in the editor.
- **Transport safety.** Stdout is strict LF-framed JSONL with a 1 MiB line limit;
  stderr is diagnostics only. Windows resolves `coop-data-doc.exe` directly and
  rejects `.cmd`/`.bat` shell shims. Older tool versions stop with upgrade guidance.

Coop does not prompt for or run this wizard during session or project startup.
The same setup is also available by selecting *Document my data* from `/start` or
running `coop data-doc setup` in a shell.

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

## Required daily logging

When the nearest `.coop/project.yml` sets `logging.require_task_log: true`, the
`before_agent_start` hook adds a human-hidden system instruction on every turn:
after meaningful project work, Coop must explicitly use `daily-logger` and append
today's entry before its final response. The configured `daily_log_path` and project
timezone determine the file. The contract flag is standing authorization for the
append, but never for a commit or push.

The extension tracks successful edit/write calls, substantive review and data-doc
calls, and common shell validation/mutation commands. Once the agent is fully
settled, it compares the target log's timestamp and tracked writes. If meaningful
work finished without a log update, Coop shows a warning and a footer status; a
later log update clears it. Read-only Q&A, status checks, lineage lookups, failed
tool calls, contracts with the flag disabled, and explicit per-task opt-outs do not
require an entry. The verifier is intentionally advisory—the per-turn instruction
is what makes the agent perform the log step, while the warning exposes a miss.

## Compaction over the configured transport (`session_before_compact`)

Pi 0.87.1 (and still 1.1.0) builds its compaction request without the session's
`transport` setting, so the OpenAI Codex provider falls back to `auto` and opens
a WebSocket for the summary even when `/settings` says `sse`; a large context
then fails with `WebSocket idle timeout after 300000ms` (coop-agent #236). When
the agent dir's `settings.json` has `transport: "sse"` and the current model's
provider honours `transport` (`openai-codex-responses`), this hook generates the
summary itself through Pi's exported `compact()` with a stream function that
forwards `transport`, the idle timeout (`retry.provider.timeoutMs`, else
`httpIdleTimeoutMs`) and the retry policy, then returns it as the compaction.
Manual `/compact`, threshold and overflow compaction all pass through the hook.

It stands down (returns nothing, so Pi compacts as before) for every other
transport, for models whose provider ignores `transport`, when credentials
cannot be resolved, or when Pi lacks the `compact()` / `streamSimple()` seam. A
provider failure during the SSE summary propagates, so Pi reports one
`session_compact_failed` and keeps the session history. Remove the hook once
upstream Pi forwards the transport to its compaction request.

## Behavior notes

- If a CLI is not installed, the tool returns a friendly message
  (*"… could not run … Is it installed? (coop install)"*) rather than raising —
  it does not break the conversation.
- Tools run in the session's working directory (`ctx.cwd`) and honor the
  abort signal.
- These mirror the CLI contracts exactly; there are no extra flags.
