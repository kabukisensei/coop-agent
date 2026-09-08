# /share-learning

Use the `team-knowledge` skill.

Draft a team learning note from this session's discoveries, corrections, or reusable patterns to share with the team.

## Note location and format

Draft into `<knowledge-clone>/learnings/<title-slug>-<YYYY-MM-DD>.md` (locate the clone via `~/.coop/config` `knowledge.repos[*].local_path`, typically `~/.coop/knowledge/incremental-bi/learnings/`).

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
- **Publication via PR only**: NEVER commit directly to main of the knowledge repo. On user approval, create a branch and open a PR / run `teamai push` (if installed) or guide the user to submit a pull request.
