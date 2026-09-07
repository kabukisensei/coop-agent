# Desktop completion status — September 7, 2026

Objective: get the app to a final working state with all tests and improvements made. This checklist tracks the whole objective; a passing local slice does not complete it.

## Authority and evidence limits

- Product/architecture: `COOP_DESKTOP_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`, especially sections 5 and 12. Terminal remains first-class; browser retirement is deferred until Desktop acceptance per the user handoff.
- Capability completion: `config/desktop-parity.json` and its referenced capability contracts.
- Distribution/journey acceptance: `config/desktop-release-requirements.json` and `scripts/desktop-release-gate.mjs`.
- Source worktree is dirty and intentionally preserved. The release baseline used HEAD b4e824a7b01bcfd275eaf86241f3543c03b744a3 with no submitted release evidence. It is a gap inventory, not evidence for the uncommitted patch or a release approval.
- Baseline `ready` is false. Protocol manifest agreement passes; capability parity and release evidence are blocked. No parity status was promoted based only on unit tests.
- Production signing/release and native Windows acceptance remain outstanding. No commit, release, production signing or installation is implied by this work.

## Product work and observed acceptance

| Area | Current evidence | Required remaining work |
|---|---|---|
| Real agent work | Real model created files, ran four passing tests; Stop ended an in-flight tool | Full approval/retry/fork/clone and managed-runtime journeys |
| Chat recovery | Real restart restored workspace; manual History restored transcript/table and selected model | Automatic restoration and runtime/app SIGKILL recovery verified in macOS packaged preview; Windows/managed-runtime journeys remain |
| History | Pending-selection lock, retry on network failure, disabled missing folders tested | Native failure/conflict journeys across platforms |
| Toolbar identity | Stale chat/out-of-order settings replies reproduced and fixed; context statistics protected and behaviorally tested | Include in restored multi-chat journey |
| Copy/UI | Response icon verified by native copy/paste; panels/sidebar/themes visually checked on macOS | Complete accessibility/attachments/narrow-window/native interoperability matrix |
| Performance | Existing transport backpressure and replay checks | Repeatable startup/memory/long-conversation measurements and fixes |
| Distribution | Development preview uses local ad-hoc signed shell and repo runtime | Managed state migration, durable install, production signing, trusted updates and rollback |

## Architecture release invariants

Each item requires matching-scope evidence; the checks below remain incomplete until inspected and verified for final artifacts.

1. Byte-equivalent governed Pi launch behavior across terminal, Web and runtime.
2. Current real-Pi protocol verification and zero unexplained required-event drift.
3. Generated capability/parity report with all required entries complete.
4. Exact companion-tool golden-fixture parity and visible partial evidence.
5. Renderer isolation and IPC/path/navigation security tests.
6. Session/checkout ownership including crashes and stale recovery.
7. Clipboard, attachments, accessibility, clean-machine, updates and rollback.
8. Signed artifacts and verified update metadata.
9. Passing terminal/Web/Bash/PowerShell regression gates for the final state.

## Named release requirements

No formal platform evidence documents were supplied to the baseline gate. Local observations in the daily log are useful development evidence, but do not satisfy these final-artifact requirements automatically.

| Requirement | Kind | Platforms | Final evidence |
|---|---|---|---|
| suite.bash | test-suite | windows, macos | Not yet established |
| suite.powershell | test-suite | windows, macos | Not yet established |
| suite.protocol-real-pi | test-suite | windows, macos | Not yet established |
| journey.install-repair | journey | windows, macos | Not yet established |
| journey.model-sign-in | journey | windows, macos | Not yet established |
| journey.workspace-open | journey | windows, macos | Not yet established |
| journey.agent-chat | journey | windows, macos | Not yet established |
| journey.sql-dax-review | journey | windows, macos | Not yet established |
| journey.git-diff | journey | windows, macos | Not yet established |
| journey.session-fork-clone | journey | windows, macos | Not yet established |
| journey.terminal-handoff | journey | windows, macos | Not yet established |
| journey.clean-shutdown | journey | windows, macos | Not yet established |
| journey.clipboard-interoperability | manual-interoperability | windows | Not yet established |
| journey.powerbi-desktop | manual-interoperability | windows | Not yet established |
| journey.platform-limited-powerbi | manual-interoperability | macos | Not yet established |
| distribution.signed-installer | distribution | windows, macos | Not yet established |
| distribution.signed-update | distribution | windows, macos | Not yet established |
| distribution.failed-update-rollback | distribution | windows, macos | Not yet established |
| quality.accessibility | quality | windows, macos | Not yet established |
| quality.renderer-security | quality | windows, macos | Not yet established |

## Capability gate inventory

| Gate | Baseline result | Platforms |
|---|---|---|
| parity.coop.agent.chat.streaming | blocked | windows, macos |
| parity.coop.agent.tools.live-output | blocked | windows, macos |
| parity.coop.agent.thinking.display | blocked | windows, macos |
| parity.coop.agent.model.select | blocked | windows, macos |
| parity.coop.agent.model.cycle | blocked | windows, macos |
| parity.coop.agent.thinking-levels.list | blocked | windows, macos |
| parity.coop.agent.thinking-level.set-cycle | blocked | windows, macos |
| parity.coop.agent.queue.steer | blocked | windows, macos |
| parity.coop.agent.queue.follow-up | blocked | windows, macos |
| parity.coop.agent.compaction.auto | blocked | windows, macos |
| parity.coop.agent.retry.auto | blocked | windows, macos |
| parity.coop.agent.abort-retry | blocked | windows, macos |
| parity.coop.session.multiple | blocked | windows, macos |
| parity.coop.session.history | blocked | windows, macos |
| parity.coop.session.name | blocked | windows, macos |
| parity.coop.session.export | blocked | windows, macos |
| parity.coop.session.switch-path | blocked | windows, macos |
| parity.coop.session.fork | blocked | windows, macos |
| parity.coop.session.clone | blocked | windows, macos |
| parity.coop.session.tree.read | blocked | windows, macos |
| parity.coop.session.tree.checkout | blocked | windows, macos |
| parity.coop.runtime.commands.discover | blocked | windows, macos |
| parity.coop.runtime.resources | blocked | windows, macos |
| parity.coop.runtime.extension-dialogs | blocked | windows, macos |
| parity.coop.agent.prompt-images | blocked | windows, macos |
| parity.coop.workspace.files | blocked | windows, macos |
| parity.coop.workspace.user-profile | blocked | windows, macos |
| parity.coop.workspace.project-config | blocked | windows, macos |
| parity.coop.workspace.environment-discovery | blocked | windows, macos |
| parity.coop.workspace.progressive-setup | blocked | windows, macos |
| parity.coop.workspace.git-changes | blocked | windows, macos |
| parity.coop.workspace.worktree-isolation | blocked | windows, macos |
| parity.coop.session.crash-restart | blocked | windows, macos |
| parity.coop.review.sql | blocked | windows, macos |
| parity.coop.review.dax | blocked | windows, macos |
| parity.coop.lineage.explorer | blocked | windows, macos |
| parity.coop.lineage.setup | blocked | windows, macos |
| parity.coop.impact.guided | blocked | windows, macos |
| parity.coop.workflow.review-changes | blocked | windows, macos |
| parity.coop.review.bpa | blocked | windows, macos |
| parity.coop.knowledge.private-memory | blocked | windows, macos |
| parity.coop.knowledge.shared | blocked | windows, macos |
| parity.coop.runtime.doctor | blocked | windows, macos |
| parity.coop.auth.model | pass | windows, macos |
| parity.coop.auth.microsoft | blocked | windows, macos |
| parity.coop.integration.powerbi-desktop | blocked | windows |
| parity.coop.session.terminal-handoff | blocked | windows, macos |

## Automatic chat restoration acceptance

- Persist only Desktop navigation metadata: workspace, runtime-confirmed session reference, access mode and active selection. Pi continues to own session contents and credentials.
- Read session identity through supported runtime/Pi commands; resume through the existing jailed `/resume` path and preserve ownership enforcement.
- Restore multiple chats sequentially, honor runtime chat capacity, retain read-only access, and surface missing sessions/workspaces or lease conflicts without an automatic write override.
- Prevent initial empty startup state and late snapshot requests from overwriting the saved recovery set. Handle quit and unexpected runtime exit without silently losing the previous selection.
- Verify one/multiple chats, active selection, missing folder/file, conflicts, read-only attachment, empty/new chats, interrupted restore and retry in unit/integration tests and native restart journeys.

## Completion rule

Keep the goal active until every required feature, test, platform journey and distribution artifact above has direct current-state evidence. Record external blockers without relabeling missing capabilities as complete.

Implementation evidence: `desktop/src/session-restoration.mjs`, `desktop/src/main.mjs`, `tests/desktop-preview-shell.test.mjs`, and the September 7 daily log. Native development-shell restart restored two chats and their active read-only selection; missing file/folder references remained saved. This does not establish packaged or Windows acceptance.


## Packaged macOS recovery evidence

September 7 locally ad-hoc-signed artifact:
`/private/tmp/coop-desktop-restoration-20260907/mac-arm64/Coop Desktop Preview.app`.
Its 13 packaged source files match the worktree, and all eight audited Electron
fuses match the required states. Archive SHA-256:
`1cfc6660f80492aa76615135c372bd165ad5f17ddb9f5cc4374035cc07fd5597`.
The preview used the repo runtime through COOP_BIN and separate test user data;
this is not an installed managed release or production signing evidence.

- Runtime SIGKILL: native recovery prompt appeared; Restart runtime restored both
  chats, their access modes and the saved transcript.
- App SIGKILL: recorded seven associated processes before termination; none
  remained at the post-crash check. Relaunch restored both chats with the
  read-only chat selected. This observation is macOS-specific.
- Evidence logs and source/fuse manifest are under
  `/private/tmp/coop-desktop-home-20260907-state/`; daily log identifies names.
- Native Windows, managed-runtime isolation/migration, packaging/install/update
  and comprehensive accessibility/performance gates remain unproven.


## Managed profile continuity implementation

`desktop/src/managed-profile.mjs` selects a stable Desktop-owned profile using an
atomically published pointer. One legacy profile is adopted in place; multiple
profiles require explicit selection. Unit checks cover stable selection, adoption,
ambiguous selection, invalid/missing pointers and symlink rejection. This preserves
the storage path; it does not prove future Pi data-format compatibility or migrate
credentials.

A locally ad-hoc-signed managed macOS bundle launched with system-only PATH and no
installed-runtime override. Native restart revealed that Pi does not flush a newly
named empty session: the checkpoint now treats zero-message chats as new chats.
Their workspace/access can be restored; their unpersisted name is not retained.
The corrected bundle is `/private/tmp/coop-managed-profile-fixed-20260907/mac-arm64/Coop Desktop.app`.
Managed sign-in, real-model work, Windows installation, production signing and
update/rollback acceptance remain open. The earlier profile-test bundle had six
missing npm hashes; the subsequent integrity acceptance below supersedes that gap.

- Corrected managed native restart acceptance passed: named empty chat saved as
  `file: null`, relaunch with no workspace override restored one write-access chat
  in the correct folder, Ready, without Chat recovery failure. Quit completed
  cleanly. Evidence: `profile-fixed-launch.log`, `profile-fixed-restart.log`.


## npm integrity acquisition acceptance

The six Pi 0.84.3 shrinkwrapped dependencies omit hashes upstream. Preparation now
compares each exact resolved archive with all installed package files before
recording a SHA-512 checksum. It rejects file differences, extra files, unsafe
archive entries and partial updates without rewriting the lock on failure.

A disposable copy of the actual managed npm tree passed all six comparisons.
`/private/tmp/coop-managed-integrity-20260907` now contains 507 npm entries with
complete integrity, 101 Python distributions, and inventory SHA-256
`ac6a4b15d90f4f486a192bcd27653c34902dfa6fbd244a29a6f6b0a51adf578a`.
This proves checksum coverage for this acquisition, not clean-machine installation,
production signing, vulnerability clearance or future data-format compatibility.


## Managed first-run identity acceptance

`web/auth-service.mjs` now checks only the explicitly selected runtime profile.
A missing file cannot fall back to unrelated global Pi credentials; empty JSON,
unrelated providers and incomplete entries do not report successful OpenAI/Codex
sign-in. Malformed/unreadable storage produces a safe error without credential
values. The check recognizes stored Pi 0.84.3 credential shapes; it does not
validate provider acceptance or expiration by making a model request.

The locally ad-hoc-signed managed app at
`/private/tmp/coop-managed-auth-scope-app-20260907/mac-arm64/Coop Desktop.app`
launched with system-only PATH, no installed-runtime override and fresh user data.
Native Health showed model access unauthenticated, an enabled Sign in button and
profile-specific guidance, while independently retaining Microsoft account state.
The app quit cleanly. OAuth completion, API-key environment-based readiness and
a real model task from this fresh profile remain unproven.


## Model picker keyboard acceptance

The model picker now offers a focused setup action when empty, a focused retry
when loading fails, and an explicitly labeled filter. Model operations pin the
originating chat, suppress duplicate clicks and ignore stale selection results.
Focused behavioral tests cover these paths.

Native acceptance on `/private/tmp/coop-managed-picker-app-20260907/mac-arm64/Coop Desktop.app`:
opening an empty picker focused Set up model access; Enter opened Health; Escape
closed Health and returned focus to the model control; Enter reopened the picker
and refocused its setup button. App quit cleanly. The package verifier and local
ad-hoc signature verification passed. This is scoped macOS keyboard evidence,
not completion of all accessibility, Windows, or real-model setup requirements.


## Installer and post-use signature acceptance

Separate DMG/NSIS build commands now exist in `desktop/package.json`, using
`desktop/electron-builder-installer.cjs`. They retain managed runtime/fuse
configuration and never publish automatically. Windows setup preserves app data
on uninstall and does not auto-launch after completion; native Windows execution
is still required.

DMG verification exposed that Python rewrote signed cache files during runtime
use. Staging now strips Coop source bytecode caches, and both managed launchers
set PYTHONDONTWRITEBYTECODE=1. The corrected locally ad-hoc-signed app passed
codesign verification before and after native startup and Health inspection.

Accepted development DMG:
`/private/tmp/coop-installer-immutable-20260907/Coop-Desktop-0.0.1-mac-arm64.dmg`
(429127766 bytes). Disk checksum passed; mounted app signature passed; app ASAR,
runtime manifest and dependency inventory matched the tested source app; the
Applications shortcut was present and the removed source cache was absent.
The read-only volume was detached. Both full Bash/PowerShell suites passed.

This is a development installer artifact, not production signing/notarization or
an installed-app journey. Earlier `/private/tmp/coop-installer-acceptance-20260907`
artifact failed signature validation and must not be used. App icon, actual native
install/repair, Windows, and complete update/rollback wiring remain open.


## macOS development installation and relocation acceptance

Copied the accepted DMG app with `ditto` into
`/private/tmp/coop-install-journey-20260907/Applications/Coop Desktop.app`, then
ejected the source image before launch. The copied app's signature passed.
Launched with system-only PATH, no runtime/workspace override and new isolated
user data. Selected the smoke workspace through the native folder picker; the
app reached Ready and completed Health inspection (41 runtime checks).

Clean quit returned exit 0; all nine recorded descendant/app PIDs were absent at
the post-quit check. Navigation stored the workspace, one chat and profile-v1
selection. Relaunch without a workspace override restored the correct workspace
and write-access chat, Ready. A second clean quit returned exit 0. Signature
verification after both launches passed.

This proves a scoped DMG copy/eject/relocate/start/relaunch journey for a locally
ad-hoc-signed development app in a disposable Applications folder. It does not
prove production Gatekeeper/notarization, repair, Windows installation, or model
sign-in/work. No application in the real Applications folders was replaced.
Evidence: `/private/tmp/coop-desktop-home-20260907-state/install-copy-*`.
No source edits were needed, so existing passing suites were not rerun.


## Native app branding

- Reused the existing Coop/Cooptimize artwork in `themes/coop.ico`. Added
  `themes/coop.icns` using macOS native format conversion; PNG header and image
  data comparisons confirm the original 256-pixel artwork is unchanged.
- Application build configuration now specifies the macOS ICNS and Windows ICO.
  NSIS installer and uninstaller explicitly use the same Windows icon.
- Rebuilt `/private/tmp/coop-managed-branded-app-20260907/mac-arm64/Coop Desktop.app`.
  Its CFBundleIconFile resource matches the source ICNS byte-for-byte (SHA-256
  `dbad18c72cd01a9d30d2f14971016e90c75d925c6fe3951fbf0e8df6c5cba039`), and the
  build no longer emits a default Electron icon warning. Packaged verifier passed.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/icon-*`. Backup:
  `.backups/20260907_app_icon`. README updated. Full suites and branded DMG
  verification are pending at this entry. This is artwork reuse; native Windows
  installer rendering and production signing remain unverified.

- Final icon acceptance: branded DMG built at
  `/private/tmp/coop-installer-branded-20260907/Coop-Desktop-0.0.1-mac-arm64.dmg`.
  Disk checksum, mounted app signature and embedded-icon comparison passed.
  Read-only volume detached. Both full Bash/PowerShell suites passed.
  Existing native icon artwork is now integrated; Windows rendering, production
  signing, managed sign-in and update/rollback integration remain open.
  No application replacement, commit, push or release occurred.


## Update check/controller integration

Added `desktop/src/update-controller.mjs`: loads an optional fixed in-app feed,
bounds requests, denies redirects/credentials, verifies signed descriptors using
the existing pinned trust policy, handles same/older versions, deduplicates calls
and rechecks trust/expiry before verified artifact staging. Staged paths remain
in the main process. Download requests have a bounded timeout.

The native Help menu now exposes Check for Updates. It reports verified version
results or explicit unavailable state; unprovisioned builds make no update request.
Production feed/key resources are not supplied or invented. Download UI and
installer application/relaunch plus activation/rollback integration remain open.
The controller is not being counted as a complete working updater.

Eleven update-service tests pass, including actual ephemeral Ed25519 signatures,
verified downloaded bytes, tampering, limits, expiration, old versions, concurrent
checks and no-network unprovisioned behavior. Native packaged check on
`/private/tmp/coop-managed-update-check-app-20260907/mac-arm64/Coop Desktop.app`
showed the unavailable dialog, returned to a Ready workspace with one open chat,
and quit cleanly. Packaged source comparison and runtime/fuse verifier passed.


## Cancellable update download and staged recovery

- Native update results now offer Download/Later. Download has a cancellable
  native progress dialog and Dock/taskbar progress; existing sessions keep running.
  The verified result remains staged, with explicit wording that installation is
  not yet enabled. No production feed or key is provisioned.
- Added cancellation/progress to the verified download service, including complete
  handling of short filesystem writes and awaited final verification so failure
  cleanup also covers final verifier rejection. Partial files are removed.
- Only fully verified downloads get atomic `staged-update.json` metadata containing
  the exact signed bytes/signature and a confined file reference. Recovery verifies
  metadata signature/expiry/version and actual file checksum again. Corrupt or
  escaping recovery records are preserved and never accepted as installable.
- Quit cancels and awaits update cleanup, including when the runtime has already
  crashed. Added a regression for that shutdown path.
- Fifteen update-service tests pass: signed fixture download, restart recovery,
  tamper/expiry/path rejection, cancellation cleanup/retry, real native-handler
  logic with a dialog test double, and shutdown cleanup after runtime failure.
  This is synthetic signed-download evidence, not a production feed/installer test.
- Full suites/build checks are pending for the final shutdown adjustment. Evidence:
  `/private/tmp/coop-desktop-home-20260907-state/update-download-*`. Backups:
  `.backups/20260907_update_download`. README updated.
- Native installation/relaunch and activation/rollback wiring remain unfinished.
  No real update installed, release published, production signing, source commit
  or push. Goal remains active.

## Model credentials supplied through the runtime environment

- Fixed model-access readiness for a nonblank `OPENAI_API_KEY` in the actual
  child runtime environment. The HTTP route now supplies the same merged
  environment and resolved profile directory as the runtime. No key is returned
  to the renderer, diagnostics, or logs. This reports configured credentials;
  provider acceptance still requires a real model request.
- Baseline returned unauthenticated for an isolated profile with a fixture key.
  Seven focused auth-service tests now pass, including missing/blank/unrelated
  keys, profile isolation, and credential redaction. Added a bridge endpoint
  regression with a key present only in the launch spec. Full suites pending.
- Source: `web/auth-service.mjs`, `web/server.mjs`; tests:
  `tests/auth-service.test.mjs`, `tests/webbridge.test.mjs`. Backups:
  `.backups/model_environment_20260907_133357/`. Reviewed against repository
  guardrails and the bundled Pi environment-key mapping. No network model call
  or credential migration performed; the packaged app has not been rebuilt for
  this source change yet.
- Prior update-download verification is complete: final Bash and PowerShell
  suites passed. The prior final package's post-use signature check also passed.
  This supersedes the pending-test notes above. Update installation, restart,
  activation and rollback remain unfinished. No commit, push or release.

- Final validation for environment credentials: both full Bash and PowerShell
  suites passed, including the live localhost bridge endpoint regression. Bash
  syntax, paired-script parity and whitespace checks passed. Evidence:
  `/private/tmp/coop-desktop-home-20260907-state/model-env-bash.log` and
  `/private/tmp/coop-desktop-home-20260907-state/model-env-powershell.log`.
  Next: packaged fresh-profile real-model acceptance and update installation.
  The overall completion goal remains active.

## Packaged model-environment acceptance

- Restaged the current repo with the previously verified dependency bundle into
  `/private/tmp/coop-managed-model-env-20260907` and built
  `/private/tmp/coop-managed-model-env-app-20260907/mac-arm64/Coop Desktop.app`.
  The packaged auth service and server match current source byte-for-byte.
  Managed package/runtime inventory and Electron fuse verification passed.
- Two fresh isolated profiles used the actual packaged Pi/runtime with a
  system-only PATH. Without a key, the auth endpoint reported unauthenticated
  and Pi returned zero OpenAI models. With an offline fixture key, the endpoint
  reported configured credentials and Pi returned 38 OpenAI models. Neither
  profile saved credentials; neither sent a model request. This validates
  configuration/model enumeration, not provider acceptance or real coding work.
- Native launch used fresh user data and the disposable smoke workspace. The
  app reached Ready; Health showed model sign-in required and a Sign in action.
  Quit returned exit 0. Local ad-hoc signing only; production identity discovery
  disabled. No installation over the user's existing app, commit, push or release.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/model-env-stage.log`,
  `model-env-package.log`, `model-env-package-verification.json`,
  `model-env-packaged-smoke.mjs`, `model-env-packaged-smoke.log`,
  `model-env-native.log`, and `model-env-signature-after.log` in that directory.
  The preceding source slice's full Bash and PowerShell suites passed; no source
  edits in this packaging/acceptance slice. Repository workflow, guardrails and
  daily-log postcondition followed.
- Next: update installation/relaunch/rollback and actual fresh-profile model
  sign-in/task acceptance. Windows native acceptance and production distribution
  remain unproven. Overall goal stays active.

- Strict deep code-signature verification passed after native use (exit 0).

## Native macOS update candidate preparation

- Added `desktop/src/update-installer.mjs` and connected the main-process update
  controller's `prepare` operation. A verified staged/recovered download is
  required; descriptor trust and artifact hash are checked again. The helper
  verifies a private image snapshot, mounts read-only, checks app identity,
  Desktop/Coop versions, architecture, native signature and managed runtime,
  copies to a private candidate directory, rechecks it, detaches, and promotes
  the directory into the version store. It never replaces the running app.
- App traversal bounds entry count/bytes and rejects links escaping the app or
  unsupported file types. Native commands have bounded output/time, cancellation,
  and exit-aware cleanup. Failed detach preserves uncertain mount contents.
- Twenty-one update-service tests pass, including native-command failure and
  cancellation, recovery-to-preparation tampering, wrong app/runtime identity,
  bad signatures, escaping links, cancellation cleanup and detach failure.
  These injected command fixtures prove control flow; native evidence follows.
- Real macOS preparation passed using the previously accepted branded local DMG
  and an ephemeral test signing key in memory, with no feed/network access.
  Candidate: `/private/tmp/coop-update-prepare-native-20260907/local-preparation-001-S6Unno/Coop Desktop.app`.
  Mount was detached before success; no active installation replaced.
- Full PowerShell suite passed. Full Bash and candidate runtime smoke pending.
  Evidence directory: `/private/tmp/coop-desktop-home-20260907-state/`, files
  `update-prepare-focused.log`, `update-prepare-native.mjs`,
  `update-prepare-native.log`, `update-prepare-health.log`,
  `update-prepare-bash.log`, `update-prepare-powershell.log`,
  `update-prepare-parity.log`. Backups: `.backups/update_prepare_20260907_134600/`.
- Followed repository workflow/guardrails and daily logging. No commit, push,
  production signing or release. Preparation is not yet exposed as a UI action;
  installer replacement, restart, health-gated activation and rollback still
  need integration. Native Windows preparation and fresh-profile real-model
  work remain open. Goal remains active.

- Final preparation validation: both full Bash and PowerShell suites passed.
  Bash syntax, parity and whitespace checks passed. The copied candidate runtime
  started after image detach and passed the managed-runtime smoke (exit 0), then
  strict deep signature verification passed after use (exit 0). This supersedes
  pending checks above. Candidate was prepared only, not activated or installed.

## Recoverable macOS application replacement transaction

- Added `desktop/src/update-replacement.mjs`: a low-level, main/helper-process
  transaction requiring explicit stopped-runtime state, candidate validation and
  a health probe that stops before resolving. Candidate copying and validation
  precede same-filesystem renames. The original app is preserved adjacent to the
  installed app; successful transactions retain it, and failed health restores it.
- An atomically written, file-synced journal records directory device/inode
  identities. Recovery handles interruption before/after each rename, including
  a process killed during the health check. Paths are derived from the caller's
  known app location, never read from journal data. Unexpected directories,
  symlinks, malformed journals and live foreign helpers fail without overwriting
  unrelated data. This is process-interruption recovery, not power-loss proof.
- `tests/update-service.test.mjs`: 25 tests pass, including healthy replacement,
  failed health/copy/cancellation, retry, actual killed-helper recovery, both
  rename gaps and changed-destination/journal rejection. Full PowerShell passed;
  full Bash remains running. Syntax/parity and whitespace checks passed.
- Native acceptance used disposable copies of two existing locally signed
  development packages (both version 0.0.1, with different auth-service bytes).
  Forced health failure restored the original bytes/signature; retry replaced
  them with the newer source, started that installed runtime with an isolated
  profile and system-only PATH, verified its capability contract, stopped it,
  and passed post-use code-signature verification. No installed user app changed.
  Result: `/private/tmp/coop-replacement-native-20260907/Coop Desktop.app`;
  retained original: `.Coop Desktop.app.coop-update/previous.app` beside it.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/update-replace-native.mjs`,
  `update-replace-native.log`, `update-replace-focused.log`,
  `update-replace-bash.log`, `update-replace-powershell.log`,
  `update-replace-parity.log` in that directory. Backups:
  `.backups/update_replace_20260907_135802/`. Workflow/guardrails and daily
  logging followed; no commit, push, release or production signing.
- Integration remains open: a trusted external helper must connect signed
  preparation, actual Desktop/runtime shutdown, this replacement transaction,
  startup recovery and relaunch. It is not yet called from the user update UI.
  Adjacent native rollback backups differ from the old version-root-only state
  helpers; do not treat those unused helpers as already integrated. Native
  Windows and fresh-profile real-model task acceptance also remain open.
  Overall completion goal stays active.

- Final replacement validation: both full Bash and PowerShell suites passed
  (exit 0). Native forced rollback, healthy replacement and post-use signature
  checks passed. This supersedes the pending Bash note above. No Desktop update
  UI/helper/relaunch integration is claimed by this low-level transaction slice.

## Packaged update helper and Install and restart handoff

- Connected managed macOS Install and restart to `update-handoff.mjs` and a
  packaged `update-helper.mjs` over private Node IPC. The main process transfers
  only its already-pinned public trust policy and reverified signed download.
  The helper never reads replacement trust keys from user data/workspaces.
- Preparation completes before shutdown. Desktop checkpoints navigation, stops
  its runtime, and only then authorizes replacement. The helper independently
  waits for both original PIDs to exit, rechecks signature/expiry and the installed
  app identity/version, uses the replacement transaction, probes the installed
  runtime with a fresh profile, and relaunches the app. Restored failures also
  attempt to relaunch the prior signed app. No replacement occurs on cancellation.
- Managed packaging now includes the helper module dependency closure under
  Resources/update-helper. Both fixture/candidate helper copies match current
  source; package verifier passed. Development fixture version 0.0.0 is an
  isolated build override; repo version/release metadata was not bumped.
- 30 focused update tests and both final full Bash/PowerShell suites passed.
  Includes real Node IPC readiness/cancel/apply, trust serialization, late expiry,
  live-process wait rejection, native install progress logic, and checkpoint →
  runtime stop → apply ordering (failed stop cancels the helper). Syntax, parity
  and whitespace checks passed. `desktop/README.md` updated.
- Native journey uses locally ad-hoc-signed 0.0.0/0.0.1 fixture packages and an
  ephemeral public-key policy/signature; no feed/network download or production
  signing. An actual old runtime stopped and parent exited after the packaged
  helper reported ready. At this checkpoint helper PID 37063 was verified live;
  parent 36821 and runtime 36840 had completed the authorized shutdown.
  Receipt: `/private/tmp/coop-update-helper-journey-20260907/handoff.json`.
  Final helper result/relaunch still pending. Do not restart based on a stale
  receipt alone: inspect the specific helper PID and outcome file.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/update-helper-*`,
  user-data helper log/result under `/private/tmp/coop-update-helper-journey-20260907/userdata/`.
  Backups: `.backups/update_helper_20260907_141027/`. Source edits: main, controller,
  installer verifier extraction, helper/handoff modules, managed builder and
  update tests. Repository workflow/guardrails and daily logging followed.
- Remaining: full native-window health beyond the runtime probe; automatic cold
  recovery after a helper interruption; visible outcome/error reporting; native
  Windows; fresh-profile real model work; authoritative release provisioning.
  The current two-rename transaction has a recoverable missing-app gap if the
  helper dies between renames; its recovery routine needs an independently
  launchable entry point before claiming automatic interruption recovery.
  No commit, push or release. Overall goal stays active.

- Native handoff completed: helper PID 37063 exited, outcome is healthy 0.0.1,
  and LaunchServices started the updated app as PID 37468 with the intended
  user-data directory. Installed app archive version is 0.0.1; main and helper
  source match the current repo byte-for-byte. The retained previous app is under
  `/private/tmp/coop-update-helper-fixture-app-20260907/mac-arm64/.Coop Desktop.app.coop-update/previous.app`.
- Native visual verification is pending: CUA reported the Mac locked and automatic
  unlock failed. An asynchronous manual-unlock request is pending. Do not bypass
  the lock or claim a visually verified Ready window. The updated test app remains
  open for that check. This does not block independent code work on the remaining
  update/runtime requirements.

## Corrected packaging and native update outcomes

- Correction to the prior handoff evidence: a live app process plus the helper's
  runtime health probe did not prove native-window startup. The prior managed
  extraResources rule removed shared modules from app.asar, breaking main imports.
  The earlier package verifier did not check that dependency closure.
- Managed packaging now copies the helper in afterPack, retaining modules in both
  app.asar and Resources/update-helper. The stronger package verifier recursively
  checks relative static imports from main and the helper; it rejects the earlier
  broken artifact and passes the corrected build. Packaged main/helper/outcome
  modules match source byte-for-byte.
- Fixed outcome-file write failures that could prevent app relaunch. Added bounded
  one-time native success/failure dialogs after managed window load, with fixed
  copy, retry after dialog failure and preservation of newer results.
- Native acceptance with isolated user data and local ad-hoc signing: corrected
  build showed success, opened Ready workspace, showed fixed failure copy on a
  separate launch, consumed both dismissed receipts, and reopened Ready without
  repeated alerts. All three native sessions exited normally after Cmd+Q.
- Corrected app: /private/tmp/coop-update-outcome-fixed-app-20260907/mac-arm64/Coop Desktop.app.
  Profile: /private/tmp/coop-update-outcome-native-20260907/userdata.
  31 update tests and four managed-package checks passed. Final PowerShell passed;
  final Bash suite remains running at this checkpoint.
- Still open: interrupted replacement/cold recovery, full native-window health
  as part of the helper's activation decision, actual configured-feed native
  update journey with corrected packages, Windows, fresh managed-profile model
  work, and production release provisioning. Overall goal remains active.

- Final validation: both final full Bash and PowerShell suites passed (exit 0).
  Post-use strict deep signature verification also passed after all three native
  launches. Logs: /private/tmp/coop-desktop-home-20260907-state/update-outcome-*.

## Native-app update health gate

- Helper health now combines the runtime contract/version probe with a real
  packaged Electron app probe. Temporary user data prevents use of the user's
  profile. Main must receive renderer navigation startup through its trusted
  preload, complete chat get_state RPC, stop its runtime, acknowledge the random
  challenge and expected Desktop version, and exit cleanly.
- Native acceptance: the new ad-hoc-signed packaged app passed; the earlier
  broken package with missing main imports failed. Both probes completed and
  the current app retained a valid strict deep signature after use.
- 33 focused tests passed; actual child-process fixtures reject wrong challenge,
  version, crash, hang and cancellation, and verify process exit. Main ordering
  coverage rejects acknowledgement when runtime stop fails. Unix process-group
  fixtures are not represented as Windows acceptance.
- Current package: /private/tmp/coop-native-health-app-20260907/mac-arm64/Coop Desktop.app.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/native-update-health-*.
  Full PowerShell, packaging, syntax and parity checks passed; final Bash status
  will be recorded below. Still open: interruption recovery, configured-feed
  native update journey, native Windows, managed real-model acceptance and
  authoritative production release provisioning. Goal remains active.

- Final native-health slice validation: full Bash and PowerShell suites passed
  (exit 0); 33 focused update tests passed after the platform guard. Package
  dependency/fuse verification, native positive/negative probes and post-use
  strict deep signature verification passed. No commit, push or release.

- Real local HTTPS acceptance passed using the public trust/feed resources
  extracted from the built old app archive: signed check reported available;
  cancellation removed the partial artifact; the complete 729270044-byte download
  verified; a new controller instance reverified the staged download after restart.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/native-feed-controller.json.
- Native UI test is pending manual unlock: CUA explicitly reported the Mac locked
  and automatic unlock failed. An asynchronous unlock request is pending. Do not
  bypass the lock or count controller checks as native button acceptance.
- Old fixture main PID 31289 was confirmed running at the intended user-data path;
  its exec session is 42121. HTTPS server session 59308 remains live for the pending
  UI test (server PID/endpoint in /private/tmp/coop-native-feed-20260907/server.json).
  Signing key is in server memory; do not restart the server unless terminal state
  is confirmed because restart would require rebuilding the pinned old fixture.
- No repository source changed in this acceptance slice. Isolated build/package
  verification and strict deep signature checks passed. No commit/push/release.
  Goal remains active; interruption recovery and other independent work remain.

## Full configured-feed native update passed

- Operated Help → Check for Updates → Download → Install and restart in the
  packaged 0.0.0 fixture. Native offer showed 0.0.1 and 696 MB; download reported
  verified, preparation showed a cancellable dialog, and the old app exited 0.
- Helper PID 35248 completed replacement and both runtime/native UI health probes.
  Relaunched app PID 35995 displayed Update installed, then restored the same
  workspace with Ready status after Continue. This is native UI acceptance, not
  a controller-only or process-liveness inference.
- Authoritative disk evidence: installed CFBundleShortVersionString 0.0.1,
  retained previous.app 0.0.0, transaction phase healthy, dismissed outcome gone.
  Both installed and previous app passed post-use strict deep signature checks.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/native-feed-completed.json.
- Test CA was added only to the copied fixture main via node:tls; production
  certificate validation and repo main were unchanged. The signed candidate
  remained immutable and predates the plain-logo asset request; current source
  and the separate plain-logo build retain the requested original logo.
- Closed upgraded app normally and confirmed PID gone. Stopped the exact local
  HTTPS server PID 31060; session 59308 exited 0. Removed its disposable TLS private
  key after shutdown. Ephemeral Ed25519 key disappeared with server memory.
  Do not resume these server handles; this acceptance is complete.
- No production signing, release configuration, installed user app, commit, push
  or release was changed. No source logic changed in this native acceptance slice.
  Still open: automatic interrupted-replacement recovery, native Windows,
  fresh managed-profile real-model acceptance and production release provisioning.
  Overall completion goal remains active.

## Atomic replacement and rollback verified

- New macOS transactions use native atomic directory exchange for activation and
  rollback. Bundled Python from the stable prepared release calls renamex_np with
  SWAP and NOFOLLOW_ANY; a missing/unsupported primitive cannot trigger a two-
  rename fallback. Version 2 journals handle original-app placement before and
  after backup filing, and interruption after rollback exchange. Legacy version 1
  recovery remains available for old transactions.
- Actual SIGKILL immediately after the native swap left the normal app path
  present; recovery restored the original. Native signed-app tests passed forced
  health failure/rollback and healthy activation with real native UI health.
  Installed version 0.0.1, retained previous 0.0.0; both signatures verified after
  use. This is stronger than simulated filesystem operations alone.
- 35 focused update tests passed; full PowerShell passed. Full Bash remains running
  at this checkpoint. Rebuilt package dependency checks passed, and atomic helper
  modules match source in both app.asar and helper resources. Local signing is
  being verified. Current plain-logo build: /private/tmp/coop-atomic-update-app-20260907.
- Evidence: atomic-swap-* under /private/tmp/coop-desktop-home-20260907-state/.
  Real-bundle transaction: /private/tmp/coop-atomic-swap-native-20260907.
- Automatic cold recovery still requires an independent startup/recovery entry
  point. A preserved path alone cannot repair a candidate whose main process
  cannot load. Windows and managed-profile real-model acceptance remain open.
  No commit, push or release; overall goal remains active.

- Final atomic-swap validation: full Bash and PowerShell suites passed (exit 0),
  as did 35 focused tests, package dependency checks and strict deep signature
  verification of the rebuilt plain-logo app. Native rollback/activation and
  immediate-SIGKILL recovery evidence passed. No remaining test handles are live
  from this slice; automatic cold-start recovery remains separate unfinished work.

## Independent recovery after updater crash passed

- Recovery job is now integrated before helper readiness. It retains a verified
  copy of the current app outside the replacement paths and registers a temporary
  per-user LaunchAgent. Cancellation/completed restart disarms it; an authorized
  interrupted update leaves it armed. No recovery keys come from user data.
- Native crash acceptance passed with a real LaunchAgent and real signed bundles:
  the fixture updater was SIGKILLed immediately after swapping in the known
  non-starting candidate. Without manually launching recovery, the independent
  worker restored version 0.0.0, set journal rolled-back, reopened the app with the
  failure message and reached the same Ready workspace after Continue.
- Agent label com.cooptimize.coop.desktop.recovery.004e0200-2909-400a-91f2-d02db9d722af
  removed itself, deleted its plist and marked its request finished. Recovered app
  was closed normally. Native process-cleanup checks also passed for an orphaned
  runtime group and a separate native-probe group.
- 37 focused tests and full Bash/PowerShell suites passed, with syntax/parity and
  package dependency verification. Native final signature checks are being
  completed. Main logic unchanged after those suites. Recovery-ready default
  0.0.1 build (plain logo) is building separately from the 0.0.0 crash fixture.
- Evidence: recovery-worker-* under /private/tmp/coop-desktop-home-20260907-state/.
  Actual reboot/login launch acceptance has not been performed; boot-ID handling
  is covered through controlled tests. Successful UI update with the new job
  integration, retention/pruning, Windows, fresh-profile model work and production
  release provisioning remain open. Overall goal stays active.

- Final recovery-worker validation: 37 focused tests and both full suites passed.
  Native automatic crash recovery, orphan runtime/native-probe cleanup, removal
  of the exact LaunchAgent and post-use worker/recovered-app signatures passed.
  Default 0.0.1 plain-logo package built and passed dependency/fuse verification;
  local package signature result is recorded by the final tool check.
- Follow-up hardening: prevent ordinary candidate startup while a transaction is
  pending; handle a helper crash after successful relaunch without leaving a busy
  recovery registration; prune completed diagnostic recovery copies safely.
  Physical reboot acceptance and successful native update with the newly armed
  recovery job still need evidence. No production install, commit, push or release.

## Pending startup and late recovery cleanup passed

- Ordinary startup during copying/ready/testing now defers before workspace,
  runtime or managed profile setup. Only the journal owner's direct health-probe
  child may start. The macOS auto-closing notice uses a parent window because
  unparented native dialogs ignore AbortSignal.
- Native packaged checks passed for automatic startup deferral and an authorized
  health probe in the same pending transaction. A real LaunchAgent then handled
  a simulated helper exit after rollback/relaunch: it verified the running app,
  disarmed and removed its plist while preserving the exact app PID. No duplicate
  update-result receipt or reopened window was created. Ready workspace observed
  before and after cleanup; the disposable session was closed normally.
- Evidence: recovery-notice-native-completed.json under
  /private/tmp/coop-desktop-home-20260907-state/. Plain Cooptimize logo retained.
  39 focused checks and full PowerShell passed; full Bash final result pending.
- Actual reboot/login acceptance, full successful native update with the newest
  recovery integration, retention/pruning, Windows acceptance, fresh-profile real
  model work and production provisioning remain open. No release performed.

- Final result: full Bash and PowerShell suites exited 0; 39 focused update tests,
  syntax/parity, whitespace, packaged dependency/fuse checks, and native startup /
  late recovery cleanup acceptance passed. Independent worker verified both its
  signed copy and the running app before disarming. Test GUI PID 15590 is gone
  after normal quit; the exact recovery LaunchAgent and plist are absent.

## Completed recovery storage cleanup verified

- Normal managed startup keeps the newest completed recovery bundle and removes
  older completed job directories only after confirming the saved LaunchAgent
  plist is absent, launchctl reports service-not-found, and pgrep reports no
  referencing processes. Unknown states and inspection failures preserve data.
- 41 focused tests passed, including pending/newest/busy/malformed/linked entries,
  revalidation after a state change, duplicate invocations, inspection failures
  and saved-plist protection. Native real-process and LaunchAgent lifecycle checks
  passed. Final rebuilt package passed dependency/fuse and strict deep signature
  verification; native startup removed an older completed fixture, retained the
  newest and reached the saved Ready workspace. Test app was closed normally.
- Full final PowerShell passed; final Bash is still running. Evidence prefix:
  /private/tmp/coop-desktop-home-20260907-state/recovery-retention-. Build:
  /private/tmp/coop-recovery-retention-app-20260907. Plain logo retained.
- This covers completed recovery copies. Incomplete preparation directories,
  downloaded/staged updates and adjacent transaction archives still require a
  separate retention policy. Full successful native update with current recovery
  integration, reboot/login and Windows acceptance, fresh-profile real model work
  and production provisioning remain open. No installed user app or release changed.

- Final retention validation: full Bash and PowerShell suites exited 0 after the
  saved-plist guard. All 41 focused update tests, native live/registered/saved-job
  safeguards, final packaged startup, signature/package and syntax/parity checks
  passed. Disposable GUI PID 61973 exited normally and test LaunchAgent was
  removed. No known active handles remain from this slice. Goal remains active.

## Current packaged updater successful activation passed

- Actual packaged helper/Node IPC, verified signed DMG preparation, real old
  bundled runtime shutdown, recovery LaunchAgent registration, atomic replacement,
  default runtime/native health probes and automatic reopening passed together.
  Installed app is 0.0.1; adjacent rollback app is 0.0.0. Both strict deep signatures
  passed after use. The recovery request is finished, exact service/plist absent,
  original parent/runtime/helper gone, and reopened test GUI closed normally.
- Plain Cooptimize icon byte equality passed. Native Ready workspace observed.
  This fixture initiated helper IPC directly; it does not replace the earlier
  native Help-menu/download UI acceptance. Success-dialog presentation was not
  observed in this run (receipt already consumed on first inspection).
- Evidence: /private/tmp/coop-desktop-home-20260907-state/current-update-native-completed.json
  and current-update-verification.log. No source changes since the passing 41-test,
  full Bash/PowerShell retention checks. No user installation or release changed.
- Remaining: actual reboot/login acceptance; incomplete preparation/download/archive
  retention; Windows implementation/acceptance and final capability/journey evidence;
  fresh managed-profile real model work; production feed/signing/notarization and
  release provisioning. Overall goal remains active.

## Prepared-copy cleanup packaged acceptance passed

- Verified committed source a5dc57e05c361862bcda8c5dcd1b52b95701e577 using
  disposable packaged 0.0.0 and 0.0.1 apps. Both package/resource/fuse verifiers
  passed before the update; the signed local DMG was authenticated by an ephemeral
  test descriptor. Production signing and release publication were not involved.
- Actual helper IPC prepared the candidate and armed a real recovery LaunchAgent,
  then the old runtime and fixture parent exited. Atomic activation reached healthy
  after the default runtime and native-window probes. The reopened app displayed
  “Update installed — Coop Desktop 0.0.1 is ready”; Continue opened the saved Ready
  workspace. The disposable app was then closed normally.
- The one recorded prepared release directory was removed. Installed 0.0.1 and
  adjacent rollback 0.0.0 remained and passed strict deep signature checks after
  use. The original DMG remained and passed its signed SHA-256/size check. The plain
  Cooptimize icon matched source bytes. The recovery request finished, its exact
  service and plist were absent, and parent/runtime/helper/reopened app PIDs exited.
- Evidence: /private/tmp/coop-desktop-home-20260907-state/prepared-cleanup-native-completed.json
  and prepared-cleanup-verification.log (exit 0). This validates the committed
  cleanup implementation through packaged helper IPC, not the download-menu flow.
  Existing 42 focused tests and full Bash/PowerShell suites apply to unchanged code.
- Runtime/native health profiles remain; this result does not establish general
  cache, orphan preparation, download or transaction-archive retention. Native
  Windows work, real reboot/login acceptance, fresh managed-profile model work,
  companion-source packaging and production provisioning remain open.

## Development companion wheel packaging verified

- Added scripts/build-development-wheels.py and config/development-companions.json
  to build wheels from exact committed Git archives, excluding working-tree edits.
  Explicit --pins supports later committed validation fixes. Output is fresh and
  records each companion repository, full revision, filename and SHA-256.
- prepare-managed-runtime.mjs accepts --development-wheels, authenticates private
  snapshots and passes both the exact release-version constraint and hash-bearing
  wheel URL to pip. Installed metadata/archive receipts must match before a source
  marker is written. Dependency inventory generation validates and retains that
  provenance; its schema and the packaged helper dependency closure were updated.
  Package verification reports developmentSources. Published acquisition remains
  the default. Version numbers and production release configuration are unchanged.
- Built all three pinned development wheels, installed them with the managed
  Python interpreter, and staged a fresh runtime using existing verified Node/npm/
  Python base inputs and unchanged published Fabric roots. This exercised the new
  installation/staging path, not a new download of every platform dependency.
- Packaged payloads matched all wheel code/data bytes: data-doc 47 files, SQL 54,
  DAX 61. Targeted companion tests ran under the packaged Python against packaged
  modules (76 data-doc, 13 SQL, 16 DAX passed), with copied test fixtures and no
  source checkout import fallback. Native managed startup, Ready workspace, normal
  quit, post-use strict signature and plain-logo byte equality checks passed.
- Six preparation checks and twelve managed-runtime checks passed, covering hash
  tampering, wrong pins, duplicates, unsafe provenance and mismatched install
  receipts. Full Bash and PowerShell, syntax/parity and whitespace checks passed
  with exit 0. Evidence prefix development-wheels- under
  /private/tmp/coop-desktop-home-20260907-state/. Native payload/process receipt:
  development-wheels-payload-evidence.json. Test app/runtime PIDs 22006/22040 exited.
- Updated desktop/README.md and the Windows handoff with build commands and the
  difference between development source provenance and published versions. Native
  Windows validation remains required. Full preparer acquisition on a fresh worker,
  transitive resolution reproducibility, fresh-profile model work, remaining update
  retention/reboot checks and production provisioning remain open. No release.

## Fresh-profile sign-in failure reproduced and corrected

- Native setup in the packaged development app reached Choose model / Set up model
  access / Health / Sign in. Computer Use rejected Terminal access, so Aaron
  completed the terminal step manually and reported the actual failure: the
  login-only process attempted to acquire Desktop's existing workspace write lease
  and exited before authentication. No concurrent-write override was requested.
- Native model-login launchers now attach read-only on macOS and Windows (and the
  fallback terminal path), retaining the selected managed profile. A regression
  exercises the real guardrail handlers with an active writer: login remains alive,
  workspace mutations stay blocked, and the original lease remains held afterward.
- Login-only completion now fingerprints only a complete, unexpired Codex OAuth
  record and waits for it to differ from the record present at startup. Empty,
  malformed, unrelated, expired and pre-existing credentials no longer count as a
  successful new login. Credential values are not logged. Added readiness/lifecycle
  checks and fixed native launcher assertions; the former macOS launcher assertion
  failed before the fix. 78 guardrail and 17 shell tests passed, plus login checks.
- Fresh model controls now say Choose model instead of unknown/model ellipsis and
  clear stale model tooltips. Native rebuilt UI confirmed the label and restored
  Ready workspace. The candidate runtime is an APFS clone of the verified
  development runtime with the three changed runtime source files overlaid; exact
  packaged equality of those files and native-terminal.mjs passed. Package/fuse,
  strict signature and full PowerShell checks passed; the subsequent full Bash
  run also completed with exit 0.
- Reopened the fixed packaged app using the same disposable profile, then invoked
  its Sign in action. Aaron was asked to complete the new terminal/browser flow.
  Aaron subsequently reported Succeeded; native Health confirmed authentication.
  The real-model acceptance results are recorded below. Existing user workspaces
  were not changed.
- Source changes: desktop/src/native-terminal.mjs, extensions/coop-tools/index.ts,
  web/public/app.js and index.html; tests and desktop/README.md updated. Backups:
  .backups/model_setup_20260907/. Evidence prefix model-login-lease- under
  /private/tmp/coop-desktop-home-20260907-state/. Fixed test app:
  /private/tmp/coop-model-login-lease-app-20260907/mac-arm64/Coop Desktop.app.

## Authenticated model work and availability refresh verified

- After successful native sign-in, the running Pi process retained its pre-login
  model availability snapshot. Added coop-refresh-models using the public model
  registry refresh API with network disabled. The HTTP model-list adapter checks
  command registration, awaits refresh, then reads models; older runtimes never
  receive an unknown slash command as a model prompt. Refresh failures propagate.
- Real Pi 0.84.3 SDK and actual packaged HTTP integration both verified external
  credential changes without an agent restart. The HTTP fixture used a disposable
  profile and synthetic API key, discovered 38 OpenAI models after an initially
  empty listing, and verified zero user/assistant messages through session stats.
  No model request was made by that fixture. Earlier fixture attempts failed due
  to a missing CSRF header and use of an intentionally unsupported get_messages
  HTTP command; both harness errors were corrected before the passing run.
- In the native packaged app, the authenticated GPT-5.5 session created
  name_tools.py and test_name_tools.py in the disposable workspace and ran four
  passing unittest cases. Independent execution with bundled Python also passed
  all four tests. Tests cover trimming, blank removal, case-insensitive deduplication,
  order preservation and rejection of non-string values.
- Native Stop acceptance passed on a repeated 90-second Python wait: the tool was
  visibly running, its actual process PID 12496 was observed at 14 seconds, then
  clicking Stop returned the UI to Ready, marked the tool interrupted and removed
  that process. An earlier wait completed normally and is not counted as Stop
  evidence. The authenticated test profile is retained; no credentials were copied
  or printed.
- The final code passed full Bash and PowerShell suites (both observed exit 0),
  including 78 guardrail checks, 17 shell checks, model-login lifecycle checks and
  eight RPC adapter checks. Evidence is under
  /private/tmp/coop-desktop-home-20260907-state/: model-login-refresh-bash.log,
  model-login-refresh-powershell.log, model-refresh-http-evidence.json and
  model-login-refresh-package-verification.json. Backups remain under
  .backups/model_setup_20260907/.
- Native Windows installer/runtime and sign-in acceptance remain pending. The
  native footer also displayed an inconsistent usage-window reset label during
  this run; this is recorded for follow-up and is not treated as verified quota
  information. Remaining release/provisioning and reboot/retention work is still
  open. No release, tag, version bump or production signing was performed.
- Final post-use strict signature verification passed. All five changed runtime
  sources and the native terminal module matched the tested package byte for byte;
  its icon matched the original plain Cooptimize logo. Syntax, parity and whitespace
  checks passed. Native evidence: model-native-work-evidence.json and
  model-login-final-source-equality.json in the same evidence directory.

## Provider usage window correction

- Investigation traced the native 5h label paired with a multi-day reset to pinned
  pi-better-openai 0.1.22: its parser hard-codes primary/secondary as 5h/7d and
  discards the provider's actual duration. The npm registry still reports 0.1.22
  as current. OpenAI's own client maps limit_window_seconds from each window:
  https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs .
- Added an exact-source compatibility correction in lib/openai-usage-compat.mjs,
  applied by both sync scripts and managed staging. It rejects unknown versions,
  modified input, symlinks and non-files; repeated application is idempotent.
  Managed staging changes only its fresh output copy and records original/corrected
  hashes in coop-compatibility.json; the package verifier checks that receipt.
  The dependency's original auth/fetch/model-scope owner remains in place.
- Desktop now parses variable-duration usage labels, clears absent/unknown bars,
  consumes automatic extension status/replay, clears quota state on chat switches
  and no longer sends periodic slash-command prompts. Registered the parser route.
- Five focused tests reproduce the upstream weekly-primary defect, then verify
  corrected percentages/reset labels, custom/unknown durations, missing quota,
  Spark selection, countdown aging, patch provenance/idempotence/rejection and
  meter clearing. Real upstream usage.ts is retained only as an MIT-licensed test
  fixture. Package and sync test fixtures now include that source; reconnect
  coverage verifies quota clearing before replay.
- Created a separate APFS-cloned test app at
  /private/tmp/coop-usage-windows-app-20260907/mac-arm64/Coop Desktop.app with the
  corrected dependency and renderer. Ad-hoc signing, strict verification and the
  package/fuse/compatibility verifier passed. The prior authenticated app/profile
  was preserved. Native visual acceptance is pending because Computer Use reports
  the Mac is locked; Aaron was asked to unlock it. No workaround screen access was
  attempted. Full Bash/PowerShell and isolated packaged HTTP checks are in progress.
- Backups: .backups/usage_windows_20260907/. Evidence prefix usage-windows- in
  /private/tmp/coop-desktop-home-20260907-state/. README documents the correction
  and how it differs from acquired npm archive integrity. Existing release,
  Windows and broader journey requirements remain open; no release performed.

### Usage correction acceptance results

- Aaron unlocked the Mac. Quit the original test app through its native menu and
  launched the separate corrected app with the same managed profile/workspace.
  Native accessibility and screenshot inspection confirmed a 7d header meter and
  matching 7d reset label in the footer, Ready status, preserved GPT-5.5 selection
  and restored prior conversation. No new model task was submitted for this check.
  Exact equality of eight overlaid runtime source files and the original plain
  logo passed, as did post-use strict code-signature verification. Evidence:
  usage-windows-native-evidence.json and usage-windows-package-verification.json.
- Final full Bash and PowerShell suites both completed with exit 0. ShellCheck,
  Bash/JavaScript syntax, script parity/BOM and whitespace checks passed. Logs:
  usage-windows-bash.log, usage-windows-powershell.log,
  usage-windows-shellcheck.log and usage-windows-parity.log. Earlier suite failures
  exposed incomplete staged dependency fixtures, a missing reconnect test stub and
  a runtime test whose inherited home/PATH selected a pre-existing August 21 fake
  ~/.local/bin/pi. The runtime lifecycle test now isolates HOME and pins its stub
  path. That unrelated machine-local launcher was not modified.
- An additional exploratory HTTP fixture using synthetic OAuth data did not pass:
  its NODE_OPTIONS fetch replacement loaded but did not intercept the extension's
  actual quota request, which returned 401 for the synthetic token. This fixture
  is not credited as offline integration evidence, nor as a product authentication
  failure. No real credentials were read or copied by it; no model generation was
  requested. The production acceptance evidence is the authenticated native app,
  plus the deterministic parser/formatter and staging/sync tests. Diagnostic log:
  usage-windows-http.log. A reliably intercepted HTTP fixture remains follow-up.
- The authenticated native test app remains open for use. Source is prepared for
  the already-authorized commit/push; no release, tag or version bump. Windows
  native acceptance, additional model-specific quota bucket coverage and the
  previously listed broader completion requirements remain outstanding.

## Native fork/clone acceptance and transcript replay correction

- The packaged Clone action created a new session ID with identical branch entries
  and retained the original session byte for byte. Native inspection nevertheless
  exposed a renderer regression: the RPC backfill discarded reasoning, tool args
  and results, and displayed the interrupted tool with a success mark.
- Added web/transcript-replay.mjs to project Pi's public active-branch messages into
  rich replay events. It associates tool results with tool calls, retains order,
  arguments/output/error state, and preserves existing reasoning/output limits.
  Missing results are explicitly incomplete; both file replay and the legacy
  text-event renderer now avoid claiming success without recorded evidence.
  Existing file-based History branch-selection heuristics are unchanged.
- A real bridge regression failed before the fix on the discarded aborted result
  and passed afterward. All 277 bridge checks and eight runtime-domain checks
  passed, including malformed blocks, Unicode separators, size limits and input
  immutability. Full Bash/PowerShell regression runs were started afterward.
- Built a separate APFS-cloned disposable app at
  /private/tmp/coop-session-replay-app-20260907/mac-arm64/Coop Desktop.app,
  overlaying server, renderer and projection module. Ad-hoc signing, strict
  verification and package/fuse/compatibility checks passed. The native Clone
  action now retained the thinking disclosures, failure mark, command arguments
  and Command aborted output. The fixed clone had an independent ID and every
  original entry matched exactly.
- Native Fork from the final user prompt created a third distinct session ID and
  exactly the entries preceding that prompt. The selected prompt appeared in the
  composer without being submitted. Original and fixed clone remained byte for
  byte unchanged. Cleared that disposable draft and used native History to restore
  the original session; persisted Desktop state confirmed the original file.
  No model generation or workspace file edits were needed for this acceptance.
- Evidence: session-branch-evidence.json, session-branch-original.jsonl,
  session-replay-before.log, session-replay-after.log and
  session-replay-package-verification.json under
  /private/tmp/coop-desktop-home-20260907-state/. Session fixture copies contain
  only the authorized disposable acceptance conversation, not credentials.
  Backups: .backups/session_replay_20260907/. Updated web/README.md to describe
  replay fidelity and the already-shipped usage-status behavior accurately.
- Native Windows branching and remaining named release/quality/journey requirements
  are still open. No formal final-artifact parity status was promoted from this
  development build, and no release, tag or version bump was performed.
- Final full Bash and PowerShell suites completed with observed exit 0. Syntax,
  parity/BOM and whitespace checks passed. Post-use strict signature verification,
  exact equality of the three changed runtime sources and original-logo equality
  passed. Final suite logs: session-replay-bash.log and
  session-replay-powershell.log in the evidence directory. The corrected native app
  remains open on the restored original conversation.
