# coop-guardrails

Runtime **enforcement** of Cooptimize's governance rules — the coop-native
replacement for the third-party `@aliou/pi-guardrails` (which was pinned to the old
`@mariozechner` Pi). Loaded at launch via `pi -e` (nothing to install).

`docs/guardrails.md` is the **advisory** system prompt (it asks the model to behave).
This extension hooks the agent's **tool calls** and actually **enforces** the rules
the model could slip on. It enforces the *agent's* tool calls — **your own shell is
never intercepted**.

## What it enforces

| Rule | Behavior |
| --- | --- |
| **Never commit source** | Blocks a `git commit` whenever staged files include anything outside the allow-listed docs/logs/site paths. Policy comes from a per-session snapshot of the `repositories:` entries in `.coop/project.yml` (`agent_allowed_to_commit` / `agent_never_commit`), resolved from the session directory so sibling repositories inherit their configured rules (plus conservative defaults: `docs/`, `site/`, `data-docs/`, `data-docs-site/`, any `*.md`). Editing the contract mid-session never weakens the active policy; `.coop/project.yml` itself is not agent-committable. The agent may still commit docs/logs/site; a human commits source. |
| **Destructive commands** | Confirms (via a dialog) before `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, and `DROP`/`TRUNCATE` SQL. Declining blocks the command. |
| **Fabric writes from the shell** | Confirms before `az rest` with a non-GET method, `fab api -X post|patch|put|delete`, and mutating `fab` subcommands (`deploy`, `mkdir`, `rm`, `set`, `import`, `job`, ...), which the official Microsoft Fabric skills use for item create/update/deploy/delete. Reads pass. |
| **Power BI Desktop reloads** | Reads `powerbi-desktop status` before `powerbi-desktop reload` and before a `powerbi-report-author preview` that reloads the live Desktop window (bare, `--reload`, `--reload-with-model`; `--status`, `--screenshot`, `--close` and `--host service` pass). The bridge's reload discards unsaved Desktop edits unconditionally, so an instance with `hasUnsavedChanges: true` asks first (headless: blocked), and an instance coop cannot verify (no status, not connected, pid missing, flag unstated) is blocked. The instance is picked by `--pid`, else by the preview's `.Report` folder, else every connected instance must be clean. |
| **Secret files** | Confirms before the agent reads/edits/writes a secret-looking file — `.env` (not `.env.example`), `*.pem`/`*.key`/`*.p12`, `id_rsa`/`id_ed25519`, `credentials`, `.npmrc`, `secrets.*`. Declining blocks. |
| **Live environment reads** | Allows read-only dev/test metadata, schema, and artifact-code inspection. Confirms row-level reads and every production read. A confirmed, explicitly bounded read scope may be reused for matching calls in the same session; production is allowed when it is part of that exact grant. |
| **Mutating MCP actions** | Confirms create/update/delete/deploy/publish-looking Fabric, Power BI, and proxied MCP calls. |
| **Production writes** | Runs SQL DDL/DML on a production target, Power BI Modeling edits after a production connection, and Fabric or shell writes that name production only with a person's separate, time-limited go-ahead for that client, and then each one asks a yes/no at the desk; without it they are blocked. Never session-wide, never headless, never from the phone; every attempt is audited. A session can never give itself the go-ahead. |

When a tool call is blocked, the model receives a `reason` explaining why and what to
do instead (e.g. "unstage source and let a human commit").

## Design

- **Fail closed for enforcement exceptions.** Headless mutations/destructive
  commands and ambiguous Git wrappers block. An exception escaping enforcement,
  including a throwing/rejected approval dialog, blocks the affected call with a
  fixed reason that excludes exception text. It cannot create a new live-read grant.
- **Optional display/logging remains best-effort.** A failed audit write or status
  notification does not change the enforcement decision or crash Pi.
- **Interactive confirms only.** Approval-required actions fail closed when no
  confirmation UI is available. The never-commit-source block needs no UI and
  always applies.

Audit command gates persist fixed classifications instead of command text or
arguments. The status command also suppresses legacy command details when displaying
history, without rewriting or deleting existing records. Historical raw audit files
may still contain command text and are not sanitized exports.

## Toggle & inspect

- Disable governance confirms/blocks: `COOP_NO_GUARDRAILS=1`.
- Show Pi's own update banner for maintainer diagnostics: `COOP_SHOW_UPSTREAM_UPDATE_NOTICES=1` (read by the Coop launcher).
- `/coop-guardrails` — show what's enforced and whether it's on.

## Live reads

Reads need no approval on any environment, production included; only changes do. A plain SQL read through the COOP-managed `fabric-sqlendpoint` entry or the native `fabric_sql_query` tool resolves its target from coop's own configuration and the launch identity, never from tool arguments, and is audited without SQL, arguments or results. A target or identity that does not resolve, and reads coop cannot classify, ask. Detail: `docs/guardrails-reference.md`, Live environment reads.

## Implementation

A `pi.on("tool_call", …)` handler (returns `{ block, reason }` to deny). The
never-commit-source check runs `git diff --cached --name-only` and classifies staged
paths; the destructive check is a conservative set of command patterns.
