# `_microsoft/` — official Microsoft skills (subordinate, opt-in)

This folder holds **official Microsoft agent skills**
([github.com/microsoft/skills](https://github.com/microsoft/skills), MIT — 175
Azure-SDK / AI-Foundry skills). They are wired to be **subordinate to Cooptimize
skills**: yours always win.

A Microsoft skill is surfaced by coop only when **all** of these are true:

1. it is **allow-listed** in `microsoft_skills.allow[]` in `.coop/project.yml`, and
2. it does **not conflict** with a Cooptimize skill — by folder name *or* by
   frontmatter `name:`. On any conflict, coop **skips the Microsoft skill** and
   keeps ours (you'll see a `skipping Microsoft skill …` warning).

Empty `allow[]` (the default) loads **none** — matching Microsoft's own guidance to
"use skills selectively" and avoid context rot.

## Fetching

Fetched skills are **not vendored** into this repo (they're gitignored), so coop-agent
stays small and the Microsoft skills update independently. Pull the allow-listed,
non-conflicting ones with:

```bash
scripts/fetch-microsoft-skills.sh
```

It shallow-clones the source into `.cache/microsoft-skills` (gitignored) and copies
each allow-listed skill into `skills/_microsoft/<name>/`.

## Adding a Microsoft skill

1. Find the skill's folder name in the source (e.g. `azure-cosmos-db-py`).
2. Add it to `microsoft_skills.allow[]` in `.coop/project.yml`.
3. Run `scripts/fetch-microsoft-skills.sh`.
4. Run `coop` — it loads only allow-listed, non-conflicting skills.

## Guardrails

- Subordinate + opt-in: presence is never enough; a skill must be allow-listed and
  conflict-free to activate.
- Microsoft skills run under the Cooptimize guardrails (`docs/guardrails.md`) and the
  `coop-workflow` 11 steps: read-only first, plan-and-approve, never commit source,
  MCP read-only.
- Only files inside `coop-agent` are managed here; the upstream Microsoft source is
  never modified.
