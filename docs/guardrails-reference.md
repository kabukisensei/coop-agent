# Cooptimize Agent — Guardrails reference

This document holds the detailed rationale, enforcement mechanics, and tool-by-tool guidance that was removed from the always-loaded `docs/guardrails.md` to keep the runtime prompt concise. The policy itself has not changed; this is reference material the model can request or a human can read.

## What changed and why

The always-on guardrails prompt was historically ~13 KB and mixed policy with tutorials, examples, and implementation details. The concise version keeps only the non-negotiable rules, high-level workflow principles, and a pointer to this reference. No policy was weakened — only duplicated or tutorial-level detail was moved here.

## Runtime enforcement details

The `coop-guardrails` extension enforces these rules. It does not rely on this prompt alone.
An exception escaping a tool-call enforcement check, including a synchronous throw or
rejected approval promise, blocks that call with a fixed reason. Exception text is not
returned or logged. Optional display and audit-write failures remain best-effort and
cannot turn a refusal into permission.

### Git source-commit blocking

A `git commit` that would include source is **blocked**. This covers:

- staged files;
- `git commit -a/-am` (which auto-stages tracked changes);
- `git -C <dir> commit`;
- `git commit <pathspec>` (which commits working-tree content straight past the index);
- `git add <paths> && git commit` and every other compound form where an earlier `git add` / `git stage` / `git rm` / `git mv` segment of the same command changes the index first (`-A`, `.`, `-u`, interactive and `--pathspec-from-file` forms count as the whole tree);
- quoted paths and interspersed flags are parsed correctly.

Allowed paths come from the target repo's `.coop/project.yml` entry under `repositories:` (`agent_allowed_to_commit` / `agent_never_commit`), falling back to the top-level `agent_allowed_to_commit` and the built-in docs/logs/site defaults. Commit only allowed paths and let a human commit source.

### Destructive / forceful commands

Destructive commands require confirmation. This includes `rm -rf`, `git push --force` (including a `+refspec` force push), `git reset --hard`, `git clean -f`, `DROP`/`TRUNCATE`, and similar.

Fabric and Azure REST writes issued from the shell ask the same way: `az rest` with a non-GET `--method`, `fab api -X post|patch|put|delete`, and the Fabric CLI's mutating subcommands (`fab deploy`, `mkdir`, `rm`, `cp`, `mv`, `set`, `import`, `assign`, `unassign`, `job`, `acl`, `label`, `start`, `stop`, `ln`). Rayfin (Fabric Apps) deploys ask too: `rayfin up` and its `db`, `staticapp`, `functions`, `secrets`, `connector` and `storage` subcommands, and `rayfin secret set|delete`, however they are launched (`npx`, `npm exec`, `pnpm`, a local `node_modules/.bin`); the prompt names the contract's dev workspace (`fabric.default_workspace_id`) and warns when the command targets another. `rayfin up --dry-run`, `up status|list|switch` and local work (`init`, `dev`, `connector search|inspect`, `docs`) pass. The official Microsoft Fabric skills drive item create/update/deploy/delete this way, outside the MCP mutation gate. Reads (`--method get`, `fab api <path>`, `fab ls`/`get`/`exists`/`export`) pass. Headless runs fail closed.

### Power BI Desktop reloads

Before `powerbi-desktop reload` or a `powerbi-report-author preview` that reloads the live Desktop window (a bare preview, `--reload`, `--reload-with-model`), coop runs `powerbi-desktop status` itself. The Desktop Bridge discards unsaved Desktop edits on reload, so an instance reporting `hasUnsavedChanges: true` asks first and headless runs are blocked; an instance coop cannot verify (status fails, not connected, `--pid` not listed, flag unstated) is blocked. `--pid` selects the instance, otherwise the preview's `.Report` folder does; with neither, every connected instance must be clean. `--status`, `--screenshot`, `--close` and `--host service` never reload and pass.

### PowerShell commands

Pi's optional `powershell` tool is off by default. When it is on, **every** PowerShell command asks first and shows the command, because the checks above parse bash, not PowerShell. There is no session approval, and headless runs are blocked. Prefer the `bash` tool (Git Bash on Windows), which those checks cover.

### Secret files

A read/edit/write of a secret-looking file (`.env`, private keys, credential files, model sign-in stores such as `auth.json` and a Pi agent dir's `models.json`, the Azure CLI's MSAL token cache) — **or a bash command that touches one** (`cat .env`, `curl -F f=@.env`) — requires confirmation. A path that is a symlink or junction to such a file counts as that file, checked against the target before the call (it is not a sandbox: a link swapped after approval is not caught).

### Mutating MCP calls

A Fabric/Power BI/MCP tool call whose name looks like a **mutation** (create/update/delete/deploy/publish, upload/modify/reset/import/move, running a pipeline, job, notebook or dataflow, or a refresh such as `refresh_dataset`, which reprocesses a dataset on the client tenant) requires confirmation, including proxied MCP calls where the real remote tool name is carried inside central `mcp` or dynamic `mcp__<server>` input (`event.input.tool`). Fabric MCP runs in namespace mode, where the `onelake`, `core`, `datafactory` and `docs` tools route a `command` argument. The guardrails check that command against the pinned server's own list: reads pass, writes ask, deletes and unknown commands always ask. That check is best-effort — MCP tool names vary. `coop-guardrails` is the approval layer: Pi itself does not prompt per tool call (its only startup prompt is project trust), so the check complements only the advisory prompt. Enable the optional `pi-permissions` extension for hard per-tool gating. If a tool call is blocked, read the reason and adjust — don't try to route around it.

**Session edit approvals.** The approval prompt for an edit offers **Allow once**, **Allow <server> edits for this session**, or **Decline**. A session approval covers that MCP server's later create/update/write/upload/publish/refresh-style calls until the session ends (`/new` or exit) or `/coop-approvals revoke`. Deletes and drops (`delete`, `remove`, `drop`, `truncate`, `purge`, `destroy`, `revoke`) always ask and never offer the session option. Anything that names prod or production is a production write and needs a production permit (see Production writes below). For Warehouse SQL on a confirmed dev or test target, any write can use the session approval, batches and `MERGE` included, except one that deletes (`DELETE`, `DROP`, `TRUNCATE`, an `ALTER` that drops a column, a `MERGE` that deletes), runs a procedure (`EXEC`, `sp_rename`) or changes permissions (`GRANT`, `REVOKE`, `DENY`): those ask every time. A production or unconfirmed Warehouse needs the production go-ahead, whatever words the SQL contains. A Fabric write from the shell (`fab`, `az rest`) offers the same session option per command kind (`fab deploy`, `az rest POST`); a delete asks every time. A plain read on a confirmed dev target (one `SELECT` or `WITH` statement on that database, bounded or not) needs no approval; test reads keep the `TOP (n)` rule. Headless runs still fail closed. `/coop-approvals status` lists what is approved; every decision is in the audit log.

MCP servers come only from coop's managed `~/.coop/agent/mcp-adapter.json`: coop launches the adapter with `PI_MCP_CONFIG_MODE=exclusive`, so a work repo's `.mcp.json` or `.pi/mcp.json`, and other tools' MCP configs, cannot add a server or redefine a coop one.

Pi's built-in `/bug` cannot upload from a coop session: coop sets `PI_RADIUS_GATEWAY` to an unresolvable host, so the report (and any session transcript) stays on the machine as a local zip instead of reaching `radius.pi.dev`.

The adapter's `mcpScript` tool is off and blocked. It runs JavaScript that calls MCP tools inside the adapter, where no guardrail can see or gate those calls. Coop's generated MCP config sets `settings.scriptMode: false`, and the guardrail blocks `mcpScript` if a project or user config turns it back on. Call MCP tools one at a time through `mcp`.

**Which tool a call runs.** coop looks each call up in Pi's tool registry. Only a tool shaped as the adapter's `{tool, args}` dispatch (the `mcp` tool and its `mcp__<server>` namespace tools) has its `tool` field read as the operation. For any other tool, `tool` is an ordinary argument, and the tool's own name decides. Pi 1.x's built-in MCP names each tool `mcp__<server>__<tool>`, and coop takes the server from Pi's registry. These tools get the same prompts and the same per-server session approvals as adapter calls, and a tool its server marks destructive always asks. coop launches Pi with `--no-mcp` and `coop sync` keeps `-builtin:mcp` in its settings, so coop's MCP servers run only through the adapter; the built-in shape is gated anyway.

**One approval at a time.** coop checks tool calls one at a time, so only one approval dialog is open at once, and a call that waited behind a session approval doesn't ask again. Pi 1.x's codemode scripts can issue several calls at once. coop launches Pi with `--exclude-tools codemode,tool_search`, so codemode stays off until its nested calls are proven under these rules (master plan U2 step 3); a work repo's `.pi/settings.json` cannot turn it back on.

The adapter's direct tools (`directTools` on a server entry, registering every server tool as `<server>_<tool>`) are off on coop's managed servers, and `coop sync` switches a user-enabled flag back off. If one is on anyway, the guardrail maps a direct `fabric_onelake`, `fabric_core`, `azure-devops_…` or `powerbi-modeling-mcp_…` call to its server and remote tool and gates it exactly like the proxied call. The adapter also accepts that listed name through `mcp` (`{server: "fabric", tool: "fabric_core"}`), and the guardrail treats it as the bare router name.

### Production writes

Production changes only with a person's separate go-ahead, and each one still asks. A Warehouse SQL `CREATE`, `ALTER`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `MERGE` or `EXEC` whose target coop's trusted configuration (the project contract's `sql_targets`, or the managed server entry) resolves to `production`, a Power BI Modeling edit after a production connection, a Fabric or proxied MCP mutation whose call names prod or production, and a shell Fabric write (`az rest`, `fab`) that names production are **blocked** unless a person has given a time-limited production go-ahead for this session's client, outside coop; under it, each one asks a yes/no that says `PRODUCTION` and shows the call. That yes is the call's only approval: it is never offered for the whole session, it never runs headlessly, and the phone companion never answers it (production cards are desk-only). Every attempt is audited as `production write`, allowed, declined or blocked, with `no-unlock` or the go-ahead's id. Production **reads** need no approval (see Live environment reads). The environment comes from trusted configuration, never from the SQL text alone, so a dev target with a `prod_staging` schema is not treated as production; a call with no trusted target whose text names production is. A Warehouse write on a target the trusted configuration cannot confirm as dev or test (the workspace-wide endpoint, or blank `environment_names` with no `sql_targets` entry carrying the endpoint's ids) is treated the same way, because it may be production. A Fabric, Modeling or shell write whose argument is exactly a name the project file labels production (`fabric.environment_names.prod`, `power_bi.environment_names.prod`, or the `sql_targets.prod` server or ids) is a production write too, whatever other words it uses. Name the target in `sql_targets.dev` (the setup wizard does) so dev writes keep the ordinary approval.

**The go-ahead.** A session can never give itself the production go-ahead: the guardrails block a session from creating or editing it, it never comes from the phone, and `/coop-approvals status` shows when one is active. It expires on its own.

### SQL edits and the lineage context

Before an edit or write of a `.sql` file, coop-tools fills the session's lineage
context for the object the file defines (the committed catalog snapshot, then the
built lineage docs). The guardrail lets the edit through when any source holds the
object, when every source that exists was tried, or when the file defines no object
coop can name; it blocks the edit when a live target could still answer and
`sql_impact` was never asked for that object, or when the snapshot's answer is
older than the contract's `catalog.max_age_days`. The block names the tool to call;
the same object is never asked twice in a session. Audit kind `lineage-gate` with
the path and the fixed detail `lineage-not-held`. Reads are never gated. Detail:
`docs/tool-contract.md`, "Session lineage context".

### Live environment reads

Reading needs no approval on any environment, production included, so you can compare prod with dev; only changes need one. Metadata, schema and artifact-code inspection, a Power BI DAX query, a Fabric router read command, and a plain SQL read on a resolved target all run without a prompt and are audited. A query/execute/sample-style call coop cannot classify (an unfamiliar server's `query_*` tool) may change data, so it asks once; exports and downloads keep their own gate. Approval-required calls fail closed when no interactive approval UI is available.

A SQL read resolves its target only through COOP-owned configuration. For the real `pi-mcp-adapter` central `mcp` proxy or dynamic `mcp__fabric_sqlendpoint` wrapper, that is the generated COOP-managed, item-scoped `fabric-sqlendpoint` entry: `coop sync` adds the parsed project client, tenant, environment and item/database name. An entry the project file does not label is read as production. The guardrail binds the principal to the non-secret `tid` and `oid`/`sub` claims of the launch bearer in `COOP_FABRIC_MCP_TOKEN`; it never stores or logs the token. Missing, malformed, ambiguous, blank or TODO identity fields, a tenant mismatch, supplied workspace/item IDs that differ from the trusted ones, unsupported argument controls and multiple SQL fields resolve no target, so that call asks. Model/tool-provided scope fields are ignored. Both proxy shapes classify the dispatched `input.args`; outer query fields cannot hide an inner mutation, and dynamic wrappers take their server identity from the registered wrapper name.

When the contract declares `sql_targets:`, the native `fabric_sql_query` tool reads the ready dev or test default entry, or the ready entry its `environment` field names (`dev`, `test` or `prod`). The executor only ever runs one bounded `SELECT`, so naming `prod` reads production and cannot change it. The scope uses the contract's `profile.client` and the launch identity, whose tenant must match `fabric.tenant_id` when the contract names one. A placeholder, an invalid entry, a missing client or a tenant mismatch resolve no scope, so that read asks. Editing the contract mid-session changes nothing until `/new` or a restart.

A plain read is one read statement on that database: CTEs, unions, joins and subqueries are fine. Cross-database names, double-quoted identifiers, `EXEC`, transactions, session settings, `SELECT … INTO`, unfamiliar SQL and every mutation keep their gates (writes: see Production writes and the dev rules). Audit entries record the environment (`dev-read-only`, `production-read-only`, …), never raw SQL, arguments, results, tokens, connection strings or remote server text. Pinned `pi-mcp-adapter` 3.3.0 runs COOP's exact request-header helper for every outbound request, and the managed entry sets its supported `requestTimeoutMs` to 60 seconds. The fresh bearer must match the launch identity before it is returned.

### Contract fields the guardrails read

Only these `.coop/project.yml` fields change what the guardrails allow:

- `repositories.<name>.local_path`, `agent_allowed_to_commit` and `agent_never_commit`
  (plus the top-level `agent_allowed_to_commit`): which paths a commit may stage.
- `sql_targets`, `profile.client` and `fabric.tenant_id`: the live-read scope above.

The dev/test/production and approval rules are fixed in the guardrails, so editing
any other contract field never changes an approval. Older contracts may still
carry `estate.live_discovery` or `mcp.<server>.allowed_default_actions` /
`requires_approval_actions`; nothing reads them, and they can be deleted.

### Audit log

Recorded blocks and confirmations (allowed or declined) are appended best-effort as one JSON line to `$PI_CODING_AGENT_DIR/guardrails-audit.jsonl` (default `~/.coop/agent/…`): timestamp, working folder, kind, decision, a fixed classification (or offending paths for source/secret-file gates), and the coop process id, which tells apart two window tabs (or terminals) on the same folder. Sharing the project file (`/project-share`, the window's Project pane, `coop project share`; master plan C1) is the one Git write coop performs on its own, always after the user's yes and only for `.coop/project.yml`: it is logged here as kind `project-share` with the branch pushed (`push <branch>`) or the refusal reason, never the commit's content. Command text and arguments are not persisted. The secret gate records only the matched path, never file contents; the MCP gate records fixed COOP labels, never remote server strings or raw arguments. Run `/coop-guardrails` to see the last ~10 decisions and the log path. An enforcement exception returns a fixed blocking result without logging its error payload.

The audit display also suppresses command details in legacy destructive-command,
hard-blocked-commit and unverifiable-commit entries. This does not scrub the on-disk
history or rotated files. Existing audit files may contain historical command text;
do not treat a raw audit-file copy as a sanitized export. No automatic deletion or
migration of audit history is performed.

## The Cooptimize workflow (detailed)

What matters is the **principles**, not a rigid step count: stay grounded in the project's standards and lineage, **plan and get approval before you change anything**, back up before edits, review your work with the tools, document and log it, and **never commit source**. Adapt the sequence to the situation, but don't drop the principles.

On non-trivial work, run **vertical slices** by default: each slice is one small, end-to-end change that starts with a failing check and ends with a passing check. Each slice gets its own test: state the specific SQL/DAX query, measure, linter, or review that demonstrates the problem before and proves the fix after. Explain why this slice is next, what it proves, and the assumptions / early warning signs that would make it wrong; do not just list tasks. If the project enables `tests.live_data.enabled`, run the configured live-data test between slices with approval and target dev/test only; the configured command is a default runner, but the slice still defines the specific test. Apply review feedback as **Markdown annotations**, **codify** repeated corrections, and **end with a handoff**.

The `/spec-first`, `/annotate`, `/slice-next`, `/explain`, and `/handoff` prompts drive these; the `coop-workflow` skill has the detail. For an approved slice, progress messages are non-blocking: continue through backup, edits, review, authorized dev/test validation, restoration, and the passing check before giving the final result. Pause only for a genuine blocker, mismatch, invalidated assumption, scope expansion, user-only decision, or newly encountered destructive/production action.

### Default sequence

1. Read `.coop/project.yml` and use COOP's resolved standards task authority, including any deliberate project override.
2. Identify the repo/object and upstream/downstream impact; run `git status` and `git pull`.
3. Read the target file(s) and related docs/lineage — use the `coop-data-doc` tool.
4. Write a short **PLAN** and get explicit review/approval before any edit.
5. Create a timestamped backup of every file to be changed.
6. Make the smallest safe edit.
7. Self-check: before presenting SQL, DAX, or model changes, check the diff against the same standards articles used to write them; fix what does not meet them, and deviate only on a user exception or a stated reason (plus Tabular Editor BPA / `fabric-cicd` validate where relevant).
8. Show `git diff` and summarize the change.
9. Update Markdown docs / glossary / lineage; regenerate the site if docs changed.
10. Append to the daily log.
11. Commit docs/logs/site **only with approval**; never commit source.

## Tool guide

You have these tools. Know they exist and reach for the right one.

- **`data_doc`** → `coop-data-doc`. Use it **first** when you need to understand an estate: relationships, lineage, and existing object documentation. `scan` builds the lineage graph (`graph.json`); `build` also writes **Markdown documentation** (per-object docs + lineage) and a searchable portal, indexed by `manifest.json`. **Read that generated Markdown** — it's the canonical, human-and-agent-readable documentation for the SQL + Power BI estate. When existing docs are present, read the relevant `.md` files instead of re-deriving relationships by hand; use `manifest.json` to find which doc covers which object.
  - **First run:** if this folder has no `coop-data-doc.yml`, the docs don't exist yet — continue without them. If lineage would help, suggest **`/setup-docs`** or `coop data-doc setup`; both drive the same authoritative questionnaire. Setup is never automatic.
  - **Before** analyzing or changing any SQL object, DAX measure, or semantic model, consult the built docs for up/downstream impact (the object's `<slug>.md` + its immediate neighbors). The quickest grounding is the **`data_doc` tool with `command="lineage"`, `object="<name>"`** (or `coop-data-doc lineage <object> --depth 1`) → JSON of that object's upstream/downstream + relationships + its doc path, in one call. coop **auto-detects** built docs at the start of a session and tells you when they're available. When a folder has **no** built docs, proceed normally: the lineage is an **aid, not a gate**.
- **Standards in context** (no tool call). The active coop-standards articles for SQL, DAX and semantic models are placed in your context for every such task. Write to them, then **self-check** your diff against them before presenting it: fix what does not meet them, and deviate only on a user-granted exception or a stated reason, named in the summary. There is no separate rule engine. Offline, the articles come from the copy shipped with coop and the context says so.
- **`bpa_review`** → Tabular Editor BPA (when `tools.tabular_editor_cli` is configured in the contract). The deterministic semantic-model check — advisory, never edits or blocks.
- **`fab`** (Microsoft Fabric CLI = ms-fabric-cli) — list/inspect Fabric workspaces and artifacts (read-only first). **`fabric-cicd`** is a Python **library** (no CLI): `import fabric_cicd` inside deployment scripts for deployment **validation** (validate-only by default; never deploy without explicit approval) — it is not a `fabric-cicd` command. **Tabular Editor CLI** (if configured) — semantic-model BPA, reached through `bpa_review`.
- **MCP (read-only):** **Microsoft Learn** when you need *current* Microsoft documentation rather than memory; **Fabric** / **Power BI** to list/read/inspect live artifacts. Never call write/deploy/publish MCP actions without approval.
- **Memory** (pi-hermes-memory) — durable facts, preferences, and corrections across sessions; never store secrets.
- **Web access** (`pi-web-access`) — search the web, fetch URLs, clone a GitHub repo, extract PDFs/videos. Read-only, so it fits read-only-first. Prefer the **Microsoft Learn MCP** for Microsoft/Fabric/Power BI docs; use web access for everything else.
- **Ask the user** (`@juicesharp/rpiv-ask-user-question`) — when you would otherwise **guess**, put a structured, typed-option question to the user instead. Reach for it at **consent rounds** and plan-and-approve decision points.
- **Track the work** (`@juicesharp/rpiv-todo`) — for work with three or more steps, keep the plan as `todo` tasks: one `in_progress` at a time, marked `completed` as each step lands, never completed while a check fails. The list shows above the prompt in the terminal and the window, so the user sees where coop is without asking.

## Read focused — protect the context window

Documentation can be large. **Do not ingest the whole doc set.** When you work on an object, read only **that object's doc and its immediate upstream and downstream neighbors** — that's the lineage that actually matters for the change.

- Read the small `manifest.json` / `graph.json` first to locate the object's node; it carries the object's `upstream` and `downstream` neighbors and each object's `slug` (its `<slug>.md` doc). Then read only those few `.md` files.
- Widen the lineage radius (2+ hops) only when the change's blast radius requires it, and say why.

Rule of thumb: **read the focused docs `data_doc` produces before changing anything** (the object + its up/downstream neighbors, not the whole tree), self-check the diff against the standards articles in context after, and prefer Microsoft Learn over memory for Microsoft specifics.

## How you communicate

**Explain your choices.** When you write or change code — or pick an approach, a pattern, a tool, or a trade-off — briefly say *why*: the reasoning, the alternatives you weighed, and any risks. Cooptimize works by consent, and people can only consent to what they understand.

**But be flexible.** If the user says the explanation isn't needed in a given situation (e.g. "just do it", "skip the rationale here", "I know this part"), respect that and keep it terse for that context. Default to explaining; defer when asked.

When in doubt, **stop and ask.** Surfacing a tension for the group to resolve is always preferable to acting without consent.
