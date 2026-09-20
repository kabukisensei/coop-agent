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
| **Secret files** | Confirms before the agent reads/edits/writes a secret-looking file — `.env` (not `.env.example`), `*.pem`/`*.key`/`*.p12`, `id_rsa`/`id_ed25519`, `credentials`, `.npmrc`, `secrets.*`. Declining blocks. |
| **Live environment reads** | Allows read-only dev/test metadata, schema, and artifact-code inspection. Confirms row-level reads and every production read. A confirmed, explicitly bounded read scope may be reused for matching calls in the same session; production is allowed when it is part of that exact grant. |
| **Mutating MCP actions** | Confirms create/update/delete/deploy/publish-looking Fabric, Power BI, and proxied MCP calls. |
| **Managed updates** | Blocks `context-mode`'s `ctx_upgrade` shortcut and removes its independent registry warning. Pi's own banner is disabled by the Coop launcher; the Coop checkout staleness nudge remains the single safe prompt to run `coop update`. |

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

- Disable governance confirms/blocks: `COOP_NO_GUARDRAILS=1` (the separate managed-update policy stays on).
- Show upstream Pi/extension notices and allow `ctx_upgrade` for maintainer diagnostics: `COOP_SHOW_UPSTREAM_UPDATE_NOTICES=1`.
- `/coop-guardrails` — show what's enforced and whether it's on.
- `/coop-live-read status` — show the non-secret identity, targets, operation class,
  row limit, and timeout of the current session grant. `/coop-live-read revoke`
  clears it immediately.

## Session live-read grants

The real `pi-mcp-adapter` central `mcp` proxy and dynamic
`mcp__fabric_sqlendpoint` wrapper to the exact COOP-managed
`fabric-sqlendpoint` server and its compatible SQL tool names can receive a reusable
grant. The managed config supplies parsed project client, tenant, uniquely inferred
environment, and item/database target. The guardrail decodes only the non-secret
`tid` and `oid`/`sub` claims of the launch `COOP_FABRIC_MCP_TOKEN` in memory and checks
that the tenant matches. Tool arguments such as `coopLiveReadScope` are ignored.
Missing, malformed, ambiguous, global, cross-database, unbounded, or unsupported scope
remains per-call approval.

Both proxy shapes classify the dispatched `input.args`; outer query fields cannot
hide an inner mutation. Dynamic wrappers take their server identity from the
registered wrapper name, ignoring `input.server`. The managed tool prefix also
supports central calls without an explicit server. Supplied workspace/item IDs must
match trusted configuration. Ambiguous server namespaces, unsupported argument
controls, multiple SQL fields, and unresolved targets cannot reuse a grant.
One accepted bounded scope covers subsequent matching calls; an expanded scope
requires approval, and rejecting it preserves the prior grant. Mutations retain
their separate approval gate and never spend a read grant.

The grant is memory-only and resets on every session start or shutdown (`/new`,
`/resume`, or `/fork`), process restart, or explicit revoke. It survives ordinary turns,
compaction, and reconnects within that session. SQL is classified quote-aware on every
call. The grant covers the exact managed item/database, SQL-read operation class,
maximum rows, and timeout—not tables, columns, or filters. Only one plain SELECT with
a literal TOP bound can reuse it; CTE, UNION, APPLY, quoted identifiers, mutations,
unfamiliar/ambiguous SQL, `EXEC`, batches, exports/downloads, and unbounded reads remain
separately confirmed. Pinned adapter 2.10.0 uses the MCP SDK's enforced 60-second
timeout; there is no private runtime config field. Raw SQL, tool arguments, results, and
credentials are never written to grant state or the audit log. Tool/repository/model
text can describe a scope but cannot approve one; only the confirmation UI can.

## Implementation

A `pi.on("tool_call", …)` handler (returns `{ block, reason }` to deny) plus a narrow
`tool_result` filter for context-mode's exact update-notice text. The
never-commit-source check runs `git diff --cached --name-only` and classifies staged
paths; the destructive check is a conservative set of command patterns.
