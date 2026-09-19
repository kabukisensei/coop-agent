# Windows-terminal roadmap: preparation handoff

**Prepared September 19, 2026. Status: PREPARED — EXECUTION NOT STARTED.**

Aaron authorized putting the plan into the repository and setting up what could be prepared, explicitly without starting the plan. This file records that boundary. It is not an acceptance receipt for B0, B1, a beta build, or any other roadmap package.

## Read first

Read [AGENTS.md](../AGENTS.md), then the [canonical Windows-terminal plan](COOP_WINDOWS_TERMINAL_PLAN.md). The plan's document revision 2.0 is the adopted roadmap, not a Coop product release. This preparation record qualifies its original planning-time statements: a source branch has now been reserved, but no implementation or workstation baseline acceptance has occurred.

The Markdown plan is the working source of truth. `Coop_Windows_Terminal_Plan_v2.docx` remains a reading snapshot supplied in the originating conversation; it has not been committed because the available repository file-write interface supports UTF-8 text, not binary uploads. That reading-copy transfer is not a prerequisite for beginning B0 later. Do not claim the Word copy is in the repository or create a broken link to it.

## Prepared repository state

| Item | State |
| --- | --- |
| Canonical plan | `docs/COOP_WINDOWS_TERMINAL_PLAN.md`, adopted for future work |
| Agent entry point | `AGENTS.md` links to the roadmap and this preparation gate |
| Source branch | `experimental/windows-terminal`, reserved as a provisional source branch |
| Provisional source seed | `9e8248a8b34a0bd7581b1909bf4fd18f253b3350`, the observed main head before this documentation preparation |
| Released comparison point | `v0.23.3` / `969153246bdeb4d2a8d8f4aadec82df7cadacec4` |
| Actual accepted Windows installation | Unknown; B0 must establish it after authorization |
| Beta installer, command, profile and packages | Not implemented or installed; branch presence proves none of these |
| Runtime, dependency pins, skills, CI/release configuration | No changes in this preparation |
| Previous Desktop work | Retained as historical reference; no merge, deletion or port |
| Next-work issue | [#70: paused B0 baseline reconciliation](https://github.com/kabukisensei/coop-agent/issues/70), unassigned and without `agent:ready` at preparation |

The documentation commits may advance main and the experimental branch without changing their runtime code. An earlier experimental-branch preparation note is retained as a pointer at `docs/COOP_PLAN_PREPARATION_STATUS.md`; its source history is preserved. This does not turn the provisional source seed into the accepted workstation baseline. Reconcile that seed during B0; do not reset or force-push the branch, discard newer fixes, or overwrite another person's work to make it match a guess.

## Execution gate

**B0 and all implementation packages remain unstarted until Aaron explicitly asks to begin.** Do not mark these tasks `agent:ready`, assign an autonomous coding agent, or start a scheduled workflow merely because the roadmap is now in Git. Existing unrelated maintenance is not re-scoped by this preparation.

The original plan's terms such as "ready for inventory" describe dependency readiness, not permission to execute. This explicit pause governs work under the roadmap until superseded by Aaron's next task-specific instruction.

| Package | Current status | First future action |
| --- | --- | --- |
| B0 | Not started; awaiting explicit start | Establish actual stable installation identity and reconcile the release/main delta and prior safety findings |
| B1 | Blocked by B0 and its scoped approval | Propose, then implement and prove isolated beta lifecycle behavior |
| S1–S7, U1, SK1 | Not started | Select bounded work only after the plan's relevant gates |
| K1–K3, J0–J3 | Not started; no installation, publication or API experiment | Follow isolated TeamAI and Jev gates; preserve separate authorization for live data/costs |
| R1 | Blocked by independent package acceptance | No tags, release or promotion implied |
| D2 | Deferred; last | Native Windows Coop 2.0 discovery only when separately prioritized |

## Exact next task after the pause is lifted

Begin B0 only. Inspect the actual accepted Windows installation read-only where available, record its code/manifest identity and safe executable/profile paths, reconcile retained capabilities and the newer main changes, and revalidate the original safety findings at that exact revision. Produce an acceptance map and one bounded B1 proposal, then stop for review. Do not install beta or implement B1 while completing B0.

Do not ask for information a read-only workstation inspection can establish. When the workstation is unavailable, record the limitation and request only the missing sanitized evidence. Never collect credential values, credential-file contents, raw environment dumps or private client payloads into this public repository.

A future start instruction can be:

> Start B0 from docs/COOP_WINDOWS_TERMINAL_PLAN.md. Read AGENTS.md and the preparation handoff first. Reconcile the actual stable Windows installation with the provisional experimental source seed, document the accepted baseline and safety/test gaps, and propose B1. Do not implement B1, install or upgrade packages, publish knowledge, call paid/live services, or begin Desktop work. Stop after the B0 report and bounded B1 proposal.

This quoted instruction is a handoff template, not an instruction to execute now.

## Do not mistake a source branch for a beta installation

Do not run the current installer, updater or unqualified Pi/package install from `experimental/windows-terminal` as a supposed side-by-side beta. The current shared/global paths and conflicting profile-root interpretations are precisely what B1 must address. `coop-beta`, `COOP_PROFILE_ROOT`, beta version selectors and private beta package roots are proposed interfaces, not shipped commands or completed setup.

No package or skill refresh, Jev/TeamAI activation, source refactor, live Fabric/database request, credential/configuration migration, native application work, branch-protection change, release or version bump is authorized by this preparation.

## Documentation verification

For this preparation, verify the documentation links and compare the final commit against the provisional source seed. The intended change list is only `AGENTS.md`, this handoff, the canonical Markdown plan, and the earlier preparation-status entry point. The canonical plan's content is unchanged from the supplied revision 2.0 Markdown. Do not describe a documentation check as a Windows test or beta acceptance. No runtime test execution is required to claim that these documentation files were staged, but native acceptance remains mandatory for the future implementation packages.
