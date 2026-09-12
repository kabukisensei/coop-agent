# Coop Desktop — Windows Validation Repository Handoff (2026-09-11)

This repository handoff document summarizes the validated fixes, commit states, worktree statuses, candidate artifacts, and immediate next steps for the incoming lead agent taking over the Coop Desktop Windows validation effort.

---

## 1. Commit and Remote State

| Item | Details | Full SHA |
|------|---------|----------|
| **Feature Branch** | `feature/coop-desktop-windows-validation` | — |
| **Local Commit (HEAD)** | `fix(desktop): fix native process launch, error rendering, and doctor argument parsing on Windows` | `f5618dacce8571e1039e8fd531b1c87d61ef171f` |
| **Remote Commit (origin)** | `origin/feature/coop-desktop-windows-validation` (verified exact match) | `f5618dacce8571e1039e8fd531b1c87d61ef171f` |
| **Pre-fix Baseline Commit** | `fix: correct Power BI Desktop Bridge CLI pin to published 0.1.2` | `eae3a1a229ba619f6b0d19988371c10284efec3e` |
| **Workspace Isolation Fix** | `fix: preserve workspace override leases across owner departure and release failures` | `379a7b88b7cbe66b8b887c907fe058e25ab31cb2` |
| **Main Branch (local)** | `Release v0.23.1` | `d60300780b565aabf15b172b2bc32abad12b9ca6` |
| **Main Branch (origin)** | `docs: adopt Spec Kit constitution v1.0.0` | `059d9f37da6e05370f1a92e10c73229b48c66e96` |
| **Unreviewed/WIP Branch** | `wip/unreviewed-te-cli-fabric-config` (pushed to origin; unmerged) | `7431de45e2604441cf2a6cedb8fbd73648aa2497` |

---

## 2. Completed Fixes and Verification Evidence

The single commit `f5618dacce8571e1039e8fd531b1c87d61ef171f` consolidates all three reviewed and approved Windows fix sets:

### 1. Native Launcher Fix
* **Files**: `desktop/src/main.mjs`, `desktop/src/native-terminal.mjs`, `tests/desktop-preview-shell.test.mjs`
* **Changes**: Distinguishes short-lived launcher completion (Windows `cmd.exe /c start`, macOS `osascript`) from long-lived interactive sessions (`x-terminal-emulator`); handles async process spawning errors, signal termination, and launcher timeouts.
* **Reviewed Archive SHA-256**: `3512A3BEBA870F36C59E867DDE577AB5B1486B782FE977AFD5DDB2A096E5E61B`
* **Verification Evidence**: `tests/desktop-preview-shell.test.mjs` passes native Windows live probe (macOS probe cleanly skipped).

### 2. Error Display Fix
* **Files**: `web/public/app.js`, `tests/error-display.test.mjs`, `tests/protocol.test.mjs`, `web/protocol.mjs`, `web/server.mjs`, `tests/run.sh`
* **Changes**: Corrects `message_end` brace nesting in the web UI, correctly renders zero-token errors, appends errors to partial output streams, and enforces credential redaction.
* **Reviewed Archive SHA-256**: `342A2D5C57C177DC379CBD4628697A64CBEB77A21B6BBECB48A61C7F6764E083`
* **Verification Evidence**: Production behavioral tests in `tests/error-display.test.mjs` execute and pass within the `tests/run.sh` test harness.

### 3. Health & Doctor Fixes
* **Files**: `scripts/doctor.ps1`, `tests/doctor-service.test.mjs`, `tests/fixtures/doctor-argv/`, `tests/test_production_argv.ps1`, `tests/webbridge.test.mjs`
* **Changes**: Fixes PowerShell splatting unboxing and backslash continuation leaks; provides AST regression fixtures and recording shims under `tests/fixtures/doctor-argv/`.
* **Reviewed Archive SHA-256**: `55BE819A938AEFCA9227388FB4C5883765B1DE8E52EE13A72C3A19DAA86EA7DA`
* **Verification Evidence**: `doctor-service.test.mjs` (6 passed), `webbridge.test.mjs` (284 passed, including `/doctor` endpoint), and `test_production_argv.ps1` all pass.

### Aggregate Test Results
* **362+ automated tests passed** across all suites.
* **Expected skips documented**:
  * Symlink escape jail tests (2) skipped due to Windows host POSIX symlink semantics.
  * macOS native probe explicitly skipped on Windows.
  * `first-run.test.sh` PTY tests skipped due to lack of native Windows Python termios support.

---

## 3. Unreviewed & WIP Work

* **Branch**: `wip/unreviewed-te-cli-fabric-config`
* **Commit**: `7431de45e2604441cf2a6cedb8fbd73648aa2497` (pushed to `origin/wip/unreviewed-te-cli-fabric-config`)
* **Status**: Separate unmerged WIP branch.
* **Contents**:
  * `.coop/project.yml`: Configuration additions for `tabular_editor_cli`, `fabric_cicd`, Fabric/Power BI MCP servers, memory configuration, and Fabric skill allowlists.
  * `skills/te-cli/`: Tabular Editor CLI skill documentation and reference guides.
* **Security & Integrity Check**: Verified zero credentials, private profile data, caches, or build artifacts are present.
* **Note on Local Worktrees**: `C:\Users\quiddity\coop-agent-wt-webbridge` contains preliminary uncommitted edits on detached `2dae4dc`, which were the pre-commit draft for commit `379a7b88` (already incorporated into `f5618da`). It remains preserved as-is.

---

## 4. Remaining Blocker: Doctor Timeout in Managed Runtime

* **Issue**: When running under the bundled managed desktop runtime, `scripts/doctor.ps1` bare runtime is ~48 seconds. With bundled Python/Node/PowerShell runtime overhead, total duration exceeds the 60-second default timeout in `web/doctor-service.mjs:105`.
* **Symptom**: The Health UI displays "Doctor timed out" during candidate packaging verification.
* **Diagnosis**: This is an environmental resource and execution timing limit, not a logical code defect.
* **Status**: **Increasing the timeout is strictly a proposal**, not yet an approved change:
  * *Proposal A*: Increase `timeoutMs` in `web/doctor-service.mjs:105` from `60_000` to `120_000`.
  * *Proposal B*: Provide an environment variable override for Desktop managed mode (`COOP_DOCTOR_TIMEOUT_MS`).
  * *Proposal C*: Optimize `doctor.ps1` to skip slow global module scans when invoked from a managed runtime bundle.

---

## 5. Candidate Checkpoints and Artifact Hashes on D:

> [!WARNING]
> The Azure VM `D:` drive is an ephemeral temporary disk (`FriendlyName: Temporary Storage`). While worktrees and candidate directories are preserved locally on `D:`, persistent data should also be anchored or backed up to `C:` or remote repositories until a permanent Azure Managed Data Disk is attached.

### Artifact Directory & File Hashes

| Item | Path on D: | SHA-256 Hash |
|------|------------|--------------|
| **Checkpoint Document** | `D:\coop-review-handoff\END-OF-DAY-CHECKPOINT.md` | `BA6311D4681C4B8C1256EDCFE2BC84A71CCDB2BB2F815CA74CC265A2E7617B3E` |
| **P2-A Candidate Executable** | `D:\coop-p2a-candidate\candidate-pkg\Coop Desktop-win32-x64\Coop Desktop.exe` | *246,535,168 bytes* |
| **P2-A Candidate ZIP** | `D:\coop-p2a-candidate\handoff\Coop-Desktop-win32-x64-P2-A.zip` | `2C6A4066DEFA77E2D13CD206C8FA4676A453E6AF6A274D5B7602EE2CE5EB76F0` |
| **P2-B Candidate Executable** | `D:\coop-p2a-candidate\candidate-pkg-v2\Coop Desktop-win32-x64\Coop Desktop.exe` | *246,535,168 bytes* |
| **P2-B Candidate ZIP** | `D:\coop-p2a-candidate\handoff\Coop-Desktop-win32-x64-P2-B.zip` | `C894B5D25A7CF2BB03A4654A1586ED392E3BA7444436414677ABFB0B68126398` |
| **Acceptance Checklist** | `D:\coop-p2a-candidate\handoff\AARON_TESTING_CHECKLIST.md` | `9/10/2026 baseline checklist` |

### Environment Paths for Local Execution

```powershell
$env:COOP_WORKSPACE = "D:\coop-p2a-candidate\test-workspace"
$env:TEMP = "D:\coop-p2a-candidate\cache\temp"
$env:TMP = "D:\coop-p2a-candidate\cache\temp"
& "D:\coop-p2a-candidate\candidate-pkg-v2\Coop Desktop-win32-x64\Coop Desktop.exe" --user-data-dir="D:\coop-p2a-candidate\test-profile"
```

---

## 6. Strategic Timeline and Demonstration Deadlines

* **Hard Demonstration Deadline**: **September 20, 2026** for the live terminal demonstration.
* **Strategic Roadmap Priority**:
  1. Complete Windows stabilization and acceptance (close Doctor timeout blocker and complete Aaron's interactive checklist).
  2. Immediately shift engineering focus to the **Terminal Track**:
     * **TeamAI & Unified Knowledge** (Part III / Section 8A of Master Plan).
     * **Semantic Search & Shared Retrieval** (TU-2 / TU-3 update windows).
     * Progressive delivery via main-based PRs leading up to the September 20 demonstration milestone.

---

## 7. Exact Next Task for Incoming Lead Agent

1. **Resolve Doctor Timeout Blocker**:
   * Review and decide on the timeout increase proposal in `web/doctor-service.mjs:105` (e.g. increase `timeoutMs` to 120,000 ms or configure via environment variable).
2. **Execute End-to-End CDP Test**:
   * Run `node C:\Users\quiddity\.gemini\antigravity-cli\brain\111f25f9-d381-42d9-819d-cfc56cbb3ee4\scratch\test_candidate_health_login.mjs` against the packaged candidate.
3. **If Code Changes Made, Re-Package P2-B**:
   * Under `D:\coop-agent-wt-build`, run `npm run package:managed:win` and `node scripts/verify-managed-package.mjs dist-managed/Coop\ Desktop-win32-x64`.
4. **Hand Off to Aaron for Interactive Acceptance**:
   * Execute remaining manual tests in `D:\coop-p2a-candidate\handoff\AARON_TESTING_CHECKLIST.md` (Sign-in, real model reply, approved edit, decline approval, stop running execution, native copy/paste, conversation reopen).
