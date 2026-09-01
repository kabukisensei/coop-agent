# coop-guardrails

Runtime **enforcement** of Cooptimize's governance rules — the coop-native
replacement for the third-party `@aliou/pi-guardrails` (which was pinned to the old
`@mariozechner` Pi). Loaded at launch via `pi -e` (nothing to install).

`docs/guardrails.md` is the **advisory** system prompt (it asks the model to behave).
This extension hooks the agent's **tool calls** and actually **enforces** the two rules
the model could slip on. It enforces the *agent's* tool calls — **your own shell is
never intercepted**.

## What it enforces

| Rule | Behavior |
| --- | --- |
| **Never commit source** | Blocks a `git commit` whenever staged files include anything outside the allow-listed docs/logs/site paths. Policy comes from a per-session snapshot of the `repositories:` entries in `.coop/project.yml` (`agent_allowed_to_commit` / `agent_never_commit`), resolved from the session directory so sibling repositories inherit their configured rules (plus conservative defaults: `docs/`, `site/`, `data-docs/`, `data-docs-site/`, any `*.md`). Editing the contract mid-session never weakens the active policy; `.coop/project.yml` itself is not agent-committable. The agent may still commit docs/logs/site; a human commits source. |
| **Destructive commands** | Confirms (via a dialog) before `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, and `DROP`/`TRUNCATE` SQL. Declining blocks the command. |
| **Secret files** | Confirms before the agent reads/edits/writes a secret-looking file — `.env` (not `.env.example`), `*.pem`/`*.key`/`*.p12`, `id_rsa`/`id_ed25519`, `credentials`, `.npmrc`, `secrets.*`. Declining blocks. |
| **Managed updates** | Blocks `context-mode`'s `ctx_upgrade` shortcut and removes its independent registry warning. Pi's own banner is disabled by the Coop launcher; the Coop checkout staleness nudge remains the single safe prompt to run `coop update`. |

When a tool call is blocked, the model receives a `reason` explaining why and what to
do instead (e.g. "unstage source and let a human commit").

## Design

- **Fail closed for approval-required actions.** Headless mutations/destructive
  commands and ambiguous Git wrappers block. Unexpected extension faults stay isolated. The
  system prompt still guides in that case.
- **Feature-detected + try/catch** so it can never crash pi.
- **Interactive confirms only.** The destructive-command gate needs a UI; in
  print/RPC mode it lets commands through (the system prompt still applies). The
  never-commit-source block needs no UI and always applies.

## Toggle & inspect

- Disable governance confirms/blocks: `COOP_NO_GUARDRAILS=1` (the separate managed-update policy stays on).
- Show upstream Pi/extension notices and allow `ctx_upgrade` for maintainer diagnostics: `COOP_SHOW_UPSTREAM_UPDATE_NOTICES=1`.
- `/coop-guardrails` — show what's enforced and whether it's on.

## Implementation

A `pi.on("tool_call", …)` handler (returns `{ block, reason }` to deny) plus a narrow
`tool_result` filter for context-mode's exact update-notice text. The
never-commit-source check runs `git diff --cached --name-only` and classifies staged
paths; the destructive check is a conservative set of command patterns.
