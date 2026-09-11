# /share-learning

Use the `team-knowledge` skill.

Draft a team learning note from this session's discoveries, corrections, or reusable patterns to share with the team.

## Select the knowledge repository FIRST

Team knowledge may span several configured repositories (`~/.coop/config`,
`knowledge.repos[*]` — each with its own `url` and `local_path`). Before
drafting anything:

1. List the configured repositories for the user (label + local path).
2. Ask the user WHICH repository this learning belongs to.
3. Draft into the selected repository only. Never publish a note to a
   repository the user did not pick, and never pick one on the user's behalf.

## Note location and format

Draft into `<selected-knowledge-clone>/learnings/<title-slug>-<YYYY-MM-DD>.md`
(locate the clone via the selected repository's `local_path`, typically
`~/.coop/knowledge/incremental-bi/learnings/`).

Use the standard YAML frontmatter:

```yaml
---
title: <60 chars max descriptive title>
author: <from git config user.name>
date: YYYY-MM-DD
tags: [2-5 tags]
x-coop:
  kind: pattern | antipattern | decision | runbook | troubleshooting | standard | exception
  scope: team
  sensitivity: internal | client-confidential
  status: proposed
  confidence: low | medium | high
---
```

## Structure

1. **Context** — what problem was being solved and where it surfaced.
2. **Learning / Solution** — the concrete pattern, bug fix, or finding discovered.
3. **Implications** — when to apply this, trade-offs, or what to avoid.

## Guardrails and publication rules

- **Secret & client sweep**: Never include client-identifiable names, credentials, connection strings, or internal client URLs. Scrub to generic ERP/Fabric terminology and set `sensitivity: internal`.
- **User review first**: Present the complete drafted note to the user in chat before doing anything else.
- **Publication via PR only**: NEVER commit directly to main of the knowledge repo. Publication is a plain Git branch + pull request in the selected repository: on user approval, create a branch, commit the note there, and open a PR (or guide the user to submit one).
