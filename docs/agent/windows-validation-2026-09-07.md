# Windows development acceptance — current snapshot

Acceptance remains incomplete. The original installation and business workspaces are excluded. All development builds, profiles, synthetic data, dependency caches, and checkouts are under `D:\CoopDesktopWindowsValidation-20260907`.

## Source and tests

- Initial agent revision: `a5dc57e05c361862bcda8c5dcd1b52b95701e577`.
- Current integration checkout: `source-current/coop-agent-desktop`, branch `feature/coop-desktop-windows-validation-e70a41a`, based on `e70a41a073c0621ca19919e01a11cda579cb171c` with Windows changes. Latest fetched upstream: `767e2ecfd79359ffbd9d6985d3ba05c3ecc7e560`. Its managed-tool analysis checks are integrated; equivalent native dependency corrections are present locally. Agent changes are not yet committed or pushed.
- Verified companion commits already pushed to their Windows validation branches: Data Doc `8ed8344b20b4c27fd8edb3e043c96f0f46b2b939`; DAX Review `7d26424bc97c58c88a93266486b3eb110e6457c6`. SQL Review remains `07d94a06b732f3f34085a48d60ffc637c806faa8`.
- Companion native suites: Data Doc 635, SQL Review 670, DAX Review 624 with no skipped DAX lock test; lint/format checks passed.
- Native PowerShell 5.1 full suites passed at both the dfa910d and e70 integration stages. Current PowerShell 7 and full Git Bash runs remain active. Later native-lock and analysis-check changes passed focused tests and require final suite reconciliation.
- Focused evidence: 79 guardrail checks; 20 lifecycle checks; 45 update checks; 12 managed preparation checks; paired-script/BOM parity passed at the dfa integration stage. These do not establish complete installed-app acceptance.
- Old ae8f909 full Bash v4 failed a fixed 600 ms startup-event wait. Current source polls the real event with a 10-second bound, retaining the assertion. Its full-run result remains pending.

## Observed native workflows

The authenticated GUI evidence below uses `integration-app-v3/win-unpacked`, with a recorded development overlay of the paired Coop launch scripts and guardrails extension. It is not the final rebuilt NSIS artifact.

| Requirement | Native evidence and remaining work |
|---|---|
| Install/repair | Baseline NSIS installed successfully to `installed-v2`; latest installer and repair repeat pending. |
| Model sign-in | User signed in to the actual disposable `profile-v1`; GUI authenticated and refreshed models. Native sign-in terminal flow still requires verification. No credentials copied. |
| Workspace open | Disposable workspace opens and persists; no business folder used. |
| Real agent work | GPT-5.4 mini read Unicode correctly, created Python source and tests, and ran four tests successfully. |
| Approvals | No denied the synthetic guarded read; Yes allowed it. Stop during approval remains pending. |
| Stop | Interrupted a real tutorial response at an unfinished seventeenth example; GUI returned to ready/Send. A subsequent coding task completed. |
| Queue/steering | Pending real GUI verification. |
| SQL/DAX reviews | Real native tool calls returned SQL 1 finding and DAX 15 findings from synthetic paths containing spaces, ampersand, and café. Structured SQL finding card rendered. |
| Documentation/lineage | New 767e2ec verifier passed against the existing bundle: SQL 1 expected finding, DAX 5 expected findings, Data Doc 6 nodes/5 edges. GUI workspace had no documentation config and reported that accurately. |
| Git diff | Created a disposable fixture repository, baseline commit `6bbfba50b57a57a998a0435ddacc3a1e5e4f5d38`; a one-line Python change rendered in unified and side-by-side views. |
| History/recovery | History restored conversation, model, read result and approval outcomes after normal shutdown. Automatic restore/crash recovery on latest build remains pending. |
| Session fork/clone | Clone command completes, but old v3 replay flattens structured tool cards. Latest upstream contains related fixes; rebuilt-app verification pending. Fork check in progress. |
| Terminal handoff | Clone-to-terminal reports success; Windows reports a terminal window. Tool inventory excludes terminal windows; user observation requested. Contents/interactive parity remain unverified. |
| Clipboard | Installed baseline Unicode round-trip passed. Code, multiline/table interoperability and final-build repeat pending. |
| Attachments | Installed baseline TXT picker/attachment passed. Additional formats and agent consumption pending. |
| Power BI Desktop | Synthetic local PBIP saved; matrix validates with zero errors/warnings, bridge reload succeeds, rendered values are 10/20/30 and total60. Local DAX returns 3 rows/total60. Coop-to-MCP end-to-end readiness still needs checking. |
| Shutdown | Owned validation app exits through normal native close. Current supervisor focused tests verify descendant cleanup and startup failure cleanup. Final installer shutdown/listener check pending. |
| Update/rollback | Native directory replacement engine passed 10 cases, including crash and real NTFS sharing lock. Windows preparation/helper/independent recovery/GUI orchestration remains incomplete. |
| Accessibility/security | Keyboard navigation and native dialogs exercised; package ASAR/fuse verification passed on previous build. Complete accessibility/DPI and latest package security checks pending. |
| Signing/release | Development installers are unsigned. No production signing, release, version change, or tag publication performed. |

## Build findings and artifacts

Canonical dfa preparation failed in `npm ci`: `@microsoft/fabric-mcp-win32-x64` was missing from the committed Windows lock. Corrected locks preserve the existing versions and add target-native Fabric/Modeling MCP, Sharp and recheck payloads. Checks now reject missing target payloads both before installation and in the installed dependency tree. Native `System32/tar.exe` extraction and update-notice handle fixes from upstream are included.

Fresh canonical preparation is running with pinned Node22.22.3/Python3.12.14 and development companion wheels. npm installation and all five Python package installations have completed; staging is in progress. Its final runtime and NSIS verification remain pending.

| Existing installer | Bytes | SHA256 |
|---|---:|---|
| Baseline `installer-baseline/Coop-Desktop-Windows-Validation-0.0.1-x64.exe` | 366609655 | `F0301F7FF3632A1CBF902264FE5F080DABE4C521A8A41BEC7E5007364F068BFD` |
| Integrated v2 `integration-installer-v2/Coop-Desktop-Windows-Validation-0.0.1-x64.exe` | 402115088 | `EED989AFD96759D7CADC7DB22C64C5AD79A1CDFEDA9EB8DA1E5E731F477F0F56` |

Both are Authenticode `NotSigned`. The second installer has not passed native installation acceptance.

## Reproduction and evidence

Run from `D:/CoopDesktopWindowsValidation-20260907/source-current/coop-agent-desktop` unless specified. Set TEMP/TMP to `D:/CoopDesktopWindowsValidation-20260907/temp`; npm and pip caches are also on D:.

```text
C:/Program Files/Git/bin/bash.exe tests/run.sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/run.ps1
pwsh -NoProfile -File tests/run.ps1
node --test tests/managed-runtime-build-plan.test.mjs tests/prepare-managed-runtime.test.mjs
node --test tests/update-service.test.mjs tests/prepare-managed-runtime.test.mjs tests/knowledge-index.test.mjs
npm ci --prefix desktop
node scripts/prepare-managed-runtime.mjs --target win32-x64 --work D:/CoopDesktopWindowsValidation-20260907/e70-acquisition-v1 --output D:/CoopDesktopWindowsValidation-20260907/e70-runtime-v1 --development-wheels D:/CoopDesktopWindowsValidation-20260907/integration-wheels/development-wheels.json
```

The Bash run sets `COOP_TEST_DATADOC_REQUIRED=1`, `PYTHONUTF8=1`, and prepends the isolated Data Doc source venv to PATH. Raw logs and screenshots are in `outputs/evidence`; daily chronology is in `outputs/daily-log-2026-09-07.md`. Current long-running build/test logs remain on D: until completion.

Key screenshots: `integration-v3-context-fix.jpg`, `integration-v3-stop-ready.jpg`, `integration-v3-real-agent-four-tests.jpg`, `integration-v3-native-reviews.jpg`, `integration-v3-git-diff.jpg`, and `powerbi-native-matrix.png`.
