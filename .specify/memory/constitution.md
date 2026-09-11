# coop-agent Constitution

## Core Principles

### I. Paired-Script Parity (NON-NEGOTIABLE)

Every edit to `bin/coop`, `lib/common.sh`, or `scripts/*.sh` must be ported to its
`.ps1` twin in the same change, and vice versa. `lib/common.ps1` is the sole shared
helper library — helper changes never live in per-script inline copies.
`scripts/check-parity.sh` gates this on every change. Every `.ps1` keeps its UTF-8
BOM (`EF BB BF` first three bytes); after any `.ps1` edit, re-run the parity check.

Rationale: the sh/ps1 twins are the cross-platform contract of the product. Drift
between them ships platform-specific breakage that CI catches late or not at all.

### II. Bash 3.2 Compatibility

All bash written in this repo targets macOS stock `/bin/bash` (3.2). Prohibited:
associative arrays, `${var,,}` lowercase expansion, `mapfile`/`readarray`,
`&>>` redirect. `scripts/install.sh` especially must stay 3.2-clean.

Rationale: macOS ships bash 3.2 and never upgrades it; developers and CI on newer
bash will not catch 4.x-only syntax, but every macOS user hits it immediately.

### III. Verify Before Declaring Done

No change is complete until its verification gates pass:
- `bash -n` on every edited shell script (and pwsh parse-check on edited `.ps1`)
- `bash scripts/check-parity.sh` — expect "✓ parity check passed"
- `bash tests/run.sh` — expect "✓ all tests passed" (requires node + npx)
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
- **Cross-platform reality:** the product runs on macOS and Windows workstations;
  developing the repo works headless on Linux, but workstation-only operations
  (`coop install`, `coop doctor`) are never attempted from a headless box.
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
verification gates in Principle III. Where AGENTS.md, CONTRIBUTING.md, or
RELEASE.md conflict with this document, this document prevails and those files
are amended to match. Runtime development guidance remains in AGENTS.md.

**Version**: 1.0.0 | **Ratified**: 2026-09-11 | **Last Amended**: 2026-09-11
