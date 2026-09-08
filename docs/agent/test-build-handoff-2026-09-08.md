# Next milestone: a Coop Desktop build Aaron can test

## Latest user direction — September 8, 2026

Aaron paused work to conserve weekly usage and explicitly changed the next
milestone to **getting a build he can use to test**. Do not resume the open-ended
"all tests and improvements" effort. Work remains paused until Aaron resumes;
this documentation/branch update is not permission to start implementation now.

On resume, deliver one identified, reproducible development build, with concise
launch/install instructions and known limitations. Stop and hand it to Aaron for
hands-on testing once the acceptance checks below pass. Do not keep polishing or
expanding the release checklist after that handoff.

## Starting state

- Repo: https://github.com/kabukisensei/coop-agent
- Mac checkout: `/Users/aaronjennings/Developer/coop-agent-desktop`
- Branch to resume: `feature/coop-desktop-platform`
- Implementation checkpoint: `60a0b7f` (ownership changes and pause notes).
  The subsequent documentation commit on this branch records this new milestone.
- Last earlier build evidence is for `c95db47`, not for the ownership checkpoint.
- Windows VM checkpoint: `262a9dc068caa1b13e8b958151ccbfded6b97320` on
  `feature/coop-desktop-windows-validation-worktrees`. Read its
  `docs/agent/windows-pause-2026-09-08.md` using git show; it is not on this branch.
- Local details: [Mac pause handoff](mac-pause-2026-09-08.md).
- PR 48 remains draft. No release, main merge, production signing or version tag.

## Build to deliver

Start with the Mac where Aaron uses Coop; keep the Windows VM checkpoint intact.
If Aaron resumes specifically on Windows, deliver the Windows test candidate first.
Do not make both platforms' entire release matrices prerequisites for handing him
one useful test build. Clearly identify which platform and source commit were
actually tested. Preserve the requested Codex-like UI and plain Cooptimize icon.

1. Inspect current Git state and the pause notes. Reconcile only VM changes needed
   for the chosen candidate; do not blindly merge the broad validation branches.
2. Finish verification of the ownership checkpoint. Its focused workspace and
   Web bridge checks passed; a complete final-tree regression run remains due.
   Windows CI also needs a directory-identity assertion fix: ordinary realpath
   did not normalize short TEMP names. Do not remove the underlying location check.
3. Build an isolated managed app from a recorded commit with pinned runtime and
   companions. Put the deliverable and its instructions in a durable user-accessible
   location, not only a temporary build folder. Record path, commit and checksum.
4. Verify native startup, model selection/authentication through supported UI,
   and a small real-model task in a disposable workspace that creates/edits a
   file, runs a command or test, and reports the result. Preserve existing login;
   never read/copy credential files. If user interaction is needed, finish the
   build first and hand over exact short testing steps.
5. Check Stop, chat persistence after close/reopen, workspace selection, and
   basic copy/paste. Confirm shutdown leaves no owned test processes. Avoid
   changing the original terminal installation or business workspaces.
6. Hand Aaron the build with short usage instructions, the checks actually passed,
   and specific known limitations. Stop for his feedback.

A usable isolated app bundle/unpacked Windows candidate is acceptable for this
milestone when installation is not needed to run it. Do not claim the installer
works unless it was tested. If using an installer, validate its actual install and
launch path before delivery. Never overwrite an existing installation implicitly.

## Explicitly deferred unless a test-build blocker

- Production signing/notarization, release feeds, publishing, main merge and tags.
- Complete automatic update/rollback and reboot/login recovery matrices.
- Exhaustive cross-platform accessibility, DPI, performance and long-session work.
- TeamAI/shared-knowledge integration and additional UI features.
- Broad refactors and unrelated improvements.

These remain recorded in the full completion ledger; they are not requirements
for Aaron's next testing milestone. Preserve serious known defects in the handoff;
fix anything that prevents or endangers the agreed test workflow.

## Known evidence and open issues

- c95db47 managed CI 34203950061: Mac native check passed; Windows isolated
  runtime and packaged renderer/chat checks passed; installer built. The installer
  acceptance step timed out after approximately 180 seconds. Inspect the receipt
  before inferring the failing phase. This need not block an unpacked test build.
- c95db47 regular CI 34203949925 failed the Windows TEMP-path assertion.
- 60a0b7f local checks: workspace isolation 12, real two-process ownership lifecycle,
  full PowerShell, lint/parity, and focused Web bridge 287 passed. Full Bash hit
  the old lease assertion; it was corrected and the focused bridge check passed.
  The full final-tree suite was not rerun because Aaron requested the pause.
- VM 262a9dc is also a partially verified checkpoint. Its pause note records the
  installed candidate and GUI evidence, plus remaining worktree/update defects.

## Usage discipline

Use a short plan with the concrete deliverable and stop condition above. Reuse
valid evidence, run required checks for changed paths, and do not repeat builds or
suites without a changed input or diagnosed failure. Follow live process/job handles
rather than restarting on an observation timeout. No proactive agents, recurring
runs or background continuation while paused. If a major blocker threatens to turn
this into broad release work, report it with the closest usable candidate and a
bounded next step; do not silently broaden the milestone.
