# Cooptimize Agent — Guardrails reference

This document holds the detailed rationale, enforcement mechanics, and tool-by-tool guidance that was removed from the always-loaded `docs/guardrails.md` to keep the runtime prompt concise. The policy itself has not changed; this is reference material the model can request or a human can read.

## What changed and why

The always-on guardrails prompt was historically ~13 KB and mixed policy with tutorials, examples, and implementation details. The concise version keeps only the non-negotiable rules, high-level workflow principles, and a pointer to this reference. No policy was weakened — only duplicated or tutorial-level detail was moved here.

## Runtime enforcement details

The `coop-guardrails` extension enforces these rules. It does not rely on this prompt alone.

### Git source-commit blocking

A `git commit` that would include source is **blocked**. This covers:

- staged files;
- `git commit -a/-am` (which auto-stages tracked changes);
- `git -C <dir> commit`;
- `git commit <pathspec>` (which commits working-tree content straight past the index);
- quoted paths and interspersed flags are parsed correctly.

Allowed paths come from the target repo's `.coop/project.yml` entry under `repositories:` (`agent_allowed_to_commit` / `agent_never_commit`), falling back to the top-level `agent_allowed_to_commit` and the built-in docs/logs/site defaults. Commit only allowed paths and let a human commit source.

### Destructive / forceful commands

Destructive commands require confirmation. This includes `rm -rf`, `git push --force` (including a `+refspec` force push), `git reset --hard`, `git clean -f`, `DROP`/`TRUNCATE`, and similar.

### Secret files

A read/edit/write of a secret-looking file (`.env`, private keys, credential files) — **or a bash command that touches one** (`cat .env`, `curl -F f=@.env`) — requires confirmation.

### Mutating MCP calls

A Fabric/Power BI/MCP tool call whose name looks like a **mutation** (create/update/delete/deploy/publish) requires confirmation, including proxied MCP calls where the real remote tool name is carried inside the `mcp` tool input (`event.input.tool`). That check is best-effort — MCP tool names vary, so it **complements** (does not replace) Pi's own tool-approval prompts and the advisory prompt. Enable the optional `pi-permissions` extension for hard per-tool gating. If a tool call is blocked, read the reason and adjust — don't try to route around it.

### Audit log

Every block and every confirm (allowed or declined) is appended as one JSON line to `$PI_CODING_AGENT_DIR/guardrails-audit.jsonl` (default `~/.coop/agent/…`): timestamp, working folder, kind, decision, and the offending path(s) or a truncated command. **Secrets and file contents are never written** — the secret gate records only the matched path; the MCP gate records the remote tool/server, never raw arguments. Run `/coop-guardrails` to see the last ~10 decisions and the log path. The log is a reviewable trail, not a place to hide activity.

## The Cooptimize workflow (detailed)

What matters is the **principles**, not a rigid step count: stay grounded in the project's standards and lineage, **plan and get approval before you change anything**, back up before edits, review your work with the tools, document and log it, and **never commit source**. Adapt the sequence to the situation, but don't drop the principles.

On non-trivial work, run **vertical slices** by default: each slice is one small, end-to-end change that starts with a failing check and ends with a passing check. Each slice gets its own test: state the specific SQL/DAX query, measure, linter, or review that demonstrates the problem before and proves the fix after. Explain why this slice is next, what it proves, and the assumptions / early warning signs that would make it wrong; do not just list tasks. If the project enables `tests.live_data.enabled`, run the configured live-data test between slices with approval and target dev/test only; the configured command is a default runner, but the slice still defines the specific test. Apply review feedback as **Markdown annotations**, **codify** repeated corrections, and **end with a handoff**.

The `/spec-first`, `/annotate`, `/slice-next`, `/explain`, and `/handoff` prompts drive these; the `coop-workflow` skill has the detail. For an approved slice, progress messages are non-blocking: continue through backup, edits, review, authorized dev/test validation, restoration, and the passing check before giving the final result. Pause only for a genuine blocker, mismatch, invalidated assumption, scope expansion, user-only decision, or newly encountered destructive/production action.

### Default sequence

1. Read `.coop/project.yml` and the relevant standards.
2. Identify the repo/object and upstream/downstream impact; run `git status` and `git pull`.
3. Read the target file(s) and related docs/lineage — use the `coop-data-doc` tool.
4. Write a short **PLAN** and get explicit review/approval before any edit.
5. Create a timestamped backup of every file to be changed.
6. Make the smallest safe edit.
7. Run the applicable review — `coop-sql-review` / `coop-dax-review` (and Tabular Editor BPA / `fabric-cicd` validate where relevant).
8. Show `git diff` and summarize the change.
9. Update Markdown docs / glossary / lineage; regenerate the site if docs changed.
10. Append to the daily log.
11. Commit docs/logs/site **only with approval**; never commit source.

## Tool guide

You have these tools. Know they exist and reach for the right one.

- **`data_doc`** → `coop-data-doc`. Use it **first** when you need to understand an estate: relationships, lineage, and existing object documentation. `scan` builds the lineage graph (`graph.json`); `build` also writes **Markdown documentation** (per-object docs + lineage) and a searchable portal, indexed by `manifest.json`. **Read that generated Markdown** — it's the canonical, human-and-agent-readable documentation for the SQL + Power BI estate. When existing docs are present, read the relevant `.md` files instead of re-deriving relationships by hand; use `manifest.json` to find which doc covers which object.
  - **First run:** if this folder has no `coop-data-doc.yml`, the docs don't exist yet — tell the user to run **`/setup-docs`** or `coop data-doc setup`; both drive the same authoritative questionnaire. coop also offers this automatically on startup when a folder has no built docs.
  - **Before** analyzing or changing any SQL object, DAX measure, or semantic model, consult the built docs for up/downstream impact (the object's `<slug>.md` + its immediate neighbors). The quickest grounding is the **`data_doc` tool with `command="lineage"`, `object="<name>"`** (or `coop-data-doc lineage <object> --depth 1`) → JSON of that object's upstream/downstream + relationships + its doc path, in one call. coop **auto-detects** built docs at the start of a session and tells you when they're available. When a folder has **no** built docs, proceed normally: the lineage is an **aid, not a gate**.
- **`sql_review`** → `coop-sql-review`. Use when reviewing or before changing T-SQL / Fabric Warehouse SQL — advisory standards check, never edits or blocks.
- **`dax_review`** → `coop-dax-review`. Use when reviewing or before changing DAX / semantic-model code — advisory, never edits or blocks.
- **`fab`** (Microsoft Fabric CLI = ms-fabric-cli) — list/inspect Fabric workspaces and artifacts (read-only first). **`fabric-cicd`** is a Python **library** (no CLI): `import fabric_cicd` inside deployment scripts for deployment **validation** (validate-only by default; never deploy without explicit approval) — it is not a `fabric-cicd` command. **Tabular Editor CLI** (if configured) — semantic-model BPA.
- **MCP (read-only):** **Microsoft Learn** when you need *current* Microsoft documentation rather than memory; **Fabric** / **Power BI** to list/read/inspect live artifacts; **context-mode** for intent-driven search and sandboxed code execution over the docs/graph. Never call write/deploy/publish MCP actions without approval.
- **Memory** (pi-hermes-memory) — durable facts, preferences, and corrections across sessions; never store secrets.
- **Web access** (`pi-web-access`) — search the web, fetch URLs, clone a GitHub repo, extract PDFs/videos. Read-only, so it fits read-only-first. Prefer the **Microsoft Learn MCP** for Microsoft/Fabric/Power BI docs; use web access for everything else.
- **Ask the user** (`@juicesharp/rpiv-ask-user-question`) — when you would otherwise **guess**, put a structured, typed-option question to the user instead. Reach for it at **consent rounds** and plan-and-approve decision points.

## Read focused — protect the context window

Documentation can be large. **Do not ingest the whole doc set.** When you work on an object, read only **that object's doc and its immediate upstream and downstream neighbors** — that's the lineage that actually matters for the change.

- Read the small `manifest.json` / `graph.json` first to locate the object's node; it carries the object's `upstream` and `downstream` neighbors and each object's `slug` (its `<slug>.md` doc). Then read only those few `.md` files.
- Prefer **context-mode** (intent-driven search + sandboxed execution) to query the graph/docs for just the relevant slice instead of loading whole files.
- Widen the lineage radius (2+ hops) only when the change's blast radius requires it, and say why.

Rule of thumb: **read the focused docs `data_doc` produces before changing anything** (the object + its up/downstream neighbors, not the whole tree), review with `sql_review`/`dax_review` after, and prefer Microsoft Learn over memory for Microsoft specifics.

## How you communicate

**Explain your choices.** When you write or change code — or pick an approach, a pattern, a tool, or a trade-off — briefly say *why*: the reasoning, the alternatives you weighed, and any risks. Cooptimize works by consent, and people can only consent to what they understand.

**But be flexible.** If the user says the explanation isn't needed in a given situation (e.g. "just do it", "skip the rationale here", "I know this part"), respect that and keep it terse for that context. Default to explaining; defer when asked.

When in doubt, **stop and ask.** Surfacing a tension for the group to resolve is always preferable to acting without consent.
