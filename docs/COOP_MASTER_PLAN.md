# Coop master plan — ordered execution roadmap

**Document revision 3.2 · September 29, 2026**
**Product scope: Coop Windows terminal first; an installable Electron desktop returns after the terminal is simplified.**

**Canonical repository location:** `docs/COOP_MASTER_PLAN.md`. This revision keeps the
intention of the [Windows terminal plan, revision 2.0](history/COOP_WINDOWS_TERMINAL_PLAN.md)
(Windows-first, stable and beta kept separate, bounded simplification, qualified
upgrades, TeamAI and Jev as optional experiments) and **replaces its execution
order**. Revision 2.0 stays in the tree as the detailed reference for each package
(S1–S7, U1, SK1, K1–K3, J0–J3, PK1); where the two documents disagree on order,
scope, or the Desktop direction, this document wins.

**Authority and status:** a plan, not a receipt. Nothing here is implemented by
adopting the document. Aaron starts each phase explicitly; a merged plan is not an
execution trigger, and `agent:ready` is still added by hand. Releases follow
`RELEASE.md` and happen only when Aaron names a version.

## 1. What changed since revision 2.0

| Topic | Revision 2.0 | Revision 3.0 |
| --- | --- | --- |
| First work | B0 baseline, then B1 isolated beta channel, then everything else | **Rollout hotfixes on stable first** (installer prerequisites, Azure sign-in, project contract), then test right-sizing and simplification. B1 moves after simplification. |
| Tests | Retain and consolidate; "test reduction follows implementation reduction" | Same rule, plus an explicit cut: CI keeps a fast gate that must pass on every PR; slow process/timing fixtures move out of the PR gate or go with the surface they test. No test runs just to run. |
| Dependencies | Qualify one family at a time after B1 | Same discipline, done **right after simplification** against the drift measured on September 28 (section 6), with an explicit keep/drop list for dependencies that Windows-first no longer needs. |
| Standards | Canonical `cooptimize/coop-standards` sealed to one manifest shape | Coop **reads the format the standards repo ships** (and `cooptimize/incremental-bi`), instead of locking a copy of it. Default project contract is regenerated from that format. |
| SQL and DAX reviewers | Keep `coop-sql-review` / `coop-dax-review` as deterministic gates | Decide keep-or-retire after standards alignment (section 7). Default recommendation: retire the in-agent wrappers; keep the CLIs only where a client CI pipeline actually uses them. |
| SQL platforms | Fabric Warehouse / Lakehouse SQL endpoint only | Fabric stays. Add **Azure SQL Database and Azure SQL serverless** as first-class targets with the same guardrails. |
| Editing SQL objects | Local files plus `coop-data-doc` lineage | SQL is not source-controlled today, so coop **defaults to the dev environment**, traces impact from **live metadata**, and verifies an edit with **actual data** before and after. |
| First run | Onboarding wizard, then `/start` menu on demand | **Common workflows menu on first run**; the wizard becomes one entry in it. |
| Desktop | Removed; native Windows Coop 2.0 last, no Electron | **Electron desktop returns, last**, gated on a packaged installer that other users can run. The native rewrite is dropped from the roadmap. |
| TeamAI / Jev / PK1 | Early beta experiments after B1 | Unchanged intention, but they wait for the beta channel and run after the client-facing phases. PK1 now evaluates `pi-lovely-codex` as a whole (usage stats plus tool-call handling), not `apply_patch` alone. |
| Update channel | `coop update` fast-forwards `main` | `coop update` moves to the **latest release tag**; `--edge` keeps head-of-main for maintainers. |
| Qualification machine | Isolated beta channel (B1) before any upgrade | The team is **seven people**. A **fresh Windows development VM** plus a second clone with `COOP_AGENT_DIR` qualifies upgrades, and a tagged release reaches all seven the same day. B1 is built only if the fleet outgrows that. |
| Agent working model | Implicit | Section 14 sets how agents pick up work so several sessions stay coherent. |

## 2. Ordering principle and the "not over-engineered" rule

Order is by who is hurt when it is missing:

1. Users on the rollout are hurt today → hotfixes on stable, no refactor attached.
2. Every later change is slower while CI is heavy → right-size tests.
3. Every later change is bigger while two platforms and legacy web exist → simplify.
4. Then change what is inside: dependencies, standards, SQL breadth, first run.
5. Then experiments (beta channel, PK1, TeamAI, Jev) and the desktop.

Rules for every package, in addition to the hard gates in revision 2.0 (no source
loss, no credential leakage, no approval bypass, no accidental Fabric or database
mutation, no update overwriting user configuration):

- One PR, one purpose. No "cleanup plus upgrade plus feature".
- No new framework, registry, schema, environment variable, test mode, or
  abstraction unless it deletes more than it adds or closes a bug a user hit.
- A test is written for a boundary or a bug, not for coverage. A test that needs a
  sleep, a PTY, a marker file, or a load-dependent wait is an integration test and
  does not belong in the PR gate.
- Paired scripts, bash 3.2, and the `.ps1` BOM rules in `AGENTS.md` still apply until
  the simplification phase retires them in the same PR that retires the surface.
- No new behavior on a surface this plan retires (`coop web`, the macOS/Linux
  product path, `mcp-remote`). A hotfix touches such a surface only to keep it
  from breaking; it does not improve it.
- Timing fixtures (sleeps, hang timers, marker polls) belong in the extended lane
  from now on, even before T1 lands. A PR that must add one says why in its body.

## 3. Phase 0 — Rollout hotfixes on stable

These are the bugs users hit in the week of September 21. Two were already fixed and
released (pipx not visible to a fresh Windows user in v0.23.4; antivirus quarantining
`lib/common` giving cascading "not recognized" errors in v0.23.5). The rest are
open. Each is a small PR against `main`, released as a patch when Aaron asks.

### H1 — Installer: check every prerequisite first, in order, and print the exact command

**Observed:** `coop install` tries a silent `winget install` for missing Git, Python
3.12, Node LTS, and Azure CLI, discards winget's output and exit code, warns, and
**continues** (`$ErrorActionPreference = 'Continue'`). On a machine without Node the
install then fails several steps later ("cannot install pi (npm missing)", every
extension "skipped", authoring tools "skipping", doctor "pi missing"). Without
Python it fails at pipx and the Fabric CLI. Four concrete defects make it worse:

- `Coop-Warn` in `lib/common.ps1` takes one parameter, so every call that passes a
  second "how to fix" argument (the Node-too-old hint, all ODBC hints) silently
  drops the hint. The bash twin prints it. Users on Windows see the problem and
  not the command.
- The Node minimum is hard-coded to 22.19.0 in both installers instead of read from
  `config/release-manifest.json`; only doctor reads the manifest.
- After a winget install the script adds a few known directories to `PATH` but not
  the Python install-manager location, so a just-installed Python is not found in
  the same window; pipx then reports "python missing".
- `README.md` says Azure CLI is auto-installed in one section and "not
  auto-installed" in another.

No test covers "Node missing" or "Python missing". The background-job units in
`install.ps1` (`$UnitPi`, `$UnitPytool`) reference variables and a helper that are
not passed into the job runspace; verify on a workstation whether those units work
at all when reached (read-only finding, not reproduced).

**Fix:** a single prerequisite stage at the top of `install.ps1` (and the bash twin
while it exists) that checks everything before installing anything, in dependency
order, and stops with a numbered checklist when a required item is missing:

| Order | Prerequisite | Why this order | Command printed when missing (Windows) |
| --- | --- | --- | --- |
| 1 | Git | clone/update of coop-agent and knowledge repos | `winget install --id Git.Git -e` |
| 2 | Node.js ≥ 22.19 (LTS) | Pi and every npm tool need it | `winget install --id OpenJS.NodeJS.LTS -e` |
| 3 | Python 3.10–3.13 (3.12 recommended) | Fabric CLI cannot run on 3.14; pipx needs a Python | `winget install --id Python.Python.3.12 -e` |
| 4 | pipx | installs coop tools and Fabric CLI; needs Python | `py -3.12 -m pip install --user pipx` then `py -3.12 -m pipx ensurepath` |
| 5 | Azure CLI | Fabric, Power BI, SQL tokens | `winget install --id Microsoft.AzureCLI -e` |
| 6 | ODBC Driver 18 for SQL Server | `pyodbc` live SQL fallback and Azure SQL | `winget install --id Microsoft.msodbcsql.18 -e` (id to confirm on a workstation) |
| 7 | Tabular Editor CLI (optional) | BPA reviews only | link plus `te auth login` |

Behavior: print the table with a ✓/✗ per row, then either "all prerequisites
present, continuing" or "install the ✗ rows above in that order, open a **new**
terminal, run `coop install` again". With `--prereqs auto` (default off until proven)
run the winget commands **visibly**, re-check, and still require the new terminal.
`coop doctor` reuses the same check list and messages, so install and doctor never
disagree. Keep `--no-prereqs`. No new framework: one function, one table.

**Acceptance:** fresh Windows VM without Node and without Python stops at the
checklist with the two commands; after running them and reopening the terminal,
`coop install` completes and `coop doctor` exits 0. Regression: a machine with every
prerequisite behaves as today.

### H2 — Azure sign-in happens automatically

**Observed:** three places can sign in, and none of them works by default on the
rollout machines.

- The launch preflight (`coop_az_preflight` in `lib/common.sh`,
  `Invoke-CoopAzPreflight` in `lib/common.ps1`) returns before doing anything when
  there is no `.coop/project.yml` under the working directory **or** when
  `fabric.tenant_id` is empty or starts with `TODO`. The bundled fallback contract
  ships `TODO`, so from the desktop shortcut (home folder) or any repo without a
  contract, sign-in is never attempted. It ignores the tenant that onboarding
  already saved to `~/.coop/config` (`azure.tenant_id`).
- When the preflight does run, it checks only a Power BI token. The Fabric MCP and
  the SQL fallback mint a Fabric token (`https://api.fabric.microsoft.com`, no
  `--tenant`), so a user can pass the preflight and still see `auth_required`
  inside the session.
- The preflight asks "Run az login now?" with default **No**, and refuses outright
  on a non-interactive stdin. From a shortcut there is nobody to answer.
- Onboarding's sign-in (`lib/azure_auth.py`) runs `subprocess.run(["az", ...])`
  with no shell. On Windows the Azure CLI is `az.cmd`; `shutil.which` finds it,
  but the process call cannot start a `.cmd` without `cmd.exe`, so tenant discovery
  returns nothing and the user is told "Azure sign-in did not complete" before a
  browser ever opens. Only `fabric_request_headers.mjs` handles `az.cmd`
  correctly; the tests avoid the bug by pointing `COOP_AZ_BIN` at a `.bat`.
- `coop doctor` treats `az` as optional presence only; it never reports sign-in
  state except through the Warehouse probe.

**Fix:**
- Tenant comes from one place with a fallback chain: `.coop/project.yml`
  `fabric.tenant_id` → `~/.coop/config` `azure.tenant_id` (saved by onboarding) →
  nothing. A `TODO` value counts as unset. (Corrected by PR 89: onboarding writes
  `~/.coop/config`, not `user.json`, and Aaron decided there is no default tenant
  and no tenant id in this public repo.)
- Preflight checks the Fabric resource token first (`https://api.fabric.microsoft.com`),
  then Power BI; either missing triggers sign-in.
- One `az` invocation helper shared by Python, PowerShell, and Node that resolves
  `az.cmd` on Windows (the `fabric_request_headers.mjs` logic, reused, not copied).
- Sign-in runs `az login --tenant <id> --allow-no-subscriptions` directly (browser
  flow) and falls back to `--use-device-code` when no browser can open. No confirm
  prompt; the user asked for coop, not for a question about Azure. Token minting
  for Fabric passes the same `--tenant`.
- On failure, launch continues with one line that names the exact command, and
  `coop doctor` gains one row: signed in to tenant X / not signed in, run this.
- Cache stays as today (`.az-ok`, 30 minutes, tenant-stamped).

**Acceptance:** fresh machine, signed-out `az`: first `coop` opens the browser sign-in
once, then the Fabric MCP tools list without `auth_required`. Signed-in machine: no
prompt, no delay beyond the cached check.

### H3 — Coop reads the coop-standards wiki directly (merged in PR 85)

**Observed (revision 3.0):** the shipped `.coop/project.yml`, the example, `coop init`,
and `/setup-project` had no `standards:` section, and `lib/standards.mjs` locked
`cooptimize/coop-standards` to one manifest shape, exactly three domains, exact file
paths, branch `main`, and an anchor commit, with the registry duplicated in code.

**What the repo actually is (found 2026-09-28 with local clones):**
`coop-standards` is an Obsidian wiki the team reads directly. Every article carries
YAML front matter (`id, title, domain, layer, artifact, technology, status`). The
`standards.yml`, `standards/*.md`, and `scripts/assemble.py` files that coop was
locked to are a compatibility shim that existed only because coop could not read
the wiki. Aaron's direction: do not change the repo's structure; change how coop
reads it, and stop depending on the assembly script.

**Done in [PR 85](https://github.com/kabukisensei/coop-agent/pull/85):**
- Coop discovers every active article by front matter (any folder, any future
  domain); it never reads the shim. Drafts, deprecations, notes without front
  matter, dot-folders, and symlinks are skipped; an empty wiki fails closed and
  keeps the last known good.
- Domains map by front matter: `domain: sql` → `sql`; `domain: powerbi` → `dax` when
  the artifact is a DAX expression or measure, else `semantic_model`; any other safe
  domain keeps its name.
- Tasks receive whole articles (general ones plus up to six ranked by layer,
  artifact, technology, and title), each with path, hash, and repo revision.
- The registry JSON is the only copy; the frozen domain list, anchor commit, and
  archive hash are gone. Project overrides accept the nested
  `standards.<domain>.path` shape. `incremental-bi` uses the same reader.
- The SQL/DAX reviewers, until ST1 retires them, are fed a content-addressed
  reviewer-input file built from the same articles, so they never contradict what
  coop just wrote.

**Verified against the real repo** at `a00c8cc`: `coop sync` refreshes, prompts
receive the expected articles, `/setup-project` round-trips. No VM needed.

**Follow-ups filed, not `agent:ready`:** #83 retire the legacy `manifest.json`
fixture seam and its schema file; #87 the standards runtime test writes the
developer's real `~/.coop/standards`; #88 the prompt classifier misses wiki SQL
topics such as "silver indexing on the fabric warehouse".

### H4 — Regression evidence for the fixes that already shipped

Keep the v0.23.4/v0.23.5 fixes in the plan so that the simplification phase does not
undo them: pipx launcher directory resolution via `sysconfig` on Windows, the clear
message when `lib/common` is missing, and the setup-bridge early-close wording.
No new work.

### H5 — `coop update` follows release tags, not the head of `main`

**Observed:** `coop update` fast-forwards the clone to the tip of `main`, so every
team machine receives every merged commit, including the ones that only exist to
fix the previous one. Releases are tagged (`v0.23.5`) but nothing consumes the tag.

**Fix:** `coop update` fetches tags and checks out the newest `v*` tag by default;
`coop update --edge` keeps today's head-of-`main` behavior for maintainers. Doctor's
staleness nudge compares against the newest tag, not the branch. The version
report already carries the SHA, so support can still tell which tag a machine runs.

**Acceptance:** a machine on `v0.23.5` with newer unreleased commits on `main` stays
on `v0.23.5` after `coop update`; after Aaron tags `v0.23.6` it moves there; `--edge`
moves to head. A dirty checkout still refuses, as today.

### H6 — One-page "Install coop on Windows" for teammates

**Observed:** `README.md` is the only install guide. It is long, mixes macOS and
Linux in, and contradicts itself on whether Azure CLI is auto-installed. New
teammates read it once and then ask.

**Fix:** `docs/install-windows.md`, one page, whose numbered steps are the H1
prerequisite table in the same order and wording the installer prints, followed by
"double-click `Install coop.cmd`", "open a new terminal", "run `coop`", and what
the first-run sign-in looks like. The README's Windows section links to it instead
of repeating it. Nothing in it that the installer does not also say.

**Acceptance:** a teammate on the fresh development VM installs coop from the page
alone, without asking a question. Every command on the page is copy-pasted from
the installer's own output.

## 4. Phase 1 — Right-size tests and CI

**Goal:** every PR runs a gate that finishes in a few minutes and fails only for a
real regression. Everything slower runs on demand or nightly. No test is skipped,
disabled, or quarantined to get green; a test leaves the repo only with the surface
it covers or with a named replacement.

**Observed (September 28, measured on a Linux container; CI on `main` is green at
v0.23.5):**

- `tests/` holds 95 files and 23,765 lines against 29,613 lines of product source
  (`bin`, `lib`, `scripts`, `extensions`), a 0.8 ratio before counting the 3,207-line
  Windows acceptance harness.
- A full `bash tests/run.sh` takes roughly 6.5 to 7 minutes when it passes. Over
  five minutes of that is spent in a dozen process fixtures: `sync-knowledge`
  (62 s, 56 sleeps), `inventory` (57 s), the standards generation crash test
  (40 s, eight spawned children), `fleet-execution` + `install-python-prereq`
  (47 s), `fabric-request-headers` (27 s), `webbridge` (27 s), `knowledge-git`
  (22 s), `doctor` (21 s), `review` (19 s), `home-guard` (14 s). The guardrail
  suite, the largest logic suite, runs in under one second.
- CI runs that suite three times per PR (ubuntu, Windows Git Bash, and the pwsh
  twin), plus a macOS bash 3.2 parse job, a Windows PowerShell 5.1/7 parse job with
  PSScriptAnalyzer, a Pi matrix job that installs Pi from npm, and a focused Windows
  knowledge-search job whose own comment says the full suite "legitimately remains
  red on unrelated open defects".
- Three of the last four commits on `main` are timing repairs (30-second marker
  waits, hang-fixture headroom, orphan reaping). Of the last 40 commits touching
  `tests/`, 35 are Windows fixture debugging iterations from September 18 and 19.
- On this container the suite fails deterministically at
  `fabric-mcp-launch.test.sh` phase `web-no-python-warning`, a fixture for the
  retired `coop web` path that builds a synthetic minimal `PATH`. It passes in CI.
  A test that depends on which directory `python3` lives in is not a product test.
- Ten test files are not run by anything (`ado`, `fleet-digest`,
  `install-pipx-path`, `missing-common-guard`, `knowledge-read`,
  `knowledge-retrieve`, `knowledge-sources`, `support-center`, `tool-result`,
  `repro-tmp-contamination`). The BOM is checked three separate times.

That is the "too aggressive" signal: the cost is in process fixtures and
duplicated gates, not in the logic tests users depend on.

**Split:**

| Lane | Runs when | Contents |
| --- | --- | --- |
| `gate` (required on every PR) | push and PR | syntax (`bash -n`, pwsh parse), shellcheck, parity/BOM (until retired), JSON/YAML/resource validation, esbuild transpile, and the **deterministic logic suites**: standards, guardrails, coop-tools contract, project wizard, launch-spec, `_yaml.py`, `_extdeps.py`, mcp-config, warehouse-mcp, fabric-sql-query, init wizard, doctor project. Target under five minutes on ubuntu. |
| `extended` (manual `workflow_dispatch` + nightly) | schedule | process and timing fixtures: fabric-mcp-launch, sync-knowledge hang cases, first-run PTY, fleet execution, knowledge-git process inspector, update-guard, staleness, azcache, home-guard, inventory, and the Windows-native probes. |
| `workstation acceptance` | on demand before a release | the existing `windows-terminal-workstation-acceptance.yml` and `acceptance/` receipt. |

**Delete with their surface (Phase 2):** `webbridge.test.mjs`, `protocol.test.mjs`,
`diffmodel.test.mjs`, `fabric-mcp-web-launch.test.mjs`, `stub-pi.mjs`, and the two
web phases inside `fabric-mcp-launch.test.sh` (legacy web); the macOS-specific
cases in `knowledge-git`, `inventory`, `install-python-prereq`, `coop-profile` and
the macOS bash 3.2 job once the bash product path is retired; the
`COOP_UPDATE_GATE_DRYRUN` / `COOP_FLEET_TEST_MODE` test modes per revision 2.0 S7.
`fleet-*` and `ado-*` fixtures stay unless Aaron retires those features.

**Wire or delete now (Phase 1):** the ten orphaned test files above either join the
gate lane (`tool-result`, `knowledge-*`, `support-center`, `missing-common-guard`,
`install-pipx-path` look like real unit tests) or are deleted; one BOM check, not
three.

**Rules for new tests going forward:** a fixture may not sleep or poll for a
subprocess in the gate lane; a Windows-only behavior gets one Windows test, not a
synthetic matrix; a bug fix adds the one test that reproduced it.

**Acceptance:** gate lane green on ubuntu and windows-latest in under five minutes;
extended lane documented in `docs/ci.md`; no assertion weakened; the list of tests
moved or removed recorded in the PR with the reason per file.

## 5. Phase 2 — Simplify for Windows first

Revision 2.0's S1–S7 packages, in this order and with these decisions:

1. **S1 Retire the POSIX product path.** Keep `bin/coop` only as a small Git Bash
   forwarder to `coop.ps1` (Git Bash on Windows is still a supported entry). Delete
   the bash lifecycle scripts (`install.sh`, `update.sh`, `sync.sh`, `doctor.sh`,
   `uninstall.sh`, and the digest/onboard twins) and the parity gate with them.
   Development of coop-agent itself still works on a headless Linux box for the gate
   lane; operating coop needs Windows.
2. **S5 Remove legacy web** (`web/`, `coop web`, its token wrapper, its tests). The
   Electron desktop in Phase 8 does not reuse this code; the shared launch spec
   (`coop launch-spec --json`) is what it needs and that stays.
3. **S3 One profile root.** `COOP_DIR` means two different things today; keep the
   stable defaults, add nothing new until the beta channel needs it, but make every
   reader agree.
4. **S2 / S4 / S6** as described in revision 2.0: one install/update/sync
   convergence path, shared token and MCP predicates with doctor observational, dead
   data-doc writer helpers removed after call-site proof.
5. **S7 Docs and instructions** updated in the same PRs (`AGENTS.md`,
   `CONTRIBUTING.md`, `docs/ci.md`) so agents do not reinstate parity or BOM duties
   for files that no longer exist.

**Dependencies to drop when Windows-first (confirm each before deleting):**

| Candidate | Reason | Confirm |
| --- | --- | --- |
| `mcp-remote` | only bridges Microsoft Learn; Learn offers direct Streamable HTTP and `pi-mcp-adapter` 3.x speaks it | direct HTTP works through the adapter on Windows |
| `powerbi-mcp-server` (unscoped npm, 0.1.0) | superseded by `@microsoft/powerbi-modeling-mcp` 1.0.0 | no skill or prompt depends on its tool names |
| `pi-better-openai` | Aaron wants the plan-usage stats it feeds the footer, but B0 found its configuration inactive on the live install, and `pi-lovely-codex` may supply the same stats plus tool-call handling | **keep** until PK1 compares it with `pi-lovely-codex` on the development VM; drop only if the replacement shows the same 5h/7d usage windows in the Coop footer |
| `context-mode` | sandboxed code execution over docs; overlaps Pi's own compaction | measure context saved on two real sessions |
| Homebrew/apt/dnf prerequisite branches, `/opt/homebrew` troubleshooting | Mac-only | goes with S1 |

## 6. Phase 3 — Dependency reconciliation against the freeze

Drift measured on September 28, 2026 with read-only `npm view` and PyPI metadata.
The manifest is `config/release-manifest.json` at v0.23.5.

| Component | Pinned | Latest | Needed? | Notes |
| --- | --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 0.84.3 | 0.87.1 (Sep 22) | **Yes, qualify** | 0.86.0 and 0.87.0 carry breaking extension-API changes (`user_bash` fails closed, `ToolCall.arguments` JSON-only, `turn_end` boundaries, `SessionManager` canonical). The four Coop extensions and the guardrail runner test must be re-verified. Still Node ≥ 22.19. |
| `pi-mcp-adapter` | 2.34.0 | 3.1.0 (Sep 27) | **Yes, after Pi** | 3.x peer range accepts pi-ai 0.84–0.87; a 3.0 major means read its changelog for config-shape changes before touching `mcp.json` generation. |
| `pi-hermes-memory` | 0.7.17 | 0.9.9 | Maybe | private memory; check cache roots and secret scanning still behave. |
| `pi-web-access` | 0.10.7 | 0.33.0 | Maybe | research only; qualify Windows and security changes. |
| `@juicesharp/rpiv-ask-user-question` | 1.20.0 | 2.11.0 | **Yes, qualify** | major bump; the setup wizards depend on its dialogs and cancellation. |
| `pi-better-openai` | 0.1.22 | 0.1.22 | No | candidate to drop (section 5). |
| `context-mode` | 1.0.169 | 1.0.169 | No | candidate to drop (section 5). |
| `@microsoft/powerbi-modeling-mcp` | 0.5.0-beta.12 | **1.0.0** (Sep 25) | **Yes** | first GA; read-only invocation and connection scope must be re-checked. |
| `@microsoft/powerbi-report-authoring-cli` | 0.1.4 | 0.4.0 | **Yes** | the report skills call it; validate output contracts. |
| `@microsoft/powerbi-desktop-bridge-cli` | 0.1.2 | 1.0.0 | Yes | re-test the reload/save source-loss report (S31 in revision 2.0) on disposable PBIP files. |
| `@microsoft/fabric-mcp` | 1.3.0 | 1.4.0 | Yes | B0 found 1.0.0 installed and 1.2.0 cached; pin exactly, never `@latest`. |
| `@azure-devops/mcp` | 2.9.0 | 2.10.0 | Low | B0 found 2.10.0 already at the executable path. |
| `mcp-remote` | 0.1.38 | 0.14.3 | Drop or pin | see section 5. |
| `coop-data-doc` / `coop-sql-review` / `coop-dax-review` | 1.2.0 / 0.15.2 / 0.22.0 | same | No | unchanged since the freeze; the reviewer decision is in section 7. |
| `ms-fabric-cli` / `fabric-cicd` / `pyodbc` | 1.7.0 / 1.3.0 / 5.3.0 | same | No | unchanged. |
| `microsoft/skills-for-fabric` catalog | v0.3.10 | v0.3.18 (Sep 25) | **Yes** | v0.3.12 merged the two pinned `sqldw-*` skills into `sqldw-cli`; v0.3.17 unified `powerbi-report-cli`; new `sqldb-cli` targets Fabric SQL database. The allowlist in `config/microsoft-skills.json` must be remapped. |
| `microsoft/skills` (`kql`, `microsoft-docs`) | commit 903dc62 | not checked | Low | refresh with the catalog step. |

Order inside the phase: Pi → adapter → ask-user-question → Microsoft npm tools →
Fabric skills catalog → the "maybe" rows. One PR per row, each with the exact
old/new versions, what changed, the tests run, and the rollback.

**Where upgrades are qualified.** Not on a teammate's stable machine. Two existing
mechanisms cover it without new code:

- The **fresh Windows development VM** (set up the week of September 28) is the
  qualification machine: install the candidate version there with the normal
  installer, run the acceptance for the package, and keep the VM's `coop doctor`
  output with the PR. Snapshot the VM after a clean install so every qualification
  starts from the same state.
- For extension, MCP, skill, and prompt changes on a machine that also runs
  stable, a **second clone plus `COOP_AGENT_DIR`** already isolates the Pi agent
  directory (extensions, settings, MCP, sessions). Pi itself is global, so a
  different Pi version needs the VM.

Upgrades reach teammates only through a tagged release (H5), so a qualified change
sitting on `main` cannot surprise anyone. The full isolated beta channel (B1) is
built only if this proves insufficient.

## 7. Phase 4 — Standards alignment and the reviewer decision

Depends on H3 having access to the two repositories.

1. **Resolver follows the repo.** Finish H3's data-driven reader. coop reads the
   coop-standards Obsidian wiki articles directly by their front matter (`domain`,
   `layer`, `artifact`, `technology`, `status`). It does not use the repo's
   `scripts/assemble.py`, `standards/*.md`, or `standards.yml`, which stay in the
   repo unchanged for the team and older clients. Keep provenance (revision, article
   path, file hash) because it is what makes a review reproducible; drop the
   anchor-commit and archive-hash equality checks that only prove the repo has not
   changed shape.
2. **Standards are what coop writes to.** Every skill and prompt that authors SQL,
   DAX, or a semantic model reads the effective standard for that domain at task
   start (this already happens through `buildStandardsContext`) and the
   `coop-workflow` slice checklist names the standard section it applied.
3. **Reviewer decision.** `coop-sql-review` and `coop-dax-review` are deterministic
   linters with their own rule sets, keyed to the standards through `--standards`.
   Once coop applies the standards while writing, the in-agent `sql_review` and
   `dax_review` tools mostly re-find what the model already knows. Recommendation:
   - retire the in-agent wrappers and the bundled-fallback resolution path (a large
     part of `lib/standards.mjs` exists only to bind reviewer provenance);
   - keep the two CLIs as **optional CI gates** (`coop init --ci`, `docs/ci.md`) only
     for clients whose pipelines run them, and re-key their rules to the new
     standards format in their own repos;
   - if no client pipeline uses them within one quarter, archive the CLIs.

   **Decided 2026-09-28 (Aaron):** the review tools leave coop. Standards are
   enforced while writing, from the wiki articles. The replacement is a short
   self-check: before presenting SQL, DAX, or model changes, coop checks its own
   diff against the same articles it used to write them and names any rule it could
   not meet. No separate rule engine. The CLIs survive only as optional CI gates for
   a client whose pipeline runs them today (section 15's open question). Answer
   that question before ST1 starts. Until ST1 retires them, the reviewers are fed
   from the wiki so they never contradict what coop just wrote.
4. **Tabular Editor BPA** stays as the deterministic model check; it is vendor-owned
   and not tied to the standards format.

## 8. Phase 5 — SQL platform breadth: Fabric plus Azure SQL, dev by default, live impact

**Observed:** live SQL works only against Fabric. The pyodbc fallback accepts only
`*.datawarehouse.fabric.microsoft.com` servers discovered through the Fabric REST
API; the managed MCP route is the Fabric SQL-endpoint data-plane URL; the target
model is Fabric workspace and item GUIDs; the environment is inferred by matching
workspace names. No code queries `sys.*` metadata; impact analysis comes only from
the `coop-data-doc` graph built from local files, which does not exist when SQL is
not source-controlled.

**Work, in order:**

1. **Connection targets in the contract.** Add a `sql_targets:` section to
   `.coop/project.yml` with one entry per environment and a `default_environment:
   dev`. Each entry names a `kind` (`fabric_warehouse`, `fabric_lakehouse`,
   `azure_sql`, `azure_sql_serverless`), `server`, `database`, and for Fabric the
   existing workspace/item IDs. Production entries are present but never default.
2. **Azure SQL in the fallback executor.** Extend `lib/fabric_sql_query.py` (rename
   to `sql_query.py` in the same PR) to accept `*.database.windows.net` and
   serverless `*-ondemand.sql.azuresynapse.net` hosts from the contract, same
   token audience (`https://database.windows.net/`), same ODBC Driver 18, same
   row/byte/timeout caps, `ApplicationIntent=ReadOnly` where the target supports
   it. No SQL authentication, no stored passwords.
3. **Guardrails unchanged in spirit, wider in vocabulary.** The bounded session grant
   (`LiveReadScope`) gains the target kind and environment from the contract instead
   of the hard-coded Fabric URL; production keeps the explicit-scope-and-approval
   rule; DDL/DML on dev still asks once per session.
4. **Live impact tracing.** A read-only `sql_impact` capability that, for one object
   on the default (dev) target, queries `sys.sql_expression_dependencies`,
   `sys.dm_sql_referencing_entities`, `sys.sql_modules`, and `INFORMATION_SCHEMA`
   to return upstream and downstream objects, then hands the same object to
   `data_doc lineage` when built docs exist. The `impact-analysis` prompt and the
   `coop-workflow` skill call it before any edit. The current query filter rejects
   quotes and `WITH`, so this needs its own allow-listed parameterized queries, not
   the free-text path.
5. **Verify with data.** The slice workflow already requires a failing check before
   and a passing check after. Make it concrete for SQL: capture row counts and a
   bounded sample for the affected objects on dev before the edit, apply the edit on
   dev (after approval), re-run the same queries, and show the difference. Writes go
   only to the default dev target; test and production remain ask-first and
   explicit-approval respectively.
6. **Microsoft skill mapping.** Enable `sqldw-cli` for Fabric and evaluate `sqldb-cli`
   (Fabric SQL database, OLTP) from the v0.3.18 catalog; neither covers Azure SQL
   outside Fabric, so Coop's own `sql-review`/workflow guidance stays the authority
   for Azure SQL.

**Acceptance:** on a dev Azure SQL database and on a Fabric Warehouse, the same
session traces a view's dependents, edits it with approval, and shows before/after
counts. A production target configured in the same contract is never selected
without the explicit approval path. No credential or connection string ever
appears in a tool result or audit record.

## 9. Phase 6 — First run shows common workflows, not a wizard

**Observed:** the first plain `coop` launch runs `scripts/onboard.py` (name,
communication preference, integrations) before Pi starts and stops the launch when
it fails; `/start` is an on-demand menu whose first item creates or edits the
project contract; `/setup-docs` and `/setup-project` are separate wizards.

**Change:** on first run (and via `/start` any time) open one menu of the workflows
consultants actually do, each mapped to the existing prompt or skill:

1. Review a SQL object or a DAX measure against the standards (`sql-review`,
   `dax-review`)
2. Trace impact of a change (`impact-analysis`, Phase 5 live tracing)
3. Fix or edit an object on dev with approval (`spec-first` → `slice-next`)
4. Document a warehouse or semantic model (`setup-docs`, `data_doc build`)
5. Start a client project (`/setup-project`)
6. Write today's log or a handoff (`daily-log`, `handoff`)
7. Sign in or check health (`az login`, `coop doctor`)

Onboarding questions that are still needed (name, tenant) move into item 5 or into
the first workflow that needs them; nothing blocks the launch. The menu is the
existing `/start` code in `extensions/coop-tools`, not a new UI.

## 10. Phase 7 — Beta channel and optional experiments

**B1, minimal and conditional.** Revision 2.0's isolated beta channel is the
right design for a fleet too large to reach by hand. Coop's fleet is seven
people: with release-tag updates (H5), the development VM as the qualification
machine (Phase 3), and a rollback that is "check out the previous tag", B1 may
never be needed. Build it only when a concrete case appears
(for example a teammate who must run a beta feature daily while keeping stable),
and then after simplification so it isolates one platform, not two. Scope stays what the
B1 proposal in [PR 72](https://github.com/kabukisensei/coop-agent/pull/72) bounds: a separate clone,
`COOP_PROFILE_ROOT` meaning the profile directory itself, a private npm prefix and
pipx home, a `coop-beta` shim, and the same lifecycle code fed an installation
context. No copied installer, no second manifest schema. Version reporting shows
channel, version, SHA, and safe paths.

**Then, each only when Aaron asks, each independently revertible:**

- **PK1** package-fit trials (session naming, redacted diagnostics, scoped
  simplify, and `pi-lovely-codex`) per the package-fit review in
  [PR 72](https://github.com/kabukisensei/coop-agent/pull/72), GPT subscription
  only. **Scope change:** evaluate `pi-lovely-codex` as a whole, not `apply_patch`
  alone, because Aaron wants the usage stats `pi-better-openai` provides and the
  Codex extension may supply them together with how tool calls are made. The
  comparison is `pi-better-openai` + stock Pi tools versus `pi-lovely-codex`, on
  the development VM, measuring: the 5h/7d usage windows reach the Coop footer;
  every tool call it makes still passes through the guardrail hooks (the fit
  review found its patch path needs every touched path authorized); cancellation
  reaches the child process; patch text is not exposed in process arguments; it
  works on the team's Codex subscription without a separate key. Whichever wins
  becomes the one owner of usage stats; the other is removed.
- **K1–K3 TeamAI** shared knowledge, starting with isolated CLI and read-only recall.
- **J0–J3 Jev** shadow experiments on synthetic material, advisory only.

The controls in revision 2.0 sections 8 and 9 (data approval, secrets, authority,
cost caps, stop conditions) are unchanged.

## 11. Phase 8 — Electron desktop, installable on other users' machines

Revision 2.0 removed Desktop and reserved a native Windows rewrite for last. Aaron
wants the Electron desktop back, later, with one hard requirement: **another user
installs it without a terminal, Node, or Python knowledge**. That changes the
gate, not the order; it stays last.

- **Entry gate:** the terminal product is simplified (Phase 2), dependencies are
  reconciled (Phase 3), and the first-run workflows exist (Phase 6). The desktop
  reuses the shared launch spec and the same guardrails, skills, prompts, and
  profile; it must never carry a second policy implementation.
- **Reference, not merge:** the ten `feature/coop-desktop-*` and
  `desktop/candidate-2026-09-20` branches and `docs/history/ui-strategy.md` are design
  evidence. Salvage after review; do not merge wholesale.
- **Packaging is the project:** a signed Windows installer (MSIX or a Squirrel/NSIS
  package via electron-builder) that bundles Node, installs or reuses Pi in the
  coop profile, checks the same prerequisite table as H1 for Python, Azure CLI, and
  ODBC, and updates through the same channel logic as the terminal. No custom
  updater beyond what the packager provides.
- **Decision to record before starting:** a native rewrite (WinUI/WPF) is off the
  roadmap; "Coop 2.0" means this packaged Electron app.

## 12. Other improvements found in this review

Not requested, offered for Aaron's decision. None is scheduled.

- **Policy fields in the contract are write-only.** `estate.live_discovery`,
  `mcp.*.requires_approval_actions`, and `tests.live_data` are written by the wizards
  but no enforcement code reads them; the guardrails are hard-coded. Decision
  taken: wire them in Phase 5 step 3 (the guardrail scope reads the contract) and
  drop any field that is still unread when Phase 5 closes, so the contract never
  promises what it cannot enforce.
- **`docs/tool-contract.md` drifted** from the code: the reviewer invocation omits
  `--standards`, the sample report uses `rule` where the validator requires
  `rule_id`, and the `details` shape is missing four fields. Fix in Phase 4.
- **`config/standards-registry.schema.json` validates the legacy fixture manifest**,
  not the registry it is named after. Rename or delete in H3.
- **The `PENDING_OWNER_PROVISIONING` doctor state** is defined and never emitted.
  Delete in S6.
- **Open [PR 72](https://github.com/kabukisensei/coop-agent/pull/72)** (B0 receipt,
  B1 proposal, PK1 fit review) should merge as documentation once its plan-diff is
  rebased on this revision, so the B0 evidence is not lost. It removed the `y0usaf/pi-jev` rows that `main` still carries; keep
  `main`'s rows.
- **Stale branches.** Thirty-nine remote heads, many `tmp/`, `test/`, `wip/`, and
  "DO NOT MERGE" verification branches. Delete the ones whose PR is closed after
  Aaron confirms; they confuse "which branch is the beta".
- **Daily logs reference `E:` and `C:` workstation paths.** Fine as evidence, but the
  plan should not depend on a specific machine's drive letters; B1's E: proposal is
  Aaron's workstation preference, not a product path.

## 13. Ordered work register

Status values: `not started`, `issue open`, `in progress (branch)`, `in review
(PR)`, `merged`, `done (tag)`. The agent that opens a PR sets `in review` in that
PR. Merging is Aaron's act, so the **next** PR any agent opens also moves every row
whose PR has merged since to `merged`; Aaron moves rows to `done (tag)` when he
tags. A stale row is never a reason to re-do work: check the PR list first.

| Order | ID | Package | Starts after | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | H1 | Installer prerequisite gate with ordered commands; doctor reuses it | now | fresh VM acceptance in section 3 | merged ([#82](https://github.com/kabukisensei/coop-agent/pull/82), 2026-09-28), VM pending: [#76](https://github.com/kabukisensei/coop-agent/issues/76) |
| 2 | H2 | Automatic Azure sign-in, tenant fallback chain, `az.cmd`, Fabric token check | now | signed-out machine acceptance | in review ([#89](https://github.com/kabukisensei/coop-agent/pull/89)), VM pending: [#77](https://github.com/kabukisensei/coop-agent/issues/77) |
| 2b | H2b | Coop's own Fabric/SQL token mints pass the project tenant; ships in the same tag as H2 | H2 | guest-tenant acceptance in [#91](https://github.com/kabukisensei/coop-agent/issues/91) | issue open: [#91](https://github.com/kabukisensei/coop-agent/issues/91) (Aaron labels) |
| 3 | H5 | `coop update` follows release tags; `--edge` for head | now | tag/edge acceptance in section 3 | in progress (`h5/update-follows-tags`, started 2026-09-29): [#78](https://github.com/kabukisensei/coop-agent/issues/78) |
| 4 | H6 | One-page Windows install doc matching the H1 checklist | H1 | a teammate installs from the page alone | agent:ready: [#79](https://github.com/kabukisensei/coop-agent/issues/79) |
| 5 | H3 | Coop reads the coop-standards wiki directly; contract override shape | local clones of both repos | `coop sync` verifies the real `coop-standards` head; new contract round-trips through `/setup-project` | merged ([#85](https://github.com/kabukisensei/coop-agent/pull/85), 2026-09-28); no VM step; close [#80](https://github.com/kabukisensei/coop-agent/issues/80) at the tag |
| 6 | T1 | CI gate/extended split; fixture rules | H1–H3 merged | gate under five minutes, both OS, no weakened assertion | not started |
| 7 | S1, S5 | Retire POSIX product path and legacy web | T1 | one Windows implementation, forwarder kept, tests removed with their surface | not started |
| 8 | S3, S2, S4, S6, S7 | Profile root, lifecycle, token/MCP, dead helpers, docs | S1/S5 | duplication removed; `AGENTS.md` and `CONTRIBUTING.md` no longer require parity/BOM | not started |
| 9 | U1 | Dependency reconciliation per section 6, one row per PR, qualified on the VM | S-lane | exact versions, tests, rollback per PR; keep/drop list closed | not started |
| 10 | ST1 | Standards alignment and reviewer decision | H3 + U1 | resolver data-driven; reviewers retired from coop (decided 2026-09-28), self-check in place | not started |
| 11 | SQ1–SQ6 | Azure SQL targets, dev default, live impact, data verification | ST1 | section 8 acceptance | not started |
| 12 | FR1 | Common-workflows first run | SQ1 (menu items exist) | first launch shows the menu; onboarding no longer blocks | not started |
| 13 | PK1 | `pi-lovely-codex` versus `pi-better-openai`, naming, diagnostics, simplify | U1 + explicit start | one owner of usage stats; adopt/build/defer recorded per candidate | not started |
| 14 | B1 | Minimal beta channel, only if a concrete need appears | S-lane + explicit need | B1 proposal acceptance table, one platform | not started (conditional) |
| 15 | K1–K3, J0–J3 | Optional experiments | B1 or VM isolation + explicit start | revision 2.0 gates | not started |
| 16 | D1 | Electron desktop with packaged installer | 7–12 accepted | another user installs from the package alone | not started |

Phase 0 rows can each be released as a patch. Later phases are minor versions.
Rows become `agent:ready` only when Aaron says so. On September 28 he marked the
five Phase 0 issues (#76 H1, #77 H2, #78 H5, #79 H6, #80 H3); they carry the plan
text as their body. Take them lowest issue number first, one at a time; H1, H2, and
H5 all touch `lib/common.*`, so do not run them in parallel. H3 is independent and
may run alongside.

## 14. Working this plan: agents, issues, and the development VM

Several agent sessions will work this plan in the same week. These rules keep them
on the same page; they add to `AGENTS.md`, they do not replace it.

**One row, one issue, one branch, one PR.**

- Every row in section 13 that is being worked has a GitHub issue titled with its
  ID (`H1: installer prerequisite gate`), whose body is the row's section of this
  plan (Observed, Fix, Acceptance) copied in, so the issue is self-contained. Aaron
  adds `agent:ready`; nobody else does.
- An agent takes the lowest-numbered `agent:ready` row whose "Starts after" is
  satisfied, comments on the issue that it is starting, and works on a branch named
  `<id>/<short-name>` (for example `h1/prereq-gate`).
- The PR title starts with the ID. The PR body states the phase, what changed,
  what was deliberately not changed, the tests run, and the acceptance evidence
  (for Phase 0 that is the development VM run). It updates the row's Status.
- One purpose per PR. If an agent finds a second bug, it opens an issue and moves
  on. If it finds that the plan is wrong, it says so in the PR and stops rather
  than widening the change.
- No agent starts the next phase because the current one is finished. Phase starts
  are Aaron's. Releases and tags are Aaron's.

**Before starting any row, read in this order:** `AGENTS.md`, this plan's section
2 (the rules) and the row's own section, then revision 2.0 (in `docs/history/`)
only for the package detail it points to. Everything else under `docs/history/`
is read-only context, never direction.

**There is one plan.** This file is it. New planning is a new revision of this
file, never a new plan document. A Spec Kit `plan.md` under `specs/<issue>/` is an
implementation note for one issue and must point back to its row here; it is not
a roadmap.

**The development VM (week of September 28).** A fresh Windows VM is the shared
acceptance and qualification machine:

- It has nothing installed but Windows and a browser at the start. Snapshot it
  there ("blank"), then again after a clean `coop install` ("stable"), so any agent
  can reset to either.
- H1 and H6 are accepted only on the "blank" snapshot; H2 only on "stable" with
  `az` signed out; Phase 3 candidates only on a fresh install of the candidate
  version.
- Evidence from the VM (the installer's printed checklist, `coop doctor` output,
  the version report) goes into the PR. No credential values, no client data.
- The VM is not a teammate's machine and not Aaron's C: installation; nothing on
  it is precious, so acceptance may include uninstall and reinstall.
- **The VM gates acceptance, not the start of work.** Code, stubbed tests, and the
  PR for any Phase 0 row begin as soon as the row is `agent:ready`; CI's Windows
  runners prove the stubbed behavior. A PR may merge on green CI with its
  acceptance line marked "VM pending". Aaron runs the VM step before tagging the
  patch release, and the row's Status moves to `done (tag)` only then. H3 never
  needs the VM.

**Definition of done for the week:** Phase 0 rows H1, H2, H5, and H6 merged and
tagged as a patch release by Aaron, installed on the VM from the tag, and H3 either
merged or blocked only on the standards repositories.

## 15. What this review could not verify

- (Resolved 2026-09-28.) The two standards repositories were not readable from the
  cloud session; local clones were used for H3, which found the wiki layout
  described in section 3.
- No Windows workstation was available; installer and sign-in behavior is inferred
  from the scripts, the README, the v0.23.4/v0.23.5 changelog, and the B0 receipt.
- Dependency "latest" values are registry metadata on September 28, 2026; none was
  installed or run.
- Whether any client CI pipeline runs `coop-sql-review` or `coop-dax-review` today
  is still unknown. Section 7's decision to retire them from coop is taken; this
  question only decides whether the CLIs stay alive as optional gates.
