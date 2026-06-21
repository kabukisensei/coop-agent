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
| **Never commit source** | Blocks a `git commit` whenever staged files include anything outside the allow-listed docs/logs/site paths. Reads `approval_policy.agent_allowed_to_commit` from `.coop/project.yml` (plus sensible defaults: `docs/`, `site/`, `data-docs/`, `*-site/`, any `*.md`). The agent may still commit docs/logs/site; a human commits source. |
| **Destructive commands** | Confirms (via a dialog) before `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, and `DROP`/`TRUNCATE` SQL. Declining blocks the command. |
| **Secret files** | Confirms before the agent reads/edits/writes a secret-looking file — `.env` (not `.env.example`), `*.pem`/`*.key`/`*.p12`, `id_rsa`/`id_ed25519`, `credentials`, `.npmrc`, `secrets.*`. Declining blocks. |

When a tool call is blocked, the model receives a `reason` explaining why and what to
do instead (e.g. "unstage source and let a human commit").

## Design

- **Fail-open.** Any error in a guardrail (e.g. git not present, can't read staged
  files) lets the action through — a bug here must never block legitimate work. The
  system prompt still guides in that case.
- **Feature-detected + try/catch** so it can never crash pi.
- **Interactive confirms only.** The destructive-command gate needs a UI; in
  print/RPC mode it lets commands through (the system prompt still applies). The
  never-commit-source block needs no UI and always applies.

## Toggle & inspect

- Disable entirely: `COOP_NO_GUARDRAILS=1` (env var).
- `/coop-guardrails` — show what's enforced and whether it's on.

## Implementation

A single `pi.on("tool_call", …)` handler (returns `{ block, reason }` to deny). The
never-commit-source check runs `git diff --cached --name-only` and classifies staged
paths; the destructive check is a conservative set of command patterns.
