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

## Latest integration follow-up

The earlier uncommitted follow-ups are now pushed: shutdown confirmation and
health-acknowledgement flushing at `867c9875ba0ebb46b0f33ed209894bc90b94c19a`
on `feature/coop-desktop-windows-validation-e70a41a`, and Windows ZIP candidate
preparation at `8d6b0ab542f3100812372182ad6a4b7d49cd6541` on
`feature/coop-desktop-windows-validation-updates`. Both passed the full native
Bash, Windows PowerShell 5.1 and PowerShell 7 source runners before their pushes.

The new isolated `feature/coop-desktop-windows-validation-c22f6f7` integration
combines platform commit `c22f6f7c157b9838e1e426edc89beff9e6c1cbd2` with the
Windows validation changes and the ZIP-preparation patch. Native CI and update
health now share the same disposable-home, OS-only launch environment. Windows
shutdown still requires the child close event when taskkill reports an exited
wrapper. A restart regression found that a released primary ownership record
could block the final approved writer from immediately reacquiring normal write
access. Recovery now recognizes explicit release with no remaining overrides;
active overrides continue to block recovery.

Fresh staging from the previously verified development dependency inputs passed.
`node scripts/verify-managed-runtime.mjs --bundle <stage>/managed-runtime
--workspace <disposable-workspace> --agent <disposable-agent> --environment native`
passed with SQL (1 expected finding), DAX (5 findings including the expected rule),
Data Doc (6 nodes, 5 edges), and lineage through packaged Pi's actual extension
loader. Two writable starts took 9432 and 3050 ms and owner-controlled shutdown
completed. This first stage predates the ownership restart correction and is a
recorded intermediate artifact. Fresh final staging, full integration suites,
packaged native checks, installed GUI acceptance and update/rollback remain
required. The Windows updater components are still not a complete updater flow.

### Pushed native verification result

Integration commit `cc6d4808a9cb1703beaff5998c9faa7b655b44d5` is pushed on
`feature/coop-desktop-windows-validation-c22f6f7`. Its exact tree
`7dae77570bb106830300b637de3ccc4173496f10` passed the full Git Bash, Windows
PowerShell 5.1 and PowerShell 7 runners, paired-script/BOM parity, Bash syntax and
PowerShell parsing. Git's patch whitespace check reported extra blank lines at
EOF in three imported Markdown files and `scripts/verify-managed-tool-work.mjs`;
these cosmetic lines were retained to preserve the exact tested build input.

Fresh `c22-app-v1` passed package ASAR/fuse/inventory checks and the default
`desktop/scripts/verify-native-application.mjs` probe: renderer/chat ready, runtime
shutdown reported, main process exited, and disposable profile removed. The
production `nativeApplicationHealth` path also passed with its Windows Job Object
supervisor in 17103 ms at the unchanged 90000 ms deadline. These probes performed
no model generation and copied no credentials; they are not visual acceptance.

Verification against the managed runtime inside that final package repeated real
direct and Pi-loaded SQL/DAX/Data Doc/lineage work and two writable starts at
6794 ms and 6182 ms, with confirmed shutdown and immediate writable restart.
The real non-managed JSONL questionnaire also passed 19 prompts with
`PYTHONUTF8=0` and `PYTHONIOENCODING=cp1252`, using the isolated Data Doc source
executable at `8ed8344`. Its earlier UTF-8 wire fix already covers this behavior.
The first full Bash attempt used a different executable because its development
PATH was omitted; the corrected full run passed, with the failed log retained.

Unpacked artifact hashes:

- EXE, 246535168 bytes: `28F637DFCCD1A5B815D1349BFDA75D3181AFAB28452DB5D97683723A37AE2CBD`.
- ASAR, 225119 bytes: `C634E4C2FA9EF3C84D9A29C6F76165742744753B5BBB9FF757A867F2CA40EA7D`.

Authenticode is NotSigned under the distinct Windows validation identity. The
matching NSIS build is still compressing at this checkpoint. Installed GUI
workflows and complete Windows update/rollback remain outstanding. GUI control
is still paused pending the previously requested VM unlock/ready response.
