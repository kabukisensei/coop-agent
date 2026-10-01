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
- **Contract:** `.coop/project.yml` is the source of truth for repo paths,
  Fabric/Power BI workspaces, backup/log rules, and approval policy. It may declare
  deliberate project standards overrides; otherwise COOP's resolved standards task
  authority is authoritative. Read the nearest contract before doing file work.

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
The in-agent `/setup-project` command and the first `/start` menu item create or
edit `.coop/project.yml`; a missing contract is proactively offered on startup in
a Git repository. Contract edits preserve unowned fields and require `/new` or a
restart before the guardrails use the new trusted snapshot.

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

### Current roadmap — the master plan, phase by phase

The official forward plan is the [Coop master plan](docs/COOP_MASTER_PLAN.md):
Phase 0 rollout hotfixes on stable (installer prerequisites, automatic Azure
sign-in, project contract aligned with the Cooptimize standards repos) are done;
Phase 2, the Windows-first simplification, has every row S1-S7 in review as PRs
#218, #221, #223, #225, #227 and the S7 PR (one implementation in PowerShell, one
manifest, one BOM check, simplified tests and docs). Then dependency
reconciliation, standards alignment and the reviewer decision, Azure SQL breadth
with dev-by-default and live impact tracing, common-workflows first run, then
TeamAI shared knowledge (the beta channel is skipped and Jev waits, revision 3.8),
the optional package trial, and last an installable Electron desktop. **It is the
only plan.** The earlier Windows terminal plan (revision 2.0) and every prior plan,
handoff, and receipt live under `docs/history/` as read-only reference; the master
plan wins where they differ, and new planning is a new revision of the master plan,
never a new file. Aaron starts each phase explicitly. **No phase is started by the
plan being merged** or by the previous phase's PRs landing. Do not add roadmap
tasks to `agent:ready` or treat branch presence as an execution trigger.

Native Windows Coop 2.0 is off the roadmap; the desktop path is the packaged
Electron app in the master plan's last phase. Do not merge or port the old Desktop
branches; they are reference material. The simplification retired the bash
product path, the parity check and the test modes; what remains is one PowerShell
implementation with its BOM and test obligations.

`experimental/windows-terminal` is a provisional source branch, **not an installed
or proven-isolated beta**. Do not run the existing installer/updater from that
branch as a beta setup; the beta channel (B1) is skipped (revision 3.8). The
roadmap pause applies to the roadmap, not unrelated explicitly requested
maintenance.

**Working a plan row:** follow the master plan's section 14 (one row, one issue,
one branch named `<id>/<short-name>`, one PR titled with the ID; update the row's
Status in the same PR; accept Phase 0 work on the fresh development VM; never
start the next phase on your own).

### Platform notes

- **Developing this repo** — editing scripts/docs/tests and running the checks
  below — works on any OS with the prerequisites, including a headless Linux box.
- **Operating coop on a workstation** — `coop install`, launching `coop`,
  `coop doctor`, anything needing Pi/pipx/Fabric — is a Windows
  workstation activity. From a headless box, do not attempt these; report that
  they need a workstation instead.
- Cross-repo work (see `RELEASE.md`) assumes all coop-* repos are cloned **side
  by side under one parent directory** (on Aaron's Mac: `~/Developer`). If a
  sibling repo is missing, stop and report — don't clone or guess paths.

### Environment (prerequisites for the checks)

- Required: `git`, `bash` (the test harness and the release script are bash dev
  tooling), `python3` (no PyYAML), Node.js + `npx` (the test suite bundles the
  extensions with esbuild), and `pwsh` (PowerShell 7 — available on Linux and
  macOS): coop itself is PowerShell, so `tests/run.ps1` and every test that drives
  `bin/coop.ps1` or `lib/common.ps1` need it.
- Optional: `shellcheck` (CI runs it — run locally when installed:
  `shellcheck -S warning -e SC1091 bin/coop scripts/*.sh tests/*.sh`).

### Before any work

```bash
git fetch origin && git status --porcelain   # expect: no output (clean tree)
git pull --ff-only
```

If the tree is dirty or the pull can't fast-forward, **stop and report** —
another agent or Aaron may be mid-work in this tree. Never stash, reset, or
force anything to "fix" it.

### Hard rules when editing code (detail: CONTRIBUTING.md)

1. **One implementation, in PowerShell** (master plan S1). The product is
   `bin/coop.ps1`, `lib/common.ps1` (the shared helper library dot-sourced by
   `bin/coop.ps1` and every `scripts/*.ps1`; helper changes go there, never into
   per-script inline copies) and `scripts/*.ps1`. `bin/coop` is only a Git Bash
   forwarder to `coop.ps1`, and `scripts/release.sh`,
   `scripts/validate-resources.sh` and `tests/*.sh` are dev tooling. Never add a
   bash product path back, and never add a `.sh` twin for a `.ps1`.
2. **Every `.ps1` keeps its UTF-8 BOM** (`EF BB BF` as the first three bytes).
   Editors and agent write-tools silently strip it on rewrite — after every
   `.ps1` edit, re-run `pwsh -NoProfile -File scripts/check-bom.ps1` (the one
   BOM check; it prints the exact fix command for any file missing it).
3. **Every `.ps1` parses under Windows PowerShell 5.1** (`bin/coop.cmd`'s
   runtime): no ternary, `??`, `?.` or `clean {}`. CI parses every file under
   5.1; on a Linux or macOS box, pwsh 7 accepts those and will not warn you.

### Verify after every change

```bash
for f in bin/coop scripts/*.sh tests/*.sh; do bash -n "$f"; done
pwsh -NoProfile -File scripts/check-bom.ps1   # expect: "✓ BOM check passed", exit 0
pwsh -NoProfile -File tests/run.ps1   # the PowerShell suite, gate lane (starts with the BOM check); expect: "✓ PowerShell behavioral tests passed (gate lane)", exit 0 (CI also runs it under Windows PowerShell 5.1)
bash tests/run.sh               # gate lane; expect: "✓ all tests passed (gate lane)", exit 0 (needs node + npx + pwsh)
```

`bash tests/run.sh` is the gate lane that every PR runs. The extended lane (timing
and process fixtures) is optional per change and runs before every release;
`coop release` runs it itself:

```bash
COOP_TEST_EXTENDED=1 bash tests/run.sh   # expect: "✓ all tests passed (gate + extended lanes)", exit 0
```

Run it when you add or change a timing or process fixture. Lanes, fixture rules,
and the extended fixtures that still touch the real home: `docs/ci.md`,
"coop-agent's own CI (maintainers): gate and extended lanes".

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
  `README.md`, `docs/architecture.md`, `docs/ci.md`, `docs/extending.md`,
  `docs/guardrails.md`, `docs/install-windows.md`, `docs/onboarding.md`,
  `docs/tool-contract.md`, `docs/troubleshooting.md`.
- **The one plan (each phase needs an explicit start):** `docs/COOP_MASTER_PLAN.md`.
- **History (read-only context; never execute their steps):** everything under
  `docs/history/` — the revision 2.0 Windows terminal plan and its preparation
  handoff, the guardrail repair receipt, the web/UI plans, the Azure DevOps and
  improvements plans, the phase 6 report, the context-budget baseline, and the
  round-2 review fix plan. Prior Desktop/web directions never override the master plan.
- `CHANGELOG.md` — history; edit only under `## [Unreleased]`.

## Working the backlog (agents)

This repo's work queue is its GitHub issues labeled **`agent:ready`**:
`gh issue list --label agent:ready --state open`. Each issue is self-contained
(Context / Problem / Proposed fix / Acceptance criteria). Rules of engagement:

- Read this file fully first; take ONE issue at a time (oldest first unless one
  blocks another).
- Implement to the acceptance criteria; run the "Verify after every change"
  checks + lint before every commit; commit with `Fixes #N` so the issue closes
  on push.
- Never push tags, release, or bump versions — Aaron releases (see the release
  rules above).
- An open issue WITHOUT the `agent:ready` label is waiting on a human decision —
  leave it alone.
