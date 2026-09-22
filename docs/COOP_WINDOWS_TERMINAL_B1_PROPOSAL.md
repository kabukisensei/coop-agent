# B1 proposal — one isolated Windows beta lifecycle

**September 19, 2026 · Proposal only. Not implemented, installed or approved.**

This proposal follows the [B0 receipt](COOP_WINDOWS_TERMINAL_B0.md) and [canonical plan](COOP_WINDOWS_TERMINAL_PLAN.md). Its single outcome is a beta installation whose launch and lifecycle operations cannot accidentally select or modify stable-owned state. It does not simplify platforms, retire web, upgrade dependencies, add TeamAI/Jev, or start Desktop work.

## Entry decisions and constraints

1. Preserve accepted terminal ancestry `9e8248a8b34a0bd7581b1909bf4fd18f253b3350`. The existing experimental branch at review head `a339dff88a66a53b884e26bd903faad272f2cb21` adds documentation only and already has that ancestry. Recheck ownership, clean status and current remote ancestry before work; retain intervening changes. Do not reset, force-push or reinstall stable.
2. Authorize B1 explicitly. Approval of this document's existence does not authorize its execution, package installation, sign-in, service calls or publication.
3. Repair G01/G02 in a **separate bounded safety change** and retain its reviewed commit before beta governed-workflow acceptance. Pure offline B1 context/fixture work could be reviewed independently, but no beta client/live trial or promotion may pass with those defects open. Do not fold safety fixes into a cleanup or upgrade PR.
4. Resolve B0 I02 before real provisioning. Pi, six extensions and Python companion/runtime versions are verified; Fabric MCP, Azure DevOps MCP and mcp-remote have conflicting manifest/cache versions. Produce an explicit old/selected-version decision. Neither forcing manifest values nor cloning the current cache is a neutral isolation step. Keep these integrations disabled in the initial offline fixture until that decision is approved; disabled fixtures are not full MCP acceptance.
5. The C: installation and client projects remain read-only. Do not move or clear `E:\Codex\coop-pr66-20260919`, because stable references packages there. Use a new owned E: root for all beta/test artifacts whenever possible.

## Proposed contract

Use existing lifecycle functions with one small validated installation-context record: channel, exact build SHA, source root, profile root, npm/package/cache roots, pipx roots, selected manifest path and its hash. It is data passed to existing code, not a registry, service container or new manifest schema.

Propose `COOP_PROFILE_ROOT` to mean **the profile directory itself**. Derive agent, config, user preferences, sessions, auth/models, audit, standards, knowledge and support paths from it. Retain all legacy stable defaults and precedence. Do not reinterpret `COOP_DIR` on the live installation. Every consumer involved in beta must use the normalized context; unrelated policy-reader cleanup remains S3.

The following are **proposed destinations**, not directories created or interfaces available today:

| Resource | Proposed E: location / rule |
| --- | --- |
| Owned beta root | `E:\CoopBeta` after checking it does not already belong to another task and resolves wholly within the intended boundary |
| Source | `E:\CoopBeta\source`, separate clone, recorded exact accepted build revision |
| Profile / Pi agent | `E:\CoopBeta\profile` / `E:\CoopBeta\profile\agent` |
| Node packages | Private prefix/package root under `E:\CoopBeta\runtime\npm`; exact Pi executable resolved from its package metadata |
| Python tools | `E:\CoopBeta\runtime\pipx` plus beta-only application bin directory; Fabric Python kept distinct from general Python |
| Caches and temporary work | `E:\CoopBeta\cache` and `E:\CoopBeta\temp`; explicit npm/npx, MCP, standards and skill destinations |
| Launcher | Unique `coop-beta` shim under `E:\CoopBeta\bin`; absolute invocation initially, no stable shim or machine/user PATH replacement |
| Test projects | New disposable clones under an owned E: test root, never stable client working trees or linked worktrees sharing resources |
| Credentials | New beta sign-in only after explicit authorization; no copies, links or automatic fallback to stable/personal auth |

The canonical plan's LocalAppData/profile locations are target examples. This workstation proposal uses E: to honor the user's storage preference without moving existing stable state. Never change the whole account HOME to pretend every dependency is isolated. Azure, TE and other vendor state requires documented tool-specific isolation; otherwise exclude that integration or use a separate Windows account/VM for its future acceptance.

Shared Node `24.18.0` and existing Python runtimes may be selected read-only by explicit absolute path if compatibility is verified. B1 must not replace or reconfigure them. Exact component versions start with the reconciled baseline; any required change is separately reviewed qualification, including an apparent downgrade to a stale manifest pin.

## Implementation boundary

Candidate edit surfaces are `bin/coop.cmd`, `bin/coop.ps1`, `lib/common.ps1`, `scripts/install.ps1`, `scripts/update.ps1`, `scripts/sync.ps1`, `scripts/doctor.ps1`, `scripts/uninstall.ps1`, and direct path consumers such as `scripts/onboard.py`, `scripts/context-budget.py`, `scripts/search-knowledge.py`, `lib/support-center-cli.mjs`, `lib/mcp_config.py`, `lib/microsoft_skills.py`, `lib/standards.mjs` and the four extensions. Confirm call sites before editing; this is a scope boundary, not permission to refactor every listed file.

Required paired Bash changes, PowerShell BOM preservation and existing parity tests remain in force. Do not create `install-beta.ps1` as a copied installer, retire the POSIX path, remove tests, or relax `AGENTS.md` obligations within B1. Keep stable behavior unchanged through regression tests.

The package must provide these connected behaviors:

- Validate channel and ownership before directory creation, package invocation or deletion. Reject malformed roots, relative/ambiguous paths, stable/profile overlap and junction/reparse escapes. A beta request with missing context/tool must fail clearly, with no global/personal fallback.
- Route install, launch, sync, Doctor, update, rollback and remove through the same context. Package-manager calls have explicit private destinations; no unscoped global operation. A warm cache must not hide an unpinned or wrong-package executable.
- Launch exact beta Pi with scoped environment/cwd. Clear conflicting channel overrides and stale token variables. Preserve quoting, spaces/Unicode, `.cmd`/`.exe` semantics, exit codes, owned-process deadlines and active stable sessions.
- Report channel, product version, build SHA, manifest identity, executable and safe profile/package paths. Keep Doctor observational: no repairs, SQL calls, interactive auth or full agent launch to obtain a health result.
- Update only to an explicitly selected eligible beta revision. A branch label, prerelease tag or existing `--edge` behavior is insufficient. Reject dirty/unknown source state rather than stashing or overwriting it. Preserve user fields and compatible prior beta code/package state on failure.
- Remove only validated beta-owned application/code/package files; preserve user data by default. Never delete stable packages, sessions, credentials or client sources. Final public command syntax must be documented and tested when implemented; no proposed flag is advertised as shipped now.

## Acceptance and evidence

The failing baseline is already concrete: shared/global package lookup, conflicting profile roots, missing channel identity, and cache/version drift. First make these observable with inert package/executor doubles in disposable E: state; then require actual native Windows lifecycle evidence using the reviewed same-version package selection. Mock success cannot close B1.

| Acceptance case | Required result |
| --- | --- |
| Install, launch, sync, Doctor, update, injected failure, rollback, remove | Each public beta operation reaches only its owned roots; identity output is accurate; stable file/package state unchanged |
| Stable sentinel and active-session scenario | First use a disposable stable fixture. Any later real stable observation is passive; no process termination or client test actions. Existing stable session remains usable, with no beta-attributable changes. Account for user-caused changes separately. |
| Poisoned PATH / missing beta binary / stale cache | Refusal with useful diagnostics; never select stable Pi, personal credentials, global npm tools or old adapter cache entries |
| Root attack/error cases | Reject malformed override, same stable root, nested stable path, junction/reparse escape and unexpected ownership before mutation |
| PS 5.1, supported PS 7, Git Bash entry | Preserve arguments, spaces/Unicode, literal characters, exit codes and launch behavior; retain BOM/parity obligations |
| Auth/session/project/resource separation | Distinct auth/model/session/profile stores; no stable credential copies; no cross-channel skills, policy, knowledge, settings or client-project discovery |
| Failure, timeout, shutdown and locked files | Truthful failure; previous beta remains recoverable; only owned children terminated; no surviving beta agent or broad `node.exe` kill |
| Update/configuration/rollback | Unknown fields and user preferences survive; rollback restores owned code/packages only; no silent schema migration or deletion of user history |
| Guardrail regressions | G01/G02/G03 repairs have exception/canary and dynamic-wrapper coverage; one bounded approval is reused only within scope; expansion/rejection/revocation/new sessions and real Pi hooks are tested; declined, absent and throwing approval cannot reach a represented executor; ordinary optional failures do not break chat |
| Optional vendor integrations | Explicitly scoped executable/cache/credential ownership evidence for each enabled integration. No client/paid/live calls in default lifecycle tests. Unproven integrations remain disabled and are recorded as incomplete coverage. |

Use safe equality results for selected stable-owned files, configuration and package inventory before/after; do not export credential contents. Any credential integrity comparison must keep hashes private and print only equality. Testing must not require copying client projects or credential files into a public repository. Treat an active system's unrelated state changes as investigation signals, not permission to restore it.

Run the appropriate repository suite and required paired-script/BOM checks after changes; retain native Windows integration evidence beyond unit tests. Resolve or explicitly disposition the prior local standards/permissions test failures. Record exact test commands, host/shell versions, source SHA, manifest and resolved-package hashes, safe paths, errors, data/network activity and rollback outcome.

## Deliverables, stop rules and review decision

One independently reviewable B1 change should contain the shared installation context, complete owned beta lifecycle, focused regression/native acceptance coverage, and accurate operating instructions. Commit/push/PR creation/release still require the corresponding authorization. Record new helpers/flags/stores and authored lines; B1 justifies an addition for isolation and makes no code-reduction promise.

Stop the affected test/package if beta resolves stable state, a missing tool falls back globally, an approval error permits execution, a canary enters an audit/support export, stable configuration changes, an owned child survives shutdown, or rollback needs deleting user data. Preserve evidence and leave stable running. Do not fix an acceptance failure by clearing caches, resetting repositories, killing unrelated processes or performing an implicit upgrade.

**Proposed review decision:** accept the B0 source baseline and findings; separately authorize the minimal safety repairs and resolve the MCP version choices; then authorize this bounded B1 lifecycle package with E: ownership and staged native acceptance. No B1 code, installation, beta command, TeamAI/Jev activation or Desktop work has begun.
