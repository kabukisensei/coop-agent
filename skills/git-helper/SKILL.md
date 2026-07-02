---
name: git-helper
description: Draft Conventional-Commits messages and PR descriptions from the current diff. Drafts only — never commits, pushes, or merges source; a human commits source (docs/logs/site commits stay approval-gated per guardrails).
---

# Git helper — commit messages & PR descriptions (drafts only)

Use this skill when the user asks for a commit message, a PR description, or a
review-ready summary of the working tree. coop never commits source (guardrails
rule 4) — a human does — so the job here is to make the human's commit effortless.

## Gather (read-only)

1. `git status` and `git diff --stat` — the shape of the change.
2. `git diff` for the files that matter; use `git diff -- <paths>` to separate
   source changes from docs/logs/site changes.
3. If SQL / DAX / semantic-model objects changed, note the lineage impact
   (`data_doc` tool, `command="lineage"`) and any `sql_review` / `dax_review`
   findings from this session.

## Commit message (Conventional Commits)

- Format: `type(scope): imperative summary` — types: `feat`, `fix`, `docs`,
  `refactor`, `perf`, `test`, `chore`. Subject ≤ 72 chars; body explains *why*.
- One logical change per message. If the diff mixes concerns, say so and give
  one message per proposed commit.
- Example: `fix(warehouse): guard fact_sales load against duplicate order lines`

## PR description

Output a draft with these sections:

- **Summary** — what changed and why, in plain language.
- **Changes** — a bullet per file/object.
- **Lineage impact** — upstream/downstream objects affected (from `data_doc`).
- **Standards & validation** — `sql_review` / `dax_review` / Tabular Editor BPA /
  `fabric-cicd` validate results and any tests run.
- **Rollback** — how to revert safely (backups, `git checkout` of uncommitted edits).

## Hard rules

- **Never run `git commit`, `git push`, `git merge`, or `git tag` from this
  skill.** Output drafts; the human commits. (Docs/logs/site commits remain
  allowed elsewhere only with explicit approval, per guardrails — this skill
  itself only drafts.)
- Report only validation that actually ran — never invent results.
- Never include secrets in messages or descriptions.
