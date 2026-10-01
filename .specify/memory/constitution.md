# coop-agent Constitution

## Core Principles

### I. One Implementation, in PowerShell (NON-NEGOTIABLE)

The product is `bin/coop.ps1`, `lib/common.ps1` (the sole shared helper library,
dot-sourced by `bin/coop.ps1` and every `scripts/*.ps1`; helper changes never live
in per-script inline copies) and `scripts/*.ps1` (master plan S1). `bin/coop` is
only a Git Bash forwarder to `coop.ps1`; `scripts/release.sh`,
`scripts/validate-resources.sh` and `tests/*.sh` are dev tooling. There is no
bash product path and no `.sh` twin of any `.ps1`, so there is no parity to keep.
Every `.ps1` keeps its UTF-8 BOM (`EF BB BF` first three bytes) and parses under
Windows PowerShell 5.1; `scripts/check-bom.ps1` gates the BOM on every change.

Rationale: coop is operated on Windows workstations; a second implementation is a
second place for every bug, and drift between two ships breakage that CI catches
late or not at all.

### II. Windows PowerShell 5.1 Floor

Every `.ps1` runs under Windows PowerShell 5.1 (`bin/coop.cmd`'s runtime) and
pwsh 7. Prohibited: the ternary operator, `??`, `?.`, `clean {}` blocks, and any
other 7-only syntax. Single objects are wrapped in `@()` before `.Count`;
`Get-ChildItem -Include` is never trusted to filter a non-recursive listing.

Rationale: pwsh 7 on a Linux or macOS development box accepts 7-only syntax
silently; every Windows member hits the failure immediately.

### III. Verify Before Declaring Done

No change is complete until its verification gates pass:
- `bash -n` on every edited dev-tooling script and a pwsh parse-check on every
  edited `.ps1`
- `pwsh -NoProfile -File scripts/check-bom.ps1` — expect "✓ BOM check passed"
- `pwsh -NoProfile -File tests/run.ps1` — expect "✓ PowerShell behavioral tests passed (gate lane)"
- `bash tests/run.sh` — expect "✓ all tests passed (gate lane)" (requires node + npx + pwsh)
- Behavior changes carry a slice-specific test: a failing check before the change
  and the same check passing after, run against real data when enabled
- Docs changes: every path, script name, and command referenced must exist in the tree

Rationale: an agent that reports success without running the gates has produced
unverified claims, not finished work.

### IV. Clean Tree; Explicit Instructions Only

Before any work: `git fetch origin && git status --porcelain` (expect clean),
then `git pull --ff-only`. A dirty tree or non-fast-forward pull means stop and
report — never stash, reset, or force to "fix" it. Commits and pushes happen only
when explicitly asked. Releases happen only when Aaron explicitly names the
version or bump level in the current conversation — a clean tree, finished task,
or updated CHANGELOG is never release permission.

Rationale: multiple agents and humans share this repository; implicit actions on
stale assumptions have caused spurious releases and clobbered in-flight work.

### V. Simplicity — No Bloat

Vertical slices by default: the smallest change that delivers the outcome, each
slice independently verifiable. New structure, dependencies, configuration, or
abstraction require justification; YAGNI governs. Approval for any feature is
conditioned on not introducing excessive bloat.

Rationale: this repo is maintained by agents reading it cold; every unnecessary
layer is a permanent tax on comprehension and review.

## Additional Constraints

- **Contract-first:** `.coop/project.yml` is the single source of truth for repo
  paths, workspaces, standards, and approval policy. Read the nearest one before
  file work; preserve unowned fields when editing.
- **Guardrails:** `docs/guardrails.md` applies — read-only first, plan-and-approve,
  back up before edits, never expose secrets, MCP read-only by default.
- **Spec-first:** non-trivial edits start from an approved spec (`/spec-first` in
  the product workflow, or the Spec Kit `speckit-specify → plan` loop for this
  repo's own development).
- **Platform reality:** coop is operated on Windows workstations; developing the
  repo works on any OS with the prerequisites, including headless Linux, but
  workstation-only operations (`coop install`, `coop doctor`) are never attempted
  from a headless box.
- **No secrets, ever:** `.env*`, keys, and tokens are never committed (see
  `.gitignore`). Public artifacts (website, docs) never contain private data.

## Development Workflow

- Conventional commits (`fix:`, `chore:`, `feat:`, `docs:`); one logical change
  per commit; messages state what and why.
- CHANGELOG entries under `[Unreleased]` as changes land; never rewrite shipped
  history headings.
- CI must be green before merge; Windows jobs are first-class, not advisory.
- New features follow the Spec Kit loop — `/speckit-specify` → `/speckit-plan`
  (with `/speckit-checklist` quality gates) → `/speckit-tasks` → implementation
  in vertical slices → `/speckit-converge` until converged.
- Coop's native slice machinery (`/slice-next`, slice-specific tests, optional
  `tests.live_data` hook) is the execution layer beneath Speckit planning for
  multi-step work; the two compose, they do not compete.

## Governance

This constitution supersedes informal practice where they conflict. Amendments
require: a version bump (MAJOR — principle removal/redefinition; MINOR — new or
materially expanded principle; PATCH — clarification/typo), an entry in the Sync
Impact Report, and a `docs:` commit. Compliance is verified in review against the
verification gates in Principle III. AGENTS.md is the canonical operational
guide for working on this repo (CONTRIBUTING.md and RELEASE.md carry its detail);
this document does not supersede it. Where this document and AGENTS.md disagree,
AGENTS.md wins and this document is amended to match in the same change.

**Version**: 2.0.0 | **Ratified**: 2026-09-11 | **Last Amended**: 2026-10-01
