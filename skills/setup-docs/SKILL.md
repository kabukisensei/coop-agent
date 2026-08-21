---
name: setup-docs
description: Native in-agent wizard to create or update coop-data-doc.yml and build the lineage docs entirely through the agent (no terminal). Spawns coop-data-doc setup --transport jsonl and forwards each prompt/choice through the agent UI. Read-only-first; writes the config and builds only with approval.
---

# Set up data docs (in-agent wizard)

## Purpose

Stand up `coop-data-doc` for a workspace **through the agent**, so a teammate's
first touch needs no terminal. The interactive terminal wizard (`coop data-doc
setup`) renders a folder checkbox with prompt_toolkit, which can't run as a
subprocess of the agent. Instead, we launch `coop-data-doc setup --transport
jsonl` and forward each prompt through the agent UI. The result is identical:
the same `coop-data-doc.yml`, the same build.

Run inside `coop-workflow`. Read-only-first: confirm before writing the config
and before building (consent rounds). Never commit source.

## Required tool version

This flow requires **coop-data-doc ≥ 1.1.0** (the first release that ships the
`--transport jsonl` flag and the WizardIO protocol). If `coop-data-doc --version`
reports an older version, run `coop update` first and do **not** fall back to the
old config-set/folders/set-folders manual flow.

## JSONL transport contract

`coop-data-doc setup --transport jsonl` emits one JSON object per line on stdout
and expects one JSON object per line on stdin. The process stays alive for the
whole session.

Prompt event (stdout):

```json
{"type":"prompt","id":"q1","kind":"text","message":"Project name ...","default":"Coop BI Estate","choices":[]}
```

Kinds: `text`, `path`, `confirm`, `select`, `checkbox`.
For `select` and `checkbox`, `choices` contains `{label, value, checked}`.

Answer (stdin):

```json
{"id":"q1","answer":"My Project"}
```

The `id` MUST match the prompt's `id`.

Other events the process may emit (display, do not reply):

- `{"type":"notice","message":"..."}`
- `{"type":"progress","message":"..."}`
- `{"type":"complete","data":{"config":"coop-data-doc.yml"}}`
- `{"type":"error","message":"..."}`
- `{"type":"cancelled"}` (or process exits 130)

## Flow

1. **Inspect.** Read `.coop/project.yml` if present (repo paths may already be
   configured). Run `coop-data-doc --version` to confirm the JSONL transport is
   available.
2. **Launch the JSONL wizard.** Run `coop-data-doc setup --transport jsonl` as a
   subprocess with a PTY/TTY wrapper if needed, capturing stdout/stdin.
3. **Forward prompts.** For each `prompt` event, render it through the agent UI:
   - `text` / `path` → single-line `ask-user-question` with the prefilled default.
   - `confirm` → yes/no `ask-user-question`.
   - `select` → single-choice `ask-user-question` from `choices` labels; map the
     chosen label back to its `value`.
   - `checkbox` → multi-select `ask-user-question`; map checked labels back to
     their `value`s.
   Send `{"id":"<same id>","answer":...}` back to the process.
4. **Display notices/progress.** Surface `notice` and `progress` events to the
   user.
5. **Complete.** When the process emits `complete` or exits 0, the config is
   written. Show the saved path and a summary (project name, repo paths).
6. **Build (with approval).** Confirm, then `coop-data-doc build --non-interactive`.
   Show the portal path and any unresolved cross-repo links. Offer to resolve
   ambiguous links with the existing `resolve` / `resolve-apply` flow if needed.

## Guardrails

- **Read-only-first:** nothing is written until the wizard process reports success
  (config written by coop-data-doc, not by the agent). Confirm the build step
  separately.
- **Version gate:** if the installed coop-data-doc does not support
  `--transport jsonl`, stop and tell the user to run `coop update`.
- **Never commit source.** You may commit the generated docs/site only with approval.

## Output

A short summary: the repo paths set, the saved config path, the build result
(objects/edges/unresolved), and the `file://…/index.html` portal link.
