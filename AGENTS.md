# coop-agent — agent context

This repository is **coop**, the Cooptimize terminal agent: a branded layer on top
of Pi (`@earendil-works/pi-coding-agent`). It is **not** a fork of Pi. coop runs Pi in
its own isolated agent dir (`~/.coop/agent`, via `PI_CODING_AGENT_DIR`) so only
Cooptimize's curated extensions/settings/theme/MCP load and your personal `pi` stays
untouched (disable with `COOP_NO_ISOLATE=1`). It renders its own footer and splash via
`extensions/coop-powerline` — no third-party powerline footer.

If you are an agent working in a Cooptimize work repo, you operate under the
Cooptimize guardrails and the Cooptimize workflow:

- **Guardrails:** `docs/guardrails.md` (read-only first, plan-and-approve, never
  commit source, back up before edits, never expose secrets, MCP read-only).
- **Workflow:** the `coop-workflow` skill — the Cooptimize workflow for any task.
  On non-trivial work: `/spec-first` (approved spec before editing), `/annotate`
  (apply only Markdown-annotated feedback), `/handoff` (resume-cold summary), and
  the `git-helper` skill / `/pr-description` (draft commit message + PR from the
  diff — drafts only, never commits).
- **Contract:** `.coop/project.yml` is the single source of truth (repo paths,
  Fabric/Power BI workspaces, standards, backup/log rules, approval policy). Read
  the nearest one before doing file work.

Native tools available: `sql_review`, `dax_review`, `data_doc` (advisory, read-only),
plus the Microsoft Fabric CLI (`fab` = ms-fabric-cli) and `fabric_cicd` (a validate-only
Python **library**, not a CLI — `import fabric_cicd` in deployment scripts), and
read-only Fabric / Power BI / Microsoft Learn MCP servers. Persistent memory is provided
by pi-hermes-memory.

`data_doc` wraps `coop-data-doc` with commands `scan` (default; builds the lineage
graph, read-only), `build` (also writes Markdown docs + portal, indexed by
`manifest.json`), `check` (CI staleness gate), and `lineage` (returns ONE object's
upstream/downstream + relationships as JSON from the built graph). **Lineage policy:**
BEFORE analyzing or changing any SQL object, DAX measure, or semantic model, look up
its lineage (`data_doc` with `command="lineage"`, `object="<name>"`) so you know its
up/downstream impact — don't re-derive it by hand. coop **auto-detects** built docs at
session start (a `before_agent_start` hook injects an agent-visible, human-hidden note
when they exist) and **degrades gracefully** when they're absent: lineage is an aid, not
a gate, so proceed without it and, if useful, suggest `/setup-docs`.

Official Microsoft skills (`skills/_microsoft/`) are **subordinate**: a Microsoft
skill loads only if allow-listed in `microsoft_skills.allow[]` and it does not
conflict with a Cooptimize skill — yours always win.

The in-agent `/setup-docs` command (and a `setup-docs` skill) runs a native wizard to
create or rebuild lineage docs for the current folder without leaving the session;
`coop-data-doc.yml` and the built docs are committable, source is never touched.

For setup and commands — including `coop install`'s automatic `PATH` linking
(it adds `~/.local/bin` / `%LOCALAPPDATA%\coop\bin` and prompts you to open a new
terminal) and `coop doctor`'s dependency checks — see `README.md`. For how coop calls
the standalone tools, see `docs/tool-contract.md`. To add custom skills/prompts/tools,
see `docs/extending.md`.

---

## Maintaining this repo (for agents working ON coop-agent)

Everything below is for an agent editing coop-agent itself — scripts, docs, tests,
skills, extensions. This file is canonical; `CONTRIBUTING.md` and `RELEASE.md`
carry the detail and align with it.

### Platform notes

- **Developing this repo** — editing scripts/docs/tests and running the checks
  below — works on any OS with the prerequisites, including a headless Linux box.
- **Operating coop on a workstation** — `coop install`, launching `coop`,
  `coop web`, `coop doctor`, anything needing Pi/pipx/Fabric — is a Mac/Windows
  workstation activity. From a headless box, do not attempt these; report that
  they need a workstation instead.
- `docs/troubleshooting.md` §1 (split Node toolchains, `/opt/homebrew`) and the
  Homebrew `fab` collision are **Aaron's-Mac-specific**. A normal Linux box has
  one `npm` and no `/opt/homebrew` — never chase those paths there.
- Cross-repo work (see `RELEASE.md`) assumes all coop-* repos are cloned **side
  by side under one parent directory** (on Aaron's Mac: `~/Developer`). If a
  sibling repo is missing, stop and report — don't clone or guess paths.

### Environment (prerequisites for the checks)

- Required: `git`, `bash` (any version ≥ 3.2 runs the scripts — but everything you
  **write** must stay 3.2-compatible), `python3` (no PyYAML), Node.js + `npx`
  (the test suite bundles the extensions with esbuild).
- Optional: `shellcheck` (CI runs it — run locally when installed:
  `shellcheck -S warning -e SC1091 bin/coop lib/common.sh scripts/*.sh tests/*.sh`),
  and `pwsh` (PowerShell 7 — available on Linux) to parse-check any `.ps1` you edit.

### Before any work

```bash
git fetch origin && git status --porcelain   # expect: no output (clean tree)
git pull --ff-only
```

If the tree is dirty or the pull can't fast-forward, **stop and report** —
another agent or Aaron may be mid-work in this tree. Never stash, reset, or
force anything to "fix" it.

### Hard rules when editing code (detail: CONTRIBUTING.md)

1. **Paired scripts stay in sync.** Any edit to `bin/coop`, `lib/common.sh`, or
   `scripts/*.sh` must be ported to the matching `.ps1` in the same change (and
   vice versa). `scripts/check-parity.sh` gates the pairing.
2. **Every `.ps1` keeps its UTF-8 BOM** (`EF BB BF` as the first three bytes).
   Editors and agent write-tools silently strip it on rewrite — after every
   `.ps1` edit, re-run `bash scripts/check-parity.sh` (it gates the BOM and
   prints the exact fix command for any file missing it).
3. **All bash stays bash-3.2 compatible** (macOS stock `/bin/bash`) —
   `scripts/install.sh` especially. No associative arrays, `${var,,}`,
   `mapfile`, or `&>>`.

### Verify after every change

```bash
for f in bin/coop lib/common.sh scripts/*.sh tests/*.sh; do bash -n "$f"; done
                                # expect: no output, exit 0
bash scripts/check-parity.sh    # expect: "✓ parity check passed", exit 0
bash tests/run.sh               # expect: "✓ all tests passed", exit 0 (needs node + npx)
```

For docs-only changes, verify instead that every file path, script name, and
command you wrote actually exists in the tree before finishing.

### Releases — explicit instruction ONLY

Release **only when Aaron explicitly asks for a release in the current
conversation, naming the version or bump level.** A clean tree, a finished task,
or an updated CHANGELOG is **never** permission to release — on 2026-07-02 an
agent cut a spurious empty release from exactly that inference while another
agent shared the working tree. Never push `v*` tags, never force-push, never
delete or re-push a tag, never commit secrets (`.env*`, keys, tokens — see
`.gitignore`). Commits and pushes likewise happen only when asked. Runbook:
`RELEASE.md`.

### Doc map — operational truth vs. plans

- **Operational (follow these):** `AGENTS.md`, `CONTRIBUTING.md`, `RELEASE.md`,
  `README.md`, `docs/architecture.md`, `docs/extending.md`, `docs/guardrails.md`,
  `docs/onboarding.md`, `docs/tool-contract.md`, `docs/troubleshooting.md`.
- **Plans / history (context only — never execute their steps without an
  explicit request):** `docs/ui-strategy.md`, `docs/coop-web-plan.md`,
  `docs/plan-coop-agent-improvements.md`.
- `CHANGELOG.md` — history; edit only under `## [Unreleased]`.
