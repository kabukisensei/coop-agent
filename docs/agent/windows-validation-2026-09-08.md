# Windows validation handoff — 2026-09-08

Native acceptance is incomplete. Preserve the production installation and business
workspaces. All validation apps, profiles and synthetic data remain isolated under
`D:\CoopDesktopWindowsValidation-20260907` in the Windows VM.

## Pushed source

Agent branch: `feature/coop-desktop-windows-validation-e70a41a`.

- `8b9449656203a893e4d8dff983eca4a59f27114d`: earlier verified Windows integration,
  including 767e2ec managed SQL/DAX/documentation analysis checks as patches.
- `cf590827af2e2b110679d3a6545217b3801d209b`: wait for real agent readiness before
  restoring desktop navigation; retry only read-only startup timeouts, preserve
  saved chat references and recover renderer model/status state after cold startup.

The exact cf59082 tree `d0d80a068800c87be10da6114e17c24b9ac5a34c` passed all three
full native runners in an immutable checkout:

```text
C:/Program Files/Git/bin/bash.exe tests/run.sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/run.ps1
pwsh.exe -NoProfile -File tests/run.ps1
C:/Program Files/Git/bin/bash.exe scripts/check-parity.sh
```

Use D: for TEMP/TMP and package caches, Python 3.12, and the isolated Data Doc
environment on PATH with `COOP_TEST_DATADOC_REQUIRED=1`. No main merge, release,
version tag or production signing was performed.

Companion fixes are already pushed: Data Doc
`8ed8344b20b4c27fd8edb3e043c96f0f46b2b939`, DAX
`7d26424bc97c58c88a93266486b3eb110e6457c6`. SQL remains
`07d94a06b732f3f34085a48d60ffc637c806faa8`.

## Artifacts and remaining failures

NSIS v3 completed with exit 0 and has not been installed:

- File: `latest-installer-v3/Coop-Desktop-Windows-Validation-0.0.1-x64.exe`
- Size: 402473444 bytes
- SHA256: `6A8775825FB6FEFC1FCB578F225668B48393CEE870E0F63A1A3479B82F00027B`
- Authenticode: NotSigned (development validation identity)

The later v4 unpacked build contains an uncommitted acknowledgement-flush and
probe-error diagnostic follow-up. Its ASAR SHA256 is
`1349B89EB83D6A16BA513FE56333F73869313FA54FFCB53E813A411004F9511B`.
That follow-up passed focused checks but is not covered by the full cf59082 suites.

Packaged native health still fails. V9 reported “Desktop UI did not become ready”
at about 80 seconds; v10 also failed after NSIS compression had completed, returning
false at 87 seconds. A separate generic-Electron diagnostic copy uses a longer
navigation deadline to measure eventual startup; it is not an acceptance artifact.
Direct runtime protocol and stdio fixtures passed, but do not establish native GUI
readiness. Keep investigating startup and shutdown before accepting the installer.

GUI automation is paused after repeated Windows-helper capture failures
(“foreground window did not report a process id”). The user has been asked to
unlock/activate the VM. Preserve the live disposable profile and Power BI fixture.
Earlier authenticated agent/approval/Stop/history/review/clipboard/attachment and
local Power BI evidence uses older builds and must be repeated on the final install.

## Separate updater work

An isolated sibling checkout `coop-agent-windows-updates` on
`feature/coop-desktop-windows-validation-updates` contains uncommitted ZIP
extraction, native PE/Authenticode/version checks and signed private-snapshot
preparation. Component tests pass, including actual Windows ZIP extraction and
unsigned-candidate rejection. Full suites are underway there. These components
are not yet wired to desktop UI, detached helper, independent recovery or installed
update/rollback. Do not mark the Windows updater complete from component tests.

The VM task's `outputs/windows-latest-status.md`,
`outputs/windows-development-acceptance.md`, daily log and evidence directory hold
the detailed command logs, artifact receipts and workflow matrix. D: is labelled
Temporary Storage; pushed source and C: evidence copies are the durable handoff.
