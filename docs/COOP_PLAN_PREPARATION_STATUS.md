# Windows terminal plan: preparation status

**Status: PREPARED / PAUSED — do not start the plan.**

Aaron authorized repository documentation and branch preparation only. This file is not authorization to execute B0, implement beta isolation, change dependencies or skills, activate TeamAI/Jev, publish knowledge, or begin Desktop work.

## Source and documents

- Experimental branch: `experimental/windows-terminal`.
- Provisional source seed: `9e8248a8b34a0bd7581b1909bf4fd18f253b3350` (observed `main`). This reserves a source branch; it does not certify the installed stable baseline.
- Canonical plan, being staged: `docs/COOP_WINDOWS_TERMINAL_PLAN.md` (document revision 2.0).
- Reading copy, being staged: `docs/Coop_Windows_Terminal_Plan_v2.docx`.
- Paused next-work issue: https://github.com/kabukisensei/coop-agent/issues/70.

The Markdown is the editable plan; the Word document is its reading copy. No runtime implementation is included in this preparation. Do not mark a work package complete from this status file.

## Next action — only after Aaron explicitly starts B0

Read `AGENTS.md` and the canonical plan. Reconcile the actual accepted Windows installation with the release and current repository state; record the accepted code/dependency identity and safe paths, revalidate the earlier safety findings, and propose one bounded B1 isolation change. Then stop for review. Do not implement B1 as part of B0.

Do not collect credential contents, token values, raw environment dumps, or private client data. When the Windows installation is unavailable, record the limitation and request only missing sanitized evidence.

## Preparation boundaries

Keep this work out of `agent:ready` and do not assign an autonomous agent or schedule execution. Do not run the existing installer from the experimental branch: `coop-beta` and channel isolation are proposed, not shipped. Do not reset, force-push, release, bump versions, remove old branches, or rewrite user-owned settings.

Current product work is Windows terminal only. Preserve the custom theme and all capabilities and safety guarantees. Native Windows Coop 2.0 remains deferred and last; the Microsoft Power BI Desktop Bridge CLI is a separate existing integration, not the retired Coop Desktop application.
