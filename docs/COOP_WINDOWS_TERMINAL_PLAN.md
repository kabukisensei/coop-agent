# Coop Windows Terminal: execution plan and experimental roadmap

**Document revision 2.0 · September 19, 2026**  
**Product scope: Coop 1.x Windows terminal now; native Windows Coop 2.0 last.**

**Canonical repository location:** `docs/COOP_WINDOWS_TERMINAL_PLAN.md`. This document supersedes the execution sequence and Desktop recommendations in *Coop_Windows_Simplification_and_Desktop_Handoff_v1*. The Markdown is the editable source of truth; the Word edition is a reading copy. Document revision 2.0 is not a Coop product release.

**Authority and status:** The product direction below reflects Aaron’s revised instructions. This is the forward execution plan, not a receipt that its work is complete. No branch, installation, package, team repository, credential, or production resource was changed while preparing it. Adoption of this plan does not authorize a wholesale implementation, a release, a push, or sending client data to a new service. Work one bounded package at a time.

## Executive decision

Continue from the accepted Windows terminal implementation. Do not rewrite Coop, merge the old Desktop branch, or build a new platform framework. Preserve official Pi, the existing capability layer, the custom theme, and the safety boundaries. Remove redundant implementations and obsolete responsibilities, then integrate worthwhile improvements through an isolated beta channel.

The immediate product is **one Windows terminal product with two independently installed channels: `coop` and `coop-beta`**. They share implementation, not mutable installation state. Stable remains usable while beta is installed, upgraded, tested, rolled back, or removed.

The work now has four distinct purposes: simplification; qualified component/skill updates; TeamAI shared knowledge; and optional Jev experiments. Those purposes may advance within the same program, but each PR must make its purpose and behavior changes explicit. No mixed “cleanup plus upgrade plus feature” PRs. An upgrade that removes a concrete workaround can precede the corresponding cleanup after its own acceptance.

**Desktop is removed from the current delivery scope.** Archive the existing Desktop plans and branches as reference material; do not port their runtime, installer, updater, renderer, or parity machinery. A genuinely native Windows desktop application is a final roadmap item called Coop 2.0, with a separate future design decision. A shortcut that opens the Windows terminal remains acceptable and is not a Desktop application project.

## Decisions that replace the previous plan

| Topic | Direction now |
| --- | --- |
| Supported product | Windows terminal. Retire macOS/Linux product orchestration after preserving unique Windows coverage. |
| Experimentation | An isolated `coop-beta` installation from an experimental branch and exact beta revisions; never a second checkout pointing at stable packages. |
| Upgrades | Research and qualify meaningful changes during this program, separately from mechanical refactors. No blanket latest-version sweep. |
| Skills | Review the complete effective skill/prompt set for freshness, selection accuracy, duplication, context cost, and safety. |
| Shared knowledge | Integrate Tencent `teamai-cli` in stages, including shared recall and contribution workflows; do not stop at local keyword search. |
| Jev | Introduce an optional, pinned experiment into beta early, after isolation and data-handling gates. Stable remains unchanged until evidence supports promotion. |
| Future Desktop | Native Windows Coop 2.0, last; full capability parity and justified quality-of-life improvements. No current Electron/Tauri/PiChamber/Supernova implementation. |
| Ownership | Pi owns the engine; vendors own their tools; TeamAI owns its knowledge functions; Coop owns the necessary integration, policy, provenance, and brand. |

# 1. Baseline reconciliation: do this before creating the beta build

## Release identity is not the same as the current main branch

The latest GitHub release observed in this review is **v0.23.3**, published September 17, 2026, at `969153246bdeb4d2a8d8f4aadec82df7cadacec4`. Current `main` was observed at **`9e8248a8b34a0bd7581b1909bf4fd18f253b3350`**, 60 commits ahead and zero behind that release. The previous review’s “main equals release” statement is no longer current. [S01–S03]

Current main still carries `coop_version: 0.23.3`, but its manifest has `pi-mcp-adapter 2.34.0` rather than the release’s `2.10.0`, and adds `pyodbc 5.3.0`. Its history and current changelog include newer SQL/approval, BPA, result-fingerprint, and Windows work. Do not discard those fixes by blindly starting again from the older tag, or treat all 60 commits as already released and accepted. [S03–S05]

**B0 decision:** identify the exact installation Aaron currently regards as stable. Record its checkout SHA, manifest hash, resolved Pi/Node/Python/CLI paths, loaded resources, and supported workflows. Reconcile the tag-to-main changes against that installation. Select a single accepted terminal SHA as the beta starting point. The user’s machine and actual installed SHA were not accessible in this review.

Version reporting must include **channel, Coop version, checkout/build SHA, manifest identity, and safe installation/profile paths**. A version string alone is insufficient. Never include credentials, raw environment dumps, or sensitive project metadata in that report.

## Capability and safety contract

Keep ordinary terminal launch, model sign-in, session resume/new/fork, profiles, on-demand `/start`, project and data-doc setup, SQL/DAX/BPA reviews, documentation and lineage, standards/provenance, knowledge access, logs, support diagnostics, configured MCP/API integrations, and the custom theme/footer/splash. Preserve current optionality: missing optional integrations or absent lineage must not make ordinary chat unusable. Reconcile newer accepted live-SQL/fallback behavior rather than resetting it to the old review’s assumptions. [S04, S05, S11]

The hard gates remain: **no source loss; no credential leakage; no permission/approval bypass; no accidental Fabric/database mutation; no update overwriting user-owned configuration; and a working supported Windows terminal path**. A discovered defect is a separate repair, not behavior to preserve blindly.

These guarantees apply to the governed, supported execution paths. Coop is not an operating-system sandbox against the Windows account owner or arbitrary trusted extension code. Side-by-side profiles prevent accidental state collisions, not malicious same-user code from reading another directory. Use a separate Windows account or disposable VM for untrusted extensions, invasive installer tests, or tools whose state cannot be separated safely.

# 2. A — Current architecture and ownership map

| Surface | Current role | Review direction |
| --- | --- | --- |
| `bin/coop.cmd`, `bin/coop.ps1`, `bin/coop` | Windows shim plus mirrored PowerShell/Bash orchestration; routing and launch preparation | Keep one Windows implementation; preserve necessary Git Bash entry with a small forwarder. |
| `lib/common.ps1`, `lib/common.sh` | Discovery, pins, paths, progress, package checks and compatibility | Consolidate repeated decisions and profile resolution; do not add a generic service container. |
| `scripts/install.*`, `update.*`, `sync.*`, `doctor.*` | Overlapping lifecycle responsibilities | Same implementation accepts an explicit installation context for stable or beta. |
| Four Coop extensions | Guardrails, domain tools, profile context, and branding | Keep extension identities; extract only duplicated logic or a concrete safety boundary. |
| Python helpers | YAML/project work, MCP generation, Azure/Warehouse helpers, knowledge Git/search, companion integration | Reuse working code; no language-conversion campaign. |
| JavaScript modules in `lib/` | Standards, provenance, retrieval, tool results, support | Keep independent of UI and private Pi internals. |
| Configuration and resources | Manifest, project contracts, skills, prompts, theme, vibes | One qualified version authority; explicit owner for every generated or user-owned file. |
| Legacy `web/` | Released experimental browser bridge and UI | Retire in a terminal-only phase after checking consumers and preserving durable user data. |
| Existing Desktop branches | Unreleased application and distribution work | Historical reference only. No active merge, port, packaging, or parity milestone. |
| Tests, acceptance and CI | Unit checks, mirrored shell tests, native Windows evidence | Retain supported workflows and destructive/security boundaries; collapse duplication. |

The architecture review is anchored in the prior release inspection and the current files checked for this revision. It is not a fresh line-by-line certification of all 60 newer commits. Each implementation package must inspect its actual starting SHA. [S03–S12]

**Target flow:** terminal command → channel-aware Windows entry → reusable configuration/policy/invocation decisions → official Pi with Coop extensions → official tools, MCP endpoints, and optional TeamAI/Jev integrations. There is no new agent engine or always-running orchestration service.

**Important distinction:** dropping Coop Desktop does not remove the **Microsoft Power BI Desktop Bridge CLI**. That vendor tool supports existing Power BI workflows and remains in the capability inventory. Likewise, `pi-web-access` is an agent research capability, not the retired Coop browser application. [S04, S08]

# 3. B — Findings and priorities

## P0: safe baseline and isolation prerequisites

**B01 — Channel identity is missing from the old operating model.** Current lifecycle code was designed around one installation and shared/global package locations. A separate Git branch or clone does not separate Pi, pipx tools, profiles, credentials, or update targets. A beta installer must refuse to fall back to the normal global installation. [S06, S12]

**B02 — `COOP_DIR` has conflicting meanings.** `scripts/onboard.py` and knowledge readers append `.coop` to its value, while the context-budget/support paths use it as the directory itself. Setting the old variable to `.coop-beta` is not a reliable isolation solution. Establish one explicit profile-root contract for the new beta route, preserve legacy stable defaults, and converge consumers before beta installation. [S07]

**B03 — Revalidate the original guardrail findings against the accepted SHA.** The v0.23.3 inspection found a broad enforcement exception path that could fail open and audit callers that retained truncated raw command text. Do not mark either fixed or still open from this document alone: newer guardrail work exists. Reproduce through registered handlers; repair any remaining exposure separately, without changing unrelated parsing or approvals. [S03, S09]

**B04 — Source protection includes external tools.** A reported Power BI Desktop Bridge issue describes reload/save losing model content. This is an upstream report, not a reproduced Coop defect. Include the affected workflow in disposable-copy acceptance and verify the installed Power BI Desktop/bridge combination before using it against valuable files. Never point beta at the stable session’s live Power BI process. [S31]

## P1: recurring complexity

Mirrored product Bash/PowerShell logic; repeated Windows executable and token handling; overlapping extension/package convergence; inconsistent project and MCP interpretation; duplicated source-of-truth lists; large dispatcher/tools modules; and legacy web operations are the primary reduction targets. Some useful shared modules already exist, including MCP generation, Warehouse helpers, Pi settings, and standards logic. Reuse them rather than wrapping them in a second “core” layer. [S06–S12]

TeamAI and Jev introduce a second kind of risk: importing an upstream tool’s defaults can accidentally introduce another hook manager, model router, updater, permission authority, or knowledge publisher. Integration must specify exactly which responsibilities transfer to the upstream component and which remain Coop-owned.

## P2: narrow cleanup and stale instructions

Current defaults still describe the older MCP adapter version, obsolete Warehouse proxy wording, and overlapping resource inventories. This is a concrete documentation/consolidation target, not a reason to update packages blindly. Older data-doc writer helpers, migration scripts and compatibility code remain conditional deletion candidates: prove there is no supported consumer before removing them. [S08, S10]

# 4. Side-by-side stable and beta: the installation contract

## 4.1 Branches and promotion

Use `experimental/windows-terminal` as the integration branch and small topic branches for individual refactors, upgrades, TeamAI work, and Jev experiments. Create it from the **accepted terminal SHA chosen in B0**, not from the old Desktop candidate. Keep `main` limited to stable-approved work going forward; reconcile its existing unreleased content before making that the team’s rule.

Publish testable beta builds as immutable, identifiable revisions. A tag such as `v0.24.0-beta.1` is an **example naming convention, not an authorized version bump or release**. Each beta records its source SHA, exact package manifest, lock/resolution evidence, skill source commits, and acceptance results. The experimental branch is a development stream; it is not an unqualified “always install latest” feed.

Promote small accepted changes through reviewed PRs. Do not promote the entire experimental branch merely because one feature works. Stable releases must not resolve prerelease tags or experimental refs automatically. Current branch-pull update behavior must be checked explicitly: labels and GitHub’s prerelease flag alone are not a channel boundary. [S12]

## 4.2 Separate mutable state, not just commands

The names below are proposed implementation targets. They do not describe capabilities already shipped.

| Resource | Stable `coop` | Proposed `coop-beta` |
| --- | --- | --- |
| Source | Existing accepted checkout; unchanged | Separate clone under `%LOCALAPPDATA%\CoopBeta\source` |
| Installed packages | Existing stable installation | Private beta npm prefix and beta pipx environments under `%LOCALAPPDATA%\CoopBeta\runtime` |
| Coop profile | Existing `~/.coop` layout | `%USERPROFILE%\.coop-beta` |
| Pi agent directory | Existing stable profile | `.coop-beta\agent`; separate extensions, auth, models and sessions |
| Caches and outputs | Existing locations | Beta-scoped MCP, npm/npx, standards, skills, knowledge, support and experiment caches |
| TeamAI | Existing/approved stable knowledge state | Beta `TEAMAI_HOME`, separate partition identity and sandbox team remote |
| Credentials | Existing approved stable stores | Explicit separate sign-in where supported; no automatic stable/personal credential symlinks or copies |
| Projects | Real working repositories | Disposable clones with beta project contracts and nonproduction targets |
| Launchers | `coop` and existing terminal shortcut | Unique `coop-beta` command/optional terminal shortcut; no overwrite of stable shim |
| Update/remove | Stable-owned files only | Beta-owned files only; beta uninstall preserves user data by default |

Adopt one new, unambiguous internal root contract, for example **`COOP_PROFILE_ROOT`** meaning the profile directory itself. This is a **proposed new setting**, not an existing workaround. Resolve agent, user, config, cache, audit and knowledge paths from it consistently. Keep compatibility for existing stable settings; do not silently relocate the stable profile or reinterpret a legacy variable on an existing installation. [S07]

A small installation-context record should carry channel, source root, profile root, package roots, and selected manifest. Existing lifecycle functions consume it. Do not copy the installer into `install-beta.ps1`, create a general dependency-injection framework, or introduce a second manifest schema.

## 4.3 Package and executable isolation

Use official package managers with explicit beta destinations. The implementation must pass a private npm prefix or use local installs; it must never issue an unscoped global install/update/uninstall. Set a separate npm/npx cache. Resolve Pi and managed npm executables from the beta package metadata and approved paths, not whichever `pi` happens to win PATH.

Use separate pipx home/bin locations and check actual installed distributions in those environments. A shared Node or Python executable is acceptable only when beta does not replace or reconfigure it and both channels deliberately use that exact compatible runtime. Testing a newer runtime requires a private beta runtime or a separate Windows account/VM. Do not rebuild the abandoned Desktop bundled-runtime distribution system to achieve this.

Child processes receive the intended environment and working directory, with inherited stable channel overrides and stale token variables cleared. Avoid broad machine/user PATH edits. Package child processes must remain bounded and owned; updating beta must not kill stable Pi, all `node.exe` processes, or another user’s tool session.

Native Windows path resolution remains important: `.exe` versus `.cmd`, argument quoting, spaces, Unicode, PowerShell 5.1, active file locks, and junction/reparse boundaries. “Private directory” is insufficient when it resolves through a link into stable state.

## 4.4 Credentials and third-party state

Do not fake isolation by changing the whole process’s HOME and hoping every dependency follows it. Inventory each tool’s actual caches, refresh-token writes, settings, discovery paths and project-local resources. Azure, TE, TeamAI, Pi extensions and MCP servers have different ownership models. Use documented tool-specific controls and verify behavior; otherwise isolate that integration with a separate Windows account or VM.

TeamAI’s source exposes a separate home and project partitions, but partitions and resource destinations are distinct. Its project resources can be written into the working tree, and linked worktrees share a project anchor. Use a separate clone and a dedicated sandbox workspace, and verify both data-home and resource-output isolation. A `TEAMAI_HOME` override is not proof that all agents’ hooks/settings remain untouched. [S16]

Model authentication should use explicit beta sign-in, not an automatic writable link to stable/personal Pi auth. API keys must never enter Git, normal config examples, chat messages, support exports, launch-spec JSON, or command arguments. Secret retrieval must occur only at the responsible invocation boundary. A secret inherited by every subprocess is not narrowly scoped simply because it came from an environment variable.

## 4.5 Safe preparation today versus future user commands

**Safe preparation today:** inspect the accepted stable installation, create a separate source clone, and create a local experimental branch at the selected SHA. This does not install a beta. The following is a source-only example; replace the placeholder after B0:

```powershell
$ApprovedCommit = '<40-character SHA approved in B0>'
$BetaSource = Join-Path $env:LOCALAPPDATA 'CoopBeta\source'
if ($ApprovedCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'Set the accepted terminal commit before continuing.'
}
if (Test-Path -LiteralPath $BetaSource) {
    throw 'Beta source already exists; inspect it instead of overwriting it.'
}
git clone --no-checkout https://github.com/kabukisensei/coop-agent.git $BetaSource
if ($LASTEXITCODE -ne 0) { throw 'Clone failed.' }
git -C $BetaSource switch --create experimental/windows-terminal $ApprovedCommit
if ($LASTEXITCODE -ne 0) { throw 'Branch creation failed; inspect the clone.' }
```

Do not run that clone’s current `coop install`, `coop update`, or bare `pi install` as a supposed isolated beta. Existing global/profile behavior must be addressed first. The example creates no remote branch, tag, release, or PR.

**Target experience after B1 ships and passes acceptance:** `coop` runs stable; `coop-beta` runs beta; `coop-beta doctor` inspects beta; and beta install/update/remove operate exclusively on beta state. A version selector for exact beta builds can be added to the existing lifecycle parser, but the syntax must be documented when implemented. Do not imply a new `--channel`, `--version`, or `--beta` flag exists today. Existing `--edge` means upstream-latest behavior; it is not a substitute for a qualified beta channel.

## 4.6 Isolation acceptance and rollback

First install beta with the **same approved component versions** as stable. Test install, launch, sync, Doctor, update, failure, rollback and uninstall while stable remains usable. Compare stable-owned file state and package inventories before/after; report only safe equality results, not credential contents or raw environment values. Confirm that sessions, theme, sign-in, project files, knowledge and approvals never cross channels.

Test a stale PATH, a missing beta tool, a malformed profile override, a beta root pointing through a junction, and an active stable session. The missing beta tool must not resolve to stable’s copy. A beta process failure must not leave an agent executing after shutdown.

Keep the previous known-good beta code and compatible package resolution. Roll back owned code/packages, not user documents or credential stores. Any durable schema migration needs a backup and explicit compatibility handling before promotion; never solve rollback by deleting the user’s beta sessions or merging beta configuration into stable. Normal same-user testing remains a convenience boundary, not a hostile-code sandbox.

# 5. C and D — Simplification packages and reusable boundaries

Each package below identifies complexity removed, behavior retained, expected disappearing concepts/files, real tests, and whether the result is smaller. Counts are targets unless marked as historical measurements. No new abstraction earns approval merely by giving code a cleaner directory name.

## S1 — Retire duplicate platform implementations

**Remove:** the duplicate POSIX product dispatcher/common library/lifecycle path. Preserve a tiny Windows Git Bash forwarder if users rely on that entry. **Unchanged:** supported Windows commands, arguments, exit codes, first-run behavior, supported shells, Pi’s own Bash tool and all capabilities.

**Reduction:** the original release review measured 12 Bash product files at 208,868 bytes (about 204 KiB), with a target of up to 11 deleted files and one reduced forwarder. This is a historical gross candidate surface, not a current-main saving or promise. Recount at the accepted SHA. **Smaller boundary:** one Windows implementation, no replacement platform facade. **Tests:** port unique assertions first; retain native Windows/Git Bash behavior and collapse parity-only/unsupported OS cases. A Linux unit-test runner does not constitute Linux product support. [S10, S13]

## S2 — Consolidate installation, update and sync

**Remove:** duplicated package lists, extension convergence, and identical installed/missing npm update branches. **Unchanged:** public lifecycle responsibilities, exact normal pins, opt-in experimental behavior, truthful postconditions, offline no-op, busy-process safety, dirty-checkout protection and user config ownership.

**Reduction:** one install-state branch and redundant per-package probe where still identical; two or more convergence implementations become one. A small installation context supports stable/beta without copying the scripts. **Smaller boundary:** functions in existing libraries, no task graph/workflow engine. **Tests:** one shared convergence suite plus thin command-sequencing tests; keep missing tool, wrong version, refusal and failure-exit cases. No dependency version changes in this mechanical PR. [S06, S12]

## S3 — Consolidate paths, configuration and policy interpretation

**Remove:** conflicting profile roots, repeated project discovery and overlapping readers that disagree about the same fields. **Unchanged:** legacy stable locations, per-session trusted policy snapshots, explicit targets and opt-outs, per-repository allow/deny rules, comments and unknown YAML fields, and no fallback to a sample project.

**Reduction:** one profile-root meaning; target at least two redundant discovery/reader implementations removed after a field-by-field mapping. **Smaller boundary:** normalized read data is separate from the surgical writer; do not build a universal configuration system or invoke Python on every tool call. **Tests:** retain real YAML/path variants, partial/no-source projects, ancestor selection, session switching and policy-edit resistance; combine duplicate reader fixtures, not non-destructive writer assertions. Profile isolation is B1’s prerequisite, not a future Desktop abstraction. [S07, S10]

## S4 — Share token/MCP checks; keep Doctor observational

**Remove:** repeated token frame/warning parsing and MCP validation/target predicates. With legacy web gone, delete its token wrapper rather than extracting a helper solely for a retired consumer. **Unchanged:** Azure-owned login, noninteractive bounded token acquisition, no persisted bearer, explicit malformed targets never broadening, ownership-aware MCP merge, and optional integrations failing softly.

**Reduction:** one duplicate warning/framing implementation and redundant validity predicates where they remain. Keep the small supervisor when it provides a real deadline/secret boundary. Doctor consumes the same target/configuration decisions; it must distinguish configured from probed and usable. Remove its separate transport only if a qualified public interface supplies equivalent bounded metadata discovery. No full agent launch, SQL call or interactive login to make Doctor “realistic.”

**Tests:** keep native `az.CMD`, strict output/timeout/stderr handling, inherited-token clearing, redirect rejection, config ownership, and metadata-only discovery. Combine logic cases while retaining one real Windows execution path. Do not invent a generic auth framework combining Pi, Azure, TE, TeamAI and Jev. [S10–S12]

## S5 — Remove legacy web and obsolete transition code

**Remove:** Coop’s old browser route, launch command wiring, browser-only assets/tests, and obsolete compatibility/migration helpers when no supported consumer remains. **Unchanged:** terminal behavior, terminal shortcut, research capability, saved sessions/profiles and user projects. This retirement no longer waits for a Desktop replacement.

**Reduction:** one product interface/transport stack can disappear. The original server/protocol surface was 99,919 bytes; that is historical scope, not a measured net deletion. Count only actually removed callers and assets. Old Desktop updater files live on a separate branch and do not count as main savings.

**Tests:** remove route/CSRF/browser rendering cases only with the entire corresponding surface; retain any parser/session/security code still used by terminal/support. Preserve data rather than migrate or delete it automatically. Recent archive-before-edit project migration and user-owned MCP entries are not obsolete merely because the directory says “legacy.” [S10, S12]

## S6 — Delete dead tool helpers and narrow mixed modules

**Remove:** proven-unreachable local data-doc render/write helpers, stale defaults and tests whose only consumer is dead code. **Unchanged:** authoritative companion questionnaire, cancellation, rich-config preservation, lineage reads, review scope and result/provenance contracts.

**Reduction:** eliminate the local writer/renderer concept where call-site analysis confirms it is dead; do not port it to a new module. Split a large tools/guardrails module only when extracting a real independent responsibility eliminates duplication or isolates a safety boundary. **Tests:** preserve JSONL completion/exit agreement and installed-companion acceptance; separate live assertions from obsolete writer tests before deleting test files. [S10, S11]

## S7 — Simplify tests and active documentation

**Remove:** test-only production early-exit modes, redundant fixture factories, duplicated BOM/parity gates, stale architecture instructions and duplicate pin lists. **Unchanged:** public dry-run behavior and supported safety/workflow acceptance.

**Reduction:** target the two historical update test-mode concepts (`COOP_UPDATE_GATE_DRYRUN`, `COOP_FLEET_TEST_MODE`) if still present; one authoritative operational plan and version manifest; one real native BOM check. Replace test modes with direct function tests and a narrow command integration check, not a large injectable framework. Update `AGENTS.md`, contributing/release instructions and CI in the same relevant PR so agents do not reinstate removed parity/Desktop obligations. [S08, S10, S12]

## Reusable core: a responsibility boundary, not a new product

Reuse the existing libraries for five concerns: installation/profile paths; project/policy interpretation; approved tool invocation; standards/knowledge provenance; and sanitized health/results. The terminal adapter handles arguments, dialogs, progress and exit presentation. Pi retains engine/session/provider ownership, official tools retain their execution semantics, and Coop retains policy decisions.

TeamAI gets a narrow CLI boundary; Jev gets one optional judgment boundary. Neither becomes the authority for source edits, credentials, package updates or permissions. No new daemon, workflow registry, plugin registry, RPC schema ecosystem or cross-platform UI layer is authorized. Future native Desktop can consume these existing boundaries when it is actually scheduled.

# 6. Meaningful component upgrades: qualify benefits, not version numbers

## Qualification policy

An update is worthwhile when it repairs a real Windows/security/compatibility problem, removes maintained compatibility code, preserves a required vendor interface, reduces proven context/latency cost, or enables an approved TeamAI/Jev experiment. “A newer package exists” is not sufficient. A version change, skill-content update and refactor are separate changes even when their dependency order is adjacent.

For every candidate, record: exact currently installed version and source; latest stable and preview tags as separately observed; publisher/repository identity; release notes and relevant change; supported Windows/Pi/Node/Python constraints; native/transitive dependencies; source/package integrity; intended gain; tests; rollback; reviewer. Verify installed output, not just package-manager success.

**Research boundary:** the table below is not a claim that every dependency’s latest published version was verified. Official release sources were verified for the named candidates. Several npm/registry fetches were blocked or inaccessible; unresolved rows must be checked on the implementation workstation with read-only metadata queries. Do not substitute similarly named PyPI packages for npm packages, confuse a VSIX version with an npm wrapper version, or infer Microsoft ownership from a package name.

## Candidate inventory, checked September 19, 2026

| Component | Observed Coop pin/state | Action and evidence |
| --- | --- | --- |
| Official Pi | 0.84.3 in release and current main | Qualify 0.85.1 independently. Official release fixes an SDK packaging problem; some Jev extensions require 0.85.1. Do not adopt experimental Pi server APIs. [S04, S13] |
| `pi-mcp-adapter` | Release 2.10.0; main 2.34.0 | Reconcile the already changed main version before another upgrade. Test isolation, direct HTTP, proxy identity/approvals and public APIs. Latest publication not established here. [S04] |
| `pi-hermes-memory` | 0.7.17 | Preserve private/session memory. Audit freshness, cache roots and coexistence with shared TeamAI knowledge; replacement is not assumed. |
| `pi-better-openai` | 0.1.22 | Check supported usage reporting and whether old source patches are unnecessary. Do not import Desktop-only patch machinery. |
| `pi-web-access` | 0.10.7 | Keep research capability. Qualify only meaningful API/Windows/security changes; not part of web-app deletion. |
| Structured-question extension | 1.20.0 | Preserve dialogs, cancellation and headless failure semantics; no automatic replacement with incompatible UI. |
| `context-mode` | 1.0.169 | Check isolation and overlap with Jev experiments. One active owner per pruning/compaction step; keep independent self-updates controlled. |
| Coop data-doc / SQL / DAX tools | 1.2.0 / 0.15.2 / 0.22.0 | Check current published companions and changes; main already contains fingerprint/BPA-related integration work. Preserve findings, provenance, lineage and setup contracts. [S05] |
| Fabric CLI / fabric-cicd | 1.7.0 / 1.3.0 | Qualify Python compatibility and validation behavior; no accidental deploy/publish/refresh. No new CLI invented for the library. |
| pyodbc | 5.3.0 on main; absent old release | Preserve accepted SQL fallback and timeout fixes. Record actual ODBC driver/runtime prerequisites; no machine driver update disguised as a beta package install. [S04, S05] |
| Report Authoring CLI | 0.1.4 | No newer exact publication verified. Test required report validation/output contracts with the qualified skills. |
| Power BI Modeling MCP | 0.5.0-beta.12 | Resolve current npm dist-tags and exact package identity. Preserve read-only invocation, connection scope, approvals and host compatibility; do not compare only VSIX numbers. |
| Power BI Desktop Bridge CLI | 0.1.2 | Keep it despite dropping Coop Desktop. Qualify the installed Power BI Desktop + bridge pair on disposable PBIP files, including unsaved-state/reload behavior. [S31] |
| `@microsoft/fabric-mcp` / `@azure-devops/mcp` | 1.3.0 / 2.9.0 | Check relevant official changes and executable/tool contracts. New tools remain unapproved until classified. |
| Unscoped npm `powerbi-mcp-server` | 0.1.0 | Verify publisher, repository and current publication. Keep only if it supplies necessary capability not safely replaced by qualified official tooling. No assumed Microsoft ownership. |
| `mcp-remote` | 0.1.38 | Prefer eliminating the remaining managed Learn bridge after direct HTTP acceptance; otherwise qualify and retain it. No blanket deletion of user-owned entries or OAuth caches. [S14] |
| Node / Python / package managers | Node minimum 22.19.0; actual installation to inventory | Keep known-good runtimes for isolation proof. Upgrade independently when required; record npm/pipx/Git/Azure/TE locations and versions. Do not globally update stable prerequisites from beta. |
| Tabular Editor CLI | Optional external binary; installed version unknown | Qualify 0.7.0 against the current main BPA integration. Vendor documents changed JSON/commands and preview expiry October 31, 2026; recheck availability before implementation. [S05, S15] |
| Tencent `teamai-cli` | Not an installed dependency in the observed Coop manifest | Candidate GitHub release v0.24.0 and tagged package version 0.24.0 verified. Confirm registry artifact and exact release behavior; main package metadata was inconsistent, so never use it as publication proof. [S17] |
| TypeSafe SDK and Jev | Not in observed Coop manifest | Official JS SDK is `@typesafe-ai/sdk`; resolve and pin its published version. Vendor model ID observed: `jev-1.13.0`. Pin it rather than moving aliases for comparisons. [S21–S23] |

All otherwise uncited Coop pins in this table come from the exact current-main manifest. They are recorded pins, not latest-version recommendations. [S04]

Read-only metadata checks include `npm view <exact-package> dist-tags --json`, `npm view <exact-package>@<version> version engines repository dist.integrity --json`, vendor release pages and PyPI metadata. Such checks do not authorize `npm install -g`, `pipx upgrade-all`, `pi update --all`, or enabling new MCP permissions. Capture results and time of check in the PR.

# 7. Official Microsoft refresh and complete skill-efficiency sweep

## 7.1 The concrete Fabric catalog migration

Coop’s observed catalog names `microsoft/skills` at `903dc62b1e4c833235b54db918a9a51cb6d3cc8f` for `kql` and `microsoft-docs`, and `microsoft/skills-for-fabric` v0.3.10 at `28f29abf3838e13f63a38e8664042b7d9f7cd69c` for Warehouse authoring/consumption. Operations is explicitly deferred. [S18]

The official v0.3.17 Fabric release, dated September 17, consolidates the old Warehouse skill split into `sqldw-cli` and reorganizes report guidance around `powerbi-report-cli`. A commit-pin-only update can therefore break the existing allowlist. Map names, references, prompts and permitted use explicitly. The combined skill’s wider content does **not** authorize previously deferred operations. [S19]

Fetch the complete required skill directories and referenced resources from an immutable source revision into beta’s catalog. Do not add another global skill/package manager just to download Markdown. The upstream repository documents installation paths that can register wider MCP/agent dependencies than the selected skill; Coop’s existing ownership/allowlist rules must remain authoritative. Keep license and provenance data. [S20]

## 7.2 Scope and classification

Inventory **every effective instruction source**, not only `skills/`: built-in Coop skills, prompts, extension-injected notes, project/ancestor instructions, official Microsoft catalogs, TeamAI-distributed resources, package-provided skills, optional personal/project discovery, and the proposed TypeSafe skill. Do not scan or publish private personal content unnecessarily; record ownership and selection behavior without copying private text into the review.

For each resource record: canonical name/path, owner, source URL/revision, last verification date, trigger description, task boundary, referenced CLI/API versions, tools it invokes, expected writes/network calls, precedence, overlap, startup bytes/tokens, on-demand size, known tests, and disposition. Use an ordinary Markdown table or existing manifest fields, not a new registry service.

Dispositions are **keep**, **update**, **merge**, **retire**, or **defer**. Every retired skill must name the surviving capability or the explicit scope decision. Every merged skill must preserve discoverability and valid examples. Do not replace five focused skills with an always-loaded encyclopedia merely to reduce file count.

## 7.3 Efficiency rules

Keep selection descriptions short and specific; move long examples and vendor reference material to on-demand references. Measure actual loaded context on the qualified Pi build. Reduce repeated workflow/guardrail prose while preserving critical local warnings and the binding reference to Coop policy. Instructions alone are never enforcement.

Prefer official up-to-date task guidance plus a small Coop-specific policy/standards overlay over copied vendor manuals. Do not fork official skill content just to reword it. Remove obsolete tools, old flag examples, nonexistent paths, auto-start instructions and duplicate catalog entries. Link repeated task standards to their authoritative resolver rather than pasting drifting copies.

Skill quality is behavioral: measure correct selection, useful output and safe tool use, not just word count. Use representative SQL review, DAX/BPA, lineage, discovery/no-source setup, Fabric metadata, report authoring, knowledge recall and ambiguous-task examples, plus confusing near-misses. Check for over-triggering, missing prerequisites, unnecessary full-context injection, unbounded retrieval, and instructions to publish/deploy without approval.

## 7.4 Refresh and promotion controls

Refresh in explicit install/sync/update operations, not on ordinary launch. Load the last accepted local catalog offline. Stage and validate new content before replacing managed active content; a failed fetch or validation keeps the last-known-good set. User-owned resources are neither overwritten nor silently adopted.

TeamAI/Microsoft/TypeSafe content cannot weaken Coop policy or grant a new capability. TeamAI rules/culture/hooks and project instructions are especially important trust inputs: lower-trust retrieved text is reference material, not a new system instruction. Preserve resource precedence and audit the actual effective set through Pi’s loader.

Record before/after startup context and skill count, task-selection outcomes, stale references removed, and exact source pins. Set an explicit per-PR budget from the measured baseline; no invented repository-wide “40% savings” target. A shorter skill that makes more mistakes fails the sweep.

# 8. TeamAI: full shared knowledge through controlled adoption

## 8.1 What is being adopted

This plan refers to **Tencent/teamai-cli**, the Git-backed `teamai` command, not an unrelated hosted TeamAI product. Its published interface covers resource synchronization, knowledge recall, contributions, codebase knowledge and team-improvement functions. The GitHub release/tag checked here is v0.24.0. Features documented on current main still require verification against the selected release artifact. [S17, S24]

Coop already has local knowledge clones, literal search, subordinate skills and `/share-learning`. TeamAI integration is an approved capability workstream, not a refactor disguised as an upgrade. Retain existing behavior until the new path demonstrates equivalent availability and safety. [S05]

**Target ownership:** TeamAI provides shared knowledge operations and its index. Coop provides a small bounded CLI adapter, resource precedence, destination selection, review/publication policy, result limits and provenance. Private Pi/Hermes session memory remains separate from shared team knowledge. TeamAI’s code graph does not replace SQL/DAX lineage or the standards authority.

## 8.2 K1 — Isolated CLI, read-only recall and sources

Install the exact TeamAI artifact only in beta’s package root. Initialize against a sandbox team repository and disposable workspace. Verify data-home/resource destinations and prevent setup from injecting hooks, rules, environment, MCP definitions or packages into stable Coop or other agents’ directories. Prefer a supported upstream configuration; when a required exclusion cannot be represented, limit the experiment to isolated CLI operations or a separate Windows account instead of patching vendor internals.

Qualify manual recall and explicit bounded synchronization first. Return capped results with repository, project, file, revision and available provenance; distinguish no match, unavailable, partial and stale fallback. Test cross-project separation with deliberately different harmless markers. Project filters/roles/tags are routing features, not a substitute for repository access control; confidential clients need separate authorization boundaries.

TeamAI lists **Oh My Pi** support; that does not establish official stock-Pi extension or hook compatibility. Coop’s adapter must be tested with the actual official Pi package. Do not install another agent runtime just to use its knowledge features. [S24]

## 8.3 K2 — Reviewed contribution and promotion

Preserve a deliberate `/share-learning` workflow: choose the intended team/project, draft the learning, remove secrets/client identifiers/unnecessary transcripts, preview the exact text and destination, then obtain explicit approval. Use sandbox content before any real team publication.

Upstream `teamai push` describes a branch/review/merge workflow, while `teamai contribute` publishes to a learnings branch. They are not interchangeable guarantees. A “learning” is still a remote write. Prove the selected CLI’s preview/draft and publication behavior; protect branches and credentials. When it cannot produce the required review boundary, keep the result local or hand it to the existing approved PR workflow rather than permitting an unreviewed direct push. [S24, S25]

Any generated learning remains subordinate to accepted standards and project policy. Promotion into a skill/rule is a separate reviewed change. Preserve attribution and the distinction between observed evidence and inferred advice. Never publish raw transcripts, source bundles, secrets, arbitrary environment, or client datasets automatically.

## 8.4 K3 — Broader knowledge lifecycle, deliberately enabled

After recall and contribution acceptance, evaluate multi-project subscriptions, selected skill distribution, stale-entry maintenance, codebase knowledge extraction/enrichment, and sanitized team summaries/digests. Gate each by real use, content ownership and supported release behavior. Upstream functionality should be used through documented interfaces, not reimplemented in Coop. [S24–S26]

Source extraction and enrichment require approval for the exact source and remote destination; client code does not become shareable because a graph omits some original text. Usage/session sharing remains off until a documented privacy review and member consent. Do not add a competing nudge when Coop and TeamAI already both detect learning opportunities; retain one owner after equivalent behavior is proved.

Default automatic session-start pulls or publishing hooks are not imported into Coop. Keep launch local and predictable; explicit `coop sync` can invoke the accepted TeamAI operations. A future automatic mode would require its own reliability and policy decision.

## 8.5 Migration and removal of duplicate custom knowledge code

Compare old/new retrieval on the same approved corpus. Preserve note IDs/paths where possible, archive mappings and retain a reversible read-only fallback during the trial. A fallback cannot silently fetch another client’s corpus or switch from semantic to literal search without saying so.

Remove the custom local search/sync path only after TeamAI covers its required supported workflows, offline behavior, dirty/unknown checkout protection, bounded process cleanup, safe clone/update and output limits. Do not run two writers/index owners forever. Keep the existing owned-process helper when it still supplies safety TeamAI does not. No source or note deletion is required for migration.

**K exit evidence:** real CLI version and paths; isolated config and resource destinations; successful scoped recall; bounded timeout/offline results; approved contribution reaching only the selected sandbox branch/PR; no automatic client upload; last-known-good behavior; and a before/after map of custom code retained or deleted.

# 9. Jev research and experimental integration

## 9.1 Current upstream evidence

TypeSafe documents Jev as a separate typed judgment service, called through its System One API, with an official JavaScript SDK `@typesafe-ai/sdk`. The current model page names **`jev-1.13.0`**; `jev-latest` and `jev-preview` are moving aliases. Pin the version for evaluations and record the returned model identity. Typed answers and confidence values do not prove an answer correct. [S21–S23]

The official TypeSafe skill is useful for implementation guidance, but installing the skill alone does not connect Coop to the service. Pin the entire skill directory, including references, through one catalog ownership path. Do not install duplicate global/manual copies or let skill updates silently change the runtime’s decision prompts. [S22]

## 9.2 X/Twitter findings and what they actually establish

Searches targeted X/Twitter as requested, including Jev/TypeSafe and Pi implementation terms. Direct retrieval of the original posts below returned access errors. An indexed X-build roundup supplied the post links and dates; the linked public project repositories were inspected to substantiate the implementation ideas. This is not a complete review of X threads, live demos, performance claims, or all Jev projects. The post dates below are those reported by the index. [S27]

| X lead or primary project | Verified idea | Coop disposition |
| --- | --- | --- |
| Antonio Coppe, indexed September 18: `Antoniocoppe/status/2100782560183738806`; `AntonioCoppe/jev-harness` | Confidence gates, shadow evaluation and reusable decision recipes | Borrow the evaluation discipline, not another harness/framework. [S28] |
| Mark, indexed September 18: `buchmarkk/status/2100793061370728620`; `buchmark/claude-jev` | Judgment for review findings and debugging/design choices | Consider advisory ranking of existing Coop findings; not a Claude plugin transplant or linter replacement. [S29] |
| Indexed Pi context post: `RelevantElement/status/2100979507830145486`; `kevinpita/pi-jev-context` | Reversible filtering while retaining original session history | Candidate for a later public/synthetic-history beta trial after Pi compatibility. Not approved for client transcripts. [S30] |
| `joelhooks/pi-fast-jev-compaction` | A stock-Pi pruning extension with explicit prompt-cache tradeoffs | Compare rather than adopt automatically; targets Pi 0.85.1 and Node 24.18, so it is not a zero-change fit for Coop’s current runtime. [S32] |

Repository evidence is design evidence, not proof of Coop compatibility or savings. Community extensions are not official Pi/TypeSafe components merely because they use the APIs. Do not install multiple routers/compactors and then build custom coordination around them.

## 9.3 J0 — Get Jev into beta early, with no behavioral authority

J0 can begin immediately after B1 isolation and the B0 safety checks; it does **not** wait for full TeamAI rollout or complete simplification. Use the current accepted Pi with a narrow official-SDK experiment when compatible. A community Pi extension requiring a new engine follows the separate Pi qualification first.

Start with a small beta-only integration that evaluates **skill/knowledge relevance on public, synthetic or explicitly approved sanitized task summaries**. Run in shadow mode: record what Jev would choose, but let existing deterministic/Coop behavior continue. This tests whether Jev adds value without changing tools, approvals, loaded policy, source files, or session history.

Use one SDK/invocation adapter, one reviewed prompt/criteria file and a small replay dataset. Prefer an adequate upstream public extension when its defaults and configuration fit; otherwise the thin SDK boundary is justified custom capability code. Do not import a second harness, router framework, memory service or state-machine library solely for this experiment.

## 9.4 Follow-on experiments and priorities

| Stage | Experiment | Boundaries and promotion test |
| --- | --- | --- |
| J1 | Skill/knowledge relevance suggestions and optional bounded reranking | No hiding of mandatory standards or required lineage; retrieval still respects project/source permissions. Demonstrate better relevance without more missed required context. |
| J2 | Review triage and learning-value suggestions | Original SQL/DAX/BPA findings and severities remain visible and unchanged. Suggestions cannot close issues, suppress errors or publish learnings. |
| J3 | Reversible model-context pruning | Preserve raw Pi history and protected instructions, approvals, targets, provenance and tool-call/result structure. Compare with stock Pi compaction and context-mode separately. |
| Later | Model routing among already approved providers/models | Separate data/cost/provider approval, visible user override and original-model fallback. No automatic new credential or provider domain. |
| Coop 2.0 research | Explainable suggestions and a context/knowledge preview UI | Reuse accepted judgments, not a parallel desktop policy engine. No current UI implementation. |

Pruning is not “lossless” merely because the remaining text is verbatim. Keeping the original session file protects recovery, but a future model request can still omit essential information. One reviewed community extension documents that old pruning remains on an API error; that differs from a simple “all failures restore baseline” promise. Test and specify the exact behavior rather than borrowing the README’s general reversibility claim. [S30]

Measure total provider cost and prompt-cache effects, not just reduced tokens in one request. A pruning pass can invalidate the main model’s cached prompt and make repeated calls more expensive. This tradeoff is explicitly documented by an inspected Pi extension. [S32]

## 9.5 Non-negotiable Jev controls

**Authority:** Jev is advisory. It never grants, broadens, persists or bypasses approval; changes tenant/workspace/SQL scope; authorizes a source commit; marks a failed test passed; or overrides a deterministic deny. A future risk classifier could only add review/escalation, not make a prohibited action allowed.

**Data:** shadow mode still sends data off-machine. Start with synthetic/public tasks and no real transcripts. Review TypeSafe’s account terms and data handling before any client material. The vendor’s no-training statement is not the same as zero retention; its documentation offers ZDR for enterprise customers. Approval must cover the actual payload and account, not an assumed provider policy. [S21, S23]

**Secrets:** no keys in Markdown, Git, launch specs, command arguments or transcript. Use a reviewed secret-retrieval path and narrowly scoped request credentials. Restrict the API endpoint to the approved HTTPS service and reject credential-forwarding redirects. Do not let task/project text redirect the key to an arbitrary endpoint.

**Availability and cost:** off by default, explicit beta enablement, finite request size and total deadline, cancellation, concurrency/rate limits and a small operator-approved cost cap. Account for SDK retries within that deadline. Missing key, offline service, timeout or malformed response must not block ordinary Coop; governed policy/approval errors must still fail closed. These are different failure domains.

**State:** store safe experiment metadata—case ID, model/prompt revision, choice, score, latency, usage, outcome—not raw client payloads. Session switches, forks and cancellation must not apply an old answer to a new task. Do not automatically overwrite current provider compaction or memory.

## 9.6 Evaluation and graduation

Create a small labeled set drawn from actual Coop task categories, using sanitized/synthetic material. Include ambiguous routing, no useful knowledge match, stale content, disconnected service, malformed output, cancellation, and attempts to smuggle permissions into retrieved text. These are real safety boundaries, not an exhaustive provider/OS Cartesian product.

Compare baseline, shadow Jev and each enabled candidate separately. Record task success, required-context misses, false routing, latency, total model/API cost, main-model cache changes, and human correction rate. Calibrate prompts and thresholds on representative cases; do not adopt a universal confidence threshold from a demo.

Promotion requires a repeatable benefit, unchanged safety behavior, zero protected-state changes in the acceptance suite, understandable failure handling, no stable installation effects, and a reviewer-approved data policy. An experiment that does not justify its maintenance/dependency cost is removed from beta or left as a documented offline research result. No permanent extension is owed a place because it was interesting on X.

# 10. E — Test retention, consolidation and new acceptance

| Family | Keep | Combine or remove only when justified |
| --- | --- | --- |
| Channel isolation | Stable untouched during beta install/update/sync/Doctor/rollback/remove; no global fallback; distinct sessions/config/cache/tool identity | Share temporary-home and package fixtures; do not replace native proof with only mocks. |
| Guardrails | Source commit protection; destructive operations; SQL/MCP scope; decline/missing/throwing UI; trusted policy snapshots; audit canary secrets | One registered-handler suite with shared cases; remove duplicated setup, not adversarial inputs. |
| Accepted newer SQL behavior | Current grant scope/revocation/transactions/fallback timeout and single intended executor | Reconcile tag-to-main test inventory; do not restore old assumptions. |
| Windows | PowerShell 5.1 and supported 7 path; `.cmd`/`.exe`; Unicode/spaces; one BOM gate; owned children/timeouts; actual Git Bash backend | Retire POSIX product and unsupported synthetic matrix cases after unique coverage moves. |
| Lifecycle/config | Exact package state, offline no-op, honest failures, dirty/unknown checkout, user-owned fields, backup and migration safety | Test common convergence once plus public verb sequencing. |
| MCP/auth/Doctor | Nonpersisted tokens, no command/env dump leakage, no broader invalid target, no interactive auth or SQL in probes | Delete web-specific wrappers/tests with web retirement; retain remaining transport boundaries. |
| Companions and TE | Installed CLI output contracts, findings fingerprints versus provenance hashes, lineage/setup JSONL, BPA/exit behavior | Share output fixtures; keep one native installed-tool workflow. |
| Skills | Actual effective resource set, precedence, offline catalog, alias migration, relevant and near-miss triggers, bounded context | Remove duplicate prompt copies and obsolete-skill fixtures with traceable replacement. |
| TeamAI | Real CLI in sandbox repo; source/project separation; bounded/offline recall; no unauthorized hook/config injection or publication; reviewed contribution | Retire old search/sync/nudge only after parity and fallback disposition. |
| Jev | Disabled means no requests; shadow means no behavior change; key/payload containment; deadline/cancel; invalid-output fallback; protected context | Small representative dataset, not thousands of theoretical model combinations. |
| Legacy web/Desktop | Durable data preserved; terminal shortcut remains | Delete browser route tests with route; old Desktop tests remain historical, not new terminal release gates. |

Keep a small Windows acceptance run in addition to fast unit checks. Use disposable projects, nonproduction scopes, and explicit approval for any live integration. No safety gate requires a real destructive operation: assert the underlying executor is not called, and inspect before/after source/configuration state. Real Windows process fixtures are justified where they reproduce native lifecycle failures.

A test is removable only if its supported behavior is removed, the same boundary is genuinely covered elsewhere, or the environment is explicitly unsupported. Record that mapping. Do not optimize for a test-count target; test reduction follows implementation reduction.

# 11. F and G — Ordered work packages and reduction estimates

## Delivery sequence and dependencies

| ID | Work package | Starts after | Completion evidence |
| --- | --- | --- | --- |
| B0 | Reconcile installed stable, release/main changes, capability map and original safety findings | Plan adoption | Accepted SHA/manifest/resource inventory; explicit unresolved defects and owners |
| B1 | Implement isolated beta context, launch/install/update/remove and identity | B0 | Stable remains unchanged through full beta lifecycle; same component versions initially |
| S1–S2 | Small deletion/lifecycle simplification slices | B1 | Native Windows parity, real reduction counts, no hidden version changes |
| U1 | Qualify useful Pi/adapter/vendor updates one family at a time | B1 | Exact old/new versions, benefit, native tests and rollback |
| SK1 | Complete skill inventory, freshness sweep and Microsoft catalog mapping | B0 for audit; B1 for trial | Effective resource manifest, task/near-miss checks, before/after context and explicit permission map |
| J0 | Optional Jev SDK/skill and shadow experiment | B1 + data approval + required compatibility | Public/synthetic replay succeeds; no policy/state change; budget and kill switch |
| K1 | TeamAI isolated install and scoped recall | B1 | Real CLI destinations, sandbox remote, no unintended injection, offline/bounds checks |
| K2 | Reviewed learning contribution and publication | K1 | Approved exact payload/destination; only intended sandbox PR/branch changes |
| S3–S7 | Config/auth/tool/web/test/documentation consolidation | Relevant baseline/consumer gates | Removed duplication; no active consumer or durable user data lost |
| K3 / J1–J3 | Broader TeamAI lifecycle and measured Jev behavior | Their individual earlier gates | Demonstrated user benefit and safety; explicit keep/drop decisions |
| R1 | Promote selected terminal packages into stable | Each package’s independent acceptance | Scoped PR/release approval; stable rollback and no beta state import |
| D2 | Native Windows Coop 2.0 discovery | Terminal program accepted and separately prioritized | Future design/UX/runtime fit report only; no current implementation commitment |

J0 and K1 may run as separate beta topics once isolation is proven. Do not wait for every refactor before learning whether the new components help. Conversely, do not use the Jev/TeamAI work to rush past a profile or credential isolation failure. Each merge into the experimental integration branch should remain independently revertible.

## Reduction and cost ledger

| Work | Expected disappearance | Estimate and caution |
| --- | --- | --- |
| Windows-only orchestration | Second product implementation and parity obligations | Historical 12-file/204 KiB gross surface; remeasure; small Windows forwarder may remain. |
| Lifecycle consolidation | Repeated convergence and identical decision branches | Provisional 10–20% reduction in touched duplicated lifecycle code, not whole repo; measure PR result. |
| Profile/MCP/config consolidation | Conflicting roots and repeated predicates/readers | Target one root contract and at least two redundant readers/predicates; no honest LOC total yet. |
| Legacy web retirement | Browser product, bridge/UI-only routes and their fixtures | Conditional deletion; historical 97.6 KiB server/protocol surface is not all of web and not a guaranteed saving. |
| Dead helper/test/doc cleanup | Unused writer concepts, test-only runtime modes, duplicate fixtures/version prose | Per-symbol/per-assertion evidence required; no blanket percentage. |
| Beta isolation | None initially; prevents a second maintained installer | A justified small addition. Count new paths/flags/helpers and shared implementation separately. |
| TeamAI adoption | Eventually custom retrieval/index/sync/nudge work that upstream safely replaces | Net code can grow during trial; remove the obsolete owner after acceptance, not before. |
| Jev experiment | Potentially repeated model effort or context cost, not deterministic safety code | Initial code/dependency addition. Drop the experiment if benefit does not cover maintenance. |
| Deferred Desktop | Current roadmap obligations, not current-main code | No Desktop branch LOC claimed as terminal savings. |

Record authored nonblank lines, files, helpers, behavior branches, process hops, mutable stores, supported modes, dependencies and tests before/after each package. Count generated lockfiles separately; do not add overlapping mirror/lifecycle estimates. A rename or file move is not a reduction. Security fixes can add code; speculative architecture cannot claim savings without deleting something real.

# 12. H — Explicitly not worth doing now

Do not rewrite Coop, fork Pi, recreate Microsoft/TE executors, port the Python companions to TypeScript, or move every module simply to standardize style. Keep working public interfaces and exact executable/output contracts.

Do not remove awkward Windows code merely because it is verbose: BOM/quoting/null/exit handling, compatible Python selection, locked-file checks, process ownership, safe temporary paths and atomic publication protect actual regressions. Consolidate duplicates while retaining their behavior.

Do not remove `pi-web-access`, the Power BI Desktop Bridge, live integration guardrails, safe migrations, private session memory or brand assets because their names resemble retired Desktop/web work. Do not replace deterministic authorization or schema validation with Jev judgments.

Do not adopt TeamAI’s entire hook/MCP/environment/package-management surface by default, or add another indexing engine beside TeamAI without a demonstrated gap. Do not build a UI, background service, telemetry backend, cloud agent, native updater, or universal error taxonomy as part of this pass.

Do not prune protected instructions or relevant evidence merely to meet a context-token target. Do not invent future environments to justify large fixture matrices. Preserve actual unsupported-state rejection and destructive boundaries.

# 13. Last on the roadmap — native Windows Coop 2.0

Coop 2.0 means a native Windows application, not continuing the existing Electron/Tauri/browser application. Its schedule is **deferred** and its technology is **not selected**. When authorized, compare native Windows options such as WinUI/.NET and WPF against accessibility, packaging/support burden, responsiveness and public Pi integration. No current terminal milestone depends on that choice.

Its non-negotiable starting point is parity with the accepted terminal product: sessions, providers, profiles, tools, skills, knowledge, lineage/reviews, approvals, source/config safety, official integrations, diagnostics and the custom brand. “Parity” does not require a pixel-for-pixel terminal; it requires completing the same work safely.

Candidate improvements to research later are a unified findings/lineage view, reviewable edit/approval previews, scoped knowledge search/contribution, visible context and Jev decisions, project/connection health, accessible keyboard navigation, and clear channel/version identity. Each must solve an observed workflow problem. No autonomous publish/deploy, permission expansion or automatic client-data upload is implied.

Use the public Pi SDK or stdio RPC contract qualified at that time; avoid source-only experimental engine APIs. The UI must not mint permissions or maintain a second policy/configuration implementation. Terminal-driven installation/update and a shortcut may remain acceptable; a custom installer or updater needs an explicit cost/benefit case. [S13]

Preserve the old Desktop branches and design evidence as history. Salvage an idea or asset only after review; do not merge the branch wholesale, import its managed-runtime platform, or make “reusing sunk work” the justification for a non-native architecture.

# 14. Handoff, approvals and living status

## Repository adoption

Put this Markdown at the canonical path and add a short link from `AGENTS.md`. Mark prior Desktop/simplification execution plans superseded; retain them as historical evidence rather than leaving conflicting active commands. Keep stable operational instructions accurate until a change actually ships. New beta commands must not be advertised as available before B1 exists.

A maintainer edits this plan’s status table as work closes. Each closed row links to the PR/commit and acceptance receipt. Do not build a separate planning app. Use existing GitHub issues for bounded tasks and the normal release process for approved releases.

## Starting work register

| ID | Status at this revision | Next action | Owner |
| --- | --- | --- | --- |
| B0 | Ready for implementation planning | Establish actual stable SHA; reconcile 60-commit delta and safety findings | Product owner + Windows reviewer to assign |
| B1 | Blocked by B0 | Design and prove one isolated beta installation context | Unassigned |
| S1–S7 | Review findings; not implemented | Select smallest independent deletion after required evidence | Unassigned |
| U1 | Candidate research completed in part | Resolve remaining registry metadata and qualify useful families | Unassigned |
| SK1 | Ready for inventory | Full effective-skill map; Fabric v0.3.17 migration and efficiency evidence | Unassigned |
| K1–K3 | Approved roadmap direction; not installed | TeamAI v0.24.0 artifact/destination verification and sandbox recall first | Unassigned |
| J0–J3 | Approved experimental direction; no API calls made | Exact SDK/skill pins; public/synthetic shadow evaluation first | Unassigned |
| R1 | Blocked by package-specific acceptance | Promote only reviewed, proven terminal changes | Product owner |
| D2 | Deferred; last | Native Windows discovery only when separately prioritized | Unassigned |

## Per-package acceptance receipt

Record the work ID and purpose; starting/ending SHA; package and skill pins; exact Windows/shell/runtime versions; resolved safe paths; behavior intentionally changed; retained capabilities; tests run and native evidence; source/config before-after result; tests removed and replacement coverage; reduction/new-concept measurements; data/network activity; unresolved limitations; rollback; and reviewer/date.

For TeamAI add selected repo/project/branch and sanitized publication evidence. For Jev add model and prompt revision, dataset identity, actual requests/cost/latency, decision-quality results and protected-context checks. A simulated receipt is not a real Windows test, and a beta test is not a production acceptance.

## Stop conditions

Stop the affected package when beta can write stable state; a tool silently falls back to global credentials/packages; an invalid target broadens; a model answer becomes permission; an approval failure executes the action; a token enters logs/arguments/renderer data; an update overwrites user fields; a child agent survives shutdown; or a deletion has an unresolved supported consumer.

Also stop when an upstream integration needs a lasting private fork, more permanent frameworks than it removes, unreviewed client publication, or an implicit dependency upgrade. Keep ordinary stable Coop available. Do not erase data or use reset/clean/force commands to make acceptance pass.

## Instruction for the implementing agent

Start with B0 and propose B1 as the first bounded implementation package. Do not implement the roadmap all at once. Read current repository instructions and this plan, verify the exact starting SHA and clean/owned work area, and preserve uncommitted work. Do not commit, push, tag, release, change branch protection, publish knowledge, or call paid/live services without the corresponding explicit authorization. When B1 passes, schedule the smallest refactor, the meaningful upgrade/skill slice, K1 and J0 as separate changes. D2 stays deferred.

# 15. Evidence index and review limits

This revision used the supplied prior plan, current GitHub release/main/configuration reads, official upstream documentation/releases and the primary repositories behind Jev ideas. It did not execute Windows, install packages, run a GUI, exercise TeamAI against a team remote, call TypeSafe with an API key, or access Fabric/database resources. No entire-repository fresh certification or exact current-main code-reduction measurement is claimed.

Latest registry publication could not be established for every package because several npm/registry requests were blocked/inaccessible. The unresolved inventory is explicit; read-only verification is a mandatory implementation gate. X post bodies could not be directly retrieved, and index dates are not independent performance evidence. Recheck mutable upstream pages and pins before implementation.

## Repository and prior-review sources

- **S01 — Released baseline:** [Coop v0.23.3](https://github.com/kabukisensei/coop-agent/releases/tag/v0.23.3), published September 17, 2026.
- **S02 — Observed main:** [9e8248a8b34a0bd7581b1909bf4fd18f253b3350](https://github.com/kabukisensei/coop-agent/commit/9e8248a8b34a0bd7581b1909bf4fd18f253b3350).
- **S03 — Release-to-main delta:** [Pinned comparison](https://github.com/kabukisensei/coop-agent/compare/969153246bdeb4d2a8d8f4aadec82df7cadacec4...9e8248a8b34a0bd7581b1909bf4fd18f253b3350), 60 commits ahead as observed.
- **S04 — Current exact pins:** [Release manifest at observed main](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/config/release-manifest.json).
- **S05 — Current and historical capabilities:** [Changelog at observed main](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/CHANGELOG.md), Unreleased and v0.23.2–0.23.3.
- **S06 — Path/manifest helpers:** [lib/common.ps1](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/lib/common.ps1).
- **S07 — Conflicting profile roots:** [scripts/onboard.py](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/scripts/onboard.py), [scripts/context-budget.py](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/scripts/context-budget.py), [scripts/search-knowledge.py](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/scripts/search-knowledge.py), and [lib/support-center-cli.mjs](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/lib/support-center-cli.mjs).
- **S08 — Duplicate/stale defaults:** [config/defaults.yml](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/config/defaults.yml).
- **S09 — Original guardrail findings:** [v0.23.3 guardrails source](https://github.com/kabukisensei/coop-agent/blob/969153246bdeb4d2a8d8f4aadec82df7cadacec4/extensions/coop-guardrails/index.ts). Historical static findings; revalidate at B0.
- **S10 — Previous full review:** supplied `Coop_Windows_Simplification_and_Desktop_Handoff_v1.md`, revision 1.0, September 18, 2026; architecture, call-site candidates, test inventory and historical byte counts. Superseded execution sequence, retained evidence.
- **S11 — Companion capability boundary:** [Released coop-tools documentation](https://github.com/kabukisensei/coop-agent/blob/969153246bdeb4d2a8d8f4aadec82df7cadacec4/extensions/coop-tools/README.md).
- **S12 — Inspected lifecycle baseline:** [Released update.ps1](https://github.com/kabukisensei/coop-agent/blob/969153246bdeb4d2a8d8f4aadec82df7cadacec4/scripts/update.ps1), [sync.ps1](https://github.com/kabukisensei/coop-agent/blob/969153246bdeb4d2a8d8f4aadec82df7cadacec4/scripts/sync.ps1), [Warehouse helper](https://github.com/kabukisensei/coop-agent/blob/969153246bdeb4d2a8d8f4aadec82df7cadacec4/lib/warehouse_mcp.py), [MCP generator](https://github.com/kabukisensei/coop-agent/blob/969153246bdeb4d2a8d8f4aadec82df7cadacec4/lib/mcp_config.py). Reconcile with B0’s actual baseline before editing.

## Official upstream sources, accessed September 19, 2026

- **S13 — Official Pi:** [Releases](https://github.com/earendil-works/pi/releases), including v0.85.1; [Windows documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md). Current docs do not prove availability in an older installed version.
- **S14 — Microsoft Learn transport:** [Official MCP repository](https://github.com/MicrosoftDocs/mcp), direct Streamable HTTP interface.
- **S15 — TE CLI:** [Official 0.7.0 release, September 14, 2026](https://tabulareditor.com/blog/tabular-editor-cli-0-7-0-release). Preview and interface constraints require rechecking.
- **S16 — TeamAI directory semantics:** [Data-directory design](https://github.com/Tencent/teamai-cli/blob/main/docs/designs/data-directory-layout.md) and [source](https://github.com/Tencent/teamai-cli). Main documentation; verify the chosen tag and actual Windows behavior.
- **S17 — TeamAI version evidence:** [Release v0.24.0](https://github.com/Tencent/teamai-cli/releases/tag/v0.24.0) and [tagged package.json](https://github.com/Tencent/teamai-cli/blob/v0.24.0/package.json). Registry availability/integrity still to verify.
- **S18 — Coop Microsoft catalog baseline:** [skills/_microsoft/README.md](https://github.com/kabukisensei/coop-agent/blob/9e8248a8b34a0bd7581b1909bf4fd18f253b3350/skills/_microsoft/README.md).
- **S19 — Fabric skill migration:** [Official releases](https://github.com/microsoft/skills-for-fabric/releases), v0.3.17, September 17, 2026.
- **S20 — Fabric resource/install scope:** [Official skills-for-fabric repository](https://github.com/microsoft/skills-for-fabric).
- **S21 — Jev identity and model behavior:** [TypeSafe models](https://docs.typesafe.ai/models).
- **S22 — TypeSafe official skill:** [Agent-skill guidance](https://docs.typesafe.ai/agent-skill) and [skill source](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai).
- **S23 — TypeSafe integration and data review:** [Quick start](https://docs.typesafe.ai/introduction/quickstart), [patterns](https://docs.typesafe.ai/patterns), and [legal/data-policy links](https://docs.typesafe.ai/legal).
- **S24 — TeamAI behavior and agent coverage:** [Official README](https://github.com/Tencent/teamai-cli).
- **S25 — TeamAI command workflows:** [Official usage guide](https://github.com/Tencent/teamai-cli/blob/main/docs/usage-guide.md).
- **S26 — TeamAI implementation/release changes:** [v0.24.0 release notes](https://github.com/Tencent/teamai-cli/releases/tag/v0.24.0), including data layout, Windows launch and scope changes.

## Jev community evidence and upstream risk report

- **S27 — X discovery index, secondary source only:** [Best X Builds: Jev](https://www.bestxbuilds.com/jev). Used to locate posts, not certify benchmark claims. Direct X access was blocked.
- **S28 — Shadow/decision patterns:** [AntonioCoppe/jev-harness](https://github.com/AntonioCoppe/jev-harness); [original X post](https://x.com/Antoniocoppe/status/2100782560183738806), body not directly retrieved.
- **S29 — Review-scoring ideas:** [buchmark/claude-jev](https://github.com/buchmark/claude-jev); [original X post](https://x.com/buchmarkk/status/2100793061370728620), body not directly retrieved.
- **S30 — Reversible Pi context:** [kevinpita/pi-jev-context](https://github.com/kevinpita/pi-jev-context); [indexed X lead](https://x.com/RelevantElement/status/2100979507830145486), body not directly retrieved. The X poster is not assumed to be the repository author.
- **S31 — Reported external source-loss risk:** [Microsoft skills-for-fabric issue 81](https://github.com/microsoft/skills-for-fabric/issues/81). Reporter’s reproduction, not reproduced in this review; current applicability must be checked against installed versions.
- **S32 — Stock Pi pruning and cache tradeoffs:** [joelhooks/pi-fast-jev-compaction](https://github.com/joelhooks/pi-fast-jev-compaction). Community implementation evidence, not Coop acceptance.

**Operating principle:** keep stable boring; make beta genuinely separate; delete duplication; qualify useful upstream changes; let TeamAI and Jev earn their integration; and leave native Desktop until the terminal product and its boundaries are proven.
